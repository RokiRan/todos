/**
 * 恢复脚本 —— 把 `backup.ts` 导出的备份目录灌回 Postgres。
 *
 * 为什么需要它（对应 backup.ts 的局限说明）：
 *   - `restore.ts` 是 `backup.ts` 的反向操作，二者是一对
 *   - 不替代 pg_dump：只恢复 `backup.ts` 实际写入的内容
 *     （数据 + 列/主键/外键 schema，**不**含索引/触发器/视图/扩展）
 *
 * 用法：
 *   npx tsx packages/db/scripts/restore.ts <备份目录>
 *   npx tsx packages/db/scripts/restore.ts <备份目录> --yes   # 跳过确认
 *
 * 调用前置（**用户必须自己做，不在本脚本里自动化**）：
 *   1. 用 `packages/db/scripts/run-migration.ts` 跑 drizzle 迁移建 schema
 *      —— 这步会建表 + 主键 + 外键 + 索引；restore 只负责灌数据
 *   2. 然后跑 `restore.ts`
 *   3. 然后再做**任意**基于索引的优化（已经建好了，不用再动）
 *
 * 流程：
 *   1. 读 manifest.json → 打印「将恢复 N 个表 / M 行」
 *   2. 校验 schema：备份里的所有表都必须在目标 DB 里存在
 *   3. 算 FK 反向拓扑序 —— 见下面「反 FK 顺序」一节
 *   4. 确认（除非 --yes）
 *   5. 反拓扑序逐表 TRUNCATE（先清子表，最后清父表，避免 FK 约束报错）
 *   6. 按拓扑序 INSERT（先 INSERT 父表，再 INSERT 子表，避免 FK 违反）
 *   7. 逐表对账：写入行数 vs manifest.rowCount
 *
 * ────────────────────────────────────────────────────────────────
 * 反 FK 顺序：拓扑排序，不走 `session_replication_role`
 * ────────────────────────────────────────────────────────────────
 * 这个项目有 FK 链：`user → team → member`、`team → agent → chief → chief_thread`、
 * `project → todo → build → build_message` 等。按字母序导入一定会撞 FK 约束。
 *
 * 两个方案：
 *   A. **SET session_replication_role = replica** 临时关掉 FK（实现层是触发器）
 *   B. **算反 FK 拓扑序**，按「无依赖 → 有依赖」顺序导入
 *
 * **选 B**。理由：
 *   - A 方案一旦中途某行导入失败，剩下的表全靠 FK 关闭撑过去，事后排查时
 *     「为什么这条 message.build_id 在 build 表里找不到」会非常难受 —— 表面上
 *     全成功了，索引走完才发现 FK 违反
 *   - B 方案每行 INSERT 都过 FK 校验，发现失败立刻报错，失败点清晰
 *   - B 的代价只是几十张表的拓扑排序，毫秒级
 *   - B 对恢复**幂等性**更友好：每张表独立 INSERT，可以分阶段观察
 *
 * 反拓扑排序实现：把每张表当成节点，FK 边指向**被引用方**，用 Kahn 算法
 * 跑出反序。检测到环 → 立刻报错（schema 设计不该有环）。
 *
 * ────────────────────────────────────────────────────────────────
 * TRUNCATE 顺序：与导入相反（先清子表，最后清父表）
 * ────────────────────────────────────────────────────────────────
 * 不用 `TRUNCATE ... CASCADE`：CASCADE 会把 FK 指向本表的所有表都一起清掉，
 * 含**不在备份里**的外部表 —— 那会破坏用户没让我们动的东西。
 *
 * 改为逐表 TRUNCATE，按 importOrder 反序：
 *   - 子表（没有别人 FK 它）最先清，独立 TRUNCATE 没问题
 *   - 父表（被其它表 FK 引用）放在最后清 —— 此时所有引用它的子表已经空了，
 *     没有现存行指向它，TRUNCATE 不撞 FK 约束
 *
 * `RESTART IDENTITY` 让所有 `generatedAlwaysAsIdentity()` 列从 1 重新计数，
 * 跟备份里实际存储的 seq 值保持一致（备份时 seq 也是某个具体值，恢复后
 * 序列状态由后续 INSERT 自然推进）。
 *
 * ────────────────────────────────────────────────────────────────
 * bigint 列：按 manifest.tables[].bigintColumns 解析回 number
 * ────────────────────────────────────────────────────────────────
 * 备份时把 bigint 列转 string 以保护精度。恢复时按列名解析回 number：
 *   - 目标 PG 列是 bigint → 用 Number(cell)
 *     （备份前的精度保护已经保证不会超过 JS 安全整数）
 *   - 或者直接保持 string，Postgres 自动把字符串解析为 bigint
 *
 * 实测：postgres 驱动对参数化 bigint 列接受字符串字面量，不需要手动转。
 *
 * ────────────────────────────────────────────────────────────────
 * 错误策略：任一表导入失败立刻停，已导入的行**已经在 DB 里**
 * ────────────────────────────────────────────────────────────────
 * 这是不可恢复的危险（除非再跑一次完整 restore）。所以：
 *   - 失败时**不**回滚已导入的行
 *   - 打印「部分恢复完成」+ 已成功的表名，让用户决定下一步
 *   - exit code 非 0，CI / 自动化能感知
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

/** 内存里能攒多少行 JSONL 再发一次 INSERT（保护内存） */
const INSERT_BATCH = 500;

