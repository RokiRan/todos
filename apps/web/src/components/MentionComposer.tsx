'use client';

/**
 * MentionComposer —— 多行输入 + 5 类 mention toolbar + 结构化 chip。
 *
 * 事实源（来自 `D:/AI/todos/recon-live/docs-conversation.md` 第 34 行）：
 *   "@ agent or member, # todo, / skill, ~ project, & machine"
 *   "A mention inserts a structured reference chip rather than plain text"
 *
 * ## 关键设计 —— chip 与文本的同步方案
 *
 * 选 **方案 A（可见文本 + mentions 数组双轨）**：
 *   - 用户可见的 `text` 字段里**保留** prefix + label 的可见文本：
 *     "请 @Alex 看一下 #42 这个 todo"
 *   - 同时维护一个 `mentions: MentionRef[]` 数组，**按出现顺序**记下每次选中。
 *   - 发送时把 `content: text` 与 `mentions` 一起 POST 给后端，让后端用
 *     `mentions[*].refId` 解析结构化引用；模型看到的还是带前缀的可见文本
 *     （语义自洽）；后端则拿到精确 ID（去歧义）。
 *
 *   - **方案 B（零宽字符占位）的坑**：零宽字符定位困难、删除同步极易
 *     与原生 textarea 选区错位（实测 cursor 在零宽字符之间落在奇怪位置），
 *     而原站已经用「可见 label + 内部数组」的方案（A）。选 A 是与原站
 *     一致，不是为了炫技。
 *
 * ## 删除同步
 *
 *   - 用户在 textarea 里**按字符删**：`text` 自动跟随 → 我们的 segments
 *     通过 `reconcileWithText` 退化为单 text 段（chip 全部脱落为可见文本），
 *     这是「保守策略」—— 删 chip 中间字符无法精确判定用户意图。与原站
 *     「chip 就是文字」的语义一致。
 *   - 用户点 chip 上的 × ：把对应 mention 从 segments 里删除，同时把
 *     `text` 里该段（prefix + label）一并剪掉 —— 双向同步实现见
 *     `removeChipByRefId` + `foldAdjacentText`。
 *
 * ## `/` 前缀的误触防护（必须行首/空白之后 + 至少 1 字符）
 *
 * 文本里的 `/usr/local`、URL、路径都是合法字符。规则：
 *   1. **必须是「行首」或「空白之后」**：从光标位置向前扫，遇到空白/换行/标点
 *      边界才认；位置 0 也算合法起点。
 *   2. **后跟至少 1 个字符**：光标紧贴 `/` 之后没有再输入任何字符时**不**
 *   出选择器 —— 让用户先把关键词打出来再选。
 *   3. 任何不满足 (1) 的情形都**不**算 mention 选择态。
 *
 *   - `@` / `#` / `~` / `&` 也用相同规则，但误触概率低，主要是 `/` 严格。
 *
 * ## 发送时两步绑定（MentionsStore 已交付）
 *
 *   1. POST `/api/builds/:buildId/messages`（父组件持有的旧路径）→
 *      拿 `message.id`。`mentions` 也随 body 一起发（只是元数据）。
 *   2. **当且仅当 `mentions.length > 0` 且 `!queued`** 时：
 *      POST `/api/todos/:todoId/mentions`，
 *      body `{ messageId, mentions: MentionRef[] }`。
 *
 * 两步逻辑在 **父组件 (`todo/[id]/page.tsx` 的 `composerSubmit`)** 里
 * 完成 —— MentionComposer 只把 `(text, mentions)` 通过 `onSubmit` 回调交
 * 还；本组件不直接发请求。详细错误码语义（403/404/422）见父组件代码。
 *
 * ## 保留 steering 队列
 *
 * 父组件传入 `onSubmit` —— 旧 Composer 的「进队 vs 直接落库」逻辑由父
 * 组件（即 todo/[id]/page.tsx）继续持有；MentionComposer 只负责：
 *   - 内部维护 chip/text 双轨
 *   - 调用 `onSubmit(text, mentions)`，把 mentions 也带上
 *   - 父组件判定落库还是入队（跟旧逻辑完全一致）
 *
 * ## 插入入口（drop 桥）
 *
 * 父组件持有 `useRef<MentionComposerHandle | null>(null)` 并通过 `ref` 传进来。
 * 本组件用 `forwardRef` + `useImperativeHandle` 暴露 `insertMention(m)`：
 * DropCard 在 drop 时调 `composerRef.current?.insertMention(m)`，由
 * `useImperativeHandle` 的 deps 数组保证拿到的是最新 closure（segments +
 * text + cursor），不会因 render 闭包捕获过期值。
 *
 * 连续多次调 `insertMention(m)` 时 chip 位置正确（每次按当前光标插入），
 * 因为 handle 内部通过 `stateRef.current` 读最新 cursor。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent,
} from 'react';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import MentionPicker, { type MentionPickerKind } from '@/components/MentionPicker';
import { type MentionKind, type MentionPrefix, type MentionRef } from '@/lib/api';

// ── 类型 ─────────────────────────────────────────────────────────

export interface MentionComposerProps {
  /** buildId —— 不可用时整体禁用（与旧 Composer 行为一致）。 */
  buildId: string | null;
  /** 当前正在发送（外部持有 busy 状态，避免发送中并发）。 */
  busy: boolean;
  /** 错误提示（外部透传 4xx 等）。 */
  error: string | null;
  /** 成功提示（外部透传「已加入队列 / 已记录」等）。 */
  notice: string | null;
  /** todo 关联的 teamId —— MentionPicker 拉 candidates 必要。 */
  teamId: string | null;
  /**
   * 父组件决定「落 build_message 还是进 steering 队列」的入口。
   * MentionComposer 在内部把 text + mentions 打包好交给父组件，
   * 父组件原有的 `composerSubmit` 完全复用（行为零变更）。
   */
  onSubmit: (text: string, mentions: MentionRef[]) => void | Promise<void>;
}

