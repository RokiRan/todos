import postgres from 'postgres';
const sql = postgres('postgres://tds@127.0.0.1:5433/tds', { max: 1 });
const d = await sql`SELECT b.todo_id, t.phase FROM document doc JOIN build b ON b.id=doc.build_id
                   JOIN todo t ON t.id=b.todo_id WHERE doc.kind='changes'
                   ORDER BY doc.created_at DESC LIMIT 1`;
console.log(JSON.stringify(d[0]));
