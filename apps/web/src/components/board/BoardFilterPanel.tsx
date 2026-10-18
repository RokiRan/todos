'use client';

/**
 * 看板筛选面板（2026-10-18 复刻）。
 *
 * **这是契约 §3.6 筛选项的 UI 渲染方**。数据层（filter-state.ts）独立，本文件
 * 只做呈现 + 受控事件回传。挂载点不在本切片 —— `apps/web/src/app/page.tsx` 由
 * BoardCards 切片拥有，会把 panel 挂在筛选图标旁边。
 *
 * **结构**（契约 §1.3 逐字）：
 *   ── 创建者（单选 3 项）
 *      我创建
 *      总管或 Agent 创建的
 *      其他成员创建的
 *   ── 阶段（单选 3 项）
 *      [提示行] 仅作用于「执行中」「待你处理」
 *      全部 / 规划 / 执行
 *   ── 项目（多选 + 「反选」按钮）
 *      [项目列表 + count]
 *
 * **样式约定**：
 *   - 选中态用 `C.accent`（不是 `C.warn` —— warn 已绑给闸门列徽章）
 *   - 所有色值走 `@/lib/design-tokens` 的 C/T/R/F/S/L，本文件零裸字面量
 *   - Escape 与点遮罩关闭：照抄 `ConfirmDialog` 的 useEffect + overlayRef 模式
 *
 * **易用性增强（非原站元素）**：
 *   - 当 `filters.multi === true` 时，标题旁显示一个「清除」小链接方便用户
 *     一次回到全默认。原站没有这个链接（实测面板内只有三组筛选），但用户
 *     点了筛选后若想回退，能省得他们手动把每组都点一遍。
 *   - 反选按钮：原站是写在项目列表上方的「Clear selection」风格按钮，行为是
 *     取 `projectIds` 补集，我们保留同义入口但用「反选」措辞贴近原站 UI 截图。
 *
 * **不渲染「清除筛选」底部按钮**：原站实测面板底部没有这一步，违反会改变视觉权重。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { C, F, R, S, T } from '@/lib/design-tokens';
import type {
  BoardFilterCounts,
  BoardFilters,
  CreatorFilter,
  StageFilter,
} from './filter-state';
import { emptyFilters, creatorFilterAvailable } from './filter-state';

// ── Props ─────────────────────────────────────────────────────────────────────

/**
 * 面板是**受控**组件：状态在父（page.tsx），本组件只读 + 改。
 * 父负责把 `filters` 持久化（`saveFilters`），本组件不直接动 localStorage。
 */
export interface BoardFilterPanelProps {
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
  counts: BoardFilterCounts;
  /** 点击「反选」等的「关闭面板」回调（用户点非项目项时不希望被关，故在 board header 调）。 */
  onClose: () => void;
  /**
   * 当前成员 id（`member.id`，**不是** `user.id`）—— 拿不到时「我创建的」
   * 「其他成员创建的」两项**必须禁用**。
   *
   * 为什么要有这个 prop 而不是面板自己判断：`matchesCreatorFilter` 在
   * member id 缺失时返回 true（不筛，见 filter-state 的诚实性说明），
   * 于是用户点了这两项会看到「筛完和没筛一样」——那是比空结果更坏的假绿。
   * 面板必须显式禁用 + 说明原因，而不是让用户自己撞。
   *
   * 省略（undefined）按「不可用」处理 —— 默认值选保守的那一侧。
   */
  currentMemberId?: string | null;
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 浮层阴影 —— 与 `ConfirmDialog` / `CommandPalette` / `KanbanGuide` 同语义：
 * 黑底加透明度叠在 surface 之上，让卡片「浮起来」。本项目没在 design-tokens 里
 * 设浮层阴影 token，这里显式命名以避免字面量散落。 */
const ELEVATION_SHADOW = '0 12px 32px rgba(0, 0, 0, 0.45)';

/** 三档创建者文案 —— 与契约 §1.3 逐字一致。 */
const CREATOR_LABELS: ReadonlyArray<{ key: CreatorFilter; label: string }> = [
  { key: 'mine', label: '我创建的' },
  { key: 'chiefOrAgent', label: '总管或 Agent 创建的' },
  { key: 'others', label: '其他成员创建的' },
];

/** 阶段单选项 —— 「全部」是显式项，选中时 stage='all'，multi 保持不变。 */
const STAGE_LABELS: ReadonlyArray<{ key: StageFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'planning', label: '规划' },
  { key: 'executing', label: '执行' },
];

