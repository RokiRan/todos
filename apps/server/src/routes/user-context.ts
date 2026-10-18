/**
 * `GET /api/user/context` —— 「我是谁 / 我有哪些团队 / 我在团队里是什么角色」。
 *
 * **为什么需要这个端点**：所有 Settings 页面（providers / skills / schedules / chief）
 * 的 URL 都是 `/api/teams/:teamId/...`，而创建 todo、绑定 skill、建定时规则这些写路径
 * 还要 `ownerMemberId`（是 `member.id`，不是 user id）。此前 Web 端唯一的 teamId 来源是
 * `GET /api/todos` 的返回里那一列 —— 于是：
 *   - 空看板（还没有 todo）→ 前端拿不到任何 teamId，所有设置页都进不去
 *   - `ownerMemberId` 压根没有读取端点，只能猜
 * 这两条都是「功能做了但 UI 接不上」，不是权限问题，所以补一个只读端点而不是改鉴权。
 *
 * 鉴权：`resolveContext` 统一入口（Bearer `tds_…` 与 web token 都收），401 语义一致。
 * 返回的 `teams` **只含当前用户所属的团队**（`members.member_type = 'user'`），
 * 不按客户端传的 teamId 过滤 —— 客户端没有可信 teamId 可传。
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { agents, members, teams } from '@tds/db';
import { resolveContext } from '../auth.js';

export interface TeamContext {
  teamId: string;
  name: string;
  /** 本人在该团队的 `member.id` —— 写路径要的 `ownerMemberId` 就是它 */
  memberId: string;
  role: 'admin' | 'member';
}

export interface UserContext {
  userId: string;
  email: string;
  /** 本人作为 member 的所有团队（admin + member 都要） */
  teams: TeamContext[];
  /** 本人的 agent 名册（team 级，供 todo/schedule 的 agentId 选择） */
  agents: Array<{
    id: string;
    teamId: string;
    displayName: string;
    modelId: string | null;
    deletedAt: number | null;
  }>;
}

export function registerUserContextRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/user/context', async (req) => {
    // 401 = 凭据不对/缺失。与文件内其它端点同源（`resolveContext` 是唯一入口）。
    const ctx = await resolveContext(db, req);

    // 只列本人作为 **user 类型成员** 加入的团队。`member_type='agent'` 的行是 agent
    // 身份，不是人 —— 混进来会让 UI 以为 agent 是个可切换的团队。
    const rows = await db
      .select({
        teamId: teams.id,
        name: teams.name,
        memberId: members.id,
        role: members.role,
        joinedAt: members.joinedAt,
      })
      .from(members)
      .innerJoin(teams, eq(teams.id, members.teamId))
      .where(
        and(eq(members.actorId, ctx.userId), eq(members.memberType, 'user')),
      )
      .orderBy(members.joinedAt);

    const teamContexts: TeamContext[] = rows.map((r) => ({
      teamId: r.teamId,
      name: r.name,
      memberId: r.memberId,
      role: r.role,
    }));

    const teamIds = teamContexts.map((t) => t.teamId);

    // agents 只列 team 上下文里那几支（含软删的 deletedAt 便于 UI 显示「已删除」），
    // 但没有团队时不去查 —— inArray([]) 会生成恒假 SQL，白跑一趟。
    const agentRows =
      teamIds.length === 0
        ? []
        : await db
            .select({
              id: agents.id,
              teamId: agents.teamId,
              displayName: agents.displayName,
              modelId: agents.modelId,
              deletedAt: agents.deletedAt,
            })
            .from(agents)
            .where(inArray(agents.teamId, teamIds))
            .orderBy(agents.createdAt);

    return {
      userId: ctx.userId,
      email: ctx.email,
      teams: teamContexts,
      agents: agentRows,
    } satisfies UserContext;
  });
}
