import { pgTable, text, bigint, boolean, integer, jsonb, pgEnum, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Drizzle schema。
 *
 * 字段命名对齐 2026-10-16 实测（recon/03-app-api.md），
 * 而非原始草案 —— 差异见每处行内注释。
 *
 * 全站时间戳用 bigint（毫秒），不是 Postgres timestamp：
 * 实测原站每个实体的 createdAt/updatedAt 都是毫秒整数。
 */

export const todoPhase = pgEnum('todo_phase', [
  'todo', 'queued', 'planning', 'confirm',
  'implement', 'review', 'reviewing',
  'done', 'failed', 'closed',
]);

export const stepStatus = pgEnum('step_status', [
  'queued', 'pending', 'running', 'succeeded', 'failed', 'cancelled',
]);

export const docKind = pgEnum('doc_kind', [
  'plan', 'changes', 'question', 'confirm', 'input', 'review',
]);

export const memberType = pgEnum('member_type', ['user', 'agent']);
export const memberRole = pgEnum('member_role', ['admin', 'member']);

// ── 多租户 ──────────────────────────────────────────────────────

export const users = pgTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  googleId: text('google_id'),
  githubId: text('github_id'),
  locale: text('locale').notNull().default('en'),
  status: text('status').notNull().default('active'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const teams = pgTable('team', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // 复刻只做 Free，plan 字段保留以便将来扩展
  plan: text('plan').notNull().default('free'),
  storageQuota: bigint('storage_quota', { mode: 'number' }).notNull().default(1073741824),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const members = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    memberType: memberType('member_type').notNull(),
    role: memberRole('role').notNull().default('member'),
    joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
    // 实测：member 实体带 v 乐观锁版本号
    v: bigint('v', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('member_team_actor_type_uq').on(t.teamId, t.actorId, t.memberType),
    index('member_team_idx').on(t.teamId),
  ],
);

// ── Agent / Chief ──────────────────────────────────────────────

export const agents = pgTable(
  'agent',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    // 文档硬上限 800 字符，在 API 层校验
    description: text('description'),
    // 实测 actor 字段是 provider，不是 runtime
    provider: text('provider'),
    modelId: text('model_id'),
    thinkingLevel: text('thinking_level'),
    defaultSkillIds: text('default_skill_ids').array().notNull().default([]),
    grants: jsonb('grants').$type<Record<string, boolean>>().notNull().default({}),
    activeTaskCount: integer('active_task_count').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('agent_team_idx').on(t.teamId)],
);

export const chiefs = pgTable(
  'chief',
  {
    // 实测构造规则：chief-<userId>-<teamId>
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => agents.id),
    // 用户编辑，Chief 只读
    charter: text('charter'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('chief_user_team_uq').on(t.userId, t.teamId)],
);

export const chiefThreads = pgTable(
  'chief_thread',
  {
    id: text('id').primaryKey(),
    chiefId: text('chief_id').notNull().references(() => chiefs.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // 实测：{runtime,id,openedAt}
    session: jsonb('session').$type<{ runtime: string; id: string; openedAt: number }>().notNull(),
    pendingSessionResumeAt: bigint('pending_session_resume_at', { mode: 'number' }),
    // 实测：工具定义变更检测
    toolDefHashes: jsonb('tool_def_hashes').$type<Record<string, string>>().notNull().default({}),
    watchedTodos: text('watched_todos').array().notNull().default([]),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    lastTurnAt: bigint('last_turn_at', { mode: 'number' }),
    v: bigint('v', { mode: 'number' }).notNull().default(0),
  },
  (t) => [index('thread_chief_idx').on(t.chiefId)],
);

/**
 * Chief 对话消息 —— 2026-07-17 新增。
 *
 * **为什么不用 `build_message`**（这是本表存在的全部理由）：之前 `routes/chief.ts`
 * 的注释写着「Chief 对话复用 build_message，用 `thread.session.id` 当 buildId」。
 * 那个假设**在数据库层不成立** —— `build_message.build_id` 是指向 `build` 的
 * **真外键**，而 Chief thread 的 `session.id` 背后没有 build 行，写入直接被数据库
 * 拒绝（实测 500：`build_message_build_id_build_id_fk`）。补一条真 build 行也不通：
 * `builds.todo_id` 是 NOT NULL，而 Chief 自己不拥有 todo，硬造等于往看板塞假 todo。
 *
 * 独立一张表还顺带解决两件事：
 *   - Chief 与 build 的消息**天然可区分**，不必靠 `build_id` 猜来源
 *   - 不必给 `build_message` 塞「没有 build 的 build_id」这种特殊值
 *
 * 形状刻意贴着 `build_message`：`role` / `content` / `seq` / `triggerBy` 同名同义，
 * 于是 `services/conversations.ts` 那套「按 seq 增量拉」的读法能直接复用逻辑。
 */
export const chiefMessages = pgTable(
  'chief_message',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull().references(() => chiefThreads.id, { onDelete: 'cascade' }),
    // system | user | assistant | tool（与 ModelMessage.role 同名同义）
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** `role='tool'` 时指向它回应的那个 assistant.tool_calls 条目 */
    toolCallId: text('tool_call_id'),
    /**
     * `role='assistant'` 时这一回合请求了哪些工具。
     * 回灌历史时**必须**带上 —— OpenAI 兼容端点是硬契约：`tool` 消息要能对应到
     * 某条 assistant 的 `tool_calls`，对不上下一轮直接 400。
     */
    toolCalls: jsonb('tool_calls').$type<Array<{ id: string; name: string; args: Record<string, unknown> }> | null>(),
    /** 人类/agent 身份的归责（user / chief / agent / schedule） */
    triggerBy: text('trigger_by'),
    isError: boolean('is_error').notNull().default(false),
    /** 与 build_message 同款 per-thread 递增序号，增量拉取用 */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('chief_message_thread_seq_idx').on(t.threadId, t.seq)],
);

export const agentMemories = pgTable(
  'agent_memory',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    // FK 延后到 project 建表后添加
    projectId: text('project_id'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('memory_agent_idx').on(t.agentId)],
);

// ── Machine ────────────────────────────────────────────────────

export const machines = pgTable(
  'machine',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    deviceId: text('device_id').notNull(),
    enrolledBy: text('enrolled_by').notNull(),
    buildEnabled: boolean('build_enabled').notNull().default(true),
    shellEnabled: boolean('shell_enabled').notNull().default(false),
    maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(6),
    cliVersion: text('cli_version'),
    workspacesDir: text('workspaces_dir'),
    // 实测：["claude-code","codex","omp"]
    runtimes: text('runtimes').array().notNull().default([]),
    disabledRuntimes: text('disabled_runtimes').array().notNull().default([]),
    arch: text('arch'),
    runner: text('runner'),
    platform: text('platform'),
    hardware: jsonb('hardware').$type<Record<string, unknown>>().notNull().default({}),
    tailnetAddr: text('tailnet_addr'),
    tunnelError: text('tunnel_error'),
    perf: jsonb('perf').$type<Record<string, unknown>>(),
    isOnline: boolean('is_online').notNull().default(false),
    lastHeartbeatAt: bigint('last_heartbeat_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('machine_team_idx').on(t.teamId)],
);

export const machineRuntimeUsage = pgTable(
  'machine_runtime_usage',
  {
    machineId: text('machine_id').notNull().references(() => machines.id, { onDelete: 'cascade' }),
    runtime: text('runtime').notNull(),
    fetchedAt: bigint('fetched_at', { mode: 'number' }).notNull(),
    // 实测多一个 no_limits
    status: text('status').notNull(),
    account: jsonb('account').$type<{ id: string | null; plan: string | null; email: string | null }>().notNull(),
    windows: jsonb('windows').$type<unknown[]>().notNull().default([]),
    models: jsonb('models').$type<unknown[]>().notNull().default([]),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.runtime] })],
);

