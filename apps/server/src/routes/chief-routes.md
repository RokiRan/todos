# Chief REST 路由层（HTTP + 数据访问）

文件：`apps/server/src/routes/chief.ts`
测试：`apps/server/test/chief-routes.test.ts`（18 个测试全绿，连真库 `postgres://tds@127.0.0.1:5433/tds`）

## 端点清单

所有路由通过 `registerChiefRoutes(app, db)` 注册到 Fastify。统一的 `HttpError` 在路由
末尾的 `setErrorHandler` 里转成对应状态码。

| Method | Path | 字段 / 行为 | 状态码 |
| --- | --- | --- | --- |
| GET | `/api/teams/:teamId/chief?userId=` | 按 `chief-<userId>-<teamId>` 规则查 chief；找不到返回 `{chief: null}`；带 `agentName` 便于 UI 渲染 | 200 / 422 |
| PUT | `/api/teams/:teamId/chief/charter` | body `{userId, charter}`；非 team 成员 403；找不到 chief 404；写入并落 `chief_charter_updated` 审计 | 200 / 403 / 404 / 422 |
| GET | `/api/teams/:teamId/chief/threads?userId=` | 列出该 chief 的所有 topic，按 `created_at desc` 排序，字段对齐 schema：id / chiefId / title / session / watchedTodos / toolDefHashes / pendingSessionResumeAt / lastTurnAt / createdAt / updatedAt | 200 / 422 |
| POST | `/api/teams/:teamId/chief/threads` | body `{userId, title, initialMessage?}`；强制 ≤50 上限（`MAX_TOPICS_PER_CHIEF = 50`），超出返 422；写入 `chief_thread` 并落 `chief_thread_created` 审计 | 200 / 422 |
| GET | `/api/chief/threads/:threadId` | 单 topic 详情（`chief_thread.*`）；不存在 404 | 200 / 404 |
| GET | `/api/conversations/:convId/messages?sinceSeq=` | 按 `build_message` 表 `seq asc` 查；`sinceSeq` 缺省查全部；topic 没绑 build 时返空 messages 不 500 | 200 |
| POST | `/api/chief/threads/:threadId/dispatch` | body `{teamId, projectId, ownerMemberId, agentId, title, spec?}`；派工走 `transition()`；branch = `tds/conv-<buildId>`；build.triggerSource = `chief`；无机器时 todo phase = `queued`，不写 step | 200 / 404 / 422 / 403 |
| GET | `/api/chief/threads/:threadId/watches` | 返回该 thread `watchedTodos` 里每条 todo 的快照（id / phase / title / seqNum / projectId / updatedAt）；不存在 404 | 200 / 404 |

## Dispatch 状态机流转

`dispatchTodo()` 是派工核心。一次成功调用产生：

- 1 条 `todo`（默认 `seqNum = project.nextSeqNum`，然后递增 `next_seq_num`）
- 1 条 `build`，`branch = 'tds/conv-' + buildId`，`triggerSource = 'chief'`
- 0 或 1 条 `step`（仅有空闲机器时建）

phase 推进规则：

1. 探测 `machines`：取团队内 `build_enabled = true AND is_online = true` 的最早一台。
2. 无机器：`todo.phase = 'queued'`、`step` 不建。daemon claim 路径在 `routes/machine.ts`
   里负责后续 `queued → planning`（不在本文件范围）。
3. 有机器：先以 `phase = 'todo'` 落库，然后走 `transition('todo', { kind: 'claim',
   machineId })` 拿到 `nextPhase`，再 `update todo.phase`。`step.status = 'queued'`。
   重申：phase 的最终值由 `transition()` 决定，路由层不写自己的 if 链。
4. 写 `audit_event`（type = `dispatched`）并通过 `publish(db, 'todo:<id>', 'dispatched', ...)`
   推 SSE。
5. 把 `todoId` push 到 `chief_thread.watchedTodos`（静态 `Array.includes` 去重），所以
   Chief 发起派工后该 topic 自动 watch 这个 todo，到 confirm / review / settled 时
   由 `chief/watch.ts`（主代理落盘）负责在原 topic 唤醒 Chief。

未触发字段：build 的 `prevPhase` 取 `null`（首条 build 还没有前置）；`withPlan = true`、
`withChecklist = false`、`usageByModel = []`；后续由 daemon turn 重写这些字段。

## 闸门铁律在路由层的兑现

- 派工要推进时一律走 `transition()`，不写 `if (phase === 'todo') phase = 'queued'` 之类。
- `feedback` / `approve` / `complete` 不在本路由层出现 —— 它们的所有权属于
  `routes/todos.ts`，由闸门铁律统一保障 `confirm` / `review` 不被任何文字输入推进。

## 与主代理 chief/* 的边界

- HTTP 端点在这里。
- 派工完成后调 `notifyDispatched(db, evt)`（当前 no-op 占位），主代理在 `apps/server/src/chief/dispatch.ts`
  落盘后改成同名静态 import 即可；本文件不再改动。
- `chief/watch.ts` 的唤醒逻辑与本文件互不依赖 —— 路由层只负责把 todoId 加到
  `watchedTodos`，闸门唤醒由 SSE 事件订阅者驱动（prototype 在该文件里集成）。

## 测试覆盖

`chief-routes.test.ts` 用 `Fastify().inject()` 跑真 DB；每个测试 seed 一套
独立 fixture（`seedFixture` ＝ user + team + member + agent + project + chief），
after 兜底按反序删 `team` 与 `user`。

涵盖的回归断言：

- chief 命中规则与 `{chief: null}` 负向
- `userId` 缺省触发 422
- PUT charter 真落库 + 审计 + 403（非成员）
- POST threads 的 50 上限（用 50 条预插 fixture 砸边界）
- GET threads 返回字段名严格对齐 schema（含 `session.runtime/openedAt`、`toolDefHashes: {}`、`watchedTodos: []`）
- 单 topic 详情 200 与不存在的 404
- GET messages 对未知 conv 返回空数组
- dispatch 无机器：phase = queued、无 step、branch = `tds/conv-<id>`、`triggerSource = 'chief'`、
  watchedTodos 自动加入
- dispatch 有机器：phase = planning、step.status = queued 且 machine_id = null（claim 还没跑）、
  audit payload 含 `hasMachine: true` 与 `threadId`
- dispatch 同 thread 二次派：watchedTodos 仅两条，first 不重复
- dispatch body 缺字段：422
- watches 列出真实 todo 的快照；thread 不存在 404

测试结果：`18/18 通过，duration ≈ 1.0s`，连真库。
