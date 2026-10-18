'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { C, F, L, R, T, shared } from '@/lib/design-tokens';
import {
  type Todo,
  type TodoPhase,
  type SseFrame,
  type Document,
  fetchJson,
  subscribe,
  type MentionRef,
} from '@/lib/api';
import { SplitPane } from '@/components/SplitPane';
import { ChiefConversationCard } from '@/components/ChiefConversationCard';
import { useWorkspaceLayout } from '@/lib/workspace-layout';
import BoardHeader from '@/components/board/BoardHeader';
import BoardFilterPanel from '@/components/board/BoardFilterPanel';
import KanbanGuide from '@/components/board/KanbanGuide';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import Card, {
  type MainActionKind,
  resolveMainAction,
} from '@/components/board/Card';
import CardMenu, { type CardMenuHandle } from '@/components/board/CardMenu';
import type { BranchMachine } from '@/components/board/BranchMenu';
import {
  type BoardFilters,
  type BoardFilterCounts,
  type CreatorFilter,
  type StageFilter,
  filterTodos,
  loadFilters,
  saveFilters,
} from '@/components/board/filter-state';

/**
 * 首页 —— Workspace 布局（对话 + 看板）。
 *
 * **本切片（BoardCards）的范围**（契约 2026-10-18 冻结）：
 *  - 中文 4 列 + 空列文案 + Done 列「最近 7 天」副标题
 *  - 卡片右下角主按钮（契约 §3.7 冻结映射）
 *  - 卡片右键菜单（契约 §3.8 冻结顺序）
 *  - 多卡拖拽 + 部分失败回滚
 *  - 拖回「待开始」改走 `/reset`（契约 §3.3）
 *  - 筛选接线（契约 §3.6）
 *  - BoardHeader / KanbanGuide / ShortcutsDialog 接线
 *
 * **非本切片**（不要改）：ChiefConversationCard、filter-state、BoardFilterPanel、
 * BoardHeader、KanbanGuide、ShortcutsDialog、BranchMenu（TodoDetail 拥有）。
 */

interface WorkspaceColumn {
  key: 'backlog' | 'inProgress' | 'needsYou' | 'done';
  /** 列标题（中文四个字，原站实测）。 */
  label: string;
  /** drop 时落到哪个相位（服务端 move 端点的 target phase） */
  entryPhase: TodoPhase;
  /** 此列包含的所有相位 */
  phases: TodoPhase[];
  isGate: boolean;
  /**
   * 空列占位文案（契约 §1.1 实测）。
   * dragging 时由渲染逻辑替换成「松开放到这里」。
   */
  emptyHint: string;
  /** 标题下的副标题（仅 Done 列显示「最近 7 天」）。 */
  subtitle?: string;
  /**
   * 标题 `title` 属性 —— Done 列写明「按 updatedAt 近似 7 天」的诚实理由。
   * 可见文案按原站实测（不留 caveat），但在 hover 时说清近似性。
   */
  titleHint?: string;
}

/** dragstart 时 dataTransfer 的 MIME —— 复用时按这个字符串取值 */
const TODO_DRAG_MIME = 'application/x-tds-todo-ids';
interface TodoDragPayload {
  ids: string[];
}

const WORKSPACE_COLUMNS: WorkspaceColumn[] = [
  {
    key: 'backlog',
    label: '待开始',
    entryPhase: 'todo',
    phases: ['todo', 'queued'],
    isGate: false,
    emptyHint: '没有等待开始的任务',
    // 把「拖回待开始 = 重置」的语义说在 title 上 —— hover 才看得到，
    // 不在可见文案里污染列标题。
    titleHint: '已开始的卡片拖到本列会重置任务（中断构建并清空对话、方案与改动记录）',
  },
  {
    key: 'inProgress',
    label: '执行中',
    entryPhase: 'planning',
    phases: ['planning', 'implement', 'reviewing'],
    isGate: false,
    emptyHint: '没有执行中的任务',
  },
  {
    key: 'needsYou',
    label: '待你处理',
    entryPhase: 'confirm',
    phases: ['confirm', 'review', 'failed'],
    isGate: true,
    emptyHint: '没有等待你处理的任务',
  },
  {
    key: 'done',
    label: '已完成',
    entryPhase: 'done',
    phases: ['done'],
    isGate: false,
    emptyHint: '没有已完成的任务',
    subtitle: '最近 7 天',
    // 可见文案按原站，不说「近似」；把 caveat 放到 hover 上。
    titleHint: '按 updatedAt 近似最近 7 天（非 build.finishedAt）',
  },
];

const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── 当前主按钮文案（契约 §3.7 冻结） ────────────────────────────
// `resolveMainAction` 已从 Card.tsx 导入；page 用同一份映射（菜单的
// 「下一步操作」菜单项要拿同一个 label / kind）—— 避免卡片按钮和菜单项文案漂移。

