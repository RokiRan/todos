-- Chief 对话消息独立成表（2026-07-17）
--
-- 起因：`routes/chief.ts` 一直用「`thread.session.id` 当 buildId、把 Chief 对话
-- 写进 `build_message`」的做法。那在数据库层**不成立** —— `build_message.build_id`
-- 是指向 `build` 的真外键，而 Chief thread 的 `session.id` 背后没有 build 行，
-- 写入被数据库直接拒绝（`build_message_build_id_build_id_fk`）。
--
-- 补一条真 build 行也不通：`builds.todo_id` 是 NOT NULL，而 Chief 自己不拥有 todo。
--
-- 所以独立一张表。形状贴着 `build_message`（role / content / seq / trigger_by
-- 同名同义），`seq` 索引同名，方便复用「按 seq 增量拉」的读法。

CREATE TABLE "chief_message" (
  "id" text PRIMARY KEY,
  -- 归属：thread 删掉时消息一起走（CASCADE）
  "thread_id" text NOT NULL REFERENCES "chief_thread"("id") ON DELETE CASCADE,
  -- system | user | assistant | tool（与 ModelMessage.role 同名同义）
  "role" text NOT NULL,
  "content" text NOT NULL,
  -- role='tool' 时指向它回应的那个 assistant.tool_calls 条目
  "tool_call_id" text,
  -- role='assistant' 时这一回合请求了哪些工具；回灌历史时必须带上，
  -- 否则 tool 消息找不到对应 assistant.tool_calls，上游下一轮直接 400
  "tool_calls" jsonb,
  "trigger_by" text,
  "is_error" boolean DEFAULT false NOT NULL,
  -- per-thread 递增序号，增量拉取用
  "seq" bigint NOT NULL,
  "created_at" bigint NOT NULL
);

-- 按 seq 增量拉取的主力索引（与 build_message 的 message_build_seq_idx 同构）
CREATE INDEX "chief_message_thread_seq_idx" ON "chief_message" ("thread_id", "seq");