/**
 * **DropCard / ChiefConversationCard 持有的 handle。**
 *
 * 用法（父组件侧）：
 *
 *   const composerRef = useRef<MentionComposerHandle | null>(null);
 *   <MentionComposer ref={composerRef} ... />
 *   // 在 drop handler 里：
 *   composerRef.current?.insertMention({
 *     kind: 'todo', refId: t.id, label: t.title, prefix: '#', meta: '#' + t.seqNum,
 *   });
 *
 * 连续多次调 `insertMention(m)` 时 chip 位置正确（每次按当前光标插入），
 * 因为 handle 在 useImperativeHandle 的依赖数组里带了 `segments` / `text` /
 * `cursorPos` —— 每次 state 变化都拿到最新的 closure，光标不会过期。
 */
export interface MentionComposerHandle {
  /** 插入一个结构化引用 chip。只插入，不自动发送。 */
  insertMention: (m: MentionRef) => void;
}

// ── 前缀触发规则 ────────────────────────────────────────────────

interface MentionTrigger {
  kind: MentionPickerKind;
  /** `text` 中前缀符号所在的下标；用于后面插入 chip 时知道从哪开始切。 */
  startIndex: number;
  /** 查询关键词（去掉前缀符号）。空 = 紧贴光标，没输入字符。 */
  query: string;
}

const MENTION_PREFIXES: ReadonlyArray<{ readonly char: string; readonly kind: MentionPickerKind }> = [
  { char: '@', kind: 'agentOrMember' },
  { char: '#', kind: 'todo' },
  { char: '/', kind: 'skill' },
  { char: '~', kind: 'project' },
  { char: '&', kind: 'machine' },
];

function detectActiveMention(text: string, cursor: number): MentionTrigger | null {
  if (cursor <= 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  // 从 cursor 往前扫到上一个空白/换行边界，得到 token 起点
  let tokenStart = before.length;
  let stoppedAtBoundary = false;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before.charCodeAt(i);
    // 空白、换行归为边界
    if (
      ch === 0x20 /* space */ ||
      ch === 0x09 /* tab */ ||
      ch === 0x0a /* \n */ ||
      ch === 0x0d /* \r */
    ) {
      tokenStart = i + 1;
      stoppedAtBoundary = true;
      break;
    }
    tokenStart = i;
  }
  // 行首合法 —— 没有扫到边界且 tokenStart 已经回到 0
  if (!stoppedAtBoundary) tokenStart = 0;
  const token = before.slice(tokenStart);
  if (token.length === 0) return null;
  const firstChar = token.charAt(0);
  const entry = MENTION_PREFIXES.find((p) => p.char === firstChar);
  if (!entry) return null;
  // 必须至少 1 个字符（prefix 之后）
  if (token.length < 2) return null;
  return {
    kind: entry.kind,
    startIndex: tokenStart,
    query: token.slice(1),
  };
}

