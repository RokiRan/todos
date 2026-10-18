import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './drivers/shared.js';
import { log } from './log.js';

/**
 * 「同步到机器」的执行端（契约 §3.6）。
 *
 * server 端只写指令、不执行 git（契约 §3.2：git 只能在装了 repo 的那台机器上跑），
 * 所以真正把分支拉到本机目录的是这个文件。
 *
 * **为什么单独成文件而不是塞进 git.ts**：git.ts 服务的是 claim 出来的 build step
 * （目录由 daemon 自己按 `PATHS.workspaces/<buildId>` 造，路径可信）；这里的 `dir`
 * 来自服务端数据库、可能是这台机器上的任何目录，安全约束完全不同（见下）。
 * git.ts 在本切片是禁改文件，所以 git 调用封装在这里重写一份。
 */

export interface SyncBranchRequest {
  actionId: string;
  branch: string;
  /**
   * 具体目录 —— 直接用，不要拼任何东西。契约与 server 端已保证它是绝对路径
   * （`apps/server/src/routes/todos.ts` 用 `joinOnMachine` 按**目标机器自己的**
   * 分隔符拼 `<workspacesDir>/<buildId>`，不是工作根）。
   */
  dir: string;
  buildId: string | null;
  todoId?: string | null;
}

export interface SyncBranchResult {
  ok: boolean;
  /** 同步到的 commit sha；拿不到时是 null（不会假装成功） */
  commitSha: string | null;
  /** 相对基线分支的变更文件数；0 表示目录本来就是干净的 */
  filesChanged: number;
  dir: string;
  /**
   * 目标目录原有本地改动是否被丢弃（`git reset --hard` + `git clean -fdx` 的后果）。
   * **不可逆**，所以必须如实上报 —— 不如实上报就是隐瞒（契约 §3.6）。
   */
  discardedChanges?: boolean;
  error?: string;
}

/** git 调用结果，与 git.ts 的 `GitResult` 同形（那边没 export，本切片不许改它） */
interface GitOut {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 回给用户的 stderr 片段长度 —— 太长的 git 输出塞进 JSON/DB 没人看 */
const ERROR_SNIPPET = 300;

/** fetch 要给网络留够时间；其余都是本地操作 */
const FETCH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitOut> {
  // 与 git.ts 里那个未导出的同名函数同一写法：**必须 shell:false**。
  // shell:true 时 cmd.exe 会二次解析命令行，把含空格/引号/换行的参数拆成碎片
  // （git.ts 的注释原文）。`runCommand` 在 Windows 上默认会走 shell，所以这里
  // 显式传 false —— 契约 §三.6 选的就是这条路：不碰 git.ts，复用同一个
  // 已验证的 runCommand 封装。
  const r = await runCommand('git', args, { cwd, timeoutMs, shell: false });
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
}

/** 压成一行、限长：错误要进 JSON → DB → SSE，多行/超长都会把 UI 撑坏 */
function snip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > ERROR_SNIPPET ? `${flat.slice(0, ERROR_SNIPPET)}…` : flat;
}

/** 统一的失败出口。`ok:false` 一律带 commitSha:null / filesChanged:0，不抛异常 */
function fail(dir: string, error: string): SyncBranchResult {
  return { ok: false, commitSha: null, filesChanged: 0, dir, error };
}

/**
 * 路径校验（契约 §3.6 安全约束 1）。
 *
 * `dir` 来自服务端数据库 —— 这是一条「让机器去写任意目录」的通道，所以
 * 空串、`..` 段、相对路径三种都要拒。返回 null = 通过。
 */
function pathProblem(dir: string): string | null {
  if (dir.trim() === '') return 'dir 是空串';
  // `..` 逐段判，两种分隔符都算：server 按**目标机器自己的**分隔符拼 dir
  // （todos.ts 的 joinOnMachine），Windows 机器上就是 `\`。
  if (dir.split(/[\\/]/).some((seg) => seg === '..')) return 'dir 含 .. 段';
  if (!looksAbsolute(dir)) return 'dir 不是绝对路径';
  return null;
}

function looksAbsolute(dir: string): boolean {
  // **不能只判 POSIX 的 `/` 开头**：dir 可能是 Windows 盘符路径
  // （`C:\Users\...`），而且 daemon 也可能跑在 Linux 上、收到一条给
  // Windows 机器下发的 dir —— 那时 `path.isAbsolute` 按本机 POSIX 规则
  // 会把它判成相对路径。两套规则都认，谁都不误杀。
  if (path.isAbsolute(dir)) return true;
  if (/^[A-Za-z]:[\\/]/.test(dir)) return true; // C:\... 或 C:/...
  if (/^[\\/][\\/][^\\/]+/.test(dir)) return true; // UNC：\\server\share
  return false;
}

