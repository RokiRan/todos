/**
 * 备份脚本 —— 把 `public` 模式下全部业务表导出到一个带时间戳的目录。
 *
 * 为什么需要它（而不直接用 pg_dump）：
 *   这台机器用的是 zonky 嵌入式 Postgres（`.local/pg.jar` + `initdb.exe`），
 *   **只有 initdb，没有 pg_dump**（见 `.local/init-pg.ps1` + 契约 §二）。
 *   所以备份只能用 Node 的 `postgres` 驱动自己导。连接的写法照搬
 *   `run-migration.ts`，已经在本项目里验证可用。
 *
 * 用法：
 *   npx tsx packages/db/scripts/backup.ts              # 备份到默认目录
 *   npx tsx packages/db/scripts/backup.ts <输出目录>     # 指定目录
 *
 * 默认输出目录：仓库根下的 `.local/backups/`。`.local/` 已在 `.gitignore`
 * 里（看仓库根 .gitignore 第 9 行），不会被 git 跟踪。如果将来要把
 * 备份挪到 git 跟踪的目录，**记得同步更新 .gitignore**。
 *
 * 输出结构：
 *   <输出目录>/tds-backup-YYYYMMDD-HHmmss/
 *   ├── manifest.json     备份元信息（时间、PG 版本、表数、行数、每表路径）
 *   ├── schema.json       完整 schema：列名 / 类型 / 可空 / 默认值 / 主键 / 外键
 *   └── tables/<表名>.jsonl   每表一个 JSONL 文件，每行一个对象
 *
 * 为什么 JSONL 而不是 CSV / SQL INSERT：
 *   - JSONL 保类型：恢复时 `2026-10-18` 和 `"2026-10-18"` 不会被搞混，
 *     `null` 和 `""` 也不会被搞混
 *   - JSONL 是流式的：每行独立解析/写入，不需要把整张表读进内存
 *     （见下面「大表分批」一节）
 *   - 字段顺序无关：列变更后旧备份仍能恢复，缺失列填 null
 *
 * ────────────────────────────────────────────────────────────────
 * 局限（**如实写在这里，不要假装它等价于 pg_dump**）
 * ────────────────────────────────────────────────────────────────
 * ✅ 导全部业务表的数据 + schema（列、主键、外键）
 * ✅ 业务表的全量数据：含所有用户、所有 todo、所有对话、所有 secrets
 * ❌ 不导索引：恢复后由 drizzle 迁移脚本重建
 * ❌ 不导触发器：本项目没用到
 * ❌ 不导视图：本项目没用到
 * ❌ 不导扩展：zonky 版 Postgres 的扩展是内嵌的，不需要单独备份
 * ❌ 不导序列：所有 PK 由应用生成（text id 或 generatedAlwaysAsIdentity），
 *    恢复后从 max(id)+1 续
 * ❌ 不导角色/权限/表空间：本项目单人部署，权限无关
 *
 * 恢复流程：**先用 drizzle 迁移建 schema（`packages/db/scripts/run-migration.ts`），
 * 再用 `restore.ts` 灌数据**。
 *
 * ────────────────────────────────────────────────────────────────
 * 反 FK 顺序：不在这里处理，那是 restore.ts 的事
 * ────────────────────────────────────────────────────────────────
 * 备份是「按字典序逐表导出」，**不关心 FK 顺序**：FK 约束只约束 INSERT/UPDATE，
 * 对 `SELECT` 毫无影响。FK 顺序的麻烦在恢复那一侧 —— 详见 `restore.ts` 的注释。
 *
 * ────────────────────────────────────────────────────────────────
 * 大表分批
 * ────────────────────────────────────────────────────────────────
 * `postgres` 驱动提供 `cursor(batchSize)`，按批从服务端拉，避免把整张表读进
 * 内存。本脚本用 `cursor(500)` 拉 500 行的批次，再写到 JSONL 文件追加行。
 *
 * 阈值定在 500 行/批：
 *   - 现在最大的表 ~4844 行（todo），整表也才 ~50 MB JSONL；
 *   - 但用户**以后可能会灌大量数据**（上千个 todo / 数万条消息），所以不在
 *     客户端一次性 SELECT，养成好习惯
 *   - 500 行的批次对内存几乎无压力，IO 也不是瓶颈（本地 Postgres + 本地磁盘）
 *
 * 如果你看到 `await sql` 一次返回几万行就说明 driver 偷偷走非游标路径了，
 * 需要改成 `.unsafe(...).cursor(500)`。
 *
 * ────────────────────────────────────────────────────────────────
 * bigint 精度
 * ────────────────────────────────────────────────────────────────
 * `postgres` 驱动默认把 PG `bigint` 列解析成 JS `number`（本项目用的是
 * `postgres@3.4.9`，bigint 解析走 `bigint_or_number` 模式，最大精度
 * `Number.MAX_SAFE_INTEGER = 2^53-1`）。
 *
 * schema 里**绝大多数** bigint 列存的是毫秒时间戳，2030 年前都不会溢出；
 * 但有一列例外：`sse_event.seq` 是 `generatedAlwaysAsIdentity()`，
 * 理论上能涨到 JS 安全整数之外。脚本里这样处理：
 *   - 检测某列在 `information_schema.columns` 的 `data_type` 是否为 `bigint`
 *   - 把每个 cell 用 `String(cell)` 序列化（不丢精度，但 JSON 体积变大）
 *   - 在 manifest.tables[].bigintColumns 里登记该表哪些列被字符串化了，
 *     restore 时按列名解析回 number 或保留 string
 *
 * 不需要做更精细的「按行判断是否超安全整数」：统一按列处理简单可靠，
 * 体积影响只在极个别列。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// 脚本在 packages/db/scripts/backup.ts，输出目录的「默认根」在仓库根
// `.local/backups/`。不用 process.cwd()：从任何目录跑都要解析到仓库根。
//
// ⚠️ **四层 dirname，不是三层**。`packages/db/scripts/backup.ts` 往上：
//   1 → packages/db/scripts   2 → packages/db   3 → packages   4 → <仓库根>
// 三层只到 `packages/`，实测会把备份写到 `packages/.local/backups/`（错）。
// 这里不硬数层数，改成向上找含 `pnpm-workspace.yaml` 的目录 —— 布局变了也不会错。
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 找不到就退回四层 dirname（布局符合预期时的正确答案）。
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_ROOT = resolve(REPO_ROOT, '.local/backups');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

const BATCH_SIZE = 500;

/** 单表行数据中的一行（key 是列名，value 是 PG 解析后的 JS 值） */
type Row = Record<string, unknown>;

