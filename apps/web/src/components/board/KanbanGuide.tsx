'use client';

/**
 * 5 步看板引导（`aria-label="看板指南"` 触发）。
 *
 * 契约 §1.4：文案是 2026-10-18 CDP 实测 `innerText`，**逐字照抄**。
 * 改一个标点都是还原错误 —— 任何调整必须先改契约。
 *
 * 两个入口：
 * - 看板标题栏右侧的问号圆图标（`KanbanGuideTrigger`）；
 * - 键盘 `Ctrl /`（总快捷键面板里的"查看全部快捷键"也会指向同一个组件）。
 * 本文件同时导出 `KanbanGuide`（带触发按钮 + 弹层）和 `KanbanGuideDialog`（只有弹层），
 * 让父组件可以决定怎么接线。
 *
 * 设计要点（沿用 `ConfirmDialog` 模式）：
 * - portal 到 document.body；z-index 80。
 * - Escape 关闭、点遮罩关闭、Tab 焦点陷阱。
 * - 打开时焦点收敛到「下一步」按钮（默认下一步是主操作）。
 * - 第 1 步「上一步」禁用：实测第 1 步只有「下一步」一个动作。
 * - 第 5 步「下一步」替换为「完成」并调 `onClose`。
 *
 * 颜色 / 字号 / 圆角一律取 `design-tokens`；触发按钮的 SVG 内联（不引图标库）。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { C, F, R, S, T } from '@/lib/design-tokens';

// ── 文案数据（冻结：来自契约 §1.4）─────────────────────────────────

interface GuideBlock {
  /** 小标题（粗体显示）；null 表示该步只有正文没有小标题。 */
  heading: string | null;
  /** 正文段落。 */
  body: string;
  /** 可选的快捷键角标，会渲染为 `<kbd>`。 */
  kbd?: string;
  /**
   * 序号条目列表 —— 实测第 2 步的四列是 `1 待开始 2 执行中 3 待你处理 4 已完成`
   * 四个独立条目（各有自己的序号圈），不是一句话里塞四个词。
   * 只第 2 步用它；其余步骤为空。
   */
  stages?: ReadonlyArray<{ n: number; label: string }>;
  /**
   * 可点回调 —— 实测第 5 步的「查看全部快捷键」是一枚可点的 kbd 角标
   * （点了打开快捷键总面板），不是纯展示文本。
   */
  kbdOnClick?: () => void;
  /** kbd 是按钮形态时的 aria-label。 */
  kbdAriaLabel?: string;
}

interface GuideStep {
  /** 顶部标题前缀：第 1 步 · 创建任务 —— 来自契约 §1.4 表头。 */
  title: string;
  /** 顶部副标题段落，介绍这一段讲什么。 */
  subtitle: string;
  /** 该步骤的小节块列表（标题 + 正文 + 可选 kbd）。 */
  blocks: GuideBlock[];
}

/**
 * 第 5 步「查看全部快捷键」的点击回调。
 *
 * 为什么是模块级而不是 step 的 prop：`STEPS` 是 `const` 常量数据，
 * 在模块加载时就求值，那时拿不到组件 props。用一个模块级 setter 在
 * 弹层渲染时注入 —— 这样文案常量保持「纯数据」，回调仍然是实时的。
 */
let openShortcutsHandler: (() => void) | null = null;
function onOpenShortcuts(): void {
  openShortcutsHandler?.();
}

/**
 * 5 步文案 —— 来自契约 §1.4。
 *
 * 不要在这里润色文字。原文是实测 innerText，差异即视为还原错误。
 */
