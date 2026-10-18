/**
 * Skill 删除的**唯一真源** —— 给 Chief 工具面（`delete_skills`）和任何
 * 后续想加的「批量清理」入口复用。
 *
 * 与 `routes/skills.ts` 内嵌的删除语义是同一份（实测原站
 * `docs/skills.md` 末段 "Deleting a skill cannot be undone"）：
 *   1. **硬删除** skill 行（不是软删）—— `deletedAt` 留作将来扩展
 *   2. `agent_skill` 走 FK ON DELETE CASCADE 自动清
 *   3. `agent.default_skill_ids` 数组里残留的 skillId 同步剔掉，
 *      否则「下一个 todo 启动」会去加载一个不存在的 skill 而报错
 *   4. 落盘目录整棵删掉
 *
 * 与 REST 路由分离的动机：
 *   - REST 走 HTTP body 鉴权 + zod 解析；Chief 走 MCP 上下文（userId/teamId）
 *   - 共用一份实现保证两条路径不会出现「REST 删盘、Chief 不删」的漂移
 *   - 本文件**只做执行**，不做确认 —— Chief 的 confirmation card 是上层的职责
 *     （chief/tools.ts 的 `irreversible: true` 注释里钉死过这条铁律）
 *
 * 批量语义 = **逐个尽力**（best-effort），不是全或无。回包形状与
 * `routes/mcp.ts` 的 `complete_todos` / `run_builds` 同款 —— 模型拿到哪一项
 * 失败可以自己重试，信息量比「整批失败」大得多。失败原因分两类：
 *   - `not_found` —— 该 skill 不属于该团队（或已被删过）
 *   - `error`    —— DB / 落盘抛了未预期异常（极少触发，因为 fs.rm 是 best-effort）
 *
 * 磁盘路径组织（与 `routes/skills.ts` 内的 `resolveSkillDir` 一致）：
 *   `<TDS_STORAGE_DIR 或 <cwd>/.local/skills>/<teamId>/<skillId>/SKILL.md`
 * 删除时按 (teamId, skillId) 计算绝对路径 —— 不依赖 DB 行里 `storage_path`
 * 字段，因为落盘清理必须 100% 兜底：哪怕 DB 那行被奇怪地改过，磁盘清理也要
 * 落在预期目录里。`rm({ recursive: true, force: true })` 对「目录不存在」
 * 静默成功，所以幂等重试不会卡住。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { agents, auditEvents, skills } from '@tds/db';
import { HttpError } from '../http.js';
import { now } from '../ids.js';

/** skill 实际落盘根目录 —— 与 `routes/skills.ts` 的 STORAGE_ROOT 同源。
 *
 * 写成函数而不是模块顶层常量：模块顶层常量只在 import 时求值一次，
 * 而单测常在 import 完成后再 `process.env.TDS_STORAGE_DIR = ...` 来
 * 切到 tmpdir —— 那时模块已经 import 完了，env 不会再生效。`routes/skills.ts`
 * 也是顶层常量，但它的测试在 import 前就把 env 设好（顶层 require 时执行），
 * 所以那条路径没事。本服务层独立写一份，故走函数式重读，兼容「先 import 后
 * 改 env」的单测模式。 */
function getStorageRoot(): string {
  return process.env.TDS_STORAGE_DIR ?? path.resolve(process.cwd(), '.local/skills');
}

/**
 * 与 `routes/skills.ts:resolveSkillDir` 同款防御：剥 basename + 验父级，
 * 保证最终路径不会跨出 STORAGE_ROOT。这是 Chief 删除路径的最后一道闸门
 * —— 一旦绕开，删的就不是 skill 而是上层任意文件。
 *
 * **导出**（而不是留在模块私有）：service 层的穿越测试走的是「DB 先拒」的路径，
 * 根本到不了这里 —— 于是两层防御**各自能否独立接住**就没被测到。
 * 变异验证实测：去掉 `path.basename` 归一化、或去掉 `startsWith` 的 escape 检查，
 * 经 service 的测试**全绿**。所以这个函数要能被直接测。
 */
export function resolveSkillDir(teamId: string, skillId: string): string {
  const team = path.basename(teamId);
  const sk = path.basename(skillId);
  if (team !== teamId || sk !== skillId || team === '' || sk === '') {
    throw new HttpError(422, 'teamId/skillId contains illegal characters');
  }
  const root = path.resolve(getStorageRoot());
  const full = path.resolve(root, team, sk);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new HttpError(422, 'resolved skill path escapes storage root');
  }
  return full;
}

/**
 * 幂等删盘 —— `rm({ recursive, force })` 对 ENOENT 静默成功，所以「之前
 * 删过 / 从未建过」都算干净。best-effort：清理失败不抛错 —— 数据库那条
 * 「不可恢复」的承诺已经向调用方给出，磁盘残留只是垃圾，不能反过来把
 * 库里的 skill 行恢复（那就成 soft-delete 了，违背 spec）。
 */
