'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, MutableRefObject } from 'react';
import Link from 'next/link';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import { useTeamContext } from '@/lib/team-context';
import type { ChiefThread, ConversationMessage } from '@/app/chief/chief-types';
import { type MentionRef } from '@/lib/api';
import { type MentionComposerHandle } from '@/components/MentionComposer';

/** dragstart 时 dataTransfer 的 MIME —— 复用时按这个字符串取值 */
const TODO_DRAG_MIME = 'application/x-tds-todo-ids';
/** payload 是 JSON：`{ ids: string[] }` */
interface TodoDragPayload {
  ids: string[];
}

/**
 * 与 MentionComposer 集成的现状（2026-10-18 DropCard 切片决定）。
 *
 * 历史走过的弯路（提一下免得后人重做）：
 *   - 之前 dispatch 一个 `tds:mention:insert` window CustomEvent 让
 *     MentionComposer 订阅，但 MentionComposer 落库后从未挂过 listener，
 *     派发一个没人消费的事件比不派发更糟（误导），已裁撤。
 *
 * 当前架构（沿用至今）：
 *   - 首页 CCC **没有** `<MentionComposer>` 实例：Chief topic 走
 *     `chief_message` 表，不属于 build_message；MentionComposer 要求
 *     `buildId` 非空才解禁（详见 `MentionComposer.tsx` 的 `buildId`
 *     守卫），强行装它会把整块 composer 禁用掉，是回归。
 *   - 因此本切片**本地实现**一份最小化的 chip 跟踪：
 *     `insertedChips: Array<{ refId }>` 记录拖进来的 refId；textarea
 *     文本里自动追加 `#<refId[:6]>` 这种短标识作为「chip 的可发送形
 *     态」；输入框上方渲染一条 chip bar（沿用 MentionComposer 的
 *     `chipColor('#')` 配色）让用户看到并能 × 移除。
 *   - drop 时仍调 `onDropTodoReferences(refs)`（签名冻结不动）—— 这是
 *     父组件 `page.tsx` 的 `handleDropTodoReferences`，它已经用看板数
 *     据把 refs 的 label/seqNum 填好；本切片不去碰 page.tsx（其它切片
 *     拥有），真实 label 的 chip 渲染不在本切片负责范围。
 *   - 若调用方装了 MentionComposer 并把 `dropComposerRef` 传进来，本
 *     组件**仍优先**走 `tryInsertIntoComposer` —— 那条路径走 MentionComposer
 *     自己的 chip + segments 模型，本切片不接管。
 */

