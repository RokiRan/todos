'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { useTeamAgents, useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Skills（对标左侧栏「设置 → Skills」）。
 *
 * 数据契约（已在主代理的冻结文档里写明，与 `apps/server/src/routes/skills.ts` 逐字对齐）：
 *
 *   `GET    /api/teams/:teamId/skills`
 *     → `{skills: SkillPublic[]}`
 *     SkillPublic = { id, teamId, name, source, sourceUrl, storagePath,
 *                     sizeBytes, fileCount, createdBy, createdAt, deletedAt }
 *
 *   `POST   /api/teams/:teamId/skills`
 *     body `{ userId, name, skillMd, source?, sourceUrl?, assets? }`
 *     `assets` = `[{ name, contentBase64 }]`（字段名与 `AssetSchema` 逐字一致）
 *     `source` 枚举：`folder | github | files | chief`（默认 `files`）
 *     上限：10 MiB / 256 文件；后端会用 Fastify 默认 bodyLimit 顶住 12 MiB。
 *
 *   `PATCH  /api/teams/:teamId/skills/:skillId`
 *     body `{ userId, name?, skillMd? }`（两者都传空也会被 zod 拒；name/skillMd 都带 `min(1)`）
 *
 *   `DELETE /api/teams/:teamId/skills/:skillId`
 *     无 body；硬删除，不可撤销。
 *
 *   `POST   /api/teams/:teamId/agents/:agentId/skills`
 *     body `{ userId, defaultSkillIds }`  **整体替换** vs 增量追加由调用方决定；
 *     ≤ 10 / agent；skill 必须属于本 team 且未删。
 *
 * 为什么不显示「agent 真带哪些 skill」：`ctx.agents` 里没有这个字段，重拉
 * `GET /api/teams/:teamId/agents/:id` 也没有专门的工具栏，避免伪造状态；只呈现
 * 用户**此次勾选的草稿**。
 */

interface SkillPublic {
  id: string;
  teamId: string;
  name: string;
  source: 'folder' | 'github' | 'files' | 'chief';
  sourceUrl: string | null;
  storagePath: string;
  sizeBytes: number;
  fileCount: number;
  createdBy: string;
  createdAt: number;
  deletedAt: number | null;
}

/** 草稿态资产条目 —— 在表单里以「name + 明文 content」两列编辑，提交前转 base64。 */
interface AssetDraft {
  name: string;
  content: string;
}

const MAX_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 256;
const MAX_DEFAULT_SKILLS_PER_AGENT = 10;

const SOURCE_LABEL: Record<SkillPublic['source'], string> = {
  folder: '从文件夹',
  github: '从 GitHub',
  files: '从文件',
  chief: 'Chief 对话',
};

const K = 1024;
const M = K * 1024;
/** 字节数 → 人类可读（例：12.3 KB）。在列表 / 提示 / 总大小三处复用。 */
const formatBytes = (n: number): string =>
  n < K ? `${n} B` : n < M ? `${(n / K).toFixed(1)} KB` : `${(n / M).toFixed(1)} MB`;

/** 把用户粘贴的明文转成 base64。前端用 btoa 在 latin1 通道编码；中文/二进制
 * 走 Unicode 友好路径（encodeURIComponent → unescape → btoa）。 */
function encodeBase64(text: string): string {
  try {
    // 不带 BOM 的纯 ASCII 走快路径
    return btoa(unescape(encodeURIComponent(text)));
  } catch {
    return '';
  }
}

/** 把资产草稿批量编码；返回 `{ assets, byteCount, fileCount, error }`，
 * 任何一项失败都给出本地提示，前端先拦下不送服务端。 */
function compileAssets(list: AssetDraft[]): {
  assets: { name: string; contentBase64: string }[];
  byteCount: number;
  fileCount: number;
  error: string | null;
} {
  const out: { name: string; contentBase64: string }[] = [];
  let byteCount = 0;
  for (const a of list) {
    const name = a.name.trim();
    if (!name) continue;
    const b64 = encodeBase64(a.content);
    if (!b64) {
      return { assets: [], byteCount: 0, fileCount: 0, error: `资产「${name}」无法编码为 base64` };
    }
    // b64 解码后的大小约等于 (b64.length * 3) / 4 —— 用这个粗估避免在浏览器里
    // 真的再 decode 一遍
    const decoded = Math.floor((b64.length * 3) / 4);
    byteCount += decoded;
    out.push({ name, contentBase64: b64 });
  }
  // +1 for SKILL.md（必然存在）
  const fileCount = out.length + 1;
  return { assets: out, byteCount, fileCount, error: null };
}

