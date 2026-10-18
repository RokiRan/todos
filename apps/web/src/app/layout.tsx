import type { ReactNode } from 'react';
import { SWRegister } from './SWRegister';
import { AuthGate } from './AuthGate';
import { AppShell } from '@/components/AppShell';
import { shared } from '@/lib/design-tokens';

/**
 * 根布局 —— 含 PWA 元数据，逐条对齐原站 https://todos.dev/ 的 <head>。
 *
 * 证据：`D:/AI/todos/recon/pwa/root.html`（实测抓取的 314KB HTML）。
 * 逐条对应的原站标签：
 *   <meta name="theme-color" content="#18181b"/>
 *   <link rel="manifest" href="/manifest.webmanifest"/>
 *   <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
 *   <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"/>
 *   <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"/>
 *   <meta name="apple-mobile-web-app-capable" content="yes"/>
 *   <meta name="apple-mobile-web-app-title" content="Todos"/>
 *   <meta name="apple-mobile-web-app-status-bar-style" content="default"/>
 *   + 46 个 apple-touch-startup-image（media 查询逐字照抄）
 *
 * 注意 apple-mobile-web-app-* 这三项是 iOS 主屏应用的开关：
 * capable=yes 让它全屏运行而不是 Safari 带地址栏。
 */

/** iOS 主屏启动图。46 条的 media 查询逐字取自原站 HTML，未做任何推断。 */
const APPLE_STARTUP_IMAGES: ReadonlyArray<{ href: string; media: string }> = [
{ href: '/splash/apple-splash-750x1334.png', media: 'screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-1334x750.png', media: 'screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1242x2208.png', media: 'screen and (device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2208x1242.png', media: 'screen and (device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1125x2436.png', media: 'screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2436x1125.png', media: 'screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1080x2340.png', media: 'screen and (device-width: 360px) and (device-height: 780px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2340x1080.png', media: 'screen and (device-width: 360px) and (device-height: 780px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-960x2079.png', media: 'screen and (device-width: 320px) and (device-height: 693px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2079x960.png', media: 'screen and (device-width: 320px) and (device-height: 693px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-828x1792.png', media: 'screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-1792x828.png', media: 'screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1242x2688.png', media: 'screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2688x1242.png', media: 'screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1170x2532.png', media: 'screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2532x1170.png', media: 'screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1284x2778.png', media: 'screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2778x1284.png', media: 'screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1179x2556.png', media: 'screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2556x1179.png', media: 'screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1290x2796.png', media: 'screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2796x1290.png', media: 'screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1206x2622.png', media: 'screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2622x1206.png', media: 'screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1320x2868.png', media: 'screen and (device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2868x1320.png', media: 'screen and (device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1260x2736.png', media: 'screen and (device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2736x1260.png', media: 'screen and (device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1488x2266.png', media: 'screen and (device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2266x1488.png', media: 'screen and (device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1536x2048.png', media: 'screen and (device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2048x1536.png', media: 'screen and (device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1620x2160.png', media: 'screen and (device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2160x1620.png', media: 'screen and (device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1640x2360.png', media: 'screen and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2360x1640.png', media: 'screen and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1668x2224.png', media: 'screen and (device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2224x1668.png', media: 'screen and (device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1668x2388.png', media: 'screen and (device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2388x1668.png', media: 'screen and (device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-2048x2732.png', media: 'screen and (device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2732x2048.png', media: 'screen and (device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-1668x2420.png', media: 'screen and (device-width: 834px) and (device-height: 1210px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2420x1668.png', media: 'screen and (device-width: 834px) and (device-height: 1210px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
  { href: '/splash/apple-splash-2064x2752.png', media: 'screen and (device-width: 1032px) and (device-height: 1376px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { href: '/splash/apple-splash-2752x2064.png', media: 'screen and (device-width: 1032px) and (device-height: 1376px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)' },
];

export const metadata = {
  title: 'Todos',
  description:
    'Todos is the task-driven workspace for humans and agents. Command a whole team through one agent: assign models and roles, work in parallel, ship faster.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Todos',
  appleWebApp: {
    capable: true,
    title: 'Todos',
    // 原站是 default（不是 black-translucent），保持一致
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport = {
  themeColor: '#18181b',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/*
          apple-mobile-web-app-capable 必须显式输出。
          Next 15 的 metadata.appleWebApp 在 App Router 下不保证渲染出这个
          <meta name="apple-mobile-web-app-capable">（实测线上页面里查不到），
          而它正是 iOS「添加到主屏幕后全屏运行」的开关 —— 缺了就不是 standalone。
          所以这里手写，与原站 <head> 逐条对齐。
        */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Todos" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="theme-color" content="#18181b" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
        {APPLE_STARTUP_IMAGES.map((img) => (
          <link key={img.href + img.media} rel="apple-touch-startup-image" href={img.href} media={img.media} />
        ))}
      </head>
      <body style={{ margin: 0, ...shared.page }}>
        <SWRegister />
        {/* 全局登录守卫：未登录时不渲染业务内容（见 AuthGate.tsx 顶部说明）。 */}
        <AuthGate>
          {/* AppShell 提供全局侧栏 + ⌘K 搜索 + 快捷键。放在 AuthGate 之内：
              未登录时整棵树都不会挂载，不会闪一个没有上下文的空侧栏。 */}
          <AppShell>{children}</AppShell>
        </AuthGate>
      </body>
    </html>
  );
}