// ── 内部 Segment 模型 ────────────────────────────────────────────

interface TextSegment {
  kind: 'text';
  value: string;
}
interface ChipSegment {
  kind: 'chip';
  mention: MentionRef;
}
type Segment = TextSegment | ChipSegment;

function toPlainText(segs: Segment[]): string {
  return segs
    .map((s) => (s.kind === 'text' ? s.value : s.mention.prefix + s.mention.label))
    .join('');
}

function foldAdjacentText(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.kind === 'text' && s.kind === 'text') {
      last.value += s.value;
    } else {
      out.push(s);
    }
  }
  return out;
}

function project(
  segs: Segment[],
  trigger: MentionTrigger,
  mention: MentionRef,
): Segment[] {
  const startIndex = trigger.startIndex;
  const queryLen = trigger.query.length;
  const totalToRemove = 1 + queryLen;
  let cursor = 0;
  const out: Segment[] = [];
  let removed = false;
  for (const s of segs) {
    if (removed) {
      out.push(s);
      continue;
    }
    const len = s.kind === 'text' ? s.value.length : s.mention.prefix.length + s.mention.label.length;
    if (s.kind === 'text') {
      const segStart = cursor;
      const segEnd = cursor + len;
      if (startIndex >= segStart && startIndex + totalToRemove <= segEnd) {
        const localStart = startIndex - segStart;
        const localEnd = localStart + totalToRemove;
        const head = s.value.slice(0, localStart);
        const tail = s.value.slice(localEnd);
        if (head.length > 0) out.push({ kind: 'text', value: head });
        out.push({ kind: 'chip', mention });
        if (tail.length > 0) out.push({ kind: 'text', value: tail });
        removed = true;
      } else if (startIndex >= segStart && startIndex < segEnd) {
        const localStart = startIndex - segStart;
        const head = s.value.slice(0, localStart);
        const remainToRemove = totalToRemove - (segEnd - startIndex);
        const tail = s.value.slice(localStart).slice(remainToRemove);
        if (head.length > 0) out.push({ kind: 'text', value: head });
        out.push({ kind: 'chip', mention });
        if (tail.length > 0) out.push({ kind: 'text', value: tail });
        removed = true;
      } else {
        out.push(s);
      }
    } else {
      out.push(s);
    }
    cursor += len;
  }
  if (!removed) {
    out.push({ kind: 'chip', mention });
  }
  return out;
}

function removeChipByRefId(segs: Segment[], refId: string): Segment[] {
  const out: Segment[] = [];
  let dropped = false;
  for (const s of segs) {
    if (!dropped && s.kind === 'chip' && s.mention.refId === refId) {
      dropped = true;
      continue;
    }
    out.push(s);
  }
  return foldAdjacentText(out);
}

function reconcileWithText(segs: Segment[], newText: string): Segment[] {
  if (toPlainText(segs) === newText) return segs;
  // 退化：所有 chip 视为已脱落
  return [{ kind: 'text', value: newText }];
}

// ── chip 颜色（五前缀各异，绝不使用 C.warn） ──────────────────

function chipColor(prefix: string): { fg: string; bg: string; border: string } {
  switch (prefix) {
    case '@':
      return {
        fg: C.accent,
        bg: 'rgba(129,140,248,0.15)',
        border: 'rgba(129,140,248,0.45)',
      };
    case '#':
      return {
        fg: C.ok,
        bg: 'rgba(74,222,128,0.12)',
        border: 'rgba(74,222,128,0.45)',
      };
    case '/':
      return {
        fg: C.text,
        bg: C.code,
        border: C.line,
      };
    case '~':
      return {
        fg: '#a5b4fc',
        bg: 'rgba(165,180,252,0.10)',
        border: 'rgba(165,180,252,0.45)',
      };
    case '&':
      return {
        fg: C.textDim,
        bg: 'rgba(212,212,216,0.10)',
        border: 'rgba(212,212,216,0.35)',
      };
    default:
      return {
        fg: C.text,
        bg: C.code,
        border: C.line,
      };
  }
}

// ── 主组件 ─────────────────────────────────────────────────────

