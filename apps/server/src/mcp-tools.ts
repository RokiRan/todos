/**
 * MCP 入站工具面 —— **31 个**，与 Chief 的 58 个分开。
 *
 * 实测出处（recon/03-app-api.md §8）：原站 `GET /api/user/mcp-tools` 返回 31 项
 * `{name,label,group}`，`group` 只有 `read` / `write` 两种（read 13 / write 18）。
 * recon/docs/mcp.md 的能力分组（Read the workspace / Read the repo / Read progress /
 * Organize work / Run work / Manage lifecycle / Manage credentials）与这份名单一致，
 * 并且写明「MCP 是 Chief 工具面的**受限投影**」：Chief 多出的 `watch_todos`
 * `set_wake` `connect_app` `add_provider` `create_agent` `docs` `relay_question`
 * 等编排专属工具**不在** MCP 面上。
 *
 * 所以这张表是 MCP 侧唯一的工具清单：`tools/list`、`tools/call` 的「工具是否存在」、
 * scope 授权、以及 Settings → API keys 的勾选目录（`GET /api/user/mcp-tools`）
 * 全部从这里取 —— 不再拿 Chief 的 58 当 MCP 的合同。
 *
 * Chief 的 58（`src/chief/tools.ts`）**一个字都没动**，那是 Chief 自己的合同。
 * Chief 有、MCP 没有的三个工具（`create_project` / `update_project` /
 * `delete_todos`）在 MCP 上表现为「**不存在**」（与未知工具同一个 `-32002`），
 * 不是「未实现」—— 对客户端来说「这个 key 没这个能力」和「这个能力我们还没做」
 * 是两件事，前者才是对标结论。
 *
 * label / description 复用 Chief 的 summary：recon §8 只记录了 `{name,label,group}`
 * 这个**结构**，没有抓到原站 label 的逐字文案，所以不凭空编造文案，用已有的一份
 * summary 当 label（单一真源，改一处两边都变）。
 */

import { chiefToolSpec } from './chief/tools.js';
import { SPEC_MAX_CHARS } from './services/todos.js';

export type McpToolGroup = 'read' | 'write';

