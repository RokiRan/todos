'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  SettingsPlaceholder,
  teamNeedsPlaceholder,
} from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Connections / MCP servers（对标左侧栏「设置 → Connections」）。
 *
 * 一条 connection 对应一个 MCP server；团队的 agent 可以被授权用它发起的工具
 * （工具名前缀是 `mcp__<identifier>__<tool>`）。本页只管 connection 本身的 CRUD，
 * 「哪些 agent 被授权」属于 agent 页 Access 段的职责 —— UI 上注明这一点，避免
 * 用户来这里找开关。
 *
 * 与 skills / secrets 一致：admin 才能写。403 时显示「需要团队管理员」并隐藏
 * 新建 / 编辑 / 删除控件。
 */

/** 后端 `ConnectionSummary` 的字段（`services/connections.ts`）；值字段不会回传。 */
interface ConnectionRow {
  id: string;
  teamId: string;
  kind: string;
  identifier: string;
  transport: string;
  label: string;
  endpoint: string | null;
  configKeys: string[];
  expiresAt: number | null;
  createdBy: string;
  createdAt: number;
}

/** 「凭据草稿」一行 —— key 是已配置键名（编辑时用于回显），value 是用户新输入的值。
 *  留空 value = 不改；非空 = 覆盖该键；新行（key 之前不存在）= 新增。 */
interface CredentialDraft {
  key: string;
  value: string;
}

/** 与后端 `assertValidTransport` 对齐 —— 只允许这两个值。 */
type Transport = 'http' | 'stdio';
const TRANSPORTS: ReadonlyArray<{ value: Transport; label: string; hint: string }> = [
  {
    value: 'http',
    label: 'Remote (HTTP)',
    hint: 'hosted MCP endpoint by URL，认证放凭据里（一般是 Authorization 头）',
  },
  {
    value: 'stdio',
    label: 'Local command (stdio)',
    hint: '在执行机上跑的本地命令（uvx、npx 之类），凭据作为 env vars',
  },
];

/** identifier 校验：与后端 `IDENTIFIER_RE` 完全一致。失败时本端先拦下，422 不浪费。 */
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9_-]*$/;