interface ManifestTable {
  name: string;
  rows: number;
  file: string;
  bigintColumns: string[];
}

interface Manifest {
  createdAt: string;
  postgresVersion: string;
  tableCount: number;
  rowCount: number;
  tables: ManifestTable[];
}

interface ForeignKeySchema {
  column: string;
  references: { table: string; column: string };
}

interface TableSchema {
  name: string;
  columns: Array<{
    name: string;
    udt: string;
    dataType: string;
    nullable: boolean;
    default: string | null;
    primaryKey: boolean;
  }>;
  foreignKeys: ForeignKeySchema[];
}

interface SchemaFile {
  tables: TableSchema[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes('--yes');
  const backupDirArg = args.find((a) => !a.startsWith('--'));
  if (!backupDirArg) {
    console.error('usage: tsx restore.ts <备份目录> [--yes]');
    process.exitCode = 2;
    return;
  }
  const backupDir = resolve(backupDirArg);

  // ── 读 manifest + schema ─────────────────────────────────────
  const manifestPath = join(backupDir, 'manifest.json');
  const schemaPath = join(backupDir, 'schema.json');
  if (!existsSync(manifestPath) || !existsSync(schemaPath)) {
    console.error(`missing manifest.json or schema.json in ${backupDir}`);
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as SchemaFile;

  // ── 校验目标 DB 是否已经准备好 ───────────────────────────────
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const dbTables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const dbTableSet = new Set(dbTables.map((r) => r.table_name));
    const missingTables = manifest.tables
      .map((t) => t.name)
      .filter((n) => !dbTableSet.has(n));
    if (missingTables.length > 0) {
      console.error('target DB is missing tables that the backup references:');
      for (const t of missingTables) console.error(`  - ${t}`);
      console.error('run `packages/db/scripts/run-migration.ts` first.');
      process.exitCode = 1;
      return;
    }

    // ── 算反 FK 拓扑序 ─────────────────────────────────────────
    // 用 manifest.tables 里所有出现的表名当节点全集；FK 表/被引用表超出
    // 这个集合的忽略（保守：备份里没有的表我们不动）
    const tableNames = manifest.tables.map((t) => t.name);
    const tableSet = new Set(tableNames);
    const fksByTable: Record<string, ForeignKeySchema[]> = {};
    for (const t of schema.tables) {
      if (!tableSet.has(t.name)) continue;
      fksByTable[t.name] = t.foreignKeys.filter((fk) => tableSet.has(fk.references.table));
    }

    // Kahn 算法：维护每个节点的「剩余未处理的依赖数」inDegree。
    // 把 FK 边 `child → parent` 看成「parent 必须在 child 之前导入」，
    // 即 child 对 parent 有一条入边。每处理一个 parent，所有它指向的 child
    // 入度减一；下一个入度为零的节点是新的 ready。
    const inDegree: Record<string, number> = {};
    const childrenByTable: Record<string, string[]> = {};
    for (const t of tableNames) {
      inDegree[t] = 0;
      childrenByTable[t] = [];
    }
    for (const [table, fks] of Object.entries(fksByTable)) {
      for (const fk of fks) {
        // 边 fk.references.table → table（parent 必须在 child 之前）
        inDegree[table] = (inDegree[table] ?? 0) + 1;
        (childrenByTable[fk.references.table] ??= []).push(table);
      }
    }

    const importOrder: string[] = [];
    const ready: string[] = Object.entries(inDegree)
      .filter(([, deg]) => deg === 0)
      .map(([name]) => name)
      .sort();

    while (ready.length > 0) {
      // 字典序挑下一个：相同 ready 集合里谁先谁后无所谓，字典序更可预测
      const next = ready.shift()!;
      importOrder.push(next);
      for (const child of childrenByTable[next] ?? []) {
        inDegree[child]--;
        if (inDegree[child] === 0) ready.push(child);
      }
      ready.sort();
    }

    if (importOrder.length !== tableNames.length) {
      const stuck = tableNames.filter((t) => !importOrder.includes(t));
      console.error('FK cycle detected; topological sort failed. stuck tables:');
      for (const t of stuck) console.error(`  - ${t}`);
      process.exitCode = 1;
      return;
    }

    // 打印确认信息
    console.log('backup dir:   ', backupDir);
    console.log('backup from:  ', manifest.createdAt);
    console.log('target DB:    ', DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
    console.log('table count:  ', manifest.tableCount);
    console.log('total rows:   ', manifest.rowCount);
    console.log('import order: ', importOrder.join(' -> '));
    console.log('');

    if (!skipConfirm) {
      const ok = await prompt('This will TRUNCATE every listed table and re-import. Continue? [y/N] ');
      if (ok !== 'y' && ok !== 'Y') {
        console.log('aborted.');
        return;
      }
    }

    // ── TRUNCATE：一条语句清全部表 ───────────────────────────────
    //
    // ⚠️ **必须放在同一条语句里，不能逐表循环。**
    //
    // Postgres 的 `TRUNCATE` 检查的是「**有没有别的表在 schema 层面 FK 引用
    // 它**」，**与表里有没有行无关**。逐表清时清到 `chief_thread` 就会报
    // `cannot truncate a table referenced in a foreign key constraint`
    // —— 即使 `chief_wake` 早就被清空了也一样（实测踩过：error detail
    // `Table "chief_wake" references "chief_thread"`）。
    //
    // PG 允许 `TRUNCATE a, b, c` —— 它只要求**这个集合内部**的引用是闭合的，
    // 而不做跨语句追踪。我们把所有表一次列出，引用关系天然闭合。
    //
    // 为什么不用 `CASCADE`：CASCADE 会把 FK 指向本表的所有表（包括**不在本次
    // 备份里的外部表**）一起清掉，破坏用户没让我们动的东西。显式列出全部表名
    // 既安全又不越界。
    //
    // `RESTART IDENTITY` 让所有 `generatedAlwaysAsIdentity()` 列从 1 重新计数。
    // ⚠️ 表名同样要 `quoteIdent` —— `user` 是 SQL 保留字，裸写会报
    // `syntax error at or near "user"`（实测踩过，error position 340）。
    const allTables = importOrder.map(quoteIdent).join(', ');
    console.log(`TRUNCATE ${importOrder.length} tables RESTART IDENTITY`);
    await sql.unsafe(`TRUNCATE ${allTables} RESTART IDENTITY`);

    // ── 逐表 INSERT（按 importOrder 走，父表先） ───────────────
    const manifestByName: Record<string, ManifestTable> = {};
    for (const t of manifest.tables) manifestByName[t.name] = t;

    let okCount = 0;
    let failCount = 0;
    for (const tableName of importOrder) {
      const meta = manifestByName[tableName];
      const bigintCols = new Set(meta.bigintColumns);
      const fileAbs = join(backupDir, meta.file);
      if (!existsSync(fileAbs)) {
        console.error(`  ${tableName.padEnd(28)} FILE MISSING: ${meta.file}`);
        failCount++;
        continue;
      }

      try {
        const inserted = await importTable(sql, tableName, fileAbs, bigintCols);
        const expected = meta.rows;
        const status = inserted === expected ? 'OK' : 'MISMATCH';
        console.log(`  ${tableName.padEnd(28)} ${status.padEnd(8)} ${inserted}/${expected} rows`);
        if (inserted !== expected) {
          failCount++;
        } else {
          okCount++;
        }
      } catch (err) {
        console.error(`  ${tableName.padEnd(28)} FAIL`);
        console.error(err instanceof Error ? err.message : String(err));
        failCount++;
      }
    }

    // ── 序列对齐（必须在所有 INSERT 之后） ──────────────────────
    //
    // ⚠️ **这一步不能省**。`TRUNCATE ... RESTART IDENTITY` 把序列清零，
    // `OVERRIDING SYSTEM VALUE` 又把历史 id 显式插了进去 —— 但序列**自己
    // 不会前进**。结果：恢复后库里 `audit_event` 有 2113 行，而
    // `audit_event_id_seq.last_value` 还停在 400，下一次插入就撞主键。
    // （实测踩过：恢复「成功」后测试全挂，报 duplicate key。）
    //
    // 正确做法：把每个 identity 列的序列 `setval` 到 `max(列值)`。
    // 空表要 `setval(seq, 1, false)` 让下一次从 1 开始（`is_called=false`）。
    await realignSequences(sql);
    console.log('sequences realigned');

    console.log('');
    console.log(`done. ok=${okCount} fail=${failCount}`);
    if (failCount > 0) {
      console.error('partial restore — DB may be in inconsistent state. check logs above.');
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * 把一个 JSONL 文件灌进一张表。流式读取，按 INSERT_BATCH 攒批执行。
 *
 * 批 INSERT 用 `postgres` 驱动的「对象数组 + 列名」形式：
 *   `await sql\`INSERT INTO tbl ${sql(rows, 'col1', 'col2')}\``
 * 驱动会把数组展开成多值 VALUES，并参数化每个 cell —— 安全 + 高效。
 *
 * 列名从 JSONL 第一行的 keys 拿：备份文件里多余的字段（不该有，防御性）会被忽略；
 * 缺失字段补 `DEFAULT`（由 PG 兜底）。
 *
 * @returns 实际写入的行数
 */
async function importTable(
  sql: postgres.Sql,
  tableName: string,
  jsonlPath: string,
  bigintCols: Set<string>,
): Promise<number> {
  // 列名集合：扫一遍 JSONL 第一行拿 keys；空文件则直接返回 0
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return 0;

  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  const cols = Object.keys(first);

  // ── 找出 `GENERATED ALWAYS AS IDENTITY` 列 ──────────────────────
  //
  // PG **禁止**往这类列显式插值：
  //   `cannot insert a non-DEFAULT value into column "seq"`
  // （`sse_event.seq` 与 `audit_event.id` 都是这类列 —— 实测踩过，两张表导入失败。）
  //
  // 解法是 `INSERT ... OVERRIDING SYSTEM VALUE`，它让数据库接受显式值而不再
  // 自己生成。**必须加**，否则 identity 列所在表整张导不进去。
  //
  // 为什么要实时查库而不是读 schema.json：备份格式里的 `udt` 只是类型名
  // （int8 / text），区分不出「普通 bigint」与「generated bigint」。而恢复时
  // 表结构是现成的（schema 由 drizzle 迁移建好），查 `information_schema` 最准。
  const genRows = await sql<
    { column_name: string; is_generated: string; identity_generation: string | null }[]
  >`
    select column_name, is_generated, identity_generation
      from information_schema.columns
     where table_schema = 'public' and table_name = ${tableName}
       and (is_generated = 'ALWAYS'
            or identity_generation is not null)
  `;
  const generatedCols = new Set(
    genRows.map((r) => r.column_name).filter((c) => cols.includes(c)),
  );

  // 把 cell 转回 PG-friendly 值：bigint 列保留字符串（postgres 驱动
  // 对字符串参数自动识别为 bigint）；其余原样
  const coerce = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const col of cols) {
      const v = row[col];
      if (bigintCols.has(col)) {
        out[col] = v === null || v === undefined ? null : String(v);
      } else if (v === undefined) {
        // JSON.stringify 会跳过 undefined；这里显式 null，匹配 schema DEFAULT
        out[col] = null;
      } else {
        out[col] = v;
      }
    }
    return out;
  };

  let inserted = 0;
  let buffer: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    // `sql(buffer, ...colNames)` 让驱动展开成多值 VALUES 并参数化每个 cell。
    //
    // ⚠️ **标识符必须手工加双引号**。驱动的 `sql(x)` 把 x 当**值**处理（转成
    // 参数占位符或裸串），**不会**引号包裹 —— 于是保留字列名（`user` 是 SQL
    // 保留字）直接语法报错：`syntax error at or near "user"`（实测踩过）。
    // 所以列名不走 `sql()`，改用 `quoteIdent`；表名同理。
    // ⚠️ 占位符编号必须在**整条语句里连续**，不能每行都从 `$1` 开始 ——
    // 同一批 500 行的 VALUES 子句共享一个参数数组，`$1` 重复出现会让第二行
    // 覆盖第一行的值。用运行中的 offset 递增。
    let ph = 0;
    const valuesSql = buffer
      .map(() => {
        const rowPh = cols.map(() => `$${(ph += 1)}`);
        return `(${rowPh.join(', ')})`;
      })
      .join(', ');

    // `OVERRIDING SYSTEM VALUE`：允许往 `GENERATED ALWAYS AS IDENTITY` 列
    // 显式插值。没有它，identity 列所在表整张导不进去（实测 sse_event /
    // audit_event 两张都失败）。只在真的存在 generated 列时加，保持语句干净。
    const overrideClause = generatedCols.size > 0 ? ' OVERRIDING SYSTEM VALUE' : '';

    await sql.unsafe(
      `INSERT INTO ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(', ')})` +
        `${overrideClause} VALUES ${valuesSql}`,
      buffer.flatMap((row) => cols.map((c) => row[c])),
    );
    inserted += buffer.length;
    buffer = [];
  };

  try {
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      buffer.push(coerce(row));
      if (buffer.length >= INSERT_BATCH) {
        await flush();
      }
    }
    await flush();
  } catch (cause) {
    buffer = [];
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`import failed mid-batch for ${tableName} after ${inserted} rows: ${detail}`);
  }

