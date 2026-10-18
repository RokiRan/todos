/**
 * Chief todo 生命周期工具的服务层：`delete_todos` `relay_question`。
 *
 * 为什么单独成模块而不直接堆进 `todos.ts`：
 *   - `services/todos.ts` 已经是 REST 与 MCP 共用的「真源」；再加 Chief 专属的
 *     批量 / 卡片语义会让那文件过载，且语义混着不可逆 / 跨团队 / 批量「尽力」
 *     这三类跟单条 `commitPhaseTransition` 的契约并不相同
 *   - 本模块只服务 Chief 工具面（`chief/executor.ts`）；REST 路由不引入
 *   - 闸门（工具不存在 / `irreversible` 未确认 / `needsAdminGrant`）走执行器，
 *     服务层只负责执行；这是与既有 18 个接线工具同款的分工
 *
 * 跨团队：所有读 / 写按 `teamId` 收紧；用「跨团队 403 且库里未动」的策略 —— 与
 * `services/todos.ts` 的 `loadTodoTeamId` 不同，本模块对「todo 不属于这个 team」
 * 报 403 而非 404（与既有 `chief-interaction.ts:ACCESS_DENIED` 措辞同款）。
 */
import { eq } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { auditEvents, projects, todos } from '@tds/db';
import { now } from '../ids.js';
import { HttpError } from '../http.js';
import { deleteTodo } from './todos.js';
import {
  askUser,
  type AskUserInput,
  type QuestionDocument,
} from './chief-interaction.js';

/* ── 跨团队措辞 ────────────────────────────────────────────── */

const ACCESS_DENIED = (teamId: string): string =>
  `team "${teamId}" is not accessible to this key's owner`;

/* ── deleteTodos ───────────────────────────────────────────── */

/** `deleteTodos` 单项结果 —— 与 MCP `complete_todos` 等的 `{results, succeeded, failed}`
 *  同款 shape，模型可以按 `ok:false` 的项自取自重试。 */
export interface DeleteTodoOutcome {
  todoId: string;
  ok: boolean;
  reason?: string;
}

/** `deleteTodos` 入参 —— 团队必传（与单条 `deleteTodo(db, todoId, teamId)` 不同：
 *  批量入口必须由调用方传 `teamId`，否则越权校验无从谈起）。 */
export interface DeleteTodosInput {
  teamId: string;
  actorId: string;
  todoIds: string[];
}

/** `deleteTodos` 出参。 */
export interface DeleteTodosResult {
  results: DeleteTodoOutcome[];
  succeeded: number;
  failed: number;
}

/**
 * 批量硬删 todo —— 「逐个尽力」语义，不是全或无。
 *
 * ## 与 `services/todos.ts:deleteTodo` 的关系
 *
 * **逐项复用 `deleteTodo(db, todoId, teamId)`**，不重写级联：
 *   - 那条函数内部已经做了 `DELETE FROM todo` + `DELETE FROM audit_event WHERE todo_id=…`
 *     + `publish('todo_deleted')`，并把 FK 级联（build / step / message / document /
 *     checklist / step_credential）交给 schema 的 `onDelete: 'cascade'`（`packages/db/
 *     schema.ts` 里指向 todo / build 的 FK 一律 cascade，**只在删 todo 时**）
 *   - 重写一份会把「FK 是不是真的 cascade」这件事分裂成两份；哪天 schema 加
 *     `restrict` 的 FK，谁也不会发现 `deleteTodo` 已经跟着改了
 *
 * ## 校验
 *
 * 每项先用 `loadTodoTeamId` 反查 todo 真实所属 team，与入参 `teamId` 不一致就
 * 报 403 —— **整个不入 outcomes**，且不在 `audit_event` 留痕（跨团队尝试本身
 * 不该落库）。**这是「库里未写」的硬要求**（不在本 fixture 下留任何行）。
 *
 * ## 批量语义
 *
 * 一项失败不影响其它项；最终 `succeeded + failed === todoIds.length`。
 * 这与 `routes/mcp.ts` 的 `complete_todos` / `run_builds` 等同款：模型拿到
 * `{results, succeeded, failed}` 会自取自重试 ok:false 那几项。
 */
