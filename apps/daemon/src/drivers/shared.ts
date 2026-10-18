import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeSpec } from '@tds/protocol';

/**
 * driver 共用工具：二进制定位与子进程执行。
 *
 * 二进制解析顺序（对齐原站行为，见 recon/01-runtimes.md）：
 *   1. 该 runtime 专属的 TDS_<X>_BIN 环境变量 —— 允许用户指向非标准路径
 *   2. PATH 里的默认二进制名
 *
 * 内置 runtime（pi）没有二进制 —— 它是 daemon 内嵌的 SDK，不 spawn。
 * 返回 null 表示「这个 runtime 不需要二进制」，调用方据此走内嵌路径，
 * 而不是当成「找不到二进制」的失败。
 */
export function resolveBinary(runtimeId: string): { cmd: string } | null {
  const spec = runtimeSpec(runtimeId);
  if (!spec) return null;

  // 内置 runtime：不 spawn，直接返回 null
  if (spec.driver === 'pi' || spec.defaultBin === null) return null;

  const fromEnv = spec.binEnv ? process.env[spec.binEnv] : undefined;
  if (fromEnv && fromEnv.trim()) {
    return { cmd: fromEnv.trim() };
  }
  return { cmd: spec.defaultBin };
}

/**
 * Windows 上能否绕过 shell 直接 spawn。
 *
 * 这是正确性与安全性的关键差异：
 *   shell:true  → Node 拼成 `cmd /c "<cmd> <args>"`，cmd 会再解析一遍
 *                 命令行，prompt 里的引号/换行/& | > 全部失真。
 *                 实测 Claude Code 会收到残缺任务却报 succeeded。
 *   shell:false → Node 直接 CreateProcess + 拼 argv，参数原样送达。
 *
 * 只有当命令是 .cmd/.bat shim（非真二进制）时才必须走 shell。
 */
export function needsShell(cmd: string): boolean {
  if (process.platform !== 'win32') return false;
  const lower = cmd.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * 在 PATH 里查找命令对应的绝对路径。
 *
 * 找到绝对路径后才能决定能否绕开 shell：Node 的 spawn 在 Windows 上
 * 即使 shell:false 也不会自行搜索 PATHEXT，只有拿到 .exe 的绝对路径
 * 才能真正 CreateProcess 成功。
 */
export function whichCommand(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) return cmd;
  const pathEnv = process.env.PATH ?? '';
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    // 优先 .EXE —— 那是能绕开 shell 的真二进制
    const order = ['.exe', ...exts.filter((e) => e.toLowerCase() !== '.exe')];
    for (const ext of order) {
      const candidate = path.join(dir, cmd + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* 继续找下一个 */
      }
    }
  }
  return null;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * 跑一个一次性子命令并收集输出。用于 probe 与 signIn 探测。
 * 必须带超时 —— 很多 CLI 在无 TTY 下会挂住等输入。
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string; shell?: boolean } = {},
): Promise<SpawnResult> {
  const { promise, resolve } = Promise.withResolvers<SpawnResult>();

  // 默认在 Windows 上走 shell（很多 CLI 是 shim）；但调用方明确给
  // shell:false 时必须尊重 —— 真二进制经 shell 会被二次解析毁掉参数。
  const useShell = opts.shell ?? (process.platform === 'win32' && needsShell(cmd));

  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      shell: useShell,
      windowsHide: true,
    });
  } catch (err) {
    resolve({ code: null, signal: null, stdout: '', stderr: String(err) });
    return promise;
  }

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ code: null, signal: 'SIGKILL', stdout, stderr: stderr + '\n[timed out]' });
  }, opts.timeoutMs ?? 15_000);

  function finish(r: SpawnResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(r);
  }

  child.stdout?.on('data', (d) => (stdout += d.toString()));
  child.stderr?.on('data', (d) => (stderr += d.toString()));
  child.on('error', (err) => finish({ code: null, signal: null, stdout, stderr: String(err) }));
  child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }));

  return promise;
}

/**
 * 通用探测：二进制能否执行、版本号是什么。
 * 覆盖 TDS_<X>_BIN 场景 —— 这是容器与 CI 里的关键能力。
 */
export async function probeBinary(runtimeId: string): Promise<{
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}> {
  const resolved = resolveBinary(runtimeId);
  if (!resolved) return { installed: false, error: 'unknown runtime' };

  const r = await runCommand(resolved.cmd, ['--version'], { timeoutMs: 10_000 });
  const combined = `${r.stdout}${r.stderr}`;
  // 取第一行，slice 限长；空输出时留 undefined 而非空串
  const firstLine = (): string | undefined => {
    const line = combined.trim().split('\n')[0];
    return line ? line.slice(0, 80) : undefined;
  };

  if (r.code === 0) {
    return { installed: true, version: firstLine(), path: resolved.cmd };
  }

  // 很多 CLI 的 --version 写 stderr 或返回非 0；只要不是「找不到」就算装了
  const notFound = /ENOENT|not recognized|command not found|cannot find/i.test(combined);
  if (!notFound && combined.trim()) {
    return { installed: true, version: firstLine(), path: resolved.cmd };
  }
  return { installed: false, path: resolved.cmd, error: combined.trim().slice(0, 120) || 'binary not found' };
}
