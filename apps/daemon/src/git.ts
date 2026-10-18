import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './drivers/shared.js';
import { PATHS } from './paths.js';

/**
 * Git 隔离执行层。
 *
 * 对齐原站的模型（recon/SPEC.md §1）：
 *   每个 build 在 project base 分支上开自己的 `tds/conv-*` 分支，
 *   在隔离的 git worktree 里干活，绝不污染默认分支。
 *
 * 与原站的差异：原站用 `git worktree add` 挂到共享的 clone，
 * 这里 MVP 用 `git clone --local` 的独立副本 —— 语义等价（都隔离），
 * 但避免了 worktree 的共享 index 锁问题。后续可换回 worktree。
 */

export interface RepoSpec {
  /** 仓库地址。外部 Git 用 HTTPS(+token)，本地测试用 file:// 或路径 */
  url: string;
  /** base 分支 */
  baseBranch: string;
  /** 本次 build 的分支名，通常是 tds/conv-<buildId> */
  branch: string;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  // git 是真 exe —— 必须 shell:false。
  // shell:true 会让 cmd.exe 二次解析，把含空格/引号/换行的参数
  // （典型如 commit -m 的多行 message）拆成一堆碎片。
  const r = await runCommand('git', args, { cwd, timeoutMs, shell: false });
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
}

/** 仓库缓存目录：一个 remote 一个，避免每个 build 重新 clone */
function repoCacheDir(url: string): string {
  // 必须走 `remoteKey(url)`。这个函数的作用就是「取末段 + 哈希」把目录名压短并
  // 防撞名，但参数以前叫 `remoteKey`、调用方（`prepareWorkspace` 的
  // `repoCacheDir(spec.url)`）传的却是**原始 URL**，于是目录名成了
  // `file___D_AI_...` 这种长串；`pushBranch` 又按 `remoteKey(url)` 算目录，
  // 两边算出不同路径 → 缓存目录「不存在」→ `spawn git ENOENT`（实测：
  // `cache exists = false`）。现在两个调用方都只传 URL，目录名由这里唯一决定。
  return path.join(PATHS.home, 'repos', remoteKey(url).replace(/[^a-zA-Z0-9._-]/g, '_'));
}

export function remoteKey(url: string): string {
  // 取 URL 末段 + 简单哈希，避免不同仓库撞目录
  let h = 0x811c9dc5;
  for (const ch of url) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const tail = url.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? 'repo';
  return `${tail}-${h.toString(16).slice(0, 8)}`;
}

/**
 * 准备一个 build 的工作目录。
 *
 * 流程：确保本地缓存仓库存在 → 从 base 分支建 build 分支 → 克隆/更新工作副本。
 * 已存在且分支正确时直接复用（Rerun 场景）。
 */
export async function prepareWorkspace(spec: RepoSpec, buildId: string): Promise<{ cwd: string }> {
  const cache = repoCacheDir(spec.url);
  const workspace = path.join(PATHS.workspaces, buildId);

  fs.mkdirSync(PATHS.workspaces, { recursive: true });
  fs.mkdirSync(path.dirname(cache), { recursive: true });

  // 1. 缓存仓库
  if (!fs.existsSync(path.join(cache, '.git'))) {
    fs.rmSync(cache, { recursive: true, force: true });
    const r = await git(path.dirname(cache), ['clone', '--mirror', spec.url, cache], 300_000);
    if (!r.ok) {
      throw new Error(`git clone --mirror failed: ${r.stderr.trim().slice(0, 300)}`);
    }
  }

  // 2. 确保 build 分支存在（从 base 分支派生）
  const fetch = await git(cache, ['fetch', '--prune', 'origin']);
  if (!fetch.ok) {
    throw new Error(`git fetch failed: ${fetch.stderr.trim().slice(0, 200)}`);
  }

  const branchExists = await git(cache, ['rev-parse', '--verify', `refs/heads/${spec.branch}`]);
  if (!branchExists.ok) {
    const create = await git(cache, ['branch', spec.branch, `refs/remotes/origin/${spec.baseBranch}`]);
    if (!create.ok) {
      // base 分支可能还没被 fetch 到，退回直接用本地引用
      const fallback = await git(cache, ['branch', spec.branch, spec.baseBranch]);
      if (!fallback.ok) {
        throw new Error(
          `cannot create branch ${spec.branch} from ${spec.baseBranch}: ${create.stderr.trim().slice(0, 200)}`,
        );
      }
    }
  }

  // 3. 工作副本
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    fs.rmSync(workspace, { recursive: true, force: true });
    const clone = await git(
      path.dirname(workspace),
      ['clone', '--branch', spec.branch, cache, workspace],
      120_000,
    );
    if (!clone.ok) {
      throw new Error(`git clone worktree failed: ${clone.stderr.trim().slice(0, 300)}`);
    }
  } else {
    // 复用：回到干净状态。
    // reset --hard 只清已跟踪文件；agent 常留下未跟踪的临时文件
    // （build 产物、测试输出），不清会让它们污染 rerun 的新 build。
    await git(workspace, ['fetch', 'origin']);
    await git(workspace, ['checkout', spec.branch]);
    await git(workspace, ['reset', '--hard', `origin/${spec.branch}`]);
    await git(workspace, ['clean', '-fdx']);
  }

  // agent 需要一个身份才能 commit
  await git(workspace, ['config', 'user.email', 'agent@todos.local']);
  await git(workspace, ['config', 'user.name', 'Todos Agent']);

  return { cwd: workspace };
}

