'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useTeamAgents, useTeamContext } from '@/lib/team-context';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '../settings-placeholder';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Schedules（对标 todos.dev `/settings/schedules`）。
 *
 * 业务契约（来自 `apps/server/src/services/schedules.ts`）：
 *   - 四种 kind 的 cron 形态互不相同
 *       hourly → 0-59 的整数字符串（如 "30"）
 *       daily  → "HH:MM"（如 "09:30"）
 *       weekly → "HH:MM" + 单独的 weekday（0=周日…6=周六）
 *       once   → 完整 ISO 时间戳（如 "2026-12-31T15:00:00.000Z"）
 *   - 每团队 ≤ 10 条（`SCHEDULE_CONSTANTS.MAX_RULES_PER_TEAM`）
 *   - 写操作需要 admin；非 admin → 后端 403，原样透出
 *   - 时区由后端 `assertValidTimezone` 真构造 `Intl.DateTimeFormat` 校验
 *     （非法 → 422 `invalid timezone`）；前端不预先校验格式，把 422 原文显示
 *
 * **`publicSchedule` 实际行为**（已在 `services/schedules.ts` 逐字核对）：
 *   - weekly 的 cron **已经被服务端解出来**，`cron` 字段返回的是用户视角的
 *     `"HH:MM"`（如 `"09:30"`），**不带** `"Mon 09:30"` 这种持久化前缀
 *   - `weekday` 字段：weekly 时是 0-6 的数字（从持久化 cron 反解得到），
 *     其它 kind 是 `null`
 *   - 因此前端 weekly 编辑回显**不需要**双向转换 —— 直接用 `cron`（HH:MM）
 *     与 `weekday` 即可；持久化层的 `encodeWeeklyCron` / `decodeWeeklyCron`
 *     是服务端边界保护，让 DB 里只存一种形态，UI 端就拿不到那种形态
 *
 * 为什么不直接读 user.context 里的 teamId：teamId 由 `SettingsPlaceholder`
 * 这一层判定，前端页面**不需要**重复判断空态/未就绪 —— 模板里有就拿，否则
 * 直接走占位即可。
 */

type ScheduleKind = 'hourly' | 'daily' | 'weekly' | 'once';

interface ScheduleRow {
  id: string;
  teamId: string;
  todoId: string;
  kind: ScheduleKind;
  /** user-facing cron：weekly 是 "HH:MM"，hourly 是 "0-59"，daily 是 "HH:MM"，once 是 ISO */
  cron: string;
  /** weekly 时是 0-6，其它 kind 是 null（服务端 `publicSchedule` 已解出） */
  weekday: number | null;
  timezone: string;
  agentId: string | null;
  automatic: boolean;
  lastFiredAt: number | null;
  lastOutcome: string | null;
}

const WEEKDAY_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
];

const KIND_LABELS: Record<ScheduleKind, string> = {
  hourly: '每小时',
  daily: '每天',
  weekly: '每周',
  once: '一次性',
};

/** 列表里人类可读的 cron 渲染：weekly 拼成「每周一 09:30」这种形式 */
function describeCron(row: ScheduleRow): string {
  if (row.kind === 'weekly') {
    const wd = WEEKDAY_LABELS.find((w) => w.value === row.weekday)?.label ?? `星期${row.weekday}`;
    return `每周${wd} ${row.cron}`;
  }
  if (row.kind === 'hourly') {
    return `每小时第 ${row.cron} 分`;
  }
  if (row.kind === 'daily') {
    return `每天 ${row.cron}`;
  }
  try {
    return `一次：${new Date(row.cron).toLocaleString()}`;
  } catch {
    return `一次：${row.cron}`;
  }
}

/** 把 cron 字段的输入控件形态按 kind 区分（标签 + 占位 + 类型） */
interface CronInputSpec {
  label: string;
  placeholder: string;
  hint: string;
  type: 'text' | 'datetime-local';
  defaultValue: string;
}
function cronInputSpec(kind: ScheduleKind): CronInputSpec {
  switch (kind) {
    case 'hourly':
      return {
        label: '分钟（0-59）',
        placeholder: '0-59 的整数，如 30',
        hint: '每小时第几分钟触发。后端要求 0-59 的整数。',
        type: 'text',
        defaultValue: '0',
      };
    case 'daily':
      return {
        label: '时间（HH:MM）',
        placeholder: 'HH:MM，如 09:30',
        hint: '每天几点几分触发，24 小时制。',
        type: 'text',
        defaultValue: '09:00',
      };
    case 'weekly':
      return {
        label: '时间（HH:MM）',
        placeholder: 'HH:MM，如 09:30',
        hint: '每周哪一天的几点几分触发。星期另选。',
        type: 'text',
        defaultValue: '09:00',
      };
    case 'once':
      return {
        label: 'ISO 时间戳',
        placeholder: '2026-12-31T15:00:00.000Z',
        hint: '只在这一次触发。必须是未来时间。',
        type: 'datetime-local',
        defaultValue: '',
      };
  }
}