const MentionComposer = forwardRef<MentionComposerHandle, MentionComposerProps>(function MentionComposer(
  props,
  ref,
): React.JSX.Element {
  const { buildId, busy, error, notice, teamId, onSubmit } = props;

  const [segments, setSegments] = useState<Segment[]>([{ kind: 'text', value: '' }]);
  const [text, setText] = useState<string>('');

  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [cursorPos, setCursorPos] = useState<number>(0);
  const [activeTrigger, setActiveTrigger] = useState<MentionTrigger | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [toolbarOpen, setToolbarOpen] = useState<boolean>(false);

  // 用 ref 持有最新 state，避免 closure 过期
  const stateRef = useRef({ segments, text, cursorPos });
  useEffect(() => {
    stateRef.current = { segments, text, cursorPos };
  }, [segments, text, cursorPos]);

  /**
   * **drop 桥的核心实现** —— 通过 forwardRef 暴露给父组件。
   * 关键：闭包依赖 `stateRef.current`，所以连续多次 drop 时每次都拿到
   * 最新 segments + text + cursor（不会因 render 闭包捕获过期值）。
   * 副作用：setSegments/setText/setCursorPos 触发重渲染，下一轮
   * stateRef.current 自动更新。
   */
  const insertMention = useCallback((m: MentionRef): void => {
    const cur = textareaRef.current;
    const curCursor = cur?.selectionStart ?? stateRef.current.text.length;
    const curText = stateRef.current.text;
    const curSegments = stateRef.current.segments;
    const trigger = detectActiveMention(curText, curCursor);
    if (trigger) {
      const next = project(curSegments, trigger, m);
      const folded = foldAdjacentText(next);
      setSegments(folded);
      const newText = toPlainText(folded);
      setText(newText);
      const newCursor = trigger.startIndex + m.prefix.length + m.label.length;
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (t) {
          t.selectionStart = newCursor;
          t.selectionEnd = newCursor;
          t.focus();
        }
      });
      setPickerOpen(false);
      setActiveTrigger(null);
    } else {
      const before = curText.slice(0, curCursor);
      const after = curText.slice(curCursor);
      const next: Segment[] = [
        ...(before.length === 0 ? [] : [{ kind: 'text', value: before } as Segment]),
        { kind: 'chip', mention: m },
        ...(after.length === 0 ? [] : [{ kind: 'text', value: after } as Segment]),
      ];
      const folded = foldAdjacentText(next);
      setSegments(folded);
      const newText = toPlainText(folded);
      setText(newText);
      const newCursor = curCursor + m.prefix.length + m.label.length;
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (t) {
          t.selectionStart = newCursor;
          t.selectionEnd = newCursor;
          t.focus();
        }
      });
    }
  }, []);

  // 把 insert 函数通过 ref 暴露给父组件。
  // 依赖 `segments`/`text`/`cursorPos` 触发 re-create —— 实际上闭包通过
  // stateRef 拿最新值，所以这里 deps 只为「handle 句柄引用更新」而已。
  // state 变 → 重新创建 insertMention → handle 重置 → 父组件下次拿到的
  // 是新的引用（语义一致：handle 永远反映最新 state）。
  useImperativeHandle(
    ref,
    (): MentionComposerHandle => ({ insertMention }),
    [insertMention],
  );

  // ── 触发规则 effect ──────────────────────────────────────

  const detected = useMemo(() => {
    if (!pickerOpen && activeTrigger === null) {
      // 主动判定当前 cursor 处的 mention —— 仅在已经手动打开时
      return detectActiveMention(text, cursorPos);
    }
    return activeTrigger;
  }, [text, cursorPos, pickerOpen, activeTrigger]);

  useEffect(() => {
    if (detected && detected.query.length >= 1) {
      setPickerOpen(true);
      setActiveTrigger(detected);
    } else if (detected && detected.query.length === 0) {
      // query 空：不开 picker，误触防护
      setPickerOpen(false);
      setActiveTrigger(null);
    } else {
      setPickerOpen(false);
      setActiveTrigger(null);
    }
  }, [detected]);

  // ── textarea handlers ─────────────────────────────────────

  const onTextChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>): void => {
      const newText = e.target.value;
      const newCursor = e.target.selectionStart ?? newText.length;
      setText(newText);
      setCursorPos(newCursor);
      setSegments((prev) => reconcileWithText(prev, newText));
      // 每次键入都判定一次 —— 不依赖 pickerOpen 状态
      const t = detectActiveMention(newText, newCursor);
      if (t && t.query.length >= 1) {
        setPickerOpen(true);
        setActiveTrigger(t);
      } else {
        setPickerOpen(false);
        setActiveTrigger(null);
      }
    },
    [],
  );

  const onCursorMove = useCallback((): void => {
    const cur = textareaRef.current;
    if (!cur) return;
    setCursorPos(cur.selectionStart ?? 0);
  }, []);

  // ── 选中 callback ─────────────────────────────────────────

  const onPickMention = useCallback(
    (m: MentionRef): void => {
      if (!activeTrigger) {
        setPickerOpen(false);
        return;
      }
      const next = project(segments, activeTrigger, m);
      const folded = foldAdjacentText(next);
      setSegments(folded);
      const newText = toPlainText(folded);
      setText(newText);
      const newCursor =
        activeTrigger.startIndex + m.prefix.length + m.label.length;
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (t) {
          t.selectionStart = newCursor;
          t.selectionEnd = newCursor;
          t.focus();
        }
      });
      setPickerOpen(false);
      setActiveTrigger(null);
    },
    [activeTrigger, segments],
  );

  const onClosePicker = useCallback((): void => {
    setPickerOpen(false);
    setActiveTrigger(null);
  }, []);

  const removeChip = useCallback(
    (refId: string): void => {
      const next = removeChipByRefId(segments, refId);
      const folded = foldAdjacentText(next);
      setSegments(folded);
      const newText = toPlainText(folded);
      setText(newText);
      setCursorPos(newText.length);
    },
    [segments],
  );

  // ── toolbar ──────────────────────────────────────────────

  const onToolbarPick = useCallback(
    (kind: MentionPickerKind): void => {
      setToolbarOpen(false);
      const cur = textareaRef.current;
      const curCursor = cur?.selectionStart ?? text.length;
      const prefixChar = (() => {
        switch (kind) {
          case 'agentOrMember':
            return '@';
          case 'todo':
            return '#';
          case 'skill':
            return '/';
          case 'project':
            return '~';
          case 'machine':
            return '&';
        }
      })();
      const before = text.slice(0, curCursor);
      const after = text.slice(curCursor);
      const needSpace =
        before.length > 0 && !/\s/.test(before.charAt(before.length - 1));
      const insertText = (needSpace ? ' ' : '') + prefixChar;
      const newText = before + insertText + after;
      const newCursor = curCursor + insertText.length;
      setText(newText);
      setSegments(reconcileWithText(segments, newText));
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (t) {
          t.selectionStart = newCursor;
          t.selectionEnd = newCursor;
          t.focus();
        }
      });
      // toolbar 选了类别后，让用户在 prefix 后再打 1 字符才会显示 picker。
      // 不立刻开 picker —— 误触防护规则要求至少 1 字符。
    },
    [text, segments],
  );

  // ── submit ───────────────────────────────────────────────

  const onSend = useCallback((): void => {
    if (busy) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (!buildId) return;
    const mentions = segments.flatMap((s) => (s.kind === 'chip' ? [s.mention] : []));
    void onSubmit(trimmed, mentions);
  }, [busy, buildId, text, segments, onSubmit]);

  const onTextareaKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (pickerOpen && activeTrigger) {
          // 让 picker 处理 Enter
          e.preventDefault();
          return;
        }
        e.preventDefault();
        onSend();
      }
    },
    [pickerOpen, activeTrigger, onSend],
  );

  // ── 渲染 ──────────────────────────────────────────────────

  return (
    <div>
      {/* chip 区 */}
      {segments.some((s) => s.kind === 'chip') && (
        <div style={chipBarStyle} aria-label="已选 mention">
          {segments.map((s, i) => {
            if (s.kind === 'text') return null;
            const c = chipColor(s.mention.prefix);
            return (
              <span
                key={`chip-${i}-${s.mention.refId}`}
                style={{
                  ...chipSpanStyle,
                  color: c.fg,
                  background: c.bg,
                  borderColor: c.border,
                }}
                title={`${s.mention.prefix}${s.mention.label}（${s.mention.kind}）`}
              >
                <span style={{ marginRight: 4, fontWeight: 600 }}>
                  {s.mention.prefix}
                </span>
                {s.mention.label}
                <button
                  type="button"
                  aria-label={`移除 ${s.mention.label}`}
                  style={chipRemoveBtnStyle}
                  onClick={() => removeChip(s.mention.refId)}
                  disabled={busy}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={onTextChange}
        onKeyDown={onTextareaKeyDown}
        onSelect={onCursorMove}
        onClick={onCursorMove}
        onKeyUp={onCursorMove}
        placeholder={
          buildId
            ? '给 agent 发一条消息（@ # / ~ & 引用对象；Enter 发送，Shift+Enter 换行）……'
            : '当前没有可发往的 build（等 build 启动后再试）'
        }
        rows={3}
        disabled={busy || !buildId}
        style={textareaStyle}
      />

      {pickerOpen && activeTrigger && activeTrigger.query.length >= 1 && (
        <MentionPicker
          kind={activeTrigger.kind}
          query={activeTrigger.query}
          teamId={teamId}
          onPick={onPickMention}
          onClose={onClosePicker}
        />
      )}

      <div style={toolbarStyle}>
        <button
          type="button"
          onClick={() => setToolbarOpen((v) => !v)}
          disabled={busy || !buildId}
          style={toolbarToggleStyle}
          aria-expanded={toolbarOpen}
          aria-label="Mention 选择器"
        >
          Mention {toolbarOpen ? '▴' : '▾'}
        </button>
        {toolbarOpen && (
          <div style={toolbarCategoriesStyle}>
            {MENTION_PREFIXES.map((p) => (
              <button
                key={p.char}
                type="button"
                onClick={() => onToolbarPick(p.kind)}
                disabled={busy || !buildId}
                style={{
                  ...toolbarCategoryBtnStyle,
                  color: chipColor(p.char).fg,
                  borderColor: chipColor(p.char).border,
                  background: chipColor(p.char).bg,
                }}
              >
                {p.char}{' '}
                {p.kind === 'agentOrMember' ? 'agent/member' : p.kind}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={sendRowStyle}>
        <button
          type="button"
          onClick={onSend}
          disabled={busy || text.trim().length === 0 || !buildId}
          style={sendBtnStyle}
        >
          {busy ? '发送中…' : '发送'}
        </button>
        <span style={{ color: C.textDim, fontSize: T.sm }}>
          {text.trim().length} 字符 ·{' '}
          {segments.filter((s) => s.kind === 'chip').length} mention
        </span>
      </div>
      {error && <div style={errorStyle}>{error}</div>}
      {notice && <div style={noticeStyle}>{notice}</div>}
    </div>
  );
});

export default MentionComposer;

// ── 样式 ────────────────────────────────────────────────────────

const chipBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: S.xs,
  marginBottom: S.sm,
};

const chipSpanStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: S.xs,
  padding: `2px ${S.sm}px`,
  borderRadius: R.pill,
  border: `1px solid ${C.line}`,
  fontSize: T.meta,
  fontFamily: F.sans,
};

const chipRemoveBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: T.body,
  padding: `0 ${S.xs}px`,
  marginLeft: 2,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: `${S.sm}px ${S.md}px`,
  fontFamily: F.sans,
  fontSize: T.body,
  resize: 'vertical',
  minHeight: 64,
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.sm,
  marginTop: S.sm,
  flexWrap: 'wrap',
};

const toolbarToggleStyle: CSSProperties = {
  ...shared.ghostBtn,
};

const toolbarCategoriesStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.xs,
  flexWrap: 'wrap',
};

const toolbarCategoryBtnStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${C.line}`,
  borderRadius: R.pill,
  padding: `2px ${S.sm}px`,
  fontSize: T.meta,
  cursor: 'pointer',
  fontFamily: F.sans,
};

const sendRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.sm,
  marginTop: S.sm,
};

const sendBtnStyle: CSSProperties = {
  ...shared.primaryBtn,
};

const errorStyle: CSSProperties = {
  ...shared.errorBox,
  marginTop: S.sm,
  fontSize: T.meta,
};

const noticeStyle: CSSProperties = {
  marginTop: S.sm,
  fontSize: T.meta,
  color: C.textDim,
};

// ── 给外部的类型桥 ────────────────────────────────────────────

/**
 * **DropCard / ChiefConversationCard 切片使用的 handle 类型。**
 * 父组件持有 `useRef<MentionComposerHandle | null>(null)`，传 ref 即可：
 *
 *   <MentionComposer ref={composerRef} ... />
 *   composerRef.current?.insertMention({
 *     kind: 'todo', refId: t.id, label: t.title, prefix: '#',
 *   });
 */

/**
 * **MentionRef 类型桥** —— 让父组件可以从 MentionComposer 直接 import。
 * 现在直接 re-export `apps/web/src/lib/api.ts` 的正式版本（MentionsStore
 * 已交付）。
 */
export type { MentionRef, MentionKind, MentionPrefix } from '@/lib/api';
export type { MentionPickerKind } from '@/components/MentionPicker';