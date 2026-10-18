'use client';

import { Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { C, F, T } from '@/lib/design-tokens';

/**
 * 全局登录守卫 —— 未登录时不渲染任何业务内容。
 *
 * **为什么不能只在各页面处理 401**：每个页面的 `fetchJson` 拿到 401 后各自处理，
 * 于是 ① 登录前会先闪一下完整界面（骨架已渲染、数据随后 401），② 处理方式必然漂移
 * —— 看板跳了登录页、设置区显示「未登录」、详情页显示红色错误条。
 * 原站是服务端 session 守卫：未登录请求根本到不了页面。这里前端没有服务端渲染守卫，
 * 就在客户端最外层补一个，效果等价：**内容不画出来**。
 *
 * 判定只做一次：查 `/api/auth/session`（`authed` 字段）。这不是每次请求都查 ——
 * 后续页面的 401 仍会各自触发跳转，这里只负责「首次渲染前」这道闸。
 */

type AuthState = 'checking' | 'authed' | 'anon';

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Suspense fallback={<BootScreen />}>
      <AuthGateInner>{children}</AuthGateInner>
    </Suspense>
  );
}

function AuthGateInner({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>('checking');
  const pathname = usePathname();
  const search = useSearchParams();

  // 登录页本身不能被守卫挡住，否则会变成「跳登录 → 又跳登录」的死循环
  const isLogin = pathname === '/login';

  useEffect(() => {
    if (isLogin) {
      setState('authed');
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as { authed?: boolean } | null;
        if (!alive) return;
        // 查不到（后端不可达）时**按已登录放行**：否则后端一挂整站变成登录页，
        // 而各页面本来就有「后端不可达」的降级提示，那种提示比登录页更准确。
        setState(body?.authed === false ? 'anon' : 'authed');
      } catch {
        if (alive) setState('authed');
      }
    })();
    return () => {
      alive = false;
    };
  }, [isLogin]);

  useEffect(() => {
    if (state !== 'anon') return;
    // 带上原路径，登录完能回来（登录页只接受站内相对路径，见 login/page.tsx）
    const next = pathname === '/' ? '/' : `${pathname}${search?.toString() ? `?${search}` : ''}`;
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }, [state, pathname, search]);

  if (state === 'checking') return <BootScreen />;
  if (state === 'anon') return <BootScreen message="正在转到登录页…" />;
  return <>{children}</>;
}

function BootScreen({ message = '正在检查登录状态…' }: { message?: string }): React.JSX.Element {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        color: C.textFaint,
        fontFamily: F.sans,
        fontSize: T.meta,
      }}
    >
      {message}
    </main>
  );
}
