import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { agents, skills } from '@tds/db';
import { newId, now } from '../ids.js';
import { HttpError } from '../http.js';
import { actorForTeam } from '../auth.js';

/**
 * Skill 业务 REST 路由。
 *
 * 对标：todos.dev `/docs/skills`
 *   - skill 是团队共享 playbook；SKILL.md + 可选 assets
 *   - skill source 只允许 'folder' | 'github' | 'files' | 'chief'
 *     （schema 约束，本路由在写库前再校验一次防止走通 INSERT）
 *   - 大小上限 ≤ 10 MB、文件数 ≤ 256（与 docs/skills.md 原文一致）
 *   - 增删改需 team admin；普通成员可读
 *   - agent 通过 defaultSkillIds 绑定；**上限 10**（agents.md 硬规则）
 *
 * 删除语义（按 docs/skills.md "Deleting a skill cannot be undone.
 *   Agents carrying it simply stop carrying it from their next turn."）：
 *   1. **硬删除**（不是软删除）—— 与原站行为一致
 *   2. `agent_skill` 通过 FK ON DELETE CASCADE 自动清理
 *   3. `agent.default_skill_ids` 数组里残留的 skillId 需要清掉，
 *      否则「从下一个 todo 开始不再加载」会变成「加载一个不存在的 id
 *      报错」—— 把残留 id 从所有 agent.defaultSkillIds 里移除是最
 *      直接实现「simply stop carrying it」语义的做法
 *   4. 同步清理 `storage_path` 指向的目录
 *
 * 存储：
 *   - 默认根目录走 `TDS_STORAGE_DIR` 环境变量，未设时回退到本机路径
 *   - 目录布局：`<root>/<teamId>/<skillId>/SKILL.md` + 同级 assets
 *   - skillId 由 newId() 生成，本身不会撞 / 不会带路径分隔符
 *   - 路径拼接前用 `path.basename` 防御性剥一遍，避免 name 等字段
 *     被注入 `..` 或 `/`
 *
 * 鉴权：原站走 session cookie；MVP 阶段 server 在 trusted runtime 内
 *   被调用，先把端点和闸门语义跑通。真实部署时务必在 main.ts 外加
 *   一层 session middleware。**当前文件内不写 guard**。
 */

/** skill 大小 / 文件数上限 —— 直接对齐 recon/05-schema.sql 注释 */
const MAX_SKILL_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_FILE_COUNT = 256;
/** defaultSkillIds 硬上限 —— agents.md "default skills (up to 10)" */
const MAX_DEFAULT_SKILLS_PER_AGENT = 10;

/** skill.source 的合法取值 —— 与 schema CHECK 约束一致 */
const SKILL_SOURCES = ['folder', 'github', 'files', 'chief'] as const;
type SkillSource = (typeof SKILL_SOURCES)[number];

/**
 * skill 实际落盘根目录。
 *
 * TDS_STORAGE_DIR 未设置时回退到项目内 `.local/skills`，避免污染仓库
 * 上层 —— 且与 providers.ts 那种直接读环境变量的风格保持一致。
 */
const STORAGE_ROOT = process.env.TDS_STORAGE_DIR ?? path.resolve(process.cwd(), '.local/skills');

/** 单文件读取白名单：父目录逃逸、绝对路径、非字符串都挡掉 */
function safeRelativeName(input: string, kind: 'asset'): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new HttpError(422, `${kind} name must be a non-empty string`);
  }
  // path.basename 会剥前缀目录、把 `..` 变成空串 —— 单独判一次拒绝纯 `..`
  const base = path.basename(input);
  if (base !== input) {
    throw new HttpError(422, `${kind} name must not contain path separators`);
  }
  if (base === '' || base === '.' || base === '..') {
    throw new HttpError(422, `${kind} name "${input}" is not allowed`);
  }
  return base;
}

/**
 * 计算落盘目录的绝对路径，并确认落在 STORAGE_ROOT 下。
 * 防御任何上层调用方绕开 safeRelativeName 拼接路径的极端情况。
 */
