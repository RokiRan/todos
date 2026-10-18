'use client';

/**
 * 通用确认对话框 —— 本项目目前没有对话框基建。
 *
 * 为什么独立于所有切片：原站 `docs-todos.md` B1：「a confirmation dialog appears
 * first, with Merge changes checked by default」（合并确认框）。BFF/proxyWrite 这条
 * 链路没改，只是包了一层用户可见的二次确认壳，所以是**纯前端**组件。
 *
 * 设计要点：
 * - 复用 design-tokens（C/R/S/T/shared），不写字面量颜色
 * - portal 到 document.body，z-index 高于侧栏（实测 40，对话框 80）
 * - a11y：Escape 关闭、点遮罩关闭、确认按钮获焦（不是必填/危险型也让确认按钮获焦，
 *   因为这是「最后一道确认」典型场景；危险态仍用红色按钮 + 同获焦）
 * - defaultChecked：合并那个用例需要「默认勾选 → 用户不改就同意」，
 *   用受控 checkbox 让外部监听 onChange 而不是 ref，免去每个调用方自己拉状态
 * - onConfirm / onCancel 都是 void：调用方各自关 dialog 或开 dialog，组件本身不持有
 *   open 状态，由调用方控制 open 渲染（更便于「根据 open 重置内部表单」语义）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { C, F, R, S, T } from '@/lib/design-tokens';

export interface ConfirmDialogProps {
  title: string;
  /** 正文 —— ReactNode，因为 B1 用例需要塞一个带勾选块的描述。 */
  children: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险态：确认按钮变红描边。默认常规。 */
  danger?: boolean;
  /** 打开时焦点收敛到哪：confirm | cancel。默认 confirm（再确认一下最关键的动作）。 */
  initialFocus?: 'confirm' | 'cancel';
  /**
   * 默认勾选状态。**只用于合并那个「Leave it checked = 同意合并」原始站语义**：
   * 用户不改就同意合并。改了 checkbox 就把 true/false 透传给 onConfirm。
   * 不传这个 prop：组件不渲染底部那个 checkbox 行，行为退化成最简单的「点是/否」。
   */
  defaultChecked?: boolean;
  /** 用户改了 checkbox 时同步外部。checkbox 自身没意义，只是「默认同意的开关」。 */
  onCheckedChange?: (checked: boolean) => void;
  onConfirm: (checked: boolean | undefined) => void;
  onCancel: () => void;
}

// ── 样式 ─────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  // 实测侧栏 z-index=40，对话框要更高，但不必挡住 modal server 错误 toast（约定 90）。
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
  padding: S.lg,
  minWidth: 360,
  maxWidth: 520,
  width: '100%',
  boxShadow: '0 24px 60px rgba(0, 0, 0, 0.5)',
  fontFamily: F.sans,
  fontSize: T.body,
};

const titleStyle: CSSProperties = {
  margin: 0,
  marginBottom: S.sm,
  fontSize: T.h3,
  fontWeight: 600,
  color: C.text,
};

const bodyStyle: CSSProperties = {
  color: C.textDim,
  fontSize: T.body,
  lineHeight: 1.55,
  marginBottom: S.md,
};

const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.sm,
  marginTop: S.md,
  marginBottom: S.md,
  padding: `${S.sm}px ${S.md}px`,
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  color: C.text,
  fontSize: T.body,
  cursor: 'pointer',
};

const checkboxInputStyle: CSSProperties = {
  // 不写字面量颜色，吃浏览器默认；保留焦点环（不重置 outline）。
  cursor: 'pointer',
};

const actionsRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: S.sm,
  marginTop: S.md,
};

const baseBtn: CSSProperties = {
  padding: `${S.sm}px ${S.md}px`,
  borderRadius: R.md,
  fontSize: T.body,
  fontWeight: 500,
  fontFamily: F.sans,
  cursor: 'pointer',
};

const primaryBtnStyle: CSSProperties = {
  ...baseBtn,
  background: C.accent,
  color: '#0b0b0f',
  border: 'none',
};

const dangerBtnStyle: CSSProperties = {
  ...baseBtn,
  background: 'transparent',
  color: C.danger,
  border: `1px solid ${C.danger}`,
};

const cancelBtnStyle: CSSProperties = {
  ...baseBtn,
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
};

// ── 组件 ─────────────────────────────────────────────────────────

export default function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
  const {
    title,
    children,
    confirmText = '确认',
    cancelText = '取消',
    danger = false,
    initialFocus = 'confirm',
    defaultChecked,
    onCheckedChange,
    onConfirm,
    onCancel,
  } = props;

  const [checked, setChecked] = useState<boolean>(defaultChecked ?? false);
  // 钩选跟随 dialog 重置 —— 同一个 ConfirmDialog 在调用方反复 open 时，应回到 defaultChecked
  // 而不是停留在上一次用户的选择；用 mounted 标记「本次打开」判定。
  const [mounted, setMounted] = useState<boolean>(false);

  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // 打开时重置状态 + 收敛焦点。
  useEffect(() => {
    setMounted(true);
    setChecked(defaultChecked ?? false);
    // focus 在 ref callback 之后下一拍，避免 React 还未挂 ref。
    const t = setTimeout(() => {
      if (initialFocus === 'cancel') cancelRef.current?.focus();
      else confirmRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [defaultChecked, initialFocus]);

  // Escape 关闭。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // 失焦陷阱：tab 在最后一个元素上 → 回到第一个。避免用户在 dialog 内 tab 出走。
  // 简化：监听 keydown 对 Tab 做兜底。
  useEffect(() => {
    function onTab(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const focusables: HTMLElement[] = [];
      if (cancelRef.current) focusables.push(cancelRef.current);
      if (confirmRef.current) focusables.push(confirmRef.current);
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
  }, []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      // 只在点的就是遮罩本身（不是 child）时关 —— 避免用户点输入框被关。
      if (e.target === overlayRef.current) onCancel();
    },
    [onCancel],
  );

  const handleConfirm = useCallback((): void => {
    // 只有渲染了 checkbox 时才把 checked 透出；否则 undefined 以示「本次无勾选概念」。
    onConfirm(defaultChecked === undefined ? undefined : checked);
  }, [checked, defaultChecked, onConfirm]);

  const handleCheckedChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const next = e.target.checked;
      setChecked(next);
      onCheckedChange?.(next);
    },
    [onCheckedChange],
  );

  const confirmBtnStyle = useMemo(
    () => (danger ? dangerBtnStyle : primaryBtnStyle),
    [danger],
  );

  // 没挂载不渲染 —— SSR 阶段 document.body 还不能用。
  if (typeof document === 'undefined' || !mounted) return null;

  return createPortal(
    <div
      ref={overlayRef}
      role="presentation"
      onClick={handleOverlayClick}
      style={overlayStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        style={cardStyle}
      >
        <h3 id="confirm-dialog-title" style={titleStyle}>
          {title}
        </h3>
        <div style={bodyStyle}>{children}</div>
        {defaultChecked !== undefined && (
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={checked}
              onChange={handleCheckedChange}
              style={checkboxInputStyle}
            />
            <span>合并变更（默认勾选；取消勾选只标记完成、不合并）</span>
          </label>
        )}
        <div style={actionsRowStyle}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={cancelBtnStyle}
          >
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirm}
            style={confirmBtnStyle}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
