'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * 新建 todo 页面。
 *
 * **为什么不在 Settings layout 下**：Settings layout 包了 `TeamProvider`，
 * 而新建 todo 是顶层入口（看板右上角链接进来），不能也不该被 Settings 的侧边
 * 栏包住。这里自己 fetch `/api/user/context` 拿 teamId / memberId，agents 列表
 * 也从它带回来的 `agents` 字段直接拿 —— 与 settings 页面从 `useTeamAgents()`
 * 取的是同一份数据，字段契约一致。
 *
 * 项目下拉来源：`GET /api/projects?teamId=...` —— BFF 转发到上游
 * `/api/teams/:teamId/projects`（`apps/server/src/routes/projects.ts`），字段与
 * MCP `case 'projects'` 同源。新建 todo 表单**不能**让用户手填 24 位 base64url
 * id，那是不可用的。
 *
 * 提交：`POST /api/todos`，响应里 `{ id, seqNum }`（来自 `services/todos.ts`
 * 的 `createTodo`），跳转 `/todo/{id}`。
 *
 * 失败反馈：4xx 原样透出 —— 后端返回 `{error: "..."}` 文案，UI 必须显示原文
 * 才能区分 403（团队归属）/ 422（参数错，例如 spec 超长、ownerMemberId 不是
 * 本团队成员）。
 */

interface TeamContextEntry {
  teamId: string;
  name: string;
  memberId: string;
}

interface AgentEntry {
  id: string;
  teamId: string;
  displayName: string;
  deletedAt: number | null;
}

interface UserContext {
  userId: string;
  email: string;
  teams: TeamContextEntry[];
  agents: AgentEntry[];
}

interface ProjectRow {
  id: string;
  teamId: string;
  name: string;
  provider: string;
  repoFullName: string | null;
  defaultBranch: string;
  createdAt: number;
}

/** 与后端 `services/todos.ts` 的 `SPEC_MAX_CHARS = 800` 对齐 —— 单源真相。 */
const SPEC_MAX = 800;
/** 后端 `CreateTodoBody.title` 的硬上限。 */
const TITLE_MAX = 280;

type LoadStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; ctx: UserContext }
  | { kind: 'unavailable'; reason: string };

type ProjectLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; list: ProjectRow[] }
  | { kind: 'unavailable'; reason: string };

