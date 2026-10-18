/**
 * 17 个 agent runtime 的规范注册表。
 *
 * 来源：从 @todos-dev/cli@0.1.66 bundle 的运行时缺失提示文案反解
 * （recon/01-runtimes.md，每条都是 bundle 里的一等字符串，非推测）。
 *
 * 复刻策略见 recon/04-stack.md §4：**只实现前 3 个**。
 * 理由不是偷懒 —— 原站的 17 个适配器跨 5 种驱动协议（SDK/ACP/app-server/
 * stream-json/RPC），全量支持成本极高且每家的原生协议都已是一层薄 adapter。
 * MVP 先跑通 Claude Code（官方 SDK，最稳）。
 */

export interface RuntimeSpec {
  /** 规范 id，用于 API / DB / 协议 */
  id: string;
  /** UI 显示名 */
  label: string;
  /**
   * 覆盖二进制路径的环境变量。
   * 内置 runtime（pi）不 spawn 二进制 —— 这两个字段为 null。
   */
  binEnv: string | null;
  /** 默认二进制名（PATH 查找）；内置 runtime 为 null */
  defaultBin: string | null;
  /** 驱动协议 —— 决定 adapter 的实现方式 */
  driver:
    | 'pi'          // 内置 SDK（不 spawn，模型来自团队 provider）
    | 'sdk'          // 官方 SDK（Claude Code）
    | 'app-server'   // JSON-RPC over stdio（Codex）
    | 'acp'          // Agent Client Protocol
    | 'stream-json'  // NDJSON 流（Cursor / Qoder）
    | 'rpc'          // 行式 JSON-RPC（omp）
  /** 覆盖 env 即可指定非标准路径的二进制 */
  installHint: string | null;
  /** MVP 是否实现 */
  mvp: boolean;
}

export const RUNTIMES: readonly RuntimeSpec[] = [
  // ── 内置 runtime（原站默认）────────────────────────────────
  {
    id: 'pi',
    label: 'pi（内置）',
    binEnv: null,
    defaultBin: null,
    driver: 'pi',
    installHint: null,
    mvp: true,
  },

  // ── 外部 runtime ─────────────────────────────────────────
  {
    id: 'claude-code',
    label: 'Claude Code',
    binEnv: 'TDS_CLAUDE_CODE_BIN',
    defaultBin: 'claude',
    driver: 'sdk',
    installHint: 'https://claude.com/claude-code',
    mvp: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    binEnv: 'TDS_CODEX_BIN',
    defaultBin: 'codex',
    driver: 'app-server',
    installHint: 'npm i -g @openai/codex',
    mvp: true,
  },
  {
    id: 'omp',
    label: 'omp',
    binEnv: 'TDS_OMP_BIN',
    defaultBin: 'omp',
    driver: 'rpc',
    installHint: 'curl -fsSL https://omp.sh/install | sh',
    mvp: true,
  },

  // ── 后续批次 ──────────────────────────────────────────────
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    binEnv: 'TDS_GEMINI_CLI_BIN',
    defaultBin: 'gemini',
    driver: 'acp',
    installHint: 'npm install -g @google/gemini-cli',
    mvp: false,
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    binEnv: 'TDS_CURSOR_BIN',
    defaultBin: 'cursor-agent',
    driver: 'stream-json',
    installHint: 'curl https://cursor.com/install -fsS | bash',
    mvp: false,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    binEnv: 'TDS_OPENCODE_BIN',
    defaultBin: 'opencode',
    driver: 'acp',
    installHint: 'curl -fsSL https://opencode.ai/install | bash',
    mvp: false,
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    binEnv: 'TDS_QWEN_CODE_BIN',
    defaultBin: 'qwen',
    driver: 'acp',
    installHint: 'npm install -g @qwen-code/qwen-code',
    mvp: false,
  },
  {
    id: 'droid',
    label: 'Droid CLI',
    binEnv: 'TDS_DROID_BIN',
    defaultBin: 'droid',
    driver: 'stream-json',
    installHint: 'curl -fsSL https://app.factory.ai/cli | sh',
    mvp: false,
  },
  {
    id: 'cline',
    label: 'Cline CLI',
    binEnv: 'TDS_CLINE_BIN',
    defaultBin: 'cline',
    driver: 'acp',
    installHint: 'npm install -g cline',
    mvp: false,
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    binEnv: 'TDS_DSH_BIN',
    defaultBin: 'dsh',
    driver: 'acp',
    installHint: 'npm install -g @deepseek-ai/dsh',
    mvp: false,
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    binEnv: 'TDS_HERMES_BIN',
    defaultBin: 'hermes',
    driver: 'acp',
    installHint: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    mvp: false,
  },
  {
    id: 'grok-build',
    label: 'Grok Build',
    binEnv: 'TDS_GROK_BUILD_BIN',
    defaultBin: 'grok',
    driver: 'acp',
    installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    mvp: false,
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    binEnv: 'TDS_COPILOT_BIN',
    defaultBin: 'copilot',
    driver: 'stream-json',
    installHint: 'npm i -g @github/copilot',
    mvp: false,
  },
  {
    id: 'devin',
    label: 'Devin CLI',
    binEnv: 'TDS_DEVIN_BIN',
    defaultBin: 'devin',
    driver: 'acp',
    installHint: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    mvp: false,
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    binEnv: 'TDS_ANTIGRAVITY_BIN',
    defaultBin: 'agy',
    driver: 'stream-json',
    installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    mvp: false,
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    binEnv: 'TDS_QODER_BIN',
    defaultBin: 'qodercli',
    driver: 'stream-json',
    installHint: 'npm install -g @qoder-ai/qodercli',
    mvp: false,
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    binEnv: 'TDS_OPENCLAW_BIN',
    defaultBin: 'openclaw',
    driver: 'acp',
    installHint: 'openclaw gateway',
    mvp: false,
  },
] as const;

export const RUNTIME_IDS = RUNTIMES.map((r) => r.id);

export const MVP_RUNTIME_IDS = RUNTIMES.filter((r) => r.mvp).map((r) => r.id);

const BY_ID: Record<string, RuntimeSpec> = Object.fromEntries(
  RUNTIMES.map((r) => [r.id, r]),
);

export function runtimeSpec(id: string): RuntimeSpec | undefined {
  return BY_ID[id];
}

/**
 * 各 runtime 对 MCP 工具名的前缀改写。
 * 证据：bundle 里各 runtime 的 MCP bridge 会把 `mcp__tds__` 改成各家认的形式
 * （recon/02-cli-protocol.md §5.5）。omp 直接用纯名。
 */
const TOOL_PREFIX: Record<string, string> = {
  'claude-code': 'mcp__tds__',
  codex: 'mcp__tds__',
  omp: '',                     // omp 直接暴露纯名
  copilot: 'tds-',
  opencode: 'tds_',
  cline: 'tds__',
  hermes: 'mcp_tds_',
  droid: 'tds___',
};

export function toolPrefixFor(runtimeId: string): string {
  return TOOL_PREFIX[runtimeId] ?? 'mcp__tds__';
}

/** 平台内置工具名全集（bundle §5.5 服务端定义部分） */
export const PLATFORM_TOOLS = [
  'ask_user',
  'todos',
  'git',
  'web_search',
  'list_providers',
  'set_plan',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user_question',
  'read_secret',
  'update_todos',
  'cron_create',
  'cron_list',
  'cron_delete',
  'loop_wakeup',
  'monitor',
  'enter_worktree',
  'exit_worktree',
  'memory_search',
  'notify_user',
  'update_user',
  'list_users',
] as const;

/** CLI 本地实现的工具（bundle §5.5 本地定义部分） */
export const LOCAL_TOOLS = [
  'git',
  'push_branch',
  'remote_shell',
  'web_fetch',
  'create_skill',
  'update_skill',
] as const;
