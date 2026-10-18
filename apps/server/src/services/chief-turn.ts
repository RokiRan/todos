/**
 * Chief 对话轮 = `runChiefTurn` 之上的**持久化层**。
 *
 * 设计目的：让「Chief 一轮」从「模型 + 工具内存调用」升级为「真实的可回放
 * 对话」—— 用户每次发言都落 `chief_message`；下一轮从库里读历史喂回模型。
 *
 * 关键事实（2026-07-17 改过存储）：
 *   - **落 `chief_message`，不再落 `build_message`。** 原实现按
 *     「`build_message.buildId = thread.session.id`」来存 Chief 对话，
 *     但那个假设**在数据库层不成立** —— `build_message.build_id` 是指向
 *     `build` 的真外键，Chief thread 的 `session.id` 背后没有 build 行，
 *     写入直接被拒（实测 `build_message_build_id_build_id_fk`）。补一条真 build
 *     行也不通（`builds.todo_id` NOT NULL，而 Chief 不拥有 todo）。
 *     新表让「伪 buildId」这个绕路整个消失：归属就是 `thread_id`。
 *   - 新表把 `content` / `tool_call_id` / `tool_calls` **分列存**，所以
 *     「把 tool_calls 塞进 content 的 JSON 包」那套 workaround 一并拆掉了。
 *   - 读侧仍保留「孤儿 tool 行跳过」：库可能被裁剪或手工改过，不能因为一行孤儿
 *     就让整轮对话读不出来。
 *
 * 不做的事（主代理拥有）：
 *   - 不写路由（`POST /api/chief/threads/:threadId/messages`）。
 *   - 不改 `runChiefTurn` 的循环（`chief-loop.ts:runChiefTurn`）。
 *   - 不改 `buildChiefPrompt` 的形状（`chief/prompt.ts`）。
 *   - 不接模型 provider —— `ChiefTurnDeps.callModel` 由调用方（路由 / 测试）
 *     注入；本文件**不**直连真模型。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import {
  chiefMessages,
  chiefThreads,
  chiefs,
  members,
  projects,
  todos,
} from '@tds/db';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import {
  buildChiefPrompt,
  type BoardDigest,
  type ChiefFixedSegment,
  type TopicTurn,
} from '../chief/prompt.js';
import { toolSummaryText } from '../chief/tools.js';
// 消息 / 工具 / 调用结果的类型**归属 `chief-model.ts`**（它才是真正发 HTTP 的那层）。
// 从这里 import 而不是从 `chief-loop` 转手 —— loop 只是消费者，让它当类型中转会多
// 一跳、也多一点漂移面。
import type {
  ModelMessage,
  ModelToolSpec,
  ModelCallResult,
} from './chief-model.js';
import type { ChiefToolOutcome } from '../chief/executor.js';
import { runChiefTurn } from './chief-loop.js';

/**
 * runChiefTurnWithPersistence 的依赖注入。
 *
 * `db` 是持久化必需；`callModel` / `executeTool` 与 runChiefTurn 同形。
 */
export interface ChiefTurnDeps {
  db: Db;
  // **直接用 `chief-model.ts` 的类型，不要在这里重声明一遍。**
  // 之前这里内联复制了 `toolCalls` / `text` / `usage` / `finishReason` 四个字段，
  // 结果 `chief-model` 把 `toolCall` 改成数组 `toolCalls` 时，这个副本没跟上 ——
  // 类型检查通不过还算好的，真正危险的是它**长得一样但语义不同**（`finishReason`
  // 写成宽泛的 `string`，于是 `FinishReason` 的四个取值约束在这条路径上失效）。
  // 重复声明类型 = 重复承担漂移风险，没有收益。
  callModel: (messages: ModelMessage[], tools?: ModelToolSpec[]) => Promise<ModelCallResult>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ChiefToolOutcome>;
}

export interface ChiefTurnInput {
  threadId: string;
  teamId: string;
  /** 发起这一轮的 actorId —— 落库时写到 chief_message.trigger_by，用于审计归责。 */
  actorId: string;
  userMessage: string;
  /** 单轮最多几轮工具往返；缺省走 runChiefTurn 的默认 8。 */
  maxIterations?: number;
  /** 给模型用的上下文窗口大小（缺省 200_000，qwen3-flash-next 的常见值）。 */
  contextWindow?: number;
}

