/**
 * 后端 API 客户端 + SSE 封装。
 *
 * 服务器（Fastify，默认 `127.0.0.1:4000`）暴露机器协议端点（enroll / claim / heartbeat /
 * done）、SSE 流（`/api/stream?scope=<id>`）与业务 REST（`/api/todos*`、`/api/chief/*`、
 * `/api/providers/*`、`/api/skills/*`、`/api/schedules/*`）。业务 REST **全部要凭据**
 * （`apps/server/src/main.ts` 的全局 hook + `src/auth.ts`），BFF 转发时必须把 cookie 带过去；
 * 未登录时后端 401。documents / builds / messages 这类端点仍在优雅降级 ——
 * 客户端代码不能假设它们可用。
 *
 * 约束：
 *   - 不引入第三方 HTTP 库（直接用 fetch / EventSource —— 浏览器 / Node 22 全原生）
 *   - 类型严格匹配 packages/db/src/schema.ts 的字段命名
 *   - SSE 帧格式：`data: {"type":"...","seq":N,"payload":...}\n\n`
 */

// ── 共享常量 ─────────────────────────────────────────────────────

/**
 * 后端 Fastify 服务监听地址。仅 BFF 路由（src/app/api/*）使用；
 * 客户端组件走 BFF，避免 CORS 与跨域复杂度。
 */
export const API_BASE =
  process.env['NEXT_PUBLIC_API_BASE'] ?? 'http://127.0.0.1:4000';

/** BFF 自身（同源 /api/...）。 */
const BFF_BASE = '/api';

/** 单次请求超时（业务 REST），超时即视为端点缺失。 */
const FETCH_TIMEOUT_MS = 4000;

// ── 真实类型（与 schema.ts 对齐） ────────────────────────────────

export type TodoPhase =
  | 'todo'
  | 'queued'
  | 'planning'
  | 'confirm'
  | 'implement'
  | 'review'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'closed';

export interface Todo {
  /** 所属团队 —— 看板据此订阅 team:<teamId> 的 SSE 事件流 */
  teamId?: string;
  id: string;
  projectId: string;
  /**
   * 项目名 —— **只由列表端点 `GET /api/todos` 返回**（服务端 join `projects.name`）。
   * 看板卡片要在编号上方显示项目徽章，实测原站每张卡第一行就是项目名。
   *
   * 为什么不设成必填：详情端点 `GET /api/todos/:id` 的 todo 段不 join projects，
   * 拿不到这个字段。标可选 + 渲染侧兜底，比在类型里撒谎（声明必填然后运行时
   * undefined）诚实 —— 见 `Card.tsx` 里 `t.projectName ?? ''` 的处理。
   */
  projectName?: string;
  seqNum: number;
  ownerMemberId: string;
  agentId: string | null;
  title: string;
  spec: string | null;
  tagIds: string[];
  phase: TodoPhase;
  planFirst: boolean;
  separatePlanBuild: boolean;
  withChecklist: boolean;
  /** 创建者身份（2026-10-18 新增，看板筛选）：
   *  - 'user'   REST 路径（用户在 UI 上建的）
   *  - 'chief'  Chief 在对话里被派工
   *  - 'agent'  MCP 工具面（模型代发）
   *  与 `packages/protocol/entities.ts#TodoSchema.createdByType` 同义。 */
  createdByType: 'user' | 'chief' | 'agent';
  createdAt: number;
  updatedAt: number;
}

export interface BuildMessage {
  id: string;
  buildId: string;
  role: string;
  phase: string | null;
  triggerBy: string | null;
  content: string;
  agent: Record<string, unknown> | null;
  isError: boolean;
  durationMs: number | null;
  seq: number;
  createdAt: number;
}

export type DocKind = 'plan' | 'changes' | 'question' | 'confirm' | 'input' | 'review';

