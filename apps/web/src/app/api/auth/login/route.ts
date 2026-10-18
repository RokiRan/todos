import { handleLogin } from '@/lib/auth';

/**
 * `POST /api/auth/login`
 *
 * 单一职责：校验 token 并下发 httpOnly cookie。
 * 逻辑与其它端点无关，单独成文件便于前端登录表单直接 POST。
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleLogin(req);
}
