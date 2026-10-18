-- machine_pending_action —— 「同步到机器」的指令队列（2026-10-18）
--
-- Why
--
-- `POST /api/todos/:todoId/sync-to-machine` 过去四条分支全返 `ok:false`，因为
-- daemon 侧没有「把分支拉到本机目录」的协议。server 端**不能执行 git** —— git
-- 只能在装了 repo 的那台机器上跑。所以这里加的是「指令队列」而不是「同步状态」：
-- server 写一行 pending，daemon 在 `POST /api/machine/recover` 里领走并执行，
-- 执行完 `POST /api/machine/action-result` 回执把行置终态。
--
-- 为什么独立成表、而不是加列到 `machine`
--
--   * 一台机器可能同时有多个待办动作（用户连点两次、两个不同 todo），加列只能
--     存一条，第二条要么覆盖第一条（丢指令）要么排队失败。
--   * `machine` 现在的职责是「设备档案」（name / deviceId / runtimes /
--     workspacesDir / isOnline）。把指令队列塞进去会让一张表承担两种生命周期：
--     档案是长期稳定的，队列每几秒就被写一次 —— 混在一起之后连「这台机器在线
--     吗」这种查询都要跟队列争行锁。
--
-- 状态机
--
--   pending → running → done | failed
--   `running` 是 daemon 认领后的中间态。`attempts` 在认领时 +1，用来区分
--   「第一次跑」与「重试」—— 回执的审计 payload 里带它，排查「为什么这条
--   同步跑了两遍」时不用猜。
--
-- IF NOT EXISTS 的安全网
--
-- 与 `0004_todo_created_by_type.sql` 同一个理由：这台机器没有迁移版本表，
-- `pnpm --filter @tds/db push` / 手工 `psql -f` 都可能把同一份 SQL 跑第二遍。
-- 建表与建索引都加 `if not exists`，幂等性靠 DB 自己保证。表内的 CHECK 不需要
-- `DO $$` 守卫 —— 表本身没建成第二份，约束就不会重复加。

create table if not exists machine_pending_action (
  id            text primary key,
  machine_id    text not null references machine(id) on delete cascade,
  team_id       text not null,
  kind          text not null check (kind in ('sync_branch')),
  -- 指令载荷
  branch        text not null,
  dir           text not null,
  build_id      text references build(id) on delete cascade,
  todo_id       text references todo(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'done', 'failed')),
  -- 回执
  result        jsonb,               -- { ok, commitSha?, filesChanged?, error? }
  requested_by  text not null,       -- 发起用户 id（审计用）
  requested_at  bigint not null,
  started_at    bigint,
  finished_at   bigint,
  attempts      int not null default 0,
  error         text
);

-- 部分索引：只索引 pending 行。`recover` 的查询恒带 `status = 'pending'`，
-- 而 done/failed 行会一直留着（审计要看历史），全表索引会让它们白白占位。
create index if not exists machine_action_pending_idx on machine_pending_action (machine_id, status)
  where status = 'pending';