/** 某个 ref 是否存在（用完整 refs/remotes/... 路径，避免和同名本地分支撞名歧义） */
function refExists(dir: string, fullRef: string): Promise<GitOut> {
  return git(dir, ['rev-parse', '--verify', fullRef]);
}

/**
 * 确定「和谁比」的基线分支。
 *
 * **为什么不能直接用 `baseBranch` 字段**：`MachineAction`（@tds/protocol）里没有
 * 这个字段，而协议包已冻结（契约 §四 把它划给另一个切片，且第 1 步已验收完成）。
 * server 的 `sync-to-machine` 响应里其实算了 `baseBranch`，但它没有落进
 * `machine_pending_action` 表、也就没透传到指令里。所以只能在这台机器上从
 * git 自己的元数据里推。
 *
 * **回退链（可靠性从高到低）**：
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` —— clone 时从远端 HEAD
 *      带回来的符号引用，就是该仓库的默认分支。免费、纯本地、不会猜错。
 *   2. `git ls-remote --symref origin HEAD` —— 直接问远端「你的 HEAD 指哪儿」。
 *      只在第 1 步失败时走：`refs/remotes/origin/HEAD` 会因为 `--single-branch` /
 *      `--depth` clone 或 `git remote set-head -d` 而缺失，这时它是唯一还拿得到
 *      真默认分支的办法。多一次往返，但刚 fetch 过、连接是热的。
 *   3. `main` —— 全站约定（`prepareWorkspace` 的 baseBranch 就是走这条约定）。
 *   4. `master` —— 老仓库。
 *   5. 四个都拿不到 → 老实报错。`filesChanged` 必须有基线才能算；硬猜一个不存在
 *      的 ref 只会在下一步让 `git diff` 报 unknown revision，被当成「同步失败」，
 *      不如在这里说清是哪一种。
 *
 * 3/4 两步都**先验证 ref 存在**再用：fetch 之后 origin/main 不存在就说明这个仓库
 * 的默认分支另有其名，回退到猜名字不如报错。
 */
async function resolveBaseBranch(
  dir: string,
): Promise<{ ok: true; base: string } | { ok: false; error: string }> {
  // 1. 远端 HEAD（--short 输出形如 `origin/main`）
  const sym = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.ok) {
    const raw = sym.stdout.trim();
    const name = raw.startsWith('origin/') ? raw.slice('origin/'.length) : raw;
    if (name && (await refExists(dir, `refs/remotes/origin/${name}`)).ok) {
      return { ok: true, base: name };
    }
  }

  // 2. 直接问远端 HEAD 指哪儿（本地 origin/HEAD 缺失时的权威来源）
  const remoteHead = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD']);
  if (remoteHead.ok) {
    const line = remoteHead.stdout.split('\n').find((l) => l.trim().startsWith('ref: refs/heads/'));
    const name = line?.trim().match(/^ref: refs\/heads\/(.+?)\tHEAD$/)?.[1];
    if (name && (await refExists(dir, `refs/remotes/origin/${name}`)).ok) {
      return { ok: true, base: name };
    }
  }

  // 3/4. 约定俗成的默认分支名，逐个验证
  for (const cand of ['main', 'master']) {
    if ((await refExists(dir, `refs/remotes/origin/${cand}`)).ok) return { ok: true, base: cand };
  }

  return {
    ok: false,
    error:
      '无法确定基线分支：本地 origin/HEAD 和远端 HEAD 都拿不到，且 origin/main、' +
      `origin/master 都不存在（已在 ${dir} 里 fetch 过）。变更文件数需要一个基线才能算` +
      ' —— 请给这个仓库设一个默认分支',
  };
}

/**
 * 把一条分支同步到本机目录。
 *
 * **不抛异常**：每条失败路径都返回 `ok:false` + 具体 error。调用方（worker 的
 * recover 循环）要的是「一条失败不影响同批其它动作」，抛异常会逼它写兜底逻辑，
 * 而兜底逻辑最容易把具体 error 吞成一句「同步失败」。
 */
