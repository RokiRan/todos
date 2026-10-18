#!/usr/bin/env node
import os from 'node:os';
import { ServerClient } from './server-client.js';
import { Worker } from './worker.js';
import { log, closeLog } from './log.js';
import {
  PATHS,
  ensureDirs,
  loadRegistration,
  saveRegistration,
  clearRegistration,
  loadOrCreateDevice,
  type MachineRegistration,
} from './paths.js';
import { probeBinary } from './drivers/shared.js';
import { availableRuntimeIds, driverFor } from './drivers/index.js';
import { MVP_RUNTIME_IDS } from '@tds/protocol';

const CLI_VERSION = '0.1.0';
const DEFAULT_SERVER = process.env.TDS_SERVER ?? 'http://127.0.0.1:4000';

/**
 * tds CLI。
 *
 * 命令面对齐原站（recon/02-cli-protocol.md §1.1）：
 *   start / stop / restart / status / logs / logout / upgrade / version
 *
 * MVP 只实现 start / status / stop / logout / version —— 其余按需补。
 */

interface Argv {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Argv {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<number> {
  ensureDirs();

  const server = (flags.server as string) ?? DEFAULT_SERVER;
  const apiKeyFlag = flags['api-key'] as string | undefined;
  const teamFlag = flags.team as string | undefined;
  const workspacesDir = flags['workspaces-dir'] as string | undefined;
  const machineName = flags.name as string | undefined;

  if (workspacesDir) {
    process.env.TDS_WORKSPACES_DIR = workspacesDir;
  }

  const device = loadOrCreateDevice();
  if (machineName) device.name = machineName;

  let reg = loadRegistration();

  // 两种入队路径（对齐原站 bundle §2）：
  //   1. --api-key + --team：无头/CI
  //   2. 已有注册：直接复用
  if (apiKeyFlag && teamFlag) {
    const client = new ServerClient({ server, apiKey: apiKeyFlag });
    const res = await client.enroll(
      { ...device, cliVersion: CLI_VERSION, workspacesDir: PATHS.workspaces, nodeVersion: process.version },
      teamFlag,
    );
    // 服务端会签发**机器专属凭据**，之后所有 machine 请求用它 ——
    // 入队 key 是人的 API key，不能长期用于机器路径（文档：凭据可吊销但机器保留）
    reg = {
      machineId: res.machineId,
      teamId: teamFlag,
      apiKey: res.apiKey,
      server,
      enrolledAt: Date.now(),
      cliVersion: CLI_VERSION,
    };
    saveRegistration(reg);
    log.info(`enrolled machine=${reg.machineId} team=${teamFlag} reused=${res.reused}`);
  } else if (!reg) {
    console.error(
      'not enrolled. Run with --api-key <tds_...> --team <teamId>, ' +
        'or open the web app and use the enroll command.',
    );
    return 1;
  } else {
    // 复用已有注册，但刷新 server（允许 --server 覆盖）
    reg.server = server;
    saveRegistration(reg);
    log.info(`resuming machine=${reg.machineId} team=${reg.teamId}`);
  }

  // 探测本机可用 runtime
  const reports = [];
  for (const id of MVP_RUNTIME_IDS) {
    const p = await probeRuntime(id);
    if (p.installed) reports.push(id);
    log.info(`runtime ${id}: ${p.installed ? `installed (${p.version ?? '?'})` : 'not installed'}`);
  }
  if (reports.length === 0) {
    log.warn('no supported runtime found — install Claude Code: https://claude.com/claude-code');
  }

  const client = new ServerClient({ server: reg.server, apiKey: reg.apiKey });
  const ac = new AbortController();

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    ac.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const worker = new Worker({
    client,
    concurrency: 6,
    runtimeIds: reports,
    signal: ac.signal,
  });

