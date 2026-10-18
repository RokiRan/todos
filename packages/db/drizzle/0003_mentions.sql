-- Mentions 结构化引用（2026-10-18）
--
-- Why
--
-- 原站语义：composer 里 `Mention` 按钮 + prefix (`@ agent or member, # todo,
-- / skill, ~ project, & machine`) 写入的是「structured reference chip rather
-- than plain text」，所以 agent **resolves the exact ID instead of guessing**。
-- 见 `D:/AI/todos/recon-live/docs-conversation.md:34` 与本切片目标表。
--
-- 复刻必须在数据库层把「这条消息引用了谁」落地为可查事实，不能只把 `@张三`
-- 当成字符串塞进 `build_message.content` —— 那等同于让 agent 重新猜。
--
-- 形状选择（关联表 vs. JSONB 列）
--
--   * 关联表 `build_message_mention`（选这条）
--     - 一条消息可引用多个对象，关联表是 1:N 的正解
--     - 「这个 todo 被哪些消息引用过」可直接 `select ... where build_id+kind+ref_id` 反向查询
--     - 与 `chief_message` 同源：chat 类消息的引用数据天然 N 行，独立成表
--     - **不影响既有 911 个测试**：不改 `build_message` 任何列，不需要回填
--   * JSONB 列加在 `build_message` 上（拒这条）
--     - 必须 `nullable` + 默认 `'[]'` —— 加 NOT NULL 列会让所有现有 INSERT 失败，
--       波及既有 911 测试的 fixture 脚本（没有一条 INSERT 会带这个列）
--     - 反向查询（按 ref_id 反查消息）必须 jsonb 解构，`jsonb_path_ops` 索引
--       写起来比关联表索引繁琐
--
-- 字段语义
--   * `kind` 取原站 6 个语义：`agent | member | todo | skill | project | machine`
--   * `prefix` 是 `char(1)`：`@ | # | / | ~ | &`，与原站 prefix 表一一对应。
--     用 char(1) + CHECK 而不是自由 text，让「前端传任意字符」直接被数据库拒。
--   * `ref_id` 是被引用对象的真实主键（agent.id / member.id / todo.id ...）
--   * `label` 是写时的展示名快照 —— 避免「原对象改名后 chip 显示旧名」与
--     「原对象被删后 chip 显示不了」两类副作用
--   * CASCADE on message / build：消息 / build 删掉时这些 mention 一起走
--
-- 索引
--   * `build_message_mention_message_idx` —— 读「这条消息引用了谁」
--   * `build_message_mention_target_idx` —— 反向读「这个 todo 被哪些消息引用过」

CREATE TABLE "build_message_mention" (
  "id" text PRIMARY KEY NOT NULL,
  -- 消息删了引用一起走（CASCADE）
  "message_id" text NOT NULL REFERENCES "build_message"("id") ON DELETE CASCADE,
  -- build 删了引用一起走（CASCADE；与 build_message 同源）
  "build_id" text NOT NULL REFERENCES "build"("id") ON DELETE CASCADE,
  -- 与原站 prefix 表一一对应
  "kind" text NOT NULL CHECK ("kind" IN ('agent', 'member', 'todo', 'skill', 'project', 'machine')),
  -- 前端 `Mention` chip 字符
  "prefix" char(1) NOT NULL CHECK ("prefix" IN ('@', '#', '/', '~', '&')),
  -- 被引用对象的主键
  "ref_id" text NOT NULL,
  -- 写时展示名快照（与原对象解耦，避免改名/删除后 chip 显示错乱）
  "label" text NOT NULL,
  "created_at" bigint NOT NULL,
  -- 同一消息对同一目标只能有一行（幂等保证）
  CONSTRAINT "build_message_mention_uq" UNIQUE ("message_id", "kind", "ref_id")
);

CREATE INDEX "build_message_mention_message_idx" ON "build_message_mention" ("message_id");

-- 反向：「这个对象被哪些消息引用了」（例：`@张三` chip 反向查历史里谁提过他）
CREATE INDEX "build_message_mention_target_idx" ON "build_message_mention" ("build_id", "kind", "ref_id");
