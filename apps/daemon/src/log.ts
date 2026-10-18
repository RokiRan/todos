import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './paths.js';

/**
 * 日志。落 ~/.tds/daemon.log（对齐原站约定），10MB 轮转。
 * 同时写 stderr，便于前台模式观察。
 */

const MAX_BYTES = 10 * 1024 * 1024;

export interface LogSink {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    ensureDirs();
    rotateIfNeeded();
    stream = fs.createWriteStream(PATHS.log, { flags: 'a' });
    stream.on('error', () => {
      stream = null; // 文件不可写时只留 stderr
    });
    return stream;
  } catch {
    return null;
  }
}

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(PATHS.log);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(PATHS.log, PATHS.log + '.1');
  } catch {
    /* 文件不存在 */
  }
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  const s = getStream();
  if (s) s.write(line);
  process.stderr.write(line);
}

export const log: LogSink = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
};

export function closeLog(): void {
  stream?.end();
  stream = null;
}
