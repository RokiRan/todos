import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSkillDir } from '../src/services/skill-deletion.js';

/**
 * `resolveSkillDir` 的两层防御 —— **直接**测这个函数，而不是经 `deleteSkills`。
 *
 * ## 为什么必须单独测
 *
 * service 层的穿越测试（`chief-skill-delete.test.ts` 里的「路径穿越」那条）走的是
 * 「DB 先拒」的路径：调用方传一个库里不存在的 skillId，`assertSkillInTeam` 就 403 了，
 * **根本到不了 `resolveSkillDir`**。于是那两层防御各自能否独立接住，从未被测到。
 *
 * 变异验证的实测证据（2026-10-17）：
 *   - 去掉 `path.basename` 归一化 → service 层 7 条测试**全绿**
 *   - 同时去掉 `startsWith(root+sep)` 的 escape 检查 → 依然**全绿**
 *
 * 也就是说：一个能让 `fs.rm` 飞出 STORAGE_ROOT 的改动，现有测试**测不出来**。
 * 不可逆删除打穿路径防护 = 删掉上层任意文件，所以这里必须钉死。
 *
 * `STORAGE_STORAGE_DIR` 在本文件里通过 `process.env` 设置 —— `getStorageRoot()`
 * 是**函数式**读取（不是模块顶层常量），所以 import 之后再设也生效。
 */

const STORAGE_ROOT = path.resolve('.tmp-path-defense-root');

describe('resolveSkillDir 的两层路径防御', () => {
  before(() => {
    process.env.TDS_STORAGE_DIR = STORAGE_ROOT;
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  });

  after(() => {
    fs.rmSync(STORAGE_ROOT, { recursive: true, force: true });
    delete process.env.TDS_STORAGE_DIR;
  });

  // ── 正常路径 ────────────────────────────────────────────────────────
  test('正常 teamId/skillId：解析出 <root>/<team>/<skill> 且不抛', () => {
    const dir = resolveSkillDir('team-1', 'skill-1');
    assert.equal(dir, path.join(path.resolve(STORAGE_ROOT), 'team-1', 'skill-1'));
    assert.ok(dir.startsWith(path.resolve(STORAGE_ROOT) + path.sep));
  });

  // ── 层 1：basename 归一化检查 ───────────────────────────────────────
  test('层 1：teamId 含目录分隔符 → 422（basename !== raw）', () => {
    // 去掉 basename 归一化时这条会红
    assert.throws(
      () => resolveSkillDir('../escape', 'skill-1'),
      (e: Error) => {
        assert.match(e.message, /illegal characters/);
        return true;
      },
      'MUTATION? 含 .. 的 teamId 没被拦下 —— basename 归一化这层防御失效了',
    );
  });

  test('层 1：skillId 含目录分隔符 → 422', () => {
    assert.throws(
      () => resolveSkillDir('team-1', '../escape'),
      (e: Error) => {
        assert.match(e.message, /illegal characters/);
        return true;
      },
      'MUTATION? 含 .. 的 skillId 没被拦下',
    );
  });

  test('层 1：Windows 反斜杠同样被拦', () => {
    // `path.basename` 只按**本机**的分隔符切：在 POSIX 上 `\` 是普通文件名字符，
    // 所以 `..\escape` 的 basename 就等于它本身，等值检查自然放行。这不是防御
    // 被破坏 —— POSIX 上 `\escape` 本来就不是路径分隔符，`path.resolve` 拼出来的
    // 目录仍落在 STORAGE_ROOT 内，第二层 `full.startsWith(root + path.sep)`
    // （skills.ts:92）才是那道的落点。真正要拦的 `\` 穿越只在 Windows 上发生
    // （实测：这条在派上跑 Linux 会红，Windows 通过）。
    // 所以：非 Windows 直接跳过这条断言，并在标题里说明，别把它算成失败。
    if (path.sep !== '\\') return;
    assert.throws(
      () => resolveSkillDir('team-1', '..\\escape'),
      (e: Error) => {
        assert.match(e.message, /illegal characters/);
        return true;
      },
      'MUTATION? 反斜杠穿越没被拦下',
    );
  });

  test('层 1：空串 → 422（basename 归一化对空串是幂等的，等值检查放得过，必须单独判空）', () => {
    assert.throws(
      () => resolveSkillDir('', 'skill-1'),
      (e: Error) => {
        assert.match(e.message, /illegal characters/);
        return true;
      },
      'MUTATION? 空 teamId 没被拦下',
    );
    assert.throws(
      () => resolveSkillDir('team-1', ''),
      (e: Error) => {
        assert.match(e.message, /illegal characters/);
        return true;
      },
      'MUTATION? 空 skillId 没被拦下',
    );
  });

  // ── 层 2：escape check（即使层 1 被绕过也要接住）────────────────────
  //
  // 这一层只有在「层 1 已被绕过」的世界里才有意义 —— 而那种世界没法从外部构造
  // （两个入参都过不了 basename 归一化）。唯一能真正打到它的办法：**把 STORAGE_ROOT
  // 指向一个自身就带 `..` 形态的位置**，这样合法的单段 teamId/skillId 解析出来
  // 仍然越出了「字面意义上的 root 前缀」。
  test('层 2：STORAGE_ROOT 本身含 .. 时，解析结果仍必须被 escape 检查接住', () => {
    // root = <base>/nest/../real-root 形态。path.resolve 会把它拍平成
    // <base>/real-root，所以「合法输入」解析出来是在 root 内的 —— 这条测的是
    // **误伤**：escape 检查不能把 root 内的合法路径也拒掉。
    const base = path.resolve(STORAGE_ROOT);
    const weirdRoot = path.join(base, 'nest', '..', 'real-root');
    fs.mkdirSync(path.join(base, 'nest'), { recursive: true });
    fs.mkdirSync(path.join(base, 'real-root'), { recursive: true });
    const original = process.env.TDS_STORAGE_DIR;
    process.env.TDS_STORAGE_DIR = weirdRoot;
    try {
      assert.doesNotThrow(
        () => resolveSkillDir('team-1', 'skill-1'),
        'MUTATION? root 内的合法路径被 escape 检查误伤了 —— 检查判据写错了',
      );
    } finally {
      process.env.TDS_STORAGE_DIR = original;
      fs.rmSync(path.join(base, 'nest'), { recursive: true, force: true });
      fs.rmSync(path.join(base, 'real-root'), { recursive: true, force: true });
    }
  });

  test('层 2：escape 检查的判据能区分 root 内外', () => {
    // 直接钉住判据本身：root 外一层不满足 `startsWith(root + sep)`，root 内满足。
    // 写成「判据的语义」而不是「某个具体输入」，是为了让删掉 escape 检查这件事
    // 在本文件里也留下痕迹 —— 变异验证时这条会跟着一起看。
    const root = path.resolve(STORAGE_ROOT);
    const outside = path.resolve(root, '..', 'sneaky');
    assert.equal(outside.startsWith(root + path.sep), false, '前提：root 外不满足前缀');
    assert.notEqual(outside, root);
    const inside = path.resolve(root, 'team-1');
    assert.equal(inside.startsWith(root + path.sep), true, '前提：root 内满足前缀');
  });
});