/** 提交工作区的全部改动。没有改动时返回 null。 */
export async function commitAll(
  cwd: string,
  message: string,
): Promise<{ commitSha: string | null; committed: boolean }> {
  await git(cwd, ['add', '-A']);
  const status = await git(cwd, ['status', '--porcelain']);
  if (!status.stdout.trim()) {
    // 无改动 —— 不是错误，只是没东西可交
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    return { commitSha: head.stdout.trim() || null, committed: false };
  }
  const commit = await git(cwd, ['commit', '-m', message]);
  if (!commit.ok) {
    throw new Error(`git commit failed: ${commit.stderr.trim().slice(0, 300)}`);
  }
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  return { commitSha: head.stdout.trim(), committed: true };
}

/**
 * 保留**整段** stderr（截断到 400 字符），不要只取第一行。
 *
 * 为什么：git push 被拒时 stderr 的第一行是 `To <url>`，真正的拒绝原因
 * （` ! [rejected] ... (non-fast-forward)`）在后面几行。只取第一行会得到
 * `push to remote failed: To file:///...` —— 服务端/UI 上看到的 pushError
 * 等于没说（实测踩过）。
 */
function clipErr(s: string): string {
  return s.trim().slice(0, 400);
}

/**
 * 把 build 分支推到**真远端**。
 *
 * 为什么必须两跳，而不是一句 `git push origin <branch>`：工作区的 `origin`
 * 不是真远端，而是 daemon 自己的镜像缓存 —— `prepareWorkspace` 用
 * `clone --branch <branch> <cache>` 建工作区，cache = `PATHS.home/repos/<remoteKey>`
 * （`sync-branch.ts:262` 就是靠这个事实写它的「本地领先就不倒退」守卫）。
 * 直接 push origin 只会把 commit 推进缓存，真仓库里那条分支永远停在建分支
 * 时的 base tip。所以：
 *   ① workspace → cache（顺带把 `origin/<branch>` 这个 remote-tracking ref
 *      更新到刚推的 sha —— rerun 复用工作区时 `reset --hard origin/<branch>`
 *      才不会倒退到 base）；
 *   ② cache → 真 URL（缓存本身是 `clone --mirror`，它的 origin 就是真仓库）。
 *
 * **判「推成功了没有」不靠退出码**：`git push` 回 0 + `Everything up-to-date`
 * 只说明这次没东西可推，不等于真远端已经有这个 commit。唯一可信的判据是拿
 * `ls-remote` 读真远端这条分支的 tip，跟本地 HEAD 比。
 *
 * **不 force**：真远端被别的机器或用户在 IDE 里推过时会非 fast-forward 被拒，
 * 如实回 `pushError`，不悄悄覆盖别人的 commit。
 */
export interface PushResult {
  /** 真远端上这条分支的 tip 等于本地 HEAD（不是「push 命令退出码 0」） */
  pushed: boolean;
  /** 本地 HEAD 的 sha —— 推没推都带，供服务端与日志对账 */
  headSha: string;
  /** 失败原因（被拒 / 读不到远端 ref / HEAD 解析不了） */
  error?: string;
}