export async function syncBranch(req: SyncBranchRequest): Promise<SyncBranchResult> {
  const dir = req.dir;

  // ── 安全约束 1：路径校验 ────────────────────────────────────
  const bad = pathProblem(dir);
  if (bad) {
    return fail(
      dir,
      `路径校验未通过（${bad}）。dir 由服务端下发，必须是这台机器上的绝对路径且不含 .. 段：${dir}`,
    );
  }

  // ── 安全约束 3：目录不存在 = 契约 §3.7 的边界，绝不能返回 ok:true ──
  // 首次 clone 需要 remote url，而 `machine_pending_action` / `MachineAction`
  // 都没有这个字段（claim 场景是从 `claim.repo.url` 拿的）。这里只能如实说。
  if (!fs.existsSync(dir)) {
    return fail(
      dir,
      `目标目录 ${dir} 尚不存在。首次同步需要先在该目录执行 git clone。`,
    );
  }

  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch (err) {
    return fail(dir, `无法读取目标目录 ${dir}：${snip(err instanceof Error ? err.message : String(err))}`);
  }
  if (!isDir) return fail(dir, `目标路径 ${dir} 存在但不是目录`);

  // ── 安全约束 2：存在但不是 git 仓库 → 直接报错，**绝不 rm -rf** ──
  // git.ts 的 prepareWorkspace 撞名时会 `fs.rmSync(..., {recursive:true})`；
  // 这里的 dir 可能是用户的目录，删了就回不来，所以一条命令都不动它。
  const probe = await git(dir, ['rev-parse', '--git-dir']);
  if (!probe.ok) {
    return fail(
      dir,
      `目标目录已存在且不是 git 仓库：${dir}（git 判定：${snip(probe.stderr) || '无输出'}）`,
    );
  }

  // ── 1. fetch ────────────────────────────────────────────────
  const fetchRes = await git(dir, ['fetch', '--prune', 'origin'], FETCH_TIMEOUT_MS);
  if (!fetchRes.ok) {
    return fail(dir, `git fetch 失败：${snip(fetchRes.stderr) || '无 stderr 输出'}`);
  }

  // ── 2. 基线分支 ─────────────────────────────────────────────
  const base = await resolveBaseBranch(dir);
  if (!base.ok) return fail(dir, base.error);

  // ── 3. discardedChanges：必须在任何破坏性步骤**之前**测 ──────
  // 放在 checkout 之前而不是紧挨 reset 之前：checkout 本身就会改写工作区，
  // 先测才知道「用户原来有什么」。（`clean -fdx` 连被 .gitignore 忽略的文件
  // 也删，而 `status --porcelain` 不列它们 —— 所以这里报的是「源码改动」，
  // 不含 node_modules 这类构建产物；宁可多报不可漏报。）
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.ok) return fail(dir, `git status 失败：${snip(status.stderr) || '无 stderr 输出'}`);
  const dirtyBefore = status.stdout.trim() !== '';

  // ── 4. checkout ─────────────────────────────────────────────
  let co = await git(dir, ['checkout', req.branch]);
  if (!co.ok && dirtyBefore) {
    // 本地有未提交改动时 checkout 会拒绝（"local changes would be overwritten"）。
    // 下一步本来就是 reset --hard，这些改动本来就要丢，所以 `-f` 重试不额外丢东西。
    // 不加这步重试的话，最常见的情况（目录里有本地改动）会直接同步失败，
    // `discardedChanges` 也就永远没机会变 true。
    co = await git(dir, ['checkout', '-f', req.branch]);
  }
  if (!co.ok) {
    return fail(
      dir,
      `git checkout ${req.branch} 失败：${snip(co.stderr) || '无 stderr 输出'}。` +
        '若该分支在这台机器上还不存在（本地和 origin 都没有），本切片不会自动 ' +
        '`checkout -b` —— 那需要 base 分支信息，见契约 §3.7',
    );
  }

  // ── 5. 对齐到远端 tip（带「本地领先就不倒退」的守卫）──────────
  //
  // 契约 §3.6 写的是 `git reset --hard origin/<branch>`。这里照做，但**只在
  // `origin/<branch>` 存在、且本地没有它缺少的提交时**才拿它当目标，否则 reset
  // 到 HEAD。依据是这条复刻特有的两条事实（不是猜测，是读码得到的）：
  //   - 工作区的 `origin` 不是真远端，而是 daemon 自己的镜像缓存：git.ts 的
  //     `prepareWorkspace` 用 `clone --branch <branch> <cache>` 建工作区，
  //     cache = `PATHS.home/repos/<remoteKey>`。
  //   - daemon 现在**会** push（`git.ts` 的 `pushBranch`，两跳：workspace →
  //     cache → 真 URL；第①跳顺带把 `origin/<branch>` 更新到刚推的 sha）。
  //     但 push 可能被拒（真远端非 fast-forward、机器没配凭据），这时
  //     `origin/<branch>` 仍停在 base tip、commit 只在本地 —— 所以这条守卫
  //     **必须保留**，不能因为「现在有 push 了」就删掉。
  //
  // 照字面 `reset --hard origin/<branch>` 的后果：HEAD 倒退到 base tip，用户点
  // 「同步到机器」想看的那批 commit 变成 unreachable（除 reflog 找不回来），同时
  // `filesChanged` 算出 0 —— 一个「0 文件变更」的 ok:true，正是假绿。
  //
  // 两种目标**都仍然丢弃工作区改动**（不带 ref 的 `reset --hard` 就是 reset 到
  // HEAD），所以契约要的「丢弃本地改动 + 如实上报 discardedChanges」一点没少。
  // 代价不对称：丢 commit **不可逆**，少拿远端新 commit 可靠下一次 fetch/merge
  // 补回来。分叉（两边都有新 commit）时同样保本地 —— 契约 §3.7 明确不做冲突合并。
  // 真远端领先（别的机器 push 过）走 `origin/<branch>` 那条，照契约把新提交拉进来。
  const remoteRef = `refs/remotes/origin/${req.branch}`;
  const hasRemote = await refExists(dir, remoteRef);
  let resetTarget: string | null = `origin/${req.branch}`;
  if (!hasRemote.ok) {
    // 远端没有这条分支：这台机器自己 commit 的分支从没 push 过。照字面 reset 到
    // origin/<branch> 会直接报 unknown revision，所以退回 reset 到本地 HEAD。
    resetTarget = null;
    log.info(`sync ${req.actionId}: origin/${req.branch} 不存在，reset 到本地 HEAD`);
  } else {
    const ahead = await git(dir, ['rev-list', '--count', `${remoteRef}..HEAD`]);
    if (!ahead.ok) return fail(dir, `git rev-list 失败：${snip(ahead.stderr) || '无 stderr 输出'}`);
    const localAhead = Number(ahead.stdout.trim()) > 0;
    if (localAhead) {
      resetTarget = null;
      log.info(
        `sync ${req.actionId}: 本地领先 origin/${req.branch} ${ahead.stdout.trim()} 个提交，` +
          'reset 到 HEAD 而不是 origin/<branch>（倒退会丢掉这台机器上的提交）',
      );
    }
  }

  const resetArgs = resetTarget === null ? ['reset', '--hard'] : ['reset', '--hard', resetTarget];
  const reset = await git(dir, resetArgs);
  if (!reset.ok) {
    return fail(dir, `git ${resetArgs.join(' ')} 失败：${snip(reset.stderr) || '无 stderr 输出'}`);
  }

  // ── 6. clean -fdx ───────────────────────────────────────────
  // 与 prepareWorkspace 的复用分支同一行为：清掉 agent 留下的未跟踪产物，
  // 否则它们会污染下一次 rerun。注意 `-x` 连 ignored 文件也删。
  const clean = await git(dir, ['clean', '-fdx']);
  if (!clean.ok) return fail(dir, `git clean -fdx 失败：${snip(clean.stderr) || '无 stderr 输出'}`);

  // ── 7. commitSha ────────────────────────────────────────────
  const head = await git(dir, ['rev-parse', 'HEAD']);
  if (!head.ok) return fail(dir, `git rev-parse HEAD 失败：${snip(head.stderr) || '无 stderr 输出'}`);
  const commitSha = head.stdout.trim();
  if (commitSha === '') return fail(dir, 'git rev-parse HEAD 没有输出（仓库没有任何提交？）');

  // ── 8. filesChanged ─────────────────────────────────────────
  // 用两点 `origin/<base>..HEAD`（契约 §3.6 原样）。git.ts 的 collectDiff 用的是
  // 三点 `...HEAD`；两者只在「base 在建分支之后又前移了」时给出不同结果
  // （三点从 merge-base 起算，会把 base 的新提交反着算进来）。这里按契约的两点写。
  const diff = await git(dir, ['diff', '--name-only', `origin/${base.base}..HEAD`]);
  if (!diff.ok) {
    return fail(
      dir,
      `git diff origin/${base.base}..HEAD 失败：${snip(diff.stderr) || '无 stderr 输出'}`,
    );
  }
  const filesChanged = diff.stdout.split('\n').filter((line) => line.trim() !== '').length;

  const result: SyncBranchResult = { ok: true, commitSha, filesChanged, dir };
  // 安全约束 4：非空就报 true（宁可多报也不漏报 —— 见上面 status 那段注释）
  if (dirtyBefore) result.discardedChanges = true;
  log.info(
    `sync ${req.actionId} ok: ${commitSha.slice(0, 8)} ${filesChanged} files vs origin/${base.base}` +
      `${dirtyBefore ? '（丢弃了本地改动）' : ''}`,
  );
  return result;
}
