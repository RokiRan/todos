import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectDiff, commitAll, prepareWorkspace, pushBranch, remoteKey } from '../src/git.js';

/**
 * git 隔离层的真实验证。
 *
 * 这层刚修过两个真 bug，都因为 shell:true 让 cmd.exe 二次解析：
 *   1. `git commit -m "多行 message"` 被拆成 pathspec 'a' 'version' 'bump'
 *   2. 含 `v.split(".")` 的 prompt 失真
 * 所以这里用**真实 git 仓库**跑，不用 mock。
 */

const exec = promisify(execFile);

let sourceRepo: string;
let tmpRoot: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tds-git-test-'));
  sourceRepo = path.join(tmpRoot, 'source');

  fs.mkdirSync(path.join(sourceRepo, 'src'), { recursive: true });
  await git(sourceRepo, 'init', '-q', '-b', 'main');
  await git(sourceRepo, 'config', 'user.email', 't@test.local');
  await git(sourceRepo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(sourceRepo, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(sourceRepo, 'src', 'index.ts'), "export const v = '0.0.1';\n");
  await git(sourceRepo, 'add', '-A');
  await git(sourceRepo, 'commit', '-q', '-m', 'initial');
});

after(() => {
  // TDS_HOME 指向临时目录，避免污染真实 ~/.tds
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function repoUrl(): string {
  // Windows 下用 file:/// 正斜杠形式
  return `file:///${sourceRepo.replace(/\\/g, '/')}`;
}

describe('remoteKey 稳定性', () => {
  test('同一 URL 产出相同 key', () => {
    assert.equal(remoteKey('https://gitlab.com/a/b.git'), remoteKey('https://gitlab.com/a/b.git'));
  });

  test('不同 URL 产出不同 key', () => {
    assert.notEqual(remoteKey('https://gitlab.com/a/b.git'), remoteKey('https://gitlab.com/a/c.git'));
  });

  test('key 不含路径分隔符（不能直接当目录名）', () => {
    const k = remoteKey('https://gitlab.com/a/b.git');
    assert.ok(!k.includes('/'), `含分隔符: ${k}`);
    assert.ok(!k.includes('\\'), `含分隔符: ${k}`);
  });
});

describe('prepareWorkspace —— 隔离分支', () => {
  test('工作区落在 build 分支上，源仓库不受影响', async () => {
    const branch = 'tds/conv-test-branch-1';
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch },
      'build-test-1',
    );

    const current = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    assert.equal(current, branch, '必须在 build 分支上');

    // 源仓库仍在 main，且未被污染
    const srcBranch = (await git(sourceRepo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    assert.equal(srcBranch, 'main');
    const status = (await git(sourceRepo, 'status', '--porcelain')).trim();
    assert.equal(status, '', '源仓库必须干净');
  });

  test('工作区能看到 base 分支的内容', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-test-branch-2' },
      'build-test-2',
    );
    assert.ok(fs.existsSync(path.join(cwd, 'README.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'src', 'index.ts')));
  });

  test('复用同一 buildId 时幂等（不重复 clone）', async () => {
    const spec = { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-test-branch-3' };
    const a = await prepareWorkspace(spec, 'build-test-3');
    fs.writeFileSync(path.join(a.cwd, 'scratch.txt'), 'x');
    const b = await prepareWorkspace(spec, 'build-test-3');

    assert.equal(a.cwd, b.cwd, '应复用同一目录');
    // 复用时会 reset --hard，未提交的改动应被清掉
    assert.ok(!fs.existsSync(path.join(b.cwd, 'scratch.txt')), '复用时应重置到干净状态');
  });

  test('不同 buildId 得到互相隔离的目录', async () => {
    const url = repoUrl();
    const a = await prepareWorkspace({ url, baseBranch: 'main', branch: 'tds/conv-iso-a' }, 'iso-a');
    const b = await prepareWorkspace({ url, baseBranch: 'main', branch: 'tds/conv-iso-b' }, 'iso-b');

    assert.notEqual(a.cwd, b.cwd);
    fs.writeFileSync(path.join(a.cwd, 'only-in-a.txt'), 'x');
    assert.ok(!fs.existsSync(path.join(b.cwd, 'only-in-a.txt')), 'B 目录不应看到 A 的文件');
  });
});

describe('commitAll', () => {
  test('提交新增文件并返回 sha', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-commit-1' },
      'commit-1',
    );
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'src', 'version.ts'),
      'export const bumpMajor = (v: string): string => v.split(".")[0];\n',
    );

    const result = await commitAll(cwd, 'Add version helper\n\nwith quotes "inside" and (parens)');

    assert.equal(result.committed, true);
    assert.ok(result.commitSha, '应返回 commit sha');
    assert.match(result.commitSha!, /^[0-9a-f]{40}$/);
  });

  test('无改动时 committed=false 且不报错', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-commit-2' },
      'commit-2',
    );
    const result = await commitAll(cwd, 'nothing changed');
    assert.equal(result.committed, false);
    assert.ok(result.commitSha, '仍应返回当前 HEAD');
  });

  test('多行 message 完整写入（shell 拆参 bug 的回归测试）', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-commit-3' },
      'commit-3',
    );
    fs.writeFileSync(path.join(cwd, 'multi.txt'), 'x');

    const message = 'Title line\n\nBody with a version bump helper\nAnd more text';
    await commitAll(cwd, message);

    const actual = (await git(cwd, 'log', '-1', '--pretty=%B')).trim();
    assert.equal(actual, message.trim(), 'commit message 必须逐字保留，不能被 cmd 拆开');
  });
});

