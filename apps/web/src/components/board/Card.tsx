'use client';

/**
 * 看板单张卡片（契约 2026-10-18 看板对齐）。
 *
 * **为什么独立成组件**：
 *  - 卡片右下角主按钮需要乐观更新 + 失败回滚 + 阶段变文案，
 *    把这块 UI 留在 page.tsx 会让看板列渲染与拖拽/筛选逻辑混在一起。
 *  - 主按钮映射（契约 §3.7）只有卡片层能回答，所以按钮渲染逻辑
 *    必须跟卡片同行。
 *  - 下载菜单（BranchMenu）由 TodoDetail 切片拥有；卡片右上角 import
 *    复用即可 —— 该组件正在等 TodoDetail 切片把 BranchMenu.tsx 落盘，
 *    目前已存在，所以 import 直接生效（见文件顶部说明）。
 *
 * **文件所有权**：本切片（BoardCards）。不要在这文件改其它切片的字段。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import { useRouter } from 'next/navigation';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import type { Todo, TodoPhase, Build } from '@/lib/api';
import type { BranchMachine } from '@/components/board/BranchMenu';
import BranchMenu from '@/components/board/BranchMenu';
import type { CardMenuHandle } from '@/components/board/CardMenu';

// ── 类型 ─────────────────────────────────────────────────────────

/**
 * 「该 todo 是否处于 awaiting-reply 状态」的判定输入。
 *
 * 当前从 `/api/todos/:todoId/documents` 拉一次，缓存到 page.tsx 注入；
 * 这里只接收结果，不重新拉。
 */
export interface AwaitingReplyInfo {
  todoId: string;
  hasUnansweredQuestion: boolean;
}

export interface CardProps {
  todo: Todo;
  /** 是否被多选框选中（⌘/Ctrl 点选后高亮）。 */
  selected: boolean;
  /** 拖拽中状态：被拖的那张半透明。 */
  isDragging: boolean;
  /** 卡片右键菜单 ref（受控在 page.tsx 里）。 */
  menuRef?: React.MutableRefObject<CardMenuHandle | null>;
  /** BranchMenu 所需 —— `/api/teams/:teamId/machines` 拉到的机器列表（页面注入）。 */
  machines: BranchMachine[];
  /** awaiting-reply 缓存 —— page 拉到后注入；undefined 表示还没拉。 */
  awaiting?: AwaitingReplyInfo;
  /**
   * 主按钮点击回调（契约 §3.7 冻结映射）。
   * 卡片层只决定「按钮渲染什么 phase → 文本」，点按由 page.tsx 处理
   * （要拿 setTodos / setMoveError 等闭包状态做乐观更新）。
   */
  onMainAction: (todoId: string, action: MainActionKind) => void;
  /** 主按钮请求中（乐观更新已落但响应还没回）—— 用于把按钮置 disabled 并改文案「…中」。 */
  mainActionPending: boolean;
  /** 多选切换（⌘/Ctrl 点击）。元素类型同 onDragStart：卡片根是 div 不是 <a>。 */
  onSelectToggle: (e: ReactMouseEvent<HTMLDivElement>, todoId: string) => void;
  /** dragstart —— page 用同样的 dataTransfer JSON（多卡用同一份）。
   *  元素类型是 HTMLDivElement：卡片根是 div（为了在内部挂下载按钮，
   *  Link 会把点击事件吃掉），不是 <a>。 */
  onDragStart: (todoId: string, e: ReactDragEvent<HTMLDivElement>) => void;
  /** dragend —— 清掉 page 的 dragging/dropTarget。 */
  onDragEnd: () => void;
  /**
   * 回执：右键菜单里点「复制标题/复制链接」时调用，让 page.tsx 在全局
   * status 条显示「已复制 xxx」。不传时回执落到 console（BranchMenu 同源语义）。
   */
  onNote?: (note: string) => void;
}

/** 契约 §3.7 主按钮的动作枚举 —— 卡片不直接发请求，调 page 的处理函数。 */
export type MainActionKind =
  | 'start'
  | 'cancel'
  | 'approve'
  | 'complete'
  | 'rerun'
  | 'reopen'
  | 'reply';

