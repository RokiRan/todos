'use client';

/**
 * BranchMenu ——「同步到机器 / 复制检出命令」下载菜单。
 *
 * 契约 §3.4（2026-10-18 看板新增）：props 与行为逐字冻结。
 *
 * **关键诚实契约（最容易假绿的地方）**：
 *  `ok:true` 只代表**指令已下发**（服务端往 `machine_pending_action` 写了
 *  一行）, **不代表文件已经拉到那台机器上** —— 真正的执行结果由 daemon 跑完
 *  git 后 `POST /api/machine/action-result` 决定, 而那条回执目前**不会推到
 *  前端**（服务端已发 SSE `action_completed`, 但本组件没有订阅）。所以
 *  `ok:true` 的标题是「同步指令已下发」, `ok:false` 的 `reason` 原样显示
 *  —— 两种情况下看到「已同步」字样都是 bug, 不是需求。详见
 *  `apps/server/src/routes/todos.ts` 的 sync-to-machine 注释与契约 §3.9。
 *
 * 文件所有权（2026-10-18）：
 *   BoardCards 在卡片上 import 这个组件；本切片（TodoDetail）拥有它。
 *
 * 关掉模式照搬 `ConfirmDialog` —— Escape / 点外部 / 选菜单项后关。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

// ── 类型（契约 §3.4 冻结） ─────────────────────────────────────

export interface BranchMachine {
  id: string;
  displayName: string;
  isOnline: boolean;
  workspacesDir: string | null;
}

export interface BranchMenuProps {
  /** 分支名（实测规则：branch === `tds/conv-<buildId>`） */
  branch: string;
  /** 任务 id —— 用于拼检出命令与 sync-to-machine 的 URL */
  todoId: string;
  /** 该 todo 最近 build 的 worktreePath；null 表示还没有真实工作区 */
  worktreePath: string | null;
  /**
   * 机器列表（来自 `/api/teams/:teamId/machines`）。
   * 空数组时「同步到机器」按钮置灰并 title 提示「还没有登记的机器」。
   * 字段是契约 §3.4 定义的「外部视角」，但 `/api/teams/:teamId/machines`
   * 实际响应是 `{id, name, isOnline, ...}` 而**不是** `{id, displayName, ...}`
   * —— 调用方负责把 `name → displayName` 映射。
   */
  machines: BranchMachine[];
  /** 默认 `button`：带「下载」文字 + 角标。`icon` 模式只在卡片上用，紧凑图标。 */
  variant?: 'icon' | 'button';
  /**
   * 「检出命令已复制」「同步到机器：xxx」之类的回执 —— 由父组件决定
   * 显示在哪。`onNote` 不传时这些回执直接打到 console（不弹 toast，
   * 不假绿）。
   */
  onNote?: (note: string) => void;
}

// ── 同步响应（契约 §3.8 的返回表; 2026-10-18 接通 ok:true）─────────────

/**
 * `ok:true` —— **指令已下发**, 不是「已同步」。服务端只往
 * `machine_pending_action` 写了一行（`apps/server/src/routes/todos.ts` 的
 * (f) 分支）, 下面七个字段就是那边 `return` 的形状, 逐字对齐。daemon 要到
 * 下一次 `POST /api/machine/recover` 把指令领走, 才真的开始跑 git。
 */
interface SyncAcceptedResponse {
  ok: true;
  /** 指令行 id。同一 (machineId, todoId) 上已有 pending/running 行时服务端
   *  **复用**那一行、返回同一个 actionId（契约 §3.8 幂等）—— 用户连点两次
   *  不该产生两条要 git 拉取的指令。 */
  actionId: string;
  machineId: string;
  branch: string;
  /** **这台机器上的具体隔离工作区** `<workspacesDir>/<buildId>`, 不是工作根
   *  （daemon 直接拿它 fetch/checkout/reset —— 契约 §3.6「必须直接用 dir」） */
  dir: string;
  todoId: string;
  /** (f) 分支必有 build（无 build 走 409）, 但协议里 buildId 可空 —— 按协议
   *  口径留 null, 渲染时不假设它必有。 */
  buildId: string | null;
  /** 这条分支从哪个基线切出。`builds` 表**不存** base, 服务端查不到 project
   *  行时给 null, 所以「可选 + 可空」, 渲染时不能当必有。 */
  baseBranch?: string | null;
}

interface SyncFailResponse {
  ok: false;
  reason: string;
  machineId?: string;
  branch?: string;
  dir?: string;
}

/** 判别式联合 —— `postSync` 按 `ok` 分派。两条路径都拿到具体类型, 渲染时
 *  不需要非空断言, 也不会以 `any` 进 JSX。 */
type SyncResponse = SyncAcceptedResponse | SyncFailResponse;

/** 回执状态 —— `kind` 叫 `accepted` 而不是 `ok`：`ok:true` 是「指令已受理」,
 *  叫 `ok` 会让下一个读代码的人以为这里可以写成功文案。 */
type SyncReceiptState =
  | { kind: 'accepted'; accepted: SyncAcceptedResponse }
  | { kind: 'fail'; text: string };

// ── 内部小工具 ──────────────────────────────────────────────────

/**
 * 同步 fetch + 解析 —— 写路径 `userId` 由 BFF 自动注入, 我们不发 userId
 * （契约 §5.1）。返回的 `reason` 是后端原文, **必须**原样显示给用户。
 *
 * **BFF 不剥外层信封**：`proxyWrite` 把上游 JSON 原样 `NextResponse.json`
 * 透出（只有 `proxyRead` 才包 `{ready,data}`）, 所以这里直接按上游的
 * `{ok:true, actionId, ...}` / `{ok:false, reason}` 判别式解析 —— 两条路径
 * 都有具体类型, 不以 `any` 进渲染。
 *
 * **已知缺口（本切片不修）**：409 / 404 / 403 走的是 `{error}` 体
 * （`apps/server/src/http.ts` 的 `installErrorHandlers`）, 里面**没有**
 * `reason` 字段, 于是落到 `ok:false` 分支时 `text` 是 undefined, 回执框会
 * 显示成空框。这条 2026-10-18 之前就存在; 修它要改 `ok:false` 的显示逻辑,
 * 而本切片明确不许动那条路径。
 */
async function postSync(
  todoId: string,
  machineId: string,
  signal: AbortSignal,
): Promise<SyncResponse> {
  const res = await fetch(
    `/api/todos/${encodeURIComponent(todoId)}/sync-to-machine`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId }),
      signal,
    },
  );
  const body = (await res.json().catch(() => null)) as SyncResponse | null;
  if (!body) {
    return { ok: false, reason: `同步请求无响应 (HTTP ${res.status})` };
  }
  return body;
}

/** 复制到剪贴板 —— navigator.clipboard 不可用时降级到临时 textarea + execCommand。
 *  仅在复制失败时返回 false, 让 UI 给个错误回执而不是「已复制」假绿。 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 走兜底
    }
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

// ── 样式 ─────────────────────────────────────────────────────────

/** 触发按钮 —— variant='button' 时走 ghostBtn 谱系, 带文字与 `Ctrl Alt S` 角标。
 *  variant='icon' 时只画一个下载图标, 不带文字。
 *
 *  颜色/字号/圆角走 design-tokens —— 禁止写字面量颜色。 */
const triggerBtnStyle: CSSProperties = {
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  padding: `${S.xs}px ${S.sm}px`,
  fontSize: T.meta,
  fontFamily: F.sans,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const triggerBtnIconStyle: CSSProperties = {
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  padding: '4px 6px',
  fontSize: T.meta,
  fontFamily: F.sans,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
};

/** 角标 —— 显示 `Ctrl Alt S` 之类的快捷键提示, 沿用 buildMetaTag 风格。 */
const shortcutBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 6px',
  borderRadius: R.pill,
  fontSize: T.sm,
  background: 'transparent',
  border: `1px solid ${C.line}`,
  color: C.textFaint,
  fontFamily: F.mono,
};

/** 下拉面板 —— 与 ConfirmDialog 同系 z-index 思路, 但菜单不需要那么高
 *  （不挡住 modal server error toast = 90）。这里给 50: 高于侧栏 40,
 *  低于 ConfirmDialog 80, 低于 toast 90。 */
