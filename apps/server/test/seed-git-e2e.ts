import crypto from 'node:crypto';
import postgres from 'postgres';

/**
 * 端到端验证：真实 git 仓库 + 隔离分支 + diff 落库。
 * 用本地 file:// 仓库当 remote —— 不需要网络凭据也能测完整 git 隔离链路。
 */
const DB = 'postgres://tds@127.0.0.1:5433/tds';
const REPO = 'file:///D:/AI/todos/clone/.tmp/testrepo';

const newId = () => crypto.randomBytes(18).toString('base64url');
const now = () => Date.now();

const sql = postgres(DB, { max: 1 });
const kek = crypto.createHash('sha256').update('tds-dev-kek-do-not-use-in-prod').digest();
const hashApiKey = (k: string) => crypto.createHmac('sha256', kek).update(k).digest('hex');

const ts = now();
const teamId = newId();
const userId = newId();
const memberId = newId();
const projectId = newId();
const agentId = newId();
const todoId = newId();
const buildId = newId();
const stepId = newId();
const enrollKey = `tds_${crypto.randomBytes(24).toString('base64url')}`;

await sql.begin(async (tx) => {
  await tx`INSERT INTO "user" (id,email,display_name,created_at,updated_at)
            VALUES (${userId}, ${'git-e2e@test.local'}, ${'Git E2E'}, ${ts}, ${ts})`;
  await tx`INSERT INTO team (id,name,plan,created_at) VALUES (${teamId}, ${'Git E2E'}, ${'free'}, ${ts})`;
  await tx`INSERT INTO member (id,team_id,actor_id,member_type,role,joined_at)
            VALUES (${memberId}, ${teamId}, ${userId}, ${'user'}, ${'admin'}, ${ts})`;
  await tx`INSERT INTO api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
            VALUES (${newId()}, ${userId}, ${teamId}, ${enrollKey.slice(0, 12)},
                    ${hashApiKey(enrollKey)}, ${['machine:enroll']}, ${ts})`;

  await tx`INSERT INTO project (id,team_id,name,provider,repo_kind,repo_full_name,repo_url,
                                default_branch,next_seq_num,created_at)
            VALUES (${projectId}, ${teamId}, ${'testrepo'}, ${'external'}, ${'other'},
                    ${'local/testrepo'}, ${REPO}, ${'main'}, ${2}, ${ts})`;

  await tx`INSERT INTO agent (id,team_id,display_name,description,created_at,updated_at)
            VALUES (${agentId}, ${teamId}, ${'Coder'}, ${'Writes code.'}, ${ts}, ${ts})`;

  await tx`INSERT INTO todo (id,project_id,seq_num,owner_member_id,agent_id,title,spec,
                             phase,plan_first,created_at,updated_at)
            VALUES (${todoId}, ${projectId}, ${1}, ${memberId}, ${agentId},
                    ${'Add a version bump helper'},
                    ${'Create src/version.ts exporting a function bumpMajor(current: string): string that increments the major version. Also update src/index.ts to re-export it.'},
                    ${'todo'}, ${true}, ${ts}, ${ts})`;

  await tx`INSERT INTO build (id,todo_id,n,branch,prev_phase,trigger_source,agent_id,session,created_at)
            VALUES (${buildId}, ${todoId}, ${1}, ${`tds/conv-${buildId}`}, ${'todo'}, ${'user'}, ${agentId},
                    ${sql.json({ runtime: 'claude-code', id: newId(), openedAt: ts })}, ${ts})`;

  await tx`INSERT INTO step (id,build_id,machine_id,status)
            VALUES (${stepId}, ${buildId}, ${null}, ${'queued'})`;
});

console.log(JSON.stringify({ teamId, enrollKey, todoId, buildId, stepId }, null, 2));
await sql.end();
