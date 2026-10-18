/**
 * PWA manifest —— 逐字对齐原站 `https://todos.dev/manifest.webmanifest`。
 *
 * 证据保存在 `D:/AI/todos/recon/pwa/manifest.webmanifest`（实测抓取，非推测）。
 * 字段顺序、取值、单位全部照抄，包括几个容易漏的：
 *   - `launch_handler.client_mode: "navigate-existing"` —— 原站点图标直接进已有窗口
 *   - `related_applications` —— 把 PWA 自己登记为 webapp（安装器认这个）
 *   - `screenshots` 带 `form_factor: narrow|wide` —— 安装向导的宽/窄两态
 *   - maskable 图标单独给 `purpose`，否则 Android 会把图标裁掉边角
 *
 * start_url 是 `/app` 而非 `/`：与原站一致，装完直接进工作区。
 */
export default {
  id: '/',
  name: 'Todos',
  short_name: 'Todos',
  description:
    'Todos is the task-driven workspace for humans and agents. Command a whole team through one agent: assign models and roles, work in parallel, ship faster.',
  start_url: '/app',
  scope: '/',
  display: 'standalone',
  categories: ['productivity', 'developer'],
  launch_handler: { client_mode: 'navigate-existing' },
  background_color: '#18181b',
  theme_color: '#18181b',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  related_applications: [
    { platform: 'webapp', url: 'https://todos.dev/manifest.webmanifest' },
  ],
  screenshots: [
    {
      src: '/screenshots/narrow.png',
      sizes: '780x1688',
      type: 'image/png',
      form_factor: 'narrow',
      label: 'Your todos, and the agents working them',
    },
    {
      src: '/screenshots/wide.png',
      sizes: '2560x1600',
      type: 'image/png',
      form_factor: 'wide',
      label: 'Your todos, and the agents working them',
    },
  ],
};
