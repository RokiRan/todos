'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → API keys（对标原站左侧栏最下方的「设置 → API keys」）。
 *
 * 视觉与功能契约：
 *   - 明文**只显示一次**：创建成功后弹一块「复制我」的提示，之后列表里再也取不到
 *     （文档：「The plaintext value … is shown once — copy it immediately」）
 *   - 已撤销的 key 仍列出来，但置灰且不能改 scopes（文档：撤销不可逆）
 *   - scope 默认全关；每行可展开勾选 MCP 工具（数据源是 `/api/user/mcp-tools`）
 *
 * 与其它页面一致：后端不可达时显示占位，不白屏、不抛错。
 */

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

interface McpTool {
  name: string;
  label: string;
  group: string;
}

const GROUP_LABEL: Record<string, string> = { read: '读取', write: '写入' };

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/user/api-keys', { cache: 'no-store' });
    if (res.status === 401) {
      setKeys([]);
      setError('未登录');
      return;
    }
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: ApiKeyRow[]; error?: string }
      | null;
    if (!body) {
      setKeys([]);
      setError('BFF 没有返回可解析的响应');
      return;
    }
    if (body.ready === false) {
      setKeys([]);
      setError('数据未就绪：后端未实现 /api/user/api-keys');
      return;
    }
    if (!Array.isArray(body.data)) {
      setKeys([]);
      setError(`响应形状不对：${JSON.stringify(body).slice(0, 120)}`);
      return;
    }
    setKeys(body.data);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
    // scope 勾选目录：与后端 tools/list 同源（后端投影 src/mcp-tools.ts）
    void fetch('/api/user/mcp-tools', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((t: unknown) => {
        if (Array.isArray(t)) setTools(t as McpTool[]);
      })
      .catch(() => setTools([]));
  }, [load]);

  async function createKey(): Promise<void> {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/user/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (res.ok && body.key) {
        // 明文只在这一次出现 —— 立刻展示，并明确告诉用户去复制
        setPlaintext(body.key);
        setName('');
        await load();
      } else {
        setError(body.error ?? `创建失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleScope(row: ApiKeyRow, tool: string): Promise<void> {
    const next = row.scopes.includes(tool)
      ? row.scopes.filter((s) => s !== tool)
      : [...row.scopes, tool];
    setBusy(true);
    try {
      const res = await fetch(`/api/user/api-keys/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopes: next }),
      });
      if (res.ok) {
        await load();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `更新失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(row: ApiKeyRow): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/user/api-keys/${encodeURIComponent(row.id)}/revoke`, {
        method: 'POST',
      });
      if (res.ok) {
        setNotice(`已撤销「${row.name}」。用它的客户端会立刻失效；已入网的机器继续运行。`);
        await load();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `撤销失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    // 无 padding / 无「← 返回看板」：设置区的外壳（app/settings/layout.tsx）
    // 已经给了左侧导航与「← 看板」入口。留着会变成两套导航套在一起。
    <main style={{ maxWidth: 1000 }}>
      <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>API keys</h1>
      <p style={hintStyle}>
        key 属于你，不属于团队。每把 key 单独选它的 MCP 工具权限；撤销立即生效，
        但已入网的机器会继续运行。
      </p>

      {error !== null && <div style={errorStyle}><strong>出了点问题</strong><div style={{ marginTop: 4 }}>{error}</div></div>}
      {notice !== null && <div style={noticeStyle} onClick={() => setNotice(null)}>{notice}</div>}

      {plaintext !== null && (
        <div style={plaintextStyle}>
          <strong>复制这把 key —— 它只显示这一次</strong>
          <div style={{ margin: '8px 0' }}>
            <code style={codeStyle}>{plaintext}</code>
          </div>
          <button
            type="button"
            style={primaryBtn}
            onClick={() => {
              void navigator.clipboard?.writeText(plaintext);
              setNotice('已复制到剪贴板');
              setPlaintext(null);
            }}
          >
            复制
          </button>
          <button type="button" style={ghostBtn} onClick={() => setPlaintext(null)}>
            我已保存
          </button>
        </div>
      )}

      <div style={createRowStyle}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="给这把 key 起个名字（如 editor / ci）"
          style={inputStyle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createKey();
          }}
        />
        <button type="button" style={primaryBtn} onClick={() => void createKey()} disabled={busy || !name.trim()}>
          新建 key
        </button>
      </div>

      {keys === null ? (
        <div style={mutedStyle}>读取中…</div>
      ) : keys.length === 0 ? (
        <div style={mutedStyle}>还没有 key。新建的 key 默认一项工具都不能调。</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
          {keys.map((row) => {
            const revoked = row.revokedAt !== null;
            return (
              <li key={row.id} style={rowStyle} data-revoked={revoked ? '1' : '0'}>
                <div style={rowHeadStyle}>
                  <strong style={revoked ? revokedTextStyle : undefined}>{row.name}</strong>
                  <code style={prefixStyle}>{row.keyPrefix}…</code>
                  {revoked && <span style={revokedBadgeStyle}>已撤销</span>}
                  <span style={{ marginLeft: 'auto' }}>
                    {!revoked && (
                      <>
                        <button type="button" style={ghostBtn} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                          {expanded === row.id ? '收起' : `工具（${row.scopes.length}）`}
                        </button>
                        <button type="button" style={dangerBtn} onClick={() => void revokeKey(row)} disabled={busy}>
                          撤销
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <div style={metaStyle}>
                  创建于 {new Date(row.createdAt).toLocaleString()}
                  {row.lastUsedAt !== null && <> · 最近使用 {new Date(row.lastUsedAt).toLocaleString()}</>}
                </div>
                {expanded === row.id && !revoked && (
                  <div style={scopePanelStyle}>
                    {tools.length === 0 ? (
                      <div style={mutedStyle}>工具目录未就绪</div>
                    ) : (
                      (['read', 'write'] as const).map((g) => (
                        <div key={g} style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 4 }}>
                            {GROUP_LABEL[g] ?? g}
                          </div>
                          <div style={checkboxGridStyle}>
                            {tools.filter((t) => t.group === g).map((t) => (
                              <label key={t.name} style={checkboxLabelStyle}>
                                <input
                                  type="checkbox"
                                  checked={row.scopes.includes(`tool:${t.name}`)}
                                  disabled={busy}
                                  onChange={() => void toggleScope(row, `tool:${t.name}`)}
                                />
                                <span>{t.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: S.lg };
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };
const errorStyle: CSSProperties = { ...shared.errorBox, marginBottom: S.md };
const noticeStyle: CSSProperties = {
  background: 'rgba(74,222,128,0.10)',
  border: `1px solid ${C.ok}`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: S.md,
  fontSize: T.meta,
  color: C.ok,
  cursor: 'pointer',
};
const plaintextStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: S.md,
  fontSize: T.meta,
  color: C.warn,
};
const codeStyle: CSSProperties = {
  ...shared.placeholderBox,
  background: C.code,
  border: 'none',
  padding: '4px 8px',
  fontSize: T.meta,
  fontFamily: F.mono,
  wordBreak: 'break-all',
};
const createRowStyle: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 };
const inputStyle: CSSProperties = { ...shared.input, flex: 1 };
const primaryBtn: CSSProperties = { ...shared.primaryBtn, marginRight: 6 };
const ghostBtn: CSSProperties = { ...shared.ghostBtn, marginRight: 6 };
const dangerBtn: CSSProperties = { ...shared.dangerBtn };
const rowStyle: CSSProperties = { ...shared.card, marginBottom: 8 };
const rowHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: T.body };
const prefixStyle: CSSProperties = { color: C.textDim, fontSize: T.sm };
const revokedTextStyle: CSSProperties = { color: C.textGhost, textDecoration: 'line-through' };
const revokedBadgeStyle: CSSProperties = {
  ...shared.badge,
  background: 'transparent',
  color: C.textGhost,
  border: `1px solid ${C.textGhost}`,
};
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.sm, marginTop: 4 };
const scopePanelStyle: CSSProperties = {
  marginTop: S.md,
  paddingTop: S.md,
  borderTop: `1px solid ${C.line}`,
};
const checkboxGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 4 };
const checkboxLabelStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: T.sm, color: C.text };