/**
 * 把 todo + awaiting 解析成「下一步主按钮」的展示态。
 *
 * **为什么 awaiting 优先于 phase**：`failed` 时按钮是「重跑」；但
 * 同一时刻若有未答的 question doc，原站语义是「回复」（跳转）。
 * 契约 §3.7 表格用「有 awaiting-reply 文档」一条覆盖了这种情况。
 *
 * **导出**：page.tsx 也用同一份映射（菜单的「下一步操作」菜单项要拿
 * 同一个 label / kind）—— 单一事实源，避免卡片按钮和菜单项文案漂移。
 */
export function resolveMainAction(
  todo: Todo,
  awaiting: AwaitingReplyInfo | undefined,
): { kind: MainActionKind; label: string } | null {
  const phase: TodoPhase = todo.phase;
  if (awaiting?.hasUnansweredQuestion && phase !== 'done' && phase !== 'closed') {
    return { kind: 'reply', label: '回复' };
  }
  switch (phase) {
    case 'todo':
    case 'queued':
      return { kind: 'start', label: '开始' };
    case 'planning':
    case 'implement':
    case 'reviewing':
      return { kind: 'cancel', label: '中断' };
    case 'confirm':
      return { kind: 'approve', label: '确认' };
    case 'review':
      return { kind: 'complete', label: '完成' };
    case 'failed':
      return { kind: 'rerun', label: '重跑' };
    case 'done':
      return { kind: 'reopen', label: '重开' };
    case 'closed':
      return null;
  }
}

// ── 纯函数：相对时间（契约 §1.1 实测「2 天前」） ─────────────────

/**
 * 把 epoch ms 翻译成「2 天前」/「3 小时前」/「刚刚」式字符串。
 *
 *  - < 60s            → 「刚刚」
 *  - < 60min          → 「N 分钟前」
 *  - < 24h            → 「N 小时前」
 *  - < 7day           → 「N 天前」
 *  - 其它             → 「YYYY-MM-DD」
 *
 * 用 `updatedAt`，与 todo 列表端点的字段一致。
 *
 * **不接受 Date.now() 之外的注入时间**：避免 SSR/CSR 时间差导致 hydration
 * mismatch；卡片渲染时 `now` 是一致的 client-only 时钟，hydrate 之前整张
 * 卡片都在 `if (!mounted) return null` 后面（page.tsx 已经做了 SSR 兜底）。
 */
export function timeAgo(epochMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - epochMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── 样式 ─────────────────────────────────────────────────────────

/**
 * 卡片本体 —— 与原站一致的「12px 圆角 + 1px 半透边 + surfaceHi 底」。
 * 选中态沿用既有约定：accent 实线描边 + 1px shadow halo。
 */
const cardBaseStyle: CSSProperties = {
  display: 'block',
  position: 'relative',
  padding: 8,
  marginBottom: 6,
  background: C.surfaceHi,
  borderRadius: R.md,
  textDecoration: 'none',
  color: C.textDim,
  fontSize: T.meta,
};

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: C.textGhost,
  fontSize: T.sm,
  marginBottom: 2,
};

const titleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  marginBottom: 2,
};

const titleStyle: CSSProperties = {
  color: C.text,
  fontSize: T.body,
  lineHeight: 1.35,
  wordBreak: 'break-word',
  flex: 1,
};

const timeStyle: CSSProperties = {
  color: C.textGhost,
  fontSize: T.sm,
  marginTop: 2,
};

const mainBtnWrapStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: 6,
};

const mainBtnBaseStyle: CSSProperties = {
  // **不写颜色字面量**：直接复用 shared.primaryBtn 的底色 + 文字色 token，
  // 只覆盖 padding/fontSize 让卡片按钮更紧凑（卡片按钮比 header 的小一档）。
  ...shared.primaryBtn,
  padding: `${S.xs}px ${S.sm}px`,
  fontSize: T.meta,
};

const mainBtnDisabledStyle: CSSProperties = {
  ...mainBtnBaseStyle,
  opacity: 0.5,
  cursor: 'not-allowed',
};