const menuStyle: CSSProperties = {
  position: 'absolute',
  marginTop: 4,
  minWidth: 240,
  background: C.surfaceHi,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  padding: S.xs,
  zIndex: 50,
  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
  fontFamily: F.sans,
  fontSize: T.body,
  color: C.text,
};

const menuItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: `${S.sm}px ${S.md}px`,
  background: 'transparent',
  border: 'none',
  color: C.text,
  fontFamily: F.sans,
  fontSize: T.meta,
  borderRadius: R.sm,
  cursor: 'pointer',
  textAlign: 'left',
  gap: 8,
};

const menuItemDisabled: CSSProperties = {
  ...menuItemStyle,
  color: C.textGhost,
  cursor: 'not-allowed',
};

const subMenuStyle: CSSProperties = {
  marginTop: 4,
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: S.xs,
  maxHeight: 200,
  overflowY: 'auto',
};

const subMenuItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: `${S.xs}px ${S.sm}px`,
  background: 'transparent',
  border: 'none',
  color: C.text,
  fontFamily: F.sans,
  fontSize: T.meta,
  borderRadius: R.sm,
  cursor: 'pointer',
  textAlign: 'left',
};

const subMenuItemDisabled: CSSProperties = {
  ...subMenuItemStyle,
  color: C.textGhost,
  cursor: 'not-allowed',
};

const subMenuItemOnline: CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: R.pill,
  background: C.ok,
};

const subMenuItemOffline: CSSProperties = {
  ...subMenuItemOnline,
  background: C.textGhost,
};

/** 「同步到机器」回执框 —— 与 shared.noticeBox 同系, 但用 warn 配色,
 *  强调这是「未成功」回执不是「成功」提示。这里换 amber 让用户看到
 *  「这条命令没有真把分支同步上去」。
 *
 *  没有 `shared.warnBox`（设计令牌层未提供）—— 与闸门卡片
 *  `gateCardStyle` 同样手写 rgba 表达式。这里保留手写是为了
 *  视觉与闸门卡片一致; 后续如果 design-tokens 加了 warnBox
 *  再迁移。 */
const receiptStyle: CSSProperties = {
  marginTop: S.sm,
  padding: `${S.sm}px ${S.md}px`,
  background: 'rgba(251,191,36,0.10)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  fontSize: T.meta,
  color: C.text,
  lineHeight: 1.5,
};

/** 「已复制检出命令」回执 —— 成功才是 ok 配色。走 shared.noticeBox
 *  是为了不在 BranchMenu 里再造一遍「ok 提示条」的样式 —— 注意
 *  shared.noticeBox 的 borderRadius 是 `R.lg`(8px), 这里我们要 `R.md`(6px)
 *  与本地 sub-menu 视觉对齐, 所以重写 borderRadius 而非整体覆盖。 */
const receiptOkStyle: CSSProperties = {
  ...shared.noticeBox,
  marginTop: S.sm,
  borderRadius: R.md,
  lineHeight: 1.5,
};

/** 回执标题 —— 只加字重, **不换成 `C.ok`**：`ok:true` 是「指令已受理」不是
 *  「执行完成」, 标题再用成功色会把「已下发」渲染成「已完成」, 与文案的
 *  诚实等级不一致（noticeBox 本身的绿已经够了）。 */
const receiptTitleStyle: CSSProperties = {
  fontWeight: 500,
  color: C.text,
};

/** 详情行（分支 / 目录）—— `dir` 是**目标机器**上的绝对路径, 可能很长,
 *  所以等宽 + 允许断行, 否则长路径会把回执框撑破。 */
const receiptDetailStyle: CSSProperties = {
  marginTop: S.xs,
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.textDim,
  overflowWrap: 'anywhere',
  lineHeight: 1.45,
};

/** 收尾提醒 —— 弱色, 与主信息分层。这里写「执行结果不会回到这个页面」
 *  而不是「完成后这里会显示真实结果」：后者是**现在还不存在**的能力
 *  （服务端已发 SSE `action_completed`, 但本组件没订阅）, 承诺它就是假绿。 */