  return inserted;
}

/**
 * 同步提示用户 y/N。TTY 检测：不在 TTY 里（非交互）默认拒绝（除非 --yes）
 */
async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('non-interactive shell — re-run with --yes to skip confirmation');
    process.exitCode = 1;
    throw new Error('aborted: non-interactive shell without --yes');
  }
  const { promise, resolve } = Promise.withResolvers<string>();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  });
  return promise;
}

/**
 * 给表名 / 列名加双引号防止关键字冲突 + SQL 注入。
 * 名字只能来自 backup 的 JSON 文件（受信），但仍按白名单字符限制做防御。
 */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * 把所有 identity 列的序列推进到 `max(列值)`。
 *
 * 为什么必须有：`TRUNCATE ... RESTART IDENTITY` 清零序列，
 * `OVERRIDING SYSTEM VALUE` 显式插入历史 id —— 序列不跟着走。恢复后
 * 下一次 INSERT 就会撞主键（实测：audit_event 2113 行但序列停在 400，
 * 恢复后测试全挂 duplicate key）。
 *
 * 覆盖哪些列：`information_schema.columns` 里
 * `is_generated = 'ALWAYS'` 或 `identity_generation IS NOT NULL` 的列
 * —— 这与 `importTable` 里判定 `OVERRIDING SYSTEM VALUE` 的条件一致，
 * 保证「用显式值插入的列」与「被 setval 的列」严格对应。
 */
