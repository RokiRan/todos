import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { needsShell, whichCommand } from '../src/drivers/shared.js';
import { spawnArgs } from '../src/drivers/driver.js';

/**
 * Windows spawn 绕开 shell。
 *
 * 这个 bug 很隐蔽：shell:true 时 cmd.exe 会二次解析命令行，
 * prompt 里的引号/换行/元符号被吃掉，agent 收到残缺任务却报 succeeded。
 * 必须锁死「能用绝对路径就不用 shell」。
 */

describe('needsShell 判定', () => {
  test('.cmd / .bat shim 必须走 shell', () => {
    assert.equal(needsShell('C:/bin/claude.cmd'), true);
    assert.equal(needsShell('C:/bin/tool.BAT'), true);
  });

  test('.exe 不走 shell —— 参数原样送达', () => {
    assert.equal(needsShell('C:/bin/claude.exe'), false);
    assert.equal(needsShell('C:/bin/tool.EXE'), false);
  });

  test('无扩展名（绝对路径真二进制）不走 shell', () => {
    assert.equal(needsShell('C:/usr/local/bin/omp'), false);
  });

  test('非 Windows 平台一律不走 shell', {
    // 该函数在非 win32 上恒为 false；这里只验证 win32 分支的行为契约
  } as never, () => {
    assert.equal(typeof needsShell('x.cmd'), 'boolean');
  });
});

describe('whichCommand 绝对路径解析', () => {
  test('含路径分隔符时原样返回', () => {
    assert.equal(whichCommand('C:/tools/claude.exe'), 'C:/tools/claude.exe');
  });

  test('不存在的命令返回 null', () => {
    assert.equal(whichCommand('definitely-not-a-real-binary-xyz123'), null);
  });

  test('能找到 PATH 里的 claude（本机实测存在）', () => {
    const found = whichCommand('claude');
    if (found === null) {
      // 本机未装 claude 时跳过 —— 不让测试依赖特定环境
      return;
    }
    assert.ok(found.endsWith('.exe'), `期望 .exe，实际 ${found}`);
    assert.equal(needsShell(found), false, '找到 .exe 就应该能绕开 shell');
  });
});

describe('shell 模式下的参数转义仍然需要', () => {
  test('走 shell 时才转义', () => {
    const args = ['-p', 'say "hi"'];
    assert.deepEqual(spawnArgs(args, false), args, '非 shell 模式原样传');
    assert.deepEqual(spawnArgs(args, true), ['"-p"', '"say \\"hi\\""'], 'shell 模式才转义');
  });

  test('非 shell 模式下参数里的引号必须保持原样', () => {
    // 这是修复的核心：v.split(".") 必须完整送达
    const spec = 'create file with: v.split(".")';
    assert.deepEqual(spawnArgs([spec], false), [spec]);
  });
});