export default function McpServersPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();
  const isAdmin = activeTeam?.role === 'admin';

  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── 新建表单 ────────────────────────────────────────────
  const [createIdentifier, setCreateIdentifier] = useState('');
  const [createLabel, setCreateLabel] = useState('');
  const [createTransport, setCreateTransport] = useState<Transport>('http');
  const [createEndpoint, setCreateEndpoint] = useState('');
  const [createCredentials, setCreateCredentials] = useState<CredentialDraft[]>([
    { key: '', value: '' },
  ]);
  const [createExpiresAt, setCreateExpiresAt] = useState(''); // 留空 = 不设；非空 = unix ms

  // ── 编辑表单 ────────────────────────────────────────────
  const [editLabel, setEditLabel] = useState('');
  const [editCredentials, setEditCredentials] = useState<CredentialDraft[]>([]);
  const [editExpiresAt, setEditExpiresAt] = useState('');

  const load = useCallback(async (): Promise<void> => {
    if (!activeTeam) return;
    const res = await fetch(
      `/api/teams/${encodeURIComponent(activeTeam.teamId)}/mcp-servers`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: ConnectionRow[]; reason?: string }
      | null;
    if (body && body.ready && Array.isArray(body.data)) {
      setRows(body.data);
      setLoadError(null);
    } else {
      setRows([]);
      setLoadError(
        body && typeof body.reason === 'string'
          ? `数据未就绪：${body.reason}`
          : '数据未就绪：/api/teams/:teamId/mcp-servers',
      );
    }
  }, [activeTeam]);

  useEffect(() => {
    if (status === 'ready' && activeTeam) void load();
  }, [status, activeTeam, load]);

  /** 把 datetime-local 输入转成 unix ms；输入为空或格式错返回 null。 */
  function parseExpiresAt(s: string): number | null {
    if (!s.trim()) return null;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : null;
  }

  /** 从凭据草稿里筛出要发的条目：键名非空 + 值非空（= 用户想覆盖/新增）；
   *  留空 value 的条目完全忽略 —— 这就是「Untouched keys survive a save」。 */
  function compileCredentials(list: CredentialDraft[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of list) {
      const k = c.key.trim();
      if (!k) continue;
      if (c.value === '') continue; // 留空 = 不动该键
      out[k] = c.value;
    }
    return out;
  }

  async function createConnection(): Promise<void> {
    if (!activeTeam || busy) return;
    setWriteError(null);

    const identifier = createIdentifier.trim();
    if (!IDENTIFIER_RE.test(identifier)) {
      setWriteError(
        `identifier 不合规：必须以小写字母或数字开头，后面只能跟小写字母、数字、'-'、'_'（例：my-jira）`,
      );
      return;
    }
    const label = createLabel.trim();
    if (!label) {
      setWriteError('label 不能为空');
      return;
    }
    if (createTransport === 'http' && !createEndpoint.trim()) {
      setWriteError('Remote (HTTP) 必须填 endpoint（URL）');
      return;
    }
    if (createTransport === 'stdio' && !createEndpoint.trim()) {
      // 后端不强制 endpoint for stdio，但本端给一个友好提示（仅是提示，不阻断）
    }

    const credentials = compileCredentials(createCredentials);
    const body: Record<string, unknown> = {
      identifier,
      label,
      transport: createTransport,
    };
    if (createEndpoint.trim()) body.endpoint = createEndpoint.trim();
    if (Object.keys(credentials).length > 0) body.config = credentials;
    const exp = parseExpiresAt(createExpiresAt);
    if (exp !== null) body.expiresAt = exp;

    setBusy(true);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/mcp-servers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        mcpServer?: ConnectionRow;
        error?: string;
      };
      if (res.ok && data.mcpServer) {
        setNotice(`已创建「${data.mcpServer.label}」（identifier=${data.mcpServer.identifier}）`);
        setCreateIdentifier('');
        setCreateLabel('');
        setCreateEndpoint('');
        setCreateTransport('http');
        setCreateCredentials([{ key: '', value: '' }]);
        setCreateExpiresAt('');
        await load();
      } else {
        setWriteError(data.error ?? `创建失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  function openEdit(row: ConnectionRow): void {
    setEditingId(row.identifier);
    setEditLabel(row.label);
    // 编辑时按现有 configKeys 起一行（值留空 = 用户不填 = 不动）。
    // 同时多留一个空行方便新增键。
    const seed: CredentialDraft[] = row.configKeys.map((k) => ({ key: k, value: '' }));
    if (seed.length === 0) seed.push({ key: '', value: '' });
    else seed.push({ key: '', value: '' });
    setEditCredentials(seed);
    setEditExpiresAt(
      row.expiresAt ? toDatetimeLocalInput(row.expiresAt) : '',
    );
  }

  function closeEdit(): void {
    setEditingId(null);
    setEditLabel('');
    setEditCredentials([]);
    setEditExpiresAt('');
  }

  async function saveEdit(row: ConnectionRow): Promise<void> {
    if (!activeTeam || busy) return;
    setWriteError(null);

    const trimmedLabel = editLabel.trim();
    if (!trimmedLabel) {
      setWriteError('label 不能为空');
      return;
    }

    const credentials = compileCredentials(editCredentials);
    const exp = parseExpiresAt(editExpiresAt);
    const expiresAt: number | null | undefined =
      editExpiresAt === '' ? null : exp; // 用户主动清空 = null；非空 = 设值；原值不动则不传

    const patch: Record<string, unknown> = { label: trimmedLabel };
    if (Object.keys(credentials).length > 0) patch.config = credentials;
    // expiresAt 三态：清空（null）/ 设置新值 / 完全不传
    // 这里简化为：只要用户动了 expiresAt 输入框，就发；否则不发
    if (editExpiresAt !== '' || (row.expiresAt !== null && editExpiresAt === '')) {
      patch.expiresAt = expiresAt;
    }

    setBusy(true);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/mcp-servers/${encodeURIComponent(row.identifier)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        mcpServer?: ConnectionRow;
        error?: string;
      };
      if (res.ok && data.mcpServer) {
        setNotice(`已更新「${data.mcpServer.label}」`);
        closeEdit();
        await load();
      } else {
        setWriteError(data.error ?? `更新失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteConnection(row: ConnectionRow): Promise<void> {
    if (!activeTeam || busy) return;
    // 文档原话：deleting 不可逆；agent 在下次会话起不再持有该 connection 的工具。
    const ok = confirm(
      `删除连接「${row.label}」(${row.identifier}) 将立即从所有授权过它的 agent ` +
        `的工具列表里移除（从下次会话起）。此操作不可撤销。`,
    );
    if (!ok) return;
    setBusy(true);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/mcp-servers/${encodeURIComponent(row.identifier)}`,
        { method: 'DELETE' },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        deleted?: string[];
        error?: string;
      };
      if (res.ok && data.ok) {
        setNotice(`已删除「${row.label}」`);
        if (editingId === row.identifier) closeEdit();
        await load();
      } else {
        setWriteError(data.error ?? `删除失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  // ── 派生：列表 / 提示 ────────────────────────────────────
  const list = useMemo(() => rows ?? [], [rows]);
  const transportHint = TRANSPORTS.find((t) => t.value === createTransport)?.hint ?? '';
  const canEdit = isAdmin; // 非 admin 完全只读

  // 顶层占位
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  return (
    <main>
      <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Connections（MCP servers）</h1>
      <p style={hintStyle}>
        一个 connection 是一个 MCP server：catalog 应用走官方一键登录，custom 走本页面手动配置。
        <strong style={{ marginLeft: 4 }}>工具名前缀是</strong>{' '}
        <code style={codeStyle}>mcp__{'<identifier>'}__{'<tool>'}</code>，
        identifier 一旦创建不可改 —— 它已经写进了所有授权过它的 agent 的工具白名单。
        「哪些 agent 被授权用这个连接」请到{' '}
        <strong>Agent 页 → Access</strong> 段配置；本页只管连接本身。
      </p>

      {!isAdmin && (
        <div style={readonlyHintStyle}>
          <strong>只读模式</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            当前账号在该团队是成员角色。新建 / 编辑 / 删除需要团队管理员。
          </div>
        </div>
      )}

      {loadError !== null && (
        <div style={placeholderStyle}>
          <strong>读不到 connection 列表</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>{loadError}</div>
          <button
            type="button"
            style={ghostBtn}
            onClick={() => void load()}
            disabled={busy}
          >
            重试
          </button>
        </div>
      )}
      {writeError !== null && (
        <div style={errorStyle}>
          <strong>出了点问题</strong>
          <div style={{ marginTop: 4 }}>{writeError}</div>
        </div>
      )}
      {notice !== null && (
        <div style={noticeStyle} onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {/* ── 新建 ─────────────────────────────────────────── */}
      {canEdit && (
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>新增 connection</h2>
          <label style={labelStyle} htmlFor="tds-mcp-identifier">identifier（小写 slug，团队内唯一）</label>
          <input
            id="tds-mcp-identifier"
            value={createIdentifier}
            onChange={(e) => setCreateIdentifier(e.target.value)}
            placeholder="例：my-jira"
            style={inputStyle}
            disabled={busy}
          />
          {createIdentifier.trim() !== '' && !IDENTIFIER_RE.test(createIdentifier.trim()) && (
            <div style={warnStyle}>
              identifier 不合规：必须以小写字母或数字开头，后面只能跟小写字母、数字、'-'、'_'
            </div>
          )}

          <label style={labelStyle} htmlFor="tds-mcp-label">label（人类可读的名字）</label>
          <input
            id="tds-mcp-label"
            value={createLabel}
            onChange={(e) => setCreateLabel(e.target.value)}
            placeholder="例：内部 Jira"
            style={inputStyle}
            disabled={busy}
          />

          <label style={labelStyle} htmlFor="tds-mcp-transport">transport</label>
          <select
            id="tds-mcp-transport"
            value={createTransport}
            onChange={(e) => setCreateTransport(e.target.value as Transport)}
            style={selectInlineStyle}
            disabled={busy}
          >
            {TRANSPORTS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <div style={metaStyle}>{transportHint}</div>

          <label style={labelStyle} htmlFor="tds-mcp-endpoint">
            endpoint{createTransport === 'http' ? '（必填）' : '（可选）'}
          </label>
          <input
            id="tds-mcp-endpoint"
            value={createEndpoint}
            onChange={(e) => setCreateEndpoint(e.target.value)}
            placeholder={createTransport === 'http' ? 'https://example.com/mcp' : '可选的本地地址'}
            style={inputStyle}
            disabled={busy}
          />

          <label style={labelStyle}>凭据（headers / env vars）</label>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 6 }}>
            键值对提交给后端密封保存，**值永不回显**。HTTP transport 一般用
            <code style={codeStyle}> Authorization</code> 作为键；stdio 用环境变量名（如
            <code style={codeStyle}> JIRA_API_TOKEN</code>）。
          </div>
          {createCredentials.map((c, i) => (
            <div key={i} style={credRowStyle}>
              <input
                value={c.key}
                onChange={(e) =>
                  setCreateCredentials((prev) =>
                    prev.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)),
                  )
                }
                placeholder="键名（例：Authorization）"
                style={{ ...inputStyle, flex: '0 0 200px' }}
                disabled={busy}
              />
              <input
                type="password"
                value={c.value}
                onChange={(e) =>
                  setCreateCredentials((prev) =>
                    prev.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)),
                  )
                }
                placeholder="值（提交后只进密文，不回显）"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                disabled={busy}
              />
              <button
                type="button"
                style={dangerBtn}
                onClick={() =>
                  setCreateCredentials((prev) =>
                    prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i),
                  )
                }
                disabled={busy || createCredentials.length <= 1}
              >
                移除
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              style={ghostBtn}
              onClick={() =>
                setCreateCredentials((prev) => [...prev, { key: '', value: '' }])
              }
              disabled={busy}
            >
              + 添加凭据
            </button>
          </div>

          <label style={labelStyle} htmlFor="tds-mcp-expires">expires at（可选，本地时区）</label>
          <input
            id="tds-mcp-expires"
            type="datetime-local"
            value={createExpiresAt}
            onChange={(e) => setCreateExpiresAt(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />

          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              style={primaryBtn}
              onClick={() => void createConnection()}
              disabled={
                busy ||
                !IDENTIFIER_RE.test(createIdentifier.trim()) ||
                !createLabel.trim() ||
                (createTransport === 'http' && !createEndpoint.trim())
              }
            >
              新建 connection
            </button>
          </div>
        </section>
      )}

      {/* ── 列表 ─────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>已配置的 connection（{list.length} / 20）</h2>
        {rows === null ? (
          <div style={mutedStyle}>读取中…</div>
        ) : list.length === 0 ? (
          <div style={mutedStyle}>
            还没有 connection。
            {canEdit ? '在上面填一份来新建第一条。' : ''}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {list.map((row) => (
              <li key={row.id} style={rowStyle}>
                <div style={rowHeadStyle}>
                  <strong>{row.label}</strong>
                  <span style={badgeStyle}>{row.transport}</span>
                  <code style={codeStyle}>{row.identifier}</code>
                  <span style={metaStyle}>
                    工具名前缀：mcp__{row.identifier}__…
                  </span>
                  <span style={{ marginLeft: 'auto' }}>
                    {canEdit && editingId !== row.identifier && (
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={() => openEdit(row)}
                        disabled={busy}
                      >
                        编辑
                      </button>
                    )}
                    {canEdit && editingId === row.identifier && (
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={closeEdit}
                        disabled={busy}
                      >
                        取消编辑
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        style={dangerBtn}
                        onClick={() => void deleteConnection(row)}
                        disabled={busy}
                      >
                        删除
                      </button>
                    )}
                  </span>
                </div>
                <div style={metaStyle}>
                  endpoint：<code style={codeStyle}>{row.endpoint ?? '（无）'}</code>
                </div>
                <div style={metaStyle}>
                  已配置凭据：
                  {row.configKeys.length === 0 ? (
                    <em style={{ color: C.textFaint }}> 无</em>
                  ) : (
                    row.configKeys.map((k) => (
                      <code key={k} style={{ ...codeStyle, marginRight: 4 }}>
                        {k}
                      </code>
                    ))
                  )}
                </div>
                {row.expiresAt !== null && (
                  <div style={metaStyle}>
                    expires at：{new Date(row.expiresAt).toLocaleString()}
                  </div>
                )}
                <div style={metaStyle}>
                  创建于 {new Date(row.createdAt).toLocaleString()}
                </div>

                {/* ── 字段不可改提示 ──────────────────────── */}
                {canEdit && editingId !== row.identifier && (
                  <div style={immutableStyle}>
                    identifier / transport / endpoint 一旦建好不可改 —— 删了重建会改工具名前缀，
                    授权过的 agent 会全部失效。
                  </div>
                )}

                {/* ── 编辑面板 ────────────────────────────── */}
                {canEdit && editingId === row.identifier && (
                  <div style={editPanelStyle}>
                    <label style={labelStyle} htmlFor={`tds-edit-label-${row.id}`}>label</label>
                    <input
                      id={`tds-edit-label-${row.id}`}
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      style={inputStyle}
                      disabled={busy}
                    />

                    <label style={labelStyle}>凭据（{row.configKeys.length} 个已存）</label>
                    <div style={{ fontSize: 12, color: C.textDim, marginBottom: 6 }}>
                      **留空 = 不改该键**（文档：「Untouched keys survive a save」）。
                      填了新值就覆盖；要新增键，加一行填键名 + 值。
                      <br />
                      **清空一个已有键** —— 当前后端没有「删除单个键」的接口；本表单留空的条目会被忽略，
                      所以「删除」要走：填一个空字符串覆盖该键（值会被覆盖成空串）。
                      <br />
                      值字段是 password 类型，提交后只进密文，永不回显。
                    </div>
                    {editCredentials.map((c, i) => (
                      <div key={i} style={credRowStyle}>
                        <input
                          value={c.key}
                          onChange={(e) =>
                            setEditCredentials((prev) =>
                              prev.map((x, idx) =>
                                idx === i ? { ...x, key: e.target.value } : x,
                              ),
                            )
                          }
                          placeholder="键名"
                          style={{ ...inputStyle, flex: '0 0 200px' }}
                          disabled={busy}
                        />
                        <input
                          type="password"
                          value={c.value}
                          onChange={(e) =>
                            setEditCredentials((prev) =>
                              prev.map((x, idx) =>
                                idx === i ? { ...x, value: e.target.value } : x,
                              ),
                            )
                          }
                          placeholder="留空 = 不动；填值 = 覆盖；新增行 = 新增键"
                          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          style={dangerBtn}
                          onClick={() =>
                            setEditCredentials((prev) =>
                              prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i),
                            )
                          }
                          disabled={busy || editCredentials.length <= 1}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={() =>
                          setEditCredentials((prev) => [...prev, { key: '', value: '' }])
                        }
                        disabled={busy}
                      >
                        + 添加新键
                      </button>
                      <span style={metaStyle}>
                        本次会发送{' '}
                        {editCredentials.filter((c) => c.key.trim().length > 0).length} 个键名
                        （其中只有非空 value 的会真正写入）
                      </span>
                    </div>

                    <label style={labelStyle} htmlFor={`tds-edit-expires-${row.id}`}>
                      expires at（清空 = 取消过期时间；留原值 = 不改）
                    </label>
                    <input
                      id={`tds-edit-expires-${row.id}`}
                      type="datetime-local"
                      value={editExpiresAt}
                      onChange={(e) => setEditExpiresAt(e.target.value)}
                      style={inputStyle}
                      disabled={busy}
                    />

                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        style={primaryBtn}
                        onClick={() => void saveEdit(row)}
                        disabled={busy || !editLabel.trim()}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={closeEdit}
                        disabled={busy}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// ── 辅助 ────────────────────────────────────────────────────────

/** unix ms → datetime-local 输入框能吃的 `YYYY-MM-DDTHH:mm` 形式（用本地时区） */
function toDatetimeLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 样式 ────────────────────────────────────────────────────────

const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: S.lg };
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };
const errorStyle: CSSProperties = { ...shared.errorBox, marginBottom: S.md };
const noticeStyle: CSSProperties = { ...shared.noticeBox, marginBottom: S.md, cursor: 'pointer' };
const placeholderStyle: CSSProperties = { ...shared.placeholderBox, marginBottom: S.md };
const sectionStyle: CSSProperties = { ...shared.card, marginBottom: S.lg };
const sectionTitleStyle: CSSProperties = { fontSize: T.bodyLg, margin: '0 0 12px', color: C.text };
const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: T.sm,
  color: C.textDim,
  margin: '8px 0 4px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const inputStyle: CSSProperties = shared.input;
const selectInlineStyle: CSSProperties = {
  ...shared.input,
  width: 'auto',
  minWidth: 200,
  background: C.bg,
  color: C.text,
};
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.sm, marginTop: 4 };
const warnStyle: CSSProperties = { color: C.danger, fontSize: T.sm, marginTop: 4 };
const codeStyle: CSSProperties = {
  background: C.code,
  color: C.text,
  padding: '2px 6px',
  borderRadius: R.sm,
  fontSize: T.sm,
  fontFamily: F.mono,
};
const badgeStyle: CSSProperties = {
  ...shared.badge,
  background: 'rgba(129,140,248,0.14)',
  color: C.accent,
  border: `1px solid ${C.accent}`,
};
const rowStyle: CSSProperties = { ...shared.card, marginBottom: 8 };
const rowHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: T.body,
  flexWrap: 'wrap',
};
const credRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'stretch',
  marginBottom: 6,
  flexWrap: 'wrap',
};
const primaryBtn: CSSProperties = shared.primaryBtn;
const ghostBtn: CSSProperties = { ...shared.ghostBtn, marginRight: 6 };
const dangerBtn: CSSProperties = shared.dangerBtn;
const editPanelStyle: CSSProperties = {
  marginTop: S.md,
  paddingTop: S.md,
  borderTop: `1px solid ${C.line}`,
  display: 'flex',
  flexDirection: 'column',
};
const immutableStyle: CSSProperties = {
  marginTop: 8,
  padding: 8,
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  fontSize: T.sm,
  color: C.warn,
};
const readonlyHintStyle: CSSProperties = {
  ...shared.placeholderBox,
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  color: C.warn,
  marginBottom: S.md,
};
