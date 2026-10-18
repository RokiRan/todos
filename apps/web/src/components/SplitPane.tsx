'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { C, R } from '@/lib/design-tokens';

/**
 * 可拖动分割线的双栏容器 —— Workspace 布局的核心组件。
 *
 * 原站语义（`docs-chief.md:14-20`）：
 *   - 宽屏（≥ 1024px）：左对话 + 右看板 + 6px 命中区 divider，可拖
 *   - 窄屏（<  1024px）：退化为单栏 + 顶部 toggle 按钮（**不是手势滑动**——
 *     原站窄屏是分层页面 + 滑动；本复刻不做手势 UI，改用按钮切换，且在 UI 上
 *     注明「与原站差异」）
 *   - 拖到 divider 最左 = 折叠对话，看板全宽（foldLeftToZero 行为）
 *   - 拖回左边缘 = 重新展开
 *   - divider 是 `role="separator"` + `tabIndex=0`，方向键步进 24px，
 *     Home/End 直达两端
 *
 * **拖拽实现**：鼠标事件挂 window 上（不挂 divider —— 鼠标移出 divider
 * 也要继续追踪），mouseup 时**必须** `removeEventListener`，否则每拖一次
 * 泄漏一次监听。
 *
 * **宽度持久化**：用 localStorage。读出来要做合法性校验：非有限数字、
 * < 0 或 > 100 都丢弃用默认值 —— 否则一个坏值能让布局永久坏掉（典型表现：
 * 拖到 >100 让右栏被推到屏幕外）。
 */

const NARROW_BREAKPOINT = 1024;
const DEFAULT_LEFT_PCT = 42;
const MIN_LEFT_PCT = 0;
const MAX_LEFT_PCT = 85;     // 给看板留至少 15% —— 看板列宽 ≈308px，窄屏比例
                              // 用户自己拖也很容易把它挤没
const FOLD_THRESHOLD_PCT = 2; // 拖到 ≤ 2% 时算「折叠」，让 foldLeftToZero 体验自然
const KEY_STEP_PCT = 3;      // ← / → 一次步进 ≈ 24px @ 800px 内容宽度
const DIVIDER_PX = 6;        // 命中区宽度（视觉窄但点击宽容）

export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** localStorage key。省略则不持久化（每会话默认值）。 */
  storageKey?: string;
  /**
   * 拖到最左时是否把左栏归 0。true = 原站「折叠对话」语义；省略 = 纯弹性布局，
   * 拖到 0 也仍按 0% 渲染（不留返回按钮），仍可拖回。
   */
  foldLeftToZero?: boolean;
  /**
   * 外部强制折叠开关（如 ⌘⇧Enter 快捷键）。为 true 时无论 leftPct 多大
   * 都把左栏宽度归 0 —— 不写 localStorage（避免覆盖用户的拖拽习惯）。
   */
  forceFolded?: boolean;
  /**
   * 折叠态下用户点「返回对话」按钮时回调。`forceFolded=true` 时回调里
   * 应该调用 `setConversationFolded(false)`；拖拽折叠态下回调里应该
   * 把 `leftPct` 拉回默认。省略则只动 leftPct（拖拽语义）。
   */
  onUnfold?: () => void;
}

