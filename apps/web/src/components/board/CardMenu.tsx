'use client';

/**
 * 卡片右键菜单（契约 §3.8 冻结顺序）。
 *
 * **关键不变量**：
 *  - 顺序冻结：下一步操作 → 中断 → 编辑 → 复制 → 复制链接 → 关闭 → 删除
 *    → ─── → 重开 → 重跑。原站实测的菜单项顺序即此。
 *  - 每项条件渲染：见契约表。"下一步操作" 是「主按钮的非 done/closed 那一档」，
 *    page 层用同一份映射（resolveMainAction）来判定 —— 但因为 resolveMainAction
 *    还涉及 awaiting-reply 注入，这里再做一个最小版「下一步是否存在」判定。
 *  - 删除走 ConfirmDialog（不自己写）。其它项原地消化。
 *  - 关掉模式照搬 ConfirmDialog：Escape / 点外部 / 选菜单项后关。
 *  - 受控：父组件持 `open`，这里只负责呈现与触发回调。
 *
 * **为什么用 imperative handle**：右键点击坐标由 page.tsx 拿到，传到 menu
 * 里再渲染浮层；这种 "坐标 → 弹菜单" 的语义用命令式 API 比 state 更顺手。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { C, F, R, S, T } from '@/lib/design-tokens';
import type { TodoPhase } from '@/lib/api';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { MainActionKind } from './Card';

// ── 公开 handle：父组件命令式打开菜单 ───────────────────────────

export interface CardMenuHandle {
  /** 在指定屏幕坐标打开菜单。todoId 用于后续回调定位。
   * `onOpen` 回调通知父组件记下当前 todoId（page 用它查 phase/nextAction）。 */
  open(x: number, y: number, todoId: string): void;
  /** 关闭菜单。 */
  close(): void;
}

// ── props ────────────────────────────────────────────────────────

export interface CardMenuProps {
  /** 当前 todo 的 phase —— 用于条件渲染「中断/关闭/重开/重跑」等。 */
  phase: TodoPhase;
  /**
   * 「下一步操作」是否存在 —— 若 resolveMainAction 非 null 且非 done/closed，
   * 这里就显示 "下一步操作" 菜单项。父组件算好后传入：
   *
   *   const next = useMemo(
   *     () => resolveMainAction(todo, awaiting)?.kind ?? null,
   *     [todo, awaiting],
   *   );
   *
   * `null` = 没有下一步（终态 / 关闭）。
   */
  nextAction: MainActionKind | null;
  /** 主按钮 label —— 显示在「下一步操作」菜单项右侧（与卡片右下角按钮一致）。 */
  nextLabel: string | null;
  /**
   * CardMenu.open 被调用时通知父组件"菜单当前指向的 todoId"。父组件用它
   * 来查 phase / awaiting / nextAction —— 因为 CardMenu 自己不持有 todo 引用。
   * 不传就不通知（菜单能开能关，但 `phase` / `nextAction` 永远是初始值）。
   */
  onOpen?: (todoId: string) => void;
  /**
   * 主按钮点击的同一回调。菜单项「下一步操作」走它：
   * 父组件不用再单独实现一份 onAdvance，按钮和菜单共享一份动作。
   */
  onMainAction: (todoId: string, kind: MainActionKind) => void;
  /** 编辑标题 inline。父组件拿到新标题后调 PATCH。 */
  onEdit: (todoId: string, newTitle: string) => void;
  /** 复制标题 / 复制链接 —— 回执交给父组件显示。 */
  onCopy: (note: string) => void;
  /** 关闭任务 —— POST /api/todos/:todoId/cancel。 */
  onCancel: (todoId: string) => void;
  /** 删除任务 —— POST DELETE /api/todos/:todoId。 */
  onDelete: (todoId: string) => void;
  /** 重开 —— POST /api/todos/:todoId/reopen。 */
  onReopen: (todoId: string) => void;
  /** 重跑 —— POST /api/todos/:todoId/rerun。 */
  onRerun: (todoId: string) => void;
}

// ── 样式 ─────────────────────────────────────────────────────────

/** 浮层阴影 —— 与 BoardFilterPanel 同源命名（避免字面量散落）。 */
const ELEVATION_SHADOW = '0 12px 32px rgba(0, 0, 0, 0.5)';

