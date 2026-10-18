import { handleSession } from '@/lib/auth';

/**
 * `GET /api/auth/session`
 *
 * 前端启动时调它决定渲染登录页还是主界面。
 * 未配置 TDS_WEB_TOKEN 时返回 { required: false } —— 开发态不需要登录。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleSession(req);
}