export default function SkillsPage(): React.JSX.Element {
  const { ctx, status, activeTeam } = useTeamContext();
  const userId = ctx?.userId ?? '';
  const agents = useTeamAgents();

  const [skills, setSkills] = useState<SkillPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 新建表单 ─────────────────────────────────────────────────
  const [createName, setCreateName] = useState('');
  const [createMd, setCreateMd] = useState('');
  const [createSource, setCreateSource] = useState<SkillPublic['source']>('files');
  const [createSourceUrl, setCreateSourceUrl] = useState('');
  const [createAssets, setCreateAssets] = useState<AssetDraft[]>([]);

  // ── 编辑表单 ─────────────────────────────────────────────────
  const [editName, setEditName] = useState('');
  const [editMd, setEditMd] = useState('');

  // ── 分配给 agent 的勾选草稿：agentId → skillId 集合 ───────────
  const [draftByAgent, setDraftByAgent] = useState<Record<string, Set<string>>>({});

  const load = useCallback(async (): Promise<void> => {
    if (!activeTeam) return;
    const res = await fetch(`/api/teams/${encodeURIComponent(activeTeam.teamId)}/skills`, {
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: SkillPublic[]; reason?: string }
      | null;
    if (body && body.ready && Array.isArray(body.data)) {
      setSkills(body.data);
      setLoadError(null);
    } else {
      setSkills([]);
      setLoadError(
        body && typeof body.reason === 'string'
          ? `数据未就绪：${body.reason}`
          : '数据未就绪：/api/teams/:teamId/skills',
      );
    }
  }, [activeTeam]);

  useEffect(() => {
    if (status === 'ready' && activeTeam) void load();
  }, [status, activeTeam, load]);

  /** 重新拉一次 skill 列表；agent 的勾选草稿不动（不属于本任务的真理来源）。 */
  const refreshSkills = useCallback(async (): Promise<void> => {
    await load();
  }, [load]);

  // ── 列表派生：name/size/fileCount/source/createdAt ───────────
  const skillList = useMemo(() => skills ?? [], [skills]);

  async function createSkill(): Promise<void> {
    if (!activeTeam || busy) return;
    setWriteError(null);
    setBusy(true);
    try {
      const name = createName.trim();
      const skillMd = createMd;
      if (!name) {
        setWriteError('请填写名称');
        return;
      }
      if (!skillMd.trim()) {
        setWriteError('SKILL.md 正文不能为空 —— 这是 skill 的必读文档正文');
        return;
      }
      const compiled = compileAssets(createAssets);
      if (compiled.error) {
        setWriteError(compiled.error);
        return;
      }
      // 10 MiB 上限 + 256 文件上限 —— 本地先拦下再送服务端
      const mdBytes = new TextEncoder().encode(skillMd).byteLength;
      const totalBytes = mdBytes + compiled.byteCount;
      if (totalBytes > MAX_SKILL_BYTES) {
        setWriteError(`总大小超过 10 MiB 上限（${formatBytes(totalBytes)}）`);
        return;
      }
      if (compiled.fileCount > MAX_FILE_COUNT) {
        setWriteError(`文件数超过 256 上限（${compiled.fileCount}）`);
        return;
      }
      const body: Record<string, unknown> = {
        userId,
        name,
        skillMd,
        source: createSource,
        sourceUrl: createSourceUrl.trim() || null,
        assets: compiled.assets,
      };
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/skills`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        skill?: SkillPublic;
        error?: string;
      };
      if (res.ok && data.skill) {
        setNotice(`已创建「${data.skill.name}」`);
        setCreateName('');
        setCreateMd('');
        setCreateSourceUrl('');
        setCreateAssets([]);
        await refreshSkills();
      } else {
        setWriteError(data.error ?? `创建失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  function openEdit(row: SkillPublic): void {
    setEditingId(row.id);
    setEditName(row.name);
    setEditMd('');
  }

  function closeEdit(): void {
    setEditingId(null);
    setEditName('');
    setEditMd('');
  }

  async function saveEdit(row: SkillPublic): Promise<void> {
    if (!activeTeam || busy) return;
    setWriteError(null);
    setBusy(true);
    try {
      // 「SKILL.md 留空表示不改；name 必填」—— 后端要求两者至少传一个，且 zod 都是 min(1)
      const patch: { userId: string; name?: string; skillMd?: string } = { userId };
      const trimmedName = editName.trim();
      const trimmedMd = editMd;
      if (trimmedName && trimmedName !== row.name) patch.name = trimmedName;
      if (trimmedMd) patch.skillMd = trimmedMd;
      if (patch.name === undefined && patch.skillMd === undefined) {
        setWriteError('没改动任何字段 —— 想改名就改 name 想覆盖 SKILL.md 就填正文，否则不要保存');
        return;
      }
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/skills/${encodeURIComponent(row.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        skill?: SkillPublic;
        error?: string;
      };
      if (res.ok && data.skill) {
        setNotice(`已更新「${data.skill.name}」`);
        closeEdit();
        await refreshSkills();
      } else {
        setWriteError(data.error ?? `更新失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteSkill(row: SkillPublic): Promise<void> {
    if (!activeTeam || busy) return;
    // 文档原话：Deleting a skill cannot be undone ... Agents carrying it simply
    // stop carrying it from their next turn —— 这里必须用 confirm 二问，文案写明
    // 不可撤销 + 副作用。
    const ok = confirm(
      `删除「${row.name}」将永久移除该 skill 及其 ${formatBytes(row.sizeBytes)} 的磁盘内容，` +
        `且绑定到该 skill 的 agent 会从下次会话起不再携带它。此操作不可撤销。`,
    );
    if (!ok) return;
    setBusy(true);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/skills/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setNotice(`已删除「${row.name}」`);
        if (editingId === row.id) closeEdit();
        await refreshSkills();
      } else {
        setWriteError(data.error ?? `删除失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  // ── 分配给 agent ──────────────────────────────────────────────
  function toggleDraftSkill(agentId: string, skillId: string, on: boolean): void {
    setDraftByAgent((prev) => {
      const next: Record<string, Set<string>> = { ...prev };
      const cur = new Set(next[agentId] ?? []);
      if (on) {
        if (cur.size >= MAX_DEFAULT_SKILLS_PER_AGENT) return prev; // 上限硬卡
        cur.add(skillId);
      } else {
        cur.delete(skillId);
      }
      next[agentId] = cur;
      return next;
    });
  }

  async function saveAgentDrafts(agentId: string): Promise<void> {
    if (!activeTeam || busy) return;
    setBusy(true);
    setWriteError(null);
    try {
      const ids = Array.from(draftByAgent[agentId] ?? []);
      const body = { userId, defaultSkillIds: ids };
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/agents/${encodeURIComponent(agentId)}/skills`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        agentId?: string;
        defaultSkillIds?: string[];
        error?: string;
      };
      if (res.ok && data.agentId) {
        setNotice(
          `已保存 ${data.defaultSkillIds?.length ?? ids.length} 个 skill 到 agent「${
            agents.find((a) => a.id === agentId)?.displayName ?? agentId
          }」`,
        );
      } else {
        setWriteError(data.error ?? `保存失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  function setDraftSkillsForAgent(agentId: string, ids: string[]): void {
    // 把当前勾选态替换成传入集合 —— 用于「全选/全清」等快捷动作
    const capped = ids.slice(0, MAX_DEFAULT_SKILLS_PER_AGENT);
    setDraftByAgent((prev) => ({ ...prev, [agentId]: new Set(capped) }));
  }

  // ── 顶层占位（非 ready / 无团队）──────────────────────────────
  // 布尔判定，不用 `if (<SettingsPlaceholder/>)`（JSX 恒真，见 settings-placeholder.tsx）
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  return (
    <main>
      <h1 style={{ fontSize: T.h2, margin: '0 0 4px', color: C.text }}>Skills</h1>
      <p style={hintStyle}>
        Skill 是一段 SKILL.md 正文 + 可选的 companion 资源；团队级共享，
        可以指给 agent 作为 default skill。
      </p>

      {loadError !== null && (
        <div style={placeholderStyle}>
          <strong>读不到 skill 列表</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>{loadError}</div>
          <button type="button" style={ghostBtn} onClick={() => void refreshSkills()} disabled={busy}>
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
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>新增 skill</h2>
        <label style={labelStyle} htmlFor="tds-skill-name">名称</label>
        <input
          id="tds-skill-name"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder="例如：commit-message-style"
          style={inputStyle}
          disabled={busy}
        />

        <label style={labelStyle} htmlFor="tds-skill-md">SKILL.md 正文（必填）</label>
        <textarea
          id="tds-skill-md"
          value={createMd}
          onChange={(e) => setCreateMd(e.target.value)}
          placeholder="# 我的 skill&#10;&#10;描述这个 skill 做什么、何时启用…"
          rows={8}
          style={textareaStyle}
          disabled={busy}
        />
        <div style={metaStyle}>
          {formatBytes(new TextEncoder().encode(createMd).byteLength)} / 10 MiB
        </div>

        <div style={row3Style}>
          <div>
            <label style={labelStyle} htmlFor="tds-skill-source">来源</label>
            <select
              id="tds-skill-source"
              value={createSource}
              onChange={(e) => setCreateSource(e.target.value as SkillPublic['source'])}
              style={selectInlineStyle}
              disabled={busy}
            >
              {(Object.keys(SOURCE_LABEL) as SkillPublic['source'][]).map((k) => (
                <option key={k} value={k}>
                  {SOURCE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle} htmlFor="tds-skill-url">来源 URL（可选）</label>
            <input
              id="tds-skill-url"
              value={createSourceUrl}
              onChange={(e) => setCreateSourceUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              style={inputStyle}
              disabled={busy}
            />
          </div>
        </div>

        <label style={labelStyle}>companion assets（可选，name + 明文内容，提交时 base64）</label>
        {createAssets.map((a, i) => (
          <div key={i} style={assetRowStyle}>
            <input
              value={a.name}
              onChange={(e) =>
                setCreateAssets((prev) =>
                  prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)),
                )
              }
              placeholder="templates/checklist.md"
              style={{ ...inputStyle, flex: '0 0 220px' }}
              disabled={busy}
            />
            <textarea
              value={a.content}
              onChange={(e) =>
                setCreateAssets((prev) =>
                  prev.map((x, idx) => (idx === i ? { ...x, content: e.target.value } : x)),
                )
              }
              placeholder="文件原文（提交时自动 base64）"
              rows={3}
              style={{ ...textareaStyle, flex: 1, minWidth: 0 }}
              disabled={busy}
            />
            <button
              type="button"
              style={dangerBtn}
              onClick={() =>
                setCreateAssets((prev) => prev.filter((_, idx) => idx !== i))
              }
              disabled={busy}
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
              setCreateAssets((prev) => (prev.length >= MAX_FILE_COUNT - 1 ? prev : [...prev, { name: '', content: '' }]))
            }
            disabled={busy || createAssets.length >= MAX_FILE_COUNT - 1}
          >
            + 添加 asset
          </button>
          <span style={metaStyle}>
            最多 255 个 asset（含 SKILL.md 共 ≤ {MAX_FILE_COUNT} 个文件）
          </span>
        </div>

        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            style={primaryBtn}
            onClick={() => void createSkill()}
            disabled={busy || !createName.trim() || !createMd.trim()}
          >
            新建 skill
          </button>
        </div>
      </section>

      {/* ── 列表 ─────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>已存在的 skill（{skillList.length}）</h2>
        {skills === null ? (
          <div style={mutedStyle}>读取中…</div>
        ) : skillList.length === 0 ? (
          <div style={mutedStyle}>还没有 skill。</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {skillList.map((row) => (
              <li key={row.id} style={rowStyle}>
                <div style={rowHeadStyle}>
                  <strong>{row.name}</strong>
                  <span style={badgeStyle}>{SOURCE_LABEL[row.source]}</span>
                  <span style={metaStyle}>
                    {formatBytes(row.sizeBytes)} · {row.fileCount} 文件
                  </span>
                  <span style={{ marginLeft: 'auto' }}>
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                      disabled={busy}
                    >
                      {expandedId === row.id ? '收起' : '详情'}
                    </button>
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => (editingId === row.id ? closeEdit() : openEdit(row))}
                      disabled={busy}
                    >
                      {editingId === row.id ? '取消编辑' : '改名 / 改正文'}
                    </button>
                    <button
                      type="button"
                      style={dangerBtn}
                      onClick={() => void deleteSkill(row)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </span>
                </div>
                <div style={metaStyle}>
                  创建于 {new Date(row.createdAt).toLocaleString()} · storagePath{' '}
                  <code style={codeStyle}>{row.storagePath}</code>
                </div>

                {expandedId === row.id && (
                  <div style={expandPanelStyle}>
                    <div>
                      <span style={labelStyle}>sourceUrl</span>
                      <span style={{ fontSize: T.meta }}>
                        {row.sourceUrl ?? <em style={{ color: C.textFaint }}>未设置</em>}
                      </span>
                    </div>
                  </div>
                )}

                {editingId === row.id && (
                  <div style={expandPanelStyle}>
                    <label style={labelStyle} htmlFor={`tds-edit-name-${row.id}`}>名称</label>
                    <input
                      id={`tds-edit-name-${row.id}`}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={inputStyle}
                      disabled={busy}
                    />
                    <label style={labelStyle} htmlFor={`tds-edit-md-${row.id}`}>
                      新的 SKILL.md 正文（留空 = 仅改名 / 仅改名不动正文）
                    </label>
                    <textarea
                      id={`tds-edit-md-${row.id}`}
                      value={editMd}
                      onChange={(e) => setEditMd(e.target.value)}
                      rows={6}
                      style={textareaStyle}
                      disabled={busy}
                    />
                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        style={primaryBtn}
                        onClick={() => void saveEdit(row)}
                        disabled={busy}
                      >
                        保存
                      </button>
                      <button type="button" style={ghostBtn} onClick={closeEdit} disabled={busy}>
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

      {/* ── 分配给 agent ─────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>分配给 agent</h2>
        <p style={hintStyle}>
          一个 agent 最多带 {MAX_DEFAULT_SKILLS_PER_AGENT} 个 default skill。保存会**整体替换**
          该 agent 的 `defaultSkillIds`（非增量）—— 已勾选的留下，没勾的会从下次会话起
          不再携带。
        </p>
        {agents.length === 0 ? (
          <div style={mutedStyle}>当前团队还没有 agent。</div>
        ) : skillList.length === 0 ? (
          <div style={mutedStyle}>还没有 skill，无法分配。</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {agents.map((agent) => {
              const draft = draftByAgent[agent.id] ?? new Set<string>();
              const atLimit = draft.size >= MAX_DEFAULT_SKILLS_PER_AGENT;
              return (
                <li key={agent.id} style={rowStyle}>
                  <div style={rowHeadStyle}>
                    <strong>{agent.displayName}</strong>
                    <span style={metaStyle}>
                      已勾 {draft.size} / {MAX_DEFAULT_SKILLS_PER_AGENT}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={() => setDraftSkillsForAgent(agent.id, [])}
                        disabled={busy || draft.size === 0}
                      >
                        全清
                      </button>
                      <button
                        type="button"
                        style={primaryBtn}
                        onClick={() => void saveAgentDrafts(agent.id)}
                        disabled={busy || draft.size === 0}
                      >
                        保存 default skills
                      </button>
                    </span>
                  </div>
                  <div style={checkboxGridStyle}>
                    {skillList.map((s) => {
                      const checked = draft.has(s.id);
                      return (
                        <label key={s.id} style={checkboxLabelStyle}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy || (!checked && atLimit)}
                            onChange={(e) => toggleDraftSkill(agent.id, s.id, e.target.checked)}
                          />
                          <span>{s.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

// ── 样式 ────────────────────────────────────────────────────────
//
// 与设置区其他页面一致：CSS-in-JS + 文件底部 const。沿用 api-keys/page.tsx 的
// 颜色与圆角，让侧栏切换不刺眼。

const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 16 };
const placeholderStyle: CSSProperties = {
  ...shared.placeholderBox,
  color: C.textDim,
  marginBottom: 12,
};
const mutedStyle: CSSProperties = { color: C.textGhost, fontSize: T.meta, padding: '12px 0' };
const errorStyle: CSSProperties = { ...shared.errorBox };
const noticeStyle: CSSProperties = { ...shared.noticeBox, cursor: 'pointer' };
const sectionStyle: CSSProperties = { ...shared.card, marginBottom: 16 };
const sectionTitleStyle: CSSProperties = { fontSize: T.h3, margin: '0 0 12px', color: C.text };
const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: T.sm,
  color: C.textDim,
  margin: '8px 0 4px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const inputStyle: CSSProperties = { ...shared.input };
const textareaStyle: CSSProperties = {
  ...shared.input,
  fontFamily: F.mono,
};
const selectInlineStyle: CSSProperties = {
  ...shared.input,
  width: 'auto',
  minWidth: 140,
};
const row3Style: CSSProperties = { display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' };
const assetRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'stretch',
  marginBottom: 6,
  flexWrap: 'wrap',
};
const primaryBtn: CSSProperties = { ...shared.primaryBtn };
const ghostBtn: CSSProperties = { ...shared.ghostBtn, marginRight: 6 };
const dangerBtn: CSSProperties = { ...shared.dangerBtn };
const rowStyle: CSSProperties = { ...shared.card, padding: S.md, marginBottom: 8 };
const rowHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: T.body,
  flexWrap: 'wrap',
};
const badgeStyle: CSSProperties = { ...shared.badge, color: C.accent };
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.base };
const codeStyle: CSSProperties = {
  background: C.code,
  padding: '2px 6px',
  borderRadius: R.sm,
  fontSize: T.base,
  fontFamily: F.mono,
  color: C.text,
};
const expandPanelStyle: CSSProperties = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  flexDirection: 'column',
};
const checkboxGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: 4,
  marginTop: 8,
};
const checkboxLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: T.base,
};
