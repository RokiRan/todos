'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Providers（团队级 provider 目录）。
 *
 * 这是 pi 内置 runtime 的模型来源：没有 provider 就没有模型，agent 建不起来。
 * 因此这个页面同时承担两个职责 —— 让 admin 配 key / 改 label / 增删模型，
 * 以及让所有成员看一眼「我能用的模型长什么样」。
 *
 * 与 api-keys 页面的差异：
 *   - **必须**要有团队。provider 属于团队，写路径要 admin。统一用
 *     `SettingsPlaceholder` 兜底，避免再写一份「加载中/没团队」的分支。
 *   - **apiKey 在 GET 响应里只有布尔**（`hasApiKey`），明文永不回传。
 *   - **PATCH apiKey = '' 视为保留**（上游 `routes/providers.ts` 里的编辑器
 *     语义），UI 上必须在输入框下方写明，不能让用户以为「清空 = 删 key」。
 *   - **20 个上限**要在 UI 先挡住，不是只靠 422 兜底 —— 用户加第 21 个再去
 *     等服务端拒，体验更差。
 */

const PROVIDER_LIMIT = 20;

/** `MODEL_APIS` 的合法枚举值（与 `packages/protocol/src/enums.ts` 保持一致）。 */
const MODEL_APIS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
] as const;
type ModelApi = (typeof MODEL_APIS)[number];

const API_LABEL: Record<ModelApi, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'google-generative-ai': 'Google Generative AI',
};

interface ModelEntry {
  id: string;
  label?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
}

