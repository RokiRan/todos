/**
 * Agent 管理员写操作的**唯一真源**。
 *
 * 这是 Chief 工具面 `create_agent` / `update_agent` / `delete_agents` 的
 * 服务层 —— `apps/server/src/chief/executor.ts` 与未来的 REST 路由都从这里取。
 *
 * 与 `services/todos.ts` / `services/schedules.ts` 同构：纯服务层，不认 HTTP、
 * 不认 JSON-RPC，抛 `HttpError`。授权判定（是不是这个团队、是不是 admin）由
 * 调用方先做 —— REST 侧是 `actorForTeam`，MCP 侧是 `requireTeamAccess` +
 * `requireTeamAdminForTool`。这里只管 agent 本身的业务规则。
 *
 * ── 三条规则（都来自 `recon/docs/agents.md`） ──
 *   1. 写操作要 team admin（agents.md "Changes require a team admin"）。
 *      与 `delete_agents` spec 上 `needsAdminGrant: true` 同源；`create_agent` /
 *      `update_agent` spec 上没有 `needsAdminGrant`，但 agents.md 文档铁律一致，
 *      所以这三个工具全部走 admin 闸门。
 *   2. agent 描述（description）≤ 800 字符 —— 与 `quota.roleDescription` 共用
 *      同一上限（agents.md "Role ... up to 800 characters"）。
 *   3. 每 agent 默认 skill ≤ 10（agents.md "default skills (up to 10)"），
 *      与 `routes/skills.ts` 的 `MAX_DEFAULT_SKILLS_PER_AGENT` 同源。
 *
 * ── 删除语义（按 agents.md "Removing an agent"） ──
 *   原文 "A removed agent stops taking on new work, and any active task for it
 *   is stopped. Its memory remains stored ... but is no longer used" —— 与
 *   schedule 的 soft-delete 同款「停用即忘」语义。
 *
 *   **为什么是 soft-delete 不是 hard-delete**：
 *   `agents.id` 是 `chiefs.agent_id` / `builds.agent_id` / `agent_memory.agent_id`
 *   / `agent_skill.agent_id` / `agent_connection_grant.agent_id` / `todo.agent_id`
 *   等多张表的外键：
 *     - `chiefs` / `agent_memory` / `agent_skill` / `agent_connection_grant` 走
 *       `ON DELETE CASCADE`（理论上可删）
 *     - `builds.agent_id` 是 `NOT NULL references agents.id`，**没有 cascade**
 *     - `todos.agent_id` 也是裸 references，**没有 cascade**
 *   硬删会撞 `builds` / `todos` 的 FK —— 而这些表的「agent」字段产品语义是
 *   历史归属，不能因为 agent 删了就 cascade 掉历史 build/todo 数据。
 *   所以走 `deletedAt` soft-delete，与 schedules.ts 的 deleteSchedule 同款。
 *   「activeTaskCount = 0」的额外校验来自 agents.md "any active task for it
 *   is stopped" —— soft-delete 后新 todo 不再分给这个 agent（清单过滤
 *   `isNull(agents.deletedAt)` 已经在 `routes/mcp.ts` 的 agents case 与
 *   `routes/skills.ts` 的 skill binding 里实现）。
 *
 * ── 跨团队校验 ──
 *   `defaultSkillIds` 里的每个 skillId 必须属于该 team（防跨团队挂载：把
 *   team A 的 skillId 写到 team B 的 agent 上 = skill 跨团队泄露）；
 *   `provider` 字段必须属于该 team（`providers.teamId` 的 provider 集合
 *   才算「pi 模型的来源」）。两者都是 agents.md 「default skills」「Runtime
 *   & model」字段的直接语义。
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { agents, agentSkills, auditEvents, providers, skills } from '@tds/db';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import { requireTeamAdmin } from '../auth.js';

// ── 上限常量 ────────────────────────────────────────────────

/**
 * agent 描述上限 800 字符 —— agents.md "Role ... up to 800 characters"。
 * 与 `packages/protocol/src/quota.ts` 的 `roleDescription` 共用同一条闸门。
 */
const DESCRIPTION_MAX_CHARS = 800;

/**
 * displayName 长度上限 —— agents.md 原文没说硬上限。
 * 取 280 是为了与 `services/todos.ts` 的 todo.title 上限对齐（实测原站
 * 习惯：人可见的短文本字段都是 1..280）。这是推断，写在注释里。
 */
