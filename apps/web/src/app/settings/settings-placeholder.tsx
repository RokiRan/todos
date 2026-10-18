import type { CSSProperties } from 'react';
import { C, R, S, T, ph } from '@/lib/design-tokens';

/**
 * 设置页的「团队上下文未就绪」占位。
 *
 * **为什么不在 `layout.tsx` 里导出**：Next.js App Router 规定 layout 只能有
 * 具名导出 `default` / `metadata` / `generateStaticParams` / `dynamic` 等框架
 * 保留字，多导出一个 `SettingsPlaceholder` 会让 `.next/types/app/settings/layout.ts`
 * 报 TS2344（`Property 'SettingsPlaceholder' is incompatible with index signature`）。
 * 那个类型文件是自动生成的、每次 build 都会重写，所以「不 build 就发现不了」。
 * 共用组件就放共用模块 —— 与 layout 的职责（外壳与导航）分开。
 *
 * **为什么是函数而不是 React 组件**：它在「已就绪」时返回 `null`。若页面写成
 *
 *   const ph = <SettingsPlaceholder status={status} activeTeam={activeTeam} />;
 *   if (ph) return <main>{ph}</main>;
 *
 * 则 `if (ph)` **恒为真** —— JSX 元素是对象，对象永远 truthy，`null` 要等渲染时
 * 才变成空。症状极其隐蔽：SSR HTML 里能看到「读取团队信息…」，客户端也成功拉到
 * 了团队，但 `<main>` 一直是空的，而且**控制台一条错误都没有**。
 * 我自己写这个 API 时就是这么用的，5 个页面全照抄了这个 bug。
 *
 * 现在的形状（见 `teamNeedsPlaceholder` / `SettingsPlaceholder`）：
 *   if (teamNeedsPlaceholder(status, activeTeam)) return <main><SettingsPlaceholder .../></main>;
 * 布尔判定与渲染各司其职，不会再出现「恒真的元素」。
 */

export type TeamStatus = 'loading' | 'ready' | 'unavailable' | 'empty';

/** 团队上下文是否还没就绪到可以渲染业务内容。 */
export function teamNeedsPlaceholder(
  status: TeamStatus,
  activeTeam: { teamId: string } | null,
): boolean {
  if (status === 'loading') return true;
  if (status === 'unavailable') return true;
  // ready 也要求真的选中了团队：context 到达但选中态尚未落定的那一帧，
  // 渲染空表单会让用户填完才发现提交不了。
  return status === 'empty' || activeTeam === null;
}

/**
 * 未就绪时的占位元素；已就绪返回 `null`。
 *
 * 三种态必须分开，不能合并成一句「加载失败」：
 *   - loading      还在读，正常过渡态
 *   - unavailable  后端不可达 → 要引导去查服务/登录态
 *   - empty        确实没有团队 → 要引导去加成员（查服务没有用）
 */
export function SettingsPlaceholder({
  status,
  activeTeam,
}: {
  status: TeamStatus;
  activeTeam: { teamId: string } | null;
}): React.JSX.Element | null {
  if (status === 'loading') {
    return <div style={ph.loading}>读取团队信息…</div>;
  }
  if (status === 'unavailable') {
    return (
      <div style={{ ...ph.error }}>
        <strong>读不到团队信息</strong>
        <div style={{ marginTop: 4, fontSize: 13 }}>
          后端 /api/user/context 不可用。确认 server 在跑、token 有效，且 cookie 没过期。
        </div>
      </div>
    );
  }
  if (status === 'empty' || activeTeam === null) {
    return (
      <div style={{ ...ph.empty }}>
        <strong>你还没有团队</strong>
        <div style={{ marginTop: 4, fontSize: 13 }}>
          团队级设置需要一个 team。服务端把 user 加为成员后，这个页面会自动放行。
        </div>
      </div>
    );
  }
  return null;
}


