/**
 * 看板筛选的纯函数 + localStorage 持久化（2026-10-18 复刻）。
 *
 * **这是契约 §3.6 冻结签名的唯一实现方**：所有上层（BoardHeader / BoardFilterPanel /
 * BoardCards / page.tsx）都只 import 这个文件的导出。签名（类型、字段顺序、可空性）
 * 一旦改动即破坏契约。
 *
 * **两个易错点**：
 *   ① `stageBucketOf` 只回答「属于规划桶还是执行桶」，不回答「属不属于被 stage 筛过滤」
 *      —— 「Backlog（todo/queued）」与「Done（done/closed）」在原站不属于 stage 筛作用范围，
 *      列过滤在 `filterTodos` 里先做。如果对这两个列的成员返回 `'executing'`，会让
 *      "只看待确认的方案"把 Backlog 的「待开始」也筛进来，对用户是错的。**采取约定**：
 *      本函数对非目标 phase 返回 `'planning'` 作为「安全默认」；**调用方必须用
 *      `columnOf` 先分类**，列不在筛选范围时跳过 stage 判定。
 *      见 `filterTodos` 内注释。
 *   ② `matchesCreatorFilter` 在 `currentUserId === null` 时**不能默认返回 true**——
 *      那会让『我创建的』看起来是空集后所有用户卡都通过，是事实上的假绿。我们按
 *      `ownerMemberId !== null` 处理：拿不到当前用户 id 时，'mine' 与 'others'
 *      退化成「按 ownerMemberId 是否存在」二分；'chiefOrAgent' 不依赖 currentUserId。
 *
 * 主代理在最后做 typecheck 时，本文件零类型错误：所有依赖都从 `@/lib/api` 取，
 * 不回头引本切片内部。
 */

import type { Todo, TodoPhase } from '@/lib/api';

// ── 类型（契约 §3.6 逐字冻结；不要改字段、不要改顺序、不要改可空性） ────────────

/** 创建者筛选。'mine' = 我创建的；'chiefOrAgent' = 总管或 Agent；'others' = 其他成员。 */
export type CreatorFilter = 'mine' | 'chiefOrAgent' | 'others';

/** 阶段筛选。'all' = 不限；'planning' = 规划；'executing' = 执行。
 *  注：阶段筛只作用于「执行中」「待你处理」两列 —— Backlog 与 Done 不受影响。
 *  该实现细节由 `filterTodos` 在列分类之后判定，不在本类型里表达。 */
export type StageFilter = 'all' | 'planning' | 'executing';

/** 看板筛选状态。`multi` 是衍生布尔：勾了任何具体筛选后为 true，回到全默认时为 false。 */
export interface BoardFilters {
  creator: CreatorFilter;
  stage: StageFilter;
  projectIds: string[];
  multi: boolean;
}

/** 计数快照 —— 由 `BoardFilterPanel` 直接渲染到右侧，不二次计算。 */
export interface BoardFilterCounts {
  creator: Record<CreatorFilter, number>;
  stage: Record<Exclude<StageFilter, 'all'>, number>;
  projects: Array<{ id: string; name: string; total: number }>;
}

// ── 列分类（不在契约里，但 stage 筛的正确性依赖它） ────────────────────────────

/** 看板四列：backlog / inProgress / needsYou / done。
 * 原站看板列顺序固定，stage 筛只对中间两列生效（Backlog 与 Done 不被过滤掉）。 */
export type BoardColumn = 'backlog' | 'inProgress' | 'needsYou' | 'done';

/**
 * 把 phase 映射到看板列。
 * 契约 §3.6 没冻结这个函数，但 `filterTodos` 的语义强依赖它，故与 `stageBucketOf`
 * 一起放本文件，避免散落到多个切片。
 *
 * 映射依据（2026-10-18 原站实测，与看板列定义一致）：
 *   - Backlog：todo / queued（用户还没开始 / 等机器上线）
 *   - 执行中：planning / implement / reviewing（机器在跑，但还没推到闸门）
 *   - 待你处理：confirm / review / failed（主按钮 / 重试按钮亮起）
 *   - Done：done / closed（终态）
 */
export function columnOf(phase: TodoPhase): BoardColumn {
  switch (phase) {
    case 'todo':
    case 'queued':
      return 'backlog';
    case 'planning':
    case 'implement':
    case 'reviewing':
      return 'inProgress';
    case 'confirm':
    case 'review':
    case 'failed':
      return 'needsYou';
    case 'done':
    case 'closed':
      return 'done';
  }
}

// ── phase → 桶（契约 §3.6 冻结签名；非目标 phase 返回默认值，见文件头注释） ─────

/**
 * 把 phase 归类到「规划」或「执行」桶。
 *
 * **本函数的边界**：它只回答「在原站语境下这个 phase 属于规划期还是执行期」。
 * 不回答「属不属于被 stage 筛过滤」 —— Backlog（todo/queued）与 Done（done/closed）
 * 在原站看板是两列，stage 筛不作用于它们。**调用方必须先用 `columnOf` 判定列**，
 * 列不在中间两列时跳过 stage 判定。
 *
 * 对非目标 phase 返回 `'planning'`（安全默认），理由：
 *   - 'executing' 默认会把 Backlog（todo/queued）也算成执行 —— 「仅看待确认的方案」
 *     会把「待开始」一起筛进来，对用户是错的。
 *   - 'planning' 默认虽然不完美，但结合上面 `columnOf` 判定后，这个错误永远不会
 *     浮现（Backlog/Done 已先被跳过）。
 *
 * 映射：
 *   - 'planning'    → 'planning'
 *   - 'implement'   → 'executing'
 *   - 'reviewing'   → 'executing'
 *   - 'confirm'     → 'executing'
 *   - 'review'      → 'executing'
 *   - 'failed'      → 'executing'
 *   - 其它（todo / queued / done / closed）→ 'planning'（详见上）
 */
export function stageBucketOf(phase: TodoPhase): 'planning' | 'executing' {
  switch (phase) {
    case 'planning':
      return 'planning';
    case 'implement':
    case 'reviewing':
    case 'confirm':
    case 'review':
    case 'failed':
      return 'executing';
    case 'todo':
    case 'queued':
    case 'done':
    case 'closed':
      // 不是规划也不是执行的中间列/终态：返回安全默认 'planning'。
      // 调用方（filterTodos）必须先用 columnOf 判定四列，Backlog/Done 已先跳过。
      return 'planning';
  }
}

// ── 创建者筛选（契约 §3.6 冻结签名） ────────────────────────────────────────────

/**
 * 判断一条 todo 是否落在给定的创建者筛选范围内。
 *
 * ⚠️ `currentMemberId` 传的是 **member id**（`member.id`），不是 `user.id`。
 * `todo.ownerMemberId` 指向 `member` 表，两个命名空间不同的字符串比较**永远
 * 不相等** —— 传错会让「我创建的」恒 0、「其他成员创建的」吃掉全部，而界面
 * 上完全看不出错在哪。可比字段是 `/api/user/context` 的 `data.teams[0].memberId`。
 *
 * `currentMemberId === null` 时（本函数唯一需要特殊处理的场景）**返回 true**：
 *   拿不到当前成员身份就无法区分「我的」与「别人的」——此时任何一种近似都是
 *   编造语义。`ownerMemberId` 是 `notNull` 列（schema 铁律：恒为人类成员），
 *   所以「按 owner 是否为空来近似」会退化成 mine 恒真 / others 恒假，
 *   用户看到的是「其他成员创建的：0 项」，且永远修不好。
 *
 * **为什么「不筛」比「猜一个」好**：
 *   - 'chiefOrAgent' 与成员身份无关，照常判定 —— 筛它永远正确。
 *   - 'mine' / 'others' 返回 true（不筛），配合 `creatorFilterAvailable()`
 *     让 UI **禁用并说明**这两项，而不是让用户点了发现是空结果。
 *   - stage 与 project 筛选**照常生效**，不会被这个降级掩盖。
 */
export function matchesCreatorFilter(
  t: Pick<Todo, 'ownerMemberId' | 'createdByType'>,
  f: CreatorFilter,
  currentMemberId: string | null,
): boolean {
  switch (f) {
    case 'chiefOrAgent':
      // 与成员身份无关；只看来源。
      return t.createdByType === 'chief' || t.createdByType === 'agent';
    case 'mine':
      // 拿不到当前成员 id → 不筛（见函数头注释的诚实性说明）。
      if (currentMemberId === null) return true;
      return t.createdByType === 'user' && t.ownerMemberId === currentMemberId;
    case 'others':
      if (currentMemberId === null) return true;
      return t.createdByType === 'user' && t.ownerMemberId !== currentMemberId;
  }
}

/**
 * 创建者筛选当前是否可用。
 *
 * 单独导出是因为 UI 要据此**禁用并说明**「我创建的」「其他成员创建的」两项，
 * 而不是让用户点了发现是空结果。`chiefOrAgent` 与成员身份无关，永不不可用。
 */
export function creatorFilterAvailable(currentMemberId: string | null): boolean {
  return currentMemberId !== null;
}

// ── 整体筛选（契约 §3.6 冻结签名） ──────────────────────────────────────────────

/**
 * 把给定的 todo 列表按 `BoardFilters` 过滤。
 *
 * **判定顺序**（伪代码）：
 *   for t in todos:
 *     // 1. 项目筛选（最窄最优先，多选「与」语义）
 *     if filters.projectIds.length > 0 && !filters.projectIds.includes(t.projectId):
 *       skip
 *
 *     // 2. 创建者筛选（filters.multi === false 时跳过 —— 全默认时不禁 creator）
 *     if filters.multi:
 *       if !matchesCreatorFilter(t, filters.creator, currentUserId):
 *         skip
 *
 *     // 3. 阶段筛选 —— **只对 Backlog / Done 之外的两列生效**
 *     column := columnOf(t.phase)
 *     if column !== 'backlog' && column !== 'done':
 *       bucket := stageBucketOf(t.phase)
 *       want   := filters.stage === 'planning' ? 'planning'
 *               : filters.stage === 'executing' ? 'executing'
 *               : null  // 'all'：不限
 *       if want !== null && bucket !== want:
 *         skip
 *
 *     keep(t)
 *
 * 注意：`filters.stage === 'all'` 等价于「不限」而不是「只看 planning」，必须
 * 用显式 want=null 判定，不能误把 'all' 当成某一桶的入口。
 */
