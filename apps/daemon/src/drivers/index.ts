import type { RuntimeDriver } from './driver.js';
import { ClaudeCodeDriver } from './claude-code.js';
import { CodexDriver } from './codex.js';
import { OmpDriver } from './omp.js';
import { PiDriver } from './pi.js';

/**
 * driver 注册表。
 *
 * 首批三个的驱动协议各不相同（这正是选型里不做 ACP 抽象的原因）——
 *   pi          : **内置 SDK**，`import("@earendil-works/pi-coding-agent")`，
 *                 不 spawn 任何二进制，模型来自团队 provider。原站默认 runtime，
 *                 Free 档正路（不消耗平台 credits）。见 pi.ts 的详细注释。
 *   claude-code : `claude -p --output-format stream-json`（NDJSON，已实测 v2.1.226）
 *   omp         : `omp --mode=json --print`（NDJSON，已实测 v18.2.11）
 *   codex       : `codex app-server`（JSON-RPC over stdio）—— 本机未装，
 *                 协议未实测，故为 stub：probe 如实返回未安装，run 返回明确错误。
 *                 详见 local://runtime-drivers.md 与 codex.ts 的文件注释。
 *
 * 注册顺序 = 原站的优先级：pi 是默认，排在最前。
 */
const DRIVERS: Record<string, RuntimeDriver> = {
  pi: new PiDriver(),
  'claude-code': new ClaudeCodeDriver(),
  omp: new OmpDriver(),
  codex: new CodexDriver(),
};

export function driverFor(runtimeId: string): RuntimeDriver | undefined {
  return DRIVERS[runtimeId];
}

export function availableRuntimeIds(): string[] {
  return Object.keys(DRIVERS);
}

export type { RuntimeDriver, RunOptions, RunResult, ToolCallRequest } from './driver.js';
