import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  CARD_STATUS_TEXT,
  decodeCard,
  defaultCardAction,
  encodeCard,
  validateCredentialInput,
  type ChiefCard,
  type ConfirmCard,
  type InputCard,
  type QuestionCard,
} from '../src/chief/cards.js';

const QUESTION: QuestionCard = {
  kind: 'question',
  id: 'c1',
  askedBy: { type: 'chief', id: 'chief-1', name: '全流程统筹' },
  question: '这版 PRD 要不要覆盖国内厂商？',
  options: [
    { id: 'yes', label: '要覆盖' },
    { id: 'no', label: '先只做海外' },
  ],
  allowFreeText: true,
  context: { todoId: 't1' },
};

const CONFIRM: ConfirmCard = {
  kind: 'confirm',
  id: 'c2',
  target: { type: 'agent', id: 'a1', name: '市场与需求分析师' },
  consequence: '该 agent 会被删除，其记忆保留在团队仓库但不再注入',
  cancelHint: '取消则不做任何改动',
  affected: ['3 个 todo 正在用这个 agent'],
};

const INPUT: InputCard = {
  kind: 'input',
  id: 'c3',
  credentialType: 'provider_key',
  label: 'MiniMax API Key',
  target: { type: 'provider', id: 'p1', name: 'MiniMax CN (Anthropic)' },
  writeOnly: true,
  emptyKeepsExisting: true,
};

describe('卡片编码往返', () => {
  test('三种卡片都能 encode → decode 还原', () => {
    for (const card of [QUESTION, CONFIRM, INPUT] as ChiefCard[]) {
      const decoded = decodeCard(encodeCard(card));
      assert.deepEqual(decoded, card, `${card.kind} 往返失败`);
    }
  });

  test('编码是 JSON 字符串（与实测 system 消息一致）', () => {
    const s = encodeCard(QUESTION);
    assert.equal(typeof s, 'string');
    assert.equal(JSON.parse(s).kind, 'question');
  });

  test('kind 字段在最外层（实测信封是 {"kind":...}）', () => {
    const parsed = JSON.parse(encodeCard(CONFIRM)) as Record<string, unknown>;
    assert.equal(parsed.kind, 'confirm');
  });

  test('非卡片内容解码返回 null', () => {
    assert.equal(decodeCard('not json'), null);
    assert.equal(decodeCard('{"kind":"text_delta"}'), null);
    assert.equal(decodeCard('{"kind":"machine_selected"}'), null);
  });
});

describe('确认卡是防误删的最后闸门', () => {
  test('必须说清后果', () => {
    assert.ok(CONFIRM.consequence.length > 0);
    assert.ok(CONFIRM.consequence.includes('删除'), CONFIRM.consequence);
  });

  test('必须给出零风险的取消说明', () => {
    assert.ok(CONFIRM.cancelHint.length > 0);
  });

  test('列出连带影响', () => {
    assert.ok(CONFIRM.affected && CONFIRM.affected.length > 0);
  });

  test('确认卡的默认动作是取消，不是执行', () => {
    assert.equal(defaultCardAction(CONFIRM), 'cancel', '默认必须是安全的取消');
  });

  test('非确认卡默认提交', () => {
    assert.equal(defaultCardAction(QUESTION), 'submit');
    assert.equal(defaultCardAction(INPUT), 'submit');
  });
});

describe('凭据绝不回显', () => {
  test('校验通过只回显长度，不回传值', () => {
    const v = validateCredentialInput('sk-abcdef123456');
    assert.equal(v.ok, true);
    assert.equal(v.lengthEcho, 'sk-abcdef123456'.length);
    assert.equal(JSON.stringify(v).includes('sk-abcdef'), false, '返回值里不能含原值');
  });

  test('write-only 标记不可被关掉', () => {
    assert.equal(INPUT.writeOnly, true);
    assert.equal(INPUT.emptyKeepsExisting, true);
  });
});

describe('凭据输入校验', () => {
  test('正常 ASCII 凭据通过', () => {
    for (const v of ['sk-123', 'ghp_abcdefghijklmnopqrstuvwxyz', 'x-token-abc:123']) {
      assert.equal(validateCredentialInput(v).ok, true, v);
    }
  });

  test('含不可见字符拒绝（粘贴常见问题）', () => {
    assert.equal(validateCredentialInput('sk-abc\ndef').ok, false);
    assert.equal(validateCredentialInput('sk-abc\tdef').ok, false);
    assert.equal(validateCredentialInput('sk-abc\rdef').ok, false);
  });

  test('空格是合法可打印字符（connection header 允许）', () => {
    // 文档约束是「ASCII 可打印字符」0x20–0x7E，空格在内
    assert.equal(validateCredentialInput('sk-abc def').ok, true);
    assert.equal(validateCredentialInput('Authorization: Token abc123').ok, true);
  });

  test('DEL(0x7F) 拒绝', () => {
    assert.equal(validateCredentialInput('sk-abcdef').ok, false);
  });

  test('含非 ASCII 字符拒绝', () => {
    assert.equal(validateCredentialInput('密钥abc').ok, false);
    assert.equal(validateCredentialInput('sk-密码').ok, false);
  });

  test('必填时空值拒绝', () => {
    const v = validateCredentialInput('', { required: true });
    assert.equal(v.ok, false);
    assert.ok(v.reason?.includes('不能为空'));
  });

  test('非必填且允许保留已存时，空值合法', () => {
    const v = validateCredentialInput('', { required: false, emptyKeepsExisting: true });
    assert.equal(v.ok, true);
    assert.equal(v.lengthEcho, 0);
  });

  test('过长拒绝', () => {
    assert.equal(validateCredentialInput('a'.repeat(5000)).ok, false);
  });

  test('错误信息不回显输入内容', () => {
    const secret = 'sk-verysecret-value';
    const v = validateCredentialInput(secret + '\n');
    assert.equal(v.ok, false);
    assert.equal(JSON.stringify(v).includes('verysecret'), false, '错误信息不能泄漏凭据');
  });
});

describe('卡片状态文案', () => {
  test('未再等待的表述与文档一致', () => {
    assert.equal(CARD_STATUS_TEXT.no_longer_awaiting, '该问题已不再等待回答');
  });

  test('四种状态都有中文文案', () => {
    for (const [k, v] of Object.entries(CARD_STATUS_TEXT)) {
      assert.ok(v.length > 0, k);
    }
  });
});