const menuStyle: CSSProperties = {
  position: 'fixed',
  // zIndex 比侧栏(40) 高，比 ConfirmDialog(80) 低 —— 让删除的二次确认
  // 弹在菜单之上。
  zIndex: 70,
  minWidth: 180,
  background: C.surfaceHi,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.lg,
  padding: `${S.xs}px 0`,
  boxShadow: ELEVATION_SHADOW,
  fontFamily: F.sans,
  fontSize: T.body,
  color: C.text,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: `${S.xs}px ${S.md}px`,
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  width: '100%',
  textAlign: 'left',
  color: C.text,
  fontFamily: F.sans,
  fontSize: T.body,
};

const itemDangerStyle: CSSProperties = {
  ...itemStyle,
  color: C.danger,
};

const dividerStyle: CSSProperties = {
  height: 1,
  background: C.line,
  margin: `${S.xs}px 0`,
};

const hintStyle: CSSProperties = {
  color: C.textFaint,
  fontSize: T.sm,
  marginLeft: 12,
};

// inline 编辑输入框样式
const editWrapStyle: CSSProperties = {
  ...menuStyle,
  padding: S.sm,
  minWidth: 240,
};

const editInputStyle: CSSProperties = {
  width: '100%',
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  padding: `${S.xs}px ${S.sm}px`,
  fontFamily: F.sans,
  fontSize: T.body,
  outline: 'none',
};

// ── phase → 哪些菜单项可见（契约 §3.8 条件） ─────────────────────

/**
 * 终态 = done / closed：这两态下"关闭"/"中断"/"编辑"/"删除"等还在，
 * 但「下一步操作」不出（resolveMainAction 返回 null）。
 * 「重开」只对 done/closed 显示；「重跑」对 done/failed/closed 显示。
 *
 * 我们在父组件按 phase 直接条件渲染，这里只列 helper：
 */

// ── 组件 ─────────────────────────────────────────────────────────