// ── Project ────────────────────────────────────────────────────

export const projects = pgTable(
  'project',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // MVP 只做 external；保留 platform 枚举位
    provider: text('provider').notNull().default('external'),
    repoKind: text('repo_kind').notNull().default('other'),
    repoFullName: text('repo_full_name'),
    repoUrl: text('repo_url'),
    defaultBranch: text('default_branch').notNull().default('main'),
    description: text('description'),
    iconUrl: text('icon_url'),
    // 实测：todo 编号分配器
    nextSeqNum: integer('next_seq_num').notNull().default(1),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('project_team_idx').on(t.teamId)],
);

export const repoCredentials = pgTable('repo_credential', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // 外部 Git 留空 username 时实际发 'oauth2'（实测文档坑）
  username: text('username'),
  // AES-256-GCM，永不回传
  encToken: text('enc_token').notNull(),
  encNonce: text('enc_nonce').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
});

// ── Todo / Build —— 状态机持久层 ────────────────────────────────

export const todos = pgTable(
  'todo',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // 人类可读编号，实测字段名 seqNum
    seqNum: integer('seq_num').notNull(),
    // 恒为人类成员，文档铁律
    ownerMemberId: text('owner_member_id').notNull(),
    agentId: text('agent_id').references(() => agents.id),
    title: text('title').notNull(),
    // 实测：描述字段就叫 spec
    spec: text('spec'),
    tagIds: text('tag_ids').array().notNull().default([]),
    phase: todoPhase('phase').notNull().default('todo'),
    // 创建者身份（2026-10-18 新增）：看板筛选 `createdByType` 需要此字段。
    // - 'user'   REST 创建路径（dashboard / new-todo 等前端入口）
    // - 'chief'  Chief 在 chief_thread 对话里被派工时
    // - 'agent'  MCP 工具面 create_todo 由模型代发
    // migration：`drizzle/0004_todo_created_by_type.sql` 加了列 + CHECK，
    // 既有行填 'user'（DEFAULT）—— 见该文件的「为什么」。
    createdByType: text('created_by_type').notNull().default('user'),
    planFirst: boolean('plan_first').notNull().default(true),
    separatePlanBuild: boolean('separate_plan_build').notNull().default(false),
    withChecklist: boolean('with_checklist').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('todo_project_seq_uq').on(t.projectId, t.seqNum),
    index('todo_project_phase_idx').on(t.projectId, t.phase),
  ],
);