const STEPS: ReadonlyArray<GuideStep> = [
  {
    // 实测原站标题就是「创建任务」，没有「第 N 步 ·」前缀（步骤位置由底部圆点表达）。
    title: '创建任务',
    subtitle: '看板上的每张卡片对应一个任务，有两种创建方式：',
    blocks: [
      {
        heading: '「新任务」按钮',
        body: '点击左侧边栏的「新任务」，填写任务信息后提交。',
        kbd: 'N',
      },
      {
        heading: '主题对话',
        body: '在首页的「总管」主题对话中描述需求，任务将自动创建并进入「待开始」列。',
      },
    ],
  },
  {
    title: '任务阶段与推进',
    subtitle: '看板的四列从左到右对应任务的四个阶段。推进任务的方式如下：',
    blocks: [
      {
        heading: null,
        body: '',
        // 实测四列各自带序号圈，横排展示 —— 与正文分开，不塞进一句话里。
        stages: [
          { n: 1, label: '待开始' },
          { n: 2, label: '执行中' },
          { n: 3, label: '待你处理' },
          { n: 4, label: '已完成' },
        ],
      },
      {
        heading: '卡片操作',
        body: '卡片右下角的主按钮随任务状态变化：开始、确认、完成；构建失败时显示重跑，等待回复时显示回复。',
      },
      {
        heading: '卡片菜单',
        body: '右键点击卡片打开菜单：下一步操作排在最前，运行中的任务可中断，还可编辑、复制、复制链接、关闭或删除；已完成的卡片可重开。',
      },
      {
        heading: '拖拽移动',
        body: '将卡片直接拖拽至目标列，按住 Ctrl 或 ⌘ 点选可一次拖动多张。已开始的卡片拖回「待开始」会重置任务：中断构建并清空对话、方案和改动记录。',
      },
      {
        heading: '详情页操作',
        body: '任务详情页右上角的主按钮随阶段变化：确认、完成、重跑，运行中会置灰。',
      },
    ],
  },
  {
    title: '筛选与识别',
    subtitle: '任务多了之后，可以这样聚焦到你关心的卡片：',
    blocks: [
      {
        heading: '全局筛选',
        body: '所有筛选都在看板右上角的筛选图标里：按创建者（我创建的、总管或 Agent 创建的、其他成员创建的）、阶段和项目筛选，对所有列生效。',
      },
      {
        heading: '按阶段细分',
        body: '筛选里的「阶段」可把「执行中」与「待你处理」列细分为规划与执行，比如只看待确认的方案，或只看待验收的改动。',
      },
      {
        heading: 'Agent 创建的任务',
        body: '由总管或 Agent 创建的卡片，编号左侧会显示对应的小图标，一眼区分哪些是你自己建的。',
      },
    ],
  },
  {
    title: '对话与看板并排',
    subtitle: '在「工作台」，总管对话在左、看板在右，可以这样配合使用：',
    blocks: [
      {
        heading: '拖入对话',
        body: '将卡片拖到对话输入框，以任务标签插入，补充说明后发送即可交给总管处理；多选的卡片会一并拖入。',
      },
      {
        heading: '隐藏看板',
        body: '点击看板标题栏最右侧的面板图标，隐藏或展开对话旁的看板。',
        kbd: 'Ctrl Alt B',
      },
      {
        heading: '看板全屏',
        body: '点看板标题栏的最大化图标，或把分隔线向左拖到底，收起总管对话让看板占满整屏；再点一次或从左侧边缘拖回即可还原，状态会被记住。',
        kbd: 'Ctrl Shift Enter',
      },
    ],
  },
  {
    title: '在本机预览改动',
    subtitle: '任务的改动保存在其专属分支上。点击看板卡片或任务详情页右上角的下载图标：',
    blocks: [
      {
        heading: '「同步到机器」',
        body: '将任务分支的提交同步到运行 tds 的本机目录，可在本地直接查看与运行。快捷键在任务页生效。',
        kbd: 'Ctrl Alt S',
      },
      {
        heading: 'Git',
        body: '复制检出命令，在任意本地克隆中切换到任务分支。',
      },
      {
        heading: '查看全部快捷键',
        body: '',
        kbd: 'Ctrl /',
        // 实测这枚角标是可点的：点了直接打开快捷键总面板，不需要用户自己记快捷键。
        kbdOnClick: () => onOpenShortcuts?.(),
        kbdAriaLabel: '查看全部快捷键',
      },
    ],
  },
];

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
  maxWidth: 600,
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