  log.info(`daemon up — server=${reg.server} host=${os.hostname()}`);
  await worker.run();
  closeLog();
  return 0;
}

async function cmdStatus(): Promise<number> {
  const reg = loadRegistration();
  const device = loadOrCreateDevice();

  console.log(`cli version   ${CLI_VERSION}`);
  console.log(`node          ${process.version}`);
  console.log(`host          ${device.name} (${device.platform}/${device.arch})`);
  console.log(`tds home      ${PATHS.home}`);
  console.log(`workspaces    ${PATHS.workspaces}`);

  if (!reg) {
    console.log('enrollment    NOT ENROLLED');
    console.log('runtimes      ' + (await runtimeReport()));
    return 1;
  }

  console.log(`machine id    ${reg.machineId}`);
  console.log(`team          ${reg.teamId}`);
  console.log(`server        ${reg.server}`);
  console.log(`enrolled at   ${new Date(reg.enrolledAt).toISOString()}`);

  // 连通性
  const client = new ServerClient({ server: reg.server, apiKey: reg.apiKey });
  try {
    const me = await client.me();
    console.log(`server says   OK (machine=${me.machineId})`);
  } catch (err) {
    console.log(`server says   UNREACHABLE — ${errText(err)}`);
  }

  console.log('runtimes      ' + (await runtimeReport()));
  return 0;
}

/**
 * 统一的 runtime 探测入口。
 *
 * 为什么不能直接用 `probeBinary`：`drivers/shared.ts:13` 自己就写着「内置
 * runtime（pi）没有二进制 —— 它是 daemon 内嵌的 SDK，不 spawn」，
 * `resolveBinary` 对 pi 返回 null，于是 `probeBinary('pi')` 回
 * `{installed:false, error:'unknown runtime'}`。结果 bundled 的 pi 被误判成
 * 未安装、永远进不了 `runtimeIds`（实测踩过：daemon 日志打
 * `runtime pi: not installed`，而单独调 `PiDriver.probe()` 回
 * `installed:true, version:1.3.0`）。
 *
 * 外部 driver 的 `probe()` 内部本来就是 `probeBinary(id)`
 * （`claude-code.ts:76` / `omp.ts:110`），所以走 driver 入口对它们**零行为变化**
 * —— 只是把并存的两套 probe 语义收敛成一套。
 */
async function probeRuntime(id: string): Promise<{
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}> {
  const driver = driverFor(id);
  return driver ? driver.probe() : probeBinary(id);
}

async function runtimeReport(): Promise<string> {
  const parts: string[] = [];
  for (const id of MVP_RUNTIME_IDS) {
    const p = await probeRuntime(id);
    parts.push(`${id}=${p.installed ? 'yes' : 'no'}`);
  }
  return parts.join(' ');
}

function cmdStop(): number {
  // MVP：worker 随信号退出即停止；这里落一份 pid 文件供将来 detach 模式用
  console.log('no detached daemon is running (foreground mode only in this build)');
  return 0;
}

function cmdLogout(): number {
  clearRegistration();
  // device.json 刻意保留 —— 同一台机器重入队复用指纹
  console.log('registration cleared (device fingerprint kept for re-enrollment)');
  return 0;
}

function cmdVersion(): number {
  console.log(`${CLI_VERSION}`);
  return 0;
}

function cmdHelp(): number {
  console.log(`tds ${CLI_VERSION}

Usage: tds <command> [options]

Commands:
  start      Run the daemon (foreground)
  status     Show enrollment, connectivity and detected runtimes
  stop       Stop the daemon
  logout     Clear this machine's registration
  version    Print the CLI version
  help       Show this message

Options for start:
  --api-key <tds_...>      Enroll with an API key (headless / CI)
  --team <teamId>          Team to join (required with --api-key)
  --server <url>           Server URL (default ${DEFAULT_SERVER}, or $TDS_SERVER)
  --workspaces-dir <dir>   Override the worktree root
  --name <name>            Machine display name (default: hostname)

Runtime binary overrides:
  TDS_CLAUDE_CODE_BIN      Path to the claude binary
  (see recon/01-runtimes.md for all 17 runtime env vars)

Supported runtimes in this build: ${availableRuntimeIds().join(', ')}
`);
  return 0;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<number> {
  const { command, flags } = parseArgv(process.argv.slice(2));
  switch (command) {
    case 'start':
      return cmdStart(flags);
    case 'status':
      return cmdStatus();
    case 'stop':
      return cmdStop();
    case 'logout':
      return cmdLogout();
    case 'version':
    case '--version':
    case '-v':
      return cmdVersion();
    case 'help':
    case '--help':
    case '-h':
    default:
      return cmdHelp();
  }
}

process.exitCode = await main();
