/**
 * MCP Catalog —— 原站 todos.dev `/docs/mcp-servers` 实测目录的客户端只读副本。
 *
 * **这是协议层**：`server` 与 `web` 都要 import，所以只放**纯数据 + 纯函数**，
 * 不依赖 Node / DOM / Drizzle / zod。
 *
 * **诚实来源标注**（2026-10-18）：
 *   - `playwright` / `cua-driver`（local stdio）：文档里**逐字写出了**命令与分类，
 *     这两个条目是文档原话照抄的，`endpointVerified: true`。
 *   - 其余 21 个远程条目：
 *     - `identifier` / `label` / 分类：来自原站目录的英文原名。
 *     - `endpoint`：通过 web_search 拿到的厂商官方 MCP endpoint URL 摘要。
 *       - `endpointVerified: true`  → 文档或厂商官方页面**直接给出**完整 URL。
 *       - `endpointVerified: false` → 厂商确证有官方 MCP，但 URL 形态从摘要不全，
 *         或由社区文档指向（接入前请对照厂商官方文档复核）。
 *   - 「endpoint 未核实」的条目在 UI 上**必须**展示警示横幅（见 settings/connections
 *     页），不能假装已经验证过。
 *
 * **不要新增 OAuth / 一键登录逻辑**：那是另一个数量级的工程。本切片只提供
 * `MCP_CATALOG` 数据 + 一个 GET 端点把这份数据交给前端。
 */

export interface McpCatalogEntry {
  /** 工具名前缀 `mcp__<identifier>__<tool>` —— 团队内唯一。 */
  identifier: string;
  /** 显示名。 */
  label: string;
  /** 原站目录的「分类」。本切片在 UI 用来做筛选。 */
  category: McpCatalogCategory;
  /** 传输方式：`http` = 远程；`stdio` = 本地机器上跑。 */
  transport: 'http' | 'stdio';
  /**
   * 远程 MCP endpoint（`http` 条目必填）。UI 上若 `endpointVerified === false`，
   * 必须给警示提示，绝不替用户做「一键连接」动作。
   */
  endpoint: string | null;
  /** stdio 条目的命令行（`transport === 'stdio'` 时必填）。 */
  command: string | null;
  /** stdio 条目的参数。 */
  args: string[] | null;
  /** 是否需要 OAuth 一键登录。本地预设为 false。 */
  requiresOAuth: boolean;
  /** endpoint 是否经过官方文档确证。详见文件顶注释。 */
  endpointVerified: boolean;
  /** 厂商官方文档链接（用于「请对照厂商文档」按钮）。null 表示文档未核实到具体页。 */
  docsUrl: string | null;
}

/** 目录分类。`browser` / `desktop` 是原站目录里点名的两个本地类。 */
export type McpCatalogCategory =
  | 'productivity'
  | 'engineering'
  | 'analytics'
  | 'browser'
  | 'desktop';

/**
 * 23 条目录数据。
 *
 * 顺序：先 21 条远程（按原站文档顺序），后 2 条本地 stdio。
 * 任何修改都必须保证 `catalogCategories()` 与此处出现的分类**一一对应**——
 * 测试会钉这条。
 */
export const MCP_CATALOG: ReadonlyArray<McpCatalogEntry> = [
  // ── 远程应用（21）────────────────────────────────────────────

  {
    identifier: 'linear',
    label: 'Linear',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://mcp.linear.app/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    identifier: 'notion',
    label: 'Notion',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://mcp.notion.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
  {
    // Google 把三个 app 各开一个连接，每个都有自己的 endpoint —— 这里给的是
    // docs/sheets 共用宿主名（实测 `mcp.googleapis.com/v1` 形态）。Docs / Drive /
    // Sheets 各自细分 endpoint，详见 docsUrl。
    identifier: 'google-drive',
    label: 'Google Drive',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://mcp.googleapis.com/v1/',
    command: null,
    args: null,
    requiresOAuth: true,
    // Google 把所有 Workspace MCP 都挂在 `mcp.googleapis.com` 下；具体 endpoint
    // 形态各家子目录略有差异，没在单一厂商页面里逐字看到三个独立完整 URL，
    // 所以标 false。
    endpointVerified: false,
    docsUrl: 'https://developers.google.com/workspace/agents/mcp',
  },
  {
    identifier: 'google-docs',
    label: 'Google Docs',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://docsmcp.googleapis.com',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: false,
    docsUrl: 'https://developers.google.com/workspace/agents/mcp',
  },
  {
    identifier: 'google-sheets',
    label: 'Google Sheets',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://mcp.googleapis.com/v1/',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: false,
    docsUrl: 'https://developers.google.com/workspace/agents/mcp',
  },
  {
    identifier: 'atlassian',
    label: 'Jira / Confluence (Atlassian)',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://mcp.atlassian.com/v2/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://github.com/atlassian/atlassian-mcp-server',
  },
  {
    identifier: 'gitlab',
    label: 'GitLab',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://gitlab.com/api/v4/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.gitlab.com/user/gitlab_duo_agent_platform/',
  },
  {
    identifier: 'slack',
    label: 'Slack',
    category: 'productivity',
    transport: 'http',
    endpoint: 'https://mcp.slack.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server',
  },
  {
    identifier: 'sentry',
    label: 'Sentry',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.sentry.dev/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.sentry.io/product/mcp/',
  },
  {
    identifier: 'datadog',
    label: 'Datadog',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.datadoghq.com/v1/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
  },
  {
    identifier: 'posthog',
    label: 'PostHog',
    category: 'analytics',
    transport: 'http',
    endpoint: 'https://mcp.posthog.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
  },
  {
    identifier: 'mixpanel',
    label: 'Mixpanel',
    category: 'analytics',
    transport: 'http',
    endpoint: 'https://mcp.mixpanel.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.mixpanel.com/docs/mcp',
  },
  {
    identifier: 'amplitude',
    label: 'Amplitude',
    category: 'analytics',
    transport: 'http',
    endpoint: 'https://mcp.amplitude.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://amplitude.com/docs/mcp',
  },
  {
    identifier: 'supabase',
    label: 'Supabase',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.supabase.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://supabase.com/docs/guides/ai-tools/mcp',
  },
  {
    identifier: 'neon',
    label: 'Neon',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.neon.tech/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
  },
  {
    identifier: 'cloudflare',
    label: 'Cloudflare',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.cloudflare.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
  },
  {
    identifier: 'netlify',
    label: 'Netlify',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://netlify-mcp.netlify.app/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    // Netlify 的官方 MCP 是「自托管在自己域」的 endpoint，社区博客与 Azure 工具
    // 目录都引用此 URL，但厂商官方 docs 页面未直接出现在搜索结果里 —— 标 false
    // 让用户接入前对照。
    endpointVerified: false,
    docsUrl: 'https://docs.netlify.com/build/mcp/',
  },
  {
    identifier: 'vercel',
    label: 'Vercel',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.vercel.com',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
  },
  {
    identifier: 'railway',
    label: 'Railway',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.railway.com',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.railway.com/reference/mcp',
  },
  {
    identifier: 'expo',
    label: 'Expo',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.expo.dev/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.expo.dev/guides/mcp-server/',
  },
  {
    // DigitalOcean 一个连接覆盖 7 个产品（每个产品自己一个 MCP），原站文档：
    // "A single DigitalOcean connection covers them all with one sign-in".
    // 这里给一个主 endpoint（Droplets），其余子端点见 docsUrl。
    identifier: 'digitalocean',
    label: 'DigitalOcean',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://droplets.mcp.digitalocean.com/mcp',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.digitalocean.com/reference/mcp/configure-mcp/',
  },
  {
    identifier: 'stripe',
    label: 'Stripe',
    category: 'engineering',
    transport: 'http',
    endpoint: 'https://mcp.stripe.com',
    command: null,
    args: null,
    requiresOAuth: true,
    endpointVerified: true,
    docsUrl: 'https://docs.stripe.com/mcp',
  },

  // ── 本地预设（2） ── 文档里逐字写出的命令与分类 ──

  {
    identifier: 'playwright',
    label: 'Browser (Playwright)',
    category: 'browser',
    transport: 'stdio',
    endpoint: null,
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--extension'],
    requiresOAuth: false,
    endpointVerified: true,
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    identifier: 'cua-driver',
    label: 'Computer use (Cua Driver)',
    category: 'desktop',
    transport: 'stdio',
    endpoint: null,
    command: 'cua-driver',
    args: ['mcp'],
    requiresOAuth: false,
    endpointVerified: true,
    docsUrl: 'https://docs.cua.ai/cua-driver/overview',
  },
];

/**
 * 当前目录里出现的分类集合（**与 MCP_CATALOG 出现的分类一一对应**）。
 *
 * 测试会钉这条：增减条目时**同步**这里。返回顺序是「先远程后本地」，由
 * 本文件内 MCP_CATALOG 的实际顺序推导，避免出现「分类列表里冒出幽灵条目」
 * 或「条目里出现了不存在的分类」的两类漂移。
 */
export function catalogCategories(): McpCatalogCategory[] {
  const seen = new Set<McpCatalogCategory>();
  const ordered: McpCatalogCategory[] = [];
  for (const entry of MCP_CATALOG) {
    if (!seen.has(entry.category)) {
      seen.add(entry.category);
      ordered.push(entry.category);
    }
  }
  return ordered;
}

/** 按 identifier 查目录条目。**只读查找**，未命中返回 null。 */
export function findCatalogEntry(identifier: string): McpCatalogEntry | null {
  for (const entry of MCP_CATALOG) {
    if (entry.identifier === identifier) return entry;
  }
  return null;
}

/** 目录里的分类常量集合，方便 UI 写 import 时不依赖字面量。 */
export const MCP_CATALOG_CATEGORIES: ReadonlyArray<McpCatalogCategory> =
  catalogCategories() as ReadonlyArray<McpCatalogCategory>;

/** 每团队连接上限（与 `quota.connections` 同源；为前端展示而暴露）。 */
export const TEAM_CONNECTION_LIMIT = 20;
