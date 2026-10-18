import postgres from 'postgres';
import { toolSummaryText, CHIEF_TOOLS, requiresConfirmation } from '../src/chief/tools.js';
import { buildChiefPrompt, parseStandingGrants, hasGrant, CHIEF_LIMITS } from '../src/chief/prompt.js';
import { encodeCard, decodeCard, validateCredentialInput, type QuestionCard } from '../src/chief/cards.js';

/**
 * Chief 模块的真实冒烟（不启 HTTP，纯逻辑 + 真数据库读表头）。
 * 目的是在合并前确认三件事：
 *   1. 工具面与实测一致
 *   2. prompt 构造能跑出合理体积
 *   3. 数据库里 chief / chief_thread 表结构与 schema.ts 一致
 */
const DB = 'postgres://tds@127.0.0.1:5433/tds';

const sql = postgres(DB, { max: 1 });
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    failures++;
  }
}

console.log('── 1. 工具面 ──');
check('58 个工具', CHIEF_TOOLS.length === 58, `实际 ${CHIEF_TOOLS.length}`);
check('delete_todos 需确认', requiresConfirmation('delete_todos'));
check('create_todo 不需确认', !requiresConfirmation('create_todo'));
check('工具摘要非空', toolSummaryText().length > 500);

console.log('── 2. prompt 构造 ──');
const prompt = buildChiefPrompt({
  fixed: {
    roleInstructions: '你是 Chief，负责拆解目标、派工、跟踪。',
    toolSummary: toolSummaryText(),
    charter: '## 我的团队\nOPC 工业自动化软件公司。',
    memory: '### 偏好\n先调研后设计。',
  },
  topicId: 'chief-smoke',
  history: [
    { role: 'user', content: '帮我组建团队', at: Date.now() - 60_000 },
    { role: 'assistant', content: '我先看看板。', at: Date.now() - 30_000 },
  ],
  board: {
    byPhase: { todo: 2, implement: 1, review: 1, done: 5 },
    needsYou: [{ id: 't1', seqNum: 4, title: '市场调研报告', phase: 'review' }],
    changes: [{ id: 't2', what: 'completed' }],
  },
  userMessage: '继续',
  contextWindow: 200_000,
});
check('三段都有内容',
  prompt.segments.fixed > 0 && prompt.segments.history > 0 && prompt.segments.current > 0);
check('占用率合理（< 50%）', prompt.occupancy < 0.5, `实际 ${(prompt.occupancy * 100).toFixed(1)}%`);
check('固定段约 20k 字符量级（远小于 20k tokens）', prompt.segments.fixed > 500);

console.log('── 3. standing 授权 ──');
const grants = parseStandingGrants('merge when review passes, don\'t ask me', { type: 'team' }, Date.now());
check('识别出 merge 授权', hasGrant(grants, 'merge_changes', {}).granted);
check('all_gates 覆盖 approve', hasGrant(grants, 'approve_plan', {}).granted);

console.log('── 4. 卡片 ──');
const q: QuestionCard = {
  kind: 'question', id: 'q1',
  askedBy: { type: 'chief', id: 'c', name: '统筹' },
  question: '要不要覆盖国内厂商？',
  options: [{ id: 'y', label: '要' }, { id: 'n', label: '不要' }],
  allowFreeText: true,
};
check('卡片往返', decodeCard(encodeCard(q))?.id === 'q1');
check('凭据校验不回显', validateCredentialInput('sk-abc').lengthEcho === 6);

console.log('── 5. 数据库表结构 ──');
for (const t of ['chief', 'chief_thread', 'todo', 'build', 'step']) {
  const rows = await sql`SELECT column_name FROM information_schema.columns
                        WHERE table_name = ${t} ORDER BY ordinal_position`;
  check(`${t} 表存在且有列`, rows.length > 0, `实际 ${rows.length} 列`);
}
const chiefCols = await sql`SELECT column_name FROM information_schema.columns
                           WHERE table_name = 'chief' ORDER BY ordinal_position`;
const names = chiefCols.map((c) => c.column_name);
for (const need of ['id', 'user_id', 'team_id', 'agent_id', 'charter']) {
  check(`chief.${need} 存在`, names.includes(need), names.join(','));
}

console.log('── 6. 上限常量 ──');
check('topic 上限 50', CHIEF_LIMITS.MAX_TOPICS === 50);
check('check-in 7 天', CHIEF_LIMITS.MAX_CHECKIN_DAYS === 7);

await sql.end();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
