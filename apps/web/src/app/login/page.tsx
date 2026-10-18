'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * 登录页 —— 单人使用的最简 token 输入。
 *
 * 对标依据：`docs/api-keys.md` 里原站的 key 形如 `tds_your_key`，
 * 那是**机器凭据**；Web 端原站走 NextAuth session。
 * 我们按用户要求改成简单 token：这台机器只有一个人用，
 * 引入 OAuth/多用户体系没有收益。
 *
 * **`?next=` 回跳**：看板在拿到 401 时会跳到 `/login?next=/`（见 `app/page.tsx`）。
 * 登录成功后要回**原来想去的页面**，而不是一律回首页 —— 深链接
 * （比如直接打开某个 todo）否则登录完就丢上下文。
 * 只接受以单个 `/` 开头的相对路径：`//evil.com` 会被浏览器当协议相对 URL
 * 跳到外站，所以必须挡掉双斜杠（开放重定向）。
 */
export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense fallback={<LoginForm next="/" />}>
      <LoginFormWithNext />
    </Suspense>
  );
}

function LoginFormWithNext(): React.JSX.Element {
  const params = useSearchParams();
  const raw = params.get('next');
  // 只允许站内相对路径：`/` 开头且不是 `//`，长度也限一下。
  const next = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  return <LoginForm next={next} />;
}

function LoginForm({ next }: { next: string }): React.JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        // 整页跳转最简单可靠：让服务端组件重新读 cookie
        window.location.href = next;
        return;
      }
      setError('token 不正确');
    } catch {
      setError('请求失败，请检查服务端是否在运行');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#18181b',
        color: '#fafafa',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0, fontWeight: 600 }}>Todos</h1>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
          输入访问 token（服务端环境变量 TDS_WEB_TOKEN）
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="token"
          autoFocus
          autoComplete="current-password"
          style={{
            padding: '10px 12px',
            fontSize: 14,
            borderRadius: 8,
            border: '1px solid #3f3f46',
            background: '#27272a',
            color: '#fafafa',
          }}
        />
        <button
          type="submit"
          disabled={busy || token.length === 0}
          style={{
            padding: '10px 12px',
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 8,
            border: 'none',
            background: busy || token.length === 0 ? '#52525b' : '#fafafa',
            color: busy || token.length === 0 ? '#a1a1aa' : '#18181b',
            cursor: busy || token.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? '校验中…' : '进入'}
        </button>
        {error ? (
          <p style={{ margin: 0, fontSize: 13, color: '#f87171' }} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
