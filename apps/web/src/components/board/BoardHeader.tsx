'use client';

/**
 * 看板标题栏（`aria-label="看板指南"` 同侧）。
 *
 * 契约 §3.5 冻结 props：`filters / onFiltersChange / filterOpen / onFilterOpenChange /
 * counts / onToggleFullscreen / onOpenShortcuts`。BoardCards 切片接线时会传入这些。
 *
 * 类型说明：本文件**没有**复用到 `apps/web/src/components/board/filter-state.ts`
 * 的 `BoardFilters / BoardFilterCounts` —— 那个文件由 BoardFilters 切片拥有，
 * 集成阶段两边的类型会被对齐。这里用同形（structural）的本地最小接口，
 * BoardCards 接线时直接传结构化兼容的 props 即可（不需要 import）。
 *
 * 布局冻结（实测原站）：
 *   `看板` 标题 → 圆问号图标（aria-label="看板指南"）→ 弹性空隙
 *   → 漏斗图标（aria-label="筛选"）→ 「看板全屏」文字按钮 → 快捷键按钮（`Ctrl /` 角标）。
 * 高度 44px，下边框 `1px solid C.line`。
 *
 * 标题栏**没有**面板图标（实测 §1.2）：别加。
 *
 * 颜色 / 字号 / 圆角 / 间距一律取 `design-tokens`，不写字面量。
 */

import {
  type CSSProperties,
  type ReactElement,
} from 'react';
import { C, F, R, S, T } from '@/lib/design-tokens';

// ── 类型（与契约 §3.5 同形；不导入 filter-state 以免跨切片依赖） ──

/** 与契约 §3.6 的 `CreatorFilter` 同形（结构化兼容即可）。 */
export type CreatorFilter = 'mine' | 'chiefOrAgent' | 'others';
/** 与契约 §3.6 的 `StageFilter` 同形。 */
export type StageFilter = 'all' | 'planning' | 'executing';

/** 与契约 §3.6 的 `BoardFilters` 同形。 */
export interface BoardFiltersShape {
  creator: CreatorFilter;
  stage: StageFilter;
  projectIds: string[];
  multi: boolean;
}

/** 与契约 §3.6 的 `BoardFilterCounts` 同形。 */
export interface BoardFilterCountsShape {
  creator: Record<CreatorFilter, number>;
  stage: Record<Exclude<StageFilter, 'all'>, number>;
  projects: Array<{ id: string; name: string; total: number }>;
}

/** 契约 §3.5 冻结的 props。 */
export interface BoardHeaderProps {
  /** 全局筛选状态，初始值由 filter-state 读 localStorage 得出。 */
  filters: BoardFiltersShape;
  onFiltersChange: (next: BoardFiltersShape) => void;
  /** 筛选面板是否开着（受控）。 */
  filterOpen: boolean;
  onFilterOpenChange: (open: boolean) => void;
  /** 各分组实时计数。 */
  counts: BoardFilterCountsShape;
  /** 「看板全屏」按钮回调（`Ctrl Shift Enter`）。 */
  onToggleFullscreen: () => void;
  /** 快捷键面板打开回调（`Ctrl /`）。 */
  onOpenShortcuts: () => void;
  /**
   * 5 步引导打开回调。
   *
   * **为什么不在契约 §3.5 冻结 props 里**：契约只列了 7 个写路径相关的回调，
   * 引导是只读的展示型入口，可以不传（不传时不渲染问号图标，但标题栏布局
   * 仍然完整 —— flex spacer 顶替问号的宽度，不会塌陷）。
   * 这让 BoardCards 切片可以选择「在 page 里挂 KanbanGuide + 把回调传进来」
   * 或「Header 内不挂引导，由 page 单独渲染 KanbanGuideTrigger」两种接线方式。
   */
  onOpenGuide?: () => void;
}

// ── 样式 ─────────────────────────────────────────────────────────

