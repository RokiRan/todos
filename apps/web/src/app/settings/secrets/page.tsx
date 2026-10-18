'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Secrets（对标 todos.dev `/settings/secrets`）。
 *
 * 数据契约（与 `apps/server/src/routes/resources.ts` 的 secrets 子句对齐）：
 *
 *   GET    /api/teams/:teamId/secrets
 *     → `{ secrets: SecretSummary[] }`
 *     SecretSummary = { id, teamId, projectId, scope: 'team' | 'project',
 *                       name, description, createdBy, createdAt }
 *     **没有 `value` 字段** —— 值只在上游 `SetSecretBody` 入站时落地（seal 后
 *     永不回传）。UI 上明确写出这一点，避免用户来「查看 secret」处找。
 *
 *   POST   /api/teams/:teamId/secrets
 *     body `{ scope, projectId?, name, description?, value, overwrite? }`
 *     - `name` 必须是 `^[A-Z][A-Z0-9_]*$`（如 `STRIPE_API_KEY`）—— 后端
 *       zod 在 422 里给的具体文案「secret name must match ^[A-Z][A-Z0-9_]*$」，
 *       **前端**先用同一条正则拦下，不让用户白跑一次
 *     - `scope=project` 时 `projectId` 必填
 *     - 同名已存在且没传 `overwrite:true` → 409（前端要把它呈现为「勾选覆盖」
 *       再重提，**不是**当作普通错误）
 *     - 写阅契约：成功回包里仍然没有 value（只有 summary）
 *
 *   DELETE /api/teams/:teamId/secrets
 *     body `{ scope, projectId?, names: string[] }` → `{ ok:true, deleted }`
 *     一次可删多个；BFF 转发时**带 body**（不折 query —— 后端直接读 `req.body`）。
 *
 * **team secrets 是默认关闭的授权项**：原站 agents.md 写明「Team secrets and
 * connections work the same way — off until you grant them」。UI 顶部要写清楚：
 * 设了 secret 不等于 agent 能读到，必须去 agent 的 Access 里单独打开 team_secrets。
 *
 * **写阅契约**（写路径不变 = 改值 = 走新增并 overwrite）：后端没有 PATCH，
 * 因此「编辑」只允许改 name/description；要改值必须重新走新增并勾选 overwrite，
 * 在编辑面板里说明这一点，避免用户去那找「修改值」入口。
 *
 * 不发 userId：写路径让 `proxyWrite` 自动注入；DELETE 由 BFF 不读 userId，
 * 服务端从 cookie 取。
 */

interface SecretSummary {
  id: string;
  teamId: string;
  projectId: string | null;
  scope: 'team' | 'project';
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: number;
}

interface ProjectOption {
  id: string;
  name: string;
}

type ScopeKey = 'team' | 'project';

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** 把 createdAt（epoch ms）转成「YYYY-MM-DD HH:mm」；不引外部时间库，保持一致。 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export default function SecretsPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();
  const isAdmin = activeTeam?.role === 'admin';

  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 新建草稿 ─────────────────────────────────────────────────
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createValue, setCreateValue] = useState('');
  const [createScope, setCreateScope] = useState<ScopeKey>('team');
  const [createProjectId, setCreateProjectId] = useState<string>('');
  /** 409 之后给用户「是否覆盖」的机会；存住当前表单状态避免回填。 */
  const [overwritePrompt, setOverwritePrompt] = useState<{
    name: string;
    scope: ScopeKey;
    projectId: string | null;
    payload: Record<string, unknown>;
  } | null>(null);

  // ── 编辑草稿（仅 name / description；改值 = 走新增 overwrite） ───
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // ── 批量删除勾选 ─────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /** 只读列表 —— 不需要 admin；admin 才能写，所以用 `isAdmin` 隐藏控件。 */
  const load = useCallback(async (): Promise<void> => {
    if (!activeTeam) return;
    const res = await fetch(
      `/api/teams/${encodeURIComponent(activeTeam.teamId)}/secrets`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: SecretSummary[]; reason?: string }
      | null;
    if (body && body.ready && Array.isArray(body.data)) {
      setSecrets(body.data);
      setLoadError(null);
    } else {
      const reason = body && 'reason' in body && typeof body.reason === 'string' ? body.reason : null;
      setLoadError(reason ?? `http-${res.status}`);
      setSecrets(null);
    }
  }, [activeTeam]);

  /** 加载项目下拉选项 —— 用于 scope=project 时选项目。 */
  const loadProjects = useCallback(async (): Promise<void> => {
    if (!activeTeam) return;
    const res = await fetch(
      `/api/projects?teamId=${encodeURIComponent(activeTeam.teamId)}`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: ProjectOption[]; reason?: string }
      | null;
    if (body && body.ready && Array.isArray(body.data)) {
      setProjects(body.data);
    } else {
      // 项目下拉取不到不影响主列表；给空数组 + 控制台即可
      setProjects([]);
    }
  }, [activeTeam]);

  useEffect(() => {
    if (status === 'ready' && activeTeam) {
      void load();
      void loadProjects();
    }
  }, [status, activeTeam, load, loadProjects]);

  const list = useMemo(() => secrets ?? [], [secrets]);
  const projectNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  function toggleSelected(id: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function clearSelection(): void {
    setSelected(new Set());
  }

  /** 把 scope/projectId/names（项目=字符串）打包成上游 DELETE 期望的形状。
   *  注意：`names` 在 `DeleteSecretsBody` 里是 `z.array(z.string().min(1))`，
   *  字符串数组，所以 project scope 按 name 数组发；不要把 `id` 误传成 `name`。 */
  async function batchDelete(): Promise<void> {
    if (!activeTeam || busy || selected.size === 0) return;
    // 按 scope 分组（不能跨 scope 一次删 —— 后端 schema 是单 scope）
    const byScope = new Map<string, { scope: ScopeKey; projectId: string | null; names: string[] }>();
    for (const s of list) {
      if (!selected.has(s.id)) continue;
      const key = `${s.scope}::${s.projectId ?? ''}`;
      const cur = byScope.get(key);
      if (cur) {
        cur.names.push(s.name);
      } else {
        byScope.set(key, { scope: s.scope, projectId: s.projectId, names: [s.name] });
      }
    }
    if (byScope.size === 0) return;
    const totalCount = Array.from(byScope.values()).reduce((n, g) => n + g.names.length, 0);
    const sample = Array.from(byScope.values())
      .slice(0, 3)
      .map((g) =>
          g.scope === 'project'
            ? `项目「${projectNameById.get(g.projectId ?? '') ?? g.projectId ?? ''}」下的 ${g.names.length} 条`
            : `团队级 ${g.names.length} 条`,
        )
      .join('；');
    const ok = confirm(
      `确认删除 ${totalCount} 条 secret（${sample}${byScope.size > 3 ? '…' : ''}）？\n\n` +
        `此操作不可逆 —— secret 的明文值将永久消失，agent 也将无法再访问这些变量。`,
    );
    if (!ok) return;
    setBusy(true);
    setWriteError(null);
    try {
      let firstError: string | null = null;
      let totalDeleted = 0;
      for (const group of byScope.values()) {
        const res = await fetch(
          `/api/teams/${encodeURIComponent(activeTeam.teamId)}/secrets`,
          {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scope: group.scope,
              projectId: group.projectId,
              names: group.names,
            }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          deleted?: number;
          error?: string;
        };
        if (res.ok && data.ok) {
          totalDeleted += typeof data.deleted === 'number' ? data.deleted : group.names.length;
        } else if (firstError === null) {
          firstError = data.error ?? `删除失败 (${res.status})`;
        }
      }
      if (firstError === null) {
        setNotice(`已删除 ${totalDeleted} 条 secret`);
        clearSelection();
        await load();
      } else {
        setWriteError(firstError);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 新增 + 409 → 询问覆盖 → 带 overwrite:true 重提 */
  async function submitCreate(forceOverwrite: boolean): Promise<void> {
    if (!activeTeam || busy) return;
    setWriteError(null);
    setBusy(true);
    try {
      const name = createName.trim();
      const value = createValue;
      const description = createDescription.trim();
      const scope = createScope;
      const projectId = createScope === 'project' ? createProjectId.trim() : null;

      if (!NAME_RE.test(name)) {
        setWriteError('名称必须以大写字母开头，只含大写字母、数字、下划线（例：STRIPE_API_KEY）');
        return;
      }
      if (!value) {
        setWriteError('值不能为空');
        return;
      }
      if (scope === 'project' && !projectId) {
        setWriteError('scope=project 时必须选一个项目');
        return;
      }
      const payload: Record<string, unknown> = {
        scope,
        name,
        description: description || null,
        value,
      };
      if (projectId) payload['projectId'] = projectId;
      if (forceOverwrite) payload['overwrite'] = true;

      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/secrets`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        secret?: SecretSummary;
        error?: string;
      };
      if (res.ok && data.secret) {
        setNotice(
          forceOverwrite
            ? `已覆盖「${data.secret.name}」的值（明文不再可读）`
            : `已创建「${data.secret.name}」`,
        );
        setCreateName('');
        setCreateDescription('');
        setCreateValue('');
        setOverwritePrompt(null);
        await load();
      } else if (res.status === 409) {
        // 414 Unprocessable Entity 之类放普通错误；只有 409 走覆盖询问。
        // 后端 409 文案是「secret "<name>" already exists; pass overwrite:true」，
        // 我们用更直接的本地文案提示覆盖。
        setOverwritePrompt({ name, scope, projectId, payload });
        setWriteError(null);
      } else {
        setWriteError(data.error ?? `创建失败 (${res.status})`);
        setOverwritePrompt(null);
      }
    } finally {
      setBusy(false);
    }
  }

  function openEdit(row: SecretSummary): void {
    setEditingId(row.id);
    setEditName(row.name);
    setEditDescription(row.description ?? '');
  }
  function closeEdit(): void {
    setEditingId(null);
    setEditName('');
    setEditDescription('');
  }
  async function saveEdit(): Promise<void> {
    if (!activeTeam || busy) return;
    setWriteError(null);
    setBusy(true);
    try {
      const newName = editName.trim();
      if (!NAME_RE.test(newName)) {
        setWriteError('名称必须以大写字母开头，只含大写字母、数字、下划线');
        return;
      }
      // 后端 secrets 路由**没有 PATCH** —— 改值/改名必须先删除再新增（带 overwrite）
      // 这条路径直接告知用户走新增，不假装在原地更新。
      setWriteError(
        `Secret 的名称/描述修改需要走「删除 → 新增覆盖」两步（值永不回传，无法在原地编辑）。` +
          `请到下方「新增 secret」面板用同名 + 新描述 + overwrite 重提。`,
      );
      closeEdit();
    } finally {
      setBusy(false);
    }
  }

  // ── 顶层占位（非 ready / 无团队）──────────────────────────────
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  const canWrite = isAdmin;
  const selectedCount = selected.size;

  return (
    <main>
      <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Secrets</h1>
      <p style={hintStyle}>
        Secret 是命名凭据 —— API key、token、服务密码。设了 secret <strong>不等于 agent 能读到</strong>，
        必须去对应 agent 的 <em>Access</em> 里勾上 <strong>Team secrets</strong> 才会以环境变量形式注入到它的 shell 里。
      </p>
      <p style={subHintStyle}>
        值是<strong>写阅</strong>的：保存后任何人（包括管理员）都无法再看到明文。要改值只能再写一条同名 secret 并勾选「覆盖」。
      </p>

      {loadError !== null && (
        <div style={placeholderStyle}>
          <strong>读不到 secret 列表</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>原因：{loadError}</div>
          <button type="button" style={ghostBtn} onClick={() => void load()} disabled={busy}>
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
      {overwritePrompt !== null && (
        <div style={overwriteBannerStyle}>
          <div style={{ flex: 1, fontSize: 13 }}>
            已存在同名 secret「<strong>{overwritePrompt.name}</strong>」（{overwritePrompt.scope === 'project' ? '项目' : '团队'} scope）。
            是否覆盖它的值？覆盖后原值将<strong>永久丢失</strong>。
          </div>
          <button
            type="button"
            style={primaryBtn}
            onClick={() => void submitCreate(true)}
            disabled={busy}
          >
            覆盖
          </button>
          <button
            type="button"
            style={ghostBtn}
            onClick={() => setOverwritePrompt(null)}
            disabled={busy}
          >
            取消
          </button>
        </div>
      )}

      {/* ── 新建 ─────────────────────────────────────────── */}
      {canWrite ? (
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>新增 secret</h2>
          <label style={labelStyle} htmlFor="tds-secret-name">名称</label>
          <input
            id="tds-secret-name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="例如：STRIPE_API_KEY"
            style={inputStyle}
            disabled={busy}
          />
          <div style={metaStyle}>
            必须以大写字母开头，只含大写字母、数字、下划线（{`^[A-Z][A-Z0-9_]*$`}）。
          </div>

          <label style={labelStyle} htmlFor="tds-secret-desc">描述（可选）</label>
          <input
            id="tds-secret-desc"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
            placeholder="agent 看到这个描述就知道这是给什么的"
            style={inputStyle}
            disabled={busy}
          />

          <label style={labelStyle} htmlFor="tds-secret-value">值（保存后无法再读回）</label>
          <input
            id="tds-secret-value"
            type="password"
            value={createValue}
            onChange={(e) => setCreateValue(e.target.value)}
            placeholder="粘贴明文一次，保存后这里将清空"
            style={inputStyle}
            autoComplete="off"
            disabled={busy}
          />

          <div style={row3Style}>
            <div>
              <label style={labelStyle} htmlFor="tds-secret-scope">作用范围</label>
              <select
                id="tds-secret-scope"
                value={createScope}
                onChange={(e) => {
                  const next = e.target.value as ScopeKey;
                  setCreateScope(next);
                  if (next === 'team') setCreateProjectId('');
                }}
                style={selectInlineStyle}
                disabled={busy}
              >
                <option value="team">团队（所有项目可见）</option>
                <option value="project">单个项目</option>
              </select>
            </div>
            {createScope === 'project' ? (
              <div>
                <label style={labelStyle} htmlFor="tds-secret-project">项目</label>
                <select
                  id="tds-secret-project"
                  value={createProjectId}
                  onChange={(e) => setCreateProjectId(e.target.value)}
                  style={selectInlineStyle}
                  disabled={busy || projects.length === 0}
                >
                  <option value="">— 选择项目 —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {projects.length === 0 && (
                  <div style={warnStyle}>项目列表为空，请先到「项目」里创建一个</div>
                )}
              </div>
            ) : null}
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={primaryBtn}
              onClick={() => void submitCreate(false)}
              disabled={busy}
            >
              保存 secret
            </button>
            <span style={metaStyle}>
              值只会提交这一次，明文不会再回传。
            </span>
          </div>
        </section>
      ) : (
        <div style={readonlyHintStyle}>
          只读视图：你是团队成员，没有管理员权限。增删改请联系团队管理员。
        </div>
      )}

      {/* ── 列表 + 批量删除 ────────────────────────────────── */}
      <section style={sectionStyle}>
        <div style={sectionHeadStyle}>
          <h2 style={{ ...sectionTitleStyle, margin: 0 }}>现有 secret（{list.length}）</h2>
          {canWrite && selectedCount > 0 && (
            <button
              type="button"
              style={dangerBtn}
              onClick={() => void batchDelete()}
              disabled={busy}
            >
              删除所选（{selectedCount}）
            </button>
          )}
        </div>
        {list.length === 0 ? (
          <div style={mutedStyle}>还没有 secret。新建一条后会在此列出。</div>
        ) : (
          <div>
            {list.map((s) => {
              const isEditing = editingId === s.id;
              const projectName =
                s.scope === 'project'
                  ? projectNameById.get(s.projectId ?? '') ?? s.projectId ?? '未知项目'
                  : null;
              return (
                <div key={s.id} style={rowStyle}>
                  <div style={rowHeadStyle}>
                    {canWrite && (
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={(e) => toggleSelected(s.id, e.target.checked)}
                        disabled={busy}
                        aria-label={`选择 ${s.name}`}
                      />
                    )}
                    <code style={codeStyle}>{s.name}</code>
                    <span style={badgeStyle}>
                      {s.scope === 'team' ? '团队' : `项目：${projectName}`}
                    </span>
                    {canWrite && (
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={() => (isEditing ? closeEdit() : openEdit(s))}
                        disabled={busy}
                      >
                        {isEditing ? '取消' : '编辑'}
                      </button>
                    )}
                  </div>
                  {s.description !== null && s.description !== '' && (
                    <div style={metaStyle}>{s.description}</div>
                  )}
                  <div style={metaStyle}>
                    创建于 {formatTime(s.createdAt)} · 由 {s.createdBy.slice(0, 8)}… 创建
                    {' · '}
                    <span style={valueMaskStyle}>值永不回传</span>
                  </div>
                  {isEditing && (
                    <div style={editPanelStyle}>
                      <label style={labelStyle} htmlFor={`tds-secret-edit-name-${s.id}`}>名称</label>
                      <input
                        id={`tds-secret-edit-name-${s.id}`}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={inputStyle}
                        disabled={busy}
                      />
                      <label style={labelStyle} htmlFor={`tds-secret-edit-desc-${s.id}`}>
                        描述
                      </label>
                      <input
                        id={`tds-secret-edit-desc-${s.id}`}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        style={inputStyle}
                        disabled={busy}
                      />
                      <div style={metaStyle}>
                        名称 / 描述修改实际上要走「删除同名 → 新增覆盖」两步（值永不回传，无法在原地改）。
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          style={primaryBtn}
                          onClick={() => void saveEdit()}
                          disabled={busy}
                        >
                          提交
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────
//
// 与 Settings 其他页一致：CSS-in-JS + 文件底部 const。颜色与圆角参考 skills/page.tsx。

const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 8, lineHeight: 1.5 };
const subHintStyle: CSSProperties = { color: C.textDim, fontSize: T.sm, marginBottom: S.lg, lineHeight: 1.5 };
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };
const placeholderStyle: CSSProperties = { ...shared.placeholderBox, marginBottom: S.md };
const errorStyle: CSSProperties = { ...shared.errorBox, marginBottom: S.md };
const noticeStyle: CSSProperties = { ...shared.noticeBox, marginBottom: S.md, cursor: 'pointer' };
const warnStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  padding: '6px 10px',
  fontSize: T.sm,
  marginTop: 4,
  color: C.warn,
};
const readonlyHintStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: S.md,
  fontSize: T.meta,
  color: C.warn,
};
const sectionStyle: CSSProperties = { ...shared.card, marginBottom: S.lg };
const sectionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: S.md,
  gap: S.md,
};
const sectionTitleStyle: CSSProperties = { fontSize: T.h3, margin: '0 0 12px', color: C.text };
const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: T.sm,
  color: C.textDim,
  marginTop: S.md,
  marginBottom: 4,
};
const inputStyle: CSSProperties = shared.input;
const selectInlineStyle: CSSProperties = {
  ...shared.input,
  width: 'auto',
  minWidth: 200,
  background: C.bg,
  color: C.text,
};
const row3Style: CSSProperties = { display: 'flex', gap: S.md, marginTop: 4, flexWrap: 'wrap' };
const primaryBtn: CSSProperties = shared.primaryBtn;
const ghostBtn: CSSProperties = { ...shared.ghostBtn, marginLeft: 6 };
const dangerBtn: CSSProperties = shared.dangerBtn;
const overwriteBannerStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: S.md,
  display: 'flex',
  alignItems: 'center',
  gap: S.md,
  flexWrap: 'wrap',
  color: C.text,
};
const rowStyle: CSSProperties = { ...shared.card, marginBottom: 8 };
const rowHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: T.body,
  flexWrap: 'wrap',
};
const badgeStyle: CSSProperties = {
  ...shared.badge,
  background: 'rgba(129,140,248,0.14)',
  color: C.accent,
  border: `1px solid ${C.accent}`,
};
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.sm, marginTop: 4 };
const codeStyle: CSSProperties = {
  background: C.code,
  color: C.text,
  padding: '2px 6px',
  borderRadius: R.sm,
  fontSize: T.meta,
  fontFamily: F.mono,
};
const valueMaskStyle: CSSProperties = {
  color: C.textFaint,
  fontSize: T.sm,
  fontStyle: 'italic',
};
const editPanelStyle: CSSProperties = {
  marginTop: S.md,
  paddingTop: S.md,
  borderTop: `1px solid ${C.line}`,
  display: 'flex',
  flexDirection: 'column',
};
