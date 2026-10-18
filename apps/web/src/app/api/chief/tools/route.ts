import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/chief/tools` —— Chief 的工具面清单。
 *
 * 上游（`apps/server/src/routes/chief.ts:809` GET tools）需要鉴权：
 * `resolveContext` 仅校验 token 存在，不筛内容（清单是全局的）。
 *
 * `wired` 字段是关键差异点：
 *   - `true`  = 已接线（直接调用本地 executor 或走 MCP）
 *   - `false` = 「真缺口」（声明了但没实现）
 * UI 必须把 `wired=false` 标灰显示，让运维一眼能看出哪些工具没装。
 *
 * 这条 BFF 转发时保留 `wired` 字段 —— `pick` 用对象解构而不是 cast
 * 数组索引以避免后续字段增加时漏字段。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  return proxyRead(req, '', {
    path: () => '/api/chief/tools',
    // 透传整段（tools + count），让 UI 自己取所需字段
    pick: (body) => {
      const obj = body as { tools?: unknown[]; count?: number };
      return { tools: obj.tools ?? [], count: obj.count ?? 0 };
    },
  });
}