export interface ChiefTurnOutput {
  /** Chief 的最终回复文本。`stoppedBy !== 'text'` 时可能为空。 */
  text: string;
  /** 本轮实际执行的工具（与落库的 chief_message 行对应）。 */
  toolCalls: Array<{ name: string; ok: boolean; reason?: string }>;
  /** 工具执行后写入的 chief_message 最大序号，UI 可用来增量拉 sinceSeq。 */
  lastSeq: number;
  /** 收口原因。 */
  stoppedBy: 'text' | 'tool_call' | 'max_iterations' | 'truncated';
}

/**
 * 把 prompt 的 system 段、历史、当前轮拼成 ModelMessage[]。纯函数：同一入参
 * 两次调用结果一致（顺序稳定、不带时间戳），便于测试断言与 prefix cache 命中。
 *
 * 顺序：system 第一条 → history（按调用方给定顺序）→ user 最后一条。
 *
 * 重复调用幂等：`runChiefTurn` 自己也会在 system 里再塞一次 —— 这里**不**
 * 重复加 system：如果 history 第一条已经是 system 就用它，否则才插一条。
 *
 * `history` 的 role 形态与 ModelMessage 对齐（user/assistant/tool/system）。
 * assistant 消息可带 `tool_calls`；tool 消息带 `toolCallId`。本函数**不重建**
 * tool_calls —— 调用方负责给完整形状，传进来什么样就什么样；本文件保留这一
 * 兼容以让测试可以构造「既成历史」喂回模型。
 */
export function buildTurnMessages(input: {
  systemPrompt: string;
  history: ModelMessage[];
  userMessage: string;
}): ModelMessage[] {
  const out: ModelMessage[] = [];
  if (input.history[0]?.role !== 'system') {
    out.push({ role: 'system', content: input.systemPrompt });
  }
  for (const m of input.history) out.push(m);
  if (input.userMessage.length > 0) {
    out.push({ role: 'user', content: input.userMessage });
  }
  return out;
}

/**
 * 读 thread + 它的 chief + team + 校验 caller 属于该团队。
 *
 * 不属于 → 抛 403（措辞与 `requireTeamMembership` / `routes/chief.ts:531` 一致）。
 * thread 不存在 → 抛 404。
 * `session.id` 必须存在（建 thread 时由路由写过，缺这字段是 schema 漂移：拒）。
 */
async function loadThreadForTurn(
  db: Db,
  threadId: string,
  actorId: string,
): Promise<{
  threadId: string;
  teamId: string;
  charter: string | null;
}> {
  const row = (await db
    .select()
    .from(chiefThreads)
    .where(eq(chiefThreads.id, threadId))
    .limit(1))[0];
  if (!row) throw new HttpError(404, 'thread not found');

  const chief = (await db
    .select({ teamId: chiefs.teamId, charter: chiefs.charter })
    .from(chiefs)
    .where(eq(chiefs.id, row.chiefId))
    .limit(1))[0];
  if (!chief) throw new HttpError(403, 'thread has no accessible team');

  const teamId = chief.teamId;
  const memberRow = (await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.teamId, teamId),
        eq(members.actorId, actorId),
        eq(members.memberType, 'user'),
      ),
    )
    .limit(1))[0];
  if (!memberRow) {
    throw new HttpError(403, `team "${teamId}" is not accessible to this key's owner`);
  }

  // **不再需要伪 buildId。** 原实现取 `thread.session.id` 当 buildId 写进
  // `build_message` —— 那个假设在数据库层不成立（build_message.build_id 有真外键，
  // 背后没有 build 行，写入被拒）。换 `chief_message` 后归属直接是 `thread_id`，
  // 这个绕路整个消失了。
  return { threadId: row.id, teamId, charter: chief.charter };
}

/**
 * 从 `chief_message` 按 `thread_id` 且 `seq` 升序读历史，
 * 转成 ModelMessage[] 给 runChiefTurn 当 history 喂回去。
 *
 * 处理：
 *   - role 严格只接受 'user' / 'assistant' / 'system' / 'tool'；落库时如果
 *     跑进了别的字符串（设计不会发生），跳过。
 *   - **assistant 行**：`tool_calls` 是独立列，直接取（不再从 content 的 JSON 里扒）。
 *   - **tool 消息**：`tool_call_id` 是独立列；缺则回落到上一条 assistant 的
 *     最后一个 tool_call id；再缺就是孤儿，跳过。
 *   - **孤儿 tool 消息**（找不到对应 assistant 的 tool_calls）：跳过而不是
 *     当成 user 消息硬塞 —— 库里历史可能被裁剪/迁移，不能因为一行孤儿就拒绝整轮。
 */
async function loadHistory(db: Db, threadId: string): Promise<ModelMessage[]> {
  const rows = await db
    .select({
      seq: chiefMessages.seq,
      role: chiefMessages.role,
      content: chiefMessages.content,
      toolCallId: chiefMessages.toolCallId,
      toolCalls: chiefMessages.toolCalls,
    })
    .from(chiefMessages)
    .where(eq(chiefMessages.threadId, threadId))
    .orderBy(asc(chiefMessages.seq));

  const out: ModelMessage[] = [];
  let lastAssistantToolIds: string[] = [];
  for (const row of rows) {
    if (row.role === 'user') {
      out.push({ role: 'user', content: row.content });
      lastAssistantToolIds = [];
    } else if (row.role === 'system') {
      out.push({ role: 'system', content: row.content });
      lastAssistantToolIds = [];
    } else if (row.role === 'assistant') {
      // `tool_calls` 是**独立列**（chief_message.tool_calls），不再是塞在 content 里
      // 的 JSON —— 换表时顺手把那个 workaround 也拆了。
      const toolCalls = Array.isArray(row.toolCalls) ? row.toolCalls : undefined;
      lastAssistantToolIds = toolCalls ? toolCalls.map((c) => c.id) : [];
      if (toolCalls && toolCalls.length > 0) {
        // content 与 tool_calls 分列存，assistant 的文本照常保留
        out.push({ role: 'assistant', content: row.content, toolCalls });
      } else {
        out.push({ role: 'assistant', content: row.content });
      }
    } else if (row.role === 'tool') {
      // `tool_call_id` 是独立列。仍保留「回落��上一条 assistant 的最后一个 id」
      // —— 库可能被手工改过，而一个孤儿 tool 行不该让整轮对话读不出来。
      const toolCallId = row.toolCallId ?? lastAssistantToolIds.at(-1);
      if (!toolCallId) continue;
      out.push({ role: 'tool', toolCallId, content: row.content });
    }
    // 未知 role —— 跳过
  }
  return out;
}

/**
 * 在闸门（product semantics）+ Review 阶段需要 Chief 决策的 todo 相位集合。
 * 用静态 Record + 集合判定替代 Set，**只在静态字面量上**展开，避免动态增删。
 *
 * Phase meanings（来自 packages/protocol schema）：
 *   confirm / reviewing —— 走完闸门等用户
 *   planning / review    —— 等人类审批或运行 review
 */
const GATE_PHASES: Record<string, true> = {
  confirm: true,
  reviewing: true,
  planning: true,
  review: true,
};

/**
 * 拼 `BoardDigest` 给 prompt 用。从真库聚合：
 *   - `byPhase`: 按 todo.phase 分组计数（只数该 team 下的 project 的非 done todo）。
 *   - `needsYou`: phase 在 GATE_PHASES 的 todo，取 seqNum + title 上限 20 条。
 *   - `changes`: 空数组 —— 本服务每次聚合时是「当前」看板，没法拿「自上次 digest
 *     之后」的变化（没有上次 digest 时间戳），留空给 UI / 后续 watch 模块填。
 *
 * 看板聚合是**同 team 全员共享**的，不是某 thread 私有的 —— Chief 是并行
 * 看所有项目的调度者。
 */
async function buildBoardDigest(db: Db, teamId: string): Promise<BoardDigest> {
  const projectsRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, teamId));
  const projectIds = projectsRows.map((r) => r.id);
  if (projectIds.length === 0) {
    return { byPhase: {}, needsYou: [], changes: [] };
  }

  const allTodos = await db
    .select({
      phase: todos.phase,
      seqNum: todos.seqNum,
      id: todos.id,
      title: todos.title,
    })
    .from(todos)
    .where(
      sql`${inArray(todos.projectId, projectIds)} and ${todos.phase} <> 'done'`,
    );

  const byPhase: Record<string, number> = {};
  const needsYou: Array<{ id: string; seqNum: number; title: string; phase: string }> = [];
  for (const t of allTodos) {
    byPhase[t.phase] = (byPhase[t.phase] ?? 0) + 1;
    if (GATE_PHASES[t.phase]) {
      needsYou.push({ id: t.id, seqNum: t.seqNum, title: t.title, phase: t.phase });
    }
  }
  needsYou.sort((a, b) => a.seqNum - b.seqNum);
  return {
    byPhase,
    needsYou: needsYou.slice(0, 20),
    changes: [],
  };
}

/** 把 history（ModelMessage[]）压成 prompt 模块要的 TopicTurn[]。 */
function toTopicTurns(history: ModelMessage[]): TopicTurn[] {
  const ts = now();
  return history.map((m, i) => ({
    role: m.role,
    content:
      m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
        ? JSON.stringify({ tool_calls: m.toolCalls })
        : m.content,
    at: ts + i,
  }));
}

/**
 * 把本轮新增的 user / assistant / tool 结果**全部**写到 build_message，
 * `thread_id`、`seq` 从该 thread 现有最大 +1 起递增。
 *
 * **必须**先读 max(seq) 再写 —— 不能假设从 0 起，因为别的轮次可能写过
 * （同 thread 由其他 actor 并发 / 跨进程重试 / 轮次被压缩迁移）。
 *
 * 内容形状约定：
 *   - assistant 行如果带 tool_calls，content 用 JSON 包
 *     `{text, tool_calls}` —— 与 loadHistory 解析对齐。
 *   - tool 行 content 用 JSON 包 `{tool_call_id, ok, tool, reason?, result?}`，
 *     与 `chief-loop.ts:serializeToolOutcome` 同形（多塞一个 `tool_call_id`
 *     顶层键，专门给读侧用）。
 *   - user 行 content 是原 userMessage 字符串（不包装）。
 */
async function writeTurnMessages(
  db: Db,
  threadId: string,
  newMessages: Array<
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls?: ModelMessage['toolCalls'] }
    | { role: 'tool'; toolCallId: string; content: string }
  >,
): Promise<number> {
  if (newMessages.length === 0) {
    const max = await db
      .select({ maxSeq: sql<number | null>`max(${chiefMessages.seq})::bigint::int` })
      .from(chiefMessages)
      .where(eq(chiefMessages.threadId, threadId));
    return max[0]?.maxSeq ?? 0;
  }
  const existingMax = await db
    .select({ maxSeq: sql<number | null>`max(${chiefMessages.seq})::bigint::int` })
    .from(chiefMessages)
    .where(eq(chiefMessages.threadId, threadId));
  let next = (existingMax[0]?.maxSeq ?? 0) + 1;

  const ts = now();
  for (const m of newMessages) {
    // content / tool_call_id / tool_calls **分列存**（2026-07-17 换 `chief_message` 时
    // 拆掉了原来「把 tool_calls 塞进 content 的 JSON 包」那套 workaround —— 新表有
    // 真列，不必再绕）。
    const id = newId();
    const triggerBy = m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : 'assistant';
    await db.insert(chiefMessages).values({
      id,
      threadId,
      role: m.role,
      content: m.content,
      ...(m.role === 'tool' ? { toolCallId: m.toolCallId } : {}),
      ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
        ? { toolCalls: m.toolCalls }
        : {}),
      seq: next,
      createdAt: ts,
      isError: false,
      triggerBy,
    });
    next += 1;
  }
  return next - 1;
}

/**
 * 主入口：跑一轮 Chief 对话，把 userMessage / assistant 回复 / tool 结果都
 * 落 `chief_message`，更新 `chief_thread.lastTurnAt` / `v`，返回 lastSeq。
 *
 * 三层结构：
 *   1. 加载 thread + 团队校验
 *   2. 读历史 → 拼 system + board → 调用 runChiefTurn
 *   3. 把这一轮的所有新消息（含工具结果）落库，更新 thread 乐观锁
 *
 * 落库顺序：user → assistant（无 tool 走纯文本 / 有 tool 走带 tool_calls JSON 包）→
 * 一组 tool 回灌。
 */