export async function deleteTodos(
  db: Db,
  input: DeleteTodosInput,
): Promise<DeleteTodosResult> {
  const outcomes: DeleteTodoOutcome[] = [];

  for (const todoId of input.todoIds) {
    try {
      // 归属只能由 todo 反查 —— 客户端传的 teamId 一律不信。
      const todo = await db
        .select({ teamId: projects.teamId })
        .from(todos)
        .innerJoin(projects, eq(projects.id, todos.projectId))
        .where(eq(todos.id, todoId))
        .limit(1);
      const row = todo[0];
      if (!row) {
        // 不存在 = 与跨团队给同一个答案（不泄露存在性）
        outcomes.push({ todoId, ok: false, reason: ACCESS_DENIED(input.teamId) });
        continue;
      }
      if (row.teamId !== input.teamId) {
        outcomes.push({ todoId, ok: false, reason: ACCESS_DENIED(input.teamId) });
        continue;
      }

      // 复用既有单删：FK cascade 自动带走 build / step / message / document / checklist，
      // audit_event 在 deleteTodo 内显式清掉。
      await deleteTodo(db, todoId, input.teamId);

      // 双轨审计：Chief 工具面发起的写，actorType='chief'，与 agents-admin 一致。
      await db.insert(auditEvents).values({
        teamId: input.teamId,
        actorType: 'chief',
        actorId: input.actorId,
        todoId,
        buildId: null,
        type: 'todo_deleted',
        payload: { todoIds: [todoId] },
        createdAt: now(),
      });

      outcomes.push({ todoId, ok: true });
    } catch (e) {
      // 单项失败：翻译成 reason 不抛 ——「逐个尽力」语义的全部意义在此
      if (e instanceof HttpError) {
        outcomes.push({ todoId, ok: false, reason: `${e.statusCode}: ${e.message}` });
        continue;
      }
      throw e;
    }
  }

  const succeeded = outcomes.filter((o) => o.ok).length;
  return { results: outcomes, succeeded, failed: outcomes.length - succeeded };
}

/* ── relayQuestion ─────────────────────────────────────────── */

/** `relayQuestion` 入参 —— 把 agent 的提问「转发」到 todo 上的 question 文档。
 *
 *  与 `ask_user` 的区别：
 *   - `askedBy` 固定 `{type: 'agent', id, name}` —— 语义是「这是 agent 在问，
 *     Chief 把它转给你」
 *   - `todoId` 必传：卡要挂到具体 todo 上，模型才能定位
 *
 *  其余字段（question / options / allowFreeText）与 `ask_user` 完全同形。 */
export interface RelayQuestionInput {
  teamId: string;
  actorId: string;
  todoId: string;
  /** 提问 agent —— Chief 转发时的来源。 */
  agent: { id: string; name: string };
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowFreeText?: boolean;
}

/**
 * 把 agent 的提问转发到 todo 上的 question 文档（薄封装 `askUser`）。
 *
 * ## 与 `chief-interaction.ts:askUser` 的关系
 *
 * **存储层共用 `documents(kind='question')` 一张表** —— 这是 recon 文档里
 * `Question card` 的官方落点（concepts.md 第 103-104 行；inbox.md「Answering a
 * question」段）。`relay_question` 与 `ask_user` 的唯一区别是 `askedBy.type`：
 * 前者从 agent 转，后者从 Chief 自己发起。复用 `askUser` 实现意味着：
 *   - 文档版本号 / 审计双轨 / build 关联全部走同一条路径，UI 反查时不需要
 *     再写第二个 kind / 第二个 version 序列
 *   - `chief/cards.ts:QuestionCard.askedBy.type` 既支持 'chief' 也支持 'agent'，
 *     渲染层不需要分两条路
 *
 * ## 与 recon 的「relays」措辞的对应
 *
 * recon/docs/chief.md 行 138 verbatim：「Chief relays the build's question card
 * directly into the Chief thread so you can answer from either place」。该段
 * 描述的是**用户感知**（同一个问题在 todo 和 Chief thread 都能答），而底下的
 * 存储仍然是同一份 question 文档 —— **没有 inbox 表 / 没有 thread inbox 表**，
 * 「在两边都能答」由 UI 层的 `listQuestionsForTodo` 反查覆盖，本服务层不需要
 * 写第二份。
 *
 * **未确认项**：recon 没有给出 `relay_question` 工具的入参 schema 与返回形状。
 * 本实现按 `ask_user` 的同款语义给出最保守版本（薄封装 `askUser`，把
 * `askedBy.type` 改成 `'agent'`）。将来 recon 补到原站 `relay_question` 的实际
 * 入参，再调整本函数即可。
 */
export async function relayQuestion(
  db: Db,
  input: RelayQuestionInput,
): Promise<QuestionDocument> {
  if (input.question.trim().length === 0) {
    throw new HttpError(400, 'question must not be empty');
  }
  if (input.options.length === 0) {
    throw new HttpError(400, 'question must include at least one option');
  }

  const askInput: AskUserInput = {
    teamId: input.teamId,
    actorId: input.actorId,
    todoId: input.todoId,
    askedBy: { type: 'agent', id: input.agent.id, name: input.agent.name },
    question: input.question,
    options: input.options,
    ...(input.allowFreeText !== undefined ? { allowFreeText: input.allowFreeText } : {}),
  };

  return askUser(db, askInput);
}