/** manifest.json 的单表条目 */
interface ManifestTable {
  name: string;
  rows: number;
  file: string;
  /** 被字符串化处理的 bigint 列名列表（精度保护） */
  bigintColumns: string[];
}

/** manifest.json 顶层 */
interface Manifest {
  createdAt: string;
  postgresVersion: string;
  tableCount: number;
  rowCount: number;
  tables: ManifestTable[];
}

async function main(): Promise<void> {
  const outputRoot = resolve(process.argv[2] ?? DEFAULT_OUTPUT_ROOT);
  const now = new Date();
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const backupDir = join(outputRoot, `tds-backup-${stamp}`);
  const tablesDir = join(backupDir, 'tables');

  mkdirSync(tablesDir, { recursive: true });

  const sql = postgres(DATABASE_URL, { max: 1 });

  try {
    // 1. PG 版本（写到 manifest，方便排查版本差异）
    const [{ version: pgVersion }] = await sql<{ version: string }[]>`
      SELECT version()
    `;

    // 2. 列出所有业务表：public schema + BASE TABLE（排除视图）
    const tableRows = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tables = tableRows.map((r) => r.table_name);
    if (tables.length === 0) {
      console.error('no tables found in public schema — is the DB initialized?');
      process.exitCode = 1;
      return;
    }

    // 3. 完整 schema：列 + 主键 + 外键
    //    - columns：列名、类型（udt_name 是 PG 内部类型，data_type 是 SQL
    //      标准类型；两个都拿，restore 时优先用 udt_name 因为更精确，
    //      例如 jsonb 在 data_type 是 'jsonb'，在 udt_name 也是 'jsonb'）
    //    - primary keys：用 kcu.table_name + kcu.column_name 反查
    //    - foreign keys：从 information_schema 三表 JOIN 反查
    //
    // 为什么不直接一个大 JOIN：
    //   - information_schema 在 PG 里是视图，复杂查询慢；
    //   - 拆三个简单查询在 30 张表以内毫秒级返回，足够清楚。
    type ColumnInfo = {
      table_name: string;
      column_name: string;
      udt_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
      ordinal_position: number;
    };
    const columns = await sql<ColumnInfo[]>`
      SELECT
        table_name,
        column_name,
        udt_name,
        data_type,
        is_nullable,
        column_default,
        ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `;

    type PkRow = { table_name: string; column_name: string };
    const pks = await sql<PkRow[]>`
      SELECT
        tc.table_name::text AS table_name,
        kcu.column_name::text AS column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'PRIMARY KEY'
    `;

    type FkRow = {
      table_name: string;
      column_name: string;
      ref_table: string;
      ref_column: string;
    };
    const fks = await sql<FkRow[]>`
      SELECT
        tc.table_name::text                                    AS table_name,
        kcu.column_name::text                                  AS column_name,
        ccu.table_name::text                                   AS ref_table,
        ccu.column_name::text                                  AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;

    // 按表名分组，组装 schema.json
    interface ColumnSchema {
      name: string;
      udt: string;
      dataType: string;
      nullable: boolean;
      default: string | null;
      primaryKey: boolean;
    }
    interface ForeignKeySchema {
      column: string;
      references: { table: string; column: string };
    }
    interface TableSchema {
      name: string;
      columns: ColumnSchema[];
      foreignKeys: ForeignKeySchema[];
    }
    const schema: { tables: TableSchema[] } = { tables: [] };

    // 索引各表的列 / 主键 / 外键
    const columnsByTable: Record<string, ColumnInfo[]> = {};
    for (const col of columns) {
      (columnsByTable[col.table_name] ??= []).push(col);
    }
    const pkSetsByTable: Record<string, Set<string>> = {};
    for (const pk of pks) {
      (pkSetsByTable[pk.table_name] ??= new Set<string>()).add(pk.column_name);
    }
    const fksByTable: Record<string, FkRow[]> = {};
    for (const fk of fks) {
      (fksByTable[fk.table_name] ??= []).push(fk);
    }

    for (const tableName of tables) {
      const cols = columnsByTable[tableName] ?? [];
      const pkSet = pkSetsByTable[tableName] ?? new Set<string>();
      const fkList = fksByTable[tableName] ?? [];
      schema.tables.push({
        name: tableName,
        columns: cols.map((c) => ({
          name: c.column_name,
          udt: c.udt_name,
          dataType: c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default,
          primaryKey: pkSet.has(c.column_name),
        })),
        foreignKeys: fkList.map((f) => ({
          column: f.column_name,
          references: { table: f.ref_table, column: f.ref_column },
        })),
      });
    }
    writeFileSync(
      join(backupDir, 'schema.json'),
      JSON.stringify(schema, null, 2),
      'utf8',
    );

    // 4. 逐表导出行数据 → JSONL（用 cursor 流式拉）
    const manifestTables: ManifestTable[] = [];
    let totalRows = 0;

    for (const tableName of tables) {
      const tableCols = columnsByTable[tableName] ?? [];
      const bigintCols = tableCols
        .filter((c) => c.udt_name === 'int8' || c.data_type === 'bigint')
        .map((c) => c.column_name);

      const filePath = join('tables', `${tableName}.jsonl`);
      const fileAbs = join(backupDir, filePath);
      let rowCount = 0;

      // `cursor(BATCH_SIZE)` 返回 AsyncIterable<row[]>
      // 关键：`postgres` 驱动对 `bigint` 列默认走 number 解析；
      //   我们后面用 String(cell) 序列化以防溢出
      const pending = sql.unsafe(
        `SELECT * FROM ${quoteIdent(tableName)}`,
      ).cursor(BATCH_SIZE);

      // 流式写入：每批攒到一定量再写一次盘，减少 IO 调用
      const lines: string[] = [];
      for await (const batch of pending) {
        for (const row of batch) {
          lines.push(JSON.stringify(stringifyBigInts(row, bigintCols), jsonReplacer));
        }
        if (lines.length >= 1000) {
          writeFileSync(fileAbs, lines.join('\n') + '\n', {
            encoding: 'utf8',
            flag: rowCount === 0 ? 'w' : 'a',
          });
          rowCount += lines.length;
          totalRows += lines.length;
          lines.length = 0;
        }
      }
      // 收尾
      if (lines.length > 0) {
        writeFileSync(fileAbs, lines.join('\n') + '\n', {
          encoding: 'utf8',
          flag: rowCount === 0 ? 'w' : 'a',
        });
        rowCount += lines.length;
        totalRows += lines.length;
      } else if (rowCount === 0) {
        // 空表：写一个空文件，让 manifest.file 指向真实存在的文件
        writeFileSync(fileAbs, '', 'utf8');
      }

      manifestTables.push({
        name: tableName,
        rows: rowCount,
        file: filePath,
        bigintColumns: bigintCols,
      });
      console.log(`  ${tableName.padEnd(28)} ${rowCount.toString().padStart(6)} rows`);
    }

    // 5. 写 manifest
    const manifest: Manifest = {
      createdAt: now.toISOString(),
      postgresVersion: pgVersion,
      tableCount: tables.length,
      rowCount: totalRows,
      tables: manifestTables,
    };
    writeFileSync(
      join(backupDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    console.log('');
    console.log(`backup written to: ${backupDir}`);
    console.log(`  tables: ${manifest.tableCount}`);
    console.log(`  rows:   ${manifest.rowCount}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * 把指定 bigint 列的 cell 转成 string。其余列原样。
 * - 对 null/undefined 直接返回
 * - 对 number/bigint/string 统一 String()
 *   （万一用户将来用 `postgres({ bigint: true })` 配置，BigInt 也能 String 转）
 */
function stringifyBigInts(row: Row, bigintCols: string[]): Row {
  if (bigintCols.length === 0) return row;
  const out: Row = { ...row };
  for (const col of bigintCols) {
    const v = out[col];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') {
      out[col] = String(v);
    }
  }
  return out;
}

/**
 * JSON.stringify 的 replacer：处理三种 PG 驱动可能返回的特殊值
 * - `undefined`：JSON 不允许，让 stringify 跳过这一字段
 * - `Buffer`：转成 base64 字符串（驱动默认不返回 Buffer，但保留兜底）
 * - `Date`：转 ISO 字符串（驱动默认不返回 Date，但保留兜底）
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof Buffer !== 'undefined' && value instanceof Buffer) {
    return value.toString('base64');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/**
 * 给表名 / 列名加双引号防止关键字冲突 + SQL 注入。
 * 名字只能来自 information_schema（受信），但仍按白名单字符限制做防御。
 */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

void main();