export async function runChiefTurnWithPersistence(
  deps: ChiefTurnDeps,
  input: ChiefTurnInput,
): Promise<ChiefTurnOutput> {
  const { db, callModel, executeTool } = deps;

  // 1) 加载 thread
  const { threadId, teamId, charter } = await loadThreadForTurn(db, input.threadId, input.actorId);

  // 2) 读历史
  const history = await loadHistory(db, threadId);

  // 3) board digest
  const board = await buildBoardDigest(db, teamId);

  // 4) 拼 system —— 调 buildChiefPrompt
  const fixed: ChiefFixedSegment = {
    roleInstructions: '你是 Chief。你不能自己写代码，只能派工给 agent。',
    toolSummary: toolSummaryText(),
    charter: charter ?? '',
    memory: '', // 记忆由后续 memory-watch 模块接入（prompt 模块对空记忆显示「(暂无)」）
  };
  const built = buildChiefPrompt({
    fixed,
    topicId: input.threadId,
    history: toTopicTurns(history),
    board,
    userMessage: input.userMessage,
    contextWindow: input.contextWindow ?? 200_000,
  });

  // 5) 跑循环
  const result = await runChiefTurn(
    { callModel, executeTool },
    {
      systemPrompt: built.text,
      history,
      userMessage: input.userMessage,
      tools: [],
      ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    },
  );

  // 6) 把本轮新增的全部写到 build_message
  const newMessages: Array<
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls?: ModelMessage['toolCalls'] }
    | { role: 'tool'; toolCallId: string; content: string }
  > = [];

  newMessages.push({ role: 'user', content: input.userMessage });

  const toolCalls = result.toolCalls;
  if (toolCalls.length === 0) {
    // 纯文本收口：单次 model call 就回了 text
    newMessages.push({ role: 'assistant', content: result.text });
  } else {
    // runChiefTurn 的循环语义：每轮只有「要调工具」或「拍板文本」二选一。
    //   - 调工具：那一轮 assistant(tool_calls=[c]) + tool 回灌；结果入 toolCalls
    //     数组；循环继续
    //   - 拍板：那一轮 assistant(text)；停止
    //
    // 所以 K 条 toolCalls + 收口 = iterations 轮。具体形状：
    //   - stoppedBy='text' 时：K 个 assistant(tool_calls) + K 个 tool + 1 个 assistant(text)
    //   - stoppedBy='max_iterations' 时：N 个 assistant(tool_calls) + N 个 tool + 1 个 assistant('') [text 为空]
    // K 与 iterations 的关系：
    //   - 'text'：K = iterations - 1（最后一轮拍板，无工具）
    //   - 'max_iterations'：K = iterations（每一轮都调工具）
    // 但 result.type 没暴露这个差别 —— 只能从 stoppedBy 推断。
    const iterations = result.iterations;
    const K = result.stoppedBy === 'max_iterations'
      ? iterations
      : iterations - 1;
    for (let i = 0; i < K; i++) {
      const c = toolCalls[i];
      if (!c) break;
      const toolCallId = `t-${i}`;
      newMessages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: toolCallId, name: c.name, args: {} }],
      });
      const payload: { ok: boolean; tool: string; reason?: string } = {
        ok: c.ok,
        tool: c.name,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
      };
      newMessages.push({
        role: 'tool',
        toolCallId,
        content: JSON.stringify(payload),
      });
    }
    // 收口的 assistant 文本行：'text' 时非空，'max_iterations' 时空串；都照写。
    newMessages.push({ role: 'assistant', content: result.text });
  }

  const lastSeq = await writeTurnMessages(db, threadId, newMessages);

  // 7) 更新 thread 的 lastTurnAt + v（乐观锁字段）
  await db
    .update(chiefThreads)
    .set({ lastTurnAt: now(), v: sql`${chiefThreads.v} + 1` })
    .where(eq(chiefThreads.id, input.threadId));

  return {
    text: result.text,
    toolCalls: result.toolCalls,
    lastSeq,
    stoppedBy: result.stoppedBy,
  };
}
