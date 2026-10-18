'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { use } from 'react';
import type { CSSProperties } from 'react';
import {
  type Build,
  type BuildMessage,
  type Document,
  type FetchResult,
  type Todo,
  type TodoPhase,
  type SseFrame,
  fetchJson,
  subscribe,
} from '@/lib/api';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import { useTeamContext } from '@/lib/team-context';
import ConfirmDialog from '@/components/ConfirmDialog';
import DocPreview from '@/components/DocPreview';
import MentionComposer, { type MentionComposerHandle } from '@/components/MentionComposer';
import type { MentionRef } from '@/components/MentionComposer';
import BranchMenu, { type BranchMachine } from '@/components/board/BranchMenu';

/** 终态 phase 集合 —— Rerun / Reopen 按钮只在这些 phase 显示。
 *  与 `lib/api.ts` 的 `TodoPhase` 定义同源，避免散落字面量比较。
 *  用 `Partial<Record<...>>` 是为了让 ts 在加新 phase 时给出「少了一项」的提示。 */
const TERMINAL_PHASE: Partial<Record<TodoPhase, true>> = {
  done: true,
  failed: true,
  closed: true,
};

/**
 * Todo 详情页。
 *
 * 后端还没实现业务端点时的渲染契约：
 *   - /api/todos/[id] 404 → 「数据未就绪」占位，不抛错
 *   - builds / messages / documents 任一缺失 → 该区域单独降级，其他区域照常
 *
 * Diff 用 <pre> 原样渲染（不引第三方 diff 库）—— 后端落地 Changes 文档时
 * payload 里通常含 { diff: string } / { files: Array<{ path, diff }> } 两种形态，
 * 这里都做归一化处理。
 */

interface PageProps {
  params: Promise<{ id: string }>;
}

/** 验收清单项 —— 与 `apps/server/src/routes/checklist.ts` 的 `ChecklistItemRow` 对齐。 */
interface ChecklistItem {
  id: string;
  todoId: string;
  text: string;
  done: boolean;
  seq: number;
  createdAt: number;
}

/**
 * Steering 队列项（服务端 `/api/builds/:buildId/messages` 响应里
 * `queued:` 字段的形状）。本切片只读 + 编辑 + 撤回，没有自带投递逻辑
 * （那是机器侧责任，进程内 Map 仅活到下一个 turn）。
 */
interface QueueItem {
  id: string;
  buildId: string;
  content: string;
  position: number;
  createdAt: number;
  status: 'pending' | 'delivered';
  mentions: Array<{ kind: string; id: string; label: string }>;
}

/** 当前 build 的 stable id —— 没有 build 就不让 composer 渲染。 */
function pickLatestBuildId(builds: Build[] | null): string | null {
  if (!builds || builds.length === 0) return null;
  return builds[0]!.id;
}

/** 闸门识别 —— 与 `lib/api.ts` 的 PHASE_COLUMNS 保持一致来源（不重复字面量）。 */
function isGatePhase(phase: TodoPhase | undefined | null): boolean {
  if (!phase) return false;
  return phase === 'confirm' || phase === 'review';
}

