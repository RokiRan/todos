-- todo.createdByType —— 看板筛选的「创建者」维度（2026-10-18）
--
-- Why
--
-- 原站看板筛选里有一组「创建者」三选项：
--   1) 我创建的（ownerMemberId = currentUserId & 人类成员）
--   2) 总管或 Agent 创建的（createdByType IN ('chief','agent')）
--   3) 其他成员创建的（兜底）
-- 前端无法做这种筛选，因为：(a) `GET /api/todos` 不返 `createdByType`；
-- (b) 数据库层根本没有这个字段。本迁移解决 (b)。
--
-- 列的语义
--
--   * `'user'`  REST 写路径（`routes/todos.ts` POST /api/todos）—— 用户在
--               New Todo / 看板卡片按钮里主动创建
--   * `'chief'` Chief 在 `routes/chief.ts` 的 `dispatchTodo` 里代发的 todo
--               —— 用户在 Chief 对话里说需求，Chief 把它变成 todo
--   * `'agent'` MCP 写路径（`routes/mcp.ts` 的 `create_todo` 工具面）——
--               模型代发，通常是 Schedule / agent ↔ agent 衔接场景
-- 三个调用点都不会给默认值 —— service 层 `createTodo` 的入参加
-- `createdByType` 字段（必填），漏传就把 service 编译期挡住，跟
-- `ownerMemberId` / `projectId` 同等的「不能漏」地位。
--
-- 既有行（迁移前 N 个 todo）一律填 `'user'`
--
-- 这是一个**可接受的近似**，不是精确还原：
--   * 早期 Chief / MCP 写的 todo 会被错标成 `'user'`
--   * 但看板筛选的语义是「这张卡片是谁造的」 —— 人类写的 todo 标记 `'user'`
--     永远不会错；Chief / Agent 写的会丢失精确归类。要做到精确就得回放
--     audit_event（每条 todo_created 都带 type + payload.projectId 之类），
--     远超本切片范围。**前端「我创建的」与「其他成员创建的」依然精确**
--     （按 ownerMemberId + 当前 user 不依赖 createdByType），只有
--     「总管或 Agent 创建的」会因回填低估。UI 应在筛选面板给出
--     「历史 todo 未精确区分创建者」的诚实提示（不在本切片范围）。
--
-- 为什么不直接用 pgEnum
--
-- `todo_phase` 用 `pgEnum`，但本列只有 3 个值且和 `audit_event.actor_type`
-- 模式更接近（自由文本 + CHECK 约束：CHECK 让脏数据写不进来，但加新枚举
-- 值不用 ALTER TYPE 那种 DB 阻塞操作；与本切片同步新增的三个写路径里没有
-- 用 enum 的习惯）。**保持 text + CHECK 与既有 audit 风格一致**。
--
-- IF NOT EXISTS 的安全网
--
-- 由 zb 工具运行：`pnpm --filter @tds/db drizzle-kit push` / 其它自定义
-- 工具可能在同一台 DB 上反复跑同一份 SQL。`ADD COLUMN IF NOT EXISTS` + 名
-- 字固定的 CHECK 让幂等性靠 DB 自己保证 —— 这台机器没有迁移版本表，DB
-- 不会重复执行，但写一份幂等的 SQL 是最便宜的防呆。

ALTER TABLE "todo" ADD COLUMN IF NOT EXISTS "created_by_type" text NOT NULL DEFAULT 'user';

-- CHECK 必须命名（迁移要可重放），且值集合与服务层契约字面对齐
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'todo_created_by_type_check'
      AND conrelid = 'todo'::regclass
  ) THEN
    ALTER TABLE "todo"
      ADD CONSTRAINT "todo_created_by_type_check"
      CHECK ("created_by_type" IN ('user', 'chief', 'agent'));
  END IF;
END $$;
