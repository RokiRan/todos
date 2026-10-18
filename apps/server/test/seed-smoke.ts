/**
 * 端到端冒烟：建一个 team + project + agent + todo + build + step，
 * 让 daemon 能领到活并真的跑起 Claude Code。
 *
 * 这是 MVP 关键路径（阶段 2+3+4）的真实验证，不是 mock。
 */
import crypto from 'node:crypto';
import postgres from 'postgres';

const DB = 'postgres://tds@127.0.0.1:5433/tds';

const newId = () => crypto.randomBytes(18).toString('base64url');
const now = () => Date.now();

async function main(): Promise<void> {
  const sql = postgres(DB, { max: 1 });

  const kek = crypto.createHash('sha256').update('tds-dev-kek-do-not-use-in-prod').digest();
  const hashApiKey = (k: string) =>
    crypto.createHmac('sha256', kek).update(k).digest('hex');

  const ts = now();
  const teamId = newId();
  const userId = newId();
  const memberId = newId();
  const projectId = newId();
  const agentId = newId();
  const todoId = newId();
  const buildId = newId();
  const stepId = newId();

  // 机器注册用 key —— 名称约定为 machine:<machineId>
  const apiKey = `tds_${crypto.randomBytes(24).toString('base64url')}`;

  await sql.begin(async (tx) => {
    await tx`INSERT INTO "user" (id,email,display_name,created_at,updated_at)
              VALUES (${userId}, ${'smoke@test.local'}, ${'Smoke Tester'}, ${ts}, ${ts})`;

    await tx`INSERT INTO team (id,name,plan,created_at)
              VALUES (${teamId}, ${'Smoke Team'}, ${'free'}, ${ts})`;

    await tx`INSERT INTO member (id,team_id,actor_id,member_type,role,joined_at)
              VALUES (${memberId}, ${teamId}, ${userId}, ${'user'}, ${'admin'}, ${ts})`;

    await tx`INSERT INTO api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              VALUES (${newId()}, ${userId}, ${teamId}, ${apiKey.slice(0, 12)},
                      ${hashApiKey(apiKey)}, ${['machine:enroll']}, ${ts})`;

    await tx`INSERT INTO project (id,team_id,name,provider,repo_kind,repo_full_name,
                                  repo_url,default_branch,next_seq_num,created_at)
              VALUES (${projectId}, ${teamId}, ${'smoke-project'}, ${'external'}, ${'other'},
                      ${'local/smoke'}, ${null}, ${'main'}, ${2}, ${ts})`;

    await tx`INSERT INTO agent (id,team_id,display_name,description,created_at,updated_at)
              VALUES (${agentId}, ${teamId}, ${'Builder'},
                      ${'Implements tasks in an isolated worktree.'}, ${ts}, ${ts})`;

    await tx`INSERT INTO todo (id,project_id,seq_num,owner_member_id,agent_id,
                               title,spec,phase,plan_first,created_at,updated_at)
              VALUES (${todoId}, ${projectId}, ${1}, ${memberId}, ${agentId},
                      ${'Write a greeting file'},
                      ${'Create a file named hello.txt containing exactly: hello from tds clone'},
                      ${'todo'}, ${true}, ${ts}, ${ts})`;

    await tx`INSERT INTO build (id,todo_id,n,branch,prev_phase,trigger_source,
                                agent_id,session,created_at)
              VALUES (${buildId}, ${todoId}, ${1}, ${`tds/conv-${buildId}`},
                      ${'todo'}, ${'user'}, ${agentId},
                      ${sql.json({ runtime: 'claude-code', id: newId(), openedAt: ts })}, ${ts})`;

    await tx`INSERT INTO step (id,build_id,machine_id,status)
              VALUES (${stepId}, ${buildId}, ${null}, ${'queued'})`;
  });

  console.log(JSON.stringify({ teamId, apiKey, todoId, buildId, stepId }, null, 2));
  await sql.end();
}

await main();