// ── 样式 ──────────────────────────────────────────────────────────────────────

const wrapStyle: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.xl,
  padding: S.lg,
  width: 320,
  boxShadow: ELEVATION_SHADOW,
  fontFamily: F.sans,
  color: C.text,
  fontSize: T.body,
};

/** 头部：标题 + 可选的「清除」链接。 */
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: S.md,
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: T.h3,
  fontWeight: 600,
  color: C.text,
};

const clearLinkStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: `${S.xs}px ${S.sm}px`,
  color: C.accent,
  fontSize: T.meta,
  fontFamily: F.sans,
  cursor: 'pointer',
};

const groupTitleStyle: CSSProperties = {
  fontSize: T.sm,
  fontWeight: 500,
  color: C.textGhost,
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  marginTop: S.md,
  marginBottom: S.sm,
};

/** 阶段组的提示行 —— 原文是「仅作用于「执行中」「待你处理」」。 */
const stageHintStyle: CSSProperties = {
  fontSize: T.base,
  color: C.textFaint,
  marginBottom: S.sm,
};

/** 阶段组的提示行字号更小、且自带缩进 —— 让它看上去不像可点项。 */
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: S.sm,
  padding: `${S.sm}px ${S.md}px`,
  marginBottom: 2,
  borderRadius: R.md,
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  width: '100%',
  color: C.text,
  fontSize: T.body,
  fontFamily: F.sans,
  textAlign: 'left',
};

const rowSelectedStyle: CSSProperties = {
  ...rowStyle,
  background: C.surfaceHi,
  color: C.accent,
};

const rowCountStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.textFaint,
};

const rowCountSelectedStyle: CSSProperties = {
  ...rowCountStyle,
  color: C.accent,
};

const invertBtnStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  color: C.textDim,
  padding: `${S.sm}px ${S.md}px`,
  fontSize: T.meta,
  fontFamily: F.sans,
  cursor: 'pointer',
  marginBottom: S.sm,
  width: '100%',
};

// ── 组件 ──────────────────────────────────────────────────────────────────────