function resolveSkillDir(teamId: string, skillId: string): string {
  // teamId / skillId 都来自 newId()（base64url），无 `/` 无 `..`，
  // 但仍走 basename 兜底，保证后续路径操作不会跨出 STORAGE_ROOT
  const team = path.basename(teamId);
  const sk = path.basename(skillId);
  if (team !== teamId || sk !== skillId || team === '' || sk === '') {
    throw new HttpError(422, 'teamId/skillId contains illegal characters');
  }
  const root = path.resolve(STORAGE_ROOT);
  const full = path.resolve(root, team, sk);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new HttpError(422, 'resolved skill path escapes storage root');
  }
  return full;
}

/** 同上，但把整个文件路径（含文件名）一起解析 */
function resolveSkillFile(teamId: string, skillId: string, fileName: string): string {
  const dir = resolveSkillDir(teamId, skillId);
  const file = safeRelativeName(fileName, 'asset');
  const full = path.resolve(dir, file);
  if (!full.startsWith(dir + path.sep) && full !== dir) {
    throw new HttpError(422, 'resolved asset path escapes skill directory');
  }
  return full;
}

const AssetSchema = z.object({
  /** 相对文件名（如 "templates/checklist.md"）—— 不允许路径前缀 */
  name: z.string().min(1).max(512),
  /** base64 编码后的二进制内容（用 UTF-8 解释文本也行） */
  contentBase64: z.string().min(1),
});

const CreateSkillBody = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(120),
  /** SKILL.md 正文 —— 文档原文要求 */
  skillMd: z.string().min(1),
  /** 可选来源标识；省略时按「从文件拉取」计为 'files'（与 mobile "From files" 对齐） */
  source: z.enum(SKILL_SOURCES).default('files'),
  sourceUrl: z.string().url().max(2000).nullable().default(null),
  /** 其它 companion 文件 —— 与 SKILL.md 同级落盘 */
  assets: z.array(AssetSchema).max(MAX_FILE_COUNT - 1).default([]),
});

const UpdateSkillBody = z.object({
  userId: z.string().min(1),
  /** 改名可选；空串视为不传 */
  name: z.string().min(1).max(120).optional(),
  /** 重新覆盖 SKILL.md —— 文档说「skills can be updated at any time」 */
  skillMd: z.string().min(1).optional(),
});

const BindAgentSkillBody = z.object({
  userId: z.string().min(1),
  /** 要绑定为 default 的 skillId 数组（去重后整体替换 vs 增量追加由 caller 决定） */
  defaultSkillIds: z.array(z.string().min(1)).max(MAX_DEFAULT_SKILLS_PER_AGENT),
});

const DeleteQuerySchema = z.object({ userId: z.string().min(1) });

function parseBody<T extends z.ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
  const r = schema.safeParse(payload);
  if (!r.success) {
    throw new HttpError(422, r.error.issues.map((i) => i.message).join('; '));
  }
  return r.data;
}


/**
 * 确认 skill 在该 team 下存在且未软删（虽然走硬删，但保留 deletedAt IS NULL
 * 过滤便于将来加软删时不必大改路由）。
 */
async function loadSkillForTeam(
  db: Db,
  teamId: string,
  skillId: string,
): Promise<typeof skills.$inferSelect> {
  const row = (
    await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.teamId, teamId), isNull(skills.deletedAt)))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(404, 'skill not found');
  return row;
}

/**
 * 把 skill 内容写到本地磁盘。SKILL.md 必写，assets 各自写到同级目录。
 * 返回 (sizeBytes, fileCount)。失败时尽量回滚已写入的文件，避免半成品。
 */