const BAR_H = 44;

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.sm,
  height: BAR_H,
  padding: `0 ${S.lg}px`,
  borderBottom: `1px solid ${C.line}`,
  background: C.bg,
  fontFamily: F.sans,
};

const titleStyle: CSSProperties = {
  fontSize: T.sm,
  fontWeight: 500,
  color: C.text,
  margin: 0,
  padding: `0 ${S.sm}px`,
  letterSpacing: '0.2px',
};

const spacerStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const iconBtnStyle: CSSProperties = {
  width: 24,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  color: C.textFaint,
};

// 激活态的漏斗按钮：用 surfaceHi 做底色提示「面板开着」。
// 设计令牌里没有"激活图标按钮"专色 —— 用 surfaceHi + 强调色描边近似，
// 不写字面量颜色。
const iconBtnActiveStyle: CSSProperties = {
  ...iconBtnStyle,
  background: C.surfaceHi,
  borderRadius: R.md,
  color: C.text,
};

const textBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: C.textDim,
  fontFamily: F.sans,
  fontSize: T.body,
  padding: `${S.xs}px ${S.sm}px`,
};

const shortcutsBtnStyle: CSSProperties = {
  ...iconBtnStyle,
  color: C.textDim,
};

// 「Ctrl /」角标（实测在按钮右侧的小字）。
const shortcutsHintStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.textFaint,
  marginLeft: S.xs,
};

// ── 组件 ─────────────────────────────────────────────────────────

export default function BoardHeader(props: BoardHeaderProps): ReactElement {
  const {
    filterOpen,
    onFilterOpenChange,
    onToggleFullscreen,
    onOpenShortcuts,
    onOpenGuide,
  } = props;

  const handleFilterClick = (): void => {
    onFilterOpenChange(!filterOpen);
  };

  // 不传 onOpenGuide 时把问号位置留空 —— 占位用同尺寸空 div，避免布局塌陷。
  // 这让父组件既能选择接线（传 onOpenGuide）又能选择不接线（让 page 自己渲染触发）。
  const guideSlotStyle: CSSProperties = {
    width: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div style={barStyle}>
      <span style={titleStyle}>看板</span>

      {/* 圆问号图标按钮 —— 触发 5 步引导。
          onOpenGuide 可选：不传时这个槽位渲染空占位 div，flex 宽度一致，
          不会改变标题栏布局（契约冻结的「5 元素横排」依然成立）。 */}
      {onOpenGuide ? (
        <button
          type="button"
          aria-label="看板指南"
          tabIndex={0}
          onClick={onOpenGuide}
          style={iconBtnStyle}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </svg>
        </button>
      ) : (
        <div style={guideSlotStyle} aria-hidden="true" />
      )}

      {/* —— flex 间隔 —— */}
      <div style={spacerStyle} />

      {/* 漏斗图标：筛选按钮。激活态（filterOpen=true）用 surfaceHi 提示面板开着。 */}
      <button
        type="button"
        aria-label="筛选"
        tabIndex={0}
        onClick={handleFilterClick}
        style={filterOpen ? iconBtnActiveStyle : iconBtnStyle}
        aria-pressed={filterOpen}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
      </button>

      {/* 看板全屏（文字按钮） */}
      <button
        type="button"
        onClick={onToggleFullscreen}
        style={textBtnStyle}
        aria-label="看板全屏"
      >
        看板全屏
      </button>

      {/* 快捷键按钮：图标 + `Ctrl /` 角标 */}
      <button
        type="button"
        onClick={onOpenShortcuts}
        style={shortcutsBtnStyle}
        aria-label="查看全部快捷键"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01" />
          <path d="M10 10h.01" />
          <path d="M14 10h.01" />
          <path d="M18 10h.01" />
          <path d="M8 14h8" />
        </svg>
        <span style={shortcutsHintStyle}>Ctrl /</span>
      </button>
    </div>
  );
}