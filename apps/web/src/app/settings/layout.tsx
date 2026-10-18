'use client';

import type { ReactNode } from 'react';
import { SideNav } from './team-shell';

/**
 * 设置区二级布局 —— 只补一条「设置」子导航。
 *
 * **不再套 `TeamProvider`**：全局侧栏已经把它提到了根布局
 * （`components/AppShell.tsx`）。两处 Provider 意味着每次进设置页都会再发一次
 * `/api/user/context`，且两个实例的选中态（localStorage 同一 key）是独立的 ——
 * 一处 ready 一处 loading 时，页面会先闪「读取中」。
 *
 * 同样**只能有 default 导出**（Next App Router 对 layout 的硬约束：
 * 多一个具名导出就让 `.next/types/.../layout.ts` 报 TS2344）。
 */
export default function SettingsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <SideNav>{children}</SideNav>;
}