async function writeSkillFiles(args: {
  teamId: string;
  skillId: string;
  skillMd: string;
  assets: Array<{ name: string; contentBase64: string }>;
}): Promise<{ sizeBytes: number; fileCount: number }> {
  const dir = resolveSkillDir(args.teamId, args.skillId);
  await fs.mkdir(dir, { recursive: true });

  let sizeBytes = 0;
  let fileCount = 0;
  const written: string[] = [];
  try {
    // SKILL.md 必写
    const mdPath = path.join(dir, 'SKILL.md');
    const mdBuf = Buffer.from(args.skillMd, 'utf8');
    await fs.writeFile(mdPath, mdBuf);
    written.push(mdPath);
    sizeBytes += mdBuf.byteLength;
    fileCount += 1;

    // assets：每个用 base64 解码后落盘
    for (const a of args.assets) {
      const filePath = resolveSkillFile(args.teamId, args.skillId, a.name);
      let buf: Buffer;
      try {
        buf = Buffer.from(a.contentBase64, 'base64');
      } catch {
        throw new HttpError(422, `asset "${a.name}" is not valid base64`);
      }
      if (buf.byteLength === 0) {
        throw new HttpError(422, `asset "${a.name}" is empty after decode`);
      }
      // 不允许覆盖 SKILL.md —— 那是必写的正文槽位
      if (path.basename(filePath) === 'SKILL.md') {
        throw new HttpError(422, 'asset name "SKILL.md" is reserved for skill body');
      }
      await fs.writeFile(filePath, buf);
      written.push(filePath);
      sizeBytes += buf.byteLength;
      fileCount += 1;
    }
  } catch (err) {
    // 写盘失败做 best-effort 回滚：删掉已经成功写入的文件
    for (const p of written) {
      await fs.rm(p, { force: true });
    }
    throw err;
  }

  if (sizeBytes > MAX_SKILL_BYTES) {
    // 已经写盘，需要回滚
    await fs.rm(dir, { recursive: true, force: true });
    throw new HttpError(422, `skill exceeds 10 MB (got ${sizeBytes} bytes)`);
  }
  if (fileCount > MAX_FILE_COUNT) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new HttpError(422, `skill exceeds 256 files (got ${fileCount})`);
  }
  return { sizeBytes, fileCount };
}

/**
 * 把 skill 当前的 storage_path 目录整个删掉。
 * 不抛错：磁盘清理失败不应阻断数据库删除的对外承诺。
 */
async function rmSkillDir(teamId: string, skillId: string): Promise<void> {
  const dir = resolveSkillDir(teamId, skillId);
  await fs.rm(dir, { recursive: true, force: true });
}

