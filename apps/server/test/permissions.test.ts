import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  canManageTodoSchedule,
  canRunOn,
  canUseConnection,
  canUseCoreTool,
  canUseElevatedTool,
  hasCapability,
  CORE_TOOLS,
  ELEVATED_TOOLS,
  type Actor,
  type GrantMap,
} from '../src/permissions.js';

const ADMIN: Actor = { role: 'admin', viaChief: false, userExplicitlyRequested: false };
const MEMBER: Actor = { role: 'member', viaChief: false, userExplicitlyRequested: false };
const CHIEF_UNASKED: Actor = { role: 'admin', viaChief: true, userExplicitlyRequested: false };
const CHIEF_ASKED: Actor = { role: 'admin', viaChief: true, userExplicitlyRequested: true };
const CHIEF_AS_MEMBER: Actor = { role: 'member', viaChief: true, userExplicitlyRequested: true };

const GRANTED: GrantMap = { push_branch: true, merge_branch: true, remote_shell: true };
const EMPTY: GrantMap = {};

describe('核心工具默认可用', () => {
  test('7 个核心工具全部免授权', () => {
    for (const t of CORE_TOOLS) {
      assert.equal(canUseCoreTool(t).allowed, true, `${t} 应默认可用`);
    }
  });

  test('核心工具不需要确认卡', () => {
    assert.equal(canUseCoreTool('read_workspace').requiresConfirmation, false);
  });
});

describe('高影响工具默认关闭', () => {
  test('7 个高影响工具未授权时全部拒绝', () => {
    for (const t of ELEVATED_TOOLS) {
      const d = canUseElevatedTool(t, EMPTY, ADMIN);
      assert.equal(d.allowed, false, `${t} 默认必须关闭`);
      assert.ok(d.reason.includes('未授权'), d.reason);
    }
  });

  test('已授权则放行', () => {
    assert.equal(canUseElevatedTool('push_branch', GRANTED, ADMIN).allowed, true);
    assert.equal(canUseElevatedTool('remote_shell', GRANTED, ADMIN).allowed, true);
  });

  test('授权是逐项的 —— 不能用一个推另一个', () => {
    const only: GrantMap = { push_branch: true };
    assert.equal(canUseElevatedTool('push_branch', only, ADMIN).allowed, true);
    assert.equal(canUseElevatedTool('merge_branch', only, ADMIN).allowed, false);
    assert.equal(canUseElevatedTool('create_tag', only, ADMIN).allowed, false);
  });

  test('非 admin 一律不能授权', () => {
    for (const t of ELEVATED_TOOLS) {
      const d = canUseElevatedTool(t, GRANTED, MEMBER);
      assert.equal(d.allowed, false, `${t} 不该给 member`);
    }
  });
});

describe('Chief 绝不自行授予权限', () => {
  test('Chief 代用户请求但用户未明确要求 → 拒绝', () => {
    const d = canUseElevatedTool('merge_branch', GRANTED, CHIEF_UNASKED);
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes('明确请求'), d.reason);
    assert.equal(d.requiresConfirmation, true, '应弹确认卡');
  });

  test('用户明确要求过 → 放行', () => {
    assert.equal(canUseElevatedTool('merge_branch', GRANTED, CHIEF_ASKED).allowed, true);
  });

  test('用户明确要求了但用户自己不是 admin → 仍然拒绝', () => {
    const d = canUseElevatedTool('merge_branch', GRANTED, CHIEF_AS_MEMBER);
    assert.equal(d.allowed, false, 'Chief 的权限不能超过用户本人');
  });

  test('连接授权同样受此约束', () => {
    const g: GrantMap = { connections: { c1: true } };
    assert.equal(canUseConnection('c1', g, CHIEF_UNASKED, 1).allowed, false);
    assert.equal(canUseConnection('c1', g, CHIEF_ASKED, 1).allowed, true);
  });
});

describe('连接授权上限', () => {
  const withConn = (ids: string[]): GrantMap => ({
    connections: Object.fromEntries(ids.map((i) => [i, true])),
  });

  test('每个 connection 独立开关', () => {
    const g = withConn(['c1', 'c2']);
    assert.equal(canUseConnection('c1', g, ADMIN, 2).allowed, true);
    assert.equal(canUseConnection('c3', g, ADMIN, 2).allowed, false, 'c3 未授权');
  });

  test('已授权 10 个后再加第 11 个被拒', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const g = withConn(ids);
    const d = canUseConnection('c10', g, ADMIN, 10);
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes('10'), d.reason);
  });
});

describe('machine 开关', () => {
  const switches = {
    builds: true,
    remoteShell: true,
    runtimes: { 'claude-code': true, codex: false },
  };

  test('builds 关闭则一律不接活', () => {
    const d = canRunOn('claude-code', { ...switches, builds: false }, ADMIN);
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes('关闭'), d.reason);
  });

  test('runtime 被逐个关闭时不接该 runtime 的活', () => {
    assert.equal(canRunOn('claude-code', switches, ADMIN).allowed, true);
    const d = canRunOn('codex', switches, ADMIN);
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes('codex'), d.reason);
  });

  test('未列出的 runtime 默认放行（只有显式 false 才关）', () => {
    assert.equal(canRunOn('omp', switches, ADMIN).allowed, true);
  });

  test('Chief 不能自行改 machine 开关', () => {
    const d = canRunOn('claude-code', switches, CHIEF_UNASKED);
    assert.equal(d.allowed, false);
    assert.equal(d.requiresConfirmation, true);
  });
});

describe('人员角色能力', () => {
  test('member 可看与操作看板', () => {
    assert.equal(hasCapability('member', 'view_board'), true);
    assert.equal(hasCapability('member', 'manage_board'), true);
  });

  test('member 不可配置任何基础设施', () => {
    const adminOnly: Array<Parameters<typeof hasCapability>[1]> = [
      'configure_providers', 'configure_connections', 'configure_skills',
      'configure_secrets', 'configure_agents', 'configure_machines',
      'project_git_credentials', 'remove_agent',
    ];
    for (const cap of adminOnly) {
      assert.equal(hasCapability('member', cap), false, `member 不该能 ${cap}`);
      assert.equal(hasCapability('admin', cap), true, `admin 应该能 ${cap}`);
    }
  });
});

describe('schedule 跟 todo owner 而非 team role', () => {
  test('owner 可以改自己的 schedule', () => {
    assert.equal(canManageTodoSchedule('m1', 'm1').allowed, true);
  });

  test('非 owner 即使是 admin 也不能改', () => {
    const d = canManageTodoSchedule('m-admin', 'm-owner');
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes('owner'), d.reason);
  });
});
