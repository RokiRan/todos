'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GlobalSidebar } from '@/components/GlobalSidebar';
import { CommandPalette } from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import { TeamProvider } from '@/lib/team-context';
import { WorkspaceLayoutProvider, useWorkspaceLayout } from '@/lib/workspace-layout';
import { L, S } from '@/lib/design-tokens';

/**
 * 应用外壳 —— 全局侧栏 + 内容区 + Workspace 快捷键。
 *
 * **为什么放到根布局**：原站的侧栏是**常驻全局**的（看板/对话/设置都在它右侧），
 * 复刻此前只有 settings 下有侧栏 ⇒ 从看板点不到任何设置。现在提到根布局，
 * 所有页面共享。`TeamProvider` 也随之提上来 —— 侧栏要显示当前团队，
 * 提到根布局后设置区那层 `TeamProvider` 就多余了（两处 Provider 会各自发一次
 * `/api/user/context`，且选中态可能不一致）。
 *
 * **快捷键**（`docs-chief.md:14-20` 实测）：
 *   - ⌘⌥B / Ctrl+Alt+B  → 显示或隐藏右侧看板
 *   - ⌘⇧Enter           → 折叠或展开 Chief 对话
 *   - ⌘B  / Ctrl+B     → 显示或隐藏左侧栏
 *   - ⌘J  / Ctrl+J     → 搜索 topics
 *   - N                  → 新建任务
 *   - Ctrl / ⌘/         → 快捷键总面板（2026-10-18 实测原站第 5 步引导
 *                        「查看全部快捷键」角标点开的就是它）
 *
 * **关键陷阱**（已实测踩过，见 `GAP-ANALYSIS.md`「两轮中修掉的真 bug」4）：
 * 两个 listener 改同一份 state 会让按键「按了没反应」—— 之前 AppShell 与
 * GlobalSidebar 都注册了 ⌘B 的 listener、各翻一次同一份 state，净效果抵消。
 * 现在的做法是把状态**全部** 收到 AppShell 这一层（侧栏的折叠也由
 * `WorkspaceLayout` 提供，但 ⌘B 的 listener 只此一份），并把 ⌘⌥B / ⌘⇧Enter
 * 用同一个 listener 同时分发 —— 同一个 onKey 函数里更新同一份 state，
 * 不存在 race。
 *
 * **WorkspaceLayoutProvider**：放在 AppShell 之内、TeamProvider 之内。
 * 状态放在 context 是因为 AppShell 与首页（app/page.tsx）隔着 children，
 * 没法穿透 prop —— 见 `lib/workspace-layout.tsx` 顶部注释。
 */
export function AppShell({ children }: { children: ReactNode }): React.JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false);
  // 侧栏折叠：⌘B 切换。折叠后 main 的左边距要跟着变，所以状态必须在这里
  // （GlobalSidebar 自己管不了 —— 它不知道 main 的偏移）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Workspace 显隐 / 折叠状态放在 Provider 里 —— AppShell 通过 hook 拿，监听
  // 快捷键并写到 context。
  return (
    <TeamProvider>
      <WorkspaceLayoutProvider>
        <ShellBody
          searchOpen={searchOpen}
          setSearchOpen={setSearchOpen}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
        >
          {children}
        </ShellBody>
      </WorkspaceLayoutProvider>
    </TeamProvider>
  );
}

function ShellBody({
  searchOpen,
  setSearchOpen,
  sidebarCollapsed,
  setSidebarCollapsed,
  children,
}: {
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  children: ReactNode;
}): React.JSX.Element {
  const ws = useWorkspaceLayout();

  // 快捷键总面板（Ctrl /）。**全局开关不放在 ShortcutsDialog 里** ——
  // 面板是被 AppShell 的全局 keydown 驱动的，谁拥有快捷键谁拥有开关状态。
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // N 键新建任务 —— 实测原站侧栏有这个快捷键。
  //
  // Workspace 显隐的快捷键（⌘⌥B / ⌘⇧Enter）2026-10-18 落地 —— Workspace
  // 并排布局已实现（见 apps/web/src/app/page.tsx），快捷键不再空挂。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 正在输入时不抢键 —— ⌘⇧Enter 必须例外，否则 composer 里按
      // Ctrl+Shift+Enter 永远不会触发折叠。
      const typing =
        target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const ce = target?.isContentEditable;
      const isTyping = typing || !!ce;
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'n' && !mod && !e.altKey && !isTyping) {
        e.preventDefault();
        window.location.href = '/new-todo';
        return;
      }

      // ⌘J = 搜索 topics，走同一个命令面板（原站是独立的 topic 搜索，
      // 我们的面板已包含 topics 与 todos，见 CommandPalette）
      if (mod && e.key === 'j' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      // ⌘B = 折叠/展开左侧栏。Ctrl+B 在 Windows 上会被浏览器当成「书签栏」，
      // 但 preventDefault 后有效；实测原站 Ctrl+B 也是这个键。
      // 严格区分：不能有 ⌘⇧B 之类也折叠侧栏。
      if (mod && e.key === 'b' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
        return;
      }

      // ⌘⌥B = 显隐右侧看板。原站语义；只允许 mod+alt+B 一个组合。
      // 不挡在 textarea 里 —— 用户在 composer 里按 ⌘⌥B 不该折叠看板，
      // 那样体验很怪。所以这里**不**做 isTyping 例外，与原站保持一致：
      // 全局快捷键在文本框里也生效。
      if (mod && e.altKey && (e.key === 'b' || e.key === 'B') && !e.shiftKey) {
        e.preventDefault();
        ws.setBoardHidden((cur) => !cur);
        return;
      }

      // ⌘⇧Enter = 折叠/展开 Chief 对话。注意 mod 与 shift 同时存在，
      // **不**带 alt。⌘⇧Enter 也是 textarea 内的「插入换行」常见快捷键，
      // 所以这里要在 textarea/输入态下让位 —— 否则用户不能换行。
      // 原站实测：⌘⇧Enter 在输入态下就是「插入换行」，只有离开输入态
      // 才触发折叠。
      if (mod && e.shiftKey && e.key === 'Enter' && !e.altKey && !isTyping) {
        e.preventDefault();
        ws.setConversationFolded((cur) => !cur);
        return;
      }

      // Ctrl / ⌘/ = 快捷键总面板。
      //
      // 为什么放在最后：它不与上面任何一个组合键重叠（`/` 既不是字母也不是
      // Enter），排在后面纯粹是为了读代码时「常用键在前、兜底键在后」。
      // **不做 isTyping 例外** —— 与 ⌘⌥B 一致，原站的全局快捷键在文本框里
      // 也生效；用户想看帮助面板时正在打字是常态。
      //
      // 键盘布局坑：非美式布局上 `e.key` 可能是 `?`（Shift 已经按下）。
      // 两种都收，否则非美式键盘上这个快捷键是死的。
      if (mod && !e.altKey && !e.shiftKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault();
        setShortcutsOpen((cur) => !cur);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarCollapsed, setSearchOpen, setSidebarCollapsed, ws]);

  return (
    <>
      <GlobalSidebar
        onSearch={() => setSearchOpen(true)}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <main
        style={{
          marginLeft: sidebarCollapsed ? 0 : L.sidebarW,
          minHeight: '100vh',
          padding: `${S.xl}px ${S.lg}px ${S.xxl}px`,
          boxSizing: 'border-box',
          transition: 'margin-left 120ms ease',
        }}
      >
        {children}
      </main>
    </>
  );
}