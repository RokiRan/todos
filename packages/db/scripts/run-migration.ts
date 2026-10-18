/**
 * 迁移执行器 —— 把 `packages/db/drizzle/*.sql` 打到本地 Postgres。
 *
 * 为什么需要它：这台机器用的是 zonky 嵌入式 Postgres（`.local/pg.jar`），
 * 只有 `initdb.exe`，**没有 psql.exe**（见 `.local/init-pg.ps1`）。所以
 * 迁移没法用命令行客户端跑，只能从 Node 侧用 `postgres` 驱动执行。
 *
 * 用法：
 *   npx tsx packages/db/scripts/run-migration.ts           # 跑全部
 *   npx tsx packages/db/scripts/run-migration.ts 0004_     # 跑指定的
 *
 * **为什么必须住在 `packages/db/` 下**：pnpm workspace 的 node_modules 是按包
 * 隔离的，从仓库根或 `local/` 跑脚本解析不到 `postgres`（ERR_MODULE_NOT_FOUND）。
 * `packages/db` 依赖它，所以脚本要跟着依赖住。
 *
 * 幂等性：所有迁移都写成可重放的（IF NOT EXISTS / DO $$ 守卫），重复执行
 * 不会破坏数据。**顺序按文件名**——0000 → 0004 的依赖是线性的。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

// 脚本在 packages/db/scripts/，迁移在 packages/db/drizzle/ —— 相对本文件定位，
// 不用 process.cwd()（那样从任何目录跑都会找错）。
const DB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(DB_DIR, 'drizzle');

async function main(): Promise<void> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(DATABASE_URL, { max: 1 });

  const filter = process.argv[2];
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    // 名称排序即执行序：0000_init → 0001 → … → 0004。字典序对定宽前缀正确。
    .sort()
    .filter((f) => (filter ? f.startsWith(filter) : true));

  if (files.length === 0) {
    console.error(`no migration matched: ${filter ?? '(all)'}`);
    process.exitCode = 1;
    await sql.end();
    return;
  }

  for (const file of files) {
    const path = join(MIGRATIONS_DIR, file);
    const body = readFileSync(path, 'utf8');
    try {
      await sql.unsafe(body);
      console.log(`OK   ${file}`);
    } catch (err) {
      console.error(`FAIL ${file}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      break;
    }
  }

  await sql.end();
}

void main();