const CardMenu = forwardRef<CardMenuHandle, CardMenuProps>(function CardMenu(
  props,
  ref,
): ReactElement | null {
  const {
    phase,
    nextAction,
    nextLabel,
    onOpen,
    onMainAction,
    onEdit,
    onCopy,
    onCancel,
    onDelete,
    onReopen,
    onRerun,
  } = props;

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [todoId, setTodoId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  // onOpen 的 ref 镜像 —— 父组件每次 render 都新建 callback 会让
  // useImperativeHandle 每次重建 handle（Card 拿到的 instance 引用会失效）。
  // 用 ref 镜像，handle 永远稳定，只在调用时读最新 callback。
  const onOpenRef = useRef<((id: string) => void) | undefined>(undefined);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useImperativeHandle(
    ref,
    () => ({
      open(x, y, id) {
        setPos({ x, y });
        setTodoId(id);
        setOpen(true);
        setEditing(false);
        onOpenRef.current?.(id);
      },
      close() {
        setOpen(false);
        setEditing(false);
      },
    }),
    [],
  );

  // Escape / 点外部关闭 —— 照搬 ConfirmDialog 的写法
  useEffect(() => {
    if (!open || confirmDelete) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (overlayRef.current && target && !overlayRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    // 用 capture:true 抢在 page 的 onclick 之前 —— 否则点菜单外部时 page
    // 的 onClick 会先跑、菜单不会自动关。
    document.addEventListener('mousedown', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onClick, true);
    };
  }, [open, confirmDelete]);

  // 编辑模式：自动 focus + 选中文本
  useEffect(() => {
    if (!editing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  /** 选菜单项后的统一关闭逻辑（ConfirmDialog 例外，它自己有 onCancel）。 */
  const closeAfterAction = useCallback((): void => {
    setOpen(false);
    setEditing(false);
  }, []);

  // 不在打开态时直接不渲染（避免抢事件）
  if (!open || !todoId) return null;

  // 边界裁切 —— 坐标不要超出视口右边/底部
  const MENU_W = 220;
  const MENU_H_EST = 280;
  const x = pos ? Math.min(pos.x, window.innerWidth - MENU_W - 8) : 0;
  const y = pos ? Math.min(pos.y, window.innerHeight - MENU_H_EST - 8) : 0;

  // ── inline 编辑态：独立小面板，不显示菜单 ─────────────────────
  if (editing) {
    const submit = (): void => {
      const newTitle = draft.trim();
      if (newTitle && newTitle !== draft) {
        // 用 ref 取当前 todo 标题不便（我们只持有 todoId），所以让父组件
        // 在 onEdit 里做"未变则跳过"的判断。这里一律通知。
        onEdit(todoId, newTitle);
      }
      closeAfterAction();
    };
    return (
      <div
        ref={overlayRef}
        role="dialog"
        aria-label="编辑标题"
        style={{ ...editWrapStyle, left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={editInputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeAfterAction();
            }
          }}
          onBlur={submit}
          style={editInputStyle}
          placeholder="新标题"
        />
      </div>
    );
  }

  // ── 主菜单 ─────────────────────────────────────────────────────
  const showNext = nextAction !== null;
  // 「中断」按契约仅 active phase：planning / implement / reviewing / queued
  const showCancel =
    phase === 'planning' ||
    phase === 'implement' ||
    phase === 'reviewing' ||
    phase === 'queued';
  /**
   * 「关闭」= POST /cancel，而**状态机只在这几个相位接受 `cancel`**：
   * queued / planning / implement / reviewing（`state-machine.ts` 逐个 case
   * 都有一行 `if (t === 'cancel')`），加上两道闸门 confirm / review
   * （`state-machine.ts:126` 的 gate 分支统一放行）。
   *
   * ⚠️ `todo` 相位**不接受** cancel —— 它会拿到
   * `409 transition refused: cancel on todo would land on todo (todo rejects cancel)`。
   * 那条路的正确动作是 `/reset`（拖回「待开始」列也是这个端点）。
   * 所以这里不能简单写 `phase !== 'done' && phase !== 'closed'` ——
   * 那样会在 `todo` 相位显示一个注定 409 的菜单项。
   */
  const CANCEL_PHASES: readonly TodoPhase[] = [
    'queued',
    'planning',
    'implement',
    'reviewing',
    'confirm',
    'review',
  ];
  const showClose = CANCEL_PHASES.includes(phase);
  const showReopen = phase === 'done' || phase === 'closed';
  const showRerun =
    phase === 'done' || phase === 'failed' || phase === 'closed';

  return (
    <>
      <div
        ref={overlayRef}
        role="menu"
        style={{ ...menuStyle, left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {showNext && nextAction && nextLabel && (
          <button
            type="button"
            role="menuitem"
            style={itemStyle}
            onClick={() => {
              onMainAction(todoId, nextAction);
              closeAfterAction();
            }}
          >
            <span>下一步操作</span>
            <span style={hintStyle}>{nextLabel}</span>
          </button>
        )}

        {showCancel && (
          <button
            type="button"
            role="menuitem"
            style={itemStyle}
            onClick={() => {
              onCancel(todoId);
              closeAfterAction();
            }}
          >
            中断
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          style={itemStyle}
          onClick={() => {
            // inline edit：进入编辑态
            setDraft('');
            setEditing(true);
          }}
        >
          编辑
        </button>

        <button
          type="button"
          role="menuitem"
          style={itemStyle}
          onClick={() => {
            // 复制标题 —— 我们手里没有 todo 全文，让父组件拼。
            // 这里只把 todoId 给父组件，由 page 在回调里查到 title 复制。
            onCopy(`title:${todoId}`);
            closeAfterAction();
          }}
        >
          复制
        </button>

        <button
          type="button"
          role="menuitem"
          style={itemStyle}
          onClick={() => {
            onCopy(`link:${todoId}`);
            closeAfterAction();
          }}
        >
          复制链接
        </button>

        {showClose && (
          <button
            type="button"
            role="menuitem"
            style={itemStyle}
            onClick={() => {
              onCancel(todoId);
              closeAfterAction();
            }}
          >
            关闭
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          style={itemDangerStyle}
          onClick={() => setConfirmDelete(true)}
        >
          删除
        </button>

        {(showReopen || showRerun) && <div style={dividerStyle} />}

        {showReopen && (
          <button
            type="button"
            role="menuitem"
            style={itemStyle}
            onClick={() => {
              onReopen(todoId);
              closeAfterAction();
            }}
          >
            重开
          </button>
        )}

        {showRerun && (
          <button
            type="button"
            role="menuitem"
            style={itemStyle}
            onClick={() => {
              onRerun(todoId);
              closeAfterAction();
            }}
          >
            重跑
          </button>
        )}
      </div>

      {/* 删除二次确认 —— ConfirmDialog 没有 `open` prop，自己用 mounted
          状态挂载/卸载。这里条件渲染：confirmDelete=false 时不渲染。 */}
      {confirmDelete && (
        <ConfirmDialog
          title="删除任务？"
          danger
          confirmText="删除"
          cancelText="取消"
          onConfirm={() => {
            if (todoId) onDelete(todoId);
            setConfirmDelete(false);
            closeAfterAction();
          }}
          onCancel={() => setConfirmDelete(false)}
        >
          这个操作无法撤销。任务的对话、方案与改动记录都将一起删除。
        </ConfirmDialog>
      )}
    </>
  );
});

export default CardMenu;