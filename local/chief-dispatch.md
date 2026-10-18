# Chief 派工决策层（dispatch + watch）—— 交付说明

切片：`apps/server/src/chief/{types,dispatch,watch}.ts` + `apps/server/test/chief-dispatch.test.ts`

---

## 类型清单（`apps/server/src/chief/types.ts`）

| 类型 | 作用 |
|---|---|
| `ChiefId` | Chief 运行时 ID 命名：`chief-<userId>-<teamId>` |
| `Topic` | 单个对话主题（独立 history / context / watched todos / check-ins） |
| `WatchedTodo` | Chief 对 todo 的关注（chief 或 user 触发） |
| `CheckIn` | 一次性定时唤醒（用于平台外工作） |
| `DispatchRequest` | 派工决策输入（纯逻辑，不碰 DB/HTTP） |
| `StandingGrantLite` | standing 授权的轻量表示（避免跨模块依赖 prompt.ts 内部） |
| `DispatchDecision` | discriminated union：`dispatch` / `needsApproval` / `needsClarification` / `refuse` |
| `ThinkingLevel` | `'low' \| 'medium' \| 'high'` |
| `QuestionCard` | Chief 拍板前必须先弹给用户的卡片（todo + agent + thinking + reason） |
| `ConfirmationCard` | 不可逆操作（删 agent/skill/secret/connection/provider/todo）前的闸门卡 |
| `WakeTrigger` | 唤醒源（gate / agent_question / review_failed / settled） |
| `WakeEvent` | 单条 wake 事件（同 topic 合并为一条） |

---

## 决策树（`decideDispatch`）

```
1. onlineMachineCount === 0          → refuse（"没有在线机器可派工"）
2. idleAgentIds 为空                  → refuse（"没有空闲 agent 可派工"）
3. spec 缺 goal/boundary/done 之一    → needsClarification + missing 列表
4. requestedByUser === true           → dispatch（reason="用户原话请求"）
5. userMessage 含 standing 授权       → dispatch（reason="standing 授权覆盖"）
6. 其它（Chief 自己拍板）              → needsApproval + question card
```

standing 授权的识别复用 `prompt.ts.parseStandingGrants`（不重复实现），
三层优先级（per-todo > per-agent > per-team）复用 `prompt.ts.hasGrant`。

---

## 与 permissions.ts 的复用点

`canAutoDispatch` 把 `prompt.ts.hasGrant` 的三层匹配暴露为「是否可自动派」，
**纯逻辑层**：不引入 admin role / connection / machine 开关。
permissions.ts 派生的 caller（如要扩展自动授权链路）可调它做 standing 判定。

未在本模块重复实现：
- `canUseElevatedTool`（admin role + viaChief + userExplicitlyRequested 三段判定）
- `canUseConnection`（每 agent ≤10 + per-connection 开关）
- `canRunOn`（machine 开关 + runtime 开关）

Chief 「绝不自行授予」的铁律由 permissions.ts 独占保证，本模块不绕开。

---

## watch 机制（`apps/server/src/chief/watch.ts`）

| 导出 | 作用 |
|---|---|
| `shouldWatch(triggerBy)` | Chief 五种 turn 来源自动 watch；`user_typed` 例外（走普通通知） |
| `wakeEvents(builds, at)` | 把 phase 变更折叠成 wake 事件，同 topic **合并**（dedup by topicId） |
| `wakeTriggersFor(build)` | 单 build → trigger 数组（gate / review_failed / agent_question / settled） |
| `nextCheckIn(at, now)` | 7 天上限钳位（MAX_CHECKIN_DAYS 来自 prompt.ts.CHIEF_LIMITS） |
| `canCreateTopic(n)` | 50 topic 上限判定（MAX_TOPICS 来自 prompt.ts.CHIEF_LIMITS） |
| `WATCH_LIMITS` | 锁定 MAX_TOPICS=50 / MAX_CHECKIN_DAYS=7（防回退） |

