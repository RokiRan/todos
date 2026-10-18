import { handleLogout } from '@/lib/auth';

/**
 * `POST /api/auth/logout` —— 清掉 token cookie。
 */

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return handleLogout();
}
