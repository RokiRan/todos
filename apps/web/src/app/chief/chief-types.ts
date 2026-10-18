/**
 * Chief topic 与对话消息的共享类型。
 *
 * **不要**让 `apps/web/src/app/settings/chief/[threadId]/page.tsx` 直接 import 这个
 * 模块（那是另一切片占有区）；本切片把它放在 `/app/chief/chief-types.ts`，仅供
 * 本切片新建的 `/chief/[threadId]/page.tsx` 引用，避免在两个页面之间产生交叉依赖。
 *
 * 字段字段与 `apps/server/src/routes/chief.ts:478-490` 一致；消息字段与
 * `apps/server/src/services/conversations.ts` 的 `ConversationMessage` 同构。
 */

export interface ChiefThread {
  id: string;
  chiefId: string;
  title: string;
  session: { runtime: string; id: string; openedAt: number };
  watchedTodos: string[];
  toolDefHashes: Record<string, unknown>;
  pendingSessionResumeAt: number | null;
  lastTurnAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessage {
  id: string;
  buildId: string;
  role: string;
  phase: string | null;
  triggerBy: string | null;
  content: string;
  agent: unknown;
  isError: boolean;
  durationMs: number | null;
  seq: number;
  createdAt: number;
}