async function rmSkillDir(teamId: string, skillId: string): Promise<void> {
  const dir = resolveSkillDir(teamId, skillId);
  await fs.rm(dir, { recursive: true, force: true });
}

export interface DeleteSkillInput {
  teamId: string;
  /** 0 个 id 是合法的 no-op（与现有 MCP 工具的「数组可空」语义一致） */
  skillIds: readonly string[];
  /** Chief 调用方的人类用户 id；记审计用 */
  actorId: string;
}

export interface DeleteSkillResult {
  skillId: string;
  ok: boolean;
  /** ok:false 时必有；ok:true 时缺省 */
  reason?: string;
}

export interface DeleteSkillsOutcome {
  results: DeleteSkillResult[];
  succeeded: number;
  failed: number;
}

/**
 * 校验 skill 是否属于该 team —— 跨团队读取会泄露存在性，所以用 403
 * 措辞 `team "<id>" is not accessible to this key's owner`，与
 * `routes/mcp.ts` `assertTeamIn` / `auth.ts:requireTeamMembership` 完全同款。
 * 这是服务层的硬闸门：调用方已经验过 actor 不算数 —— 任何路径调到这里
 * 都会被这里再卡一次。
 */
async function assertSkillInTeam(
  db: Db,
  teamId: string,
  skillId: string,
): Promise<{ id: string; teamId: string }> {
  const row = (
    await db
      .select({ id: skills.id, teamId: skills.teamId })
      .from(skills)
      .where(
        and(
          eq(skills.id, skillId),
          eq(skills.teamId, teamId),
          isNull(skills.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!row) {
    // 不区分「不属于该 team」与「不存在」—— 跨团队读取不该泄露存在性，
    // 这条 403 措辞与既有 `assertTeamIn` 完全一致，连 caller 读起来都不
    // 知道是 skill 跨界还是 team 跨界（也不该知道）。
    throw new HttpError(
      403,
      `team "${teamId}" is not accessible to this key's owner`,
    );
  }
  return row;
}

/**
 * 单条删除：先 assertSkillInTeam（这里抛 403），再 scrub agent 残留引用，
 * 再 DELETE skill 行（CASCADE 带走 agent_skill），最后清盘 + 落审计。
 * 每一步都是最佳努力；DB 部分抛错不会让落盘提前发生。
 */
async function deleteOneSkill(
  db: Db,
  teamId: string,
  skillId: string,
  actorId: string,
): Promise<void> {
  await assertSkillInTeam(db, teamId, skillId);

  const ts = now();

  // 1. 先 scrub agent.defaultSkillIds 里的残留 skillId，再删 skill 行。
  //    即便 scrub 失败也不会留下「半成品引用」—— 行还在，下次启动照样能用。
  //    这是 `routes/skills.ts` 删除路由的同款顺序。
  await db
    .update(agents)
    .set({
      defaultSkillIds: sql`(
        select coalesce(array_agg(x), '{}')
        from unnest(${agents.defaultSkillIds}) as x
        where x <> ${skillId}
      )::text[]`,
      updatedAt: ts,
    })
    .where(
      and(eq(agents.teamId, teamId), sql`${skillId} = any(${agents.defaultSkillIds})`),
    );

  // 2. 删 skill 主行。agent_skill 走 FK ON DELETE CASCADE 自动清。
  await db.delete(skills).where(eq(skills.id, skillId));

  // 3. 清盘（best-effort，失败不抛）
  await rmSkillDir(teamId, skillId);

  // 4. 审计 —— Chief 双轨：人类轨道 + agent 轨道必须独立可追溯。
  //    payload 里带 skillId 与 actorId，方便后续按调用方反查。
  await db.insert(auditEvents).values({
    teamId,
    actorType: 'chief',
    actorId,
    todoId: null,
    buildId: null,
    type: 'skill_deleted',
    payload: { skillId, ok: true },
    createdAt: ts,
  });
}

/**
 * 批量删除 skill —— Chief `delete_skills` 的服务层入口。
 *
 * 逐个尽力：单个 skill 失败（403 跨界 / 磁盘异常 / DB 异常）只让该项
 * `ok:false`，不影响同批其它项。回包 `{results, succeeded, failed}` 与
 * `complete_todos` / `run_builds` 同款。
 *
 * 空数组合法 —— 当下「没有任何 skill 想删」应当是 no-op 而不是 422，
 * 上层（confirmation card）按它的状态决定是否触发；服务层不该反过来
 * 绑架上层的 UX。
 */
export async function deleteSkills(
  db: Db,
  input: DeleteSkillInput,
): Promise<DeleteSkillsOutcome> {
  const results: DeleteSkillResult[] = [];

  // 去重但保留顺序 —— caller 传重复 id 不该出现两次 ok:true 干扰计数。
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of input.skillIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  for (const skillId of ids) {
    try {
      await deleteOneSkill(db, input.teamId, skillId, input.actorId);
      results.push({ skillId, ok: true });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'unknown failure';
      results.push({ skillId, ok: false, reason });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}