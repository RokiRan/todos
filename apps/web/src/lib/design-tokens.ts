/**
 * 原站实测设计令牌（2026-10-17）。
 *
 * **这些值是实测出来的，不是设计出来的**：浏览器打开 https://todos.dev 与其
 * `/docs/*`，用 `getComputedStyle` 聚合出的计算样式。抓取过程与原始数据见
 * `D:/AI/todos/recon-live/DESIGN-TOKENS.md`。
 *
 * **为什么必须先有这一层**：此前 13 个页面各自 `const xStyle: CSSProperties = {...}`，
 * 颜色/圆角/字号在每个文件里各写一遍，于是
 *   ① 主题方向从第一行就错了（原站深色 `#18181b`，复刻浅灰 `#f6f7f9` + 白卡片）
 *   ② 同一个「次级文字色」在 13 个文件里有 4 种不同的灰
 *   ③ 想改主题要改 13 个文件，没有一处能改
 * 令牌层就是为了消灭 (2)(3)，并把 (1) 一次纠正。
 *
 * 用法：`style={{ color: C.textDim }}`，不要写字面量。
 */

/**
 * 深色主题。原站就是深色（`background: rgb(24,24,27)` 实测），
 * 不要再写浅色背景 —— 那是此前「还原成一坨屎」的第一层原因。
 */
export const C = {
  /** 页面与侧栏底色 —— 实测 `rgb(24,24,27)` */
  bg: '#18181b',
  /** 卡片/浮层底色：比 bg 略亮，用来做层次 */
  surface: '#1f1f23',
  /** 更亮的浮层（弹窗、hover） */
  surfaceHi: '#27272a',
  /** 代码块底 —— 实测 `rgb(39,39,42)` */
  code: '#27272a',

  /** 主文本 —— 实测 `rgb(250,250,249)` */
  text: '#fafaf9',
  /** 次级文本 —— 实测 `rgb(212,212,216)` */
  textDim: '#d4d4d8',
  /** 弱文本（导航/按钮默认态）—— 实测 `rgb(113,113,122)` */
  textFaint: '#71717a',
  /** 更弱（分隔说明、禁用）—— 实测 `rgb(82,82,91)` */
  textGhost: '#52525b',

  /** 强调色 indigo —— 实测 `rgb(129,140,248)` */
  accent: '#818cf8',
  /** 警告/闸门 amber —— 实测 `rgb(251,191,36)` */
  warn: '#fbbf24',
  /** 危险 */
  danger: '#f87171',
  /** 成功 */
  ok: '#4ade80',

  /** 深色下的分隔线 —— 实测 `rgba(255,255,255,0.1)` */
  line: 'rgba(255,255,255,0.1)',
  /** 更实的边框 —— 实测 `rgb(39,39,42)` */
  lineStrong: '#27272a',
} as const;

/** 圆角梯度 —— 实测原站用到 4 / 6 / 8 / 12 / 9999 */
export const R = {
  sm: '4px',
  md: '6px',   // 按钮实测
  lg: '8px',
  xl: '12px',  // 卡片实测
  pill: '9999px',
} as const;

/**
 * 字号梯度 —— 实测原站在用的：
 * 10 / 11 / 12 / 13 / 14 / 15 / 16 / 17 / 24 / 30 / 36 / 56
 * （7/8px 只出现在装饰角落，不是内容字号，别用）
 * 另记实测字重：h1 30/600、h2 18/600、导航按钮 14/400、小徽标 12/500。
 */
export const T = {
  xs: '10px',
  sm: '11px',
  base: '12px',      // 导航项实测 14px，但列表次要信息用 12px
  meta: '13px',
  body: '14px',      // 导航/按钮实测
  bodyLg: '15px',
  lead: '16px',      // body 基准
  h3: '17px',
  h2: '18px',
  h1: '24px',
  display: '30px',
} as const;

/**
 * 字体族 —— 实测：正文 `inter`，logo/等宽 `jetbrainsMono`，代码内联 `ui-monospace`。
 * 都带系统回退，不依赖网络字体（本机没有 inter 时退到系统无衬线，观感差异可接受）。
 */
export const F = {
  sans: 'inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, sans-serif',
  mono: 'jetbrainsMono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

/** 间距：沿用 4 的倍数（原站 padding 实测 `6px 10px`、`2px 6px` 等）。 */
export const S = { xs: 4, sm: 6, md: 10, lg: 16, xl: 24, xxl: 32 } as const;

/** 布局常量 —— 实测值。 */
export const L = {
  /** 原站侧栏实测 240px。此前复刻设置区是 220px 且只在 settings 下有。 */
  sidebarW: 240,
  /** 顶部 header 实测 57px，sticky + backdrop-blur。 */
  headerH: 57,
  /** 看板列实测 308px。 */
  boardColW: 308,
} as const;

/**
 * 共享样式片段（内联 style 用）。
 *
 * 为什么是**对象**而不是 className：本项目没装 Tailwind/CSS 框架，且 package.json
 * 不许改；Next 支持 CSS Modules 但那要求新建 .module.css 并在每个文件 import，
 * 与现有 13 个页面的 inline 写法并存会更乱。所以统一到「内联 style + 共享常量」：
 * 值只有一处定义，用法仍 inline。
 */
export const shared = {
  /** 全页面底色与字体：挂在 body 上（layout.tsx 已接）。 */
  page: {
    background: C.bg,
    color: C.text,
    fontFamily: F.sans,
    fontSize: T.lead,
    lineHeight: 1.5,
  } as const,

  /** 卡片：原站 12px 圆角 + 1px 半透明白边 + 略亮底。 */
  card: {
    background: C.surface,
    border: `1px solid ${C.line}`,
    borderRadius: R.xl,
    padding: S.lg,
  } as const,

  /** 主按钮：强调色底。 */
  primaryBtn: {
    background: C.accent,
    color: '#0b0b0f',
    border: 'none',
    borderRadius: R.md,
    padding: `${S.sm}px ${S.md}px`,
    fontSize: T.body,
    fontWeight: 500,
    fontFamily: F.sans,
    cursor: 'pointer',
  } as const,

  /** 次按钮：透明底 + 边框。 */
  ghostBtn: {
    background: 'transparent',
    color: C.textDim,
    border: `1px solid ${C.lineStrong}`,
    borderRadius: R.md,
    padding: `${S.sm}px ${S.md}px`,
    fontSize: T.body,
    fontFamily: F.sans,
    cursor: 'pointer',
  } as const,

  /** 危险按钮：红字描边。 */
  dangerBtn: {
    background: 'transparent',
    color: C.danger,
    border: `1px solid ${C.danger}`,
    borderRadius: R.md,
    padding: `${S.sm}px ${S.md}px`,
    fontSize: T.body,
    fontFamily: F.sans,
    cursor: 'pointer',
  } as const,

  /** 侧栏项：实测 14px / #d4d4d8，选中态用强调色底。 */
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: S.sm,
    width: '100%',
    padding: `${S.sm}px ${S.md}px`,
    borderRadius: R.md,
    fontSize: T.body,
    color: C.textDim,
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: F.sans,
  } as const,

  /** 分组小标题：实测 11px 弱色。 */
  navGroupLabel: {
    padding: `${S.md}px ${S.md}px ${S.xs}px`,
    fontSize: T.sm,
    color: C.textGhost,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.4px',
  } as const,

  /** 文本输入：原站深色下边框 `rgba(255,255,255,0.1)`。 */
  input: {
    background: C.bg,
    color: C.text,
    border: `1px solid ${C.line}`,
    borderRadius: R.md,
    padding: `${S.sm}px ${S.md}px`,
    fontSize: T.body,
    fontFamily: F.sans,
    width: '100%',
  } as const,

  /** 错误条。 */
  errorBox: {
    background: 'rgba(248,113,113,0.12)',
    border: `1px solid ${C.danger}`,
    borderRadius: R.lg,
    padding: S.md,
    fontSize: T.meta,
    color: C.text,
  } as const,

  /** 提示条（成功/说明）。 */
  noticeBox: {
    background: 'rgba(74,222,128,0.10)',
    border: `1px solid ${C.ok}`,
    borderRadius: R.lg,
    padding: S.md,
    fontSize: T.meta,
    color: C.text,
  } as const,

  /** 未就绪占位。 */
  placeholderBox: {
    background: C.surface,
    border: `1px solid ${C.lineStrong}`,
    borderRadius: R.lg,
    padding: S.md,
    fontSize: T.meta,
    color: C.textFaint,
  } as const,

  /** 徽章（pill）。 */
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 8px',
    borderRadius: R.pill,
    fontSize: T.base,
    color: C.textDim,
    background: C.surfaceHi,
    border: `1px solid ${C.line}`,
  } as const,

  /** 闸门徽章（confirm / review）—— 用实测的 warn 色。 */
  gateBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 8px',
    borderRadius: R.pill,
    fontSize: T.base,
    color: C.warn,
    background: 'rgba(251,191,36,0.12)',
    border: `1px solid ${C.warn}`,
  } as const,
} as const;

/** 令牌版 `SettingsPlaceholder` 的配色入口，供共用模块引用。 */
export const ph = {
  loading: shared.placeholderBox,
  error: { ...shared.placeholderBox, border: `1px solid ${C.danger}`, color: C.text },
  empty: { ...shared.placeholderBox, border: `1px solid ${C.warn}`, color: C.text },
} as const;