dedup 用 `Map<string, WakeTrigger[]>`（动态键、累加）：
- 静态字面量用 `Record` —— 这里**不是**静态字面量，是运行时累加器
- 保证确定性顺序（Map 保留插入序 → `[...byTopic.entries()]`）

---

## 文档铁律的覆盖

| chief.md 铁律 | 覆盖位置 |
|---|---|
| 用户原话 → 自动派 | `decideDispatch` step 4 |
| 用户说「别问我了 / 就这么办」→ 自动派 | `parseStandingGrantsLite` + step 5 |
| Chief 自己拍板 → question card | `decideDispatch` step 6 + `QuestionCard` |
| 锐化：goal / boundary / done 缺一不可 | `sharpen` + `needsClarification` |
| 不可逆操作 → confirmation card | `ConfirmationCard`（构造留给 caller） |
| Chief 自己起 turn → 自动 watch | `shouldWatch('chief_*')` |
| 用户直接给 todo 发消息 → 不 watch | `shouldWatch('user_typed') === false` |
| 闸门/提问/review 失败/settled 唤醒 | `wakeTriggersFor` |
| 同 topic 并发 wake 合并 | `wakeEvents` Map 累加 |
| 每 team 最多 50 topic | `canCreateTopic` + `WATCH_LIMITS.MAX_TOPICS=50` |
| check-in 最远 7 天 | `nextCheckIn` + `WATCH_LIMITS.MAX_CHECKIN_DAYS=7` |
| Chief 绝不自行授权 | 不实现，留在 permissions.ts |

---

## 路由集成契约（`onDispatched`）

`apps/server/src/routes/chief.ts` 已 try/catch import `onDispatched`（peer 提前写的整合边界）。
本模块提供纯逻辑版 `onDispatched(_db, evt) → OnDispatchedOutcome`：
- `watched`: 始终 `true`（Chief dispatch 路径）
- `advice`: `dispatch` / `hold`（gate 相位 → hold，其它 → dispatch）
- **不**直连 DB —— caller 负责写库

---

## 测试覆盖（52 个，全绿）

`apps/server/test/chief-dispatch.test.ts`（node:test + tsx，中文名）：

| 分组 | 测试数 | 覆盖 |
|---|---|---|
| sharpen | 4 | 完整 / 缺段 / 全缺 / 中文标题 |
| pickAgent | 4 | 空 / 偏好 / 回退 |
| pickThinkingLevel | 3 | 高 / 低 / 中 |
| standing 授权三层 | 5 | per-todo / per-agent / all_gates / 冲突具体胜出 / 不匹配 |
| decideDispatch 决策树 | 7 | 资源缺 / 用户原话 / standing / 自行拍板 / 缺信息 / 信息优先于原话 |
| shouldWatch | 6 | 五种 chief 来源 + user_typed |
| wakeEvents + wakeTriggersFor | 7 | planning gate / review+failed / agent_question / settled×3 / 中段无 / 同 topic 合并 / 顺序确定 |
| nextCheckIn 7 天上限 | 6 | 过去 / now / 内 / 超 7 / 边界 / 常量锁 |
| canCreateTopic 50 上限 | 4 | 0 / 49 / 50 / 常量锁 |
| onDispatched | 3 | chief_dispatch / gate×3 hold / 非 gate dispatch |
| dispatch ↔ prompt.ts 边界 | 3 | liftGrant / parseStandingGrantsLite / scope 类型 |

---

## 验证结果

```
$ npx tsx --test test/chief-dispatch.test.ts
ℹ tests 52   pass 52   fail 0

$ npx tsc --noEmit | grep -E "src/chief/(types|dispatch|watch)\.ts"
（无输出 —— 三个文件零类型错误）
```

主代理全量 typecheck 时，本模块相关错误为零；剩余 `cards.ts` / `routes/chief.ts` 的
类型错误由对应 peer 在自己的切片里处理。