async function realignSequences(sql: postgres.Sql): Promise<void> {
  const cols = await sql<
    {
      table_name: string;
      column_name: string;
      identity_generation: string | null;
    }[]
  >`
    select c.table_name, c.column_name, c.identity_generation
      from information_schema.columns c
     where c.table_schema = 'public'
       and (c.is_generated = 'ALWAYS' or c.identity_generation is not null)
  `;

  for (const col of cols) {
    const table = quoteIdent(col.table_name);
    const column = quoteIdent(col.column_name);
    // 序列名约定 = <table>_<column>_seq（PG 默认命名）。
    //
    // ⚠️ 序列名必须作为**字符串字面量**传给 setval，不能 `quoteIdent` ——
    // 双引号包起来之后 PG 会把它当成列名，报
    // `column "audit_event_id_seq" does not exist`（实测踩过）。用
    // `sql.unsafe(..., [seqName])` 让驱动参数化。
    const seqName = `${col.table_name}_${col.column_name}_seq`;

    // 第三个参数 is_called=false 让空表的下一次取值就是 1。
    await sql.unsafe(
      `select setval($1::regclass, ` +
        `coalesce((select max(${column}) from ${table}), 1), ` +
        `(select count(*) > 0 from ${table}))`,
      [seqName],
    );
  }
}

void main();
