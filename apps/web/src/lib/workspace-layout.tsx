'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Workspace 布局上下文 —— 首页 Chief 对话 / 看板 显隐状态。
 *
 * **为什么用 context 而不是 props**：`AppShell` 与 `app/page.tsx` 在 React 树里
 * 是爷孙关系但中间隔着 `children`（layout → AppShell → children），AppShell
 * 管的快捷键（⌘⌥B / ⌘⇧Enter）需要直接驱动首页右侧看板与左侧对话的显隐，
 * 而首页是 AppShell 的 `children`，没法往里穿透 prop。在 layout 里拆两个
 * Provider 嵌套解决。
 *
 * 三个状态语义都按原站实测（`docs-chief.md:14-20`）：
 *   - `boardHidden` —— ⌘⌥B 切换；为 true 时看板整列收起，只留左下角的小图标唤回
 *   - `conversationFolded` —— ⌘⇧Enter 切换；为 true 时左侧对话栏宽度归 0，
 *     看板占满；占满侧栏有「返回对话」按钮 / 拖回左边缘也可恢复
 *
 * 三个状态全部在 Provider 内部持久化到 localStorage（key 集中在 `STORAGE_KEYS`），
 * 刷新不丢。
 */

const STORAGE_KEYS = {
  boardHidden: 'tds.workspace.boardHidden',
  conversationFolded: 'tds.workspace.conversationFolded',
} as const;

/** 合法性校验：读出的值要么是字面量 'true' 要么是 'false'，否则丢弃。 */
function readBool(key: string): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // localStorage 可能被禁用（隐私模式 / 磁盘满），吞掉异常而不是崩 UI。
  }
}

export interface WorkspaceLayoutState {
  /** ⌘⌥B 切换。true = 看板收起（首页只有左对话）。 */
  boardHidden: boolean;
  /** ⌘⇧Enter 切换。true = 对话栏折叠，看板占满。 */
  conversationFolded: boolean;
  setBoardHidden: (v: boolean | ((prev: boolean) => boolean)) => void;
  setConversationFolded: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** 同时复位（首页未挂载时也安全 —— 都基于 setter）。 */
  resetWorkspace: () => void;
}

const Ctx = createContext<WorkspaceLayoutState | null>(null);

export function WorkspaceLayoutProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // 初始值用 null 占位，等挂载后再从 localStorage 读，避免 SSR/CSR 不一致
  // 让 React 报 warning。读取逻辑放在 effect 之外的 useState 初始化函数里：
  // 该函数只在首次渲染时跑一次，且在 server 端 typeof window === 'undefined'
  // 直接返回 false（默认值），客户端水合后再补一次。
  const [boardHidden, setBoardHiddenState] = useState<boolean>(() => readBool(STORAGE_KEYS.boardHidden) ?? false);
  const [conversationFolded, setConversationFoldedState] = useState<boolean>(
    () => readBool(STORAGE_KEYS.conversationFolded) ?? false,
  );

  const setBoardHidden = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setBoardHiddenState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      writeBool(STORAGE_KEYS.boardHidden, next);
      return next;
    });
  }, []);

  const setConversationFolded = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setConversationFoldedState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      writeBool(STORAGE_KEYS.conversationFolded, next);
      return next;
    });
  }, []);

  const resetWorkspace = useCallback(() => {
    setBoardHidden(false);
    setConversationFolded(false);
  }, [setBoardHidden, setConversationFolded]);

  const value = useMemo<WorkspaceLayoutState>(
    () => ({
      boardHidden,
      conversationFolded,
      setBoardHidden,
      setConversationFolded,
      resetWorkspace,
    }),
    [boardHidden, conversationFolded, setBoardHidden, setConversationFolded, resetWorkspace],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * 取 workspace 布局状态。未在 Provider 内调用时返回默认全部 false 的 noop 状态，
 * 让消费组件不强制套 Provider（首页是唯一消费点，但不应让 TS 强制约束上游）。
 */
export function useWorkspaceLayout(): WorkspaceLayoutState {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  // fallback：未挂 Provider 时返回静默 no-op —— 不抛错，避免「在 AppShell 写快捷键
  // 调试时 Provider 还没挂」就把首页搞崩。
  return {
    boardHidden: false,
    conversationFolded: false,
    setBoardHidden: () => undefined,
    setConversationFolded: () => undefined,
    resetWorkspace: () => undefined,
  };
}