/** 选中点：6×6 实心圆点（既有约定）。 */
const selectedDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: C.accent,
  marginLeft: 'auto',
};

/**
 * 卡片右上角的小图标按钮 —— 触发下载菜单（BranchMenu）。
 * BranchMenu 自己渲染触发器按钮（icon 模式），我们只要把它浮在卡片右上角。
 * 「绝对定位 + z-index 高于链接」让点击不被 Link 抢走。
 *
 * **为什么不用 button 包整个卡片**：BranchMenu 是受控弹层（point at the trigger），
 * 让 BranchMenu 自带触发器更省心。卡片本身的 click 仍由外层 Link 走。
 */
const downloadSlotStyle: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  zIndex: 2,
};

// ── 组件 ─────────────────────────────────────────────────────────

export default function Card(props: CardProps): ReactElement {
  const {
    todo,
    selected,
    isDragging,
    menuRef,
    machines,
    awaiting,
    onMainAction,
    mainActionPending,
    onSelectToggle,
    onDragStart,
    onDragEnd,
    onNote,
  } = props;

  const router = useRouter();

  // ── 拉一次最新 build（仅当 phase 不是 todo/queued/done/closed） ─
  // 无 Build 时不渲染下载菜单（BranchMenu 会自己处理 null 的语义）。
  // 缓存用本地 useState —— 同一张卡多次挂载只 fetch 一次（mount 时）。
  const [branchInfo, setBranchInfo] = useState<{
    branch: string;
    worktreePath: string | null;
  } | null>(null);
  useEffect(() => {
    // 没 phase 进 build 的 todo 跳过（todo/queued/done/closed 都没有 build）
    const skipPhases: TodoPhase[] = ['todo', 'queued', 'done', 'closed'];
    if (skipPhases.includes(todo.phase)) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/todos/${encodeURIComponent(todo.id)}/builds`,
          { cache: 'no-store', signal: ac.signal },
        );
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { ready?: boolean; data?: Build[] }
          | null;
        if (!body?.ready || !body.data) return;
        // 列表按 n desc，取首条（latest）
        const latest = body.data[0];
        if (!latest) return;
        setBranchInfo({
          branch: latest.branch,
          worktreePath: latest.worktreePath,
        });
      } catch {
        // 失败 = 没有下载菜单；不假绿
      }
    })();
    return () => ac.abort();
  }, [todo.id, todo.phase]);

  const action = useMemo(
    () => resolveMainAction(todo, awaiting),
    [todo, awaiting],
  );

  /** 主按钮 disabled —— pending 或没有下一步（closed）。 */
  const disabled = mainActionPending || action === null;

  /**
   * 阻止右键菜单与拖拽冲突：拖拽时不弹菜单（按住右键拖卡走原站行为）。
   * 但拖拽时被右键触发 `contextmenu`，先 preventDefault 避免误弹菜单。
   */
  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (!menuRef) return;
      // 让浏览器原生菜单不弹 —— 自己接管
      e.preventDefault();
      menuRef.current?.open(e.clientX, e.clientY, todo.id);
    },
    [menuRef, todo.id],
  );

  return (
    <div
      // 卡片根容器：div 而不是 Link —— Link 内部还要套下载按钮（branch menu）
      // 会让点击事件被 button 抢走。把整张卡变成 div + onClick 用 router.push
      // 走详情页，保留 ⌘ 点选 / 右键 / drag。
      role="button"
      tabIndex={0}
      data-card-todo-id={todo.id}
      draggable
      onClick={(e) => {
        // ⌘/Ctrl 点选走 onSelectToggle；否则走详情页
        if (e.metaKey || e.ctrlKey) {
          onSelectToggle(e, todo.id);
          return;
        }
        // 其它点击：跳详情页 —— 用 next/navigation 的 client-side push，
        // 避免整页 reload（同 Link 的语义）。
        router.push(`/todo/${encodeURIComponent(todo.id)}`);
      }}
      onContextMenu={handleContextMenu}
      onDragStart={(e) => onDragStart(todo.id, e)}
      onDragEnd={onDragEnd}
      aria-selected={selected}
      style={{
        ...cardBaseStyle,
        border: `1px solid ${selected ? C.accent : C.line}`,
        boxShadow: selected ? `0 0 0 1px ${C.accent}` : 'none',
        opacity: isDragging ? 0.4 : 1,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      {/* 卡片右上角 —— 下载菜单（BranchMenu icon 模式）。
          节点位置必须在卡片根 div 内（绝对定位），否则点按钮会被外层点击吞掉。
          只有拉到 branch 之后才挂上 —— 没 build 的 todo（如 todo/queued/done/closed）
          没必要画个图标提示「点了也没意义」。 */}
      {branchInfo && (
        <div
          style={downloadSlotStyle}
          // 阻止冒泡：点 BranchMenu 触发器不应触发卡片的 Link 跳转
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <BranchMenu
            variant="icon"
            branch={branchInfo.branch}
            todoId={todo.id}
            worktreePath={branchInfo.worktreePath}
            machines={machines}
            onNote={onNote}
          />
        </div>
      )}

      {/* 项目徽章行 —— 横向，`:<projectName>`（契约 §1.1 实测结构） */}
      <div style={badgeRowStyle}>
        <span>{todo.projectName ? `:${todo.projectName}` : ''}</span>
        {selected && <span aria-hidden style={selectedDotStyle} />}
      </div>

      {/* 编号 + 标题 —— Agent 创建的徽章在编号左侧 */}
      <div style={titleRowStyle}>
        {todo.createdByType !== 'user' && (
          <CreatorBadge type={todo.createdByType} />
        )}
        <span style={{ color: C.textGhost }}>#{todo.seqNum}</span>
      </div>
      <div style={titleStyle}>{todo.title}</div>

      {/* 相对时间 */}
      <div style={timeStyle}>{timeAgo(todo.updatedAt)}</div>

      {/* 右下角主按钮 */}
      {action && (
        <div style={mainBtnWrapStyle}>
          <button
            type="button"
            disabled={disabled}
            onClick={(e) => {
              // 阻止冒泡 —— 不被 Link 当作普通点击（虽然根 div 是 div 不是 Link，
              // 但 stopPropagation 是个保险，未来若换成 Link 时不会出 bug）。
              e.stopPropagation();
              onMainAction(todo.id, action.kind);
            }}
            style={disabled ? mainBtnDisabledStyle : mainBtnBaseStyle}
          >
            {mainActionPending ? `${action.label}…中` : action.label}
          </button>
        </div>
      )}
    </div>
  );
}

// ── CreatorBadge：Agent 创建的徽章（编号左侧小图标） ────────────

/**
 * 「总管创建的」/「Agent 创建的」在编号左侧显示一个小图标（契约 §3 实测）。
 *
 * 设计细节：
 *  - 12px，与原站实测一致
 *  - 色 `C.textGhost`，不抢标题焦点
 *  - `title` 属性写明（hover 才看得到，无障碍读屏也能念出来）
 *  - 内联 SVG 不引图标库 —— 整个卡片组件树不允许装新依赖（design-tokens 已够用）
 *
 * **为什么不共用一个图标**：原站实测两个图标视觉上有差别（总管更像「机器人 +
 * 提词符」，Agent 更像「齿轮 + 终端」），所以画两个完全不同的 svg。
 */
function CreatorBadge(props: { type: 'chief' | 'agent' }): ReactElement {
  const { type } = props;
  if (type === 'chief') {
    return (
      <span
        aria-hidden
        title="总管创建的"
        style={{ display: 'inline-flex', alignItems: 'center', color: C.textGhost }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="8" width="18" height="12" rx="2" />
          <path d="M12 2v6" />
          <circle cx="12" cy="2" r="1" fill="currentColor" />
          <path d="M9 13h.01" />
          <path d="M15 13h.01" />
          <path d="M9 17h6" />
        </svg>
      </span>
    );
  }
  // agent
  return (
    <span
      aria-hidden
      title="Agent 创建的"
      style={{ display: 'inline-flex', alignItems: 'center', color: C.textGhost }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </span>
  );
}