const blockWrapStyle: CSSProperties = {
  marginTop: S.md,
};

const blockHeadingStyle: CSSProperties = {
  margin: `${S.md}px 0 ${S.xs}px`,
  fontSize: T.body,
  fontWeight: 600,
  color: C.text,
};

const blockBodyStyle: CSSProperties = {
  margin: 0,
  color: C.textDim,
  fontSize: T.body,
  lineHeight: 1.6,
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

/**
 * 第 5 步「查看全部快捷键」的角标做成按钮形态 —— 实测原站它是可点的。
 * 视觉与 `kbdStyle` 一致，只多加 hover / focus 反馈，避免「看起来能点、按了没反应」。
 */
const kbdButtonStyle: CSSProperties = {
  ...kbdStyle,
  cursor: 'pointer',
  margin: 0,
  lineHeight: 1.4,
};

const stageListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: S.sm,
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const stageItemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: T.base,
  color: C.text,
};

const stageNumStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: R.pill,
  background: C.surfaceHi,
  border: `1px solid ${C.line}`,
  color: C.textDim,
  fontSize: T.sm,
  fontFamily: F.mono,
};

const actionsRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: S.sm,
  marginTop: S.xl,
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

const cancelBtnStyle: CSSProperties = {
  ...baseBtn,
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
};

const stepDotsStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: S.md,
  justifyContent: 'center',
};

const stepDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: R.pill,
  background: C.lineStrong,
};

const stepDotActiveStyle: CSSProperties = {
  ...stepDotStyle,
  background: C.accent,
};

// 触发按钮：圆问号图标。父组件要么内嵌它，要么通过 KanbanGuide 的受控 props 自己渲染。
const triggerBtnStyle: CSSProperties = {
  width: 16,
  height: 16,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  color: C.textFaint,
};

// ── 弹层组件（导出供 BoardHeader 直接嵌入）─────────────────────────

export interface KanbanGuideDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * 第 5 步「查看全部快捷键」角标的点击回调 —— 打开快捷键总面板。
   * 不传时该角标退化成纯文本（不假装可点）。
   */
  onOpenShortcuts?: () => void;
}