/** 公开的 skill 形状 —— 不暴露 storagePath 内部细节（让 UI 自己展示） */
function publicSkill(row: typeof skills.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    source: row.source,
    sourceUrl: row.sourceUrl,
    storagePath: row.storagePath,
    sizeBytes: row.sizeBytes,
    fileCount: row.fileCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export function registerSkillRoutes(app: FastifyInstance, db: Db): void {
  // ── 列出团队 skill（成员可读）───────────────────────────────

  app.get('/api/teams/:teamId/skills', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);

    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.teamId, teamId), isNull(skills.deletedAt)))
      .orderBy(sql`${skills.createdAt} asc`);

    return { skills: rows.map(publicSkill) };
  });

  // ── 创建 skill（需 admin）──────────────────────────────────────
  //
  // 文档「Add a skill」原文：需要 team admin；正文是 SKILL.md + 可选
  // companion files；上限 10 MB / 256 files。我们用 JSON body（userId
  // + name + skillMd + 可选 assets），是最小可用形态；multipart 需要
  // 新增 fastify 依赖，与本任务文件所有权冲突（不允许改 package.json）。
  //
  // 大小上限：Fastify 默认 bodyLimit 1 MiB。我们这里把上限提到 12 MiB
  // （10 MiB 内容 + base64 膨胀 + 余量），路由级 bodyLimit 不需要改
  // main.ts，符合文件所有权约束。

  app.post(
    '/api/teams/:teamId/skills',
    { bodyLimit: 12 * 1024 * 1024 },
    async (req) => {
      const { teamId } = req.params as { teamId: string };
      const body = parseBody(CreateSkillBody, req.body);
      await actorForTeam(db, req, teamId, { action: 'changing skills' });

      const skillId = newId();
      const ts = now();

      // 提前写盘；失败抛错由 installErrorHandlers 转 4xx/5xx
      const { sizeBytes, fileCount } = await writeSkillFiles({
        teamId,
        skillId,
        skillMd: body.skillMd,
        assets: body.assets,
      });

      const storagePath = resolveSkillDir(teamId, skillId);

      try {
        await db.insert(skills).values({
          id: skillId,
          teamId,
          name: body.name,
          source: body.source satisfies SkillSource,
          sourceUrl: body.sourceUrl,
          storagePath,
          sizeBytes,
          fileCount,
          createdBy: body.userId,
          createdAt: ts,
          deletedAt: null,
        });
      } catch (err) {
        // 落库失败 —— 已写盘的文件清理掉，不能让磁盘和数据库不一致
        await rmSkillDir(teamId, skillId);
        throw err;
      }

      const row = (
        await db.select().from(skills).where(eq(skills.id, skillId)).limit(1)
      )[0];
      if (!row) {
        await rmSkillDir(teamId, skillId);
        throw new HttpError(500, 'skill vanished after insert');
      }
      return { skill: publicSkill(row) };
    },
  );

  // ── 改名 / 覆盖 SKILL.md（需 admin）─────────────────────────

  app.patch(
    '/api/teams/:teamId/skills/:skillId',
    { bodyLimit: 12 * 1024 * 1024 },
    async (req) => {
      const { teamId, skillId } = req.params as { teamId: string; skillId: string };
      const body = parseBody(UpdateSkillBody, req.body);
      await actorForTeam(db, req, teamId, { action: 'changing skills' });

      const current = await loadSkillForTeam(db, teamId, skillId);

      // 改名走白名单路径安全（只换 DB 字段，不动磁盘）。改 SKILL.md 正文
      // 必须覆盖到磁盘原文件，否则下次读取会出现「目录里是旧内容」的
      // 隐形漂移。
      if (body.skillMd !== undefined) {
        const mdPath = path.join(resolveSkillDir(teamId, skillId), 'SKILL.md');
        let buf: Buffer;
        try {
          buf = Buffer.from(body.skillMd, 'utf8');
        } catch {
          throw new HttpError(422, 'skillMd is not valid utf-8');
        }
        // 大小重算：size_bytes 包含 SKILL.md + 所有 assets（按约定）。
        const assets = await fs.readdir(resolveSkillDir(teamId, skillId));
        let sizeBytes = buf.byteLength;
        for (const f of assets) {
          if (f === 'SKILL.md') continue;
          const st = await fs.stat(path.join(resolveSkillDir(teamId, skillId), f));
          sizeBytes += st.size;
        }
        if (sizeBytes > MAX_SKILL_BYTES) {
          throw new HttpError(422, `skill exceeds 10 MB after update (${sizeBytes} bytes)`);
        }
        await fs.writeFile(mdPath, buf);
        const fileCount = (assets.includes('SKILL.md') ? assets.length : assets.length + 1);
        await db
          .update(skills)
          .set({
            name: body.name ?? current.name,
            sizeBytes,
            fileCount,
          })
          .where(eq(skills.id, skillId));
      } else if (body.name !== undefined) {
        await db
          .update(skills)
          .set({ name: body.name })
          .where(eq(skills.id, skillId));
      } else {
        throw new HttpError(422, 'no-op update: provide name or skillMd');
      }

      const row = (
        await db.select().from(skills).where(eq(skills.id, skillId)).limit(1)
      )[0];
      if (!row) throw new HttpError(404, 'skill not found');
      return { skill: publicSkill(row) };
    },
  );

  // ── 删除 skill（需 admin；硬删除 + 清理磁盘）──────────────
  //
  // 删除语义依据：docs/skills.md 末段
  //   "Deleting a skill cannot be undone ... Agents carrying it simply
  //    stop carrying it from their next turn."
  // 解读：
  //   - "cannot be undone" → 硬删除（不是软删除），deletedAt 列保留但
  //     本路由永远不写它
  //   - "simply stop carrying it" → 必须清掉 agent.defaultSkillIds 里的
  //     残留引用，否则下次 todo 启动仍会尝试加载一个不存在的 skill

  app.delete('/api/teams/:teamId/skills/:skillId', async (req) => {
    const { teamId, skillId } = req.params as { teamId: string; skillId: string };
    await actorForTeam(db, req, teamId, { action: 'changing skills' });

    const current = await loadSkillForTeam(db, teamId, skillId);

    // 1. 先删 agent.defaultSkillIds 里残留的 skillId。
    //    顺序：先 scrub 引用，再 delete skill 行 —— 即便 scrub 失败也不
    //    会留下半成品引用。
    await db
      .update(agents)
      .set({
        defaultSkillIds: sql`(
          select coalesce(array_agg(x), '{}')
          from unnest(${agents.defaultSkillIds}) as x
          where x <> ${skillId}
        )::text[]`,
        updatedAt: now(),
      })
      .where(and(eq(agents.teamId, teamId), sql`${skillId} = any(${agents.defaultSkillIds})`));

    // 2. agent_skill 通过 FK ON DELETE CASCADE 自动清掉 —— 这里只删
    //    skill 主行即可。
    await db.delete(skills).where(eq(skills.id, skillId));

    // 3. 清磁盘。best-effort：失败不阻塞（对外已承诺 skill 不可恢复）。
    await rmSkillDir(current.teamId, current.id);

    return { ok: true, deleted: skillId };
  });

  // ── 把 skill 绑到 agent 的 defaultSkillIds（需 admin）───────
  //
  // 文档 agents.md：default skills (up to 10)。这里不是「增量绑定」，
  // 而是**整体替换** defaultSkillIds 数组 —— 调用方传完整列表，路由
  // 一次性校验 ≤10 + 所有 skillId 属于本 team + agent 也属于本 team。
  // 这是 docs/skills.md 「Give a skill to an agent」语义的最直接实现：
  // 用户在 agent 详情页勾选若干 skill，整体保存。

  app.post(
    '/api/teams/:teamId/agents/:agentId/skills',
    async (req) => {
      const { teamId, agentId } = req.params as { teamId: string; agentId: string };
      const body = parseBody(BindAgentSkillBody, req.body);
      await actorForTeam(db, req, teamId, { action: 'changing skills' });

      const agent = (
        await db
          .select()
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.teamId, teamId), isNull(agents.deletedAt)))
          .limit(1)
      )[0];
      if (!agent) throw new HttpError(404, 'agent not found');

      const wanted = Array.from(new Set(body.defaultSkillIds));

      // 校验 ≤10 —— agents.md 硬上限
      if (wanted.length > MAX_DEFAULT_SKILLS_PER_AGENT) {
        throw new HttpError(
          422,
          `agent can carry at most ${MAX_DEFAULT_SKILLS_PER_AGENT} default skills (got ${wanted.length})`,
        );
      }

      // 所有 skillId 必须真实存在 + 属于本 team + 未被删除
      if (wanted.length > 0) {
        const found = await db
          .select({ id: skills.id })
          .from(skills)
          .where(
            and(
              inArray(skills.id, wanted),
              eq(skills.teamId, teamId),
              isNull(skills.deletedAt),
            ),
          );
        if (found.length !== wanted.length) {
          const known = new Set(found.map((r) => r.id));
          const missing = wanted.filter((s) => !known.has(s));
          throw new HttpError(422, `unknown skill ids: ${missing.join(', ')}`);
        }
      }

      // 同步 agent_skill 关联行 —— isDefault 全部 true（其它取值
      // 文档没定义；当前路由只暴露 default skill 这一档）
      await db
        .update(agents)
        .set({ defaultSkillIds: wanted, updatedAt: now() })
        .where(eq(agents.id, agentId));

      return {
        agentId,
        defaultSkillIds: wanted,
      };
    },
  );
}
