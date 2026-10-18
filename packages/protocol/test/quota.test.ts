import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { quota, firstViolation, fitMemories, MEMORY_INJECT_BUDGET } from '../src/quota.js';
import { FREE_LIMITS } from '../src/entities.js';

describe('Free 档配额边界', () => {
  test('恰好等于上限时拒绝（current < limit 才放行）', () => {
    assert.equal(quota.agents(4).ok, true);
    assert.equal(quota.agents(5).ok, false, '第 5 个 agent 就该被拒');
  });

  test('零配额不误拒', () => {
    assert.equal(quota.agents(0).ok, true);
    assert.equal(quota.projects(0).ok, true);
  });

  test('超出时消息说明当前值与上限', () => {
    const r = quota.projects(6);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('6'), r.message);
    assert.ok(r.message.includes('项目'), r.message);
  });

  test('各维度上限与文档一致', () => {
    assert.equal(FREE_LIMITS.agents, 5);
    assert.equal(FREE_LIMITS.ownMachines, 1);
    assert.equal(FREE_LIMITS.projects, 6);
    assert.equal(FREE_LIMITS.openTodosPerProject, 400);
    assert.equal(FREE_LIMITS.secretsPerScope, 50);
    assert.equal(FREE_LIMITS.connectionsPerTeam, 20);
    assert.equal(FREE_LIMITS.connectionsPerAgent, 10);
    assert.equal(FREE_LIMITS.defaultSkillsPerAgent, 10);
    assert.equal(FREE_LIMITS.memoriesPerAgent, 100);
    assert.equal(FREE_LIMITS.scheduleRulesPerTeam, 10);
    assert.equal(FREE_LIMITS.storageBytes, 1073741824);
  });

  test('角色描述 800 字符边界', () => {
    assert.equal(quota.roleDescription('a'.repeat(800)).ok, true);
    assert.equal(quota.roleDescription('a'.repeat(801)).ok, false);
  });

  test('skill 大小 10MB / 256 文件边界', () => {
    assert.equal(quota.skillSize(10 * 1024 * 1024, 256).ok, true);
    assert.equal(quota.skillSize(10 * 1024 * 1024 + 1, 256).ok, false);
    assert.equal(quota.skillSize(1024, 257).ok, false);
  });

  test('附件 5 个上限', () => {
    assert.equal(quota.attachments(4).ok, true);
    assert.equal(quota.attachments(5).ok, false);
  });

  test('存储 1GB 上限', () => {
    assert.equal(quota.storage(1073741824).ok, true);
    assert.equal(quota.storage(1073741825).ok, false);
  });

  test('机器并发必须是 1–10 的整数', () => {
    assert.equal(quota.machineConcurrency(0).ok, false);
    assert.equal(quota.machineConcurrency(1).ok, true);
    assert.equal(quota.machineConcurrency(10).ok, true);
    assert.equal(quota.machineConcurrency(11).ok, false);
  });
});

describe('firstViolation', () => {
  test('全通过返回 null', () => {
    assert.equal(firstViolation([quota.agents(1), quota.projects(2)]), null);
  });

  test('返回第一个违规项', () => {
    const v = firstViolation([quota.agents(1), quota.projects(99), quota.agents(99)]);
    assert.ok(v);
    assert.equal(v.current, 99);
  });

  test('空数组返回 null', () => {
    assert.equal(firstViolation([]), null);
  });
});

describe('memory 注入预算', () => {
  const entry = (titleLen: number, contentLen: number) => ({
    title: 't'.repeat(titleLen),
    content: 'c'.repeat(contentLen),
  });

  test('总成本在预算内全部注入', () => {
    const entries = [entry(10, 100), entry(10, 100)];
    const { injected, downgraded } = fitMemories(entries);
    assert.equal(injected.length, 2);
    assert.equal(downgraded.length, 0);
  });

  test('超出预算的条目降级为 title-only', () => {
    const entries = Array.from({ length: 200 }, () => entry(10, 2000));
    const { injected, downgraded } = fitMemories(entries);
    assert.ok(injected.length < 200);
    assert.ok(downgraded.length > 0, '必须有条目被降级');
    assert.equal(injected.length + downgraded.length, 200, '不能丢条目');

    // 注入的总成本不超预算
    const used = injected.reduce((s, e) => s + e.title.length + e.content.length, 0);
    assert.ok(used <= MEMORY_INJECT_BUDGET, `注入 ${used} 超过预算 ${MEMORY_INJECT_BUDGET}`);
  });

  test('预算为 10,000 字符（文档实测值）', () => {
    assert.equal(MEMORY_INJECT_BUDGET, 10_000);
  });

  test('空列表不炸', () => {
    const { injected, downgraded } = fitMemories([]);
    assert.equal(injected.length, 0);
    assert.equal(downgraded.length, 0);
  });

  test('单条超预算也不注入（不能注入半条）', () => {
    const { injected, downgraded } = fitMemories([entry(10, 20_000)]);
    assert.equal(injected.length, 0);
    assert.equal(downgraded.length, 1);
  });
});
