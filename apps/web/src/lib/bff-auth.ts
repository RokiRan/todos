/**
 * BFF 转发凭据的单一入口。
 *
 * 为什么抽出来：cookie 转发的写法在 6 条 BFF 路由里逐字重复过。重复不是问题，
 * **漂移**才是 —— 有的路由带 cookie、有的忘了带，后端收到「无凭据」就 401，
 * 而症状看起来像「后端坏了」。抽一处之后新增路由不会再漏。
 *
 * cookie 名（`tds_token`）由 `lib/auth.ts` 的 `handleLogin` 下发，与后端
 * `src/auth.ts` 的 `readWebToken` 读的是同一个名 —— 改动必须三边同步。
 */
export function forwardAuthHeaders(req: Request): Record<string, string> {
  const cookie = req.headers.get('cookie');
  // 空 cookie 就不带这个头：后端会把它当作「无凭据」而不是「空凭据」，
  // 两者返回的 401 措辞不同，排查时要看得出区别。
  return cookie ? { cookie } : {};
}