export function SplitPane({
  left,
  right,
  storageKey,
  foldLeftToZero = false,
  forceFolded = false,
  onUnfold,
}: SplitPaneProps): React.JSX.Element {
  // ── 窄屏检测：1024 是与 L.sidebarW 240 + 看板 4 列 × 308 算出的临界值。
  // 用 matchMedia 监听变化（用户拖窗）而不是只在挂载时读 window.innerWidth。───
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < NARROW_BREAKPOINT;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent): void => setIsNarrow(e.matches);
    setIsNarrow(mq.matches);
    // Safari 14 以下 addListener / 新版 addEventListener 都支持
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  // ── 宽度：百分比（0-100）持久化 ───────────────────────────────────
  const clamp = (v: number): number => Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, v));

  const readStored = useCallback((): number => {
    if (!storageKey) return DEFAULT_LEFT_PCT;
    if (typeof window === 'undefined') return DEFAULT_LEFT_PCT;
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return DEFAULT_LEFT_PCT;
    const n = Number(raw);
    // 严格校验：NaN / Infinity / 越界都丢弃。Number('') 是 0，Number('abc') 是 NaN
    if (!Number.isFinite(n)) return DEFAULT_LEFT_PCT;
    return clamp(n);
  }, [storageKey]);

  const [leftPct, setLeftPctState] = useState<number>(readStored);

  const setLeftPct = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setLeftPctState(clamped);
      if (storageKey && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, String(clamped));
        } catch {
          // localStorage 可能被禁用 —— 吞掉，运行时内存态仍生效
        }
      }
    },
    [storageKey],
  );

  // ── 拖拽状态 ────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<boolean>(false);

  const beginDrag = (clientX: number): void => {
    if (isNarrow) return;
    draggingRef.current = true;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const startPct = leftPct;
    const widthPx = rect.width;

    const onMove = (e: MouseEvent): void => {
      const dx = e.clientX - clientX;
      const dPct = (dx / widthPx) * 100;
      setLeftPct(startPct + dPct);
    };
    const onUp = (): void => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── 键盘可访问性 ────────────────────────────────────────────────
  function onKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (isNarrow) return;
    let next = leftPct;
    switch (e.key) {
      case 'ArrowLeft':
        next = leftPct - KEY_STEP_PCT;
        break;
      case 'ArrowRight':
        next = leftPct + KEY_STEP_PCT;
        break;
      case 'Home':
        next = MIN_LEFT_PCT;
        break;
      case 'End':
        next = MAX_LEFT_PCT;
        break;
      default:
        return;
    }
    e.preventDefault();
    setLeftPct(next);
  }

  // ── 折叠语义 ────────────────────────────────────────────────────
  // 三个折叠条件取或：
  //   1. foldLeftToZero 且拖到 ≤ 2%  —— 拖拽折叠
  //   2. forceFolded                    —— 外部强制（⌘⇧Enter）
  //   3. forceUnfolded 为 false 时不算折叠
  const isFolded =
    (foldLeftToZero && leftPct <= FOLD_THRESHOLD_PCT) || forceFolded;

  // ── 渲染 ─────────────────────────────────────────────────────────
  if (isNarrow) {
    // 窄屏：单栏显示，顶部 toggle 按钮切换。
    // 注意：与原站差异 —— 原站窄屏是「分层页面 + 滑动切换」，本复刻不做手势，
    // 用按钮。差异在父页面（首页）头部展示，让用户能直接看到。
    const [active, setActive] = useState<'left' | 'right'>('left');
    return (
      <div style={containerStyle}>
        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 8,
            padding: 4,
            background: C.surface,
            borderRadius: R.md,
            border: `1px solid ${C.line}`,
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active === 'left'}
            onClick={() => setActive('left')}
            style={{
              ...narrowTabStyle,
              ...(active === 'left' ? narrowTabActiveStyle : null),
            }}
          >
            对话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active === 'right'}
            onClick={() => setActive('right')}
            style={{
              ...narrowTabStyle,
              ...(active === 'right' ? narrowTabActiveStyle : null),
            }}
          >
            看板
          </button>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: C.textGhost,
              alignSelf: 'center',
            }}
            title="原站窄屏用滑动切换；本复刻改用按钮"
          >
            窄屏 · 按钮切换（原站：滑动）
          </span>
        </div>
        <div style={{ display: active === 'left' ? 'block' : 'none' }}>{left}</div>
        <div style={{ display: active === 'right' ? 'block' : 'none' }}>{right}</div>
      </div>
    );
  }

  // 宽屏：双栏 + 可拖 divider
  return (
    <div ref={containerRef} style={containerStyle}>
      <div
        style={{
          // 折叠时左栏宽度归 0；保持 DOM 挂载可减少 SSE 重连
          width: isFolded ? 0 : `${leftPct}%`,
          minWidth: 0,
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'width 80ms ease',
        }}
      >
        {left}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN_LEFT_PCT}
        aria-valuemax={MAX_LEFT_PCT}
        aria-valuenow={Math.round(leftPct)}
        aria-label="对话与看板的分隔线；左右方向键调整，Home/End 跳到两端"
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
          beginDrag(e.clientX);
        }}
        onKeyDown={onKey}
        // 不在拖拽中也允许用 divider 上的双击跳到默认 50%
        onDoubleClick={() => setLeftPct(50)}
        style={{
          width: DIVIDER_PX,
          cursor: 'col-resize',
          flexShrink: 0,
          background: 'transparent',
          position: 'relative',
          outline: 'none',
          // 焦点环：divider 本身只有 6px，焦点态要给视觉粗的环
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 2,
            width: 2,
            background: C.line,
            borderRadius: 1,
          }}
        />
      </div>

      <div
        style={{
          // 折叠时右栏占满（去掉左侧 width）
          flex: 1,
          minWidth: 0,
          position: 'relative',
        }}
      >
        {right}
        {/* 折叠时把「返回对话」按钮叠在右侧顶部，靠近 divider 一侧 */}
        {isFolded && (
          <button
            type="button"
            aria-label="展开对话栏"
            onClick={() => {
              // 拖拽折叠：把左栏拉回默认；外部强制折叠（forceFolded）：让
              // 调用方去取消外部状态（onUnfold 回调）。两个动作都跑，
              // forceFolded 的解除靠 onUnfold 自己。
              setLeftPct(DEFAULT_LEFT_PCT);
              onUnfold?.();
            }}
            style={unfoldBtnStyle}
          >
            ‹ 返回对话
          </button>
        )}
      </div>
    </div>
  );
}

// ── 样式 ──────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  height: '100%',
  alignItems: 'stretch',
  gap: 0,
};

const narrowTabStyle: CSSProperties = {
  flex: 1,
  padding: '6px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  color: C.textDim,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

const narrowTabActiveStyle: CSSProperties = {
  background: C.surfaceHi,
  color: C.text,
};

const unfoldBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 10,
  padding: '6px 12px',
  background: C.surface,
  color: C.text,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
};