export function filterTodos(
  todos: Todo[],
  f: BoardFilters,
  currentMemberId: string | null,
): Todo[] {
  return todos.filter((t) => {
    // 1. 项目筛选
    if (f.projectIds.length > 0 && !f.projectIds.includes(t.projectId)) {
      return false;
    }

    // 2. 创建者筛选 —— multi=false 时跳过（默认态不禁 creator）
    if (f.multi) {
      if (!matchesCreatorFilter(t, f.creator, currentMemberId)) {
        return false;
      }
    }

    // 3. 阶段筛选 —— Backlog 与 Done 不参与；'all' 等价于不限
    const column = columnOf(t.phase);
    if (column !== 'backlog' && column !== 'done' && f.stage !== 'all') {
      const bucket = stageBucketOf(t.phase);
      if (bucket !== f.stage) return false;
    }

    return true;
  });
}

// ── localStorage 持久化（key 集中在 `BOARD_FILTER_STORAGE_KEY`） ─────────────────

/** localStorage key。命名空间 `tds.board.*`，与 `workspace-layout` 的 `tds.workspace.*` 对齐。 */
export const BOARD_FILTER_STORAGE_KEY = 'tds.board.filters';

/**
 * 默认（无筛选）状态。**注意**：`multi` 一律 false。任何具体筛选都要在 setter 里把它翻 true。
 */
export function emptyFilters(): BoardFilters {
  return {
    creator: 'mine',
    stage: 'all',
    projectIds: [],
    multi: false,
  };
}

/**
 * 读 localStorage —— 字段逐个校验类型，任一不符返回 `emptyFilters()`。
 * 不允许部分恢复（防止坏数据让用户卡死在半筛选态）。
 *
 * 写法与 `apps/web/src/lib/workspace-layout.tsx` 的 `readBool` 同风格：
 *   - typeof window === 'undefined' 时返回 null/默认（SSR 安全）
 *   - try/catch 兜住 localStorage 禁用（隐私模式 / 磁盘满 / 安全策略），
 *     吞掉异常不让 UI 崩。
 */
export function loadFilters(): BoardFilters {
  if (typeof window === 'undefined') return emptyFilters();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(BOARD_FILTER_STORAGE_KEY);
  } catch {
    return emptyFilters();
  }
  if (raw === null) return emptyFilters();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFilters();
  }
  if (!isBoardFiltersLike(parsed)) return emptyFilters();

  // field-by-field 类型校验通过 → 构造结果。
  // multi 是衍生字段，从 creator/stage/projectIds 重新算 —— 不能信 localStorage 里写的。
  // 默认值是 creator='mine' & stage='all' & projectIds=[]；任一偏离即 multi=true。
  const multi =
    parsed.creator !== 'mine' ||
    parsed.stage !== 'all' ||
    parsed.projectIds.length > 0;
  const next: BoardFilters = {
    creator: parsed.creator,
    stage: parsed.stage,
    projectIds: parsed.projectIds,
    multi,
  };
  return next;
}

/**
 * 写 localStorage。**任何 IO 异常都吞掉**，不让 UI 崩。
 * 与 `workspace-layout.writeBool` 同一策略。
 */
export function saveFilters(f: BoardFilters): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BOARD_FILTER_STORAGE_KEY, JSON.stringify(f));
  } catch {
    // 隐私模式 / 磁盘满 / 安全策略 → 静默失败，不阻塞 UI。
  }
}

// ── 内部 helper ────────────────────────────────────────────────────────────────

/** 字段类型守卫 —— 校验 unknown 是否符合 BoardFilters 的形状。 */
function isBoardFiltersLike(x: unknown): x is {
  creator: CreatorFilter;
  stage: StageFilter;
  projectIds: string[];
  multi: boolean;
} {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;

  if (!isCreatorFilter(o.creator)) return false;
  if (!isStageFilter(o.stage)) return false;
  if (!Array.isArray(o.projectIds)) return false;
  for (const id of o.projectIds) {
    if (typeof id !== 'string') return false;
  }
  if (typeof o.multi !== 'boolean') return false;

  return true;
}

function isCreatorFilter(v: unknown): v is CreatorFilter {
  return v === 'mine' || v === 'chiefOrAgent' || v === 'others';
}

function isStageFilter(v: unknown): v is StageFilter {
  return v === 'all' || v === 'planning' || v === 'executing';
}