/** MCP 面上的一个工具：名字、分组、给勾选 UI 的 label、给模型的 description、入参契约。 */
export interface McpToolSpec {
  name: string;
  group: McpToolGroup;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 31 项的**名字与分组**（recon §8 逐字名单：read 13 / write 18）。
 *
 * `group` 必须显式声明，不能从 Chief 的 7 个分组推导 —— 两者正交：
 * `todos`（Chief 的 `todo` 组）在 MCP 是 read，`create_todo`（同一个 Chief 组）
 * 是 write；`secrets`（Chief 的 `infra` 组）是 read，`set_secret` 是 write。
 * 读写分离是原站 key 勾选 UI 的粒度（recon §8 注：「`secrets` 在 read 组但
 * `set_secret`/`delete_secrets` 在 write 组」）。
 */
const TABLE: Array<{ name: string; group: McpToolGroup }> = [
  // ── read (13) ───────────────────────────────────────────────
  { name: 'todos', group: 'read' },
  { name: 'projects', group: 'read' },
  { name: 'conversation', group: 'read' },
  { name: 'agents', group: 'read' },
  { name: 'schedules', group: 'read' },
  { name: 'attachment', group: 'read' },
  { name: 'skills', group: 'read' },
  { name: 'machines', group: 'read' },
  { name: 'issues', group: 'read' },
  { name: 'pull_requests', group: 'read' },
  { name: 'workflow_runs', group: 'read' },
  { name: 'secrets', group: 'read' },
  { name: 'mcp_servers', group: 'read' },

  // ── write (18) ──────────────────────────────────────────────
  { name: 'create_todo', group: 'write' },
  { name: 'update_todo', group: 'write' },
  { name: 'message_todo', group: 'write' },
  { name: 'run_builds', group: 'write' },
  { name: 'run_review', group: 'write' },
  { name: 'confirm_builds', group: 'write' },
  { name: 'merge_builds', group: 'write' },
  { name: 'cancel_builds', group: 'write' },
  { name: 'complete_todos', group: 'write' },
  { name: 'close_todos', group: 'write' },
  { name: 'reopen_todos', group: 'write' },
  { name: 'schedule_todo', group: 'write' },
  { name: 'unschedule_todo', group: 'write' },
  { name: 'set_secret', group: 'write' },
  { name: 'delete_secrets', group: 'write' },
  { name: 'add_mcp_server', group: 'write' },
  { name: 'update_mcp_server', group: 'write' },
  { name: 'delete_mcp_servers', group: 'write' },
];

/**
 * 输入契约（MCP `tools/list` 协议规定 `inputSchema` 是 JSON Schema object）。
 *
 * 手写、只声明确知字段，其它一律 `additionalProperties: true` 透传：
 * - 项目依赖里有 zod，但 `zod-to-json-schema` 不在 dependencies，加依赖要动
 *   CONTRACT 之外的 package.json，不值当
 * - docs/mcp.md 与 docs/api-keys.md 都没给出任何工具的权威 JSON Schema；
 *   读类工具只列已知查询字段，写类工具只列必填字段，写严了会把客户端合法的
 *   细粒度调用挡在外面
 *
 * `spec` 的上限取 `SPEC_MAX_CHARS`（服务层那份），不在这里写第二份 800。
 */
function inputSchemaFor(name: string): Record<string, unknown> {
  switch (name) {
    case 'todos':
      return {
        type: 'object',
        properties: {
          teamId: { type: 'string' },
          projectId: { type: 'string' },
          todoId: {
            type: 'string',
            description: '给了就是读单条 todo 的完整上下文（含 builds / documents）',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            default: 50,
            description: '列表模式的返回条数；超限会被夹到 200，不会一次撑爆模型上下文',
          },
          phase: {
            type: 'string',
            enum: ['todo', 'queued', 'planning', 'confirm', 'implement', 'review', 'reviewing', 'done', 'failed', 'closed'],
          },
        },
        additionalProperties: true,
      };
    case 'create_todo':
      return {
        type: 'object',
        required: ['teamId', 'projectId', 'title'],
        properties: {
          teamId: { type: 'string' },
          projectId: { type: 'string' },
          title: { type: 'string', minLength: 1, maxLength: 280 },
          ownerMemberId: {
            type: 'string',
            description: '省略时默认 key 所有者在该团队的 member',
          },
          agentId: { type: ['string', 'null'] },
          spec: { type: ['string', 'null'], maxLength: SPEC_MAX_CHARS },
          tagIds: { type: 'array', items: { type: 'string' } },
          planFirst: { type: 'boolean', default: true },
          separatePlanBuild: { type: 'boolean', default: false },
          withChecklist: { type: 'boolean', default: false },
        },
        additionalProperties: true,
      };
    case 'update_todo':
      return {
        type: 'object',
        required: ['todoId'],
        properties: {
          todoId: { type: 'string' },
          title: { type: 'string', minLength: 1, maxLength: 280 },
          spec: { type: ['string', 'null'], maxLength: SPEC_MAX_CHARS },
          tagIds: { type: 'array', items: { type: 'string' } },
        },
        // phase 故意不列 —— 它只能走闸门工具，传了会被明确拒绝（见 update_todo case）
        additionalProperties: true,
      };
    case 'complete_todos':
    case 'close_todos':
    case 'reopen_todos':
      return {
        type: 'object',
        required: ['todoIds'],
        properties: {
          todoIds: { type: 'array', items: { type: 'string' } },
          merge: { type: 'boolean' },
        },
        additionalProperties: true,
      };
    case 'schedule_todo':
      return {
        type: 'object',
        required: ['teamId', 'todoId', 'kind', 'cron', 'timezone'],
        properties: {
          teamId: { type: 'string' },
          todoId: { type: 'string' },
          kind: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'once'] },
          // hourly: "0"-"59"（整数）；daily/weekly: "HH:MM"；once: ISO 时间戳
          cron: { type: 'string', maxLength: 120 },
          timezone: { type: 'string', maxLength: 80 },
          weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0=周日 … 6=周六；仅 weekly 必填' },
          agentId: { type: ['string', 'null'] },
          machineId: { type: ['string', 'null'], description: '钉死后触发不再需要 online machine' },
          automatic: { type: 'boolean', default: true },
        },
        additionalProperties: true,
      };
    case 'unschedule_todo':
      return {
        type: 'object',
        required: ['teamId', 'scheduleId'],
        properties: {
          teamId: { type: 'string' },
          scheduleId: { type: 'string' },
        },
        additionalProperties: true,
      };
    case 'conversation':
      return {
        type: 'object',
        required: ['buildId'],
        properties: {
          // conversation id 就是 build id（分支名 `tds/conv-<buildId>` 同源）
          buildId: { type: 'string' },
          sinceSeq: { type: 'integer', minimum: 0, description: '增量游标：只回 seq 更大的消息' },
        },
        additionalProperties: true,
      };
    case 'run_builds':
    case 'cancel_builds':
    case 'confirm_builds':
    case 'merge_builds':
    case 'run_review':
      return {
        type: 'object',
        required: ['todoIds'],
        properties: {
          // 五个都不收 teamId —— 归属由 todo 反查（builds.projectId → projects.teamId）
          todoIds: { type: 'array', items: { type: 'string' } },
          by: { type: 'string', enum: ['user', 'chief'], default: 'user', description: '仅 confirm_builds：谁按的闸门主按钮' },
          merge: { type: 'boolean', default: false, description: '仅 merge_builds：勾了就把结果合进主分支（落回 implement 跑 merge turn）' },
        },
        additionalProperties: true,
      };
    case 'message_todo':
      return {
        type: 'object',
        required: ['todoId', 'message'],
        properties: {
          todoId: { type: 'string' },
          message: {
            type: 'string',
            minLength: 1,
            maxLength: 8000,
            description:
              '发给 todo 的一条消息 = 闸门上的一次修订反馈。只在 confirm / review 闸门有效，' +
              '**不会推进相位** —— agent 跑一轮修订后停在同一个闸门。打 "confirm" 这种词也一样。',
          },
          // 不收 teamId —— 归属由 todo 反查
        },
        additionalProperties: true,
      };
    case 'attachment':
      return {
        type: 'object',
        required: ['buildId'],
        properties: {
          // 附件挂在消息上、消息属于 build —— 用 buildId 而不是 todoId
          buildId: { type: 'string' },
        },
        additionalProperties: true,
      };
    case 'issues':
    case 'pull_requests':
    case 'workflow_runs':
      return {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: '必须是 repoKind=github 且已绑 token 的项目' },
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            default: 'open',
            description: '仅 issues / pull_requests 生效',
          },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        },
        // 不收 teamId —— 归属由 project 反查
        additionalProperties: true,
      };
    case 'secrets':
      return {
        type: 'object',
        properties: {
          teamId: { type: 'string' },
          projectId: { type: 'string', description: '给了只看该项目级 secret；不给则含 team 级 + 全部 project 级' },
        },
        additionalProperties: true,
      };
    case 'set_secret':
      return {
        type: 'object',
        required: ['name', 'value'],
        properties: {
          name: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', description: '大写字母 / 数字 / 下划线；作为环境变量名注入子进程' },
          // 明文：立刻 seal 成密文落库，回包只含摘要，之后谁都看不到明文
          value: { type: 'string' },
          teamId: { type: 'string' },
          projectId: { type: 'string', description: '不给则 team 级；给了则该项目专属，覆盖同名 team 级' },
          overwrite: { type: 'boolean', default: false, description: '同名已存在时必须显式 true 才替换，否则 409' },
        },
        additionalProperties: true,
      };
    case 'delete_secrets':
      return {
        type: 'object',
        required: ['names'],
        properties: {
          names: { type: 'array', items: { type: 'string' } },
          teamId: { type: 'string' },
          projectId: { type: 'string' },
        },
        additionalProperties: true,
      };
    case 'mcp_servers':
      return {
        type: 'object',
        properties: { teamId: { type: 'string' } },
        additionalProperties: true,
      };
    case 'add_mcp_server':
      return {
        type: 'object',
        required: ['identifier', 'kind', 'transport'],
        properties: {
          identifier: { type: 'string', description: '连接的唯一标识，建立后不可改' },
          kind: { type: 'string', description: '连接类型，建立后不可改（如 github / linear / notion）' },
          transport: { type: 'string', description: '传输方式，建立后不可改（如 http / sse / stdio）' },
          name: { type: 'string' },
          teamId: { type: 'string' },
          projectId: { type: 'string' },
          // 凭据值：只进 seal，连接上只回 configKeys（键名），永不回值
          config: { type: 'object', additionalProperties: { type: 'string' } },
        },
        additionalProperties: true,
      };
    case 'update_mcp_server':
      return {
        type: 'object',
        required: ['identifier'],
        properties: {
          identifier: { type: 'string' },
          name: { type: 'string' },
          teamId: { type: 'string' },
          projectId: { type: 'string' },
          // 只覆盖传了的键，不是整份替换
          config: { type: 'object', additionalProperties: { type: 'string' } },
          // identifier / kind / transport 故意不列 —— 传了会被明确拒绝
        },
        additionalProperties: true,
      };
    case 'delete_mcp_servers':
      return {
        type: 'object',
        required: ['identifiers'],
        properties: {
          identifiers: { type: 'array', items: { type: 'string' } },
          teamId: { type: 'string' },
          projectId: { type: 'string' },
        },
        additionalProperties: true,
      };
    case 'projects':
    case 'agents':
    case 'machines':
    case 'skills':
    case 'schedules':
      return {
        type: 'object',
        properties: { teamId: { type: 'string' } },
        additionalProperties: true,
      };
    default:
      return { type: 'object', additionalProperties: true };
  }
}

/** MCP 的 31 个工具（read 13 + write 18），顺序即 `tools/list` 的返回顺序。 */
export const MCP_TOOLS: McpToolSpec[] = TABLE.map(({ name, group }) => ({
  name,
  group,
  label: chiefToolSpec(name)?.summary ?? name,
  description: chiefToolSpec(name)?.summary ?? name,
  inputSchema: inputSchemaFor(name),
}));

/** 13 + 18 = 31；与 recon §8 的实测数量对齐。 */
export const MCP_TOOL_COUNT: number = MCP_TOOLS.length;

const BY_NAME: Map<string, McpToolSpec> = new Map(MCP_TOOLS.map((t) => [t.name, t]));

/** MCP 面上是否有这个工具 —— `tools/call` 的「存在性」判断用它。 */
export function mcpToolSpec(name: string): McpToolSpec | undefined {
  return BY_NAME.get(name);
}

/** 全部 31 个名字（`GET /api/user/mcp-tools` 与测试拿全授权集合用）。 */
export function mcpToolNames(): string[] {
  return MCP_TOOLS.map((t) => t.name);
}

/** 按 read / write 分组的名字集合（勾选 UI 的分组标题用）。 */
export function mcpToolNamesByGroup(): Record<McpToolGroup, string[]> {
  return {
    read: MCP_TOOLS.filter((t) => t.group === 'read').map((t) => t.name),
    write: MCP_TOOLS.filter((t) => t.group === 'write').map((t) => t.name),
  };
}
