import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { quoteForCmd, spawnArgs } from '../src/drivers/driver.js';

/**
 * Windows cmd 参数转义。
 *
 * 这个 bug 真实发生过：prompt 里含换行/引号时，shell:true 会让 cmd.exe
 * 截断或重组参数，导致 agent 收到残缺的任务描述。
 */

describe('cmd 参数转义', () => {
  test('普通参数加引号', () => {
    assert.equal(quoteForCmd('hello'), '"hello"');
  });

  test('含空格的整体仍是一个参数', () => {
    assert.equal(quoteForCmd('--permission-mode acceptEdits'), '"--permission-mode acceptEdits"');
  });

  test('内部双引号被转义', () => {
    assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  });

  test('百分号被转义（防环境变量展开）', () => {
    assert.equal(quoteForCmd('100% done'), '"100%% done"');
  });

  test('换行保留在引号内', () => {
    const prompt = 'line1\nline2';
    const q = quoteForCmd(prompt);
    assert.ok(q.startsWith('"') && q.endsWith('"'));
    assert.ok(q.includes('\n'));
  });

  test('cmd 元字符在引号内是字面量', () => {
    const q = quoteForCmd('a & b | c > d');
    assert.equal(q, '"a & b | c > d"');
  });

  test('结尾反斜杠翻倍，不吃掉闭合引号', () => {
    const q = quoteForCmd('path\\');
    assert.ok(q.endsWith('\\\\"'), `结尾反斜杠应翻倍，得到 ${q}`);
  });

  test('反斜杠后的引号被正确转义', () => {
    const q = quoteForCmd('a\\"b');
    assert.ok(q.includes('\\"'), `应转义引号，得到 ${q}`);
  });
});

describe('spawnArgs', () => {
  test('shell 模式逐个转义', () => {
    const args = ['-p', '--verbose', 'the prompt'];
    assert.deepEqual(spawnArgs(args, true), ['"-p"', '"--verbose"', '"the prompt"']);
  });

  test('非 shell 模式原样返回', () => {
    const args = ['-p', 'the prompt'];
    assert.deepEqual(spawnArgs(args, false), args);
  });

  test('空数组两种模式都返回空', () => {
    assert.deepEqual(spawnArgs([], true), []);
    assert.deepEqual(spawnArgs([], false), []);
  });
});