export default function NewTodoPage() {
  const router = useRouter();

  const [userCtx, setUserCtx] = useState<LoadStatus>({ kind: 'loading' });
  const [projects, setProjects] = useState<ProjectLoad>({ kind: 'loading' });

  const [projectId, setProjectId] = useState<string>('');
  const [agentId, setAgentId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [planFirst, setPlanFirst] = useState(true);
  const [separatePlanBuild, setSeparatePlanBuild] = useState(false);
  const [withChecklist, setWithChecklist] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 拉取 /api/user/context —— 与 settings 页的 TeamProvider 数据同源（都是
  // `apps/server/src/routes/user-context.ts` 的 GET）。
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/user/context', {
          cache: 'no-store',
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        if (res.status === 401) {
          setUserCtx({ kind: 'unavailable', reason: '未登录（401）' });
          return;
        }
        const body = (await res.json()) as
          | { ready?: boolean; data?: UserContext; reason?: string }
          | null;
        if (!body?.ready || !body.data) {
          setUserCtx({
            kind: 'unavailable',
            reason: body?.reason ?? '后端未实现 /api/user/context',
          });
          return;
        }
        setUserCtx({ kind: 'ready', ctx: body.data });
      } catch (err) {
        if (ac.signal.aborted) return;
        setUserCtx({
          kind: 'unavailable',
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
    })();
    return () => ac.abort();
  }, []);

  // 拿到团队后立即拉项目列表 —— 没团队就不发请求，否则 query 上 `teamId=` 空串
  // 走到后端会 422。project 下拉是新建 todo 的硬性前置。
  const teamId =
    userCtx.kind === 'ready' ? userCtx.ctx.teams[0]?.teamId ?? null : null;
  useEffect(() => {
    if (!teamId) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/projects?teamId=${encodeURIComponent(teamId)}`,
          { cache: 'no-store', signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        if (!res.ok) {
          setProjects({ kind: 'unavailable', reason: `http-${res.status}` });
          return;
        }
        const body = (await res.json()) as
          | { ready?: boolean; data?: ProjectRow[]; reason?: string }
          | null;
        if (!body?.ready || !Array.isArray(body.data)) {
          setProjects({
            kind: 'unavailable',
            reason: body?.reason ?? '响应形状不对',
          });
          return;
        }
        setProjects({ kind: 'ready', list: body.data });
      } catch (err) {
        if (ac.signal.aborted) return;
        setProjects({
          kind: 'unavailable',
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
    })();
    return () => ac.abort();
  }, [teamId]);

  // 团队就绪 + 还没选过 project 时预选第一个 —— 减少误点
  useEffect(() => {
    if (projects.kind !== 'ready') return;
    if (projectId) return;
    const first = projects.list[0];
    if (first) setProjectId(first.id);
  }, [projects, projectId]);

  // 加载中占位
  if (userCtx.kind === 'loading') {
    return (
      <main style={wrapStyle}>
        <a href="/" style={backLinkStyle}>← 返回看板</a>
        <p style={mutedStyle}>加载团队上下文…</p>
      </main>
    );
  }

  // 团队为空 / 后端不可达
  if (userCtx.kind === 'unavailable') {
    return (
      <main style={wrapStyle}>
        <a href="/" style={backLinkStyle}>← 返回看板</a>
        <div style={notReadyStyle}>
          <strong>无法新建 todo</strong>
          <div style={{ marginTop: 4 }}>{userCtx.reason}</div>
          {userCtx.reason.includes('401') && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              请先在 <a href="/login" style={{ color: C.accent }}>登录页</a> 配置 token。
            </div>
          )}
        </div>
      </main>
    );
  }

  const ctx = userCtx.ctx;
  if (ctx.teams.length === 0) {
    return (
      <main style={wrapStyle}>
        <a href="/" style={backLinkStyle}>← 返回看板</a>
        <div style={notReadyStyle}>
          <strong>还没有任何团队</strong>
          <div style={{ marginTop: 4 }}>先去 MCP / 后端种子脚本里建一个团队再回来。</div>
        </div>
      </main>
    );
  }

  const team = ctx.teams[0]!;
  // 只列当前团队下的、未软删的 agent —— 与 settings 页 `useTeamAgents()` 行为一致。
  const agentsForTeam = ctx.agents.filter(
    (a) => a.teamId === team.teamId && a.deletedAt === null,
  );

  async function submit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    if (submitting) return;
    if (!projectId) {
      setSubmitError('请先选一个项目');
      return;
    }
    if (title.trim().length === 0) {
      setSubmitError('标题不能为空');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          teamId: team.teamId,
          projectId,
          ownerMemberId: team.memberId,
          agentId: agentId ? agentId : null,
          title: title.trim(),
          spec: spec.trim().length > 0 ? spec : null,
          tagIds: [],
          planFirst,
          separatePlanBuild,
          withChecklist,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        seqNum?: number;
        error?: string;
      };
      if (res.ok && body.id) {
        // 上游 `services/todos.ts:createTodo` 返回 `{id, seqNum}`，这里只读 id
        // 用来跳转 —— seqNum 仅在看板列里出现。
        router.push(`/todo/${encodeURIComponent(body.id)}`);
        return;
      }
      // 4xx：原样显示后端 error 文案。403/409/422 必须能分开 —— 这是为什
      // 么 BFF POST 用 `proxyWrite` 而非 `proxyRead` 把状态码吃掉。
      setSubmitError(body.error ?? `创建失败 (${res.status})`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.name : '网络错误');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={wrapStyle}>
      <a href="/" style={backLinkStyle}>← 返回看板</a>
      <h1 style={{ margin: '8px 0 16px', fontSize: 20 }}>新建 todo</h1>
      <p style={mutedStyle}>
        团队：<strong>{team.name}</strong> · 单人使用下取第一个团队。
        {agentsForTeam.length === 0 && '（当前团队下还没有 agent，留空即可）'}
      </p>

      <form onSubmit={submit} style={formStyle}>
        <label style={labelStyle}>
          项目 *
          {projects.kind === 'loading' && <span style={mutedStyle}>（加载项目…）</span>}
          {projects.kind === 'unavailable' && (
            <span style={errorInlineStyle}>
              （数据未就绪：{projects.reason}）
            </span>
          )}
        </label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={projects.kind !== 'ready' || submitting}
          style={inputStyle}
        >
          {projects.kind === 'ready' && projects.list.length === 0 && (
            <option value="">（该团队还没有项目）</option>
          )}
          {projects.kind === 'ready' &&
            projects.list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.repoFullName ? ` · ${p.repoFullName}` : ''}
              </option>
            ))}
          {projects.kind !== 'ready' && <option value="">—</option>}
        </select>

        <label style={labelStyle}>Agent（可选）</label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={submitting}
          style={inputStyle}
        >
          <option value="">（暂不指定）</option>
          {agentsForTeam.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>

        <label style={labelStyle}>
          标题 * <span style={mutedStyle}>（≤{TITLE_MAX} 字符）</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          required
          disabled={submitting}
          style={inputStyle}
          placeholder="给这个 todo 起一句话标题"
        />

        <label style={labelStyle}>
          Spec（可选） <span style={mutedStyle}>（≤{SPEC_MAX} 字符）</span>
        </label>
        <textarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          maxLength={SPEC_MAX}
          rows={8}
          disabled={submitting}
          style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
          placeholder={'详细描述要做什么 —— 后端硬上限 ' + SPEC_MAX + ' 字符，超出会 422'}
        />
        <div style={counterStyle}>
          {spec.length} / {SPEC_MAX}
        </div>

        <div style={checkRowStyle}>
          <label style={checkLabelStyle}>
            <input
              type="checkbox"
              checked={planFirst}
              onChange={(e) => setPlanFirst(e.target.checked)}
              disabled={submitting}
            />
            先出计划再开工（planFirst）
          </label>
          <label style={checkLabelStyle}>
            <input
              type="checkbox"
              checked={separatePlanBuild}
              onChange={(e) => setSeparatePlanBuild(e.target.checked)}
              disabled={submitting}
            />
            计划与构建分两次跑
          </label>
          <label style={checkLabelStyle}>
            <input
              type="checkbox"
              checked={withChecklist}
              onChange={(e) => setWithChecklist(e.target.checked)}
              disabled={submitting}
            />
            附带验收清单
          </label>
        </div>

        {submitError && <div style={errorBoxStyle}>{submitError}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            type="submit"
            disabled={submitting || projects.kind !== 'ready'}
            style={primaryBtnStyle}
          >
            {submitting ? '提交中…' : '创建 todo'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/')}
            disabled={submitting}
            style={ghostBtnStyle}
          >
            取消
          </button>
        </div>
      </form>
    </main>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────

const wrapStyle: CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
  color: C.text,
  fontSize: T.body,
  fontFamily: F.sans,
};

const backLinkStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.accent,
  textDecoration: 'none',
};

const mutedStyle: CSSProperties = {
  color: C.textGhost,
  fontSize: T.meta,
  margin: '4px 0 12px',
};

const notReadyStyle: CSSProperties = {
  ...shared.placeholderBox,
  marginTop: 16,
  fontSize: T.meta,
};

const errorInlineStyle: CSSProperties = {
  color: C.danger,
  fontSize: T.base,
  marginLeft: 8,
};

const formStyle: CSSProperties = {
  marginTop: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: T.base,
  fontWeight: 600,
  color: C.textDim,
  marginTop: 8,
};

const inputStyle: CSSProperties = {
  ...shared.input,
  // <select> 需要显式深色底，否则部分浏览器仍渲染白底
  background: C.bg,
  color: C.text,
};

const counterStyle: CSSProperties = {
  fontSize: T.sm,
  color: C.textGhost,
  textAlign: 'right',
};

const checkRowStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  flexWrap: 'wrap',
  marginTop: 12,
};

const checkLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: T.meta,
  color: C.textDim,
};

const errorBoxStyle: CSSProperties = {
  ...shared.errorBox,
  marginTop: 8,
};

const primaryBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
};

const ghostBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
};