interface ProviderRow {
  id: string;
  teamId: string;
  kind: 'vendor' | 'custom';
  providerId: string;
  label: string;
  baseUrl: string | null;
  api: ModelApi;
  models: ModelEntry[];
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ModelRow {
  id: string;
  modelId: string;
  label: string;
  providerId: string;
  providerLabel: string;
  api: ModelApi;
  baseUrl: string | null;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  usable: boolean;
}

interface DraftModel {
  id: string;
  label: string;
  contextWindow: string; // 表单里用字符串，提交时再 parseInt
  maxTokens: string;
  reasoning: boolean;
  text: boolean;
  image: boolean;
}

/** 新建 / 编辑时共享的草稿状态。apiKey 留空 = 保留已存（PATCH 语义）。 */
interface ProviderDraft {
  kind: 'vendor' | 'custom';
  providerId: string;
  label: string;
  baseUrl: string;
  api: ModelApi;
  apiKey: string;
  skipVerify: boolean;
  models: DraftModel[];
}

function emptyModel(): DraftModel {
  return { id: '', label: '', contextWindow: '128000', maxTokens: '8192', reasoning: false, text: true, image: false };
}

function emptyDraft(): ProviderDraft {
  return {
    kind: 'vendor',
    providerId: '',
    label: '',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
    skipVerify: false,
    models: [emptyModel()],
  };
}

/** 把表单草稿转成接口期望的形状；返回 null = 校验失败，错误文案给用户看。 */
function draftToPayload(d: ProviderDraft, baseUrlRequired: boolean): { payload: unknown; error: string | null } {
  if (!d.providerId.trim()) return { payload: null, error: 'providerId 必填' };
  if (!d.label.trim()) return { payload: null, error: 'label 必填' };
  if (baseUrlRequired && !d.baseUrl.trim()) {
    return { payload: null, error: 'custom provider 必须填 baseUrl（OpenAI 兼容端点常以 /v1 结尾）' };
  }
  if (d.models.length === 0) return { payload: null, error: '至少需要一个模型' };
  const models: ModelEntry[] = [];
  for (const m of d.models) {
    if (!m.id.trim()) return { payload: null, error: '模型 id 必填' };
    const ctx = Number.parseInt(m.contextWindow, 10);
    const max = Number.parseInt(m.maxTokens, 10);
    if (!Number.isFinite(ctx) || ctx <= 0) return { payload: null, error: `模型「${m.id}」的 contextWindow 必须是正整数` };
    if (!Number.isFinite(max) || max <= 0) return { payload: null, error: `模型「${m.id}」的 maxTokens 必须是正整数` };
    const input: ('text' | 'image')[] = [];
    if (m.text) input.push('text');
    if (m.image) input.push('image');
    if (input.length === 0) return { payload: null, error: `模型「${m.id}」至少勾一个 input（text / image）` };
    models.push({
      id: m.id.trim(),
      ...(m.label.trim() ? { label: m.label.trim() } : {}),
      contextWindow: ctx,
      maxTokens: max,
      reasoning: m.reasoning,
      input,
    });
  }
  return { payload: { models }, error: null };
}

export default function ProvidersPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();
  const teamId = activeTeam?.teamId ?? null;

  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 新建草稿
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 编辑中的 provider id；空 = 不在编辑
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProviderDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!teamId) {
      setProviders([]);
      setModels([]);
      return;
    }
    setLoadError(null);
    const [provRes, modelRes] = await Promise.all([
      fetch(`/api/teams/${encodeURIComponent(teamId)}/providers`, { cache: 'no-store' }),
      fetch(`/api/teams/${encodeURIComponent(teamId)}/models?runtime=pi`, { cache: 'no-store' }),
    ]);
    const provBody = (await provRes.json().catch(() => null)) as
      | { ready?: boolean; data?: ProviderRow[]; reason?: string; error?: string }
      | null;
    if (provBody?.ready === true && Array.isArray(provBody.data)) {
      setProviders(provBody.data);
    } else {
      setProviders([]);
      const reason = provBody && 'reason' in provBody ? provBody.reason : 'unknown';
      setLoadError(`provider 列表加载失败：${String(reason)}`);
    }
    const modelBody = (await modelRes.json().catch(() => null)) as
      | { ready?: boolean; data?: ModelRow[]; reason?: string }
      | null;
    if (modelBody?.ready === true && Array.isArray(modelBody.data)) {
      setModels(modelBody.data);
    } else {
      setModels([]);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createProvider(): Promise<void> {
    if (!teamId || busy) return;
    const baseUrlRequired = draft.kind === 'custom';
    const { payload: modelsPayload, error: draftErr } = draftToPayload(draft, baseUrlRequired);
    if (draftErr || modelsPayload === null) {
      setCreateError(draftErr ?? '表单校验失败');
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // **不要发 userId**：BFF 的 proxyWrite 会从 cookie 解析出的身份注入它。
          // 上游 `CreateProviderBody` 把它声明成 `z.string().min(1)`（不传会 422），
          // 但它又是不可信输入（后端 actorForTeam 拿它与凭据所有者比对）——
          // 所以正确形状是浏览器不发、由服务端填。发空串必然 422。
          kind: draft.kind,
          providerId: draft.providerId.trim(),
          label: draft.label.trim(),
          baseUrl: baseUrlRequired ? draft.baseUrl.trim() : (draft.baseUrl.trim() ? draft.baseUrl.trim() : null),
          api: draft.api,
          models: modelsPayload,
          apiKey: draft.apiKey.length > 0 ? draft.apiKey : null,
          skipVerify: draft.skipVerify,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; provider?: ProviderRow };
      if (res.ok && body.provider) {
        setCreating(false);
        setDraft(emptyDraft());
        await load();
      } else {
        setCreateError(body.error ?? `创建失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(row: ProviderRow): void {
    setEditingId(row.id);
    setEditError(null);
    setEditDraft({
      kind: row.kind,
      providerId: row.providerId,
      label: row.label,
      baseUrl: row.baseUrl ?? '',
      api: row.api,
      // 编辑时 apiKey 留空 —— 留空 = 保留已存
      apiKey: '',
      skipVerify: false,
      models: row.models.length > 0
        ? row.models.map((m) => ({
            id: m.id,
            label: m.label ?? '',
            contextWindow: String(m.contextWindow),
            maxTokens: String(m.maxTokens),
            reasoning: m.reasoning ?? false,
            text: (m.input ?? ['text']).includes('text'),
            image: (m.input ?? ['text']).includes('image'),
          }))
        : [emptyModel()],
    });
  }

  async function saveEdit(): Promise<void> {
    if (!teamId || !editingId || !editDraft || editBusy) return;
    const { payload: modelsPayload, error: draftErr } = draftToPayload(editDraft, false);
    if (draftErr || modelsPayload === null) {
      setEditError(draftErr ?? '表单校验失败');
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {
        // 同 createProvider：不发 userId，由 proxyWrite 注入
        label: editDraft.label.trim(),
        baseUrl: editDraft.baseUrl.trim() ? editDraft.baseUrl.trim() : null,
        api: editDraft.api,
        models: modelsPayload,
      };
      // 空字符串表示保留已存 key —— 上游 PATCH 路由就是这么区分的（routes/providers.ts）
      if (editDraft.apiKey.length > 0) body.apiKey = editDraft.apiKey;
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/providers/${encodeURIComponent(editingId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const respBody = (await res.json().catch(() => ({}))) as { error?: string; provider?: ProviderRow };
      if (res.ok && respBody.provider) {
        setEditingId(null);
        setEditDraft(null);
        await load();
      } else {
        setEditError(respBody.error ?? `更新失败 (${res.status})`);
      }
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteProvider(row: ProviderRow): Promise<void> {
    if (!teamId || busy) return;
    const ok = window.confirm(
      `删除 provider「${row.label}」？\n\n` +
        `该操作会立刻把它从模型目录里移除。任何 agent 若把它列为默认模型，会在下次 ` +
        `调度时无法选到可用模型；已迁回其代理的运行不受影响，但新的 spec 不能再选它。\n\n` +
        `此操作不可撤销。`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/providers/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      const respBody = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        await load();
      } else {
        setLoadError(respBody.error ?? `删除失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  // 共享占位逻辑：没 teamId 时不让用户看到空表单，避免填写了才发现没地方提交。
  // 用布尔判定而不是 `if (<SettingsPlaceholder/>)`：JSX 元素是对象，`if (ph)`
  // 恒为真，页面会永远停在空占位上（见 settings-placeholder.tsx 的注释）。
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main style={pageContainerStyle}>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  const count = providers?.length ?? 0;
  const atLimit = count >= PROVIDER_LIMIT;

  return (
    <main style={pageContainerStyle}>
      <Link href="/" style={backLinkStyle}>← 返回看板</Link>
      <h1 style={{ fontSize: T.h2, margin: '12px 0 4px', color: C.text }}>Providers</h1>
      <p style={hintStyle}>
        pi runtime 的模型从这里来。配 key 的 provider 才会出现在模型目录的可选项里
        （<code style={inlineCodeStyle}>usable</code> 由后端按「有 key / 无 key」算），
        无 key 的 provider 跑不起来 —— 删除会移除它在模型目录里的身影。
      </p>

      {loadError !== null && (
        <div style={errorStyle}>
          <strong>列表加载失败</strong>
          <div style={{ marginTop: 4 }}>{loadError}</div>
        </div>
      )}

      {/* ── 列表区 ── */}
      <section style={sectionStyle}>
        <header style={sectionHeadStyle}>
          <h2 style={sectionTitleStyle}>已配置 ({count}/{PROVIDER_LIMIT})</h2>
          {!creating && (
            <button
              type="button"
              style={atLimit ? disabledBtn : primaryBtn}
              onClick={() => {
                setCreating(true);
                setCreateError(null);
                setDraft(emptyDraft());
              }}
              disabled={atLimit}
              title={atLimit ? `已达上限 ${PROVIDER_LIMIT}` : undefined}
            >
              + 新增 provider
            </button>
          )}
        </header>
        {atLimit && !creating && (
          <div style={warnStyle}>
            已达 {PROVIDER_LIMIT} 个上限。先去提交一个再添。
          </div>
        )}

        {providers !== null && providers.length === 0 && !creating && (
          <div style={mutedStyle}>还没有 provider。点右上「新增 provider」开始。</div>
        )}

        {providers !== null && providers.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>label / providerId</th>
                <th style={thStyle}>api</th>
                <th style={thStyle}>models</th>
                <th style={thStyle}>key</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{p.label}</div>
                    <div style={{ color: C.textDim, fontSize: T.base }}>{p.providerId}</div>
                  </td>
                  <td style={tdStyle}>{API_LABEL[p.api] ?? p.api}</td>
                  <td style={tdStyle}>{p.models.length}</td>
                  <td style={tdStyle}>
                    {p.hasApiKey ? (
                      <span style={okBadgeStyle}>已配 key</span>
                    ) : (
                      <span style={errBadgeStyle}>未配 key</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => beginEdit(p)}
                      disabled={editingId === p.id}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      style={dangerBtn}
                      onClick={() => void deleteProvider(p)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 新建表单 */}
        {creating && (
          <div style={formPanelStyle}>
            <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>新增 provider</h3>
            {createError !== null && <div style={errorInlineStyle}>{createError}</div>}
            <DraftForm
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSubmit={() => void createProvider()}
              onCancel={() => {
                setCreating(false);
                setCreateError(null);
              }}
            />
          </div>
        )}

        {/* 行内编辑表单 */}
        {editingId !== null && editDraft !== null && (() => {
          const editing = providers?.find((p) => p.id === editingId) ?? null;
          return (
            <div style={formPanelStyle}>
              <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>
                编辑「{editing?.label ?? editingId}」
              </h3>
              {editError !== null && <div style={errorInlineStyle}>{editError}</div>}
              <DraftForm
                draft={editDraft}
                setDraft={setEditDraft}
                busy={editBusy}
                onSubmit={() => void saveEdit()}
                onCancel={() => {
                  setEditingId(null);
                  setEditDraft(null);
                }}
                editMode
              />
            </div>
          );
        })()}
      </section>

      {/* ── 模型目录 ── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>模型目录（pi runtime）</h2>
        {models === null && <div style={mutedStyle}>读取中…</div>}
        {models !== null && models.length === 0 && (
          <div style={mutedStyle}>还没有任何模型。配置 provider 并填入 models 字段后会出现。</div>
        )}
        {models !== null && models.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>label</th>
                <th style={thStyle}>id</th>
                <th style={thStyle}>provider</th>
                <th style={thStyle}>ctx / max</th>
                <th style={thStyle}>可用</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} style={m.usable ? undefined : dimRowStyle}>
                  <td style={tdStyle}>{m.label}</td>
                  <td style={tdStyle}>
                    <code style={inlineCodeStyle}>{m.id}</code>
                  </td>
                  <td style={tdStyle}>{m.providerLabel}</td>
                  <td style={tdStyle}>
                    {m.contextWindow.toLocaleString()} / {m.maxTokens.toLocaleString()}
                  </td>
                  <td style={tdStyle}>
                    {m.usable ? (
                      <span style={okBadgeStyle}>可用</span>
                    ) : (
                      <span style={mutedInlineStyle}>该 provider 未配 key</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

// ── 动态行编辑器 ─────────────────────────────────────────────────
//
// 与 Settings 其他页风格一致（参考 api-keys/page.tsx）。props 直接接父组件的
// state / setter，父组件决定「这是新建还是编辑」，本组件只管渲染与最小校验。

function DraftForm({
  draft,
  setDraft,
  busy,
  onSubmit,
  onCancel,
  editMode,
}: {
  draft: ProviderDraft;
  setDraft: (d: ProviderDraft) => void;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  editMode?: boolean;
}): React.JSX.Element {
  const baseUrlRequired = draft.kind === 'custom';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <FieldRow label="kind">
          <select
            style={selectStyle}
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'vendor' | 'custom' })}
          >
            <option value="vendor">vendor</option>
            <option value="custom">custom</option>
          </select>
        </FieldRow>

        <FieldRow label="providerId">
          <input
            style={inputStyle}
            value={draft.providerId}
            onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
            placeholder="如 anthropic / openai / 自定义标识"
          />
        </FieldRow>

        <FieldRow label="label">
          <input
            style={inputStyle}
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            placeholder="显示名"
          />
        </FieldRow>

        <FieldRow label={baseUrlRequired ? 'baseUrl（必填）' : 'baseUrl（可空）'}>
          <input
            style={inputStyle}
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder={baseUrlRequired ? 'https://your-gateway/v1' : 'vendor 走默认端点'}
          />
        </FieldRow>

        <FieldRow label="api">
          <select
            style={selectStyle}
            value={draft.api}
            onChange={(e) => setDraft({ ...draft, api: e.target.value as ModelApi })}
          >
            {MODEL_APIS.map((a) => (
              <option key={a} value={a}>{API_LABEL[a]}（{a}）</option>
            ))}
          </select>
        </FieldRow>

        <FieldRow label="apiKey">
          <div>
            <input
              style={inputStyle}
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder="只填一次，保存后只回传 hasApiKey 布尔"
              autoComplete="off"
            />
            <div style={tinyHintStyle}>
              {editMode
                ? '留空表示不改动已存的 key（后端编辑器语义）。要更新才填。'
                : '本地网关（Ollama / LM Studio）可不填 key，但勾上 skipVerify 否则会校验。'}
            </div>
          </div>
        </FieldRow>

        <FieldRow label="skipVerify">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={draft.skipVerify}
              onChange={(e) => setDraft({ ...draft, skipVerify: e.target.checked })}
            />
            <span>跳过真实 key 校验（不勾的话服务端会真发一次请求到 provider）</span>
          </label>
        </FieldRow>

        <FieldRow label="models">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {draft.models.map((m, idx) => (
              <div key={idx} style={modelRowStyle}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={m.id}
                  onChange={(e) => updateModel(setDraft, draft, idx, { id: e.target.value })}
                  placeholder="model id（如 gpt-4o / claude-sonnet-4-5）"
                />
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={m.label}
                  onChange={(e) => updateModel(setDraft, draft, idx, { label: e.target.value })}
                  placeholder="label（可选）"
                />
                <input
                  style={{ ...inputStyle, width: 90 }}
                  type="number"
                  value={m.contextWindow}
                  onChange={(e) => updateModel(setDraft, draft, idx, { contextWindow: e.target.value })}
                  placeholder="ctx"
                  min={1}
                />
                <input
                  style={{ ...inputStyle, width: 90 }}
                  type="number"
                  value={m.maxTokens}
                  onChange={(e) => updateModel(setDraft, draft, idx, { maxTokens: e.target.value })}
                  placeholder="max"
                  min={1}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={m.reasoning}
                    onChange={(e) => updateModel(setDraft, draft, idx, { reasoning: e.target.checked })}
                  />
                  reasoning
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={m.text}
                    onChange={(e) => updateModel(setDraft, draft, idx, { text: e.target.checked })}
                  />
                  text
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={m.image}
                    onChange={(e) => updateModel(setDraft, draft, idx, { image: e.target.checked })}
                  />
                  image
                </label>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => removeModel(setDraft, draft, idx)}
                  disabled={draft.models.length <= 1}
                  title={draft.models.length <= 1 ? '至少保留一个模型' : '删除这一行'}
                >
                  −
                </button>
              </div>
            ))}
            <button
              type="button"
              style={ghostBtn}
              onClick={() => addModel(setDraft, draft)}
            >
              + 增加一行
            </button>
          </div>
        </FieldRow>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" style={primaryBtn} onClick={onSubmit} disabled={busy}>
            {editMode ? '保存修改' : '创建'}
          </button>
          <button type="button" style={ghostBtn} onClick={onCancel} disabled={busy}>
            取消
          </button>
        </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ width: 110, color: C.textDim, fontSize: T.base, paddingTop: 6 }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function updateModel(
  setDraft: (d: ProviderDraft) => void,
  draft: ProviderDraft,
  idx: number,
  patch: Partial<DraftModel>,
): void {
  const next = draft.models.map((m, i) => (i === idx ? { ...m, ...patch } : m));
  setDraft({ ...draft, models: next });
}

function addModel(setDraft: (d: ProviderDraft) => void, draft: ProviderDraft): void {
  setDraft({ ...draft, models: [...draft.models, emptyModel()] });
}

function removeModel(setDraft: (d: ProviderDraft) => void, draft: ProviderDraft, idx: number): void {
  if (draft.models.length <= 1) return;
  setDraft({ ...draft, models: draft.models.filter((_, i) => i !== idx) });
}

// ── 样式 ─────────────────────────────────────────────────────────

const pageContainerStyle: CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  color: C.text,
  fontSize: T.body,
};
const backLinkStyle: CSSProperties = { fontSize: T.meta, color: C.accent, textDecoration: 'none' };
const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 16, lineHeight: 1.5 };
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: '12px 0' };
const errorStyle: CSSProperties = { ...shared.errorBox };
const errorInlineStyle: CSSProperties = {
  ...shared.errorBox,
  borderRadius: R.md,
  padding: '8px 10px',
  fontSize: T.base,
  marginBottom: 8,
};
const warnStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  padding: '8px 10px',
  fontSize: T.base,
  marginBottom: 8,
  color: C.text,
};
const sectionStyle: CSSProperties = { marginTop: 24 };
const sectionHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 };
const sectionTitleStyle: CSSProperties = { fontSize: T.h3, margin: 0, color: C.text };
const formPanelStyle: CSSProperties = { ...shared.card, background: C.surfaceHi, marginTop: 12 };
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: T.meta };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  borderBottom: `1px solid ${C.line}`,
  color: C.textDim,
  fontWeight: 600,
  fontSize: T.base,
};
const tdStyle: CSSProperties = {
  padding: '8px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  verticalAlign: 'top',
  color: C.text,
};
const dimRowStyle: CSSProperties = { color: C.textGhost, opacity: 0.6 };
const inputStyle: CSSProperties = { ...shared.input };
const selectStyle: CSSProperties = { ...shared.input, background: C.bg };
const primaryBtn: CSSProperties = { ...shared.primaryBtn };
const disabledBtn: CSSProperties = {
  ...shared.ghostBtn,
  opacity: 0.5,
  cursor: 'not-allowed',
  color: C.textFaint,
};
const ghostBtn: CSSProperties = { ...shared.ghostBtn };
const dangerBtn: CSSProperties = { ...shared.dangerBtn, marginLeft: 6 };
const okBadgeStyle: CSSProperties = { ...shared.badge, color: C.ok };
const errBadgeStyle: CSSProperties = { ...shared.badge, color: C.danger };
const mutedInlineStyle: CSSProperties = { color: C.textGhost, fontSize: T.base };
const inlineCodeStyle: CSSProperties = {
  background: C.code,
  padding: '1px 4px',
  borderRadius: R.sm,
  fontSize: T.base,
  fontFamily: F.mono,
  color: C.text,
};
const tinyHintStyle: CSSProperties = { color: C.textGhost, fontSize: T.sm, marginTop: 4 };
const modelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };