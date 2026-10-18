'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 「当前团队」上下文 —— 所有设置页的公共前置。
 *
 * **为什么需要**：设置页的 URL 是 `/api/teams/:teamId/...`，而写路径还要
 * `ownerMemberId`（`member.id`，不是 user id）。此前前端唯一的 teamId 来源是
 * `GET /api/todos` 里顺带返回的那一列 —— 空看板时整个设置区进不去。
 * 现在统一从 `GET /api/user/context` 取（`apps/server/src/routes/user-context.ts`）。
 *
 * 选中态存在 localStorage：刷新后仍停在同一个团队（单人使用下几乎总是同一个，
 * 但多团队切换后刷新跳回第一个团队会让人以为设置丢了）。
 */

export interface TeamContextEntry {
  teamId: string;
  name: string;
  /** 本人在该团队的 member.id —— 创建 todo / 派工要的 ownerMemberId 就是它 */
  memberId: string;
  role: 'admin' | 'member';
}

export interface AgentContextEntry {
  id: string;
  teamId: string;
  displayName: string;
  modelId: string | null;
  deletedAt: number | null;
}

export interface UserContext {
  userId: string;
  email: string;
  teams: TeamContextEntry[];
  agents: AgentContextEntry[];
}

const STORAGE_KEY = 'tds.activeTeamId';

interface TeamState {
  ctx: UserContext | null;
  /** null = 还在加载；'unavailable' = 后端不可达；'empty' = 确实没有团队 */
  status: 'loading' | 'ready' | 'unavailable' | 'empty';
  activeTeam: TeamContextEntry | null;
  setActiveTeamId: (teamId: string) => void;
}

const Ctx = createContext<TeamState | null>(null);

function readStoredTeamId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式下 localStorage 会抛 —— 不该让整个页面白屏
    return null;
  }
}

export function TeamProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ctx, setCtx] = useState<UserContext | null>(null);
  const [status, setStatus] = useState<TeamState['status']>('loading');
  const [teamId, setTeamId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/user/context', { cache: 'no-store' });
        if (res.status === 401) {
          if (alive) setStatus('unavailable');
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          ready?: boolean;
          data?: UserContext;
        } | null;
        if (!alive) return;
        if (!body?.ready || !body.data) {
          setStatus('unavailable');
          return;
        }
        setCtx(body.data);
        setStatus(body.data.teams.length === 0 ? 'empty' : 'ready');
        // 初始选中：localStorage 里的 id 仍有效 → 用它；否则第一个团队。
        // 逐个确认 id 存在，否则 stale 的存储值会让 activeTeam 为 null 而页面永远空着。
        const stored = readStoredTeamId();
        setTeamId(
          stored && body.data.teams.some((t) => t.teamId === stored)
            ? stored
            : (body.data.teams[0]?.teamId ?? null),
        );
      } catch {
        if (alive) setStatus('unavailable');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<TeamState>(() => {
    const activeTeam = ctx?.teams.find((t) => t.teamId === teamId) ?? null;
    return {
      ctx,
      status,
      activeTeam,
      setActiveTeamId: (next: string) => {
        setTeamId(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // 存不进去不影响本次会话内的切换
        }
      },
    };
  }, [ctx, status, teamId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * 取当前团队上下文。
 *
 * `mustHaveTeam` 让页面能把「团队还没就绪」与「有团队」分开处理：
 * 写路径（创建 provider/skill/schedule）**必须**要 teamId，渲染成
 * 「正在加载 / 还没有团队」两种占位；只读列表页则可以在没有团队时正常显示空列表
 * ——「一个 provider 都没有」和「查不到我的团队」是两回事，混起来会误导。
 */
export function useTeamContext(): TeamState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTeamContext must be used inside <TeamProvider>');
  return v;
}

/** 当前团队下的 agent（供 todo / schedule 选 agentId）。已软删的排掉。 */
export function useTeamAgents(): AgentContextEntry[] {
  const { ctx, activeTeam } = useTeamContext();
  return useMemo(
    () =>
      (ctx?.agents ?? []).filter(
        (a) => a.teamId === activeTeam?.teamId && a.deletedAt === null,
      ),
    [ctx, activeTeam],
  );
}
