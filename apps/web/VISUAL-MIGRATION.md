# 视觉迁移映射表（浅色 → 实测深色）

> 依据：`D:/AI/todos/recon-live/DESIGN-TOKENS.md`（浏览器 `getComputedStyle` 实测）。
> 本表是**唯一权威**，所有页面按此改，不要自己发挥。

## 颜色替换（照抄，不要微调）

| 旧（浅色） | 新（实测深色） | 令牌 | 用在哪 |
|---|---|---|---|
| `#fff` / `#ffffff` | `#1f1f23` | `C.surface` | 卡片、输入框、按钮底 |
| `#f6f8fa` | `#18181b` | `C.bg` | 次级面板、表单区、代码块底 |
| `#f6f7f9` | `#18181b` | `C.bg` | 页面底 |
| `#d0d7de`（边框） | `rgba(255,255,255,0.1)` | `C.line` | 所有边框 |
| `#eaeef2`（浅边框） | `rgba(255,255,255,0.06)` | — | 表格行分隔 |
| `#1f2328`（深文本） | `#fafaf9` | `C.text` | 正文、标题 |
| `#656d76`（次文本） | `#d4d4d8` | `C.textDim` | 说明、元信息 |
| `#8b949e`（弱文本） | `#71717a` | `C.textFaint` | 占位、禁用 |
| `#afb8c1` | `#52525b` | `C.textGhost` | 已删除、极弱 |
| `#0969da`（蓝链接） | `#818cf8` | `C.accent` | 链接、选中态 |
| `#1f883d` / `#1a7f37`（绿按钮） | `#818cf8` | `C.accent` | 主按钮（改为 indigo 强调） |
| `#dafbe1`（绿底） | `rgba(74,222,128,0.10)` | — | 成功提示底 |
| `#ffebe9`（红底） | `rgba(248,113,113,0.12)` | — | 错误提示底 |
| `#cf222e`（红边/红字） | `#f87171` | `C.danger` | 危险边框与文字 |
| `#fff8c5` / `#fff8e1`（黄底） | `rgba(251,191,36,0.12)` | — | 警告/闸门底 |
| `#d4a72c`（黄边） | `#fbbf24` | `C.warn` | 警告边框 |
| `#bf8700` / `#9a6700` | `#fbbf24` | `C.warn` | 闸门强调色 |
| `#ddf4ff`（浅蓝底） | `rgba(129,140,248,0.14)` | — | 选中徽章底 |
| `#afb8c1`（禁用按钮底） | `#27272a` | `C.surfaceHi` | 禁用态 |

## 圆角 / 字号 / 字体

- 圆角统一走 `R.sm(4) / R.md(6) / R.lg(8) / R.xl(12) / R.pill`
- 字号走 `T.xs(10) / sm(11) / base(12) / meta(13) / body(14) / bodyLg(15) / h3(17) / h2(18) / h1(24)`
- 字体走 `F.sans`（正文）与 `F.mono`（代码），不要再写 `system-ui` 字面量

## 导入写法

```ts
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
```

`shared` 里已经封装好这些（**优先用 shared，别重复造**）：

| 共享样式 | 用途 |
|---|---|
| `shared.card` | 卡片底 + 边框 + 圆角 + 内边距 |
| `shared.primaryBtn` / `ghostBtn` / `dangerBtn` | 三种按钮 |
| `shared.input` | 文本输入 |
| `shared.errorBox` / `noticeBox` / `placeholderBox` | 提示条三态 |
| `shared.badge` / `shared.gateBadge` | 徽章 |
| `shared.navItem` | 列表项 |

## 闸门视觉（confirm / review）

原站是 **amber**（实测 `#fbbf24`）。复刻保留「双线边框 + 浅黄底」的语义，
但要改成深色下的版本：

```ts
const gateCardStyle: CSSProperties = {
  ...shared.card,
  border: `2px solid ${C.warn}`,
  background: 'rgba(251,191,36,0.10)',
};
const gateBadgeStyle: CSSProperties = {
  ...shared.gateBadge,
};
```

## 页面容器

页面根元素统一：

```tsx
<main style={{ padding: `${S.xl}px ${S.lg}px ${S.xxl}px`, maxWidth: 1200, margin: '0 auto', color: C.text, fontSize: T.body }}>
```

（全局侧栏已经是 fixed + marginLeft 240px，页面**不要再自己加左侧偏移**。）

## 绝对不要做的事

- ❌ 不要引入 Tailwind / CSS 文件 / UI 库（package.json 不许改）
- ❌ 不要改 `apps/server/**`
- ❌ 不要动任何 BFF 路由文件（`app/api/**/route.ts`）的逻辑
- ❌ 不要删掉任何功能、条件分支、错误提示 —— 这一轮**只改颜色/字号/字体/圆角**
- ❌ 不要声称做了浏览器验证（主代理统一做）
