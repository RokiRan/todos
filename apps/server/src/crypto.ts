import crypto from 'node:crypto';

/**
 * 凭据加密。
 *
 * 安全等级对齐原站（文档 + bundle §6.3）：
 *   - AES-256-GCM，每条记录独立 nonce
 *   - KEK 来自环境变量，永不进数据库
 *   - 读接口永不返回明文
 *   - **只在 machine claim step 的响应里下发一次**，turn 结束即失效
 *
 * 明文只在内存中短暂存在，不写日志、不落盘。
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM 推荐 96-bit
const TAG_BYTES = 16;

/** 从环境变量派生 KEK。生产要求 32 字节 base64；开发缺失时给确定性派生值。 */
export function getKek(): Buffer {
  const raw = process.env.TDS_KEK;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(`TDS_KEK must be 32 bytes base64 (got ${buf.length})`);
    }
    return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TDS_KEK is required in production');
  }
  // 开发模式：确定性派生，便于重启后仍能解出之前加密的数据
  return crypto.createHash('sha256').update('tds-dev-kek-do-not-use-in-prod').digest();
}

export interface Sealed {
  cipher: string;  // base64
  nonce: string;   // base64
  tag: string;     // base64
}

export function seal(plaintext: string, kek: Buffer = getKek()): Sealed {
  const nonce = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, kek, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    cipher: enc.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(sealed: Sealed, kek: Buffer = getKek()): string {
  const decipher = crypto.createDecipheriv(ALGO, kek, Buffer.from(sealed.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * API key 专用：只存 HMAC-SHA256，永不存明文。
 * 用 HMAC 而非裸 SHA256 —— 防彩虹表，且允许服务端持 KEK 之外的独立密钥。
 */
export function hashApiKey(key: string, kek: Buffer = getKek()): string {
  return crypto.createHmac('sha256', kek).update(key).digest('hex');
}

/** 恒定时间比较，避免时序侧信道 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 生成机器注册用的 API key（形如原站的 tds_ 前缀）。
 * kek 必须显式传入 —— 否则生成的 hash 与验签时的 KEK 可能不一致，
 * 导致 key 永远校验不过。
 */
export function generateApiKey(kek: Buffer = getKek()): { key: string; prefix: string; hash: string } {
  const body = crypto.randomBytes(24).toString('base64url');
  const key = `tds_${body}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key, kek) };
}
