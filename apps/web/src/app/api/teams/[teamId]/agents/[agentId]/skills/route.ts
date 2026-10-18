import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：把若干 skill 绑到 agent 的 `defaultSkillIds`（**整体替换**）。
 *
 * 上游 `POST /api/teams/:teamId/agents/:agentId/skills` body `{userId, defaultSkillIds}`
 * 是一次性赋值，不是增量追加 —— 这是 docs/skills.md「Give a skill to an agent」
 * 在 UI 上的最直接对应：用户在 agent 详情里勾若干 skill，整体保存。
 *
 * 422（超 10 / 未知 skillId）/ 403（非 admin）/ 404（agent 不属于本 team）原样透出。
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ teamId: string; agentId: string }> }): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    { path: (t) => `/api/teams/${t}/agents/${agentId}/skills` },
    'POST',
  );
}