describe('collectDiff', () => {
  test('新文件产生完整 diff', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-diff-1' },
      'diff-1',
    );
    fs.writeFileSync(
      path.join(cwd, 'src', 'version.ts'),
      'export const bumpMajor = (v: string): string => { const [m] = v.split("."); return String(Number(m) + 1); };\n',
    );
    await commitAll(cwd, 'add version');

    const d = await collectDiff(cwd, 'origin/main');
    assert.equal(d.filesChanged, 1);
    assert.equal(d.insertions, 1);
    assert.equal(d.truncated, false);
    assert.ok(d.diff.includes('bumpMajor'), 'diff 应包含新增内容');
    // 引号必须完整保留 —— 这是 shell 失真 bug 的核心断言
    assert.ok(d.diff.includes('v.split(".")'), `diff 中的引号被破坏:\n${d.diff}`);
  });

  test('无改动时统计为零且不截断', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-diff-2' },
      'diff-2',
    );
    const d = await collectDiff(cwd, 'origin/main');
    assert.equal(d.filesChanged, 0);
    assert.equal(d.truncated, false);
  });

  test('删除与修改都能统计', async () => {
    const { cwd } = await prepareWorkspace(
      { url: repoUrl(), baseBranch: 'main', branch: 'tds/conv-diff-3' },
      'diff-3',
    );
    fs.unlinkSync(path.join(cwd, 'README.md'));
    fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), "export const v = '9.9.9';\n");
    await commitAll(cwd, 'modify and delete');

    const d = await collectDiff(cwd, 'origin/main');
    assert.equal(d.filesChanged, 2);
    assert.ok(d.insertions > 0);
    assert.ok(d.deletions > 0);
  });
});