/** once 提交时把 `YYYY-MM-DDTHH:MM` 拼成完整 ISO（本地时区 → UTC）。 */
function toIsoFromLocal(local: string): string {
  if (!local) return '';
  // `<input type="datetime-local">` 给的是不带时区的本地时间；new Date() 按
  // 浏览器时区解释，再 toISOString 转 UTC。后端 `Date.parse` 能吃完整 ISO。
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return d.toISOString();
}

interface FormState {
  todoId: string;
  kind: ScheduleKind;
  /** 人类视角的 cron 文本（weekly 不含 weekday） */
  cron: string;
  weekday: number;          // 0-6；weekly 用，其它形态也会带上但服务端只在 weekly 时读
  timezone: string;
  agentId: string | null;
  automatic: boolean;
}
const EMPTY_FORM: FormState = {
  todoId: '',
  kind: 'daily',
  cron: '09:00',
  weekday: 1,
  timezone: 'Asia/Shanghai',
  agentId: null,
  automatic: true,
};

/** once 形 row 的 cron 是 ISO，回填到 datetime-local 时需要去掉时区后缀 */
function toLocalFromIso(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SchedulesPage(): React.JSX.Element {
  const { status, activeTeam, ctx } = useTeamContext();
  const agents = useTeamAgents();
  const userId = ctx?.userId ?? null;

  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const teamId = activeTeam?.teamId ?? null;
  const atLimit = rows !== null && rows.length >= 10;

  // ── 加载 ────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!teamId) {
      setRows([]);
      return;
    }
    const res = await fetch(
      `/api/teams/${encodeURIComponent(teamId)}/schedules`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: ScheduleRow[]; reason?: string }
      | null;
    if (!body) {
      setRows([]);
      setError('BFF 没有返回可解析的响应');
      return;
    }
    if (body.ready === false) {
      setRows([]);
      // 把 reason 拼到提示里，方便排查；不要把上游真实错误字面暴露给非技术用户。
      setError(`数据未就绪：/api/teams/{teamId}/schedules (${body.reason ?? 'unknown'})`);
      return;
    }
    if (!Array.isArray(body.data)) {
      setRows([]);
      setError(`响应形状不对：${JSON.stringify(body).slice(0, 120)}`);
      return;
    }
    setRows(body.data);
    setError(null);
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── 写操作 ──────────────────────────────────────────────────────

  async function submit(): Promise<void> {
    if (busy || !teamId || !userId) return;
    if (!form.todoId.trim()) {
      setError('todoId 必填（必须是真实 todo id）');
      return;
    }
    // 把表单翻译成服务端 body —— 各 kind 形态互不相同，weekly 还多带 weekday。
    const body: Record<string, unknown> = {
      userId,
      todoId: form.todoId.trim(),
      kind: form.kind,
      cron: form.kind === 'once' ? toIsoFromLocal(form.cron) : form.cron.trim(),
      timezone: form.timezone.trim() || 'Asia/Shanghai',
      automatic: form.automatic,
      agentId: form.agentId,
    };
    if (form.kind === 'weekly') body['weekday'] = form.weekday;
    setBusy(true);
    setError(null);
    try {
      const url = editing
        ? `/api/teams/${encodeURIComponent(teamId)}/schedules/${encodeURIComponent(editing)}`
        : `/api/teams/${encodeURIComponent(teamId)}/schedules`;
      const method = editing ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(respBody.error ?? `${editing ? '更新' : '创建'}失败 (${res.status})`);
        return;
      }
      setNotice(editing ? '已更新定时规则' : '已创建定时规则');
      setCreating(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeRow(row: ScheduleRow): Promise<void> {
    if (busy || !teamId) return;
    if (!confirm(`确定删除「${describeCron(row)}」？此操作不可撤销。`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/schedules/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      const respBody = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(respBody.error ?? `删除失败 (${res.status})`);
        return;
      }
      setNotice('已删除');
      await load();
    } finally {
      setBusy(false);
    }
  }

  // ── 渲染 ────────────────────────────────────────────────────────

  // `cronSpec` 必须在任何 early return **之前**求值：它是 useMemo，而 React 要求
  // 同一组件每次渲染的 hook 调用顺序一致。放在 `if (placeholder) return` 之后，
  // 加载完成的那一帧就会比前一帧多调一次 useMemo —— React 报
  // 「Rendered more hooks than during the previous render」并整棵子树崩掉，
  // 症状是页面在数据到齐的瞬间变成空白。
  const cronSpec = useMemo(() => cronInputSpec(form.kind), [form.kind]);

  // 布尔判定（不用 `if (<SettingsPlaceholder/>)`：JSX 恒真，见 settings-placeholder.tsx）
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  return (
    <main style={pageContainerStyle}>
      <Link href="/" style={backLinkStyle}>← 返回看板</Link>
      <h1 style={{ fontSize: T.h2, margin: '12px 0 4px', color: C.text }}>定时规则</h1>
      <p style={hintStyle}>
        每团队最多 10 条规则。写操作需要 admin —— 非管理员会得到后端 403。
        时区在服务端用 <code>Intl.DateTimeFormat</code> 真构造校验，
        非法时区会在错误条里显示后端原文（如 <code>invalid timezone: Foo/Bar</code>）。
      </p>

      {error !== null && (
        <div style={errorStyle}><strong>出了点问题</strong>
          <div style={{ marginTop: 4 }}>{error}</div>
        </div>
      )}
      {notice !== null && (
        <div style={noticeStyle} onClick={() => setNotice(null)}>{notice}</div>
      )}

      {!creating && !editing && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            style={atLimit ? primaryDisabled : primaryBtn}
            onClick={() => {
              setCreating(true);
              setEditing(null);
              setForm(EMPTY_FORM);
              setError(null);
            }}
            disabled={busy || atLimit}
          >
            新建定时规则
          </button>
          {atLimit && (
            <span style={{ marginLeft: 12, color: C.danger, fontSize: T.base }}>
              已达 10 条上限。请先删除一条再新建。
            </span>
          )}
        </div>
      )}

      {(creating || editing) && (
        <div style={formPanelStyle}>
          <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>
            {editing ? '编辑定时规则' : '新建定时规则'}
          </h2>
          <div style={fieldGridStyle}>
            <label style={fieldLabelStyle}>
              类型
              <select
                style={selectStyle}
                value={form.kind}
                onChange={(e) => {
                  const k = e.target.value as ScheduleKind;
                  const spec = cronInputSpec(k);
                  setForm((f) => ({ ...f, kind: k, cron: spec.defaultValue }));
                }}
                disabled={busy || !!editing}
              >
                {(Object.keys(KIND_LABELS) as ScheduleKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}（{k}）</option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              todoId *
              <input
                style={inputStyle}
                value={form.todoId}
                onChange={(e) => setForm((f) => ({ ...f, todoId: e.target.value }))}
                placeholder="必须是真实 todo id（创建后不可改）"
                disabled={busy}
              />
            </label>
            <label style={fieldLabelStyle}>
              {cronSpec.label}
              <input
                style={inputStyle}
                type={cronSpec.type}
                value={form.cron}
                onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
                placeholder={cronSpec.placeholder}
                disabled={busy}
              />
              <span style={fieldHintStyle}>{cronSpec.hint}</span>
            </label>
            {form.kind === 'weekly' && (
              <label style={fieldLabelStyle}>
                星期（0=周日 … 6=周六）
                <select
                  style={selectStyle}
                  value={form.weekday}
                  onChange={(e) => setForm((f) => ({ ...f, weekday: Number(e.target.value) }))}
                  disabled={busy}
                >
                  {WEEKDAY_LABELS.map((w) => (
                    <option key={w.value} value={w.value}>{w.label}（{w.value}）</option>
                  ))}
                </select>
              </label>
            )}
            <label style={fieldLabelStyle}>
              时区
              <input
                style={inputStyle}
                value={form.timezone}
                onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                placeholder="如 Asia/Shanghai —— 不在前端校验，由后端 Intl 校验"
                disabled={busy}
              />
            </label>
            <label style={fieldLabelStyle}>
              agent（可选）
              <select
                style={selectStyle}
                value={form.agentId ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value || null }))}
                disabled={busy}
              >
                <option value="">不指定</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.displayName}</option>
                ))}
              </select>
            </label>
            <label style={{ ...fieldLabelStyle, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={form.automatic}
                onChange={(e) => setForm((f) => ({ ...f, automatic: e.target.checked }))}
                disabled={busy}
              />
              自动分派（automatic）
            </label>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="button" style={primaryBtn} onClick={() => void submit()} disabled={busy || !form.todoId.trim()}>
              {editing ? '保存' : '创建'}
            </button>
            <button
              type="button"
              style={ghostBtn}
              onClick={() => {
                setCreating(false);
                setEditing(null);
                setForm(EMPTY_FORM);
                setError(null);
              }}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 14, margin: '16px 0 8px' }}>已配置的规则</h2>
      {rows === null ? (
        <div style={mutedStyle}>读取中…</div>
      ) : rows.length === 0 ? (
        <div style={mutedStyle}>还没有定时规则。</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <li key={row.id} style={rowStyle}>
              <div style={rowHeadStyle}>
                <strong>{KIND_LABELS[row.kind] ?? row.kind}</strong>
                <code style={cronInlineStyle}>{describeCron(row)}</code>
                <span style={badgeStyle}>
                  {row.automatic ? 'automatic' : 'manual'}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  {!editing && (
                    <>
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={() => {
                          setEditing(row.id);
                          setCreating(false);
                          // 编辑回显：weekly 的 cron 服务端已解为 "HH:MM" + weekday；
                          // once 形 ISO 还要还原到 datetime-local 的本地形态。
                          setForm({
                            todoId: row.todoId,
                            kind: row.kind,
                            cron: row.kind === 'once' ? toLocalFromIso(row.cron) : row.cron,
                            weekday: row.weekday ?? 1,
                            timezone: row.timezone,
                            agentId: row.agentId,
                            automatic: row.automatic,
                          });
                          setError(null);
                        }}
                        disabled={busy}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        style={dangerBtn}
                        onClick={() => void removeRow(row)}
                        disabled={busy}
                      >
                        删除
                      </button>
                    </>
                  )}
                </span>
              </div>
              <div style={metaStyle}>
                todo: <code>{row.todoId}</code> · 时区 <code>{row.timezone}</code>
                {row.agentId !== null && <> · agent <code>{row.agentId}</code></>}
                {row.lastFiredAt !== null && (
                  <> · 上次触发 {new Date(row.lastFiredAt).toLocaleString()}
                    {row.lastOutcome !== null && <>（{row.lastOutcome}）</>}</>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────
//
// 沿用 `api-keys/page.tsx` 的风格：底部集中声明，避免每个元素重新拼内联样式。

const pageContainerStyle: CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  color: C.text,
  fontSize: T.body,
};
const backLinkStyle: CSSProperties = { fontSize: T.meta, color: C.accent, textDecoration: 'none' };
const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 16 };
const mutedStyle: CSSProperties = { color: C.textGhost, fontSize: T.meta, padding: '12px 0' };
const errorStyle: CSSProperties = { ...shared.errorBox };
const noticeStyle: CSSProperties = { ...shared.noticeBox, cursor: 'pointer' };
const primaryBtn: CSSProperties = { ...shared.primaryBtn };
const primaryDisabled: CSSProperties = { ...shared.ghostBtn, opacity: 0.5, cursor: 'not-allowed', color: C.textFaint };
const ghostBtn: CSSProperties = { ...shared.ghostBtn };
const dangerBtn: CSSProperties = { ...shared.dangerBtn };
const inputStyle: CSSProperties = { ...shared.input };
const selectStyle: CSSProperties = { ...shared.input };
const fieldLabelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', fontSize: T.base, color: C.textDim, gap: 4 };
const fieldHintStyle: CSSProperties = { fontSize: T.sm, color: C.textGhost, marginTop: 2 };
const fieldGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 };
const formPanelStyle: CSSProperties = { ...shared.card, background: C.surfaceHi, marginBottom: 16 };
const rowStyle: CSSProperties = { ...shared.card, padding: S.md, marginBottom: 8 };
const rowHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: T.body };
const cronInlineStyle: CSSProperties = {
  background: C.code,
  padding: '2px 6px',
  borderRadius: R.sm,
  fontSize: T.base,
  fontFamily: F.mono,
  color: C.text,
};
const badgeStyle: CSSProperties = { ...shared.badge, color: C.accent };
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.base, marginTop: 4 };