const DISPLAY_NAME_MAX_CHARS = 280;

/**
 * 默认 skill 数组上限 —— agents.md "default skills (up to 10)"。
 * 与 `routes/skills.ts:49` 的 `MAX_DEFAULT_SKILLS_PER_AGENT` 同源。
 */
const MAX_DEFAULT_SKILLS_PER_AGENT = 10;

/** Free 档 agent 上限 —— packages/protocol/src/quota.ts 的 `FREE_LIMITS.agents`。 */
const MAX_AGENTS_PER_TEAM = 5;

// ── 公共类型 ────────────────────────────────────────────────

/**
 * 写路径返回的 agent 摘要 —— 与 `routes/mcp.ts` 的 agents case 字段对齐，
 * 加一个 `description` / `grants` 字段供 Chief 工具面回包用。**绝不**返回
 * 任何凭据字段（agent 表本来也没有凭据列，但显式声明防漂移）。
 */
export interface AgentSummary {
  id: string;
  teamId: string;
  displayName: string;
  description: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  defaultSkillIds: readonly string[];
  grants: Record<string, boolean>;
  activeTaskCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CreateAgentInput {
  teamId: string;
  /** 调用方 userId —— 仅做审计 actorId，不参与鉴权（鉴权由调用方走 admin 闸门）。 */
  actorId: string;
  displayName: string;
  description?: string | null;
  /** providerId（teams 表里的 provider 集合），与 `agent.model_id` 配套出现。 */
  provider?: string | null;
  /** modelId = provider.models[] 里的某一项；与 `agent.provider` 配套出现。 */
  modelId?: string | null;
  /**
   * 文档枚举（agents.md 未列硬清单，但 recon/docs/runtimes.md 与原站实测都用）：
   * `'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`。
   * 这里只做长度上限，不做枚举校验（pi-ai 的 `thinkingLevelMap` 由 provider
   * 决定，调用方传错值会在 claim 阶段被拒）。
   */
  thinkingLevel?: string | null;
  /** 整体替换 defaultSkillIds 数组 —— 与 `routes/skills.ts` 的「整体替换」语义一致。 */
  defaultSkillIds?: readonly string[];
  /** 高影响能力开关；键名以 agents.md 原文为准。 */
  grants?: Record<string, boolean>;
}

export interface UpdateAgentPatch {
  displayName?: string;
  description?: string | null;
  /** 显式传 `null` = 清空；不传 = 不动。 */
  provider?: string | null;
  /** 显式传 `null` = 清空；不传 = 不动。 */
  modelId?: string | null;
  /** 显式传 `null` = 清空；不传 = 不动。 */
  thinkingLevel?: string | null;
  /** 整体替换。传空数组 = 清空所有默认 skill。 */
  defaultSkillIds?: readonly string[];
  grants?: Record<string, boolean>;
}

export interface UpdateAgentInput {
  teamId: string;
  agentId: string;
  actorId: string;
  patch: UpdateAgentPatch;
}

export interface DeleteAgentsInput {
  teamId: string;
  agentIds: readonly string[];
  actorId: string;
}

export interface DeleteAgentResult {
  agentId: string;
  ok: boolean;
  /** ok=false 时才有；同 Chief 批量工具的 `reason` 字段语义（`mcp.ts:913`）。 */
  reason?: string;
}

export interface DeleteAgentsOutput {
  results: DeleteAgentResult[];
  succeeded: number;
  failed: number;
}

// ── 内部工具函数 ────────────────────────────────────────────

function toSummary(row: typeof agents.$inferSelect): AgentSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    displayName: row.displayName,
    description: row.description,
    provider: row.provider,
    modelId: row.modelId,
    thinkingLevel: row.thinkingLevel,
    defaultSkillIds: row.defaultSkillIds,
    grants: row.grants,
    activeTaskCount: row.activeTaskCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * 校验 displayName —— 非空 + 长度上限。agents.md 没给硬上限，
 * 这里取 280（与 todo.title 对齐）。
 */
function assertValidDisplayName(displayName: string): void {
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new HttpError(422, 'displayName must be a non-empty string');
  }
  if (displayName.length > DISPLAY_NAME_MAX_CHARS) {
    throw new HttpError(
      422,
      `displayName exceeds ${DISPLAY_NAME_MAX_CHARS} characters (got ${displayName.length})`,
    );
  }
}

/**
 * 校验 description 长度 —— 800 字符上限（agents.md）。
 */
function assertValidDescription(description: string | null | undefined): void {
  if (description === null || description === undefined) return;
  if (typeof description !== 'string') {
    throw new HttpError(422, 'description must be a string or null');
  }
  if (description.length > DESCRIPTION_MAX_CHARS) {
    throw new HttpError(
      422,
      `description exceeds ${DESCRIPTION_MAX_CHARS} characters (got ${description.length})`,
    );
  }
}

/**
 * 校验 `provider` + `modelId` 配套 —— agents.md "Runtime & model"：
 * agent.provider 存 providerId，agent.model_id 存 modelId（routes/machine.ts:323）。
 *   - 两个都给 → 必须 (1) provider 属于该 team，(2) modelId 在 provider.models[] 里
 *   - 只给一个 → 拒绝（缺另一伴就是「半选状态」）
 *   - 都不给 → 合法（agent 上线后再选模型）
 */
async function assertProviderModelPair(
  db: Db,
  teamId: string,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): Promise<void> {
  const hasProvider = providerId !== null && providerId !== undefined && providerId !== '';
  const hasModel = modelId !== null && modelId !== undefined && modelId !== '';
  if (hasProvider !== hasModel) {
    throw new HttpError(
      422,
      'provider and modelId must be supplied together (or both omitted)',
    );
  }
  if (!hasProvider) return;

  const rows = await db
    .select({ providerId: providers.providerId, models: providers.models })
    .from(providers)
    .where(and(eq(providers.teamId, teamId), eq(providers.providerId, providerId)))
    .limit(1);
  const prov = rows[0];
  if (!prov) {
    throw new HttpError(422, `provider "${providerId}" is not in team "${teamId}"`);
  }
  const list = (prov.models ?? []) as Array<{ id: string }>;
  if (!list.some((m) => m.id === modelId)) {
    throw new HttpError(
      422,
      `modelId "${modelId}" is not in provider "${providerId}"`,
    );
  }
}

/**
 * 校验 `defaultSkillIds` 数组 —— ≤10 且所有 skill 都属于该 team 且未软删。
 * 与 `routes/skills.ts:456` 的 BindAgentSkillBody 同款语义：
 * 「整体替换 defaultSkillIds 数组」。
 */
async function assertDefaultSkillsBelong(
  db: Db,
  teamId: string,
  defaultSkillIds: readonly string[],
): Promise<void> {
  // 长度上限（agents.md "default skills (up to 10)"）
  if (defaultSkillIds.length > MAX_DEFAULT_SKILLS_PER_AGENT) {
    throw new HttpError(
      422,
      `agent can carry at most ${MAX_DEFAULT_SKILLS_PER_AGENT} default skills (got ${defaultSkillIds.length})`,
    );
  }
  if (defaultSkillIds.length === 0) return;

  // 去重 —— 重复 skillId 是用户的拼写错误，安静地接受会让「同一个
  // skill 加 2 次」的 bug 很难排查。
  const wanted = Array.from(new Set(defaultSkillIds));
  if (wanted.length !== defaultSkillIds.length) {
    throw new HttpError(422, 'defaultSkillIds must not contain duplicates');
  }

  const found = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        inArray(skills.id, wanted),
        eq(skills.teamId, teamId),
        isNull(skills.deletedAt),
      ),
    );
  if (found.length !== wanted.length) {
    const known = new Set(found.map((r) => r.id));
    const missing = wanted.filter((s) => !known.has(s));
    throw new HttpError(422, `unknown skill ids: ${missing.join(', ')}`);
  }
}

/**
 * 同步 agent_skill 关联行 —— 这是 `agent.defaultSkillIds` 与
 * `agent_skill` 双写之间的辅助键：
 *   - `defaultSkillIds` 数组里的 skillId → `agent_skill` 行 isDefault=true
 *   - 数组里没有的 skillId → 该 `agent_skill` 行删掉（不再挂默认）
 *
 * 仅在「用户改 defaultSkillIds」时跑。skill 主体仍由 `services/skill-deletion.ts`
 * 走硬删（agents.md "stop carrying it from their next turn"）。
 */
async function syncAgentSkillRows(
  db: Db,
  agentId: string,
  defaultSkillIds: readonly string[],
): Promise<void> {
  const wanted = Array.from(new Set(defaultSkillIds));

  // 先把该 agent 当前所有的 agent_skill 关联读出来 —— 与 wanted 比差集，
  // 删差集、补交集。这一段完全用 typed drizzle，安全、可移植。
  const existing = await db
    .select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId));
  const existingIds = new Set(existing.map((r) => r.skillId));
  const wantedSet = new Set(wanted);

  const toRemove = [...existingIds].filter((s) => !wantedSet.has(s));
  if (toRemove.length > 0) {
    await db
      .delete(agentSkills)
      .where(
        and(
          eq(agentSkills.agentId, agentId),
          inArray(agentSkills.skillId, toRemove),
        ),
      );
  }

  for (const skillId of wanted) {
    if (existingIds.has(skillId)) continue;
    await db
      .insert(agentSkills)
      .values({ agentId, skillId, isDefault: true })
      .onConflictDoUpdate({
        target: [agentSkills.agentId, agentSkills.skillId],
        set: { isDefault: true },
      });
  }
}

/**
 * 校验 agent 属于该 team 且未软删 —— 不存在或跨团队 → 404。
 * 与 `routes/skills.ts:loadSkillForTeam` 同款。
 */
async function loadAgentForTeam(
  db: Db,
  teamId: string,
  agentId: string,
): Promise<typeof agents.$inferSelect> {
  const row = (
    await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.teamId, teamId), isNull(agents.deletedAt)))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(404, 'agent not found');
  return row;
}

/** 写 audit_event —— `actorType: 'chief'` 因为 Chief 工具面发起的写。 */
async function writeAuditRow(
  db: Db,
  args: { teamId: string; actorId: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditEvents).values({
    teamId: args.teamId,
    actorType: 'chief',
    actorId: args.actorId,
    todoId: null,
    buildId: null,
    type: args.type,
    payload: args.payload,
    createdAt: now(),
  });
}

// ── 对外函数 ────────────────────────────────────────────────

/**
 * 创建一个 agent。admin 闸门由调用方先走（REST 侧 `actorForTeam`、MCP 侧
 * `requireTeamAdminForTool`）—— 这里重复调一次 `requireTeamAdmin`，让
 * 即使有人绕过调用方直接打服务层也会被挡。
 */
export async function createAgent(
  db: Db,
  input: CreateAgentInput,
): Promise<AgentSummary> {
  await requireTeamAdmin(db, input.actorId, input.teamId, 'changing agents');

  assertValidDisplayName(input.displayName);
  assertValidDescription(input.description ?? null);

  // Free 档 ≤5 —— packages/protocol/src/quota.ts 的 `FREE_LIMITS.agents`
  const countRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.teamId, input.teamId), isNull(agents.deletedAt)));
  const current = countRow[0]?.c ?? 0;
  if (current >= MAX_AGENTS_PER_TEAM) {
    throw new HttpError(422, `agent limit reached (${MAX_AGENTS_PER_TEAM} per team)`);
  }

  await assertProviderModelPair(
    db,
    input.teamId,
    input.provider ?? null,
    input.modelId ?? null,
  );

  const defaultSkillIds = input.defaultSkillIds ?? [];
  await assertDefaultSkillsBelong(db, input.teamId, defaultSkillIds);

  const ts = now();
  const id = newId();
  await db.insert(agents).values({
    id,
    teamId: input.teamId,
    displayName: input.displayName,
    description: input.description ?? null,
    provider: input.provider ?? null,
    modelId: input.modelId ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    defaultSkillIds: Array.from(defaultSkillIds),
    grants: input.grants ?? {},
    activeTaskCount: 0,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  });

  // 同步 agent_skill 关联行 —— 与 defaultSkillIds 双写一致
  await syncAgentSkillRows(db, id, defaultSkillIds);

  await writeAuditRow(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    type: 'agent_created',
    payload: { agentId: id, displayName: input.displayName },
  });

  const row = (
    await db.select().from(agents).where(eq(agents.id, id)).limit(1)
  )[0];
  if (!row) throw new HttpError(500, 'agent vanished after insert');
  return toSummary(row);
}

/**
 * 部分更新 agent —— 只覆盖 `patch` 里显式给出的字段；未传的字段保持原值。
 * 跨团队 / 软删 → 404（与 `services/schedules.ts:updateSchedule` 同款）。
 */
export async function updateAgent(
  db: Db,
  input: UpdateAgentInput,
): Promise<AgentSummary> {
  await requireTeamAdmin(db, input.actorId, input.teamId, 'changing agents');

  const current = await loadAgentForTeam(db, input.teamId, input.agentId);

  // 字段校验
  if (input.patch.displayName !== undefined) {
    assertValidDisplayName(input.patch.displayName);
  }
  if (input.patch.description !== undefined) {
    assertValidDescription(input.patch.description);
  }

  // provider/modelId 配套校验 —— 必须以「最终态」判，所以先合并当前值
  // 再传给 assertProviderModelPair。
  if (
    input.patch.provider !== undefined ||
    input.patch.modelId !== undefined
  ) {
    const finalProvider =
      input.patch.provider !== undefined ? input.patch.provider : current.provider;
    const finalModelId =
      input.patch.modelId !== undefined ? input.patch.modelId : current.modelId;
    await assertProviderModelPair(db, input.teamId, finalProvider, finalModelId);
  }

  if (input.patch.defaultSkillIds !== undefined) {
    await assertDefaultSkillsBelong(db, input.teamId, input.patch.defaultSkillIds);
  }

  // 组装 patch —— 部分更新：未传的字段**不**写入 set
  const set: Partial<typeof agents.$inferInsert> = { updatedAt: now() };
  if (input.patch.displayName !== undefined) set.displayName = input.patch.displayName;
  if (input.patch.description !== undefined) set.description = input.patch.description;
  if (input.patch.provider !== undefined) set.provider = input.patch.provider;
  if (input.patch.modelId !== undefined) set.modelId = input.patch.modelId;
  if (input.patch.thinkingLevel !== undefined) set.thinkingLevel = input.patch.thinkingLevel;
  if (input.patch.defaultSkillIds !== undefined) {
    set.defaultSkillIds = Array.from(input.patch.defaultSkillIds);
  }
  if (input.patch.grants !== undefined) set.grants = input.patch.grants;

  // no-op：patch 里一个字段都没传（除了 updatedAt），不要写库也不要审计。
  const meaningfulKeys = Object.keys(input.patch);
  if (meaningfulKeys.length === 0) {
    return toSummary(current);
  }

  await db.update(agents).set(set).where(eq(agents.id, input.agentId));

  // defaultSkillIds 改了 → 同步 agent_skill 关联行
  if (input.patch.defaultSkillIds !== undefined) {
    await syncAgentSkillRows(db, input.agentId, input.patch.defaultSkillIds);
  }

  await writeAuditRow(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    type: 'agent_updated',
    payload: {
      agentId: input.agentId,
      changedKeys: meaningfulKeys,
    },
  });

  const row = (
    await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1)
  )[0];
  if (!row) throw new HttpError(404, 'agent not found');
  return toSummary(row);
}

/**
 * 批量删除 agent —— 逐个尽力，与 `mcp.ts:complete_todos` 同款语义：
 *   - 一项失败不影响同批其它项
 *   - 每项 `{agentId, ok, reason?}`；模型可据此自行重试失败项
 *
 * 删除策略 = **soft-delete**（写 `deletedAt`），依据见文件头注释。
 * 调用方必须先走 admin 闸门；这里再调一次 `requireTeamAdmin` 兜底。
 */
export async function deleteAgents(
  db: Db,
  input: DeleteAgentsInput,
): Promise<DeleteAgentsOutput> {
  await requireTeamAdmin(db, input.actorId, input.teamId, 'changing agents');

  const results: DeleteAgentResult[] = [];

  for (const agentId of input.agentIds) {
    try {
      const row = await loadAgentForTeam(db, input.teamId, agentId);
      await db
        .update(agents)
        .set({ deletedAt: now(), updatedAt: now() })
        .where(eq(agents.id, agentId));

      await writeAuditRow(db, {
        teamId: input.teamId,
        actorId: input.actorId,
        type: 'agent_deleted',
        payload: { agentId, displayName: row.displayName },
      });

      results.push({ agentId, ok: true });
    } catch (e) {
      // 与 `mcp.ts:898` 同款：单项失败不阻断同批其它项
      const reason =
        e instanceof HttpError
          ? `${e.statusCode}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      results.push({ agentId, ok: false, reason });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