export default function TodoDetailPage({ params }: PageProps) {
  const { id } = use(params);

  const [todo, setTodo] = useState<Todo | null>(null);
  const [todoErr, setTodoErr] = useState<string | null>(null);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [buildsErr, setBuildsErr] = useState<string | null>(null);
  const [messages, setMessages] = useState<BuildMessage[] | null>(null);
  const [changesDoc, setChangesDoc] = useState<Document | null>(null);
  const [changesErr, setChangesErr] = useState<string | null>(null);

  // 闸门 UI 状态 —— confirm / review 时显示「批准 / 完成 / 完成并合并 / 反馈」
  // 三个动作。其余 phase 不渲染闸门区，避免无效按钮。
  const [feedback, setFeedback] = useState('');
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateNotice, setGateNotice] = useState<string | null>(null);

  // ── ConfirmPreview 切片（与 Composer/ReusePlan 命名不相交）────────────────
  //
  // B1 合并确认框（ConfirmDialog 受控开关）：
  //   - confirmMergeOpen=true 时点「完成并合并」按钮未直接发请求；改走 Dialog 二次确认。
  //   - 「完成（不合并）」走原路径不弹框（与原站语义一致，原站只对「合并」弹）。
  // A10 文档预览 + 版本对比：
  //   - previewDoc !== null 触发 DocPreview 弹层（kind 决定默认 tab + 安全策略）。
  //   - allDocs 是 documents 列表端点的本地缓存；planDoc 单条是因为 plan 始终来自
  //     latest build —— 与 Changes 一致，不存「旧 build 的 plan」是设计选择，原站
  //     用 run history 单独回看。
  //   - compareLeftId/RightId 选两版本文档后，文档区下方两侧并排显示 payload。
  const [confirmMergeOpen, setConfirmMergeOpen] = useState<boolean>(false);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [allDocs, setAllDocs] = useState<Document[] | null>(null);
  const [allDocsErr, setAllDocsErr] = useState<string | null>(null);
  const [planDoc, setPlanDoc] = useState<Document | null>(null);
  const [planDocErr, setPlanDocErr] = useState<string | null>(null);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);

  // 验收清单（checklist）—— 只在 todo.withChecklist 为 true 时启用。
  // `Todo.withChecklist` 在 `lib/api.ts` 的 `Todo` 接口里定义（与 todo.spec 等
  // 字段同源），开关为 false 时后端拒绝读写且 UI 不画整块区域，避免空提示
  // 「勾选任务」让用户误以为功能坏了。`null` 仍表示「正在加载」，`[]` 表示
  // 「已就绪但还没有 item」。
  const [checklist, setChecklist] = useState<ChecklistItem[] | null>(null);
  const [checklistReady, setChecklistReady] = useState<boolean>(false);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [checklistNewText, setChecklistNewText] = useState('');
  const [checklistBusy, setChecklistBusy] = useState(false);

  // 终态动作（Rerun / Reopen）—— 只在 todo.phase ∈ {done, failed, closed}
  // 时显示按钮。两个状态机写路径的 4xx 原样透出语义同闸门 —— 409 表示
  // 「状态机拒绝：从非终态触发」、422 是参数错、403 是跨团队、404 是 todo 不存在。
  // 文案人话化放在统一的 `friendlyTerminalError` 里集中处理。
  const [rerunBusy, setRerunBusy] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  // ── ReusePlan 切片新增：Continue / Reuse plan 写路径的状态 ─────────
  // Continue 仅在 failed phase 显示；Reuse plan 仅在终态且最新 build 真出过
  // plan（`planDocId !== null`）显示 —— 可见条件与 onRerun/onReopen 错开，避免
  // 同时点亮所有按钮造成用户疑惑。两个写动作与 rerun/reopen 共用 busy 互锁
  // 字段，cancel 一律 fail-fast（onContinue/onReusePlan 与 onRerun/onReopen
  // 共享同一组 busy gate），跟现有 rerunBusy/reopenBusy 一起放进 disabled。
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [reuseBusy, setReuseBusy] = useState(false);
  const [reuseError, setReuseError] = useState<string | null>(null);
  /** Continue 走通后的成功提示 —— 不是「错误」也走单独一条样式（中性灰），
   *  与 4xx 的 errorBox 区分开。避免重复点击：点击别的按钮或重开 todo
   * 时由对应的 err setter 或 reloadTodo 副作用清掉。 */
  const [continueNotice, setContinueNotice] = useState<string | null>(null);

  // ── Rewind / Restore 切片新增：UI 状态 ────────────────────────────────
  // 可见条件：`todo.phase ∈ {confirm, review, failed}`（与后端 Restore 端点
  // 一致）—— 其它相位整个区段不渲染。原站语义「available while the todo rests
  // at Confirm, Review, or Failed ... not while a turn is running or after the
  // todo is marked Done」，**用户连入口都不该看到**，不是「看到但被禁用」。
  // 写路径只接受 `{commitSha, sessionLeafEntryId}`（必填）；`sessionId` 服务
  // 端从 builds[0].session.id 自动取。**不**画假的「轮次选择器」—— schema
  // 里没有 checkpoint 定位字段，无法自动列出可回滚的历史轮次。
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoreCommit, setRestoreCommit] = useState('');
  const [restoreLeaf, setRestoreLeaf] = useState('');
  const [restoreTargetBuildId, setRestoreTargetBuildId] = useState<string>('');

  // Run history 展开状态 —— 选中某个 build 时按需拉它的 messages。
  // `null` 表示「没展开」；`undefined` 表示「收起」；`BuildMessage[]` 是已加载结果。
  // 折叠时的 `null` 与「失败」用 `expandedMessagesErr` 区分。
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<BuildMessage[] | null>(null);
  const [expandedMessagesErr, setExpandedMessagesErr] = useState<string | null>(null);
  const [expandedMessagesBusy, setExpandedMessagesBusy] = useState(false);

  // ── Composer (steering) 状态 —— 与「闸门反馈」语义严格区分：
  //   - 闸门反馈（`feedback` / `gateBusy`）只接受 confirm/review 阶段的修订意见，
  //     不会让 todo 推进。本切片**不**碰闸门区。
  //   - composer 是非闸门相位下的对话入口：running build 时进 steering 队列；
  //     settled build 时直接追加到 build_message。
  //   - 闸门相位硬塞 composer = 绕过闸门铁律，UI 上完全不渲染。
  //
  //   - **本切片只持有 busy / error / notice** —— 文本与 chip 由 MentionComposer
  //     内部状态管。父组件保留三态是因为它们跟「steering 队列」「网络错误」
  //     的写入路径是同一份逻辑；MentionComposer 把 (text, mentions) 通过
  //     `onSubmit` 回调交还给父组件，父组件照旧做「落库 vs 入队」分支。
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  /**
   * **Drop 桥 —— 让 DropCard 切片把 todo 引用直接插进 composer。**
   * MentionComposer 用 `forwardRef + useImperativeHandle` 暴露 `insertMention`；
   * DropCard 在 drop handler 里调 `composerRef.current?.insertMention(m)`，
   * MentionComposer 会把 chip 插入到当前光标位置（连续多次调用位置正确）。
   */
  const composerRef = useRef<MentionComposerHandle | null>(null);
  /**
   * MentionComposer 需要 teamId 才能拉 @agent / ~project / /skill / &machine 的候选。
   *
   * ⚠️ **不能用 `todo?.teamId`**（2026-10-18 修）：`GET /api/todos/:id` 的响应里
   * **没有 `teamId` 字段**（实测返回的 key 是 id / projectId / seqNum / …
   * repoFullName / defaultBranch），只有 `GET /api/todos` **列表**端点才带。
   * 于是 `todo?.teamId` 恒为 undefined → composer 拿不到 teamId → 所有需要
   * 团队的类目都显示「当前 todo 未关联到 team，无法拉取该类候选」。
   *
   * 身份的唯一来源是 cookie，`useTeamContext` 已经是页面级的事实源
   * （`AppShell` 里 `TeamProvider` 包着整棵树），直接取它的 `activeTeam.teamId`。
   */
  const { activeTeam } = useTeamContext();
  const activeTeamId = activeTeam?.teamId ?? null;
  /** 主消息流的「已拉到最大 seq」—— `?since=lastSeq` 增量轮询的游标。 */
  const [messagesLastSeq, setMessagesLastSeq] = useState<number>(-1);
  /** 后端返回的 steering 队列快照 —— `queued:[]` 字段。 */
  const [steeringQueue, setSteeringQueue] = useState<QueueItem[]>([]);

  // ── BranchMenu 配套：机器列表 + 检出命令 / 同步回执 ──────────────
  //
  // BranchMenu 自身只接受 `BranchMachine[]`（契约 §3.4 冻结的字段集）。
  // 上游 `/api/teams/:teamId/machines` 实测返回的是 `{id, name, isOnline,
  // workspacesDir, ...}`（**不是** `displayName`），所以我们在这里做一次
  // `name → displayName` 的字段映射再下传；契约 §3.4 不写明映射规则,
  // 由调用方负责。
  //
  // 拉机器走 BFF `/api/teams/:teamId/machines`（已存在的 settings/machines
  // 页同源）—— **不**走 todo 维度, 因为机器是团队级资源, 不是 todo 级。
  // 取的 teamId 是用户当前激活团队的 teamId（来自 useTeamContext）。
  // 这意味着如果用户激活的不是 todo 所属 team,列表可能为空; 这种情况
  // 下 BranchMenu 的契约兜底: 按钮置灰 + 「还没有登记的机器」。
  const [branchMachines, setBranchMachines] = useState<BranchMachine[]>([]);
  // BranchMenu 的回执（`onNote` 回调）—— 上抛到页面顶部 banner, 这样
  // 用户无论是从 BranchMenu 内部（菜单下方 receipt）还是从页面顶部
  // banner 都能看到。契约 §3.4 说 `onNote` 由调用方显示在「调用方
  // 选定的地方」, 我们选页面顶部 banner（最显眼的位置）。
  const [branchNote, setBranchNote] = useState<string | null>(null);
  /** BranchMenu 内 copy/sync 各自 receipt 的本地覆盖 —— 当父级 banner
   * 已经有同条文本时不重复显示。BranchMenu 内部 receipt 已经够用, 这里
   * 父级只是兜底。 */
  const [branchNoteSeenAt, setBranchNoteSeenAt] = useState<number>(0);

  // 拉 todo
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const r = await fetchJson<Todo>(`/todos/${encodeURIComponent(id)}`);
      if (ac.signal.aborted) return;
      if (r.ok) {
        setTodo(r.data);
      } else if (r.status === 404) {
        setTodoErr('数据未就绪：后端尚未实现 /api/todos/[id] 业务端点');
      } else {
        setTodoErr(`后端不可达 (${r.status}: ${r.reason})`);
      }
    })();
    return () => ac.abort();
  }, [id]);

  // 拉 builds
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const r = await fetchJson<Build[]>(`/todos/${encodeURIComponent(id)}/builds`);
      if (ac.signal.aborted) return;
      if (r.ok) setBuilds(r.data);
      else if (r.status === 404) setBuildsErr('数据未就绪：builds 端点尚未实现');
      else setBuildsErr(`不可达 (${r.status})`);
    })();
    return () => ac.abort();
  }, [id]);

  // 拉最新 build 的 messages + changes 文档
  // 响应里现在多了 `queued: QueueItem[]`（per Main 约定 + Composer 切片）；
  // `fetchJson<>` 把整个对象当 BuildMessage[] 用了，**错误**。
  // 改成本地 fetch + 手工信封解析，形状是
  //   { ready: true, data: { messages: BuildMessage[], queued?: QueueItem[] } }
  // —— 后端 Get 返回 messages 数组 + 可选 queued。失败时 ready=false，fallback
  //    到原「后端未就绪」语义。
  useEffect(() => {
    if (!builds || builds.length === 0) return;
    const latest = builds[0]!;
    const ac = new AbortController();
    void (async () => {
      const [msgResp, doc] = await Promise.all([
        fetch(`/api/builds/${encodeURIComponent(latest.id)}/messages`, {
          cache: 'no-store',
          signal: ac.signal,
        }),
        latest.changesDocId
          ? fetch(`/api/documents/${encodeURIComponent(latest.changesDocId)}`, {
              cache: 'no-store',
              signal: ac.signal,
            })
          : Promise.resolve<null>(null),
      ]);
      if (ac.signal.aborted) return;
      const msgBody = (await msgResp.json().catch(() => null)) as
        | {
            ready?: boolean;
            data?: { messages?: BuildMessage[]; queued?: QueueItem[] };
            reason?: string;
          }
        | null;
      if (msgBody && msgBody.ready === true && msgBody.data) {
        const msgs = msgBody.data.messages ?? [];
        setMessages(msgs);
        if (msgs.length > 0) {
          const max = msgs.reduce((a, b) => (b.seq > a ? b.seq : a), -1);
          setMessagesLastSeq(max);
        }
        if (Array.isArray(msgBody.data.queued)) setSteeringQueue(msgBody.data.queued);
      } else {
        // 后端未就绪 / ready:false：messages 保留为 null，仍允许「无消息」占位。
        setMessages(null);
      }
      const docBody = doc ? ((await doc.json().catch(() => null)) as
        | { ready?: boolean; data?: Document; reason?: string } | null) : null;
      if (docBody && docBody.ready === true && docBody.data) {
        setChangesDoc(docBody.data);
      } else if (doc) {
        setChangesErr('Changes 文档不可用');
      }
    })();
    return () => ac.abort();
  }, [builds]);

  // 增量轮询（消息流）—— SSE 目前没有消息级事件（实证：全仓 publish type 字面量
  // 只有 dispatched / step_update / phase_changed / todo_updated / todo_deleted，
  // 没有 message_added 或 build_message_pushed 之类）。`docs-conversation.md`
  // 说的「messages and tool calls stream in real time」在本切片里用 4 秒轮询
  //   `?since=<lastSeq>` 兜底 —— 这是诚实的「实时不到位」，UI 上明示 banner。
  // 轮询点：composer 实际渲染 + 后端拿到真实 buildId 时。每 4 s 重拉一次，
  // 只 append 比 lastSeq 大的行；每轮还会更新 steering 队列快照（已投递项
  // 自动消失）。
  // ── ConfirmPreview 切片：拉 Plan 文档 + 全 documents 列表（用于版本对比） ──
  //
  // 与 Composer 已有的 latest.changesDocId 直拉 effect 不重叠；这里走的是
  //   - fetchJson<Document>(`/documents/${latest.planDocId}`) —— 单 Plan 文档
  //   - fetchJson<Document[]>(`/todos/${todoId}/documents`) —— 全 todo 文档列
  //     表（新版对比要的就是它：docs-plans-and-diffs.md 原站「Compare with
  //     another version…」背后就是这个集合）。
  // 失败一律降级（不阻断渲染）。
  useEffect(() => {
    if (!builds || builds.length === 0) return;
    const latest = builds[0]!;
    const ac = new AbortController();
    setPlanDoc(null);
    setPlanDocErr(null);
    void (async () => {
      if (!latest.planDocId) {
        // 没有 planDocId 时**不要**置 err——只是「这个 build 没出 plan」，是合法状态。
        return;
      }
      const r = await fetchJson<Document>(`/documents/${encodeURIComponent(latest.planDocId)}`);
      if (ac.signal.aborted) return;
      if (r.ok) setPlanDoc(r.data);
      else setPlanDocErr(r.reason);
    })();
    return () => ac.abort();
  }, [builds]);

  useEffect(() => {
    if (!todo) return;
    const ac = new AbortController();
    setAllDocs(null);
    setAllDocsErr(null);
    void (async () => {
      // `/todos/:id/documents` 是 ConfirmPreview 新加的 BFF（已对照 builds 那个
      //   route 的写法做了 envelope 剥壳），拉「全 todo 的所有文档」，按
      //   createdAt desc；多 build 会产生多 plan 多 changes → 可对比。
      const r = await fetchJson<Document[]>(`/todos/${encodeURIComponent(todo.id)}/documents`);
      if (ac.signal.aborted) return;
      if (r.ok) setAllDocs(r.data);
      else setAllDocsErr(r.reason);
    })();
    return () => ac.abort();
  }, [todo?.id]);

  // ── 机器列表（BranchesMenu 配套） ─────────────────────────────────
  //
  // 实测 `/api/teams/:teamId/machines`（settings/machines 页同源）返回
  // `{id, name, isOnline, workspacesDir, ...}`, **不是**契约 §3.4 的
  // `{id, displayName, isOnline, workspacesDir}`。我们在拉取后做 `name →
  // displayName` 字段映射, 不修改后端 schema（DataLayer 切片负责）。
  //
  // 字段不存在（null/undefined）一律视为空字符串/空数组 —— 不抛错,
  // 跟其他 fetchJson 失败降级同一风格。
  //
  // 团队上下文变更时重拉（用户切团队时 BranchMenu 应看到新团队的机器）。
  useEffect(() => {
    if (!activeTeamId) {
      setBranchMachines([]);
      return;
    }
    const ac = new AbortController();
    void (async () => {
      // 走 BFF（proxyRead, envelope 形状 `{ready, data|reason}`）, data
      // 是裸数组（settings/machines page.tsx 已确认）；不指明泛型而用
      // 宽 raw 形, 然后手工校验字段, 避免 BFF 形状变化引起 ts 误差。
      type RawMachine = {
        id?: unknown;
        name?: unknown;
        isOnline?: unknown;
        workspacesDir?: unknown;
      };
      try {
        const res = await fetch(
          `/api/teams/${encodeURIComponent(activeTeamId)}/machines`,
          { cache: 'no-store', signal: ac.signal },
        );
        const body = (await res.json().catch(() => null)) as
          | { ready?: boolean; data?: RawMachine[]; reason?: string }
          | null;
        if (ac.signal.aborted) return;
        if (body && body.ready === true && Array.isArray(body.data)) {
          const list: BranchMachine[] = body.data
            .filter((m) => m && typeof m['id'] === 'string')
            .map((m) => ({
              id: String(m['id']),
              // 契约 §3.4 字段是 displayName；上游实际是 name —— 映射在这。
              displayName:
                typeof m['name'] === 'string' && m['name'].length > 0
                  ? (m['name'] as string)
                  : '(未命名机器)',
              isOnline: m['isOnline'] === true,
              workspacesDir:
                typeof m['workspacesDir'] === 'string' && (m['workspacesDir'] as string).length > 0
                  ? (m['workspacesDir'] as string)
                  : null,
            }));
          setBranchMachines(list);
        } else {
          // ready:false / 解析失败 —— 不阻断, 空数组给 BranchMenu 兜底。
          // 这里**不**把 reason 显示到 UI —— BranchMenu 内部已经按
          // 「还没有登记的机器」语义处理空数组（按钮置灰 + title）,
          // 父级 banner 会更干扰阅读。契约 §5.3: 「不许假绿」也包括
          // 「不许不存在的 reason 假装报错」 —— 失败时显示空数组
          // 而不是制造假压力。
          setBranchMachines([]);
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        // 同上, fetch 错误也走空数组 + BranchMenu 兜底, 不显示 reason。
        // eslint-disable-next-line no-console
        console.warn('[todo-page] branch machines fetch failed:', err);
        setBranchMachines([]);
      }
    })();
    return () => ac.abort();
  }, [activeTeamId]);

  const composerVisible = !!(todo && !isGatePhase(todo.phase) && !TERMINAL_PHASE[todo.phase]);
  const composerBuildId = composerVisible ? pickLatestBuildId(builds) : null;
  useEffect(() => {
    if (!composerBuildId) return;
    let stopped = false;
    let firstPoll = true;
    const tick = async () => {
      try {
        const since = firstPoll ? '' : `?since=${encodeURIComponent(String(messagesLastSeq))}`;
        firstPoll = false;
        const url = `/api/builds/${encodeURIComponent(composerBuildId)}/messages${since}`;
        const r = await fetch(url, { cache: 'no-store' });
        if (stopped) return;
        const body = (await r.json().catch(() => null)) as
          | { ready?: boolean; data?: { messages?: BuildMessage[]; queued?: QueueItem[] } }
          | null;
        if (!body || body.ready !== true || !body.data) return;
        // append 增量
        if (Array.isArray(body.data.messages) && body.data.messages.length > 0) {
          setMessages((prev) => {
            const seen = new Set<string>();
            const base = Array.isArray(prev) ? prev : [];
            for (const m of base) seen.add(m.id);
            const additions: BuildMessage[] = [];
            let maxSeq = messagesLastSeq;
            for (const m of body.data!.messages!) {
              if (seen.has(m.id)) continue;
              additions.push(m);
              seen.add(m.id);
              if (m.seq > maxSeq) maxSeq = m.seq;
            }
            if (additions.length === 0) return prev;
            const merged = [...base, ...additions].sort((a, b) => a.seq - b.seq);
            if (maxSeq !== messagesLastSeq) setMessagesLastSeq(maxSeq);
            return merged;
          });
        }
        if (Array.isArray(body.data.queued)) setSteeringQueue(body.data.queued);
      } catch {
        // 吞掉轮询错误 —— 下一轮会再试；不让它打断页面。
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // messagesLastSeq 故意进 deps：每来一批新消息，下一轮 since 才能正确推进。
  }, [composerBuildId, messagesLastSeq]);

  // 订阅 todo 级 scope —— 后端推 phase_changed 时刷新 todo
  useEffect(() => {
    const unsub = subscribe(`todo:${id}`, (frame: SseFrame) => {
      if (frame.type === 'todo_phase_changed' || frame.type === 'todo_changed') {
        void fetchJson<Todo>(`/todos/${encodeURIComponent(id)}`).then((r) => {
          if (r.ok) setTodo(r.data);
        });
        void fetchJson<Build[]>(`/todos/${encodeURIComponent(id)}/builds`).then((r) => {
          if (r.ok) setBuilds(r.data);
        });
      }
    });
    return unsub;
  }, [id]);

  // 验收清单：开关关闭或 todo 还没就绪时不拉；开关打开但接口未就绪时单独降级。
  // `todo.withChecklist` 是真值开关（与 todo.spec 等字段同源 —— `lib/api.ts`），
  // 它是 false 时不要 fetch，否则 422 错误会出现一个本不该存在的提示框。
  useEffect(() => {
    if (!todo || !todo.withChecklist) {
      // 开关关闭：清空本地状态，**不要**保留旧列表，否则切换 todo 时会闪老数据。
      setChecklist(null);
      setChecklistReady(false);
      setChecklistError(null);
      return;
    }
    const ac = new AbortController();
    void (async () => {
      const r = await fetch(
        `/api/todos/${encodeURIComponent(id)}/checklist`,
        { cache: 'no-store', signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      const body = (await r.json().catch(() => null)) as
        | { ready?: boolean; data?: ChecklistItem[]; reason?: string }
        | null;
      if (body && body.ready === true && Array.isArray(body.data)) {
        setChecklist(body.data);
        setChecklistReady(true);
        setChecklistError(null);
      } else if (body && body.ready === false) {
        // 接口未就绪：保留为 null（区别于 []），渲染「数据未就绪」占位
        setChecklist(null);
        setChecklistReady(false);
        setChecklistError(
          typeof body.reason === 'string'
            ? `数据未就绪：${body.reason}`
            : '数据未就绪：/api/todos/:id/checklist',
        );
      } else {
        setChecklist(null);
        setChecklistReady(false);
        setChecklistError('响应形状不对');
      }
    })().catch(() => {
      if (!ac.signal.aborted) {
        setChecklistError('网络错误');
      }
    });
    return () => ac.abort();
  }, [todo, id]);

  /**
   * 把 checklist 写操作的 4xx 翻译成人话 —— 与闸门 `friendlyGateError` 同形。
   * checklist 没有「phase 已变」的概念，但 422 文案是 zod 给的（如 `text: String must contain at least 1 character(s)`），
   * 需要把后端原文带回去；用户看到的是原始提示而不是「操作失败」。
   */
  function friendlyChecklistError(status: number, raw: string): string {
    if (status === 422) return `参数错：${raw}`;
    if (status === 403) return '无权操作：你不在这个 todo 所属的团队里。';
    if (status === 404) return 'todo 或清单项不存在。';
    return raw || `操作失败 (${status})`;
  }

  async function checklistAdd(): Promise<void> {
    if (checklistBusy) return;
    const text = checklistNewText.trim();
    if (text.length === 0) return;
    setChecklistError(null);
    setChecklistBusy(true);
    try {
      const res = await fetch(
        `/api/todos/${encodeURIComponent(id)}/checklist`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as
        { item?: ChecklistItem; error?: string };
      if (res.ok && body.item) {
        // 把新增项插到当前列表末尾（seq 由后端顺序生成 —— 实测 0→1），不去
        // 重新拉整个列表 —— 单条写操作不触发全量 reload，避免其它正在编辑的
        // 用户态被冲掉。
        setChecklist((prev) => (prev === null ? [body.item!] : [...prev, body.item!]));
        setChecklistNewText('');
      } else {
        setChecklistError(friendlyChecklistError(res.status, body.error ?? ''));
      }
    } catch (err) {
      setChecklistError(err instanceof Error ? err.name : '网络错误');
    } finally {
      setChecklistBusy(false);
    }
  }

  async function checklistToggle(item: ChecklistItem): Promise<void> {
    if (checklistBusy) return;
    // 乐观更新：先把勾选态翻一下，PATCH 失败再回滚并显示原因。
    // 闸门区已经用「乐观更新 + 失败回滚」模式（callGate 走的是显式 reload），
    // 清单写操作更轻量，乐观更新是合适的。
    const prevDone = item.done;
    const nextDone = !prevDone;
    setChecklistBusy(true);
    setChecklist((cur) => (cur === null ? cur : cur.map((x) => (x.id === item.id ? { ...x, done: nextDone } : x))));
    try {
      const res = await fetch(
        `/api/todos/${encodeURIComponent(id)}/checklist/${encodeURIComponent(item.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ done: nextDone }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as
        { item?: ChecklistItem; error?: string };
      if (res.ok && body.item) {
        setChecklist((cur) => (cur === null ? cur : cur.map((x) => (x.id === body.item!.id ? body.item! : x))));
      } else {
        // 回滚
        setChecklist((cur) => (cur === null ? cur : cur.map((x) => (x.id === item.id ? { ...x, done: prevDone } : x))));
        setChecklistError(friendlyChecklistError(res.status, body.error ?? ''));
      }
    } catch (err) {
      // 回滚
      setChecklist((cur) => (cur === null ? cur : cur.map((x) => (x.id === item.id ? { ...x, done: prevDone } : x))));
      setChecklistError(err instanceof Error ? err.name : '网络错误');
    } finally {
      setChecklistBusy(false);
    }
  }

  async function checklistDelete(item: ChecklistItem): Promise<void> {
    if (checklistBusy) return;
    const ok = window.confirm(
      `删除验收项「${item.text}」？\n\n该操作不可撤销。`,
    );
    if (!ok) return;
    setChecklistBusy(true);
    setChecklistError(null);
    try {
      const res = await fetch(
        `/api/todos/${encodeURIComponent(id)}/checklist/${encodeURIComponent(item.id)}`,
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as
        { ok?: boolean; error?: string };
      if (res.ok) {
        setChecklist((cur) => (cur === null ? cur : cur.filter((x) => x.id !== item.id)));
      } else {
        setChecklistError(friendlyChecklistError(res.status, body.error ?? ''));
      }
    } catch (err) {
      setChecklistError(err instanceof Error ? err.name : '网络错误');
    } finally {
      setChecklistBusy(false);
    }
  }

  // 闸门推进 / 反馈之后重拉 todo —— BFF 写路径是 4xx 原样透出，成功时 SSR 已
  // commit phase 推进，但客户端要等下一次 SSE 才有反应；显式 reload 让用户点完
  // 按钮立刻看到 phase 变化。
  const reloadTodo = useCallback(async () => {
    const r = await fetchJson<Todo>(`/todos/${encodeURIComponent(id)}`);
    if (r.ok) setTodo(r.data);
  }, [id]);

  // builds 在终态写操作（rerun / reopen）后必须重拉 —— 新 build 会作为最新
  // 一条出现，旧 build 的 messages 仍然按需加载（由 expanded-state 决定）。
  const reloadBuilds = useCallback(async () => {
    const r = await fetchJson<Build[]>(`/todos/${encodeURIComponent(id)}/builds`);
    if (r.ok) setBuilds(r.data);
  }, [id]);

  /**
   * 把上游 4xx 的人话化 —— `proxyWrite` 原样透出 `error` 字段，文案是给开发看的。
   * 409 在 confirm/review 这两条路径的语义是「状态已变 / phase 已经走过这个闸门」，
   * 必须用人话告诉用户「刷新后看最新状态」，否则用户看到的是「按钮按了没反应」。
   */
  function friendlyGateError(status: number, raw: string): string {
    if (status === 409) {
      return '状态已变：当前 phase 已经走过这道闸门。请刷新页面看最新状态。';
    }
    if (status === 422) {
      return `参数错：${raw}`;
    }
    if (status === 403) {
      return '无权操作：你不在这个 todo 所属的团队里。';
    }
    if (status === 404) {
      return 'todo 不存在或已被删除。';
    }
    return raw || `操作失败 (${status})`;
  }

  async function callGate(
    path: 'approve' | 'complete' | 'feedback',
    body: Record<string, unknown>,
  ): Promise<void> {
    setGateError(null);
    setGateNotice(null);
    setGateBusy(true);
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        phase?: string;
      };
      if (res.ok) {
        // 反馈是「写在闸门里派一个修订 build」，phase 不变；推进才是 phase 真的变。
        if (path === 'feedback') {
          setGateNotice('反馈已提交：agent 会基于你的修订重出一版计划。');
          setFeedback('');
        } else {
          setGateNotice(`已推进到 phase=${respBody.phase ?? todo?.phase ?? '下一阶段'}。`);
        }
        await reloadTodo();
      } else {
        setGateError(friendlyGateError(res.status, respBody.error ?? ''));
      }
    } catch (err) {
      setGateError(err instanceof Error ? err.name : '网络错误');
    } finally {
      setGateBusy(false);
    }
  }

  /**
   * Composer 提交 ——「非闸门时给 build 发消息」。**MentionsUI 两步绑定**。
   *
   * 与 `callGate` 完全不同：这里走 `/api/builds/:buildId/messages`（手写转
   * 发，不经 proxyWrite，详见 BFF route 注释）。后端根据 `finishedAt IS NULL`
   * 决定落库还是进队；客户端只需要把响应里的 `queued` 分支理解给用户看。
   *
   * 闸门相位（confirm / review）阶段 composer **不渲染**（见 composerVisible
   * 推导）—— 所以这里不用在这里再做闸门阻挡检查；UI 没显示，handler 不会被
   * 触发。这就是闸门铁律的最终一道防线。
   *
   * **MentionComposer 切片（MentionsUI）+ MentionsStore 端点契约**：
   * 1. POST `/api/builds/:buildId/messages`（旧路径）→ 拿 `message.id`。
   *    响应 `{ ok: true, queued: bool, message?: BuildMessage }`。
   * 2. **当且仅当 `mentions.length > 0` 且 `!queued`** 时：
   *    POST `/api/todos/:todoId/mentions`，body
   *    `{ messageId: message.id, mentions: MentionRef[] }`。
   *    状态码：`403` 跨团队、`404` messageId 不属于该 todo 的 build、
   *    `422` refId 不存在 或 prefix↔kind 不一致。
   *
   * **失败语义**：第二步失败 ≠ 消息失败。消息已经落库，原站语义是「消息发了
   * 但引用没绑上」—— 提示「消息已发送，但引用绑定失败（{reason}）」，**不**
   * 把消息报成发送失败，更**不**静默吞掉。
   *
   * **入队（queued=true）路径下不发第二步**：queued 消息还没落到 `build_messages`
   * 表，没有 `message.id` 可供 mentions 绑定。这种情况下 chip 引用会随
   * 队列项一起延后 —— 路由层没设计绑定延后机制，UI 老实告知用户。
   */
  async function composerSubmit(text: string, mentions: MentionRef[]): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!composerBuildId) {
      setComposerError('该 todo 当前没有可发往的 build，等 build 就绪后再试。');
      return;
    }
    setComposerBusy(true);
    setComposerError(null);
    setComposerNotice(null);
    try {
      // ── Step 1: 落 build_message（或入队） ────────────────────
      const res = await fetch(
        `/api/builds/${encodeURIComponent(composerBuildId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: trimmed, mentions }),
        },
      );
      const respBody = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        queued?: boolean;
        queueId?: string;
        position?: number;
        message?: BuildMessage;
        error?: string;
      };
      if (!res.ok || !respBody.ok) {
        setComposerError(
          res.status === 422
            ? `参数错：${respBody.error ?? ''}`
            : res.status === 409
              ? `消息状态已变：${respBody.error ?? '请刷新看最新状态。'}`
              : res.status === 403
                ? '无权操作：你不在这条 todo 所属的团队里。'
                : res.status === 404
                  ? 'build 不存在或已删除。'
                  : respBody.error ?? `操作失败 (${res.status})`,
        );
        return;
      }

      // MentionComposer 自己清空输入 —— 这里不用 setComposerDraft
      if (respBody.queued) {
        // 入队：本地立即画一项「投递中」，等下一轮 4s 轮询来真值。
        // queued 路径不发 step 2：queued 消息没 message.id，mentions 暂不绑定。
        const synthetic: QueueItem = {
          id: respBody.queueId ?? 'local-' + Date.now(),
          buildId: composerBuildId,
          content: trimmed,
          position: respBody.position ?? steeringQueue.length + 1,
          createdAt: Date.now(),
          status: 'pending',
          mentions: mentions.map((m) => ({ kind: m.kind, id: m.refId, label: m.label })),
        };
        setSteeringQueue((q) => [...q, synthetic]);
        setComposerNotice(`已加入 steering 队列（#${synthetic.position}），等 build 投递。`);
        if (mentions.length > 0) {
          setComposerNotice(
            `已加入 steering 队列（#${synthetic.position}）；队列项里的 chip 引用等 build 落库后再绑定。`,
          );
        }
        return;
      }

      // ── Step 2: 绑定 mentions（直接落库路径） ────────────────────
      const messageId = respBody.message?.id;
      if (mentions.length > 0 && messageId) {
        const bindRes = await fetch(
          `/api/todos/${encodeURIComponent(id)}/mentions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId, mentions }),
          },
        );
        const bindBody = (await bindRes.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!bindRes.ok || !bindBody.ok) {
          // **关键**：第二步失败 ≠ 消息失败 —— 不改 composerError，
          // 用 notice 路径如实告知用户「消息已发送，但引用绑定失败」。
          const reason = (() => {
            switch (bindRes.status) {
              case 403:
                return '跨团队拒绝';
              case 404:
                return 'messageId 不属于该 todo 的 build';
              case 422:
                return `参数错：${bindBody.error ?? 'prefix↔kind 不一致 或 refId 不存在'}`;
              default:
                return bindBody.error ?? `HTTP ${bindRes.status}`;
            }
          })();
          setComposerNotice(`消息已发送，但引用绑定失败（${reason}）。`);
        } else {
          setComposerNotice('消息已记录。');
        }
      } else {
        // 没 chip，纯文本 —— 走最简路径。
        setComposerNotice('消息已记录。');
      }
    } catch (err) {
      setComposerError(err instanceof Error ? err.name : '网络错误');
    } finally {
      setComposerBusy(false);
    }
  }

  /** 编辑未投递的队列项 —— 把 `newContent` 落到对应 queueId 上。 */
  async function queueEdit(item: QueueItem, newContent: string): Promise<void> {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    setComposerError(null);
    try {
      const res = await fetch(
        `/api/builds/${encodeURIComponent(item.buildId)}/messages/${encodeURIComponent(item.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: trimmed }),
        },
      );
      if (res.ok) {
        setSteeringQueue((q) =>
          q.map((it) => (it.id === item.id ? { ...it, content: trimmed } : it)),
        );
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setComposerError(`编辑失败：${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (err) {
      setComposerError(err instanceof Error ? err.name : '网络错误');
    }
  }

  /** 撤回队列项 —— 撤销已发出但未投递的消息。 */
  async function queueRetract(item: QueueItem): Promise<void> {
    setComposerError(null);
    try {
      const res = await fetch(
        `/api/builds/${encodeURIComponent(item.buildId)}/messages/${encodeURIComponent(item.id)}`,
        { method: 'DELETE' },
      );
      if (res.status === 200 || res.status === 404) {
        // 204 也按成功：撤回成功；404 也按成功：本来就不在队列里。
        setSteeringQueue((q) => q.filter((it) => it.id !== item.id));
        setComposerNotice('消息已撤回。');
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setComposerError(`撤回失败：${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (err) {
      setComposerError(err instanceof Error ? err.name : '网络错误');
    }
  }

  function onApprove(): void {
    if (gateBusy) return;
    void callGate('approve', { by: 'user' });
  }

  function onComplete(merge: boolean): void {
    if (gateBusy) return;
    // 原站只对「合并」那一个动作弹确认框（`docs-todos.md` B1）：
    //   "a confirmation dialog appears first, with Merge changes checked by default"
    // 「完成（不合并）」是直接推进，不弹框。所以这里根据 merge 派到两条路：
    //   - merge=false 直接发请求，与改之前等价
    //   - merge=true 先把对话框挂起；点「确认」才真发请求
    if (merge) {
      setConfirmMergeOpen(true);
    } else {
      void callGate('complete', { merge: false });
    }
  }

  /** ConfirmDialog「确认」回调 —— `checked=true` 时 merge 反正是 true；
   *  checked=false 时改走「只完成」的同一 callGate 路径（不需要再弹一次框）。 */
  function onConfirmMergeDialog(checked: boolean | undefined): void {
    setConfirmMergeOpen(false);
    if (gateBusy) return;
    if (checked === undefined) {
      // 没有 defaultChecked 概念 —— 这种调用形式在我们 B1 用例不会出现，但保持防御性
      void callGate('complete', { merge: true });
    } else {
      void callGate('complete', { merge: checked });
    }
  }

  function onSubmitFeedback(): void {
    if (gateBusy) return;
    const msg = feedback.trim();
    if (msg.length === 0) return;
    void callGate('feedback', { message: msg });
  }

  /**
   * 把 rerun / reopen 的 4xx 翻译成人话。
   *
   * - 409：状态机拒绝 —— 通常是「当前 phase 不是终态」或「正在被并发推进」。
   *   与闸门 409 的措辞区分：终态用户**预期**能重跑，所以明确告诉他
   *   「当前 phase 不能重跑，先看新 phase 是什么」。
   * - 422：zod body 错（rerun/reopen 当前不消费 body，触发一般是空字符串
   *   之类；照原文回给用户）。
   * - 403：跨团队 / actor 不在所属团队。
   * - 404：todo 不存在或被并发删了。
   *
   * 5xx / 网络错误抛上来给 catch —— 显示「后端不可达」即可。
   */
  function friendlyTerminalError(
    action: 'rerun' | 'reopen' | 'continue' | 'reuse-plan',
    status: number,
    raw: string,
  ): string {
    if (status === 409) {
      // 409 文案保持严肃但分相位给解释：continue / reuse-plan 在这里会
      // 出现「phase 不支持」或「没有可用的失败 build / plan」两种 reason；
      // raw 可能含「only valid on a failed todo」等原话，409 通用一行放不下
      // 所以继续照原文透给用户。
      return action === 'rerun'
        ? '当前 phase 不能重跑 —— 可能在别处被推进，请刷新看最新状态。'
        : action === 'reopen'
          ? '当前 phase 不能 reopen —— 可能已经不是终态，请刷新看最新状态。'
          : action === 'continue'
            ? '当前 phase 不能 continue —— 只有 failed 有 Continue。'
            : '当前 phase 不能复用 plan —— 只有终态可以。';
    }
    if (status === 422) {
      return `参数错：${raw}`;
    }
    if (status === 403) {
      return '无权操作：你不在这个 todo 所属的团队里。';
    }
    if (status === 404) {
      return 'todo 不存在或已被删除。';
    }
    return raw || `操作失败 (${status})`;
  }

  async function callTerminal(
    path: 'rerun' | 'reopen' | 'continue' | 'reuse-plan',
    busySetter: (v: boolean) => void,
    errSetter: (v: string | null) => void,
  ): Promise<void> {
    errSetter(null);
    if (path === 'continue') setContinueNotice(null);
    busySetter(true);
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        phase?: string;
      };
      if (res.ok) {
        // 立即刷新 todo 让 phase 标识变色；builds 是「附加信息」，可以异步拉。
        await reloadTodo();
        void reloadBuilds();
        // Continue 走通用诚实陈述（**不承诺自动推进**）。其余 3 种动作的
        // todo phase 一定会同步变化（rerun→todo, reopen→review, reuse-plan→
        // todo），看板刷新已经够说明；不再画蛇添足的成功提示。
        if (path === 'continue') {
          setContinueNotice(
            '已入库：同一 build 上的失败标记已清，新执行步骤已写入队列。' +
              '若当前无机器在线，或 daemon 暂不支持对已结算 build 的续跑 session，' +
              '这一步不会自动推进 phase；你随时可以再点 Rerun（开新 build）兜底。',
          );
        }
      } else {
        errSetter(friendlyTerminalError(path, res.status, body.error ?? ''));
      }
    } catch (err) {
      errSetter(err instanceof Error ? `网络错误 (${err.name})` : '网络错误');
    } finally {
      busySetter(false);
    }
  }

  /** 4 个终态按钮共享一组 busy 互锁 —— 同时只允许一个写动作在路上。 */
  function anyTerminalBusy(): boolean {
    return rerunBusy || reopenBusy || continueBusy || reuseBusy || restoreBusy;
  }

  function onRerun(): void {
    if (anyTerminalBusy()) return;
    void callTerminal('rerun', setRerunBusy, setRerunError);
  }

  function onReopen(): void {
    if (anyTerminalBusy()) return;
    void callTerminal('reopen', setReopenBusy, setReopenError);
  }

  // ── 详情页右上角主按钮（契约 §3.7 差异表第 14 项） ───────────────
  //
  // 原站实测语义：「任务详情页右上角的主按钮随阶段变化：确认、完成、重跑，
  // 运行中会置灰」。
  //
  // 我们把 9 个 phase 分成 3 类：
  //
  //   ┌─ 可用（按下走对应后端）
  //   │   - confirm   → 「确认」     POST /api/todos/:id/approve
  //   │   - review    → 「完成」     POST /api/todos/:id/complete (merge:false)
  //   │   - failed    → 「重跑」     POST /api/todos/:id/rerun
  //   │   - done      → 「重开」     POST /api/todos/:id/reopen
  //   │   - closed    → 「重开」     POST /api/todos/:id/reopen
  //   │
  //   ├─ 禁用（运行中置灰, 按钮文案照实反映阶段）
  //   │   - planning    「规划中…」
  //   │   - implement   「实现中…」
  //   │   - reviewing   「复核中…」
  //   │   - queued      「等待机器」
  //   │   - todo        「尚未开始」（不在闸门, 不算运行中, 但 todo 起步态
  //   │                  没有可走的 write 路径 —— 同样置灰）
  //
  // **不动原 commitGate / callTerminal 既有 busy 互锁** —— 主按钮只是
  // 这些函数的一个新 caller, 失败回执走 gateError / gateNotice 同一通道。
  // 因此在闸门区移除的 3 个长按钮（批准/完成不合并/完成并合并）依然在中部
  // 留了一个「完成并合并」次按钮（review only），合并走 ConfirmDialog，
  // 这条线是契约 §3.7 / docs-todos.md B1 的硬约束。
  function mainGateAction():
    | { kind: 'enabled'; label: string; onClick: () => void }
    | { kind: 'disabled'; label: string; reason: string } {
    const phase = todo?.phase;
    if (phase === 'confirm') {
      return { kind: 'enabled', label: gateBusy ? '确认中…' : '确认', onClick: onApprove };
    }
    if (phase === 'review') {
      // 主按钮 = 「完成（不合并）」, 不弹 ConfirmDialog —— 因为「完成并合并」
      // 才是弹框动作, 「完成」是直接推进。详见 onComplete 注释。
      return {
        kind: 'enabled',
        label: gateBusy ? '完成中…' : '完成',
        onClick: () => onComplete(false),
      };
    }
    if (phase === 'failed') {
      return {
        kind: 'enabled',
        label: rerunBusy ? '重跑中…' : '重跑',
        onClick: onRerun,
      };
    }
    if (phase === 'done' || phase === 'closed') {
      return {
        kind: 'enabled',
        label: reopenBusy ? '重开中…' : '重开',
        onClick: onReopen,
      };
    }
    // 禁用分支 —— 文案必须如实反映当前 phase（契约 §5.3「诚实要求」）。
    if (phase === 'planning') return { kind: 'disabled', label: '规划中…', reason: 'agent 正在出计划' };
    if (phase === 'implement') return { kind: 'disabled', label: '实现中…', reason: 'agent 正在写改动' };
    if (phase === 'reviewing') return { kind: 'disabled', label: '复核中…', reason: 'agent 在做最后审阅' };
    if (phase === 'queued') return { kind: 'disabled', label: '等待机器', reason: '尚无机器 claim 这条 todo' };
    if (phase === 'todo') return { kind: 'disabled', label: '尚未开始', reason: '还没有可推进的动作' };
    return { kind: 'disabled', label: phase ?? '未知阶段', reason: '当前阶段没有可推进的主按钮' };
  }

  /**
   * ⌘+Alt+Enter（Mac）/ Ctrl+Alt+Enter（Win）—— 在 review 相位下点
   * 「完成」。契约 §1.5（实测原站快捷键）。**只**在 review 下生效：
   *   - confirm 下 ⌘+Enter 走 send（已在 MentionComposer 内）；
   *   - running / terminal 下 ⌘+Alt+Enter 也没有意义, 不抢占用。
   *
   * 与 MentionComposer 的「⌘+Enter 发送」区分: 这里要求 **同时按住 Alt**,
   * MentionComposer 现有 Enter 处理（MentionComposer.tsx:584）显式 bails
   * when `e.altKey` is true —— 我们这边要的就是 bail + 接管。
   *
   * **gateBusy 走 ref 而非 deps**：deps 进 `gateBusy` 会让 effect 在
   * 每次 busy 翻转时重绑监听器（中间几毫秒窗口可能丢事件）。我们把
   * 当前 busy 放在 ref 里, 监听器闭包读 ref 取最新值, 重绑只发生在
   * phase 切换时 —— 用户视觉上无感。
   */
  const gateBusyRef = useRef<boolean>(false);
  useEffect(() => {
    gateBusyRef.current = gateBusy;
  }, [gateBusy]);
  useEffect(() => {
    if (!todo || todo.phase !== 'review') return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Enter') return;
      // macOS 上 metaKey = Command, Windows/Linux 上 ctrlKey = Control。
      // 兼容两平台 + 同时按住 alt。
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.altKey) return;
      // shift 不要: shift+Enter 留给 MentionComposer 换行（虽然它不接
      // shift, 但语义上要留给用户「我就想换行」的可能性）。
      if (e.shiftKey) return;
      e.preventDefault();
      // ref 取最新 gateBusy —— 避免 stale closure 双提交。
      if (gateBusyRef.current) return;
      // 与主按钮单击同源, 走 onComplete(false) —— 不弹 ConfirmDialog。
      // 主按钮在右上角 = 「完成（不合并）」, 与这里一致。
      void callGate('complete', { merge: false });
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // callGate 是 useCallback 闭包, 不进 deps；phase 切换是唯一重绑点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo?.phase]);

  /** Continue —— 已在 failed phase 校验过；服务端的 continue 端点是同一份契约。 */
  function onContinue(): void {
    if (anyTerminalBusy()) return;
    void callTerminal('continue', setContinueBusy, setContinueError);
  }

  /** Reuse plan —— 上游已按 planDocId 校验过；前端只做可见性、busy 互锁。 */
  function onReusePlan(): void {
    if (anyTerminalBusy()) return;
    void callTerminal('reuse-plan', setReuseBusy, setReuseError);
  }

  /**
   * Restore（Rewind）—— 走 POST /api/todos/:id/restore。
   *
   * 与 callTerminal 同源的「4xx 原样透出 + 文案人话化」风格，但语义独立：
   *   - 200：返回 `pendingRestore` 三个字段；前端给出**只陈述已发生**的诚实提示
   *     —— daemon 端是否真的在 next turn 回滚 worktree + 续 session 是另一个切片，
   *     UI 不预测、不承诺。
   *   - 409：phase 不允许 / build 在跑 / 已有 pending 三种 reason，全是「现在不该
   *     rewind」，人话化分支。
   *   - 403：跨团队或非 owner。
   *   - 404：todo / build 不存在。
   *   - 422：缺字段 / 类型错（前端 shouldValidate 已把关，这里兜底）。
   */
  function friendlyRestoreError(status: number, raw: string): string {
    if (status === 409) {
      if (/already pending/.test(raw)) {
        return '已经有一个待回滚的请求了；先在构建历史里取消上一个，或等它自然落地。';
      }
      if (/running/.test(raw)) {
        return 'build 还在跑 —— 等它结束或失败后再 rewind。';
      }
      return `当前 phase 不支持 rewind：${raw}`;
    }
    if (status === 422) return `参数错：${raw}`;
    if (status === 403) {
      return '无权操作：只有这条 todo 的 owner 可以 rewind。';
    }
    if (status === 404) return 'todo 或 build 不存在或已被删除。';
    return raw || `操作失败 (${status})`;
  }

  async function onRestore(): Promise<void> {
    if (anyTerminalBusy()) return;
    const commitSha = restoreCommit.trim();
    const sessionLeafEntryId = restoreLeaf.trim();
    if (!commitSha || !sessionLeafEntryId) {
      setRestoreError('commit SHA 与 session leaf entry id 都是必填。');
      return;
    }
    setRestoreError(null);
    setRestoreNotice(null);
    setRestoreBusy(true);
    try {
      const payload: Record<string, unknown> = {
        commitSha,
        sessionLeafEntryId,
      };
      if (restoreTargetBuildId) payload['buildId'] = restoreTargetBuildId;
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        pendingRestore?: { commitSha: string; sessionLeafEntryId: string; sessionId: string };
        daemonPending?: boolean;
      };
      if (res.ok && body.ok) {
        // ⚠️ 诚实陈述：库内已登记；worktree 与 session 的真实回滚取决于 daemon
        // 在 next turn 看到非空 pendingRestore 时是否支持 —— 本切片**不承诺**
        // 自动发生。agent memory 不受影响（原站原文）。
        const sessionId = body.pendingRestore?.sessionId ?? '?';
        setRestoreNotice(
          // 不要用 Markdown 语法（`**加粗**`）：这是普通文本通知，
          // 没有 markdown 渲染管线，星号会原样显示给用户。
          '已登记回滚请求。代码分支与会话将在下一轮开始时由执行机器回滚（需要 daemon 支持续跑 session）。' +
            `agent memory 不受影响。sessionId=${sessionId}`,
        );
        // 让构建历史面板刷出新的 pendingRestore 标记（build 行 v+1）
        void reloadBuilds();
      } else {
        setRestoreError(friendlyRestoreError(res.status, body.error ?? ''));
      }
    } catch (err) {
      setRestoreError(err instanceof Error ? `网络错误 (${err.name})` : '网络错误');
    } finally {
      setRestoreBusy(false);
    }
  }

  /** 折叠 / 展开某个 build 的 messages。
   *  - 第一次展开：fetchJson<BuildMessage[]>('/builds/{id}/messages')
   *  - 已加载的：只是切换可见性，不重拉
   *  - 已展开的：关掉清状态，节省后续 re-render
   *  失败 / ready:false 时把 reason 写到 expandedMessagesErr，让该行单独降级。
   */
  async function onToggleBuildExpand(buildId: string): Promise<void> {
    if (expandedMessagesBusy) return;
    if (expandedBuildId === buildId) {
      setExpandedBuildId(null);
      setExpandedMessages(null);
      setExpandedMessagesErr(null);
      return;
    }
    setExpandedBuildId(buildId);
    setExpandedMessages(null);
    setExpandedMessagesErr(null);
    setExpandedMessagesBusy(true);
    try {
      const r = await fetchJson<BuildMessage[]>(`/builds/${encodeURIComponent(buildId)}/messages`);
      if (r.ok) setExpandedMessages(r.data);
      else setExpandedMessagesErr(r.status === 0 ? r.reason : `后端 ${r.status}: ${r.reason}`);
    } catch (err) {
      setExpandedMessagesErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setExpandedMessagesBusy(false);
    }
  }

  const diffText = useMemo(() => extractDiff(changesDoc), [changesDoc]);
  const planText = useMemo(() => extractPlanText(planDoc), [planDoc]);
  // 版本对比选出来的两份文档归一化为"可对比纯文本"。找不到时显示「未选择」。
  const compareLeftDoc = useMemo(
    () => (compareLeftId ? (allDocs ?? []).find((d) => d.id === compareLeftId) ?? null : null),
    [allDocs, compareLeftId],
  );
  const compareRightDoc = useMemo(
    () => (compareRightId ? (allDocs ?? []).find((d) => d.id === compareRightId) ?? null : null),
    [compareRightId, allDocs],
  );
  const compareLeftText = useMemo(() => extractDocumentText(compareLeftDoc), [compareLeftDoc]);
  const compareRightText = useMemo(() => extractDocumentText(compareRightDoc), [compareRightDoc]);
  /** 同一 kind 下能被选为左右两份对比的文档对 —— 跨 kind 不允许（plan ↔ plan；changes ↔ changes）。 */
  const compareOptions = useMemo(() => {
    const left = compareLeftDoc;
    if (!left) return [] as Document[];
    return (allDocs ?? []).filter((d) => d.kind === left.kind);
  }, [allDocs, compareLeftDoc]);

  return (
    <main style={{ padding: `${S.xl}px ${S.lg}px ${S.xxl}px`, maxWidth: 1200, margin: '0 auto', color: C.text, fontSize: T.body }}>
      <a href="/" style={{ fontSize: T.meta, color: C.accent, textDecoration: 'none' }}>← 返回看板</a>

      {todoErr && (
        <div style={notReadyStyle}><strong>数据未就绪</strong><div style={{ marginTop: 4 }}>{todoErr}</div></div>
      )}

      {todo && (
        <section style={cardStyle}>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: C.textDim, fontSize: T.meta }}>#{todo.seqNum}</span>
            <h1 style={{ margin: 0, fontSize: T.h2, color: C.text }}>{todo.title}</h1>
            <span style={{
              fontSize: T.base,
              padding: '2px 8px',
              borderRadius: R.pill,
              background: todo.phase === 'confirm' || todo.phase === 'review' ? 'rgba(251,191,36,0.12)' : 'rgba(129,140,248,0.14)',
              color: todo.phase === 'confirm' || todo.phase === 'review' ? C.warn : C.accent,
              border: `1px solid ${todo.phase === 'confirm' || todo.phase === 'review' ? C.warn : C.accent}`,
            }}>{todo.phase}</span>
            {/*
              右上角主按钮区（契约差异 #14）—— 沿用原站「详情页右上角主按钮随
              阶段变化」语义。视觉权重：
                - 主按钮（确认/完成/重跑/重开）—— primaryBtn
                - 分支操作（BranchMenu）—— ghostBtn 谱系, 不抢主按钮权重
                - 已禁用按钮显示「运行中…」之类的诚实文案, 不留空白
            */}
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: S.sm,
              }}
            >
              {(() => {
                const action = mainGateAction();
                if (action.kind === 'enabled') {
                  return (
                    <button
                      type="button"
                      onClick={action.onClick}
                      disabled={gateBusy || anyTerminalBusy()}
                      data-testid="todo-main-action"
                      style={mainActionBtnStyle}
                    >
                      {action.label}
                    </button>
                  );
                }
                // 禁用态 —— title 解释为什么（契约 §5.3 不许静默）
                return (
                  <button
                    type="button"
                    disabled
                    title={action.reason}
                    data-testid="todo-main-action-disabled"
                    style={mainActionBtnDisabledStyle}
                  >
                    {action.label}
                  </button>
                );
              })()}
              {/*
                BranchMenu 触发按钮 —— 契约 §3.4 要求可访问 `branch` /
                `worktreePath` / `machines`。还没有 build 时 branch 是
                null, BranchMenu 内部不应该做任何分支相关操作（实际
                上现在没有 `branch===null` 的禁用分支, 因为菜单项都
                是「对当前分支操作」, 分支不存在时整张菜单没意义）;
                但我们至少保留 trigger, 用户可以复制 git 命令 —— 不
                过 branch 是 null 时复制出来的命令对用户没意义, 所
                以 trigger 直接置灰。
              */}
              {(() => {
                const branchName = builds && builds.length > 0 ? builds[0]!.branch : null;
                const wtPath = builds && builds.length > 0 ? builds[0]!.worktreePath : null;
                if (!branchName) {
                  return (
                    <button
                      type="button"
                      disabled
                      title="分支操作需要至少一个 build —— 当前 todo 还没产出过 build"
                      data-testid="branch-menu-disabled"
                      style={triggerDisabledBtnStyle}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M8 1v8.586L4.707 6.414 3.293 7.828 8 12.536l4.707-4.708-1.414-1.414L9 9.586V1H8zm-8 9v4h16v-4H0z"
                          fill={C.textGhost}
                        />
                      </svg>
                      <span>下载</span>
                    </button>
                  );
                }
                return (
                  <BranchMenu
                    branch={branchName}
                    todoId={todo.id}
                    worktreePath={wtPath}
                    machines={branchMachines}
                    variant="button"
                    onNote={(note) => {
                      setBranchNote(note);
                      setBranchNoteSeenAt(Date.now());
                    }}
                  />
                );
              })()}
            </div>
          </header>
          {/*
            BranchMenu 触发按钮的回执上抛到这里, 给个页面顶部 banner。
            BranchMenu 内部也有 receipt —— 双重显示避免用户在别处操作
            后切走 BranchMenu 后忘了。注意 BranchMenu 自己的 receipt
            是固定显示的（菜单关闭后还保留）; 这里只在 `onNote` 触发
            时短暂显示, 5 秒后自动消。

            ⚠️ `branchNoteSeenAt` 是单调自增关键 — 每次新回执产生一个
            新时间戳, 我们靠它 + `branchNote` 文本组合来判断是否
            「同一条」。为简化: 5 秒倒计时一过就清空文本, 不做去重。
          */}
          {branchNote && (
            <div
              style={{
                ...shared.noticeBox,
                marginTop: S.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
              data-testid="branch-note-banner"
            >
              <span>{branchNote}</span>
              <button
                type="button"
                onClick={() => setBranchNote(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: C.textDim,
                  cursor: 'pointer',
                  fontFamily: F.sans,
                  fontSize: T.meta,
                }}
                aria-label="关闭提示"
              >
                ✕
              </button>
            </div>
          )}
          {todo.spec && (
            <pre style={specStyle}>{todo.spec}</pre>
          )}
        </section>
      )}

      {/* 5 秒后自动消 branchNote —— 避免永久占据页面顶部空间。
          `branchNoteSeenAt` 进 deps: 每次新回执重置计时器。 */}
      {branchNote && (
        <BranchNoteAutoDismiss
          note={branchNote}
          seenAt={branchNoteSeenAt}
          onDismiss={() => setBranchNote(null)}
        />
      )}

      {/* 闸门区 —— 只在 confirm / review 渲染。

          **契约差异 #14 之后的中部精简版**：主按钮已上移到右上角（见上方
          header 区）, 这里只保留两件事:
            1. 「反馈给 agent」输入框 —— 闸门铁律的修订反馈路径
               （写反馈不会放行当前计划）
            2. 一行闸门铁律说明 —— 防止用户把反馈输入区当成「放行输入框」

          「完成并合并」次按钮（review only）保留在这一区, 因为它**必
          须**走 ConfirmDialog, 走「不弹框直接合并」等于砍掉 B1 合并
          二次确认 —— 与原站语义相反, 也不允许把 ConfirmDialog 上提到
          顶部。

          中部不放「主按钮」（已上移）, 也不放「把反馈交给 agent」
          提交按钮旁的「取消反馈」之类——后者让用户能在打字过程中
          重新看一次反馈（不必保留, 用户随时可清空输入框）。 */}
      {todo && (todo.phase === 'confirm' || todo.phase === 'review') && (
        <section
          style={gateCardStyle}
          data-gate={todo.phase}
        >
          <h2 style={{ ...sectionTitleStyle, color: C.warn }}>
            {todo.phase === 'confirm' ? '计划确认' : '变更确认'} · 闸门
          </h2>
          {/*
            review 相位的次按钮「完成并合并」 —— 走 ConfirmDialog
            (`onConfirmMergeDialog` 已存在), 不抢主按钮视觉权重,
            用 ghostBtn + warn 描边表达「这是带二次确认的备选」。
            confirm 相位没有合并语义 (原计划要 'plan' 文档,
            还没 build → 没法合并), 所以 confirm 不渲染这条。
          */}
          {todo.phase === 'review' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => onComplete(true)}
                disabled={gateBusy}
                style={mergeSecondaryBtnStyle}
                data-testid="complete-and-merge-secondary"
              >
                完成并合并…
              </button>
              <span style={{ fontSize: T.sm, color: C.textFaint, alignSelf: 'center' }}>
                弹框确认，默认勾选「合并变更」（契约 §3.7 / docs-todos.md B1）
              </span>
            </div>
          )}
          {/*
            review 相位的快捷键提示 —— 「⌘+Alt+Enter」在 review 等同点右上
            主按钮完成。confirm 相位没有可绑快捷键的主动作（输入区走 Enter 是
            MentionComposer 负责的修订反馈路径, 不能混)。
          */}
          {todo.phase === 'review' && (
            <p
              style={{
                margin: '0 0 12px',
                fontSize: T.sm,
                color: C.textFaint,
              }}
              data-testid="review-shortcut-hint"
            >
              快捷键：<code style={shortcutHintCodeStyle}>⌘ + Alt + Enter</code> /
              <code style={shortcutHintCodeStyle}>Ctrl + Alt + Enter</code> 完成。
            </p>
          )}

          <label style={{ ...labelStyle, color: C.warn }}>
            反馈给 agent（仅作修订，不会放行当前计划）
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="告诉 agent 哪里要改、哪里补什么 —— 这些字不会变成确认/完成。"
            disabled={gateBusy}
            rows={4}
            style={{ ...gateInputStyle, fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              onClick={onSubmitFeedback}
              disabled={gateBusy || feedback.trim().length === 0}
              style={feedbackBtnStyle}
            >
              {gateBusy ? '提交中…' : '把反馈交给 agent'}
            </button>
          </div>
          <p style={gateRuleStyle}>
            在这里输入的任何内容（包括写「确认」）都只会作为<strong>修订反馈</strong>交给
            agent 重新出一版计划，<strong>不会</strong>放行当前计划；要放行请点右上角的
            主按钮。
          </p>

          {gateError && <div style={gateErrorStyle}>{gateError}</div>}
          {gateNotice && <div style={gateNoticeStyle}>{gateNotice}</div>}
        </section>
      )}

      {/* 终态横幅：只对 done / failed / closed 三个 phase 渲染。
          - done：可 Rerun（重头开始）/ Reopen（拉回 review 闸门）。
          - failed：除了上面两个动作，再单独解释「为什么这条 todo 当前是 failed」。
          - closed：与 done 同形，给统一按钮即可。
          4xx 报错也走同一块 errorBox 区域呈现。 */}
      {todo && TERMINAL_PHASE[todo.phase] && (
        <section style={terminalCardStyle}>
          <h2 style={{ ...sectionTitleStyle, color: C.warn }}>
            {todo.phase === 'failed' ? '状态：失败' : todo.phase === 'done' ? '状态：已完成' : '状态：已关闭'}
            {' '}· 终态
          </h2>
          <div style={{ fontSize: T.meta, color: C.textDim, marginBottom: 12 }}>
            {todo.phase === 'failed' && (
              <>这条 todo 当前 phase=<strong>failed</strong>。先看下面 build 列表里
              最近一次 build 的失败原因，再决定下一步：</>
            )}
            {todo.phase === 'done' && (
              <>这条 todo 已经完成。要从头再跑一遍用「重跑」，要重新打开评审用「重新打开」。</>
            )}
            {todo.phase === 'closed' && (
              <>这条 todo 已经被关闭。要重新打开走「重新打开」，要从头再跑走「重跑」。</>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onRerun}
              disabled={anyTerminalBusy()}
              style={rerunBtnStyle}
            >
              {rerunBusy ? '重跑中…' : '重跑（Start over）'}
            </button>
            <button
              type="button"
              onClick={onReopen}
              disabled={anyTerminalBusy()}
              style={reopenBtnStyle}
            >
              {reopenBusy ? '重开中…' : '重新打开（回到 review 闸门）'}
            </button>
            {/* ── Continue：仅 failed 显示 ──
                原站语义：「retrying the failed turn in place on the existing
                build, keeping its conversation and code changes」。后端不
                推 phase —— 状态机里 `failed` 无「→ 非终态」trigger，daemon
                settle 才会推进。点击后下面 notice 区给出**只陈述已发生**
                的文案，不承诺「agent 完成时会推进」。 */}
            {todo.phase === 'failed' && (
              <button
                type="button"
                onClick={onContinue}
                disabled={anyTerminalBusy()}
                style={continueBtnStyle}
              >
                {continueBusy ? '继续中…' : '继续（Continue）'}
              </button>
            )}
            {/* ── Reuse plan：仅终态 + 最近 build 真出过 plan 显示 ──
                判定用 `planDocId`（DB plan_doc_id 列）而不是 `withPlan`
                （该字段在 `services/builds.ts:148` 透传 planFirst，不代表
                build 实际产出过 plan —— 见 routes/todos.ts Reuse plan handler
                的注释与 todo-continue.test.ts 的 tc-reuse-noplan 用例）。
                旧 buildId 选择 / 文档 kind=plan 的存在：服务端在 /api 端点
                校验，前端只控制可见性。 */}
            {builds && builds.length > 0 && builds[0]!.planDocId != null && (
              <button
                type="button"
                onClick={onReusePlan}
                disabled={anyTerminalBusy()}
                style={reusePlanBtnStyle}
              >
                {reuseBusy ? '复用计划中…' : '复用计划（Reuse plan）'}
              </button>
            )}
          </div>
          {(rerunError || reopenError || continueError || reuseError) && (
            <div style={terminalErrorStyle}>
              {rerunError ?? reopenError ?? continueError ?? reuseError}
            </div>
          )}
          {/* Continue 走通后展示「只陈述已发生」的提示，按 Main 要求绝不出
              现「agent 完成时推进」「会自动推进」之类承诺：库内 reset 与
              step 入队是已落地事实；后续是否推进 phase 取决于机器在线状
              态与 daemon 是否接续跑 session —— 这是诚实空白，不补预测。 */}
          {continueNotice && (
            <div style={terminalContinueNoticeStyle}>
              {continueNotice}
            </div>
          )}
        </section>
      )}

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>消息流</h2>
        {buildsErr && <div style={notReadyStyle}>{buildsErr}</div>}
        {messages === null && !buildsErr && <div style={{ color: C.textDim, fontSize: T.meta }}>无消息</div>}
        {messages && messages.length === 0 && <div style={{ color: C.textDim, fontSize: T.meta }}>暂无消息</div>}
        {messages && messages.map((msg) => (
          <div key={msg.id} style={{
            padding: 8,
            marginBottom: 6,
            background: msg.role === 'user' ? 'rgba(129,140,248,0.14)' : C.surface,
            borderRadius: R.md,
            borderLeft: msg.role === 'user' ? `3px solid ${C.accent}` : `3px solid ${C.line}`,
          }}>
            <div style={{ fontSize: T.sm, color: C.textDim, marginBottom: 4 }}>
              [{msg.seq}] {msg.role}
              {msg.isError && <span style={{ color: C.danger, marginLeft: 6 }}>ERROR</span>}
            </div>
            <pre style={msgContentStyle}>{msg.content}</pre>
          </div>
        ))}
      </section>

      {/* Steering tray（mid-turn 队列）—— 仅当 (todo 不是闸门 && 还在跑) 渲染。
          与「消息流」段不重复：消息流 = 已落 build_message；tray = 还未投递
          的用户消息（进程内 Map 在 BFF 路由另一端）。原站语义是「Queued
          messages ... numbered in delivery order when several are queued」。
          这里的 position 是后端自增序号，与原站一致。 */}
      {todo && composerVisible && steeringQueue.length > 0 && (
        <section
          style={steeringTrayStyle}
          aria-label="Steering queue"
        >
          <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong style={{ color: C.warn, fontSize: T.base }}>Steering tray</strong>
            <span style={{ color: C.textDim, fontSize: T.sm }}>
              {steeringQueue.length} 条待投递
            </span>
          </header>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {[...steeringQueue].sort((a, b) => a.position - b.position).map((it) => (
              <li
                key={it.id}
                style={steeringItemStyle}
                aria-label={`queued message ${it.position}`}
              >
                <span style={steeringPosChip}>#{it.position}</span>
                <span style={steeringTextStyle}>{it.content}</span>
                <span style={steeringStatusPill}>
                  {it.status === 'delivered' ? '已送达' : '投递中'}
                </span>
                {it.status === 'pending' && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const next = window.prompt('编辑这条消息：', it.content);
                        if (next !== null && next.trim() !== it.content) {
                          void queueEdit(it, next);
                        }
                      }}
                      style={steeringEditBtn}
                      disabled={composerBusy}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('撤回这条未投递的消息？')) void queueRetract(it);
                      }}
                      style={steeringRetractBtn}
                      disabled={composerBusy}
                    >
                      撤回
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Rewind / Restore —— 原站 docs-conversation.md：
            "Any earlier round can be restored ... The conversation and code return
             to that checkpoint, the message you sent there goes back into the
             composer for you to edit and resend, and the agent continues from
             there ... Restoring is available while the todo rests at Confirm,
             Review, or Failed ... only for the todo's owner".

          可见条件：`todo.phase ∈ {confirm, review, failed}` —— 其它相位整段
          不渲染（不是禁用），与「available while ...」一致。

          **诚实降级**：schema 没记录 checkpoint 定位字段（`build_messages`
          只有 role/seq/content），前端**无法**自动列出可回滚的历史轮次。
          也没有 `commitSha` / `sessionLeafEntryId` 字段可读 —— 给两个手动
          输入框 + 明示「自动列出历史轮次需要后端记录 checkpoint 信息，
          当前未提供」。`sessionId` 从 `builds[0].session.id` 自动取，
          前端**不**显示 / 不让用户填（服务端会从 build.session JSONB 拿）。

          body 提交 = `POST /api/todos/:id/restore`，走 BFF 手写转发
          （不走 proxyWrite，URL 不带 teamId）。成功后给出**只陈述已发生**
          的提示 —— daemon 是否真的在 next turn 回滚 worktree 是另一个切片，
          不预测、不承诺。 */}
      {todo && (todo.phase === 'confirm' || todo.phase === 'review' || todo.phase === 'failed') && (
        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>回到某一轮（Rewind / Restore）</h2>
          <div style={{ fontSize: T.meta, color: C.textDim, marginBottom: 12 }}>
            当前 phase=<strong>{todo.phase}</strong>（restore 在 confirm / review / failed 可用）。
            {builds && builds.length > 0 && builds[0]!.session && (
              <>
                {' '}
                当前 session id（服务端自动取，前端不让你填）：<code style={restoreCodeStyle}>{builds[0]!.session.id}</code>
              </>
            )}
          </div>
          <div style={{ fontSize: T.base, color: C.textDim, marginBottom: 8, lineHeight: 1.5 }}>
            schema 当前没有可定位历史轮次的字段，<strong>前端无法自动列出「可回滚的检查点」</strong>。
            需要手动填 commit SHA（git 上要回退到的那个 commit）与 session leaf entry id
            （该 session 里要回到的那条消息 id）。如不知道这两个值，留空并等后端补 checkpoint 字段后再来。
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: S.sm, marginBottom: 8 }}>
            <label style={restoreLabelStyle}>
              <span style={{ marginRight: 6 }}>Commit SHA</span>
              <input
                type="text"
                value={restoreCommit}
                onChange={(e) => setRestoreCommit(e.target.value)}
                placeholder="abc1234 或完整 sha"
                disabled={restoreBusy}
                style={restoreInputStyle}
                data-testid="restore-commit"
              />
            </label>
            <label style={restoreLabelStyle}>
              <span style={{ marginRight: 6 }}>Session leaf entry id</span>
              <input
                type="text"
                value={restoreLeaf}
                onChange={(e) => setRestoreLeaf(e.target.value)}
                placeholder="该 session 内要回到的那条消息的 id"
                disabled={restoreBusy}
                style={restoreInputStyle}
                data-testid="restore-leaf"
              />
            </label>
            {builds && builds.length > 1 && (
              <label style={restoreLabelStyle}>
                <span style={{ marginRight: 6 }}>目标 build（可选，默认最新）</span>
                <select
                  value={restoreTargetBuildId}
                  onChange={(e) => setRestoreTargetBuildId(e.target.value)}
                  disabled={restoreBusy}
                  style={restoreInputStyle}
                  data-testid="restore-build"
                >
                  <option value="">最新 build（默认）</option>
                  {builds.map((b) => (
                    <option key={b.id} value={b.id}>
                      #{b.n} · {b.triggerSource} · {formatBuildTime(b.createdAt, b.finishedAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => void onRestore()}
              disabled={restoreBusy || !restoreCommit.trim() || !restoreLeaf.trim()}
              style={restoreBtnStyle}
              data-testid="restore-submit"
            >
              {restoreBusy ? '登记中…' : '登记回滚请求'}
            </button>
            <span style={{ color: C.textFaint, fontSize: T.sm }}>
              提交后写 <code>builds.pending_restore</code>；worktree / session 的真实回滚
              取决于执行机器在下一轮开始时是否支持续跑（需 daemon 接入）。
            </span>
          </div>
          {restoreError && <div style={restoreErrorStyle}>{restoreError}</div>}
          {restoreNotice && <div style={restoreNoticeStyle}>{restoreNotice}</div>}
        </section>
      )}

      {/* Run history：列出这个 todo 全部 build，按需展开看 messages。
          与「消息流」段不重复 —— 消息流始终显示最新 build 的 messages，
          这里允许用户在多次构建之间切换。
          `Build` 字段（id/todoId/n/branch/prevPhase/triggerSource/settlementCode/
          errorMessage/withPlan/withChecklist/agentId/prUrl/createdAt/finishedAt/v）
          都已在 `lib/api.ts` 的 Build 类型里对齐 schema —— 不读 raw JSON。 */}
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>构建历史</h2>
        {buildsErr && <div style={notReadyStyle}>{buildsErr}</div>}
        {builds === null && !buildsErr && (
          <div style={{ color: C.textDim, fontSize: T.meta }}>构建历史未就绪（fetching…）</div>
        )}
        {builds !== null && builds.length === 0 && (
          <div style={{ color: C.textDim, fontSize: T.meta }}>这条 todo 还没有 build</div>
        )}
        {builds !== null && builds.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {builds.map((b) => {
              const isExpanded = expandedBuildId === b.id;
              const isLatest = b === builds[0];
              return (
                <li key={b.id} style={buildRowStyle}>
                  <button
                    type="button"
                    onClick={() => void onToggleBuildExpand(b.id)}
                    style={buildToggleStyle}
                    aria-expanded={isExpanded}
                  >
                    <span style={{
                      ...buildNBadge,
                      borderColor: b.errorMessage ? C.danger : C.line,
                      color: b.errorMessage ? C.danger : C.textDim,
                    }}>
                      #{b.n}
                    </span>
                    <span style={{ color: C.text, fontSize: T.meta }}>
                      {b.triggerSource}
                      {b.prevPhase && (
                        <span style={{ color: C.textFaint, marginLeft: 6 }}>
                          (前 phase: {b.prevPhase})
                        </span>
                      )}
                    </span>
                    {b.settlementCode && (
                      <span style={{
                        ...buildMetaTag,
                        borderColor: C.line,
                        color: C.textDim,
                      }}>
                        settle={b.settlementCode}
                      </span>
                    )}
                    {b.prUrl && (
                      <a
                        href={b.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={buildPrLink}
                        onClick={(e) => e.stopPropagation()}
                      >
                        PR
                      </a>
                    )}
                    <span style={{ ...buildTimeMeta, color: C.textFaint }}>
                      {formatBuildTime(b.createdAt, b.finishedAt)}
                    </span>
                    {isLatest && (
                      <span style={{ ...buildMetaTag, color: C.accent, borderColor: C.accent }}>
                        最新
                      </span>
                    )}
                    <span style={{ ...buildMetaTag, color: isExpanded ? C.warn : C.textFaint, borderColor: isExpanded ? C.warn : C.line }}>
                      {isExpanded ? '收起' : '展开'}
                    </span>
                  </button>
                  {isExpanded && (
                    <div style={buildExpandedBoxStyle}>
                      {b.errorMessage && (
                        <div style={buildErrorInlineStyle}>
                          <strong>build.errorMessage：</strong>
                          <pre style={buildErrorPreStyle}>{b.errorMessage}</pre>
                        </div>
                      )}
                      {expandedMessagesBusy && (
                        <div style={{ color: C.textDim, fontSize: T.meta }}>正在拉该 build 的消息…</div>
                      )}
                      {expandedMessagesErr && !expandedMessagesBusy && (
                        <div style={notReadyStyle}>构建历史未就绪（{expandedMessagesErr}）</div>
                      )}
                      {expandedMessages && expandedMessages.length === 0 && (
                        <div style={{ color: C.textDim, fontSize: T.meta }}>这条 build 没有消息</div>
                      )}
                      {expandedMessages && expandedMessages.map((msg) => (
                        <div key={msg.id} style={{
                          padding: 8,
                          marginBottom: 6,
                          background: msg.role === 'user' ? 'rgba(129,140,248,0.14)' : C.surface,
                          borderRadius: R.md,
                          borderLeft: msg.role === 'user' ? `3px solid ${C.accent}` : `3px solid ${C.line}`,
                        }}>
                          <div style={{ fontSize: T.sm, color: C.textDim, marginBottom: 4 }}>
                            [{msg.seq}] {msg.role}
                            {msg.isError && (
                              <span style={{ color: C.danger, marginLeft: 6 }}>ERROR</span>
                            )}
                          </div>
                          <pre style={msgContentStyle}>{msg.content}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Plan + Changes 并列 —— 原站 docs-plans-and-diffs.md：
            "A build produces two primary artifacts for you to read: a Plan
             before any code is modified, and Changes (the diff) afterwards."

          切片范围：ConfirmPreview（与 Composer / ReusePlan 正交；这两块一律不碰） */}
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Plan 文档</h2>
        {planDocErr && <div style={notReadyStyle}>Plan 文档不可用（{planDocErr}）</div>}
        {!planDoc && !planDocErr && (
          <div style={{ color: C.textDim, fontSize: T.meta }}>暂无 Plan 文档</div>
        )}
        {planDoc && (
          <>
            <div style={{ fontSize: T.base, color: C.textDim, marginBottom: 8 }}>
              kind={planDoc.kind} · version={planDoc.version}
            </div>
            <div style={{ display: 'flex', gap: S.sm, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setPreviewDoc(planDoc)}
                style={previewBtnStyle}
              >
                预览
              </button>
            </div>
            <pre style={diffStyle}>{planText}</pre>
          </>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Changes 文档</h2>
        {changesErr && <div style={notReadyStyle}>{changesErr}</div>}
        {!changesDoc && !changesErr && <div style={{ color: C.textDim, fontSize: T.meta }}>暂无 Changes 文档</div>}
        {changesDoc && (
          <>
            <div style={{ fontSize: T.base, color: C.textDim, marginBottom: 8 }}>
              kind={changesDoc.kind} · version={changesDoc.version}
            </div>
            <div style={{ display: 'flex', gap: S.sm, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setPreviewDoc(changesDoc)}
                style={previewBtnStyle}
              >
                预览
              </button>
            </div>
            <pre style={diffStyle}>{diffText}</pre>
          </>
        )}
      </section>

      {/* 版本对比 —— 原站 docs-plans-and-diffs.md：
            "you can switch versions, click Compare with another version… to diff
             two versions against each other" / "Use the version picker to compare
             two change versions (v1 → v3)".

          数据源：ConfirmPreview 新拉的 allDocs（一个 todo 的所有 build 文档集合，
            按 createdAt desc）。同 kind 内两两对比；跨 kind 不允许（plan ↔ plan；
            changes ↔ changes）。

          没有 allDocs 或 allDocs 只有 1 份时：**不做假**——
            - 0 份：诚实占位「版本对比尚未接通（document 列表为空）」
            - 1 份：诚实占位「当前 todo 只有 1 份文档，至少需要 2 份（来自多次 rerun）」
            - 2 份及以上：真选 + 真对比。
          */}
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>版本对比</h2>
        {allDocsErr && <div style={notReadyStyle}>文档列表不可用（{allDocsErr}）</div>}
        {!allDocs && !allDocsErr && (
          <div style={{ color: C.textDim, fontSize: T.meta }}>正在拉取文档列表…</div>
        )}
        {allDocs && allDocs.length < 2 && !allDocsErr && (
          <div style={{ color: C.textDim, fontSize: T.meta }}>
            现有 {allDocs.length} 份文档 —— 至少需要 2 份（来自多次 rerun）才能对比。
          </div>
        )}
        {allDocs && allDocs.length >= 2 && (
          <>
            <div style={{ display: 'flex', gap: S.sm, alignItems: 'center', flexWrap: 'wrap', marginBottom: S.sm }}>
              <label style={{ color: C.textDim, fontSize: T.meta }}>左侧版本</label>
              <select
                value={compareLeftId ?? ''}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setCompareLeftId(v);
                  setCompareRightId((prev) => {
                    if (!v) return prev;
                    // 切左版本时如果右版本跟着失配（kind 变了）—— 同步清掉
                    const left = (allDocs ?? []).find((d) => d.id === v);
                    if (!left) return null;
                    if (!prev) return prev;
                    const right = (allDocs ?? []).find((d) => d.id === prev);
                    if (!right || right.kind !== left.kind) return null;
                    return prev;
                  });
                }}
                style={{ ...shared.input, width: 'auto' }}
              >
                <option value="">— 选择文档 —</option>
                {allDocs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.kind} v{d.version} ({new Date(d.createdAt).toISOString().slice(0, 10)})
                  </option>
                ))}
              </select>
              <label style={{ color: C.textDim, fontSize: T.meta }}>右侧版本</label>
              <select
                value={compareRightId ?? ''}
                onChange={(e) => setCompareRightId(e.target.value || null)}
                style={{ ...shared.input, width: 'auto' }}
              >
                <option value="">— 选择文档 —</option>
                {compareOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.kind} v{d.version} ({new Date(d.createdAt).toISOString().slice(0, 10)})
                  </option>
                ))}
              </select>
            </div>
            {!compareLeftDoc && (
              <div style={{ color: C.textDim, fontSize: T.meta }}>
                请选两份文档来对比。右侧可选范围跟随左侧的 kind。
              </div>
            )}
            {compareLeftDoc && (
              <>
                {/* 单独预览按钮：用户从版本对比里也能开 DocPreview，与 Plan/Changes
                  文档区共用同一个 modal。 */}
                <div style={{ display: 'flex', gap: S.sm, marginBottom: S.sm }}>
                  <button
                    type="button"
                    onClick={() => setPreviewDoc(compareLeftDoc)}
                    style={previewBtnStyle}
                    disabled={!compareLeftDoc}
                  >
                    预览左侧
                  </button>
                  <button
                    type="button"
                    onClick={() => compareRightDoc && setPreviewDoc(compareRightDoc)}
                    style={previewBtnStyle}
                    disabled={!compareRightDoc}
                  >
                    预览右侧
                  </button>
                </div>
                <div style={compareGridStyle}>
                  <div>
                    <div style={{ ...sectionTitleStyle, color: C.textDim, fontSize: T.meta, marginBottom: 4 }}>
                      左：{compareLeftDoc.kind} v{compareLeftDoc.version}
                    </div>
                    <pre style={compareBoxStyle}>{compareLeftText || '（无内容）'}</pre>
                  </div>
                  <div>
                    <div style={{ ...sectionTitleStyle, color: C.textDim, fontSize: T.meta, marginBottom: 4 }}>
                      右：{compareRightDoc ? `${compareRightDoc.kind} v${compareRightDoc.version}` : '未选择'}
                    </div>
                    <pre style={compareBoxStyle}>{compareRightDoc ? (compareRightText || '（无内容）') : '请在右侧下拉里选一份同 kind 的文档…'}</pre>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* ConfirmDialog（B1）+ DocPreview（A10）单例渲染。previewDoc 单击对话框里的
          关闭按钮触发 setPreviewDoc(null) 自动卸载。ConfirmDialog 同理。 */}
      {confirmMergeOpen && (
        <ConfirmDialog
          title="完成并合并？"
          confirmText="确认合并"
          cancelText="取消"
          defaultChecked={true}
          onConfirm={onConfirmMergeDialog}
          onCancel={() => setConfirmMergeOpen(false)}
        >
          <p style={{ margin: 0 }}>
            原站 <code style={codeInlineStyle}>docs-todos.md</code>：「a confirmation
            dialog appears first, with <strong>Merge changes</strong> checked by
            default」。
          </p>
          <p style={{ margin: '8px 0 0' }}>
            合并会把当前 build 的变更落到默认分支。复刻版当前没有接
            GitHub PR 直连，合并动作只更新 todo 状态；具体 git 合并由后端驱动。
          </p>
          <p style={{ margin: '8px 0 0', color: C.textFaint }}>
            不确定有没有冲突、是否 squash？取消，把反馈给 agent 让它先解一下。
          </p>
        </ConfirmDialog>
      )}
      {previewDoc && (
        <DocPreview
          content={(() => {
            if (previewDoc.kind === 'changes') return extractDiff(previewDoc);
            if (previewDoc.kind === 'plan') return extractPlanText(previewDoc);
            return extractDocumentText(previewDoc);
          })()}
          kind={previewDoc.kind}
          title={`${previewDoc.kind} 文档预览（v${previewDoc.version}）`}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {/* 验收清单 —— 开关在 todo.withChecklist（与 spec / tagIds 同源 —— `lib/api.ts`）。
          false / todo 未就绪时**完全不渲染**，避免空框干扰阅读。
          开关打开但接口未就绪时单独降级提示，并行于其他端点的 ready:false 语义。 */}
{todo && todo.withChecklist && (
        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>验收清单</h2>
          {!checklistReady && checklistError !== null && (
            <div style={notReadyStyle}>{checklistError}</div>
          )}
          {checklistReady && (
            <>
              {checklist !== null && checklist.length > 0 && (() => {
                const doneCount = checklist.filter((c) => c.done).length;
                return (
                  <div style={checklistProgressStyle}>
                    {doneCount} / {checklist.length} 已完成
                  </div>
                );
              })()}
              {checklist !== null && checklist.length === 0 && (
                <div style={{ color: C.textDim, fontSize: T.meta, marginBottom: 8 }}>
                  还没有验收项。下面追加第一条。
                </div>
              )}
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 12px' }}>
                {checklist?.map((it) => (
                  <li key={it.id} style={checklistRowStyle}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: checklistBusy ? 'wait' : 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={it.done}
                        disabled={checklistBusy}
                        onChange={() => void checklistToggle(it)}
                      />
                      <span style={it.done ? checklistDoneTextStyle : undefined}>
                        {it.text}
                      </span>
                    </label>
                    <button
                      type="button"
                      style={checklistDeleteBtnStyle}
                      onClick={() => void checklistDelete(it)}
                      disabled={checklistBusy}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={checklistNewText}
                  onChange={(e) => setChecklistNewText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !checklistBusy && checklistNewText.trim().length > 0) {
                      void checklistAdd();
                    }
                  }}
                  placeholder="新验收项（按 Enter 追加）"
                  style={checklistInputStyle}
                  disabled={checklistBusy}
                />
                <button
                  type="button"
                  style={checklistAddBtnStyle}
                  onClick={() => void checklistAdd()}
                  disabled={checklistBusy || checklistNewText.trim().length === 0}
                >
                  {checklistBusy ? '提交中…' : '追加'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* Composer（steering）—— 非闸门相位且非终态时的对话入口。
          闸门铁律：confirm / review 时**只**显示上面 `feedback` 修订区；
            这里 `composerVisible === false` 时整个区域都不渲染，
            没有任何按钮可以绕过主按钮推进。终态（done/failed/closed）也是
            `composerVisible === false`，相位再开得等 Reopen/Rerun。
          范围（MentionsUI 切片接管后）：结构化 chip + 五类 mention 选择器
            （@ # / ~ &）由 MentionComposer 提供；本页面只持有 busy / error
            / notice 三态与 steering 队列写路径。DropCard 通过
            `composerRef.current?.insertMention(m)` 触发 chip 插入。
          SSE 现状：消息级事件尚未接通；4s 轮询兜底，banner 在 tray 区域说清。 */}
      {composerVisible && (
        <section
          style={composerCardStyle}
          data-composer-build={composerBuildId ?? 'none'}
        >
          <h2 style={{ ...sectionTitleStyle, color: C.accent }}>对话输入（composer）</h2>
          <div style={composerHintStyle}>
            正在跑的 build：消息会进 steering 队列，agent 在合适时机投递；已结束的 build：消息会直接落到消息流。
            当前 build：<code style={composerCodeStyle}>{composerBuildId ?? '无'}</code>。
            实时推送端到端事件尚未接通，每 4 秒轮询一次增量。
          </div>
          {/*
            **MentionComposer 切片接管下方 UI** —— 文本/chip/toolbar/mention picker
            都由子组件管。父组件只透传 busy / error / notice 与 (text, mentions)→
            composerSubmit 落库路径。
            `composerRef` 是 DropCard 切片使用的 drop 桥：DropCard 在 drop
            时调 `composerRef.current?.insertMention(m)`，MentionComposer 会
            把 chip 插到当前光标位置（连续多次调用位置正确）。
          */}
          <MentionComposer
            ref={composerRef}
            buildId={composerBuildId}
            busy={composerBusy}
            error={composerError}
            notice={composerNotice}
            teamId={activeTeamId}
            onSubmit={composerSubmit}
          />
        </section>
      )}
    </main>
  );
}

// ── 内部 helper：把 Changes 文档 payload 归一化为 diff 文本 ──────

/**
 * BranchMenu 上抛 `onNote` 后, 父级 banner 5 秒后自动消的轻量包装组件。
 *
 * 为什么拆成单独组件: 这个 effect 需要 `setTimeout` + cleanup, 直接写在
 * page 组件里会污染主函数体（page 已经够长了）。独立组件的 effect 只跟
 * `note` 与 `seenAt` 关联, 父级变化就重置计时器, 拆出来后更易读。
 *
 * `seenAt` 进 deps —— BranchMenu 每次触发 onNote 都会更新 seenAt, 这里
 * 就清掉旧的 timer 重新计时。重复同一条 note 也会重新计时（这是设计选择,
 * 让用户多看一会）, 但父级 banner 已经渲染 ok 配色, 不抢视觉。
 */
function BranchNoteAutoDismiss({
  note,
  seenAt,
  onDismiss,
}: {
  note: string;
  seenAt: number;
  onDismiss: () => void;
}): null {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(t);
  }, [note, seenAt, onDismiss]);
  return null;
}

/** Run history 列里把 build.createdAt (epoch ms) 与 finishedAt 折成人话时长。
 *  finishedAt === null 时返回「started at HH:MM:SS」，否则再补一个「→ 持续了 Xs」
 *  让用户在不需要点开的情形下也能看出 build 是快是慢。
 *  入参非法时落回空串 —— 不抛、不替换成 NaN，跟项目其他文本字段同一策略。 */
function formatBuildTime(createdAt: number, finishedAt: number | null): string {
  const started = new Date(createdAt);
  if (Number.isNaN(started.getTime())) return '';
  const startedLabel = started.toISOString().slice(11, 19);
  if (finishedAt === null) return `started ${startedLabel}`;
  const end = new Date(finishedAt);
  if (Number.isNaN(end.getTime())) return `started ${startedLabel}`;
  const sec = Math.max(0, Math.round((finishedAt - createdAt) / 1000));
  return `${startedLabel} → ${sec}s`;
}

function extractDiff(doc: Document | null): string {
  if (!doc) return '';
  const payload = doc.payload as Record<string, unknown>;
  // 形态 1：{ diff: string }
  if (typeof payload['diff'] === 'string') return payload['diff'];
  // 形态 2：{ files: Array<{ path, diff }> }
  if (Array.isArray(payload['files'])) {
    const files = payload['files'] as Array<Record<string, unknown>>;
    return files.map((f) => {
      const path = typeof f['path'] === 'string' ? f['path'] : '<unknown>';
      const diff = typeof f['diff'] === 'string' ? f['diff'] : '';
      return `--- ${path}\n${diff}`;
    }).join('\n\n');
  }
  // 兜底：原样 JSON.stringify
  return JSON.stringify(payload, null, 2);
}

/**
 * 把 Plan 文档 payload 归一化成可预览的纯文本。
 * Plan 通常落 `{ plan: string }`，但 agent 实现可能给：
 *   - { body: string }     —— 兜底
 *   - { plan: { summary } } —— 简短计划（罕见）
 *   - { sections: [{title, body}] } —— 分段
 * 与 `extractDiff` 同一空串降级语义：doc 为 null 或没法抽 → 返回 ''。
 */
function extractPlanText(doc: Document | null): string {
  if (!doc) return '';
  const payload = doc.payload as Record<string, unknown>;
  if (typeof payload['plan'] === 'string') return payload['plan'];
  if (typeof payload['body'] === 'string') return payload['body'];
  if (Array.isArray(payload['sections'])) {
    const secs = payload['sections'] as Array<Record<string, unknown>>;
    return secs
      .map((s) => {
        const title = typeof s['title'] === 'string' ? s['title'] : '';
        const body = typeof s['body'] === 'string' ? s['body'] : '';
        return title ? `## ${title}\n\n${body}` : body;
      })
      .join('\n\n');
  }
  if (typeof payload['plan'] === 'object' && payload['plan'] !== null) {
    const p = payload['plan'] as Record<string, unknown>;
    if (typeof p['summary'] === 'string') return p['summary'];
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * 给任意 Document 抽一个可对比的"纯文本" —— 版本对比模式用。
 * 用 `extractDiff` / `extractPlanText` 按 kind 派过去；其它 kind 走通用 JSON。
 */
function extractDocumentText(doc: Document | null): string {
  if (!doc) return '';
  if (doc.kind === 'changes') return extractDiff(doc);
  if (doc.kind === 'plan') return extractPlanText(doc);
  // question / confirm / input / review：用 payload 全文
  const payload = doc.payload as Record<string, unknown>;
  if (typeof payload['text'] === 'string') return payload['text'];
  if (typeof payload['question'] === 'string') return payload['question'];
  return JSON.stringify(payload, null, 2);
}

// ── 样式 ─────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  ...shared.card,
  marginTop: 16,
};

const notReadyStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.10)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.lg,
  padding: S.md,
  fontSize: T.meta,
  color: C.text,
};

const sectionTitleStyle: CSSProperties = {
  margin: '0 0 12px',
  fontSize: T.body,
  fontWeight: 600,
  color: C.text,
};

const specStyle: CSSProperties = {
  margin: '12px 0 0',
  padding: S.md,
  background: C.code,
  color: C.text,
  borderRadius: R.md,
  fontSize: T.meta,
  fontFamily: F.mono,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const msgContentStyle: CSSProperties = {
  margin: 0,
  fontSize: T.base,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: F.mono,
  color: C.text,
};

const diffStyle: CSSProperties = {
  margin: 0,
  padding: S.md,
  background: C.code,
  color: C.text,
  borderRadius: R.md,
  fontSize: T.base,
  lineHeight: 1.5,
  whiteSpace: 'pre',
  overflowX: 'auto',
  fontFamily: F.mono,
};

// ── ConfirmPreview 切片样式 ────────────────────────────────────

/** 「预览」按钮 —— 走 ghostBtn 谱系但小一号，紧贴文档区。 */
const previewBtnStyle: CSSProperties = {
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  padding: `${S.xs}px ${S.sm}px`,
  fontSize: T.meta,
  fontFamily: F.sans,
  cursor: 'pointer',
};

/** 「完成并合并」dialog 里的内联 code 配色 —— 与 design-tokens 里 inline code 不冲突。 */
const codeInlineStyle: CSSProperties = {
  background: C.code,
  padding: '0 4px',
  borderRadius: R.sm,
  fontFamily: F.mono,
  fontSize: T.meta,
  color: C.text,
};

/** 版本对比左右两栏：用 CSS Grid 等分，移动端友好不用媒体查询，由 1fr 1fr
 *  自适应压缩。最大高度 480，超过出滚动条 —— 避免大 diff 把页面撑爆。 */
const compareGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: S.sm,
};

/** 版本对比单格：跟 diffStyle 同一谱系，但 maxHeight 加滚动。 */
const compareBoxStyle: CSSProperties = {
  ...diffStyle,
  maxHeight: 480,
  overflow: 'auto',
  margin: 0,
};

// ── 闸门区样式 ──────────────────────────────────────────────────

/** 闸门卡片：双线 amber 边 + 浅 amber 底。 */
const gateCardStyle: CSSProperties = {
  ...shared.card,
  marginTop: 16,
  border: `2px solid ${C.warn}`,
  background: 'rgba(251,191,36,0.10)',
};

/**
 * 详情页右上角主按钮（契约差异 #14）—— 走 shared.primaryBtn, 体型与既有
 * 闸门按钮一致, 但放到 header 右上角而不是中部闸门区。
 *
 * **为什么不复用一个 stylesheet 行**：右上的主按钮 + 中部 confirm 闸门
 * 渲染的逻辑由 `mainGateAction()` 控制, 不再像以前那样按 phase 派三个
 * 样式 (`approveBtnStyle` / `completeBtnStyle` / `mergeBtnStyle`)。保留
 * 单独 constant 是为了 (a) 让 PR review 时容易看清这块视觉权重;
 * (b) 后续若需要按 phase 分主按钮配色 (例如 done 阶段的「重开」用 warn
 * 而不是 accent) 在一处改就行。
 */
const mainActionBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
  padding: '8px 14px',
  fontSize: T.meta,
};

/**
 * 主按钮禁用态 —— 不允许与 enabled 态混淆。配色用 textGhost + line 描边,
 * 鼠标 hover 不变色（`cursor: not-allowed` + opacity 0.7 双保险）。
 *
 * 与原站「运行中会置灰」语义对应：禁用文案照实反映阶段（规划中/实现中/
 * 复核中/等待机器/尚未开始）—— 按钮完全不停留在「下一步」, 也不假装可用。
 */
const mainActionBtnDisabledStyle: CSSProperties = {
  ...shared.primaryBtn,
  padding: '8px 14px',
  fontSize: T.meta,
  background: 'transparent',
  color: C.textGhost,
  border: `1px solid ${C.line}`,
  cursor: 'not-allowed',
  opacity: 0.7,
};

/**
 * BranchMenu 触发按钮在「无 build」时的禁用态 —— 沿用主按钮禁用态视觉,
 * 不让用户对没意义的按钮产生期待。Title 解释原因（契约 §5.3「不许静默」）。
 */
const triggerDisabledBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
  padding: '4px 10px',
  fontSize: T.meta,
  opacity: 0.7,
  cursor: 'not-allowed',
};

/**
 * 「完成并合并」次按钮（review only, 中部闸门区） —— 走 ghost + warn
 * 描边, 不抢右上角主按钮权重, 但视觉上仍能与 confirm 相位的「无次按钮」
 * 区分开。原站没有这块次按钮（合并确认直接弹 ConfirmDialog）, 但合并
 * 走 ConfirmDialog 是契约硬约束, 中部保留一个入口才能让用户在闸门区
 * 「先看完反馈再决定合并」的语义闭环 —— 不是新功能, 是 B1 闸门中线。
 */
const mergeSecondaryBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
  padding: '6px 14px',
  fontSize: T.meta,
  borderColor: C.warn,
  color: C.warn,
};

const feedbackBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
  padding: '6px 12px',
  fontSize: T.base,
};

const gateInputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  fontSize: T.meta,
  background: C.bg,
  color: C.text,
  boxSizing: 'border-box',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: T.base,
  fontWeight: 600,
  marginBottom: 4,
  color: C.text,
};

const gateRuleStyle: CSSProperties = {
  margin: '12px 0 0',
  padding: 10,
  background: C.surface,
  border: `1px dashed ${C.warn}`,
  borderRadius: R.md,
  fontSize: T.base,
  color: C.text,
  lineHeight: 1.5,
};

const gateErrorStyle: CSSProperties = {
  ...shared.errorBox,
  marginTop: S.md,
  fontSize: T.meta,
};

const gateNoticeStyle: CSSProperties = {
  ...shared.noticeBox,
  marginTop: S.md,
  fontSize: T.meta,
};

// ── 验收清单样式 ──────────────────────────────────────────────

const checklistProgressStyle: CSSProperties = {
  fontSize: T.base,
  color: C.textDim,
  marginBottom: 8,
};

const checklistRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  fontSize: T.meta,
};

const checklistDoneTextStyle: CSSProperties = {
  textDecoration: 'line-through',
  color: C.textFaint,
};

const checklistDeleteBtnStyle: CSSProperties = {
  ...shared.dangerBtn,
  padding: '3px 8px',
  fontSize: T.sm,
};

const checklistInputStyle: CSSProperties = {
  ...shared.input,
  flex: 1,
  fontSize: T.meta,
};

const checklistAddBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
  padding: '6px 14px',
  fontSize: T.meta,
};

// ── 终态横幅样式 ──────────────────────────────────────────────

/** 终态卡片：amber 描边 + 低强度 amber 底，跟闸门卡片视觉一致但不抢眼。 */
const terminalCardStyle: CSSProperties = {
  ...shared.card,
  marginTop: 16,
  border: `1px solid ${C.warn}`,
  background: 'rgba(251,191,36,0.06)',
};

/** Rerun 主按钮：用 accent（indigo）色，强调「主动操作」。 */
const rerunBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
  padding: '6px 14px',
  fontSize: T.meta,
};

/** Reopen 次按钮：ghost；与 Rerun 并排时不抢权重。 */
const reopenBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
  padding: '6px 14px',
  fontSize: T.meta,
  borderColor: C.warn,
  color: C.warn,
};

/**
 * Continue 按钮：accent primary —— 与 Rerun 同视觉权重。原站语义「在同一
 * build 上重试」是**主动操作**，不是次要 ghost。失败刷字字色 primaryBtn
 * 的 accent 与 Reopen 的 warn 在视觉上分开，「需要人决策」（warn）和
 * 「继续当前动作」（accent）的语义不会混。
 */
const continueBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
  padding: '6px 14px',
  fontSize: T.meta,
};

/**
 * Reuse plan 按钮：ghost + line 色（**不**碰 `C.warn`）。原因：
 *   - `C.warn` 在产品里 = 闸门 / 需要人决策的语义；Reuse plan 不是闸门，
 *     用 warn 会误导用户把它当 reviewer 路径
 *   - line 色 = 中性、与「复用上次产出的文档」语义一致（同 reopen 都是
 *     ghost，但 reopen 是把 todo 拉回闸门——这个动作**有** warn 含义，遵
 *     沿用现成；reopen 行为本身抢人注意力也说得通）
 *   - color 走 `C.text` 而不是 `C.warn`，保持中性
 */
const reusePlanBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
  padding: '6px 14px',
  fontSize: T.meta,
  borderColor: C.line,
  color: C.text,
};

const terminalErrorStyle: CSSProperties = {
  ...shared.errorBox,
  marginTop: S.md,
  fontSize: T.meta,
};

/**
 * Continue 走通后的中性灰提示框 —— 与 `terminalErrorStyle`（红）区分。
 * 这是「已入库存盘点」不是成功也不是失败：build 行被重置、新 step 入队是
 * 事实，后续是否推进是 daemon 的事。这里给一个独立的中性样式以免与 error
 * 红框混在一起造成「成功了为什么报错」的反向困惑。
 */
const terminalContinueNoticeStyle: CSSProperties = {
  marginTop: S.md,
  padding: '8px 10px',
  background: C.code,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  fontSize: T.meta,
  color: C.textDim,
  lineHeight: 1.5,
};

// ── Run history 样式 ───────────────────────────────────────────

const buildRowStyle: CSSProperties = {
  listStyle: 'none',
  borderBottom: `1px solid ${C.line}`,
  padding: '6px 0',
};

const buildToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  background: 'transparent',
  border: 'none',
  padding: '6px 4px',
  borderRadius: R.md,
  cursor: 'pointer',
  fontFamily: F.sans,
  textAlign: 'left',
};

const buildNBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 8px',
  borderRadius: R.pill,
  fontSize: T.base,
  background: C.surface,
  border: `1px solid ${C.line}`,
};

const buildMetaTag: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 8px',
  borderRadius: R.pill,
  fontSize: T.base,
  background: 'transparent',
  border: `1px solid ${C.line}`,
};

const buildTimeMeta: CSSProperties = {
  fontSize: T.sm,
  fontFamily: F.mono,
  marginLeft: 'auto',
};

const buildPrLink: CSSProperties = {
  fontSize: T.base,
  color: C.accent,
  textDecoration: 'none',
  padding: '1px 8px',
  borderRadius: R.pill,
  border: `1px solid ${C.accent}`,
};

const buildExpandedBoxStyle: CSSProperties = {
  marginTop: 6,
  padding: 8,
  background: C.code,
  borderRadius: R.md,
};

const buildErrorInlineStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.text,
  marginBottom: 8,
};

const buildErrorPreStyle: CSSProperties = {
  margin: '4px 0 0',
  padding: 6,
  background: 'rgba(248,113,113,0.12)',
  border: `1px solid ${C.danger}`,
  borderRadius: R.sm,
  fontSize: T.base,
  fontFamily: F.mono,
  color: C.text,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

// ── Composer / Steering tray 样式 ─────────────────────────────────
// 用 indigo accent 描边，跟闸门 amber 在视觉上分开：闸门 = 等待 reviewer 决断
// composer = 与正在跑的 agent 对话。两者不应该用同一种边框，否则闸门铁律会让
// 用户混着按（错按到 composer 把消息当反馈 agent 收到 → 与产品意图相反）。

const composerCardStyle: CSSProperties = {
  ...shared.card,
  marginTop: 16,
  border: `1px solid ${C.accent}`,
  background: 'rgba(129,140,248,0.06)',
};

const composerHintStyle: CSSProperties = {
  fontSize: T.sm,
  color: C.textDim,
  marginBottom: 8,
  lineHeight: 1.5,
};

const composerCodeStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  padding: '1px 4px',
  borderRadius: R.sm,
  background: C.code,
};

/**
 * 闸门区快捷键提示里的内联 code —— 与 composerCodeStyle 同形, 但多一
 * 点点外边距让两个 code 之间有视觉间隔。
 */
const shortcutHintCodeStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  padding: '1px 6px',
  margin: '0 4px',
  borderRadius: R.sm,
  background: C.code,
  color: C.text,
};

/** Steering tray：amber 描边（与闸门同系但形状不同，不会混）。 */
const steeringTrayStyle: CSSProperties = {
  ...shared.card,
  marginTop: 16,
  border: `1px solid ${C.warn}`,
  background: 'rgba(251,191,36,0.06)',
};

const steeringItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  marginBottom: 4,
  background: C.surface,
  borderRadius: R.md,
  borderLeft: `3px solid ${C.warn}`,
};

const steeringPosChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 28,
  padding: '1px 6px',
  borderRadius: R.pill,
  background: 'rgba(251,191,36,0.18)',
  color: C.warn,
  fontFamily: F.mono,
  fontSize: T.base,
};

const steeringTextStyle: CSSProperties = {
  flex: 1,
  fontSize: T.meta,
  color: C.text,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const steeringStatusPill: CSSProperties = {
  fontSize: T.sm,
  fontFamily: F.mono,
  color: C.textDim,
};

const steeringEditBtn: CSSProperties = {
  ...shared.ghostBtn,
  padding: '3px 8px',
  fontSize: T.sm,
};

const steeringRetractBtn: CSSProperties = {
  ...shared.dangerBtn,
  padding: '3px 8px',
  fontSize: T.sm,
};

// ── Rewind / Restore 切片样式 ─────────────────────────────

/** Restore 主按钮：accent primary —— 与 Continue 同视觉权重，「主动操作」语义。 */
const restoreBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
  padding: '6px 14px',
  fontSize: T.meta,
};

/** Restore 输入框 —— 与 gateInputStyle 同系，但不带 warn 描边（它不是闸门）。 */
const restoreInputStyle: CSSProperties = {
  ...shared.input,
  fontFamily: F.mono,
  fontSize: T.meta,
  flex: 1,
};

/** Restore label —— 上下铺排，跨字段共享 labelStyle 视觉。 */
const restoreLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: T.base,
  color: C.textDim,
  fontWeight: 600,
};

/** 行内 code（session id 显示）—— 与 composerCodeStyle 同形。 */
const restoreCodeStyle: CSSProperties = {
  background: C.code,
  padding: '0 4px',
  borderRadius: R.sm,
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.text,
};

/** Restore 错误框 —— 与 terminalErrorStyle 同形（红）。 */
const restoreErrorStyle: CSSProperties = {
  ...shared.errorBox,
  marginTop: S.md,
  fontSize: T.meta,
};

/** Restore 成功提示 —— 与 terminalContinueNoticeStyle 同形（中性灰）。
 *  不是成功也不是失败：库内 reset 是事实，daemon 真实回滚是空白。 */
const restoreNoticeStyle: CSSProperties = {
  ...shared.noticeBox,
  marginTop: S.md,
  fontSize: T.meta,
};