/**
 * 把 `/chief/[threadId]` 的对话区抽成可嵌入首页左栏的卡片。
 *
 * **设计动机**：`SplitPane` 的 `left` 是 `ReactNode`，直接渲染一个完整
 *  `/chief/[threadId]` 子页面也行，但那样会把 settings 风格的「← Chief
 *  返回链接」/「Watching」区也带进来，污染首页左栏。抽成卡片组件：
 *   - 没有返回链接
 *   - 没有 Watching 列表
 *   - 标题可点击切换 topic（popover 列表）
 *   - 消息流 + composer 完整保留
 *
 * 与 `/chief/[threadId]/page.tsx` **共享类型**（chief-types.ts），但 UI 不
 * 重复那个文件的全部样式 —— 只搬用对话区所需样式，简化版。
 *
 * **复用 / 重复的取舍**：本组件与 `/chief/[threadId]/page.tsx` 都有对话
 * 流；但 settings 那页（不允许触碰）也有一份。三处**各自维护一份对话
 * UI** —— 把合并留给后续切片处理。本卡片与 `/chief/[threadId]` 的 UI
 * 共享消息流 / composer 的 90% 代码，靠 code review 兜底不要漂移。
 *
 * **拖卡进对话（DropCard 切片引入）**：
 * composer 区现在支持 drop `application/x-tds-todo-ids`（看板拖来的多选 todo）。
 * 实现细节见 `handleComposerDrop`：
 *   1. 优先看父组件是否传了 `dropComposerRef`（即 MentionComposer handle）。
 *      若有 → 走 `tryInsertIntoComposer(refs)`，每张卡 `insertMention` 一次；
 *      全部成功就显示一条「已灌入输入框」状态条，**不**走本地 chip 路径。
 *   2. 否则（首页 CCC 的现状）→ 本切片自管的最小 chip 跟踪：
 *      - 把每个 ref 的 `refId` 入 `insertedChips`；
 *      - 在 `input` 文本末尾自动追加 `#<refId[:6]>`（短标识，**这是发到
 *        Chief 时实际进入 message body 的那部分** —— Chief 端没有
 *        mentions 字段，只能让 LLM 看到 token 后自己用 `todos` 工具解析）；
 *      - chip bar 上方渲染每个 chip 的可视徽章（沿用 MentionComposer
 *        的 `chipColor('#')` 绿调）+ × 移除（同时把对应 token 从文本里
 *        抹掉）；
 *      - 状态条说明「N 张卡已插入：refId 短标识形态，发送后总管会读到
 *        完整信息（card 侧会把真实 label/seqNum 回填）」—— 实话告知
 *        当前是占位态。
 *   3. 任何时候都仍调 `onDropTodoReferences(refs)`（签名冻结不动）——
 *      父组件 `page.tsx` 仍按它的逻辑处理：它已经把 refs 的 label 用
 *      看板 todo 数据覆盖成 `#<seqNum> <title>`，但本切片不依赖那个
 *      覆盖（占位 refId 已经够 LLM 调工具查）。
 *
 * **诚实性约束**（DropCard 必须传达的）：
 *   - 「drop 在输入框」≠ 「已通知 Chief」—— chip 的可见 token 已落入
 *     message body（Chief LLM 会读到），但本切片并不写「已绑定的
 *     mentions」表，那是 build_message 链路（todo/[id]/page.tsx）的职责。
 *     在 UI 上如实说明「refId 形态」。
 *   - 拖入失败（ids 解析不出、payload 不合法）→ 显示一条错误理由，
 *     不静默丢弃。
 */
export interface ChiefConversationCardProps {
  threadId: string;
  /**
   * 当用户拖看板 todo 卡进 composer 时触发 —— 这是「收单」回调。
   * refs 是已构造的 `MentionRef[]`，父组件（HomePage）用它做现实层（写
   * 顶部 notice、查 todo 表回填 label）。CCC 本地会把 refId 灌入
   * `insertedChips` 跟踪（详见「拖卡进对话」段落），refs 的 label
   * 字段是 refId 占位；真实 `#<seqNum> <title>` 的填充由父组件在
   * `handleDropTodoReferences` 里用看板数据覆盖，但本切片**不依赖**
   * 那个覆盖（refId token 已够 LLM 调 `todos` 工具查完整信息）。
   */
  onDropTodoReferences?: (refs: MentionRef[]) => void;
  /**
   * MentionComposer 的 ref handle。集成责任人（todo/[id]/page.tsx 的拥有者）
   * 把 `<MentionComposer ref={thisRef} .../>` 装进来时传它。
   * drop 时 CCC 优先调 `ref.current?.insertMention(m)`；**成功就跳过**
   * 本地 `insertedChips` 跟踪（让 MentionComposer 自己管 chip + segments）。
   * ref 没传（首页 CCC 的现状）→ CCC 走本地最小 chip 跟踪。
   */
  dropComposerRef?: MutableRefObject<MentionComposerHandle | null> | null;
}