describe('pushBranch —— build 分支真能进 origin', () => {
  /** 在工作区写一个文件并提交，返回 commit sha。 */
  async function commitSomething(cwd: string, file: string, msg: string): Promise<string> {
    fs.writeFileSync(path.join(cwd, file), `${file} 内容\n`);
    const r = await commitAll(cwd, msg);
    assert.ok(r.commitSha, 'commit 必须返回 sha');
    return r.commitSha!;
  }

  test('push 后真仓库有这条分支，tip 等于工作区 HEAD', async () => {
    const branch = 'tds/conv-push-1';
    const spec = { url: repoUrl(), baseBranch: 'main', branch };
    const { cwd } = await prepareWorkspace(spec, 'push-1');
    const sha = await commitSomething(cwd, 'pushed.txt', 'push test 1');

    const r = await pushBranch(cwd, spec);
    assert.equal(r.pushed, true, `push 应成功：${r.error}`);
    assert.equal(r.headSha, sha, 'headSha 必须是工作区 HEAD');

    // **用户可见的判据**：真仓库里这条分支存在，且 tip 就是那个 commit。
    // 修复前这一步永远做不到（daemon 从不 push）。
    const srcTip = (await git(sourceRepo, 'rev-parse', `refs/heads/${branch}`)).trim();
    assert.equal(srcTip, sha, '真仓库的分支 tip 必须等于工作区 HEAD');

    // 第①跳的副作用：remote-tracking ref 也前进，rerun 复用工作区时
    // `reset --hard origin/<branch>` 才不会倒退（`sync-branch.ts` 的守卫靠它）。
    const tracked = (await git(cwd, 'rev-parse', `refs/remotes/origin/${branch}`)).trim();
    assert.equal(tracked, sha, 'origin/<branch> 必须被更新');

    // push 不许动 base 分支
    const srcHead = (await git(sourceRepo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    assert.equal(srcHead, 'main', 'push 不该切走源仓库 HEAD');
  });

  test('再 push 一次（无新 commit）仍算已推 —— 判据是远端 tip，不是退出码', async () => {
    const branch = 'tds/conv-push-2';
    const spec = { url: repoUrl(), baseBranch: 'main', branch };
    const { cwd } = await prepareWorkspace(spec, 'push-2');
    const sha = await commitSomething(cwd, 'pushed2.txt', 'push test 2');

    const first = await pushBranch(cwd, spec);
    assert.equal(first.pushed, true, `首次 push 应成功：${first.error}`);

    // 第二次 git 会回 `Everything up-to-date`（退出码 0 但什么都没推）。
    // 靠退出码判成功的实现这里会翻车；靠 tip 对账的实现仍如实回已推。
    const again = await pushBranch(cwd, spec);
    assert.equal(again.pushed, true, `重复 push 应仍算已推：${again.error}`);
    assert.equal(again.headSha, sha);
  });

  test('真远端被别人推过时拒绝，且不覆盖别人的 commit', async () => {
    const branch = 'tds/conv-push-3';
    const spec = { url: repoUrl(), baseBranch: 'main', branch };
    const { cwd } = await prepareWorkspace(spec, 'push-3');
    const localSha = await commitSomething(cwd, 'local.txt', 'agent commit');

    // 模拟「另一台机器 / 用户在 IDE 里直接往这条分支推了一个 commit」：
    // 直接在真仓库上开同名分支并多提交一个。
    await git(sourceRepo, 'checkout', '-q', '-b', branch);
    fs.writeFileSync(path.join(sourceRepo, 'theirs.txt'), '别人的 commit\n');
    await git(sourceRepo, 'add', '-A');
    await git(sourceRepo, 'commit', '-q', '-m', 'theirs');
    const theirSha = (await git(sourceRepo, 'rev-parse', 'HEAD')).trim();
    await git(sourceRepo, 'checkout', '-q', 'main');

    const r = await pushBranch(cwd, spec);
    assert.equal(r.pushed, false, '非 fast-forward 必须判未推');
    assert.ok(r.error, '必须带失败原因');
    assert.match(r.error!, /rejected|non-fast-forward|fetch first/, `error=${r.error}`);

    // **不许 force**：真仓库的 tip 必须还是别人的 commit，不能被 agent 覆盖。
    const srcTip = (await git(sourceRepo, 'rev-parse', `refs/heads/${branch}`)).trim();
    assert.equal(srcTip, theirSha, '不许覆盖别人的 commit');
    assert.notEqual(srcTip, localSha);
  });

  test('远端不可达时如实报错，不假装成功', async () => {
    const branch = 'tds/conv-push-4';
    const good = { url: repoUrl(), baseBranch: 'main', branch };
    const { cwd } = await prepareWorkspace(good, 'push-4');
    await commitSomething(cwd, 'pushed4.txt', 'push test 4');

    // 工作区的 origin 是**真** URL 对应的缓存；换成一个不存在的 URL 后，
    // 第①跳（→ 缓存）仍会成功，第②跳（→ 真 URL）必然失败。
    const bogus = {
      ...good,
      url: `file:///${path.join(tmpRoot, 'no-such-repo').replace(/\\/g, '/')}`,
    };
    const r = await pushBranch(cwd, bogus);
    assert.equal(r.pushed, false, '远端不可达绝不能报已推');
    assert.match(r.error!, /push to remote failed/, `error=${r.error}`);
    assert.ok(r.headSha, '失败时也要带本地 HEAD 供对账');
  });
});
