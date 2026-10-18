'use client';

import type { ReactNode } from 'react';

/**
 * `/agents` 的布局 —— 现在**不需要**任何外壳。
 *
 * 原先这里包了一层 `TeamShell`，但全局侧栏已经提到根布局
 * （`components/AppShell.tsx`），两处会各发一次 `/api/user/context`。
 * 页面内容自带顶栏（标题 + 说明 + 卡片），侧栏由全局那层负责。
 *
 * 保留这个 layout 文件只为将来放 agents 自己的二级 tab
 * （原站 agent 页有 Overview / Access / Memory 三个 tab）。
 * 同样**只能有 default 导出**（Next App Router 约束）。
 */
export default function AgentsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