export default function HomePage(): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // ── 默认 topic ─────────────────────────────────────────────────
  const [defaultTopicId, setDefaultTopicId] = useState<string | null>(null);
  const [topicListLoading, setTopicListLoading] = useState<boolean>(false);

  // ── 当前成员 id（来自 /api/user/context 的 teams[0].memberId） ───────
  //
  // ⚠️ 这里存的是 **member id** 不是 user id：`todo.ownerMemberId` 指向
  // `member` 表，创建者筛选要比的就是它。`/api/user/context` 同时返回
  // `data.userId`（user 表）与 `data.teams[0].memberId`（member 表）——
  // 用错会导致「我创建的」恒 0 而界面上看不出任何异常。
  const [currentMemberId, setCurrentMemberId] = useState<string | null>(null);

  // ── 机器列表（BranchMenu 卡片右上角要用） ──────────────────────
  // 拉一次即可，所有卡共享一份。空数组也持久（避免重复请求）。
  const [machines, setMachines] = useState<BranchMachine[]>([]);

  // ── 筛选（契约 §3.6） ─────────────────────────────────────────
  // 初始值从 localStorage 读；保存用 saveFilters。BoardHeader 是受控面板。
  const [filters, setFilters] = useState<BoardFilters>(() => loadFilters());
  const [filterOpen, setFilterOpen] = useState(false);
  // 持久化副作用：filters 变化时写 localStorage（与现有 workspace-layout 同源语义）。
  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  // ── 引导 / 快捷键总面板 ────────────────────────────────────────
  const [guideOpen, setGuideOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // ── awaiting-reply 缓存（todoId → 是否有未答 question） ────────
  // 拉一次文档列表，构建 Map 给每张卡判定「下一步 = 回复」。
  // 拉不到就当全部 false —— 卡片按钮降级为「按 phase 决定」，不假绿。
  const [awaitingMap, setAwaitingMap] = useState<Map<string, boolean>>(
    () => new Map(),
  );

  // ── 主按钮请求中：todoId 集合（用于禁用与文案「…中」） ─────────
  const [pendingMain, setPendingMain] = useState<Set<string>>(
    () => new Set(),
  );

  // ── 删除二次确认：保留最小状态；ConfirmDialog 的开关交给 CardMenu 控制。
  // 这是一个全局回执：被删的 id 给父组件处理。
  const [cardMenuCtx, setCardMenuCtx] = useState<{ id: string } | null>(null);
  const cardMenuRef = useRef<CardMenuHandle | null>(null);

  // ── 首次拉 todos ──────────────────────────────────────────────
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const r = await fetchJson<Todo[]>('/todos');
      if (ac.signal.aborted) return;
      if (r.ok) {
        setTodos(r.data);
      } else if (r.status === 401) {
        window.location.href = '/login?next=/';
        return;
      } else if (r.status === 404) {
        setTodos(null);
        setError('数据未就绪：后端尚未实现 /api/todos 业务端点');
      } else {
        setTodos([]);
        setError(`后端不可达 (${r.status}: ${r.reason})`);
      }
    })();
    return () => ac.abort();
  }, []);

  // ── 拉 user context（拿 userId + teamId + memberId + 默认 topic） ──
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      // 默认 topic
      setTopicListLoading(true);
      try {
        const ctxRes = await fetch('/api/user/context', {
          cache: 'no-store',
          signal: ac.signal,
        });
        if (!ctxRes.ok) return;
        // **真实字段名**：响应是 BFF 的 `{ready, data}` 信封；data 是上游
        // 的 UserContext：{ userId, email, teams:[{teamId, memberId, ...}], agents }。
        //
        // `data.userId` 是 **user 表**的主键；`data.teams[0].memberId` 才是
        // **member 表**的主键。创建者筛选要比的是后者（todo.ownerMemberId
        // 指向 member），两者混用会让「我创建的」静默恒 0。
        const ctxBody = (await ctxRes.json().catch(() => null)) as
          | {
              ready?: boolean;
              data?: {
                userId?: string;
                teams?: Array<{ teamId: string; memberId: string }>;
              };
              reason?: string;
            }
          | null;
        if (!ctxBody?.ready || !ctxBody.data) return;
        const data = ctxBody.data;

        const team = data.teams?.[0];
        if (!team) return;
        // teams[0] 是当前选中团队 —— 换团队后 memberId 也要跟着变，所以
        // 放在 team 判空之后设置，而不是从 data.userId 取。
        if (typeof team.memberId === 'string') setCurrentMemberId(team.memberId);

        // 默认 topic：拉到 topics 后取最近一个
        const r = await fetch(
          `/api/teams/${encodeURIComponent(team.teamId)}/chief/threads`,
          { cache: 'no-store', signal: ac.signal },
        );
        const body = (await r.json().catch(() => null)) as
          | {
              ready?: boolean;
              data?: Array<{
                id: string;
                lastTurnAt: number | null;
                updatedAt: number;
                createdAt: number;
              }>;
              reason?: string;
            }
          | null;
        if (!body?.ready || !body.data) return;
        const sorted = [...body.data].sort((a, b) => {
          const at = a.lastTurnAt ?? a.updatedAt ?? a.createdAt;
          const bt = b.lastTurnAt ?? b.updatedAt ?? b.createdAt;
          return bt - at;
        });
        const first = sorted[0];
        if (first) setDefaultTopicId(first.id);

        // 拉机器列表（BranchMenu 卡片上用）
        const mRes = await fetch(
          `/api/teams/${encodeURIComponent(team.teamId)}/machines`,
          { cache: 'no-store', signal: ac.signal },
        );
        const mBody = (await mRes.json().catch(() => null)) as
          | { ready?: boolean; data?: unknown; reason?: string }
          | null;
        // `/api/machines` 真实字段是 `name`；BranchMenu 要求 `displayName`，
        // 所以这里显式映射（BranchMenu 注释也写了这条契约）。
        if (mBody?.ready && mBody.data) {
          const list = Array.isArray(mBody.data) ? mBody.data : [];
          const mapped: BranchMachine[] = list
            .map((m): BranchMachine | null => {
              if (m === null || typeof m !== 'object') return null;
              const o = m as Record<string, unknown>;
              const id = o['id'];
              const isOnline = o['isOnline'];
              const workspacesDir = o['workspacesDir'];
              if (typeof id !== 'string') return null;
              return {
                id,
                displayName:
                  typeof o['displayName'] === 'string'
                    ? (o['displayName'] as string)
                    : typeof o['name'] === 'string'
                    ? (o['name'] as string)
                    : id,
                isOnline: isOnline === true,
                workspacesDir:
                  typeof workspacesDir === 'string' ? workspacesDir : null,
              };
            })
            .filter((x): x is BranchMachine => x !== null);
          setMachines(mapped);
        }
      } catch {
        // 静默吃掉 —— 看板可以工作，只是筛选 'mine' 退化为「owner 非空」。
      } finally {
        setTopicListLoading(false);
      }
    })();
    return () => ac.abort();
  }, []);

  // ── 订阅 team 级 SSE ──────────────────────────────────────────
  const teamId = todos?.[0]?.teamId ?? null;
  useEffect(() => {
    if (!teamId) return;
    const unsub = subscribe(`team:${teamId}`, (frame: SseFrame) => {
      if (frame.type === 'ping') return;
      void fetchJson<Todo[]>('/todos').then((r) => {
        if (r.ok) setTodos(r.data);
      });
    });
    setConnected(true);
    return unsub;
  }, [teamId]);

  // ── 拉一次 awaiting-reply 缓存（每次 todos 刷新重建） ──────────
  // 每个 todo 单独打一次 documents 接口成本太高；改成 todos 列表里有
  // active phase 的 todo 集中拉一次，按 question + 未答判定。
  useEffect(() => {
    if (!todos || todos.length === 0) {
      setAwaitingMap(new Map());
      return;
    }
    const ac = new AbortController();
    void (async () => {
      const next = new Map<string, boolean>();
      // 并发拉；上限 8 防雪崩。active phase 的 todo 才需要 awaiting 信息，
      // 其他（done/closed）按钮不会变，所以跳过。
      const active = todos.filter(
        (t) => t.phase !== 'done' && t.phase !== 'closed',
      );
      const queue = active.slice();
      const CONCURRENCY = 8;
      const workers = Array.from({ length: CONCURRENCY }).map(async () => {
        while (queue.length > 0 && !ac.signal.aborted) {
          const t = queue.shift();
          if (!t) break;
          try {
            const res = await fetch(
              `/api/todos/${encodeURIComponent(t.id)}/documents`,
              { cache: 'no-store', signal: ac.signal },
            );
            if (!res.ok) continue;
            const body = (await res.json().catch(() => null)) as
              | { ready?: boolean; data?: Document[] }
              | null;
            if (!body?.ready || !body.data) continue;
            // 未答的 question：最近一条 question 文档之后没有同 build 的
            // input/confirm 文档。我们用更简单的近似：只要存在任何 question，
            // 且没有 confirm 文档覆盖（按 createdAt desc 顺序，第一个出现
            // 的 question 后没有 input/confirm），就视作未答。
            const docs = body.data;
            const hasUnanswered = docs.some(
              (d) =>
                d.kind === 'question' &&
                // 严格说需要 "question 之后无 input/confirm"。
                // 这里取最近一条 question 的 createdAt 作近似判定：
                !docs.some(
                  (other) =>
                    (other.kind === 'input' ||
                      other.kind === 'confirm') &&
                    other.createdAt > d.createdAt,
                ),
            );
            if (hasUnanswered) next.set(t.id, true);
          } catch {
            // 拉失败：跳过这张 —— 卡片按钮降级为按 phase 决定
          }
        }
      });
      await Promise.allSettled(workers);
      if (!ac.signal.aborted) setAwaitingMap(next);
    })();
    return () => ac.abort();
  }, [todos]);

  // ── 分组（含 7 天窗口） ───────────────────────────────────────
  const byColumn = useMemo(() => {
    const empty: Record<WorkspaceColumn['key'], Todo[]> = {
      backlog: [],
      inProgress: [],
      needsYou: [],
      done: [],
    };
    if (!todos) return empty;
    const cutoff = Date.now() - DONE_WINDOW_MS;
    for (const t of todos) {
      if (t.phase === 'done') {
        if (t.updatedAt >= cutoff) empty.done.push(t);
        continue;
      }
      for (const col of WORKSPACE_COLUMNS) {
        if (col.key === 'done') continue;
        if (col.phases.includes(t.phase)) {
          empty[col.key].push(t);
          break;
        }
      }
    }
    return empty;
  }, [todos]);

  // ── 应用筛选（在分列之后、分列之前全局） ──────────────────────
  // **筛选口径**：原站是「对所有列生效」（契约 §1.3）。我们直接在全局
  // 过滤 todo 列表，再走 byColumn 分组 —— 与原站语义一致。
  // currentMemberId 为 null 时创建者筛选**不生效**（filter-state 里返回 true），
  // 阶段与项目筛选照常工作 —— 不会因为缺身份就把整个看板筛空。
  const filteredByColumn = useMemo(() => {
    if (!todos) return byColumn;
    const filtered = filterTodos(todos, filters, currentMemberId);
    const empty: Record<WorkspaceColumn['key'], Todo[]> = {
      backlog: [],
      inProgress: [],
      needsYou: [],
      done: [],
    };
    const cutoff = Date.now() - DONE_WINDOW_MS;
    for (const t of filtered) {
      if (t.phase === 'done') {
        if (t.updatedAt >= cutoff) empty.done.push(t);
        continue;
      }
      for (const col of WORKSPACE_COLUMNS) {
        if (col.key === 'done') continue;
        if (col.phases.includes(t.phase)) {
          empty[col.key].push(t);
          break;
        }
      }
    }
    return empty;
  }, [todos, filters, currentMemberId, byColumn]);

  // ── 计数快照（BoardHeader 实时显示） ──────────────────────────
  // **全局计数**（原站语义：契约 §1.3 "我创建的 0 / 总管或 Agent 7 / 其他 0"）——
  // 计数基于未筛选的全部 todos，不是筛选后的。
  //
  // ⚠️ 这里必须用 `currentMemberId` 而不是 `currentUserId`：`todo.ownerMemberId`
  // 存的是 **member id**（schema 铁律「恒为人类成员」，指向 `member.id`），
  // 而 `/api/user/context` 的 `data.userId` 是 **user id**。两个命名空间不同的
  // 字符串比较**永远不相等** —— 早先拿 userId 去比会得到「我创建的恒 0、
  // 其他成员创建的吃掉全部」的结果，而且界面上完全看不出错在哪。
  // 正确的可比字段是 `data.teams[0].memberId`。
  const counts = useMemo<BoardFilterCounts>(() => {
    const list = todos ?? [];
    const creator: Record<CreatorFilter, number> = {
      mine: 0,
      chiefOrAgent: 0,
      others: 0,
    };
    const stage: Record<Exclude<StageFilter, 'all'>, number> = {
      planning: 0,
      executing: 0,
    };
    const projectMap = new Map<string, { id: string; name: string; total: number }>();
    for (const t of list) {
      // creator：与 matchesCreatorFilter 同源（含 currentMemberId 为 null 时
      // **不计入任何一项** —— 那是「无法判定」而不是「属于别人」）。
      if (t.createdByType === 'chief' || t.createdByType === 'agent') {
        creator.chiefOrAgent++;
      } else if (currentMemberId !== null) {
        if (t.ownerMemberId === currentMemberId) creator.mine++;
        else creator.others++;
      }
      // stage：只算执行中/待你处理两列的 phase
      const col = colKeyFor(t.phase);
      if (col === 'inProgress' || col === 'needsYou') {
        if (phaseBucketFor(t.phase) === 'planning') stage.planning++;
        else stage.executing++;
      }
      // project
      const existing = projectMap.get(t.projectId);
      if (existing) existing.total++;
      else projectMap.set(t.projectId, { id: t.projectId, name: t.projectName ?? '', total: 1 });
    }
    return { creator, stage, projects: Array.from(projectMap.values()) };
  }, [todos, currentMemberId]);

  // ── 拖拽状态 ──────────────────────────────────────────────────
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<WorkspaceColumn['key'] | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // 多选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // todos 镜像：避免 useCallback 闭包捕到过期 todos
  const todosRef = useRef<Todo[] | null>(null);
  useEffect(() => {
    todosRef.current = todos;
  }, [todos]);

  // ── 多选 / 点击 ───────────────────────────────────────────────
  const handleCardClick = useCallback(
    // 卡片根是 div（Card.tsx 为了在内部挂下载按钮放弃了 <a>），事件类型随之
    // 是 HTMLDivElement —— 与 Card.tsx 的 props 声明一致。
    (e: ReactMouseEvent<HTMLDivElement>, todoId: string): void => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(todoId)) next.delete(todoId);
          else next.add(todoId);
          return next;
        });
      } else if (selectedIds.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
      }
    },
    [selectedIds.size, clearSelection],
  );

  // ── 拖卡到输入框的回执（保留既有语义） ────────────────────────
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [dropNoteKind, setDropNoteKind] = useState<'ok' | 'warn'>('ok');

  function buildTodoMentionRefs(ids: string[]): {
    refs: MentionRef[];
    missing: string[];
  } {
    const list = todosRef.current ?? [];
    const refs: MentionRef[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const t = list.find((x) => x.id === id);
      if (!t) {
        missing.push(id);
        continue;
      }
      refs.push({
        kind: 'todo',
        refId: t.id,
        label: `#${t.seqNum} ${t.title}`,
        prefix: '#',
      });
    }
    return { refs, missing };
  }

  const handleDropTodoReferences = useCallback(
    (initialRefs: MentionRef[]): void => {
      const ids = initialRefs.map((r) => r.refId);
      const { refs, missing } = buildTodoMentionRefs(ids);
      if (refs.length === 0 && missing.length > 0) {
        setDropNote(
          `已 drop ${initialRefs.length} 张卡，但当前看板数据未包含这 ${missing.length} 个 id（数据可能正在刷新）。`,
        );
        setDropNoteKind('warn');
        return;
      }
      if (missing.length > 0) {
        const preview =
          missing.slice(0, 3).join(', ') +
          (missing.length > 3 ? ` 等 ${missing.length} 个` : '');
        setDropNote(
          `已 drop ${initialRefs.length} 张卡：${refs.length} 张已查到并填好 label/seqNum，${missing.length} 张在看板里查不到（id：${preview}）。真实集成后，这 ${refs.length} 张会以 chip 形式出现在输入框。`,
        );
        setDropNoteKind('warn');
      } else {
        setDropNote(
          refs.length === 1
            ? '已 drop 1 张卡（label 已用 todo.title/seqNum 填好）。首页 Chief 对话不插 chip，要发 #chip 请到 todo 详情页。'
            : `已 drop ${refs.length} 张卡（label 已用 todo.title/seqNum 填好）。首页 Chief 对话不插 chip，要发 #chip 请到 todo 详情页。`,
        );
        setDropNoteKind('ok');
      }
    },
    [],
  );

  // ── dragstart：把选中 ids 写进 dataTransfer（MIME 同步给输入框 drop） ─
  function handleDragStart(
    todoId: string,
    e: ReactDragEvent<HTMLDivElement>,
  ): void {
    setMoveError(null);
    setDragging(todoId);
    const ids = new Set<string>();
    ids.add(todoId);
    if (selectedIds.has(todoId)) {
      for (const id of selectedIds) ids.add(id);
    }
    const payload: TodoDragPayload = { ids: Array.from(ids) };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', todoId);
    try {
      e.dataTransfer.setData(TODO_DRAG_MIME, JSON.stringify(payload));
    } catch {
      // 失败就不进 composer
    }
  }

  // ── 多卡 drop ─────────────────────────────────────────────────
  /**
   * 多卡拖到列的统一入口：
   *  1. 解析 dataTransfer：优先 `application/x-tds-todo-ids` JSON 数组；
   *     退而其次读 `text/plain` 取单 id。
   *  2. 「待开始」特殊：调 `/reset`（契约 §3.3）；其它列走 `/move`。
   *  3. 乐观更新所有成功目标 → 失败逐个回滚并收集失败 ids。
   *
   * **为什么 BFF 而不是 page 直发**：契约 §5.3 写明「写路径 userId 由 BFF 注入」
   * —— 直发会 422。所以**所有写路径**都走 `/api/todos/...`（BFF 相对路径）。
   *
   * **dataTransfer 同步读取限制**：React 合成 onDrop 事件对象在异步闭包里
   * 还能读（与原生 addEventListener 不同），所以这里直接读就行 —— 不用 ref 缓存。
   * 注意：`onDragOver` 阶段读 getData 在所有浏览器上都被禁（dragover 期间拿不到，
   * 防止拖拽时窥探其它源），但 onDrop 可以拿。
   */
  function handleDrop(
    targetKey: WorkspaceColumn['key'],
    dataTransfer: DataTransfer | null,
  ): void {
    setDragging(null);
    setDropTarget(null);

    let ids: string[] = [];
    if (dataTransfer) {
      try {
        const raw = dataTransfer.getData(TODO_DRAG_MIME);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<TodoDragPayload>;
          if (parsed.ids && Array.isArray(parsed.ids)) ids = parsed.ids;
        }
        if (ids.length === 0) {
          const txt = dataTransfer.getData('text/plain');
          if (txt) ids = [txt];
        }
      } catch {
        try {
          const txt = dataTransfer.getData('text/plain');
          if (txt) ids = [txt];
        } catch {
          ids = [];
        }
      }
    }
    if (ids.length === 0) return;

    const col = WORKSPACE_COLUMNS.find((c) => c.key === targetKey);
    if (!col) return;

    const snapshot = todosRef.current ?? [];
    if (snapshot.length === 0) return;

    if (targetKey === 'backlog') {
      void applyResetForMany(ids);
      return;
    }
    void applyMoveForMany(ids, col.entryPhase);
  }

  // 批量 move
  async function applyMoveForMany(
    ids: string[],
    targetPhase: TodoPhase,
  ): Promise<void> {
    const snapshot = todosRef.current ?? [];
    // 乐观更新：把每张 id 的 phase 设为 targetPhase；不在列表的跳过。
    setTodos((cur) =>
      (cur ?? []).map((t) =>
        ids.includes(t.id) && t.phase !== targetPhase
          ? { ...t, phase: targetPhase }
          : t,
      ),
    );

    const failed: Array<{ id: string; reason: string }> = [];
    const succeeded: string[] = [];

    // 并发上限 4
    const CONCURRENCY = 4;
    const queue = ids.slice();
    const workers = Array.from({ length: CONCURRENCY }).map(async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        const moved = snapshot.find((t) => t.id === id);
        if (!moved) continue;
        if (moved.phase === targetPhase) {
          succeeded.push(id);
          continue;
        }
        try {
          const res = await fetch(
            `/api/todos/${encodeURIComponent(id)}/move`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ phase: targetPhase }),
            },
          );
          const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            phase?: string;
            error?: string;
            reason?: string;
          };
          if (!res.ok) {
            failed.push({
              id,
              reason: body.error ?? body.reason ?? `http-${res.status}`,
            });
            continue;
          }
          succeeded.push(id);
          if (body.phase && body.phase !== targetPhase) {
            // 服务端真实 phase 覆盖本地（罕见）
            setTodos((cur) =>
              (cur ?? []).map((t) =>
                t.id === id ? { ...t, phase: body.phase as TodoPhase } : t,
              ),
            );
          }
        } catch (err) {
          failed.push({
            id,
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    });
    await Promise.allSettled(workers);

    // 部分失败：把 failed 的 todo 回滚到 snapshot 的 phase
    if (failed.length > 0) {
      const failedIds = new Set(failed.map((f) => f.id));
      setTodos((cur) =>
        (cur ?? []).map((t) => {
          if (!failedIds.has(t.id)) return t;
          const orig = snapshot.find((s) => s.id === t.id);
          return orig ? { ...t, phase: orig.phase } : t;
        }),
      );
      const preview =
        failed
          .slice(0, 3)
          .map((f) => `#${snapshot.find((s) => s.id === f.id)?.seqNum ?? '?'}`)
          .join('、') +
        (failed.length > 3 ? ` 等 ${failed.length} 个` : '');
      const sample = failed[0]?.reason ?? '';
      setMoveError(
        `${failed.length}/${ids.length} 张卡未能移到该列（${preview}）。第一张原因：${sample}。其余 ${succeeded.length} 张已落位。`,
      );
    }
  }

  // 批量 reset（拖回「待开始」专用）
  async function applyResetForMany(ids: string[]): Promise<void> {
    const snapshot = todosRef.current ?? [];
    setTodos((cur) =>
      (cur ?? []).map((t) =>
        ids.includes(t.id) ? { ...t, phase: 'todo' as TodoPhase } : t,
      ),
    );

    const failed: Array<{ id: string; reason: string }> = [];
    const succeeded: string[] = [];
    const CONCURRENCY = 4;
    const queue = ids.slice();
    const workers = Array.from({ length: CONCURRENCY }).map(async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        const moved = snapshot.find((t) => t.id === id);
        if (!moved) continue;
        // 已经在 todo phase：跳过
        if (moved.phase === 'todo') {
          succeeded.push(id);
          continue;
        }
        try {
          // **DELETE 不带 content-type**（契约 §5.3）。
          // 这里 reset 是 POST，无 body —— 给个 '{}' 以避免 Fastify 空 body。
          const res = await fetch(
            `/api/todos/${encodeURIComponent(id)}/reset`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            },
          );
          const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            phase?: string;
            error?: string;
            reason?: string;
          };
          if (!res.ok) {
            failed.push({
              id,
              reason: body.error ?? body.reason ?? `http-${res.status}`,
            });
            continue;
          }
          succeeded.push(id);
        } catch (err) {
          failed.push({
            id,
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    });
    await Promise.allSettled(workers);

    if (failed.length > 0) {
      const failedIds = new Set(failed.map((f) => f.id));
      setTodos((cur) =>
        (cur ?? []).map((t) => {
          if (!failedIds.has(t.id)) return t;
          const orig = snapshot.find((s) => s.id === t.id);
          return orig ? { ...t, phase: orig.phase } : t;
        }),
      );
      const preview =
        failed
          .slice(0, 3)
          .map((f) => `#${snapshot.find((s) => s.id === f.id)?.seqNum ?? '?'}`)
          .join('、') +
        (failed.length > 3 ? ` 等 ${failed.length} 个` : '');
      const sample = failed[0]?.reason ?? '';
      setMoveError(
        `「待开始」= 重置任务：${failed.length}/${ids.length} 张未能重置（${preview}）。第一张原因：${sample}。重置意味着中断构建并清空对话、方案、改动记录。`,
      );
    }
  }

  // ── Workspace 显隐 ───────────────────────────────────────────
  const {
    boardHidden,
    conversationFolded,
    setBoardHidden,
    setConversationFolded,
  } = useWorkspaceLayout();

  // ── 主按钮 / 右键菜单回调 ─────────────────────────────────────
  /**
   * 把"主按钮"或"下一步操作"统一翻译成一次端点请求。
   * 乐观更新 + 失败回滚；请求中按钮置 pending。
   */
  const router = useRouter();
  const handleMainAction = useCallback(
    (todoId: string, kind: MainActionKind): void => {
      // 「回复」是跳转，不是写请求 —— 走 next/navigation 的 client-side push。
      // 详情页读 `?focus=reply` 聚焦输入框（TodoDetail 切片负责）。
      // **如果详情页没有聚焦能力**：跳过去就完了；当前 TodoDetail 切片
      // 正在写，**有没有聚焦是它的事**，BoardCards 切片负责的就是跳过去。
      if (kind === 'reply') {
        router.push(`/todo/${encodeURIComponent(todoId)}?focus=reply`);
        return;
      }
      const path = mainActionPath(kind);
      if (!path) return;
      const body = mainActionBody(kind);

      // pending 标记
      setPendingMain((prev) => {
        const next = new Set(prev);
        next.add(todoId);
        return next;
      });

      const snapshot = todosRef.current ?? [];
      const moved = snapshot.find((t) => t.id === todoId);
      if (!moved) return;
      const optimisticPhase = optimisticPhaseFor(kind);

      setTodos((cur) =>
        (cur ?? []).map((t) =>
          t.id === todoId && optimisticPhase
            ? { ...t, phase: optimisticPhase }
            : t,
        ),
      );

      void (async () => {
        try {
          const res = await fetch(
            `/api/todos/${encodeURIComponent(todoId)}${path}`,
            body.method === 'DELETE'
              ? { method: 'DELETE' } // **DELETE 不带 content-type**
              : {
                  method: body.method,
                  headers: { 'content-type': 'application/json' },
                  body: body.payload ? JSON.stringify(body.payload) : '{}',
                },
          );
          const respBody = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            todo?: Todo;
            error?: string;
            reason?: string;
          };
          if (!res.ok) {
            // 回滚
            setTodos((cur) =>
              (cur ?? []).map((t) =>
                t.id === todoId ? { ...t, phase: moved.phase } : t,
              ),
            );
            setMoveError(
              `「${moved.title}」${mainActionLabel(kind)}失败：${respBody.error ?? respBody.reason ?? `http-${res.status}`}（已放回原处）`,
            );
            return;
          }
          // 用服务端返回的 todo 覆盖（最权威）
          if (respBody.todo) {
            setTodos((cur) =>
              (cur ?? []).map((t) =>
                t.id === todoId ? { ...t, ...respBody.todo } : t,
              ),
            );
          }
        } catch (err) {
          setTodos((cur) =>
            (cur ?? []).map((t) =>
              t.id === todoId ? { ...t, phase: moved.phase } : t,
            ),
          );
          setMoveError(
            `「${moved.title}」${mainActionLabel(kind)}失败：${err instanceof Error ? err.message : 'unknown'}（已放回原处）`,
          );
        } finally {
          setPendingMain((prev) => {
            const next = new Set(prev);
            next.delete(todoId);
            return next;
          });
        }
      })();
    },
    [],
  );

  // 右键菜单 → 复制回执（page 渲染到全局 status 条）
  const handleMenuCopy = useCallback((note: string): void => {
    const t = todosRef.current?.find((x) => cardMenuCtx?.id === x.id);
    if (!t) return;
    if (note.startsWith('title:')) {
      void navigator.clipboard.writeText(t.title).then(
        () => setDropNote(`已复制标题：「${t.title}」`),
        () => setDropNote('复制失败：浏览器拒绝访问剪贴板'),
      );
    } else if (note.startsWith('link:')) {
      const url = `${window.location.origin}/todo/${encodeURIComponent(t.id)}`;
      void navigator.clipboard.writeText(url).then(
        () => setDropNote(`已复制链接：${url}`),
        () => setDropNote('复制失败：浏览器拒绝访问剪贴板'),
      );
    }
    setDropNoteKind('ok');
  }, [cardMenuCtx]);

  // 右键菜单 → 编辑标题（PATCH）
  const handleMenuEdit = useCallback(
    (todoId: string, newTitle: string): void => {
      const snapshot = todosRef.current ?? [];
      const t = snapshot.find((x) => x.id === todoId);
      if (!t) return;
      if (t.title === newTitle) return;
      const original = t.title;
      // 乐观更新
      setTodos((cur) =>
        (cur ?? []).map((x) =>
          x.id === todoId ? { ...x, title: newTitle } : x,
        ),
      );
      void (async () => {
        try {
          const res = await fetch(
            `/api/todos/${encodeURIComponent(todoId)}`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: newTitle }),
            },
          );
          if (!res.ok) {
            // 回滚
            setTodos((cur) =>
              (cur ?? []).map((x) =>
                x.id === todoId ? { ...x, title: original } : x,
              ),
            );
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
              reason?: string;
            };
            setMoveError(
              `编辑标题失败：${body.error ?? body.reason ?? `http-${res.status}`}（已放回原处）`,
            );
            return;
          }
        } catch (err) {
          setTodos((cur) =>
            (cur ?? []).map((x) =>
              x.id === todoId ? { ...x, title: original } : x,
            ),
          );
          setMoveError(
            `编辑标题失败：${err instanceof Error ? err.message : 'unknown'}`,
          );
        }
      })();
    },
    [],
  );

  // 右键菜单 → 关闭（cancel）
  const handleMenuCancel = useCallback((todoId: string): void => {
    void doWriteAction(todoId, '/cancel', 'POST', 'closed', '关闭任务');
  }, []);

  // 右键菜单 → 重开
  const handleMenuReopen = useCallback((todoId: string): void => {
    void doWriteAction(todoId, '/reopen', 'POST', null, '重开任务');
  }, []);

  // 右键菜单 → 重跑
  const handleMenuRerun = useCallback((todoId: string): void => {
    void doWriteAction(todoId, '/rerun', 'POST', null, '重跑任务');
  }, []);

  // 右键菜单 → 删除（DELETE 无 body）
  const handleMenuDelete = useCallback((todoId: string): void => {
    void doWriteAction(todoId, '', 'DELETE', null, '删除任务');
  }, []);

  /** 通用写路径助手 —— handleMainAction 之外的简单写都走这里。 */
  async function doWriteAction(
    todoId: string,
    suffix: string,
    method: 'POST' | 'DELETE' | 'PATCH',
    optimisticPhase: TodoPhase | null,
    label: string,
  ): Promise<void> {
    const snapshot = todosRef.current ?? [];
    const moved = snapshot.find((t) => t.id === todoId);
    if (!moved) return;
    if (optimisticPhase) {
      setTodos((cur) =>
        (cur ?? []).map((t) =>
          t.id === todoId ? { ...t, phase: optimisticPhase } : t,
        ),
      );
    }
    setPendingMain((prev) => {
      const next = new Set(prev);
      next.add(todoId);
      return next;
    });
    try {
      const init: RequestInit =
        method === 'DELETE'
          ? { method: 'DELETE' }
          : {
              method,
              headers: { 'content-type': 'application/json' },
              body: '{}',
            };
      const url = suffix
        ? `/api/todos/${encodeURIComponent(todoId)}${suffix}`
        : `/api/todos/${encodeURIComponent(todoId)}`;
      const res = await fetch(url, init);
      if (!res.ok) {
        if (optimisticPhase) {
          setTodos((cur) =>
            (cur ?? []).map((t) =>
              t.id === todoId ? { ...t, phase: moved.phase } : t,
            ),
          );
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        setMoveError(
          `「${moved.title}」${label}失败：${body.error ?? body.reason ?? `http-${res.status}`}（已放回原处）`,
        );
        return;
      }
    } catch (err) {
      if (optimisticPhase) {
        setTodos((cur) =>
          (cur ?? []).map((t) =>
            t.id === todoId ? { ...t, phase: moved.phase } : t,
          ),
        );
      }
      setMoveError(
        `「${moved.title}」${label}失败：${err instanceof Error ? err.message : 'unknown'}`,
      );
    } finally {
      setPendingMain((prev) => {
        const next = new Set(prev);
        next.delete(todoId);
        return next;
      });
    }
  }

  // ── 头部 ──────────────────────────────────────────────────────
  return (
    <main
      style={{
        maxWidth: 1600,
        margin: '0 auto',
        color: C.text,
        fontSize: T.body,
        fontFamily: F.sans,
      }}
    >
      {/* 看板标题栏：BoardChrome 切片提供；BoardCards 接线。 */}
      <BoardHeader
        filters={filters}
        onFiltersChange={(next) => setFilters(next)}
        filterOpen={filterOpen}
        onFilterOpenChange={setFilterOpen}
        counts={counts}
        onToggleFullscreen={() => setConversationFolded(!conversationFolded)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenGuide={() => setGuideOpen(true)}
      />

      {/* 5 步引导弹层 —— 受控。 */}
      <KanbanGuide open={guideOpen} onOpenChange={setGuideOpen} />

      {/* 快捷键总面板 —— 受控。 */}
      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* 筛选浮层 —— 受控，仅 filterOpen 时渲染。BoardFilterPanel 自己挂遮罩/关闭。 */}
      {filterOpen && (
        <div
          // 浮层定位：放在 header 下方右侧。BoardFilterPanel 的 position 由它自己
          // 控制（fixed 在右上），所以这里只用 absolute 占位让 React 树里有
          // 这个节点、不影响布局。
          style={{
            position: 'relative',
            marginBottom: 8,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <BoardFilterPanel
            filters={filters}
            onChange={setFilters}
            counts={counts}
            // member id（不是 user id）—— 与 todo.ownerMemberId 同一命名空间。
            currentMemberId={currentMemberId}
            onClose={() => setFilterOpen(false)}
          />
        </div>
      )}

      {/* 顶部状态条（连接状态 / Agents / 新建 todo） —— 保留既有语义。
          「复刻 Free 档 · todos.dev 控制台」那行按契约删除（原站没有）。 */}
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          marginBottom: 12,
        }}
      >
        <span
          style={{ color: C.textDim, fontSize: T.meta, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: connected ? C.ok : C.textGhost,
            }}
          />
          {connected ? '实时连接已建立' : '未连接'}
        </span>
        <span style={{ flex: 1 }} />
        <Link
          href="/agents"
          style={{
            ...shared.ghostBtn,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          Agents
        </Link>
        <Link
          href="/new-todo"
          style={{
            ...shared.primaryBtn,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          + 新建 todo
        </Link>
      </header>

      {moveError && (
        <div
          role="alert"
          style={{
            ...shared.errorBox,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>{moveError}</div>
          <button type="button" onClick={() => setMoveError(null)} style={shared.ghostBtn}>
            知道了
          </button>
        </div>
      )}

      {dropNote && (
        <div
          role="status"
          style={{
            ...(dropNoteKind === 'warn' ? shared.errorBox : shared.noticeBox),
            marginBottom: 16,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>{dropNote}</div>
          <button type="button" onClick={() => setDropNote(null)} style={shared.ghostBtn}>
            知道了
          </button>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div
          role="status"
          style={{
            ...shared.noticeBox,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            已选中 <strong>{selectedIds.size}</strong> 张 todo 卡。
            拖任一张到左侧对话输入框会被记录，<strong>但首页 Chief 对话暂不插 chip</strong>。
            按住 <kbd>⌘</kbd>/<kbd>Ctrl</kbd> 点击其他卡可继续追加。
          </span>
          <button type="button" onClick={clearSelection} style={shared.ghostBtn}>
            清空选区
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            ...shared.placeholderBox,
            marginBottom: 16,
            border: `1px solid ${C.warn}`,
            color: C.warn,
          }}
        >
          <strong>数据未就绪</strong>
          <div style={{ marginTop: 4, fontSize: T.meta, color: C.text }}>{error}</div>
          <div style={{ marginTop: 8, fontSize: T.base, color: C.textGhost }}>
            业务 REST 端点已实现（todos / providers / skills / schedules / chief）。
            若这里是 404，说明后端路由版本比前端旧，重启后端进程即可。
          </div>
        </div>
      )}

      <SplitPane
        storageKey="tds.workspace.splitPct"
        foldLeftToZero
        forceFolded={conversationFolded}
        onUnfold={() => setConversationFolded(false)}
        left={
          <div style={{ minHeight: 480, height: '100%' }}>
            {topicListLoading ? (
              <div style={placeholderBox}>读取 topic 列表…</div>
            ) : defaultTopicId ? (
              <ChiefConversationCard
                threadId={defaultTopicId}
                onDropTodoReferences={handleDropTodoReferences}
              />
            ) : (
              <div style={placeholderBox}>
                <strong>还没有 topic。</strong>
                <div style={{ marginTop: 4, color: C.textDim, fontSize: T.meta }}>
                  新建一个开始对话：在{' '}
                  <Link
                    href="/settings/chief"
                    style={{ color: C.accent, textDecoration: 'none' }}
                  >
                    Chief 设置
                  </Link>{' '}
                  的 Topics 区创建，或直接告诉看板里的 todo 「ask Chief」让 Chief 自动起一个。
                </div>
              </div>
            )}
          </div>
        }
        right={
          boardHidden ? (
            <div
              style={{
                minHeight: 480,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'flex-end',
                padding: 8,
              }}
            >
              <button
                type="button"
                onClick={() => setBoardHidden(false)}
                style={{
                  ...shared.ghostBtn,
                  fontSize: T.sm,
                  padding: '6px 10px',
                }}
                title="⌘⌥B 显示看板"
              >
                显示看板 ▸
              </button>
            </div>
          ) : (
            <div>
              {todos !== null && (
                <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
                  {WORKSPACE_COLUMNS.map((col) => {
                    const list = filteredByColumn[col.key];
                    return (
                      <section
                        key={col.key}
                        style={{
                          minWidth: L.boardColW,
                          flex: `0 0 ${L.boardColW}px`,
                          background: C.surface,
                          border: `1px solid ${C.line}`,
                          borderRadius: R.xl,
                          padding: 12,
                          ...(dropTarget === col.key ? dropZoneStyle : null),
                          ...(col.isGate ? gateColumnStyle : null),
                        }}
                        data-gate={col.isGate ? '1' : '0'}
                        title={col.titleHint}
                        onDragOver={(e) => {
                          if (!dragging) return;
                          // 列只接受 text/plain（多卡 MIME 也在 text/plain 之外，
                          // 因为 dragstart 同时 setData 了 text/plain + 自定义 MIME）。
                          // 拖卡到输入框的 application/x-tds-todo-ids
                          // 不要让列误吞 —— 由列的 onDragOver 返回 false
                          // 让浏览器找下一个可接受的 drop target。
                          if (e.dataTransfer.types.includes('text/plain')) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dropTarget !== col.key) setDropTarget(col.key);
                          }
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            if (dropTarget === col.key) setDropTarget(null);
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          // React 合成 onDrop 在异步闭包里也能读 dataTransfer；
                          // 直接传过去给 handleDrop 用（dragstart 写入的 JSON 还在）。
                          handleDrop(col.key, e.dataTransfer);
                        }}
                      >
                        <h2
                          style={{
                            margin: '0 0 4px',
                            fontSize: T.meta,
                            fontWeight: 600,
                            color: col.isGate ? C.warn : C.text,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {col.isGate && <span style={gateBadgeStyle}>闸门</span>}
                          {col.label}
                          <span
                            style={{
                              marginLeft: 'auto',
                              color: C.textDim,
                              fontWeight: 400,
                            }}
                          >
                            {list.length}
                          </span>
                        </h2>
                        {col.subtitle && (
                          <div
                            style={{
                              color: C.textGhost,
                              fontSize: T.sm,
                              marginBottom: 6,
                            }}
                            title={col.titleHint}
                          >
                            {col.subtitle}
                          </div>
                        )}
                        {list.length === 0 && (
                          <div style={{ color: C.textGhost, fontSize: T.base, padding: '8px 0' }}>
                            {dragging ? '松开放到这里' : col.emptyHint}
                          </div>
                        )}
                        {list.map((t) => {
                          const isSelected = selectedIds.has(t.id);
                          const awaiting = awaitingMap.has(t.id)
                            ? { todoId: t.id, hasUnansweredQuestion: awaitingMap.get(t.id) === true }
                            : undefined;
                          return (
                            <Card
                              key={t.id}
                              todo={t}
                              selected={isSelected}
                              isDragging={dragging === t.id}
                              menuRef={cardMenuRef}
                              machines={machines}
                              awaiting={awaiting}
                              onMainAction={handleMainAction}
                              mainActionPending={pendingMain.has(t.id)}
                              onSelectToggle={handleCardClick}
                              onDragStart={handleDragStart}
                              onDragEnd={() => {
                                setDragging(null);
                                setDropTarget(null);
                              }}
                              onNote={(n) => setDropNote(n)}
                            />
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
              )}

              {(boardHidden || conversationFolded) && (
                <div style={{ marginTop: 8, color: C.textGhost, fontSize: T.sm }}>
                  {boardHidden && '看板已隐藏（⌘⌥B 显示） · '}
                  {conversationFolded && '对话已折叠（⌘⇧Enter 展开） · '}
                  <span style={{ color: C.textFaint }}>
                    {boardHidden && conversationFolded
                      ? '快捷键都按了一下'
                      : '快捷键状态'}
                  </span>
                </div>
              )}
            </div>
          )
        }
      />

      {/* 右键菜单：命令式 handle，挂全局一份。 */}
      <CardMenu
        ref={(instance) => {
          // 拿到 handle，存到 ref 里供 Card 调用
          cardMenuRef.current = instance;
        }}
        onOpen={(id) => setCardMenuCtx({ id })}
        // CardMenu 的 phase / nextAction 是 props。但 page 没法在 CardMenu
        // 不打开时知道当前 todo —— CardMenu 内部用 todoId 解析。
        // 这里走一个折中：CardMenu 内部持有 todoId，phase 通过 todos 查。
        phase={(() => {
          const t = todosRef.current?.find((x) => cardMenuCtx?.id === x.id);
          return t?.phase ?? 'todo';
        })()}
        nextAction={(() => {
          const t = todosRef.current?.find((x) => cardMenuCtx?.id === x.id);
          if (!t) return null;
          const awaiting = awaitingMap.has(t.id)
            ? { todoId: t.id, hasUnansweredQuestion: awaitingMap.get(t.id) === true }
            : undefined;
          return resolveMainAction(t, awaiting)?.kind ?? null;
        })()}
        nextLabel={(() => {
          const t = todosRef.current?.find((x) => cardMenuCtx?.id === x.id);
          if (!t) return null;
          const awaiting = awaitingMap.has(t.id)
            ? { todoId: t.id, hasUnansweredQuestion: awaitingMap.get(t.id) === true }
            : undefined;
          return resolveMainAction(t, awaiting)?.label ?? null;
        })()}
        onMainAction={handleMainAction}
        onEdit={handleMenuEdit}
        onCopy={handleMenuCopy}
        onCancel={handleMenuCancel}
        onDelete={handleMenuDelete}
        onReopen={handleMenuReopen}
        onRerun={handleMenuRerun}
      />
    </main>
  );
}

// ── 辅助：phase → 列、phase → 桶（避免分散定义） ─────────────────

function colKeyFor(phase: TodoPhase): WorkspaceColumn['key'] {
  if (phase === 'todo' || phase === 'queued') return 'backlog';
  if (phase === 'planning' || phase === 'implement' || phase === 'reviewing')
    return 'inProgress';
  if (phase === 'confirm' || phase === 'review' || phase === 'failed')
    return 'needsYou';
  return 'done';
}

function phaseBucketFor(phase: TodoPhase): 'planning' | 'executing' {
  if (phase === 'planning') return 'planning';
  return 'executing';
}

// ── 主按钮动作 → 端点 + body + 乐观 phase ─────────────────────────

interface MainActionSpec {
  path: string;
  body: { method: 'POST' | 'DELETE' | 'PATCH'; payload?: Record<string, unknown> };
  optimisticPhase: TodoPhase | null;
}

function mainActionPath(kind: MainActionKind): string | null {
  switch (kind) {
    case 'start':
      return '/move';
    case 'cancel':
      return '/cancel';
    case 'approve':
      return '/approve';
    case 'complete':
      return '/complete';
    case 'rerun':
      return '/rerun';
    case 'reopen':
      return '/reopen';
    case 'reply':
      return null; // 跳转不走写路径
  }
}

function mainActionBody(kind: MainActionKind): {
  method: 'POST' | 'DELETE' | 'PATCH';
  payload?: Record<string, unknown>;
} {
  switch (kind) {
    case 'start':
      return { method: 'POST', payload: { phase: 'planning' } };
    case 'cancel':
    case 'approve':
    case 'rerun':
    case 'reopen':
      return { method: 'POST' };
    case 'complete':
      return { method: 'POST', payload: { merge: false } };
    case 'reply':
      return { method: 'POST' };
  }
}

function optimisticPhaseFor(kind: MainActionKind): TodoPhase | null {
  switch (kind) {
    case 'start':
      return 'planning';
    case 'cancel':
      return 'closed';
    case 'approve':
      return 'review';
    case 'complete':
      return 'done';
    case 'rerun':
      return 'queued';
    case 'reopen':
      return 'todo';
    case 'reply':
      return null;
  }
}

function mainActionLabel(kind: MainActionKind): string {
  switch (kind) {
    case 'start':
      return '开始';
    case 'cancel':
      return '中断';
    case 'approve':
      return '确认';
    case 'complete':
      return '完成';
    case 'rerun':
      return '重跑';
    case 'reopen':
      return '重开';
    case 'reply':
      return '回复';
  }
}

// ── 样式 ──────────────────────────────────────────────────────────

const gateColumnStyle: CSSProperties = {
  ...shared.card,
  border: `2px solid ${C.warn}`,
  background: 'rgba(251,191,36,0.10)',
};

const gateBadgeStyle: CSSProperties = {
  ...shared.gateBadge,
};

const dropZoneStyle: CSSProperties = {
  border: `2px dashed ${C.accent}`,
  background: 'rgba(129,140,248,0.08)',
};

const placeholderBox: CSSProperties = shared.placeholderBox;