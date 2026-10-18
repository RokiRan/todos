import postgres from 'postgres';
const sql = postgres('postgres://tds@127.0.0.1:5433/tds', { max: 1 });
// 找 team 与其下的 review 阶段 todo
const team = await sql`SELECT DISTINCT p.team_id FROM todo t JOIN project p ON p.id=t.project_id LIMIT 1`;
const teamId = team[0]?.team_id;
const todo = await sql`SELECT t.id, t.phase FROM todo t JOIN project p ON p.id=t.project_id
                      WHERE p.team_id=${teamId} AND t.phase='review' LIMIT 1`;
console.log('team:', teamId, ' review todo:', todo[0]?.id ?? '(无)');
if (!todo[0]) {
  // 没有 review 就造一个：拿现有 todo 推到 review 需要走状态机，直接用 SQL 改仅用于探针
  const any = await sql`SELECT t.id FROM todo t JOIN project p ON p.id=t.project_id WHERE p.team_id=${teamId} LIMIT 1`;
  if (!any[0]) { console.log('该团队无 todo'); await sql.end(); process.exit(0); }
  const orig = (await sql`SELECT phase FROM todo WHERE id=${any[0].id}`)[0].phase;
  await sql`UPDATE todo SET phase='review' WHERE id=${any[0].id}`;
  console.log(`临时把 ${any[0].id} 从 ${orig} 设为 review`);
  const r = await fetch(`http://127.0.0.1:4000/api/todos/${any[0].id}/feedback`, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ message:'SSE 触发探针' }) });
  console.log('feedback →', r.status);
  await sql`UPDATE todo SET phase=${orig} WHERE id=${any[0].id}`;
  console.log('已还原为', orig);
  await sql.end();
  process.exit(0);
}
const r = await fetch(`http://127.0.0.1:4000/api/todos/${todo[0].id}/feedback`, {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ message:'SSE 触发探针' }) });
console.log('feedback →', r.status);
console.log('TEAM_ID=' + teamId);
await sql.end();