export function ChiefConversationCard({
  threadId,
  onDropTodoReferences,
  dropComposerRef,
}: ChiefConversationCardProps): React.JSX.Element {
  const { ctx } = useTeamContext();
  const [thread, setThread] = useState<ChiefThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(true);
  const [threadErr, setThreadErr] = useState<string | null>(null);

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgErr, setMsgErr] = useState<string | null>(null);
  const [sinceSeq, setSinceSeq] = useState<number>(0);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [threadsList, setThreadsList] = useState<ChiefThread[]>([]);

  // ── 拖卡进对话（DropCard 切片）状态 ────────────────────────
  // composer 是否正在被拖卡 hover —— 驱动 composerStyle 的高亮切换。
  // dropNote / dropNoteKind 是「已 drop 提示条」的状态，区别于 sendErr。
  //
  // `insertedChips`：本切片自管的 chip 跟踪，仅在父组件没装
  // `<MentionComposer>` 时使用。每条记录一个 refId，textarea 文本里对应
  // 一个 `#<refId[:6]>` 短标识作为可发送形态；chip bar 上方渲染徽章。
  // 父组件装了 MentionComposer + 传了 `dropComposerRef` 时，本状态不会被
  // 写入（`tryInsertIntoComposer` 接管整条路径）。
  const [composerDragOver, setComposerDragOver] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [dropNoteKind, setDropNoteKind] = useState<'ok' | 'warn'>('ok');
  const [insertedChips, setInsertedChips] = useState<Array<{ refId: string }>>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const userId = ctx?.userId ?? '';

  // ── 拉 thread ────────────────────────────────────────────────
  const reloadThread = useCallback(async () => {
    setThreadLoading(true);
    setThreadErr(null);
    try {
      const res = await fetch(`/api/chief/threads/${encodeURIComponent(threadId)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ChiefThread; reason?: string }
        | null;
      if (!body?.ready) {
        setThreadErr(`数据未就绪：${body?.reason ?? 'unknown'}`);
        setThread(null);
        return;
      }
      setThread(body.data ?? null);
    } catch (err) {
      setThreadErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setThreadLoading(false);
    }
  }, [threadId]);

  // ── 拉消息 ───────────────────────────────────────────────────
  const reloadMessages = useCallback(async () => {
    const convId = thread?.session.id;
    if (!convId) return;
    setMsgLoading(true);
    setMsgErr(null);
    try {
      const qs = sinceSeq > 0 ? `?sinceSeq=${sinceSeq}` : '';
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(convId)}/messages${qs}`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ConversationMessage[]; reason?: string }
        | null;
      if (!body?.ready) {
        setMsgErr(`数据未就绪：${body?.reason ?? 'unknown'}`);
        return;
      }
      const incoming = body.data ?? [];
      setMessages((prev) => {
        if (sinceSeq === 0) return incoming;
        const knownIds = new Set<string>(prev.map((m) => m.id));
        const merged = [...prev];
        for (const m of incoming) if (!knownIds.has(m.id)) merged.push(m);
        return merged;
      });
      if (incoming.length > 0) {
        const maxSeq = Math.max(...incoming.map((m) => m.seq));
        setSinceSeq((s) => Math.max(s, maxSeq));
      }
    } catch (err) {
      setMsgErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setMsgLoading(false);
    }
  }, [thread?.session.id, sinceSeq]);

  // ── 拉 topic 列表 ────────────────────────────────────────────
  const reloadTopics = useCallback(async () => {
    if (!userId) return;
    try {
      const ctxRes = await fetch('/api/user/context', { cache: 'no-store' });
      const ctxBody = (await ctxRes.json().catch(() => null)) as
        | { ready?: boolean; data?: { teams?: Array<{ teamId: string }> }; reason?: string }
        | null;
      const firstTeam = ctxBody?.data?.teams?.[0];
      if (!firstTeam) return;
      const r = await fetch(
        `/api/teams/${encodeURIComponent(firstTeam.teamId)}/chief/threads`,
        { cache: 'no-store' },
      );
      const body = (await r.json().catch(() => null)) as
        | { ready?: boolean; data?: ChiefThread[]; reason?: string }
        | null;
      if (body?.ready) setThreadsList(body.data ?? []);
    } catch {
      // 静默：列表失败不影响对话本身
    }
  }, [userId]);

  useEffect(() => {
    void reloadThread();
  }, [reloadThread]);

  useEffect(() => {
    if (thread?.session.id) void reloadMessages();
  }, [reloadMessages, thread?.session.id]);

  useEffect(() => {
    void reloadTopics();
  }, [reloadTopics]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  // ── 发消息 ────────────────────────────────────────────────────
  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendErr(null);
    try {
      const res = await fetch(
        `/api/chief/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { lastSeq?: number; error?: string }
        | null;
      if (res.status === 502) {
        setSendErr('模型不可达：依赖的服务/上游挂了，请稍后重试。');
        return;
      }
      if (!res.ok) {
        setSendErr(body?.error ?? `http-${res.status}`);
        return;
      }
      setInput('');
      // 发送成功后清空本地 chip 跟踪 —— chip 已随 `message` 文本进入
      // chief_message 的 body（Chief LLM 已读到 refId token），下一次
      // drop 之前不应继续挂在新一轮的输入框里。
      setInsertedChips([]);
      if (body?.lastSeq && body.lastSeq > 0) setSinceSeq((s) => Math.max(s, body.lastSeq ?? s));
      await reloadMessages();
    } catch (err) {
      setSendErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setSending(false);
    }
  };

  // ── 拖卡进对话（DropCard 切片） ─────────────────────────────
  // 本组件拿到 dataTransfer 后的处理顺序：
  //   (a) 识别 MIME `application/x-tds-todo-ids`；
  //   (b) 解析 `{"ids":[...]}` 为 `MentionRef[]`（label 暂为 refId 占位）；
  //   (c) 调 `onDropTodoReferences?.(refs)` —— 签名冻结，父组件 HomePage
  //       仍按既有逻辑把 label 用看板数据覆盖；
  //   (d) 优先走 `tryInsertIntoComposer(refs)`：父组件装了 MentionComposer
  //       并把 `dropComposerRef` 传进来时，本切片把整条 chip 跟踪交给它；
  //   (e) 否则走本地最小 chip 跟踪：`insertedChips` 入 refId + textarea
  //       文本末尾追加 `#<refId[:6]>` + chip bar 渲染徽章。
  //
  // **诚实性约束**：
  //   - chip 的可见 token `#<refId[:6]>` 已写入 textarea 文本，send 时
  //     随 `message` 进入 chief_message 的 body —— Chief LLM 会读到
  //     refId 并用 `todos` 工具查完整信息。
  //   - 「refId 形态」≠「真实 #seqNum title」：UI 上写明，card 侧的
  //     真实 label 填充留给后续接线（详见顶部注释 & 状态条文案）。
  //
  // compose 区视觉反馈：拖入时给出「实线强调边」（区别于看板列的虚线）。

  /**
   * 把 refs 灌进 MentionComposer 的入口 —— 走的是父组件传的 ref。
   * 如果 `dropComposerRef` 没传（即首页 CCC 的现状），本函数直接返回 false，
   * drop 走「诚实降级」通知路径，**不**派发 window 事件（2026-10-18 Main 确认
   * 派发一个没人消费的事件比不派发更糟）。
   */
  const tryInsertIntoComposer = (refs: MentionRef[]): number => {
    const handle = dropComposerRef?.current ?? null;
    if (!handle || typeof handle.insertMention !== 'function') return 0;
    let ok = 0;
    for (const r of refs) {
      try {
        handle.insertMention(r);
        ok += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('MentionComposer.insertMention 抛错：', err);
      }
    }
    return ok;
  };

  const handleComposerDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    // 只接 application/x-tds-todo-ids 与 text/plain（board 拖卡兼容）。
    // 必须 preventDefault 否则浏览器不会触发 drop。
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(TODO_DRAG_MIME) || types.includes('text/plain')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (!composerDragOver) setComposerDragOver(true);
    }
  };
  const handleComposerDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setComposerDragOver(false);
    }
  };
  const handleComposerDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setComposerDragOver(false);
    const dt = e.dataTransfer;
    const raw = dt.getData(TODO_DRAG_MIME);
    if (!raw) {
      setDropNote(
        '输入框只接受看板卡片的拖入（来自 app/page.tsx 的 todo 卡片）。' +
          '如果你看到的不是来自 4 列看板的卡片，检查来源。',
      );
      setDropNoteKind('warn');
      return;
    }
    let payload: TodoDragPayload;
    try {
      payload = JSON.parse(raw) as TodoDragPayload;
    } catch {
      setDropNote('拖入的数据格式不是合法的 JSON（' + TODO_DRAG_MIME + '），已忽略。');
      setDropNoteKind('warn');
      return;
    }
    if (!Array.isArray(payload?.ids) || payload.ids.length === 0) {
      setDropNote('拖入的 payload.ids 为空或非数组。');
      setDropNoteKind('warn');
      return;
    }
    const refs: MentionRef[] = payload.ids
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((id) => ({
        kind: 'todo',
        refId: id,
        label: id, // 占位 —— HomePage 在 buildTodoMentionRefs 里用 title/seqNum 覆盖
        prefix: '#',
      }));
    if (refs.length === 0) {
      setDropNote('拖入的 ids 全是非法字符串。');
      setDropNoteKind('warn');
      return;
    }
    // (1) 通知父组件（HomePage），它用看板数据覆盖 label 写回自己 UI。
    //     这个回调的签名是冻结的，本切片不动。
    try {
      onDropTodoReferences?.(refs);
    } catch (err) {
      setDropNote(
        `把 ${refs.length} 张卡交给父组件时抛错：${err instanceof Error ? err.message : String(err)}`,
      );
      setDropNoteKind('warn');
    }
    // (2) 集成路径：父组件也可以传 dropComposerRef —— 装上 `<MentionComposer>`
    //     的语境才能进 chip（走 MentionComposer 自己的 chip/segments 模型）。
    //     成功就跳过本地 chip 跟踪。
    const inserted = tryInsertIntoComposer(refs);
    if (inserted === refs.length) {
      setDropNote(
        refs.length === 1
          ? '已 drop 1 张卡：已通过 MentionComposer.insertMention 灌入输入框。' +
              '继续打字补充，按 ⌘/Ctrl+Enter 发送。'
          : `已 drop ${refs.length} 张卡：已通过 MentionComposer.insertMention 灌入输入框。` +
              '继续打字补充，按 ⌘/Ctrl+Enter 发送。',
      );
      setDropNoteKind('ok');
      return;
    }
    // (3) 本地 chip 跟踪：首页 CCC **没装** `<MentionComposer>`（chief_message
    //     表不属于 build_message，强行装会被 buildId 守卫整块禁用），所以走
    //     本切片自管的最小实现。
    //   - 把每个 refId 入 `insertedChips`，让 chip bar 渲染徽章 + ×
    //   - 把 `#<refId[:6]>` 短标识追加到 textarea 文本末尾 —— 这部分会随
    //     `send()` 的 `{ message: input.trim() }` 落到 chief_message，
    //     LLM 看到 token 后能用 `todos` 工具查完整信息。
    //   - 状态条诚实说明「refId 形态，真实 label 由 card 侧填充」——
    //     真实 `#<seqNum> <title>` 的填充留作后续接线，不在本次范围。
    const newChips = refs.map((r) => ({ refId: r.refId }));
    setInsertedChips((prev) => {
      // 去重：先在本批内去重（防止 payload.ids 自身重复），再与现有 chips
      // 集合求差集。同一个 refId 已经存在就不重复插（用户多拖一次同张卡）。
      const seenInBatch = new Set<string>();
      const dedupedBatch = newChips.filter((c) => {
        if (seenInBatch.has(c.refId)) return false;
        seenInBatch.add(c.refId);
        return true;
      });
      const known = new Set(prev.map((c) => c.refId));
      const filtered = dedupedBatch.filter((c) => !known.has(c.refId));
      return filtered.length === 0 ? prev : [...prev, ...filtered];
    });
    setInput((prev) => {
      // 追加到文本末尾；若末尾非空则加空格分隔，避免 token 粘连。
      const seenInBatch = new Set<string>();
      const append = refs
        .filter((r) => {
          // 本批内去重 + 与现有文本去重
          if (seenInBatch.has(r.refId)) return false;
          seenInBatch.add(r.refId);
          const token = `#${r.refId.slice(0, 6)}`;
          return !prev.includes(token);
        })
        .map((r) => `#${r.refId.slice(0, 6)}`)
        .join(' ');
      if (append.length === 0) return prev;
      const sep = prev.length > 0 && !/\s$/.test(prev) ? ' ' : '';
      return prev + sep + append;
    });
    const labelWord = refs.length === 1 ? '1 张卡' : `${refs.length} 张卡`;
    const shortIds = refs.map((r) => `#${r.refId.slice(0, 6)}`).join('、');
    setDropNote(
      `已 drop ${labelWord}（${shortIds} 已写入输入框，refId 短标识形态）。` +
        '发送后 Chief 会读到这些 ref，card 侧后续会把真实 #seqNum title 回填渲染。' +
        '要按 mentions 绑定（结构化引用）请到 todo 详情页（带 build 的对话）。',
    );
    setDropNoteKind('ok');
  };

  /**
   * 移除 `insertedChips` 中某条，并把 textarea 文本里对应的 `#<short>`
   * token 也抹掉。最简实现：全局 replace 一次；不处理重复短标识碰撞
   * （refId 前 6 位碰撞概率极低，且用户拖入时按全 refId 去重，不重复
   * 插入）。如果 token 没找到就只移除状态条里的项，文本不动 —— 「老实
   * 不抛错」原则。
   */
  const removeInsertedChip = (refId: string): void => {
    const short = `#${refId.slice(0, 6)}`;
    setInsertedChips((prev) => prev.filter((c) => c.refId !== refId));
    setInput((prev) => {
      if (!prev.includes(short)) return prev;
      // 把 token 连同紧跟其后的多余空格一起清掉，留单个空格隔开前后文本
      // refId[:6] 是 hex 字符，正则里只会出现 [0-9a-f]，但保险起见仍把
      // 所有 RegExp 元字符（. * + ? ^ $ { } ( ) | [ ] \）一并转义。
      const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const replaced = prev.replace(new RegExp(`\\s*${escaped}`, 'g'), ' ');
      // 收尾：合并连续空格，trimEnd 不动首部（用户可能在 textarea 头部打字）
      return replaced.replace(/\s{2,}/g, ' ').trimEnd();
    });
  };

  // ── 渲染 ──────────────────────────────────────────────────────
  return (
    <div
      style={{
        ...shared.card,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 480,
        position: 'relative',
      }}
    >
      {/* 标题行：可点击切换 topic */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          position: 'relative',
        }}
      >
        {threadLoading ? (
          <span style={{ ...titleStyle, color: C.textGhost }}>读取中…</span>
        ) : threadErr ? (
          <span style={{ ...titleStyle, color: C.danger }}>{threadErr}</span>
        ) : thread ? (
          <>
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-expanded={pickerOpen}
              aria-haspopup="listbox"
              style={titleBtnStyle}
            >
              {thread.title} <span aria-hidden style={{ marginLeft: 4 }}>▾</span>
            </button>
            <Link
              href={`/chief/${encodeURIComponent(threadId)}`}
              style={{ ...shared.ghostBtn, textDecoration: 'none', fontSize: T.sm, padding: '4px 8px' }}
              title="在独立页面打开（便于分享 URL）"
            >
              ↗ 打开
            </Link>
          </>
        ) : (
          <span style={{ ...titleStyle, color: C.textGhost }}>Topic 不存在。</span>
        )}
      </div>

      {pickerOpen && (
        <div role="listbox" style={pickerStyle}>
          {threadsList.length === 0 && <div style={{ ...mutedStyle, padding: S.md }}>还没有 topic。</div>}
          {threadsList.map((t) => {
            const isCurrent = t.id === threadId;
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => {
                  setPickerOpen(false);
                  if (!isCurrent) window.location.href = `/chief/${encodeURIComponent(t.id)}`;
                }}
                style={pickerItemStyle(isCurrent)}
              >
                {t.title}
                <span style={{ color: C.textGhost, marginLeft: 6, fontSize: T.sm }}>
                  {t.lastTurnAt ? formatTime(t.lastTurnAt) : '尚未发言'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 消息流 */}
      <div ref={scrollRef} style={chatScrollStyle}>
        {msgLoading && messages.length === 0 && <div style={mutedStyle}>读取中…</div>}
        {msgErr && messages.length === 0 && <div style={mutedStyle}>{msgErr}</div>}
        {messages.length === 0 && !msgLoading && !msgErr && (
          <div style={mutedStyle}>还没有消息。说点什么。</div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={m.role === 'user' ? msgRowUser : msgRowChief}>
            <div style={msgHeadStyle}>
              <span style={msgRoleStyle}>{m.role}</span>
              {m.isError && (
                <span style={{ color: C.danger, fontSize: T.sm }}>（错误）</span>
              )}
              <span style={{ color: C.textFaint, fontSize: T.sm, marginLeft: 8 }}>
                seq {m.seq} · {formatTime(m.createdAt)}
                {m.durationMs !== null && ` · ${m.durationMs}ms`}
              </span>
            </div>
            <div style={msgBodyStyle}>{m.content}</div>
          </div>
        ))}
      </div>

      {/* composer */}
      <div
        // 整块 composer 都接受 drop —— 包括 textarea 周围区域，方便视觉反馈
        // 横向扩散。键盘焦点仍在 textarea，不会跳走。
        data-mention-drop="1"
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
        style={{
          ...composerStyle,
          // 高亮态：实线 accent（**区别于看板列的虚线**，
          // 后者在 `app/page.tsx#dropZoneStyle`，本样式刻意用实线）。
          ...(composerDragOver ? composerDropZoneStyle : null),
        }}
      >
        {dropNote && (
          <div
            role="status"
            data-drop-note="1"
            style={{
              ...(dropNoteKind === 'warn' ? shared.errorBox : shared.noticeBox),
              marginBottom: 6,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <div style={{ flex: 1, fontSize: T.meta }}>{dropNote}</div>
            <button
              type="button"
              onClick={() => setDropNote(null)}
              style={shared.ghostBtn}
            >
              知道了
            </button>
          </div>
        )}

        {/* chip bar —— 拖进来的卡片以 `#<refId[:6]>` 短标识徽章呈现。
             * 视觉上沿用 MentionComposer 的 `chipColor('#')`（绿色调）保持
             * 与 todo 详情页一致；× 按钮同步把 textarea 文本里的对应 token
             * 抹掉。最简「mention bar」UI —— 不与 MentionComposer 强耦合。 */}
        {insertedChips.length > 0 && (
          <div
            data-chip-bar="1"
            aria-label="已拖入的卡片（refId 短标识）"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: S.xs,
              marginBottom: S.sm,
            }}
          >
            {insertedChips.map((c) => {
              const short = `#${c.refId.slice(0, 6)}`;
              return (
                <span
                  key={c.refId}
                  data-chip-refid={c.refId}
                  title={`refId=${c.refId}（card 侧后续会把真实 #seqNum title 回填）`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: S.xs,
                    padding: `2px ${S.sm}px`,
                    borderRadius: R.pill,
                    border: `1px solid rgba(74,222,128,0.45)`,
                    background: 'rgba(74,222,128,0.12)',
                    color: C.ok,
                    fontSize: T.meta,
                    fontFamily: F.sans,
                  }}
                >
                  <span style={{ marginRight: 4, fontWeight: 600 }}>#</span>
                  {short.slice(1)}
                  <button
                    type="button"
                    aria-label={`移除 chip ${short}`}
                    onClick={() => removeInsertedChip(c.refId)}
                    disabled={sending}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: T.body,
                      padding: `0 ${S.xs}px`,
                      marginLeft: 2,
                    }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* textarea —— chip 的可见 token 也已经写在 input 文本里（drop
             * 时自动追加），这样 send() 走的 `message: input.trim()` 就把
             * chip 信息带进 chief_message 的 body，Chief LLM 能看到后调
             * `todos` 工具查完整信息。 */}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            composerDragOver
              ? '松手即可把卡片 ref 记到对话（已显示在 chip bar）'
              : '对 Chief 说话…（Cmd/Ctrl+Enter 发送；拖卡片到此处插入 ref）'
          }
          rows={2}
          disabled={sending}
          style={{ ...textareaStyle, opacity: sending ? 0.7 : 1, minHeight: 56 }}
        />
        <div style={composerRowStyle}>
          {sendErr ? (
            <span style={{ color: C.danger, fontSize: T.sm }}>{sendErr}</span>
          ) : sending ? (
            <span style={{ color: C.textDim, fontSize: T.sm }}>模型调用中（几十秒起）…</span>
          ) : (
            <span style={{ color: C.textGhost, fontSize: T.sm }}>
              ⌘/Ctrl+Enter 发送 · 拖卡片到此处插入引用
              {insertedChips.length > 0 && (
                <>
                  {' · '}
                  <span style={{ color: C.textDim }}>
                    已附 {insertedChips.length} 张卡（refId 形态）
                  </span>
                </>
              )}
            </span>
          )}
          <button
            type="button"
            disabled={sending || !input.trim()}
            onClick={() => void send()}
            style={{
              ...primaryBtn,
              opacity: sending || !input.trim() ? 0.5 : 1,
              cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 工具 ──────────────────────────────────────────────────────────

function formatTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// ── 样式 ──────────────────────────────────────────────────────────

const titleStyle: CSSProperties = { fontSize: T.h3, margin: 0, fontWeight: 600 };
const titleBtnStyle: CSSProperties = {
  ...titleStyle,
  background: 'transparent',
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: '4px 10px',
  cursor: 'pointer',
  color: C.text,
  display: 'inline-flex',
  alignItems: 'center',
};
const pickerStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  top: 44,
  left: 0,
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.lg,
  minWidth: 240,
  maxHeight: 320,
  overflowY: 'auto',
  padding: 6,
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
};
function pickerItemStyle(active: boolean): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '6px 10px',
    background: active ? C.surfaceHi : 'transparent',
    border: 'none',
    borderRadius: R.sm,
    color: C.text,
    cursor: 'pointer',
    fontSize: T.meta,
  };
}
const chatScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  background: C.bg,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: S.md,
  marginBottom: 8,
};
const msgRowUser: CSSProperties = {
  background: 'rgba(129,140,248,0.14)',
  borderLeft: `3px solid ${C.accent}`,
  border: `1px solid rgba(129,140,248,0.30)`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: 8,
};
const msgRowChief: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: 8,
};
const msgHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 };
const msgRoleStyle: CSSProperties = {
  fontSize: T.sm,
  fontWeight: 600,
  color: C.accent,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const msgBodyStyle: CSSProperties = {
  fontSize: T.meta,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.5,
  color: C.text,
};
const composerStyle: CSSProperties = { ...shared.card, paddingTop: S.md, marginTop: 4 };

/**
 * 输入框 drop 高亮：与看板列的虚线「dropZoneStyle」**故意不同** —— 实线
 * 强调边。视觉上立刻让用户明白「这次 drop 是另一类语义」。
 * 也加一圈 inset 阴影把对话区与输入区分隔开，让高亮边界不显得突兀。
 */
const composerDropZoneStyle: CSSProperties = {
  border: `2px solid ${C.accent}`,
  background: 'rgba(129,140,248,0.12)',
  boxShadow: `0 0 0 4px rgba(129,140,248,0.08) inset`,
};
const composerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 6,
  gap: 8,
};
const textareaStyle: CSSProperties = {
  ...shared.input,
  width: '100%',
  padding: S.md,
  resize: 'vertical',
  boxSizing: 'border-box',
  fontFamily: F.sans,
};
const primaryBtn: CSSProperties = shared.primaryBtn;
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };