import crypto from 'node:crypto';

/** 全站主键：24 字符 base64url（对齐实测原站风格） */
export function newId(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/** 时间戳统一毫秒整数（实测原站如此） */
export function now(): number {
  return Date.now();
}

/** 稳定哈希，用于 toolDefHashes / diffHash 这类变更检测 */
export function stableHash(input: unknown): string {
  return crypto
    .createHash('sha256')
    .update(typeof input === 'string' ? input : JSON.stringify(input))
    .digest('base64url')
    .slice(0, 11);
}

export const nowIso = (): string => new Date().toISOString();
