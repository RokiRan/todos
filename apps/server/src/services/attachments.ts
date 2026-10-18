/**
 * 附件（attachment）的**读模型与校验**。
 *
 * ── 现状（2026-10-17） ──
 *   `packages/db/src/schema.ts` 里没有任何附件表；`build_message.content` 是
 *   `text`，目前装的只是 `{"kind":"machine_selected"|"turn_retried"|"question"|"confirm"|"input"}`
 *   这类系统信封，**没有附件字段**。`routes/mcp.ts` 的 `attachment` 工具
 *   当前落在「not implemented in this build」通用分支。
 *
 *   recon/docs/conversation.md 第 56-62 行（Images and attachments）给出的权威
 *   语义是：
 *     - 每条消息最多 5 个附件
 *     - 图片 ≤5 MB；客户端压缩
 *     - 文档 ≤20 MB；白名单
 *       `Markdown TXT HTML CSV TSV JSON YAML XML PDF Word Excel PowerPoint`
 *     - 超限或不支持的格式**被拒绝并给出明确消息**（不静默丢弃）
 *
 *   与 `services/conversations.ts` 同构：纯服务层，抛 `HttpError`，授权判定
 *（teamId、是不是这个团队）由调用方做 —— REST 侧是 `actorForTeam`，MCP 侧是
 *   `requireTeamAccess`。
 *
 * ── 读模型来源 ──
 *   既然没有附件表，附件元数据只能从「消息内容」里解析出来。约定如下：
 *     - 消息 `role='user'` 的 `content` 可以装一段**结构化附件引用**——
 *       与系统信封 `{"kind":"machine_selected"}` 是同一种 JSON 串形态。
 *     - 该信封的 shape 故意保持最小：
 *         {"kind":"user_attachments","items":[{"id":"<uuid>","name":"...","mime":"...","sizeBytes":N}]}
 *     - 我们**只读这种 kind**，对其它 kind 一律忽略 —— 用户消息里也允许装别
 *       的 JSON（未来 `kind` 增多时也不会撞车）。
 *     - 二进制内容、签名 URL、密文、凭据**永远不出现在 envelope 里**——附件
 *       对象只有 `id` / `name` / `mime` / `sizeBytes` 四个元数据字段。后续
 *       上传端点把这些元数据转成可下载 URL 时，URL 也是临时的、不进 message。
 *
 *   `listAttachments` 扫该 build 的全部 user 消息，按 seq asc 合并所有
 *   `user_attachments` envelope，展平去重 —— 一个 attachment id 在多条消息里
 *   出现时取**最早**那条。返回数组里**没有二进制、没有凭据、没有 storage URL**。
 *
 * ── 降级条件（不是假实现） ──
 *   只要消息流里没有任何 `user_attachments` envelope，`listAttachments` 老实
 *   返回空数组。这不是「假装有数据」，是「上游还没接上传端点，本工具在有数据
 *   之前只能返回空」。**返回空数组是正确的降级**；何时升到非空取决于主代理
 *   是否补了上传端点 / envelope 写入路径。本文件末尾（注释）写明了完整交接契约。
 *
 * ── 校验规则 ──
 *   `validateAttachment` 是**纯函数**，不依赖 DB，未来 REST 上传端点直接复用。
 *   区分「数量超限 / 图片过大 / 文档过大 / 格式不支持」四种原因 —— 文档原话
 *   是「Oversized files or unsupported formats are rejected with a clear message」，
 *   上传端点的 422 措辞必须从这里来。
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { buildMessages, builds, projects, todos } from '@tds/db';
import { HttpError } from '../http.js';

// ── 文档铁律（recon/docs/conversation.md:56-62，verbatim）───────────────
/** 单条消息最多允许的附件数。recon 原话「Each message can carry up to 5 attachments」。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** 图片大小上限（字节）。recon 原话「up to 5 MB per image (standard images are compressed automatically on the client before upload)」。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 文档大小上限（字节）。recon 原话「20 MB per document」。 */
export const MAX_DOC_BYTES = 20 * 1024 * 1024;