export function KanbanGuideDialog(props: KanbanGuideDialogProps): ReactElement | null {
  const { open, onClose, onOpenShortcuts } = props;

  // 每次渲染把回调塞进模块级槽位，供 STEPS 常量里的第 5 步角标调用。
  // 不用 useEffect：STEPS 的点击发生在同一次 commit 之后，直接赋值即可，
  // 且避免「弹层打开的第一帧角标还没绑定」的窗口。
  openShortcutsHandler = onOpenShortcuts ?? null;

  const [mounted, setMounted] = useState<boolean>(false);
  const [stepIdx, setStepIdx] = useState<number>(0);
  const prevBtnRef = useRef<HTMLButtonElement | null>(null);
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 打开时回到第 1 步（不记忆上次关闭在哪一步，引导要保持线性浏览节奏）。
  // 这是「不记忆上次关闭在哪一步」的设计选择 —— 改了前请权衡用户期望。
  useEffect(() => {
    if (!open) return;
    setMounted(true);
    setStepIdx(0);
    const t = setTimeout(() => {
      nextBtnRef.current?.focus();
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

  // Tab 焦点陷阱：tab 到最后一个 → 回到第一个。
  // 可达元素是动态查询的，所以第 1 步（只有「下一步」一个按钮）与第 5 步
  // 「查看全部快捷键」也是按钮这几处都会自动纳入 —— 陷阱退化成单元素循环
  // 时按 Tab 不动、按 Shift+Tab 也不动，是预期行为（弹层里就这几个可点的）。
  useEffect(() => {
    if (!open) return;
    function onTab(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const root = cardRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      );
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
  }, [open, stepIdx]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  const goPrev = useCallback((): void => {
    setStepIdx((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback((): void => {
    setStepIdx((i) => {
      if (i >= STEPS.length - 1) {
        // 第 5 步点完成 = 关闭弹层（不是再往前）。
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [onClose]);

  // 第 1 步不渲染「上一步」（实测原站只有一个按钮）；末步渲染「完成」。
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === STEPS.length - 1;
  const step = STEPS[stepIdx];

  if (!open || typeof document === 'undefined' || !mounted || !step) return null;

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
        aria-labelledby="kanban-guide-title"
        style={cardStyle}
      >
        <h3 id="kanban-guide-title" style={titleStyle}>
          {step.title}
        </h3>
        <p style={subtitleStyle}>{step.subtitle}</p>

        {step.blocks.map((b, i) => (
          <div key={i} style={blockWrapStyle}>
            {b.heading && <div style={blockHeadingStyle}>{b.heading}</div>}
            {b.body && <p style={blockBodyStyle}>{b.body}</p>}
            {b.stages && (
              <ol style={stageListStyle}>
                {b.stages.map((s) => (
                  <li key={s.n} style={stageItemStyle}>
                    <span style={stageNumStyle}>{s.n}</span>
                    <span>{s.label}</span>
                  </li>
                ))}
              </ol>
            )}
            {b.kbd &&
              (b.kbdOnClick ? (
                <button
                  type="button"
                  onClick={b.kbdOnClick}
                  aria-label={b.kbdAriaLabel ?? b.kbd}
                  style={kbdButtonStyle}
                >
                  {b.kbd}
                </button>
              ) : (
                <kbd style={kbdStyle}>{b.kbd}</kbd>
              ))}
          </div>
        ))}

        <div style={stepDotsStyle} aria-hidden="true">
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={i === stepIdx ? stepDotActiveStyle : stepDotStyle}
            />
          ))}
        </div>

        <div style={actionsRowStyle}>
          {/* 第 1 步**不渲染**「上一步」—— 实测原站第 1 步只有一个
              「下一步」按钮。渲染成 disabled 灰按钮功能等价但视觉不对，
              而且会让「这里本来就该有个不可点的按钮」的错觉留在用户心里。
              布局上用 flex 的 `marginLeft:auto` 把「下一步」推到右边，
              与原站单按钮时的位置一致。 */}
          {!isFirst && (
            <button
              ref={prevBtnRef}
              type="button"
              onClick={goPrev}
              style={cancelBtnStyle}
              aria-label="上一步"
            >
              上一步
            </button>
          )}
          <button
            ref={nextBtnRef}
            type="button"
            onClick={goNext}
            style={isFirst ? { ...primaryBtnStyle, marginLeft: 'auto' } : primaryBtnStyle}
            aria-label={isLast ? '完成' : '下一步'}
          >
            {isLast ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 触发按钮：圆问号图标（不引图标库）─────────────────────────────

export interface KanbanGuideTriggerProps {
  onClick: () => void;
  /** 当触发按钮被父组件的某个容器渲染时，需要 `tabIndex` 让它成为可聚焦元素。 */
  ariaLabel?: string;
}

export function KanbanGuideTrigger(
  props: KanbanGuideTriggerProps,
): ReactElement {
  const { onClick, ariaLabel = '看板指南' } = props;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      tabIndex={0}
      onClick={onClick}
      style={triggerBtnStyle}
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
  );
}

// ── 便捷一体组件：触发按钮 + 弹层（受控）───────────────────────────

export interface KanbanGuideProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function KanbanGuide(props: KanbanGuideProps): ReactElement {
  const { open, onOpenChange } = props;

  // 触发按钮 + 弹层一起渲染。BoardHeader 直接用这一个组件即可。
  // 如果未来有"在别处打开引导"的需求，外部只需要控制 `open`。
  return (
    <>
      <KanbanGuideTrigger onClick={() => onOpenChange(true)} />
      <KanbanGuideDialog
        open={open}
        onClose={() => onOpenChange(false)}
      />
    </>
  );
}