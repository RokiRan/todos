import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { Db } from '@tds/db';
import { members } from '@tds/db';
import { chiefToolSpec, CHIEF_TOOLS, requiresConfirmation } from './tools.js';
import { HttpError } from '../http.js';

/**
 * Chief 工具执行器 —— `src/chief/tools.ts` 的文件头一直写着
 * 「真正的执行在 chief/executor.ts」，但**那个文件从不存在**。这是它。
 *
 * ## 为什么需要它
 *
 * Chief 声明了 **58 个工具**（`CHIEF_TOOLS`，与原站键名逐字一致）。它们的归宿分两半：
 *   - **31 个在 MCP 面上** → 由 `routes/mcp.ts` 的 `executeTool` 执行，规则在 `services/*`
 *   - **27 个不在 MCP 面上**（Chief 专属：`create_project` `update_project` `create_agent`
 *     `update_agent` `delete_agents` `delete_skills` `providers` `add_provider`
 *     `update_provider` `delete_providers` `connect_app` `connect_repo`
 *     `set_remote_shell` + memory 8 个 + interaction 4 个 + `delete_todos` `relay_question`）
 *     → **此前只有声明、没有任何执行器**
 *
 * 本文件只做**调度与闸门**，不实现业务规则：每个工具的规则在 `services/*` 里。
 * 这里的职责是
 *   1. 分派到正确的服务函数
 *   2. 执行前把三条闸门走完（不可逆确认 / admin 授权 / 工具存在）
 *   3. 统一回包形状
 *
 * ## 三条闸门（顺序不能反）
 *
 * ① **工具不存在** → 拒绝。措辞说「不存在」而不是「还没实现」，否则 Chief 会反复
 *    重试同一个我们根本没提供的工具。
 * ② **不可逆操作未确认** → 拒绝。文档铁律：「Chief 修改 agent 任何 irreversible 操作
 *    （删除 agent/skill/secret/connection/model provider/todo）必须以 confirmation card
 *    让用户点确认；nothing is deleted until you confirm」。这是防误删的最后一道闸门，
 *    不能靠调用方自觉。
 * ③ **需要 admin 的操作，当前 actor 不是该 team 的 admin** → 拒绝。
 *
 * 凭据类（`handlesSecret`）的值走 secure input card（`cards.ts` 的 `encodeCard`），
 * 由上层解封后放进 `ctx.credentials`；handler 只管用，**回包不回显**。
 */

/** 一个工具的执行结果。`ok:false` 不是异常，是「闸门当前不接受这个动作」。 */
export interface ChiefToolOutcome {
  tool: string;
  ok: boolean;
  /** 执行产物（各工具形状不同；凭据类工具这里不含任何值）。 */
  result?: unknown;
  /** 拒绝理由。措辞要能让 Chief（模型）据此决定下一步。 */
  reason?: string;
}

/** 执行上下文。`actorId` 是 Chief 背后的 userId。 */
export interface ChiefExecContext {
  db: Db;
  /** 发起这次调用的 userId */
  actorId: string;
  /** Chief 所属团队 —— 所有 team 级校验都以此为准 */
  teamId: string;
  /** 已由上层 confirmation card 确认过的不可逆操作（工具名集合） */
  confirmedTools?: ReadonlySet<string>;
  /** 已解封的凭据（仅 `handlesSecret` 工具用）。键名即凭据字段名。 */
  credentials?: Readonly<Record<string, string>>;
}

/** 一个工具的实现。`args` 是已解析好的具名参数。 */
export type ChiefToolHandler = (ctx: ChiefExecContext, args: Record<string, unknown>) => Promise<unknown>;

/** 分发表：键是工具名。 */
export type ChiefToolRegistry = ReadonlyMap<string, ChiefToolHandler>;

/**
 * 校验并执行一个 Chief 工具。
 *
 * 三条闸门按 ①②③ 顺序走，**任何一条不过都不进 handler** —— handler 里不该再有这些
 * 判断，那是重复实现，也是漂移的来源。
 */
export async function executeChiefTool(
  registry: ChiefToolRegistry,
  ctx: ChiefExecContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ChiefToolOutcome> {
  // ① 工具不存在
  const spec = chiefToolSpec(name);
  if (!spec) {
    return {
      tool: name,
      ok: false,
      reason: `tool "${name}" does not exist on this Chief; it exposes ${CHIEF_TOOLS.length} tools`,
    };
  }

  // ② 不可逆必须已确认
  if (spec.irreversible && !ctx.confirmedTools?.has(name)) {
    return {
      tool: name,
      ok: false,
      reason: `"${name}" is irreversible: ask the user to confirm via a confirmation card before running it`,
    };
  }

  // ③ 需要 admin 的操作
  if (spec.needsAdminGrant) {
    const role = await actorTeamRole(ctx.db, ctx.actorId, ctx.teamId);
    if (role !== 'admin' && role !== 'owner') {
      return {
        tool: name,
        ok: false,
        reason: `requires team admin; actor "${ctx.actorId}" is ${role === undefined ? 'not a member of' : `"${role}" in`} team "${ctx.teamId}"`,
      };
    }
  }

  const handler = registry.get(name);
  if (!handler) {
    // 声明了但还没接实现 —— 与「工具不存在」必须能区分开，Chief 才知道是
    // 「别调这个」还是「还没接」。措辞不指向任何计划文档。
    return {
      tool: name,
      ok: false,
      reason: `tool "${name}" is declared by this Chief but has no executor wired yet`,
    };
  }

  try {
    const result = await handler(ctx, args);
    return { tool: name, ok: true, result };
  } catch (e) {
    if (e instanceof HttpError) {
      return { tool: name, ok: false, reason: `${e.statusCode}: ${e.message}` };
    }
    // handler 第一行是 zod 解析，入参不对会抛 ZodError。**必须**翻译成
    // 「invalid arguments: ...」而不是让它冒穿 —— Chief 看到裸 ZodError 的
    // JSON dump 没法据此改调用，只会反复重试同样的错参数。
    if (e instanceof ZodError) {
      const detail = e.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      return { tool: name, ok: false, reason: `invalid arguments: ${detail}` };
    }
    throw e;
  }
}

/** actor 在 team 里的角色；不是成员返回 undefined。 */
async function actorTeamRole(db: Db, actorId: string, teamId: string): Promise<string | undefined> {
  const rows = await db
    .select({ role: members.role })
    .from(members)
    .where(sql`${members.teamId} = ${teamId} and ${members.actorId} = ${actorId} and ${members.memberType} = 'user'`)
    .limit(1);
  return rows[0]?.role;
}

/** 需要用户确认才能跑的不可逆工具清单（供 UI 决定弹哪种卡）。 */
export function irreversibleChiefTools(): string[] {
  return CHIEF_TOOLS.filter((t) => t.irreversible === true).map((t) => t.name);
}

/** 需要 admin 的工具清单。 */
export function adminGatedChiefTools(): string[] {
  return CHIEF_TOOLS.filter((t) => t.needsAdminGrant === true).map((t) => t.name);
}

/** 声明了但 registry 里没有 handler 的工具 —— 接线进度的自查入口。 */
export function unwiredChiefTools(registry: ChiefToolRegistry): string[] {
  return CHIEF_TOOLS.filter((t) => !registry.has(t.name)).map((t) => t.name);
}

export { requiresConfirmation };