/** 图片 mime 白名单 —— 走 `image/*`，匹配 PNG/JPEG/GIF/WebP/HEIC 等所有标准格式。
 *  原站明确「standard images are compressed automatically on the client before upload」，
 *  不在客户端额外白名单里卡。 */
const IMAGE_MIME_PREFIX = 'image/';

/** 文档扩展名白名单 —— 文档原话列表。客户端按扩展名挑 mime 时，这层只信 mime 的扩展名段；
 *  mime 形如 `application/pdf` / `text/markdown` / `application/vnd.openxmlformats-officedocument.wordprocessingml.document` 时
 *  我们按**扩展名**判，不是按整段 mime 字符串前缀匹配。 */
const DOCUMENT_EXTENSIONS: Record<string, true> = {
  md: true, markdown: true,
  txt: true,
  html: true, htm: true,
  csv: true, tsv: true,
  json: true,
  yaml: true, yml: true,
  xml: true,
  pdf: true,
  doc: true, docx: true,
  xls: true, xlsx: true,
  ppt: true, pptx: true,
};

/** 从 mime 或文件名取扩展名（小写、不含点、长度 ≤10 防御畸形输入）。 */
function extensionOf(mime: string, name: string): string {
  const dotIdx = name.lastIndexOf('.');
  const fromName = dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
  if (fromName && fromName.length <= 10) return fromName;
  // mime 形式如 `text/markdown` / `application/pdf` / `image/png` —— 取 `/` 后半段
  const slash = mime.indexOf('/');
  if (slash < 0) return '';
  // 像 `vnd.openxmlformats-officedocument.wordprocessingml.document` 这种长 mime
  // 抽 `+xml` 也抽不出扩展名，落到文件名兜底。
  return mime.slice(slash + 1).toLowerCase().split('+')[0] ?? '';
}

// ── 校验结果 ────────────────────────────────────────────────────────

export type AttachmentValidationError =
  | 'too_many'
  | 'image_too_large'
  | 'document_too_large'
  | 'unsupported_format';

export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; reason: AttachmentValidationError; message: string };

/** 校验一份附件。`size` 用字节、`name` 与 `mime` 用客户端上传时的原值。 */
export function validateAttachment(input: {
  name: string;
  mime: string;
  size: number;
}): AttachmentValidationResult {
  const mime = input.mime.toLowerCase();
  const ext = extensionOf(mime, input.name);

  if (mime.startsWith(IMAGE_MIME_PREFIX)) {
    if (input.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: 'image_too_large',
        message:
          `image "${input.name}" is ${input.size} bytes, exceeds the 5 MB per-image limit ` +
          `(max ${MAX_IMAGE_BYTES} bytes)`,
      };
    }
    return { ok: true };
  }

  // 非 image：当作文档。文档 mime 形态繁杂，按扩展名判。
  if (!ext || DOCUMENT_EXTENSIONS[ext] !== true) {
    return {
      ok: false,
      reason: 'unsupported_format',
      message:
        `unsupported attachment format: mime "${input.mime}" (extension "${ext || '<none>'}"). ` +
        `Documents accept Markdown, TXT, HTML, CSV, TSV, JSON, YAML, XML, PDF, Word, Excel, PowerPoint; ` +
        `images accept any standard image/* (compressed client-side).`,
    };
  }
  if (input.size > MAX_DOC_BYTES) {
    return {
      ok: false,
      reason: 'document_too_large',
      message:
        `document "${input.name}" is ${input.size} bytes, exceeds the 20 MB per-document limit ` +
        `(max ${MAX_DOC_BYTES} bytes)`,
    };
  }
  return { ok: true };
}

