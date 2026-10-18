'use client';

/**
 * 快捷键总面板。
 *
 * 契约 §1.5：用户按 `Ctrl /`（或点看板标题栏右侧角标按钮）后弹出的全应用快捷键总表。
 * 数据源 `apps/web/src/lib/shortcuts.ts` 的 `SHORTCUTS`，**不要**在这里硬编码第二份。
 *
 * 设计要点（沿用 `ConfirmDialog` 的对话框基建，因为本项目目前没有更通用的弹窗框架）：
 * - portal 到 document.body；z-index 80（与既有对话框对齐；modaltoast 90 留给 server 错误）。
 * - Escape 关闭、点遮罩关闭、Tab 焦点陷阱（按 scope 分组，每组最后一项 → 跳回第一项）。
 * - 打开时焦点收敛到「关闭」按钮（避免误触；其他按钮都是展示性质的）。
 * - 按 scope 分四组标题：**全局 / 工作台 / 看板 / 任务页**。
 * - 每行：左侧 `<kbd>` 块显示快捷键，右侧描述。`<kbd>` 用 design-tokens 等宽字体。
 * - 颜色 / 字号 / 圆角一律取 `C / R / S / T / F / shared`；不写颜色字面量。
 *
 * 不做的事：
 * - 不接管全局键盘事件（全局快捷键监听是 `app/page.tsx` 的责任，这里只渲染）。
 * - 不做平台分支 —— `SHORTCUTS.display` 已经包含 Mac/Win 双标。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { C, F, R, S, T } from '@/lib/design-tokens';
import {
  SHORTCUTS,
  formatShortcut,
  type ShortcutScope,
  type ShortcutSpec,
} from '@/lib/shortcuts';

export interface ShortcutsDialogProps {
  /** 受控开关。true = 渲染；false/undefined = 不渲染。 */
  open?: boolean;
  /** 点关闭按钮 / 点遮罩 / Escape 时回调。父组件拿到这个去关 `open`。 */
  onClose: () => void;
}

// ── 样式 ─────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  zIndex: 80,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: S.lg,
};

const cardStyle: CSSProperties = {
  background: C.surfaceHi,
  color: C.text,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.xl,
  padding: S.xl,
  minWidth: 420,
  maxWidth: 560,
  width: '100%',
  maxHeight: 'min(80vh, 720px)',
  overflowY: 'auto',
  boxShadow: '0 24px 60px rgba(0, 0, 0, 0.5)',
  fontFamily: F.sans,
  fontSize: T.body,
};

const titleStyle: CSSProperties = {
  margin: 0,
  marginBottom: S.xs,
  fontSize: T.h3,
  fontWeight: 600,
  color: C.text,
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  marginBottom: S.lg,
  color: C.textDim,
  fontSize: T.body,
  lineHeight: 1.55,
};

const groupTitleStyle: CSSProperties = {
  margin: `${S.lg}px 0 ${S.sm}px`,
  fontSize: T.sm,
  fontWeight: 600,
  color: C.textGhost,
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: S.md,
  padding: `${S.sm}px 0`,
};

const descStyle: CSSProperties = {
  color: C.textDim,
  fontSize: T.body,
  flex: 1,
  minWidth: 0,
};

const kbdStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.base,
  color: C.text,
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: `2px ${S.sm}px`,
  whiteSpace: 'nowrap',
};

const actionsRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: S.xl,
};

const closeBtnStyle: CSSProperties = {
  padding: `${S.sm}px ${S.md}px`,
  borderRadius: R.md,
  fontSize: T.body,
  fontWeight: 500,
  fontFamily: F.sans,
  cursor: 'pointer',
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
};

// ── 分组排序 ─────────────────────────────────────────────────────

// scope 的展示顺序：全局 → 工作台 → 看板 → 任务页。
// 用 const tuple 而不是 enum：保证遍历顺序可预测，渲染时不依赖 locale。
const SCOPE_ORDER: ReadonlyArray<{ scope: ShortcutScope; title: string }> = [
  { scope: 'global', title: '全局' },
  { scope: 'workspace', title: '工作台' },
  { scope: 'board', title: '看板' },
  { scope: 'todo', title: '任务页' },
];

function groupByScope(): Array<{ scope: ShortcutScope; title: string; items: ShortcutSpec[] }> {
  const out: Array<{ scope: ShortcutScope; title: string; items: ShortcutSpec[] }> = [];
  for (const { scope, title } of SCOPE_ORDER) {
    const items = SHORTCUTS.filter((s) => s.scope === scope);
    // 没条目的 scope 跳过 —— 帮助面板要精简，不显示空标题。
    if (items.length === 0) continue;
    out.push({ scope, title, items });
  }
  return out;
}

// ── 组件 ─────────────────────────────────────────────────────────

export default function ShortcutsDialog(props: ShortcutsDialogProps): ReactElement | null {
  const { open, onClose } = props;

  const [mounted, setMounted] = useState<boolean>(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 打开时挂载 + 收敛焦点到「关闭」按钮。
  useEffect(() => {
    if (!open) return;
    setMounted(true);
    const t = setTimeout(() => {
      closeRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  // Escape 关闭。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Tab 焦点陷阱：tab 到最后一个可达元素 → 回到关闭按钮，避免用户在 dialog 内 tab 出走。
  // 用 cardRef 做容器查询 —— `<kbd>` 不可聚焦，所以可达元素就是「关闭」按钮自己。
  useEffect(() => {
    if (!open) return;
    function onTab(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const root = cardRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onTab);
    return () => document.removeEventListener('keydown', onTab);
  }, [open]);

  const handleOverlayClick = (
    e: React.MouseEvent<HTMLDivElement>,
  ): void => {
    // 只在点的就是遮罩本身（不是 child）时关 —— 避免点 kbd 文本/卡片内文字被关。
    if (e.target === overlayRef.current) onClose();
  };

  const groups = useMemo(() => groupByScope(), []);

  // 没开就不渲染 —— SSR 阶段 document.body 还不能用。
  if (!open || typeof document === 'undefined' || !mounted) return null;

  return createPortal(
    <div
      ref={overlayRef}
      role="presentation"
      onClick={handleOverlayClick}
      style={overlayStyle}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        style={cardStyle}
      >
        <h3 id="shortcuts-dialog-title" style={titleStyle}>
          快捷键
        </h3>
        <p style={subtitleStyle}>
          按 <kbd style={kbdStyle}>Esc</kbd> 关闭。
        </p>

        {groups.map((g) => (
          <section key={g.scope} aria-labelledby={`shortcuts-group-${g.scope}`}>
            <h4 id={`shortcuts-group-${g.scope}`} style={groupTitleStyle}>
              {g.title}
            </h4>
            {g.items.map((s) => (
              <div key={s.keys} style={rowStyle}>
                <span style={descStyle}>{s.description}</span>
                <kbd style={kbdStyle}>{formatShortcut(s)}</kbd>
              </div>
            ))}
          </section>
        ))}

        <div style={actionsRowStyle}>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            style={closeBtnStyle}
          >
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}