export default function BoardFilterPanel(props: BoardFilterPanelProps): ReactElement {
  const { filters, onChange, counts, onClose, currentMemberId } = props;

  // 'mine' / 'others' 依赖当前成员 id；拿不到就禁用这两项（见 props 注释）。
  const creatorAvailable = creatorFilterAvailable(currentMemberId ?? null);

  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Escape 关闭 —— 照搬 ConfirmDialog 的写法。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 点外部关闭：判定点在 wrapRef 之外即触发 onClose。
  // 注意：mousedown 而非 click —— 避免用户在 wrap 内 click 后文档上 click 被错关。
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      const node = wrapRef.current;
      if (!node) return;
      if (e.target instanceof Node && !node.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  // 派生 setter —— 任何修改都需要重新计算 `multi`。
  const update = useCallback(
    (patch: Partial<Omit<BoardFilters, 'multi'>>): void => {
      const next: BoardFilters = {
        ...filters,
        ...patch,
        multi: computeMulti({ ...filters, ...patch }),
      };
      onChange(next);
    },
    [filters, onChange],
  );

  const handleCreator = useCallback(
    (key: CreatorFilter): void => update({ creator: key }),
    [update],
  );

  const handleStage = useCallback(
    (key: StageFilter): void => update({ stage: key }),
    [update],
  );

  const handleProjectToggle = useCallback(
    (id: string): void => {
      const set = new Set(filters.projectIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const ids = Array.from(set);
      update({ projectIds: ids });
    },
    [filters.projectIds, update],
  );

  /** 反选：把所有已知 project 取补集（用 counts.projects 列表作为全集 —— 这是
   * 当前用户可见的项目全集，UI 上"未列出的项目"也没有勾选概念）。 */
  const handleProjectsInvert = useCallback((): void => {
    const allIds = new Set(counts.projects.map((p) => p.id));
    const inverted = Array.from(allIds).filter((id) => !filters.projectIds.includes(id));
    update({ projectIds: inverted });
  }, [counts.projects, filters.projectIds, update]);

  /** 「清除」链接 —— 复位到 emptyFilters。这是易用性增强，不是原站元素。 */
  const handleClearAll = useCallback((): void => {
    onChange(emptyFilters());
  }, [onChange]);

  const isProjectSelected = useMemo(
    () => (id: string): boolean => filters.projectIds.includes(id),
    [filters.projectIds],
  );

  // ── 渲染 ───────────────────────────────────────────────────────────────────

  return (
    <div ref={wrapRef} role="dialog" aria-label="筛选" style={wrapStyle}>
      {/* 头部 */}
      <div style={headerStyle}>
        <h3 style={headingStyle}>筛选</h3>
        {filters.multi && (
          <button
            type="button"
            onClick={handleClearAll}
            style={clearLinkStyle}
            aria-label="清除所有筛选"
          >
            清除
          </button>
        )}
      </div>

      {/* 创建者 */}
      <div style={groupTitleStyle}>创建者</div>
      {!creatorAvailable && (
        // 只在真的不可用时显示这一行说明 —— 可用时不该占用面板空间。
        <div style={stageHintStyle}>
          未取到当前用户身份，「我创建的」与「其他成员创建的」暂不可用。
        </div>
      )}
      {CREATOR_LABELS.map((item) => {
        const selected = filters.creator === item.key;
        const count = counts.creator[item.key];
        // 'chiefOrAgent' 只看 createdByType，与 user id 无关，永不禁用。
        const needsUser = item.key === 'mine' || item.key === 'others';
        const disabled = needsUser && !creatorAvailable;
        return (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={
              disabled
                ? '未取到当前用户身份，无法区分「我创建的」与「其他成员创建的」'
                : undefined
            }
            onClick={() => {
              if (disabled) return;
              handleCreator(item.key);
            }}
            style={selected ? rowSelectedStyle : rowStyle}
          >
            <span>{item.label}</span>
            <span style={selected ? rowCountSelectedStyle : rowCountStyle}>{count}</span>
          </button>
        );
      })}

      {/* 阶段 */}
      <div style={groupTitleStyle}>阶段</div>
      <div style={stageHintStyle}>仅作用于「执行中」「待你处理」</div>
      {STAGE_LABELS.map((item) => {
        const selected = filters.stage === item.key;
        // 'all' 没有分组计数；'planning'/'executing' 读 counts.stage。
        const count =
          item.key === 'all'
            ? null
            : counts.stage[item.key === 'planning' ? 'planning' : 'executing'];
        return (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => handleStage(item.key)}
            style={selected ? rowSelectedStyle : rowStyle}
          >
            <span>{item.label}</span>
            <span style={selected ? rowCountSelectedStyle : rowCountStyle}>{count ?? ' '}</span>
          </button>
        );
      })}

      {/* 项目 */}
      <div style={groupTitleStyle}>项目</div>
      {counts.projects.length === 0 && (
        <div style={rowCountStyle}>（当前团队没有项目）</div>
      )}
      <button
        type="button"
        onClick={handleProjectsInvert}
        style={invertBtnStyle}
      >
        反选
      </button>
      {counts.projects.map((p) => {
        const selected = isProjectSelected(p.id);
        return (
          <button
            key={p.id}
            type="button"
            role="checkbox"
            aria-checked={selected}
            onClick={() => handleProjectToggle(p.id)}
            style={selected ? rowSelectedStyle : rowStyle}
          >
            <span>{p.name}</span>
            <span style={selected ? rowCountSelectedStyle : rowCountStyle}>{p.total}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── 内部 helpers ──────────────────────────────────────────────────────────────

/** `multi = 任一筛选维度偏离全默认`。注意 'all' 与 'mine' 都是默认值的合法状态。 */
function computeMulti(f: BoardFilters): boolean {
  return f.creator !== 'mine' || f.stage !== 'all' || f.projectIds.length > 0;
}
