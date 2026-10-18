import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.js';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

/** 建库后返回的句柄类型 —— 全 monorepo 共用这一个契约 */
export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string = DATABASE_URL): Db {
  const client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    fetch_types: false,
  });
  return drizzle(client, { schema });
}

export * from './schema.js';