const receiptHintStyle: CSSProperties = {
  marginTop: S.xs,
  fontSize: T.sm,
  color: C.textFaint,
  lineHeight: 1.45,
};

// ── 组件 ─────────────────────────────────────────────────────────

export default function BranchMenu(props: BranchMenuProps): ReactElement {
  const {
    branch,
    todoId,
    worktreePath,
    machines,
    variant = 'button',
    onNote,
  } = props;

  /** 顶层菜单展开状态 —— `false` 时 trigger 按钮直接渲染, 不挂菜单。 */
  const [open, setOpen] = useState<boolean>(false);
  /** 「同步到机器」子菜单展开 —— 二级菜单 hover/click 切到机器列表。 */
  const [syncOpen, setSyncOpen] = useState<boolean>(false);
  /** sync-to-machine 写路径回执 —— 始终显示在 trigger 下方, 关闭菜单不清掉。
   *  `accepted` 存**整条响应**（标题/正文/详情行要用不同字号与颜色分层,
   *  拼成一条字符串就分不出来）, `fail` 存后端 reason 原文。 */
  const [syncReceipt, setSyncReceipt] = useState<SyncReceiptState | null>(null);
  /** 复制检出命令的成功提示 —— 同上, 关闭菜单不清掉。 */
  const [copyReceipt, setCopyReceipt] = useState<string | null>(null);
  /** 单次 sync POST 的 busy 标志 —— 防止用户连点同一台机器。 */
  const [syncBusy, setSyncBusy] = useState<boolean>(false);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // ── 关掉模式（契约 §3.4 冻结） ───────────────────────────
  // 三个关闭源：点外部 / Escape / 点菜单项。点菜单项由各菜单项的 onClick
  // 自己 `setOpen(false)`。点外部 + Escape 走下面的 effect。

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      // 只在点的就是 root 之外（不是 trigger 也不是 menu）时关。
      // rootRef.current.contains(target) === true 时不关。
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setOpen(false);
        setSyncOpen(false);
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        // 优先级：sync 子菜单开着 → 只关 sync 子菜单, 不关顶层菜单
        // （避免误关顶层菜单后还要重新 trigger）。原站实测下拉子菜单
        // Escape 只回退一级。这里按同样的语义实现。
        if (syncOpen) {
          e.stopPropagation();
          setSyncOpen(false);
        } else {
          setOpen(false);
          setSyncOpen(false);
        }
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, syncOpen]);

  // ── 「复制检出命令」 ───────────────────────────────────
  // 契约 §3.4：navigator.clipboard.writeText(`git fetch origin ${branch}
  // && git checkout ${branch}`) → onNote('检出命令已复制')。
  // 这里**额外**把回执打在菜单下方（不靠父组件也看得到），
  // 同时把 `onNote?.('检出命令已复制')` 也回调出去 —— 双向通知,
  // 让父组件可以选择显示在自己的提示区。
  const onCopyCheckout = useCallback(async (): Promise<void> => {
    setOpen(false);
    setSyncOpen(false);
    const cmd = `git fetch origin ${branch} && git checkout ${branch}`;
    const ok = await copyToClipboard(cmd);
    const text = ok ? '检出命令已复制' : '复制失败：浏览器拒绝访问剪贴板';
    setCopyReceipt(text);
    onNote?.(text);
  }, [branch, onNote]);

  // ── 「同步到机器」选具体机器 ──────────────────────────
  // 契约 §3.4：
  //   - 机器列表为空 → 按钮置灰, title 说明「还没有登记的机器」
  //   - 机器离线 → 仍可点, 但服务端会返 ok:false, 我们把 reason 原样显示
  //   - 任何 `ok:false` 路径都必须把 reason 显示, **绝不显示「已同步」**
  //   - `ok:true` = **指令已下发**（服务端往 machine_pending_action 写了一行）,
  //     **不是执行完成** —— daemon 要到下一次 recover 轮询才真正跑 git。所以
  //     这条路径的标题是「同步指令已下发」, **同样绝不显示「已同步」**：
  //     「已同步」会把「服务端记了一行指令」说成「文件已经在那台机器上」,
  //     而后者现在**没有任何前端证据**（回执 SSE 未订阅）。将来有人想改
  //     文案, 先读这条。
  const onPickMachine = useCallback(
    async (machineId: string): Promise<void> => {
      if (syncBusy) return;
      setSyncBusy(true);
      // 选机器后关菜单 —— 后续回执仍然显示在 trigger 下方。
      setOpen(false);
      setSyncOpen(false);
      const ac = new AbortController();
      try {
        const resp = await postSync(todoId, machineId, ac.signal);
        if (resp.ok) {
          // `ok:true` 只代表**指令已下发**（服务端往 `machine_pending_action`
          // 写了一行 —— `apps/server/src/routes/todos.ts` 的 (f) 分支）,
          // **不代表文件已经拉到那台机器上**：真正的执行结果由 daemon 跑完
          // git 后 `POST /api/machine/action-result` 决定, 而那条回执目前
          // **不会推到前端**（服务端已发 SSE `action_completed`, 但本组件
          // 没有订阅）。所以这里只陈述「会发生什么」（下一次轮询执行）,
          // **绝不**写「已同步」, 也**绝不**承诺「完成后这里会显示真实结果」。
          // 存整条响应而不是拼好的字符串 —— 标题/正文/详情行要用不同字号与
          // 颜色分层渲染, 拼成一条字符串就分不出层次。
          setSyncReceipt({ kind: 'accepted', accepted: resp });
          // 上抛给父级 banner 的必须是单行纯文本（`onNote` 只吃 string）,
          // 所以这里单独拼一条 —— 同样不含「已同步」。
          const msg = `同步指令已下发（机器 ${resp.machineId}，分支 ${resp.branch}，目录 ${resp.dir}）；daemon 会在下一次轮询时执行 git 拉取（约 30 秒内）。执行结果不会回到这个页面。`;
          onNote?.(msg);
        } else {
          // **关键诚实路径**：把 reason 原样显示给用户。**绝不许改成
          // 「已同步」之类的假绿**。这条断言要在 PR review 时强校验：
          // 如果以后有人把下面 text 改成 success 表述, 整条契约就崩了。
          const text = resp.reason;
          setSyncReceipt({ kind: 'fail', text });
          onNote?.(text);
        }
      } catch (err) {
        const text = err instanceof Error ? `同步请求失败：${err.name}` : '同步请求失败';
        setSyncReceipt({ kind: 'fail', text });
        onNote?.(text);
      } finally {
        setSyncBusy(false);
      }
    },
    [todoId, syncBusy, onNote],
  );

  // ── 触发按钮 ──────────────────────────────────────────────
  const triggerBtn = (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={variant === 'icon' ? '下载分支操作' : '下载 / 分支操作'}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
        setSyncOpen(false);
      }}
      style={variant === 'icon' ? triggerBtnIconStyle : triggerBtnStyle}
      disabled={syncBusy}
    >
      {/* 极简下载图标 —— 不引图标库, 三笔 SVG。aria-hidden 是装饰语义。 */}
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1v8.586L4.707 6.414 3.293 7.828 8 12.536l4.707-4.708-1.414-1.414L9 9.586V1H8zm-8 9v4h16v-4H0z"
          fill={C.textDim}
        />
      </svg>
      {variant !== 'icon' && <span>下载</span>}
      {variant !== 'icon' && <span style={shortcutBadge}>Ctrl Alt S</span>}
    </button>
  );

  const noMachines = machines.length === 0;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      {triggerBtn}
      {open && (
        <div role="menu" style={menuStyle} data-testid="branch-menu">
          {/* ── 1) 同步到机器 ───────────────────────────── */}
          <button
            type="button"
            role="menuitem"
            onClick={() => setSyncOpen((v) => !v)}
            disabled={noMachines}
            title={
              noMachines
                ? '还没有登记的机器 —— 走 tds start 入网后才能同步'
                : '把当前分支同步到选中的机器（指令下发后由 daemon 在下一次轮询执行 git 拉取）'
            }
            style={noMachines ? menuItemDisabled : menuItemStyle}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              同步到机器
              {syncOpen && <span style={{ color: C.textFaint, fontSize: T.sm }}>▾</span>}
              {!syncOpen && <span style={{ color: C.textFaint, fontSize: T.sm }}>▸</span>}
            </span>
            <span style={shortcutBadge}>Ctrl Alt S</span>
          </button>

          {syncOpen && (
            <div role="presentation" style={subMenuStyle}>
              {noMachines && (
                <div
                  style={{
                    padding: `${S.xs}px ${S.sm}px`,
                    fontSize: T.meta,
                    color: C.textFaint,
                  }}
                >
                  还没有登记的机器
                </div>
              )}
              {machines.map((m) => {
                // 离线机器**允许**点击（契约 §3.4）—— 服务端会返
                // {ok:false, reason:'机器当前离线，无法同步'}, 我们原样
                // 显示这个 reason 给用户看。不要把按钮置灰。
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitem"
                    onClick={() => void onPickMachine(m.id)}
                    style={subMenuItemStyle}
                    data-testid={`sync-machine-${m.id}`}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={m.isOnline ? subMenuItemOnline : subMenuItemOffline} />
                      <span>{m.displayName}</span>
                    </span>
                    <span style={{ color: C.textFaint, fontSize: T.sm }}>
                      {m.isOnline ? '在线' : '离线'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 分隔线 —— 跟 menu 项 padding 错开避免挨太近 */}
          <div style={{ height: 1, background: C.line, margin: `${S.xs}px ${S.xs / 2}px` }} />

          {/* ── 2) Git · 复制检出命令 ──────────────────── */}
          <button
            type="button"
            role="menuitem"
            onClick={() => void onCopyCheckout()}
            style={menuItemStyle}
            data-testid="copy-checkout"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Git · 复制检出命令
            </span>
            <span style={{ color: C.textFaint, fontSize: T.sm, fontFamily: F.mono }}>
              fetch + checkout
            </span>
          </button>
        </div>
      )}

      {/* 回执区 —— 关掉菜单也保留显示, 直到下次成功操作覆盖或用户关页面。
          两种回执独立占位: 复制成功用 ok 配色, 同步结果无论 ok/fail 都
          优先显示最新一条。 */}
      {copyReceipt && (
        <div style={receiptOkStyle} data-testid="branch-copy-receipt">
          {copyReceipt}
        </div>
      )}
      {syncReceipt && (
        <div
          style={syncReceipt.kind === 'accepted' ? receiptOkStyle : receiptStyle}
          data-testid="branch-sync-receipt"
        >
          {syncReceipt.kind === 'fail' ? (
            // ok:false 路径 —— 原样显示 reason, 一个字符都不加工（见
            // onPickMachine 的「关键诚实路径」注释）。
            syncReceipt.text
          ) : (
            <>
              <div style={receiptTitleStyle}>同步指令已下发</div>
              <div>
                daemon 会在下一次轮询时执行 git 拉取（约 30 秒内；机器任务跑满时会延后）。
              </div>
              <div style={receiptDetailStyle}>
                <span>分支 {syncReceipt.accepted.branch}</span>
                <span style={{ color: C.textGhost }}>{' · '}</span>
                <span>目录 {syncReceipt.accepted.dir}</span>
              </div>
              <div style={receiptHintStyle}>
                想现在就看到文件，可以先用「Git · 复制检出命令」手动 checkout。
              </div>
              <div style={receiptHintStyle}>
                执行结果不会回到这个页面 —— 这个回执不会自动更新。
              </div>
            </>
          )}
        </div>
      )}

      {/* worktreePath 提示 —— 不是错误, 是「同步到机器真正落地时的目录」
          提示, 缺了也没关系（很多 todo 还没真正跑过 build）。worktreePath
          为 null 时不显示, 不做假数据。 */}
      {!syncReceipt && worktreePath && (
        <div
          style={{
            marginTop: S.sm,
            fontSize: T.sm,
            color: C.textFaint,
            fontFamily: F.mono,
          }}
          data-testid="branch-worktree"
        >
          worktree: {worktreePath}
        </div>
      )}
    </div>
  );
}