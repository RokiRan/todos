/**
 * PWA service worker —— 按原站 `https://todos.dev/sw.js` 的语义重写。
 *
 * 原站源码已存 `D:/AI/todos/recon/pwa/sw.js`（实测抓取）。下面每个决定都有原因，
 * 不是"照抄字符串"，而是照抄**行为与理由**：
 *
 * 1. **刻意不注册 fetch handler。** 原站注释写明：Chrome 已不再要求 fetch handler
 *    才能安装，而空 handler 会给每个请求加上 SW 分发/启动延迟 —— iOS 上尤其明显
 *    （iOS 没有 Chrome 那个 no-op handler 跳过优化）。所以我们也不加。
 *
 * 2. **push 前先看有没有可见窗口。** 前台时直接 return，交给页内 toast。
 *    原站注明：这个"仅前台抑制"只作用于 fall-through 路径；
 *    声明式 Web Push（Chrome/Firefox 的 {web_push:8030}）始终显示系统通知。
 *
 * 3. **notificationclick 走 CacheStorage 持久化。** 关键原因：iOS 会挂起后台 PWA
 *    页面并**丢弃** postMessage，所以"只把已有窗口拉到前台"会丢掉 href。
 *    先写 CacheStorage（`caches.open('nav')` → `/__pending-nav`），
 *    页面的每个唤醒路径都会读取并消费它（见 ServiceWorkerRegister.tsx）。
 *
 * 4. **navigate 只保留 path+query+hash。** 原站 navigate 是绝对 URL，
 *    而页面是客户端路由，只需相对部分。
 */

export const dynamic = 'force-dynamic';

/** 存 pending 导航的 cache 名与 key —— 与读取侧必须一致。 */
const NAV_CACHE = 'nav';
const PENDING_NAV_KEY = '/__pending-nav';

const SOURCE = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const n = data.notification || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    let href = '/app';
    try {
      const u = new URL(n.navigate);
      href = u.pathname + u.search + u.hash;
    } catch (e) {}
    await self.registration.showNotification(n.title || 'Todos', {
      body: n.body,
      tag: n.tag,
      data: { href },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || '/app';
  event.waitUntil((async () => {
    // 必须先落盘：iOS 挂起后台页面时会丢 postMessage。
    try {
      const cache = await caches.open(${JSON.stringify(NAV_CACHE)});
      await cache.put(${JSON.stringify(PENDING_NAV_KEY)}, new Response(JSON.stringify({ href, at: Date.now() })));
    } catch (e) {}
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      try {
        await win.focus();
        win.postMessage({ type: 'notificationclick', href });
        return;
      } catch (e) {}
    }
    const opened = await self.clients.openWindow(href);
    if (opened) opened.postMessage({ type: 'notificationclick', href });
  })());
});
`;

/**
 * `GET /sw.js`
 *
 * 必须以 `Service-Worker-Allowed: /` 返回，否则 scope 被限制在 `/sw.js` 下，
 * 页面（`/app`、`/todo/...`）不会被 SW 接管。
 */
export async function GET(): Promise<Response> {
  return new Response(SOURCE, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
      // 允许控制整个 origin
      'service-worker-allowed': '/',
    },
  });
}