export async function pushBranch(cwd: string, spec: RepoSpec): Promise<PushResult> {
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const headSha = head.stdout.trim();
  if (!head.ok || !headSha) {
    return { pushed: false, headSha: '', error: 'cannot resolve HEAD' };
  }

  // ① workspace → 缓存。这一跳失败就直接回，绝不假装第二跳成功。
  const toCache = await git(
    cwd,
    ['push', 'origin', `refs/heads/${spec.branch}:refs/heads/${spec.branch}`],
    120_000,
  );
  if (!toCache.ok) {
    return { pushed: false, headSha, error: `push to cache failed: ${clipErr(toCache.stderr)}` };
  }

  // ② 缓存 → 真远端。mirror 的 fetch refspec 是 `+refs/*:refs/*`，push 必须
  //    给显式 refspec，否则 `push.default` 在 mirror 语义下行为不定。
  const cache = repoCacheDir(spec.url);
  const toRemote = await git(
    cache,
    ['push', spec.url, `refs/heads/${spec.branch}:refs/heads/${spec.branch}`],
    120_000,
  );
  if (!toRemote.ok) {
    return { pushed: false, headSha, error: `push to remote failed: ${clipErr(toRemote.stderr)}` };
  }

  // 真判据：读真远端这条分支的 tip。
  const ls = await git(cache, ['ls-remote', spec.url, `refs/heads/${spec.branch}`], 60_000);
  const remoteSha = ls.stdout.trim().split('\t')[0] ?? '';
  if (!ls.ok || !remoteSha) {
    return { pushed: false, headSha, error: `remote ref unreadable: ${clipErr(ls.stderr)}` };
  }
  if (remoteSha !== headSha) {
    return {
      pushed: false,
      headSha,
      error: `remote tip ${remoteSha.slice(0, 8)} != local HEAD ${headSha.slice(0, 8)}`,
    };
  }
  return { pushed: true, headSha };
}

/**
 * 取改动摘要。
 * 超过阈值时只给统计不给全文 —— 对齐文档：
 *   单文件 >500KB 或总计 >2MB 时明示不静默截断。
 */
export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
  diff: string;
  /** 超出阈值时的说明，直接展示给用户 */
  note?: string;
}

const PER_FILE_LIMIT = 500 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024;

export async function collectDiff(cwd: string, baseRef: string): Promise<DiffSummary> {
  const numstat = await git(cwd, ['diff', '--numstat', `${baseRef}...HEAD`]);
  if (!numstat.ok) {
    return { filesChanged: 0, insertions: 0, deletions: 0, truncated: false, diff: '' };
  }

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const oversizeFiles: string[] = [];

  for (const line of numstat.stdout.split('\n')) {
    const [add, del, file] = line.split('\t');
    if (!file) continue;
    filesChanged++;
    insertions += Number(add) || 0;
    deletions += Number(del) || 0;

    // 查该文件的实际大小，判断是否超单文件阈值
    const size = await git(cwd, ['cat-file', '-s', `HEAD:${file}`]);
    const bytes = Number(size.stdout.trim()) || 0;
    if (bytes > PER_FILE_LIMIT) oversizeFiles.push(file);
  }

  const full = await git(cwd, ['diff', `${baseRef}...HEAD`]);
  const fullDiff = full.stdout;

  if (oversizeFiles.length > 0 || fullDiff.length > TOTAL_LIMIT) {
    const parts: string[] = [];
    if (oversizeFiles.length > 0) {
      parts.push(`${oversizeFiles.length} 个文件超过 500KB，已省略其 patch：`);
      parts.push(...oversizeFiles.map((f) => `  - ${f}`));
    }
    if (fullDiff.length > TOTAL_LIMIT) {
      parts.push(`总 diff ${(fullDiff.length / 1048576).toFixed(1)}MB 超过 2MB，仅显示文件列表。`);
    }
    return {
      filesChanged,
      insertions,
      deletions,
      truncated: true,
      diff: '',
      note: parts.join('\n'),
    };
  }

  return { filesChanged, insertions, deletions, truncated: false, diff: fullDiff };
}

/** 清理 build 的工作目录 */
export function cleanupWorkspace(buildId: string): void {
  const ws = path.join(PATHS.workspaces, buildId);
  fs.rmSync(ws, { recursive: true, force: true });
}
