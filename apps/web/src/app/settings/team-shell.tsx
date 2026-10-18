'use client';

import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { C, R, S, T } from '@/lib/design-tokens';

/**
 * 设置区的**二级导航条**（横向 tab）。
 *
 * **为什么不再是左侧 220px 白底面板**：全局侧栏（`components/GlobalSidebar.tsx`）
 * 已经承载了团队切换与一级导航，240px / `#18181b` / 固定定位 —— 与原站实测一致。
 * 再在内容区里塞一块同样的侧栏，就是「两套导航套在一起」，
 * 而那正是 `settings/api-keys` 页早期出现过的双导航问题。
 * 设置项变多之后，横向 tab 更省横向空间。
 *
 * 同时**不再套 `TeamProvider`**：全局侧栏已把它提到根布局（`AppShell`）。
 * 两处 Provider 会各发一次 `/api/user/context`，且两个实例的选中态独立 ——
 * 一处 ready 一处 loading 时页面会先闪「读取中」。
 */

/** 与全局侧栏的分组对齐，但用中文/原站同义名。 */
export const SECTIONS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/settings/projects', label: '项目' },
  { href: '/settings/providers', label: 'Providers' },
  { href: '/settings/skills', label: 'Skills' },
  { href: '/settings/mcp-servers', label: '连接' },
  { href: '/settings/secrets', label: '凭据' },
  { href: '/settings/schedules', label: '定时' },
  { href: '/settings/chief', label: 'Chief' },
  { href: '/settings/api-keys', label: 'API keys' },
];

export function SideNav({ children }: { children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();

  return (
    <div style={wrapStyle}>
      <nav style={barStyle}>
        {SECTIONS.map((s) => {
          const active = pathname === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              style={{
                ...tabStyle,
                color: active ? C.text : C.textFaint,
                background: active ? C.surfaceHi : 'transparent',
                borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
              }}
              aria-current={active ? 'page' : undefined}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * 设置区内容的统一内边距。
 *
 * 全局侧栏已经是 fixed，所以内容区从 `AppShell` 的 marginLeft 开始；这里只补
 * 上下的呼吸空间（实测原站内容容器是 `px-6 pb-16 pt-16` 量级）。
 */
export const settingsPage: CSSProperties = {
  padding: `${S.xl}px ${S.lg}px ${S.xxl}px`,
  maxWidth: 1200,
  margin: '0 auto',
  color: C.text,
  fontSize: T.body,
};

const wrapStyle: CSSProperties = { display: 'block' };

const barStyle: CSSProperties = {
  display: 'flex',
  gap: S.xs,
  padding: `0 ${S.lg}px`,
  marginBottom: S.lg,
  borderBottom: `1px solid ${C.line}`,
  overflowX: 'auto',
};

const tabStyle: CSSProperties = {
  padding: `${S.sm}px ${S.md}px`,
  fontSize: T.meta,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  borderRadius: `${R.md} ${R.md} 0 0`,
};
