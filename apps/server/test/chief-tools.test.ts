import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  CHIEF_TOOLS,
  CHIEF_TOOL_COUNT,
  chiefToolSpec,
  handlesSecret,
  requiresConfirmation,
  toolSummaryText,
} from '../src/chief/tools.js';

/**
 * 工具面必须与实测清单逐字一致。
 * 这是从 recon/03-app-api.md §3 的 toolDefHashes 键名抄下来的，
 * 少一个、多一个、拼错一个，都会让复刻与原站产生行为差异。
 */

/** recon/03-app-api.md §3 实测的 58 个工具名（verbatim） */
const RECON_TOOLS = [
  'update_project', 'set_wake', 'projects', 'delete_skills', 'clear_wake',
  'usage', 'update_mcp_server', 'watch_todos', 'connect_app', 'issues',
  'skills', 'pull_requests', 'add_provider', 'merge_builds', 'create_project',
  'delete_mcp_servers', 'docs', 'ask_user', 'conversation', 'notify_user',
  'message_todo', 'save_memory', 'delete_providers', 'update_todo', 'secrets',
  'close_todos', 'connect_repo', 'complete_todos', 'create_todo', 'reopen_todos',
  'delete_agents', 'set_remote_shell', 'add_mcp_server', 'delete_memory',
  'update_agent', 'attachment', 'update_provider', 'schedules', 'workflow_runs',
  'cancel_builds', 'memories', 'set_secret', 'unschedule_todo', 'mcp_servers',
  'delete_secrets', 'confirm_builds', 'agents', 'unwatch_todos', 'schedule_todo',
  'run_builds', 'create_agent', 'delete_todos', 'wakes', 'run_review',
  'relay_question', 'todos', 'machines', 'providers',
];

describe('工具面与实测一致', () => {
  test('数量为 58', () => {
    assert.equal(CHIEF_TOOL_COUNT, 58);
    assert.equal(RECON_TOOLS.length, 58);
  });

  test('无缺失', () => {
    const mine = new Set(CHIEF_TOOLS.map((t) => t.name));
    const missing = RECON_TOOLS.filter((n) => !mine.has(n));
    assert.deepEqual(missing, [], `缺失工具: ${missing.join(' ')}`);
  });

  test('无多余', () => {
    const recon = new Set(RECON_TOOLS);
    const extra = CHIEF_TOOLS.map((t) => t.name).filter((n) => !recon.has(n));
    assert.deepEqual(extra, [], `多余工具: ${extra.join(' ')}`);
  });

  test('无重复声明', () => {
    const names = CHIEF_TOOLS.map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, [], `重复: ${dupes.join(' ')}`);
  });

  test('每个工具都有中文说明', () => {
    for (const t of CHIEF_TOOLS) {
      assert.ok(t.summary.length > 0, `${t.name} 缺说明`);
      assert.ok(t.summary !== t.name, `${t.name} 说明不应是名字本身`);
    }
  });
});

describe('不可逆操作必须走确认卡', () => {
  test('六类删除被标为不可逆', () => {
    const irreversible = CHIEF_TOOLS.filter((t) => t.irreversible).map((t) => t.name).sort();
    assert.deepEqual(irreversible, [
      'delete_agents',
      'delete_mcp_servers',
      'delete_providers',
      'delete_secrets',
      'delete_skills',
      'delete_todos',
    ]);
  });

  test('requiresConfirmation 逐个正确', () => {
    assert.equal(requiresConfirmation('delete_todos'), true);
    assert.equal(requiresConfirmation('delete_agents'), true);
    assert.equal(requiresConfirmation('delete_secrets'), true);
  });

  test('非删除类操作不需要确认卡', () => {
    for (const n of ['create_todo', 'update_todo', 'run_builds', 'save_memory', 'ask_user']) {
      assert.equal(requiresConfirmation(n), false, `${n} 不该要确认卡`);
    }
  });

  test('未知工具返回 undefined 而不是误判为需确认', () => {
    assert.equal(requiresConfirmation('no_such_tool'), false);
    assert.equal(chiefToolSpec('no_such_tool'), undefined);
  });
});

describe('凭据类工具', () => {
  test('八个凭据工具被标记', () => {
    const secretTools = CHIEF_TOOLS.filter((t) => t.handlesSecret).map((t) => t.name).sort();
    assert.deepEqual(secretTools, [
      'add_mcp_server', 'add_provider', 'connect_app', 'connect_repo',
      'secrets', 'set_secret', 'update_mcp_server', 'update_provider',
    ]);
  });

  test('写类凭据工具需 admin，读 secrets 例外（member 可看名称）', () => {
    // 文档：常规成员可看 secret 名称与描述，只是不能改
    assert.notEqual(chiefToolSpec('secrets')?.needsAdminGrant, true,
      '读 secret 名称是只读操作，member 也可看');
    for (const t of CHIEF_TOOLS.filter((x) => x.handlesSecret && x.name !== 'secrets')) {
      assert.equal(t.needsAdminGrant, true, `${t.name} 写入凭据，必须限 admin`);
    }
  });

  test('handlesSecret 逐个正确', () => {
    assert.equal(handlesSecret('set_secret'), true);
    assert.equal(handlesSecret('todos'), false);
  });
});

describe('工具摘要串（prefix cache 友好）', () => {
  test('按组列出且稳定', () => {
    const s = toolSummaryText();
    assert.ok(s.includes('todo:'), s.slice(0, 80));
    assert.ok(s.includes('interaction:'));
  });

  test('两次调用结果完全一致（缓存前缀必须稳定）', () => {
    assert.equal(toolSummaryText(), toolSummaryText());
  });

  test('每个工具都出现在摘要里', () => {
    const s = toolSummaryText();
    for (const t of CHIEF_TOOLS) {
      assert.ok(s.includes(t.name), `摘要缺 ${t.name}`);
    }
  });
});