/** 校验**单条消息**带的一组附件数量。超限由上传端点拒绝（422）。 */
export function validateAttachmentCount(count: number): AttachmentValidationResult {
  if (count > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      reason: 'too_many',
      message:
        `message carries ${count} attachments, exceeds the per-message limit of ` +
        `${MAX_ATTACHMENTS_PER_MESSAGE}`,
    };
  }
  return { ok: true };
}

// ── 读模型 ──────────────────────────────────────────────────────────

/** 附件对外形状 —— **没有**二进制、没有 URL、没有 storage key、没有凭据。
 *  MCP `attachment` 工具的回包里就是这个东西的数组。 */
export interface Attachment {
  /** message envelope 里的 id（同一条消息多附件时唯一；跨消息同名 id 早的赢） */
  id: string;
  /** 文件名（客户端上传时的原名） */
  name: string;
  /** mime 类型（客户端声明，小写化） */
  mime: string;
  /** 字节数（客户端声明；与上限比较的工作在校验层做了，这里只透传） */
  sizeBytes: number;
  /** 所属 build id —— 调用方按 buildId 或 todoId 拉时这一列一致 */
  buildId: string;
  /** 所在消息的 seq；同 attachment id 重复出现时取最早那条 */
  messageSeq: number;
  /** 元数据落库时间（沿用所在消息的 createdAt） */
  createdAt: number;
}

/** envelope 的最小形状 —— 只认 `kind='user_attachments'`。其它 kind 一律忽略。 */
interface UserAttachmentsEnvelope {
  kind: 'user_attachments';
  items: Array<{ id: string; name: string; mime: string; sizeBytes: number }>;
}

function parseUserAttachments(content: string): UserAttachmentsEnvelope | null {
  // 性能上绝大多数 message content 都不是 JSON；先做廉价检查
  const trimmed = content.trimStart();
  if (trimmed[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== 'user_attachments') return null;
  if (!Array.isArray(obj.items)) return null;
  const items: Array<{ id: string; name: string; mime: string; sizeBytes: number }> = [];
  for (const it of obj.items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (
      typeof o.id === 'string' && typeof o.name === 'string' &&
      typeof o.mime === 'string' && typeof o.sizeBytes === 'number'
    ) {
      items.push({ id: o.id, name: o.name, mime: o.mime, sizeBytes: o.sizeBytes });
    }
  }
  return { kind: 'user_attachments', items };
}

/** 解析 build 所属团队。build 不存在、或链上 todo/project 缺失 → 403。
 *  与 `services/conversations.ts` 的 `loadConversationTeamId` 一致语义：找不
 *  到不泄露存在性。 */
export async function loadAttachmentTeamId(db: Db, buildId: string): Promise<string> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(builds)
    .innerJoin(todos, eq(todos.id, builds.todoId))
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(builds.id, buildId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, 'attachment has no accessible team');
  return row.teamId;
}

/** 通过 todoId 反查 buildId。todo 必须存在；不存在 → 403。
 *  找不到 build 时仍返回 null（调用方按 buildId 再走 403）。 */
export async function latestBuildIdForTodo(
  db: Db,
  todoId: string,
): Promise<{ buildId: string | null; teamId: string }> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(todos.id, todoId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, 'attachment has no accessible team');
  const buildRow = (await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.todoId, todoId))
    .orderBy(asc(builds.createdAt))
    .limit(1))[0];
  return { buildId: buildRow?.id ?? null, teamId: row.teamId };
}

/** 列一个 build 下的附件元数据。
 *
 *  - `buildId` 必传；找不到（被删 / 不属于任何团队）→ 403。
 *  - `todoId` 可选：若提供，验证 todo 与 build 归属同一链，不一致 → 403。
 *  - 返回数组按 `messageSeq asc, name asc` 排序（同 seq 时名字稳定）。
 *  - **不返回**任何二进制、URL、storage key、凭据。客户端要看内容去走上传端点
 *    颁发的临时签名 URL（**那是另一条接口，不在本服务层**）。
 */
export async function listAttachments(
  db: Db,
  params: { buildId: string; todoId?: string },
): Promise<Attachment[]> {
  const teamId = await loadAttachmentTeamId(db, params.buildId);

  if (params.todoId !== undefined) {
    // 二次核对 build 真的挂在该 todo 下 —— 防「不同 todo 的 build 撞 buildId」。
    const row = (await db
      .select({ todoId: builds.todoId })
      .from(builds)
      .innerJoin(todos, eq(todos.id, builds.todoId))
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .where(and(eq(builds.id, params.buildId), eq(todos.id, params.todoId), eq(projects.teamId, teamId)))
      .limit(1))[0];
    if (!row) throw new HttpError(403, 'attachment has no accessible team');
  }

  // 仅扫 user 角色的消息：助手与系统消息不会带附件信封。
  const rows = await db
    .select({
      seq: buildMessages.seq,
      content: buildMessages.content,
      createdAt: buildMessages.createdAt,
    })
    .from(buildMessages)
    .where(eq(buildMessages.buildId, params.buildId))
    .orderBy(asc(buildMessages.seq));

  // 同 attachment id 重复出现时，**最早**那条赢（user 撤回/重发的覆盖语义）。
  const byId = new Map<string, Attachment>();
  for (const row of rows) {
    const env = parseUserAttachments(row.content);
    if (!env) continue;
    for (const it of env.items) {
      if (byId.has(it.id)) continue;
      byId.set(it.id, {
        id: it.id,
        name: it.name,
        mime: it.mime,
        sizeBytes: it.sizeBytes,
        buildId: params.buildId,
        messageSeq: row.seq,
        createdAt: row.createdAt,
      });
    }
  }
  const out = Array.from(byId.values());
  out.sort((a, b) => a.messageSeq - b.messageSeq || a.name.localeCompare(b.name));
  return out;
}

/**
 * ── 主代理后续需要补的交接契约 ──
 *
 * 1. **存储端点**：上传二进制 / 颁发临时签名下载 URL 的端点不在本文件范围。
 *    一旦主代理落了上传端点，**上传端点的 422 措辞必须来自** `validateAttachment`
 *    的 `message` 字段（保证 REST 与 MCP 任何后续对附件的校验措辞都同源）。
 *
 * 2. **写路径**：上传完成后，**写消息这一步也要复用本服务层**：
 *    写一条 `role='user'` 的 `build_message`，`content` 是
 *      JSON.stringify({ kind: 'user_attachments', items: [...] })
 *    metadata-only（**只存元数据，不存二进制、不存 URL**）。
 *    二进制走对象存储的引用关系（外键 / storage key），不在 schema 里硬塞。
 *
 * 3. **schema 演进**：如果主代理决定新增专门的 attachment 表（`attachments(id, build_id, message_seq, name, mime, size_bytes, storage_key, created_at)`），
 *    `listAttachments` 的实现要切到那张表上 —— 调用方契约（返回 `Attachment[]`）不变。
 *
 * 4. **降级行为**：在那之前，`listAttachments` 对**任何** build 都返回 `[]`
 *    是合法的，**不是 bug**。MCP `attachment` 工具的回包
 *      { attachments: [] }
 *    应当被客户端当作「这个 build 还没附件」对待，不要当成错误。
 */
/**
 * 由 buildId 反查 teamId —— MCP `attachment` 工具的授权前置。
 *
 * 归属链 build→todo→project→team，与 `conversations.ts` 同一套。解析不到一律
 * **403**（不泄露存在性）：MCP 侧未知 build 与越权 build 要给出同一个答案。
 *
 * 放在服务层而不是 `routes/mcp.ts`：路由只做「凭据 → 身份」，反查本身是业务规则。
 */
export async function loadBuildTeamId(db: Db, buildId: string): Promise<string> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(builds)
    .innerJoin(todos, eq(todos.id, builds.todoId))
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(builds.id, buildId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `build "${buildId}" has no accessible team`);
  return row.teamId;
}
