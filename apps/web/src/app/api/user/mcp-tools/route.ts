import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：MCP 工具目录（Settings → API keys 里 scope 勾选的数据源）。
 *
 * 上游 `GET /api/user/mcp-tools` 的清单与 MCP 的 `tools/list` **同源**
 * （服务端直接投影 `src/mcp-tools.ts`），所以这里不做任何增删，只透传。
 *
 * 少了这条路由，Settings 页的 scope 面板会显示「工具目录未就绪」——
 * 症状看着像后端没实现，实际是 BFF 没接。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const res = await fetch(`${API_BASE}/api/user/mcp-tools`, {
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `http-${res.status}` }, { status: res.status });
    }
    // 上游回的是**裸数组**（recon §8 只记了每项 `{name,label,group}`，
    // 没抓到外层 envelope），这里原样透传，客户端自己判形状。
    const data = await res.json();
    return NextResponse.json(data, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