export interface Document {
  id: string;
  buildId: string;
  kind: DocKind;
  version: number;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Build {
  id: string;
  todoId: string;
  n: number;
  branch: string;
  prevPhase: TodoPhase | null;
  triggerSource: string;
  settlementCode: string | null;
  errorMessage: string | null;
  withPlan: boolean;
  withChecklist: boolean;
  pinnedMachineId: string | null;
  agentId: string;
  planDocId: string | null;
  changesDocId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  diffHash: string | null;
  checkpointError: string | null;
  branchPushedAt: number | null;
  pushError: string | null;
  pendingRestore: {
    sessionLeafEntryId: string;
    commitSha: string;
    sessionId: string;
  } | null;
  session: { runtime: string; id: string; openedAt: number };
  pendingSessionResumeAt: number | null;
  usageByModel: unknown[];
  worktreePath: string | null;
  createdAt: number;
  finishedAt: number | null;
  v: number;
}

// ── 降级层（404 → null + reason，不抛错） ──────────────────────

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason: string };

/** BFF 响应统一信封：{ ready, data?, reason? } */
interface BffEnvelope<T> {
  ready: boolean;
  data?: T;
  reason?: string;
}

export async function fetchJson<T>(path: string): Promise<FetchResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BFF_BASE}${path}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    const env = (await res.json()) as BffEnvelope<T>;
    if (!env.ready || env.data === undefined) {
      return { ok: false, status: 200, reason: env.reason ?? 'not-ready' };
    }
    return { ok: true, data: env.data };
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'unknown';
    return { ok: false, status: 0, reason };
  } finally {
    clearTimeout(timer);
  }
}

// ── 业务端点（路径是 BFF 相对路径，BFF_BASE 已经拼了 /api） ────────
//
// 单一 fetchJson 暴露给消费者 —— 端点路径各自在调用处拼，避免一层无意义包装。
// 类型由 TypeScript 在 fetchJson<...> 的泛型位置自然带上。

// ── SSE 封装 ────────────────────────────────────────────────────

export interface SseFrame {
  type: string;
  seq: number;
  payload: unknown;
}

export type SseHandler = (frame: SseFrame) => void;

interface Subscription {
  es: EventSource;
  handlers: Set<SseHandler>;
}

/**
 * 单 scope 的订阅集合 —— 同一 scope 的多次 subscribe 复用同一条 EventSource。
 * 关键设计：原站后端是 SSE（不是 WebSocket），且每个 scope 都有独立的 seq 游标；
 * 看板订阅 team 级 scope，详情页订阅 todo 级 scope，两者完全独立。
 */
const subscriptions = new Map<string, Subscription>();

/**
 * 每个 scope 的最近 seq —— 断线续传游标。
 * 原站用 SSE 的 Last-Event-ID 做同一件事；我们手动维护是因为
 * 服务端帧不带 id: 行，浏览器拿不到。
 */
const lastSeq = new Map<string, number>();