export const builds = pgTable(
  'build',
  {
    // buildId 同时就是分支名：branch === `tds/conv-${buildId}`（实测确认）
    id: text('id').primaryKey(),
    todoId: text('todo_id').notNull().references(() => todos.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    branch: text('branch').notNull(),
    prevPhase: todoPhase('prev_phase'),
    // 实测 build.triggerSource
    triggerSource: text('trigger_source').notNull().default('user'),
    settlementCode: text('settlement_code'),
    errorMessage: text('error_message'),
    withPlan: boolean('with_plan').notNull().default(false),
    withChecklist: boolean('with_checklist').notNull().default(false),
    pinnedMachineId: text('pinned_machine_id').references(() => machines.id),
    agentId: text('agent_id').notNull().references(() => agents.id),
    planDocId: text('plan_doc_id'),
    changesDocId: text('changes_doc_id'),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    diffHash: text('diff_hash'),
    checkpointError: text('checkpoint_error'),
    branchPushedAt: bigint('branch_pushed_at', { mode: 'number' }),
    pushError: text('push_error'),
    // 实测 Restore 的真实结构
    pendingRestore: jsonb('pending_restore').$type<{
      sessionLeafEntryId: string;
      commitSha: string;
      sessionId: string;
    } | null>(),
    session: jsonb('session').$type<{ runtime: string; id: string; openedAt: number }>().notNull(),
    pendingSessionResumeAt: bigint('pending_session_resume_at', { mode: 'number' }),
    usageByModel: jsonb('usage_by_model').$type<unknown[]>().notNull().default([]),
    worktreePath: text('worktree_path'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    finishedAt: bigint('finished_at', { mode: 'number' }),
    // 实测：版本号，配合 SSE 增量
    v: bigint('v', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('build_todo_n_uq').on(t.todoId, t.n),
    index('build_todo_idx').on(t.todoId),
  ],
);

/**
 * 「同步到机器」的指令队列 —— 2026-10-18 新增，迁移
 * `drizzle/0005_machine_pending_action.sql`。
 *
 * 数据流（server 写、daemon 读）：
 *   `POST /api/todos/:todoId/sync-to-machine` 插一行 `pending`
 *   → daemon 在 `POST /api/machine/recover` 里把它翻成 `running` 并执行
 *   → `POST /api/machine/action-result` 回执置 `done` / `failed`
 *   → 服务端写 audit_event + 发 SSE，浏览器才显示真实结果。
 *
 * **为什么独立成表、不是加列到 `machine`**：一台机器可能同时有多个待办动作
 * （用户连点两个不同 todo），加列只能存一条；`machine` 现在的职责是「设备
 * 档案」，队列每几秒被写一次 —— 两种生命周期混在一张表里，连「这台机器在线
 * 吗」都要跟队列争行锁。完整理由见迁移文件的「Why」。
 *
 * **为什么排在这里而不是 `machine` 那一节**：本文件的 FK 一律指向**更早**
 * 定义的表（`agentMemories.projectId` 的「FK 延后到 project 建表后添加」就是
 * 先例）。这张表要引用 machine / build / todo 三张表，所以必须排在它们之后。
 *
 * CHECK 约束（`kind in ('sync_branch')`、`status in ('pending','running',
 * 'done','failed')`）只在 SQL 里声明 —— 与 `todos.createdByType` 同一个做法：
 * 本文件从不使用 drizzle 的 `check()`，约束由迁移文件命名并持有，这里只把值
 * 集合注释出来。加新值改迁移，不改这里。
 */
export const machinePendingActions = pgTable(
  'machine_pending_action',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id').notNull().references(() => machines.id, { onDelete: 'cascade' }),
    // 冗余的 team_id：回执端点要写 `audit_event.team_id`（NOT NULL），走
    // machine→team 反查要多一次查询。写入时一次定死，之后每次读都省掉。
    teamId: text('team_id').notNull(),
    /** `'sync_branch'` —— DB CHECK 目前只有这一个值 */
    kind: text('kind').notNull(),
    // ── 指令载荷 ──
    branch: text('branch').notNull(),
    /** 这台机器上的绝对目录。daemon 直接用它，不再拼自己的 home */
    dir: text('dir').notNull(),
    buildId: text('build_id').references(() => builds.id, { onDelete: 'cascade' }),
    todoId: text('todo_id').references(() => todos.id, { onDelete: 'cascade' }),
    /** `pending → running → done | failed`（DB CHECK） */
    status: text('status').notNull().default('pending'),
    // ── 回执 ──
    // daemon 的执行结果，形状见 @tds/protocol 的 ActionResultSchema.result
    // （`{ ok, commitSha?, filesChanged?, dir?, discardedChanges?, error? }`）。
    // 这里用 Record 而不是引 protocol 的类型：schema.ts 一直不 import
    // @tds/protocol（见文件头），不为这一列开一个新的跨包依赖方向。
    result: jsonb('result').$type<Record<string, unknown>>(),
    requestedBy: text('requested_by').notNull(),
    requestedAt: bigint('requested_at', { mode: 'number' }).notNull(),
    startedAt: bigint('started_at', { mode: 'number' }),
    finishedAt: bigint('finished_at', { mode: 'number' }),
    // 认领时 +1（`recover` 的条件更新里自增）。区分「第一次跑」与「重试」，
    // 回执审计的 payload 带它 —— 排查「这条同步为什么跑了两遍」不用猜。
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    // 与迁移里的 DDL **逐字对应**，含 `where status = 'pending'` 谓词。
    // 这是本文件第一处 `.where()`：drizzle-orm 0.38 的 `IndexBuilder.where(SQL)`
    // 确实支持（pg-core/indexes.d.ts），写出来是为了让 schema 与迁移一致 ——
    // 少了谓词，`drizzle-kit push` 会认为索引定义变了，把部分索引重建成普通
    // 索引，`recover` 只查 pending 行时省下的那部分体积就没了。
    index('machine_action_pending_idx').on(t.machineId, t.status).where(sql`${t.status} = 'pending'`),
  ],
);

export const buildMessages = pgTable(
  'build_message',
  {
    id: text('id').primaryKey(),
    buildId: text('build_id').notNull().references(() => builds.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    // 实测值是 implement/todo 等服务端内部相位
    phase: text('phase'),
    triggerBy: text('trigger_by'),
    // 实测：system 消息装 JSON 信封字符串 {"kind":"machine_selected"|"turn_retried"}
    content: text('content').notNull(),
    agent: jsonb('agent').$type<Record<string, unknown> | null>(),
    isError: boolean('is_error').notNull().default(false),
    durationMs: integer('duration_ms'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('message_build_seq_idx').on(t.buildId, t.seq)],
);

export const documents = pgTable(
  'document',
  {
    id: text('id').primaryKey(),
    buildId: text('build_id').notNull().references(() => builds.id, { onDelete: 'cascade' }),
    kind: docKind('kind').notNull(),
    // 可版本化、可 Compare/Restore
    version: integer('version').notNull().default(1),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('doc_build_kind_idx').on(t.buildId, t.kind)],
);

export const checklistItems = pgTable(
  'checklist_item',
  {
    id: text('id').primaryKey(),
    todoId: text('todo_id').notNull().references(() => todos.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    done: boolean('done').notNull().default(false),
    seq: integer('seq').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('checklist_todo_idx').on(t.todoId, t.seq)],
);

export const auditEvents = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    // 文档：人类与 agent 两条独立可追溯轨道
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    todoId: text('todo_id'),
    buildId: text('build_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('audit_team_created_idx').on(t.teamId, t.createdAt)],
);

// ── 凭据 / Skill / Provider ────────────────────────────────────

export const secrets = pgTable(
  'secret',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // write-only，读接口永不返回
    encValue: text('enc_value').notNull(),
    encNonce: text('enc_nonce').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('secret_scope_name_uq').on(t.teamId, t.projectId, t.name)],
);

export const connections = pgTable(
  'connection',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    // 工具前缀 mcp__<identifier>__<tool>
    identifier: text('identifier').notNull(),
    transport: text('transport').notNull(),
    label: text('label').notNull(),
    endpoint: text('endpoint'),
    encConfig: text('enc_config'),
    encNonce: text('enc_nonce'),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [uniqueIndex('connection_team_identifier_uq').on(t.teamId, t.identifier)],
);

export const agentConnectionGrants = pgTable(
  'agent_connection_grant',
  {
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectionId] })],
);

export const providers = pgTable(
  'provider',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    providerId: text('provider_id').notNull(),
    label: text('label').notNull(),
    baseUrl: text('base_url'),
    api: text('api'),
    // 实测 {supportsDeveloperRole:false}
    compat: jsonb('compat').$type<Record<string, unknown>>().notNull().default({}),
    // 对象数组，不是字符串数组（字符串数组会 422 —— 文档实测坑）
    models: jsonb('models').$type<unknown[]>().notNull().default([]),
    encApiKey: text('enc_api_key'),
    encNonce: text('enc_nonce'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('provider_team_idx').on(t.teamId)],
);

export const skills = pgTable(
  'skill',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    storagePath: text('storage_path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    fileCount: integer('file_count'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('skill_team_idx').on(t.teamId)],
);

export const agentSkills = pgTable(
  'agent_skill',
  {
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

// ── API Key / Schedule ─────────────────────────────────────────

export const apiKeys = pgTable(
  'api_key',
  {
    id: text('id').primaryKey(),
    // 实测：key 属于人，不属于 team
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    // HMAC-SHA256，永不存明文
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('apikey_user_idx').on(t.userId)],
);

export const schedules = pgTable(
  'schedule',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    todoId: text('todo_id').notNull().references(() => todos.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    agentId: text('agent_id').references(() => agents.id),
    machineId: text('machine_id').references(() => machines.id),
    // false 时跳过 'No machine online'（文档：钉机器的规则不跳）
    automatic: boolean('automatic').notNull().default(true),
    lastFiredAt: bigint('last_fired_at', { mode: 'number' }),
    lastOutcome: text('last_outcome'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('schedule_team_idx').on(t.teamId)],
);

export const tags = pgTable(
  'tag',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('tag_project_name_uq').on(t.projectId, t.name)],
);

// ── 机器协议运行时 ─────────────────────────────────────────────

export const steps = pgTable(
  'step',
  {
    id: text('id').primaryKey(),
    buildId: text('build_id').notNull().references(() => builds.id, { onDelete: 'cascade' }),
    // claim 前为空 —— step 一进入队列还不属于任何机器
    machineId: text('machine_id').references(() => machines.id),
    status: stepStatus('status').notNull().default('queued'),
    claimedAt: bigint('claimed_at', { mode: 'number' }),
    heartbeatAt: bigint('heartbeat_at', { mode: 'number' }),
    finishedAt: bigint('finished_at', { mode: 'number' }),
    error: text('error'),
  },
  (t) => [
    index('step_status_machine_idx').on(t.status, t.machineId),
    index('step_build_idx').on(t.buildId),
  ],
);

/**
 * claim 时下发的单次凭据。
 * 文档铁律：明文只在 claim 响应里带一次，绝不落 agent 机器磁盘。
 */
export const stepCredentials = pgTable('step_credential', {
  stepId: text('step_id').primaryKey().references(() => steps.id, { onDelete: 'cascade' }),
  encPayload: text('enc_payload').notNull(),
  encNonce: text('enc_nonce').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  consumedAt: bigint('consumed_at', { mode: 'number' }),
});

/** SSE 事件流游标（实测帧带 seq） */
export const sseEvents = pgTable(
  'sse_event',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    teamId: text('team_id').notNull(),
    // 'team' 或 conversationId
    scope: text('scope').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('sse_scope_seq_idx').on(t.scope, t.seq)],
);

/**
 * Mentions 结构化引用 —— 2026-10-18 新增。
 *
 * 原站语义：`composer` 里 `Mention` 按钮 + prefix (`@ agent or member,
 * # todo, / skill, ~ project, & machine`) 写入的是「structured reference chip
 * rather than plain text」，让 agent **resolves the exact ID instead of guessing**
 * （见 `D:/AI/todos/recon-live/docs-conversation.md:34`）。
 *
 * **为什么是关联表、不是 `build_message.mentions jsonb` 列**：
 *   - 一条消息可引用多个对象，1:N 在关联表里是天然的，在 jsonb 里要做反范式
 *   - 「这个 todo 被哪些消息引用过」是反向查询（`build_id+kind+ref_id` 索引），关联表一行查询搞定
 *   - 不改既有 `build_message` 表 —— 既不影响 INSERT 形态，也不会破坏现有
 *     911 条 server 测试的 fixture 写法（加 NOT NULL 列会让所有 INSERT 失败）
 *
 * 字段：
 *   - `kind`     取原站 6 个语义：`agent | member | todo | skill | project | machine`
 *   - `prefix`   `char(1)`，`@ | # | / | ~ | &`，与原站 prefix 表一一对应
 *   - `ref_id`   被引用对象的主键（agent.id / member.id / todo.id ...）
 *   - `label`    写时展示名快照 —— 与原对象解耦，避免改名/删除后 chip 显示错乱
 *   - `unique(message_id, kind, ref_id)`：同一消息对同一目标只能有一行，幂等保证
 *
 * CASCADE：message / build 删了引用一起走（与 `chief_message` 同款选择）。
 */
export const buildMessageMentions = pgTable(
  'build_message_mention',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().references(() => buildMessages.id, { onDelete: 'cascade' }),
    buildId: text('build_id').notNull().references(() => builds.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    prefix: text('prefix').notNull(),
    refId: text('ref_id').notNull(),
    label: text('label').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('build_message_mention_uq').on(t.messageId, t.kind, t.refId),
    index('build_message_mention_message_idx').on(t.messageId),
    index('build_message_mention_target_idx').on(t.buildId, t.kind, t.refId),
  ],
);

export const schema = {
  users, teams, members, agents, chiefs, chiefThreads, chiefMessages, agentMemories,
  machines, machineRuntimeUsage, machinePendingActions, projects, repoCredentials,
  todos, builds, buildMessages, buildMessageMentions, documents, checklistItems, auditEvents,
  secrets, connections, agentConnectionGrants, providers, skills, agentSkills,
  apiKeys, schedules, tags, steps, stepCredentials, sseEvents,
};
