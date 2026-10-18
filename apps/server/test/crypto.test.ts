import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import crypto from 'node:crypto';
import { seal, open, hashApiKey, timingSafeEqualStr, generateApiKey } from '../src/crypto.js';

const KEK = crypto.createHash('sha256').update('test-kek').digest();

describe('凭据加密', () => {
  test('seal/open 往返', () => {
    const s = seal('sk-secret-value', KEK);
    assert.notEqual(s.cipher, 'sk-secret-value');
    assert.equal(open(s, KEK), 'sk-secret-value');
  });

  test('每次 seal 的 nonce 不同 —— 同一明文不产生同一密文', () => {
    const a = seal('same', KEK);
    const b = seal('same', KEK);
    assert.notEqual(a.nonce, b.nonce, 'nonce 必须每次随机');
    assert.notEqual(a.cipher, b.cipher, '密文应不同');
    assert.equal(open(a, KEK), open(b, KEK));
  });

  test('错误 KEK 解不出内容', () => {
    const s = seal('secret', KEK);
    const wrongKek = crypto.createHash('sha256').update('wrong').digest();
    assert.throws(() => open(s, wrongKek));
  });

  test('密文被篡改会触发 auth tag 校验失败', () => {
    const s = seal('secret', KEK);
    const tampered = {
      ...s,
      cipher: Buffer.from('tampered-payload').toString('base64'),
    };
    assert.throws(() => open(tampered, KEK), 'GCM 必须检测篡改');
  });

  test('nonce 被篡改同样失败', () => {
    const s = seal('secret', KEK);
    assert.throws(() => open({ ...s, nonce: crypto.randomBytes(12).toString('base64') }, KEK));
  });

  test('空字符串可加密', () => {
    const s = seal('', KEK);
    assert.equal(open(s, KEK), '');
  });

  test('长明文（10KB）往返正确', () => {
    const long = 'x'.repeat(10_000);
    assert.equal(open(seal(long, KEK), KEK), long);
  });

  test('UTF-8 明文往返正确', () => {
    const cn = '密钥值-中文-🔐';
    assert.equal(open(seal(cn, KEK), KEK), cn);
  });
});

describe('API key 哈希', () => {
  test('同一 key 哈希稳定', () => {
    assert.equal(hashApiKey('tds_abc', KEK), hashApiKey('tds_abc', KEK));
  });

  test('不同 key 哈希不同', () => {
    assert.notEqual(hashApiKey('tds_abc', KEK), hashApiKey('tds_abd', KEK));
  });

  test('哈希不含原文', () => {
    assert.ok(!hashApiKey('tds_secret_key', KEK).includes('secret'));
  });
});

describe('生成的 API key', () => {
  test('带 tds_ 前缀（与原站一致）', () => {
    const { key } = generateApiKey();
    assert.ok(key.startsWith('tds_'));
    assert.ok(key.length > 20);
  });

  test('两次生成不相同', () => {
    assert.notEqual(generateApiKey().key, generateApiKey().key);
  });

  test('hash 可反查校验', () => {
    const { key, hash } = generateApiKey(KEK);
    assert.equal(hashApiKey(key, KEK), hash);
  });

  test('KEK 贯穿 —— 用不同 KEK 生成则验签失败（这正是修复的 bug）', () => {
    const otherKek = crypto.createHash('sha256').update('other').digest();
    const { key, hash } = generateApiKey(KEK);
    assert.notEqual(hashApiKey(key, otherKek), hash);
  });
});

describe('时序安全比较', () => {
  test('相等返回 true', () => {
    assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  });
  test('不等返回 false（长度不同）', () => {
    assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  });
  test('不等返回 false（同长度不同内容）', () => {
    assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  });
});
