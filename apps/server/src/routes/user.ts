/**
 * Settings 侧的 user 级端点 —— 对标原站 `GET /api/user/mcp-tools`
 * （recon/03-app-api.md §8：这个端点就是 Settings → API keys 里工具勾选 UI 的数据源，
 * 返回 31 项 `{name,label,group}`，`group` 即 key 的 scope 粒度）。
 *
 * 清单与 MCP 的 `tools/list` **同源**：这里直接投影 `src/mcp-tools.ts`，不复制第二份
 * 名单 —— 改工具表，这个端点和 `tools/list` 一起变。
 *
 * 鉴权（2026-10-17 更新）：用 `resolveContext` —— Bearer `tds_…` 与
 * `TDS_WEB_TOKEN`（cookie `tds_token` / `?token=`）都收。原来只用
 * `authenticateBearer`，于是浏览器拿 cookie 打这个端点恒 401，Settings 页的
 * scope 面板永远「工具目录未就绪」。原站这个端点在登录会话下，我们仍没有会话体系，
 * 所以沿用与 MCP 同一套凭据 —— 这条边界要等真正的多用户 Auth 才算收口。
 *
 * 外层包装：recon §8 只记录了「每项结构 `{name,label,group}`」，没抓到原站的外层
 * envelope，所以这里回裸数组；将来抓到 wrapper 再对齐。
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '@tds/db';
import { resolveContext } from '../auth.js';
import { HttpError } from '../http.js';
import { MCP_TOOLS } from '../mcp-tools.js';

export function registerUserRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/user/mcp-tools', async (req, reply) => {
    // 两种凭据都收：Bearer `tds_…`（MCP 客户端）与 `TDS_WEB_TOKEN`
    // （浏览器 cookie / `?token=`，Settings 页走这条）。
    //
    // 之前只用 `authenticateBearer`，于是 Web 端拿 cookie 打这个端点恒 401 ——
    // 症状是「工具目录未就绪」，而端点本身是好的。`resolveContext` 已经是
    // 「凭据 → 用户」的统一入口，直接用它。
    try {
      await resolveContext(db, req);
    } catch (e) {
      if (e instanceof HttpError) {
        return reply.code(401).send({ error: e.message });
      }
      throw e;
    }
    // 只回 UI 需要的三列 —— label 是给勾选列表显示的，group 决定 scope 粒度
    return MCP_TOOLS.map(({ name, label, group }) => ({ name, label, group }));
  });
}
