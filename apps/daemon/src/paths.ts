import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 本地状态布局 —— 对齐原站 CLI 的约定（recon/02-cli-protocol.md §1.4）。
 *
 * 关键设计（文档铁律）：
 *   - machine.json 权限 0600，存注册凭据
 *   - device.json 在 logout 时**保留**，以便同一台机器重入队复用指纹
 *   - workspaces/ 是 git worktree 的家，每个 build 一个隔离工作区
 */

export const TDS_HOME = process.env.TDS_HOME ?? path.join(os.homedir(), '.tds');

export const PATHS = {
  home: TDS_HOME,
  /** 本机注册（0600）。logout 时删除 */
  machine: path.join(TDS_HOME, 'machine.json'),
  /** 硬件指纹。logout 时保留 */
  device: path.join(TDS_HOME, 'device.json'),
  log: path.join(TDS_HOME, 'daemon.log'),
  /** clone 下来的仓库 + 每 build 的 worktree */
  workspaces: process.env.TDS_WORKSPACES_DIR ?? path.join(TDS_HOME, 'workspaces'),
  /** 各 runtime 的隔离 home，link-in 登录态 */
  runtimeHomes: path.join(TDS_HOME, 'runtimes'),
} as const;

export function ensureDirs(): void {
  for (const dir of [PATHS.home, PATHS.workspaces, PATHS.runtimeHomes]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 注册信息。落盘时必须 0600 —— 内含 apiKey。 */
export interface MachineRegistration {
  machineId: string;
  teamId: string;
  apiKey: string;
  server: string;
  enrolledAt: number;
  cliVersion: string;
}

export function saveRegistration(reg: MachineRegistration): void {
  ensureDirs();
  // 先写临时文件再 rename，避免半截文件
  const tmp = PATHS.machine + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PATHS.machine);
  // Windows 上 rename 不保留 mode，显式 chmod
  try {
    fs.chmodSync(PATHS.machine, 0o600);
  } catch {
    /* Windows 无 POSIX 权限位，忽略 */
  }
}

export function loadRegistration(): MachineRegistration | null {
  try {
    const raw = fs.readFileSync(PATHS.machine, 'utf8');
    const parsed = JSON.parse(raw) as MachineRegistration;
    if (!parsed.machineId || !parsed.apiKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRegistration(): void {
  try {
    fs.unlinkSync(PATHS.machine);
  } catch {
    /* 已不存在 */
  }
  // device.json 刻意保留 —— 同一台机器再次入队应复用同一指纹
}

/** 设备指纹：稳定标识这台机器，不含任何凭据 */
export interface DeviceFingerprint {
  deviceId: string;
  name: string;
  arch: string;
  platform: string;
  createdAt: number;
}

export function loadOrCreateDevice(): DeviceFingerprint {
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.device, 'utf8')) as DeviceFingerprint;
    if (parsed.deviceId) return parsed;
  } catch {
    /* 首次运行 */
  }
  const fp: DeviceFingerprint = {
    // 指纹派生自稳定硬件信息；不用随机值，否则重装后无法复用
    deviceId: hardwareFingerprint(),
    name: os.hostname(),
    arch: os.arch(),
    platform: os.platform(),
    createdAt: Date.now(),
  };
  fs.writeFileSync(PATHS.device, JSON.stringify(fp, null, 2));
  return fp;
}

function hardwareFingerprint(): string {
  const cpus = os.cpus();
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    cpus[0]?.model ?? 'unknown-cpu',
    String(cpus.length),
    String(os.totalmem()),
  ];
  // 轻量非加密哈希（FNV-1a 64bit）—— 指纹不需要抗碰撞强度
  let h = 0xcbf29ce484222325n;
  for (const part of parts) {
    for (const ch of part) {
      h ^= BigInt(ch.codePointAt(0) ?? 0);
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    h ^= 0x2fn;
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** 某个 build 的隔离 worktree 路径 */
export function worktreeFor(buildId: string): string {
  return path.join(PATHS.workspaces, buildId);
}