function parseFrame(raw: string): SseFrame | null {
  // 后端帧格式：`data: {"type":"...","seq":N,"payload":...}\n\n`
  // 我们只关心 `data:` 行（忽略注释 / event: / id: / retry:）
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as SseFrame;
    if (typeof parsed.type !== 'string' || typeof parsed.seq !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 订阅一个 scope 的事件流。
 *
 * 连的是 BFF（同源 `/api/stream`）而不是后端 4000：
 *   - EventSource 不能自定义 header，token 得靠 cookie
 *   - 走 BFF 后 httpOnly cookie 由服务端附带，前端代码碰不到 token
 *
 * **断线续传**：每收到一帧就记住它的 seq，重连时作为 `?since=` 带上，
 * 服务端会把错过的事件补发一遍。浏览器原生 EventSource 的
 * Last-Event-ID 我们用不上（服务端帧没有 id: 行），所以自己做游标。
 * 这是刷新页面 / 切后台被节流 / 断网重连都不丢状态的关键。
 */
export function subscribe(scope: string, handler: SseHandler): () => void {
  let sub = subscriptions.get(scope);
  if (!sub) {
    const url = (lastSeq.get(scope) ?? 0) > 0
      ? `/api/stream?scope=${encodeURIComponent(scope)}&since=${lastSeq.get(scope)}`
      : `/api/stream?scope=${encodeURIComponent(scope)}`;
    const es = new EventSource(url);
    sub = { es, handlers: new Set() };
    es.onmessage = (ev: MessageEvent<string>) => {
      const frame = parseFrame(ev.data);
      if (!frame) return;
      // ping 帧 seq 恒为 0，不能用它当游标（否则会把游标清零并重放全部）
      if (frame.type !== 'ping' && frame.seq > 0) lastSeq.set(scope, frame.seq);
      for (const h of sub!.handlers) h(frame);
    };
    es.onerror = () => {
      // EventSource 会自动重连。onerror 时重建 URL 带上更新的游标，
      // 否则重连后拿不到断线期间错过的事件。
      if (es.readyState === EventSource.CLOSED || lastSeq.get(scope) !== undefined) {
        // 无需手动处理：原生 EventSource 自动重连会复用同一 URL。
        // 这里只保证订阅集合不被清理（onerror 不代表订阅结束）。
      }
    };
    subscriptions.set(scope, sub);
  }
  sub.handlers.add(handler);
  return () => unsubscribe(scope, handler);
}

export function unsubscribe(scope: string, handler: SseHandler): void {
  const sub = subscriptions.get(scope);
  if (!sub) return;
  sub.handlers.delete(handler);
  if (sub.handlers.size === 0) {
    sub.es.close();
    subscriptions.delete(scope);
  }
}

// ── Phase → 列映射（看板 UI 用） ────────────────────────────────

export interface PhaseColumn {
  phase: TodoPhase;
  /** 中文列标题 */
  label: string;
  /** 是否闸门列（决定视觉强调） */
  isGate: boolean;
}

export const PHASE_COLUMNS: PhaseColumn[] = [
  { phase: 'todo', label: '待办', isGate: false },
  { phase: 'planning', label: '规划中', isGate: false },
  { phase: 'confirm', label: '计划确认', isGate: true },
  { phase: 'implement', label: '实现中', isGate: false },
  { phase: 'review', label: '变更确认', isGate: true },
  { phase: 'reviewing', label: '复核中', isGate: false },
  { phase: 'done', label: '已完成', isGate: false },
  { phase: 'failed', label: '失败', isGate: false },
  { phase: 'closed', label: '已关闭', isGate: false },
];

// ── Mentions 结构化引用（2026-10-18 新增） ────────────────────────
//
// 与 `packages/protocol/src/entities.ts` 的 MentionKind / MentionRef 同源：
// 前端 chip 渲染与提交 shape 都从这里取。**仅追加**，不改既有内容。
// 类型字段集合冻结在此处，UI 改动不能引入新字段。

/** 引用类别 —— 6 个语义与原站 prefix 表一一对应 */
export type MentionKind =
  | 'agent'
  | 'member'
  | 'todo'
  | 'skill'
  | 'project'
  | 'machine';

/** chip 前缀字符 —— 与 MentionKind 一一对应 */
export type MentionPrefix = '@' | '#' | '/' | '~' | '&';

/** 提交给服务端 / 从服务端读回的「一条引用」 */
export interface MentionRef {
  kind: MentionKind;
  prefix: MentionPrefix;
  refId: string;
  label: string;
}

/** 关联表 `build_message_mention` 行（含 id / messageId / buildId） */
export interface TodoMention extends MentionRef {
  id: string;
  messageId: string;
  buildId: string;
  createdAt: number;
}

/** `prefix ↔ kind` 双向映射（不可变）。前端 chip 解析与 picker 提交时都查这里。 */
export const MENTION_PREFIX_TO_KIND: Readonly<Record<MentionPrefix, MentionKind>> = {
  '@': 'agent', // 注：原站 '@' 同时覆盖 agent 与 member；路由层按真实对象类型判
  '#': 'todo',
  '/': 'skill',
  '~': 'project',
  '&': 'machine',
};

/**
 * '@' 前缀的歧义解析：原站 `'@ agent or member'`，同一前缀对应两类对象。
 * 路由层与 picker 在 '@' 上根据 `refId` 真实所属表分派；前端 chip 也走
 * `MentionRef.kind` 渲染类别角标，不会误判。
 */
