/**
 * 快捷键总表 —— 单一事实源。
 *
 * 契约 §1.5 / §3.9：实测 https://todos.dev/app（2026-10-18）得到的 11 条快捷键。
 * 任何新加快捷键都要先在契约表里加，再来这里登记；不要在调用方各自写一份。
 *
 * 设计上把字符串键名（`Ctrl Alt B`）与展示字符串（`⌘⌥B / Ctrl+Alt+B`）分开：
 * - `keys`：用于键盘事件匹配、与 `formatShortcut` 一起交给 `ShortcutSpec`；
 * - `display`：用户在帮助面板里看到的友好串。
 *
 * 为什么 scope 分四档：
 * - `global`：全应用有效（Ctrl B / Ctrl K / N / Ctrl P / Ctrl J / Ctrl ,）；
 * - `workspace`：在工作台（左侧对话区 + 右侧看板）有效（Ctrl Alt B / Ctrl Shift Enter）；
 * - `board`：在看板区域有效（Ctrl /）；
 * - `todo`：在任务详情页有效（Ctrl Alt Enter / Ctrl Alt S）。
 * scope 不影响展示，只在帮助面板里用来分组。
 */

export type ShortcutScope = 'global' | 'workspace' | 'board' | 'todo';

export interface ShortcutSpec {
  /** 用于键盘事件匹配的串（半角空格分隔组合键），如 `Ctrl Alt B`。 */
  keys: string;
  /** 友好展示串，含 Mac 与 Windows 双标，如 `⌘⌥B / Ctrl+Alt+B`。 */
  display: string;
  /** 行为描述（中文，与引导文案口径一致）。 */
  description: string;
  /** 生效范围，决定帮助面板里的分组。 */
  scope: ShortcutScope;
}

/**
 * 冻结的 11 条快捷键。
 *
 * 顺序按契约 §1.5 表格 + 引导里出现的顺序排列，方便对照。
 * 改这里之前必须改契约；不要在这里多塞契约里没有的条目。
 */
export const SHORTCUTS: ReadonlyArray<ShortcutSpec> = [
  // —— global ——
  {
    keys: 'Ctrl B',
    display: '⌘B / Ctrl+B',
    description: '显隐左侧栏',
    scope: 'global',
  },
  {
    keys: 'Ctrl K',
    display: '⌘K / Ctrl+K',
    description: '打开搜索',
    scope: 'global',
  },
  {
    keys: 'N',
    display: 'N',
    description: '新建任务',
    scope: 'global',
  },
  {
    keys: 'Ctrl P',
    display: '⌘P / Ctrl+P',
    description: '搜索任务',
    scope: 'global',
  },
  {
    keys: 'Ctrl J',
    display: '⌘J / Ctrl+J',
    description: '搜索主题',
    scope: 'global',
  },
  {
    keys: 'Ctrl ,',
    display: '⌘, / Ctrl+,',
    description: '打开设置',
    scope: 'global',
  },

  // —— workspace ——
  {
    keys: 'Ctrl Alt B',
    display: '⌘⌥B / Ctrl+Alt+B',
    description: '显隐看板',
    scope: 'workspace',
  },
  {
    keys: 'Ctrl Shift Enter',
    display: '⌘⇧Enter / Ctrl+Shift+Enter',
    description: '看板全屏',
    scope: 'workspace',
  },

  // —— todo ——
  {
    keys: 'Ctrl Alt Enter',
    display: '⌘⌥Enter / Ctrl+Alt+Enter',
    description: '在 review 闸门点「完成」（任务页）',
    scope: 'todo',
  },
  {
    keys: 'Ctrl Alt S',
    display: '⌘⌥S / Ctrl+Alt+S',
    description: '同步到机器（任务页）',
    scope: 'todo',
  },

  // —— board ——
  {
    keys: 'Ctrl /',
    display: '⌘/ / Ctrl+/',
    description: '查看全部快捷键',
    scope: 'board',
  },
];

/**
 * 把 `ShortcutSpec` 渲染成一行展示。
 *
 * 为什么单独抽函数：`ShortcutsDialog` 里同一行既要展示快捷键也要展示描述，
 * UI 组件不应该各自拼字符串。返回值就是 `display` 字段 —— 当前设计下
 * `display` 已经包含完整串，所以这里是直接返回；如果未来要做按平台分支
 * （比如仅展示 Mac 串），改这一个函数即可。
 */
export function formatShortcut(spec: ShortcutSpec): string {
  return spec.display;
}