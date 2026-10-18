import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import Fastify from 'fastify';
import { registerSseRoutes, publish } from './src/sse.js';
const sql = postgres('postgres://tds@127.0.0.1:5433/tds', { max: 1 });
const db = drizzle(sql, { schema: dbPkg.schema });
const app = Fastify({ logger: false });
app.decorate('machineUrl', 'http://t');
registerSseRoutes(app, db as never);
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address() as any;
const port = addr?.port;
console.log('监听端口 =', port, typeof port);
const SC = 'team:t2';
await sql`DELETE FROM sse_event WHERE scope=${SC}`;
const seq = await publish(db as never, SC, 'pre', {a:1}, 'tid');
console.log('预置 seq =', seq);
const res = await fetch(`http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent(SC)}&since=${seq-1}`);
console.log('stream status', res.status);
const reader = res.body!.getReader();
const dec = new TextDecoder();
const ctrl = new AbortController();
const t = setTimeout(()=>ctrl.abort(), 3000);
try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const txt = dec.decode(value);
    console.log('收到 chunk:', JSON.stringify(txt.slice(0,120)));
    if (txt.includes('pre')) break;
  }
} catch(e) { console.log('读异常/超时'); } finally { clearTimeout(t); }
await sql`DELETE FROM sse_event WHERE scope=${SC}`;
await app.close(); await sql.end();
