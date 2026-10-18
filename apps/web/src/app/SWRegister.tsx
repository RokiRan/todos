'use client';

import { useEffect } from 'react';

/**
 * Service worker 注册 + 唤醒路由。
 *
 * 行为对齐原站（`D:/AI/todos/recon/pwa/sw.js` 的注释直接说明了原因）：
 *
 * 1. **注册路径 `/sw.js`，scope `/`。** 服务端在响应里带
 *    `Service-Worker-Allowed: /`，否则 SW 只能控制 `/sw.js` 自己。
 *
 * 2. **每个唤醒路径都要先消费 CacheStorage 里的 pending nav。**
 *    原站原话：iOS 会挂起后台 PWA 页面并**丢弃** postMessage，
 *    所以「只 focus 已有窗口」会丢掉点击通知时的 href。
 *    SW 先把 {href, at} 写进 CacheStorage 的 `/__pending-nav`，
 *    这里在 visibilitychange / pageshow / focus 三种唤醒下读取并消费。
 *
 * 3. **postMessage 是快路径**，只在页面真的在监听时用；
 *    CacheStorage 才是可靠通道。两者都要，因为：
 *    - 页面存活 → postMessage 立即生效
 *    - 页面被 iOS 挂起 → 只有 CacheStorage 能传递
 *
 * 消费语义必须**只生效一次**（读完就删），否则返回页面会重复跳转。
 */

const NAV_CACHE = 'nav';
const PENDING_NAV_KEY = '/__pending-nav';

interface PendingNav {
  href: string;
  at: number;
}

async function consumePendingNav(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  try {
    const cache = await window.caches.open(NAV_CACHE);
    const hit = await cache.match(PENDING_NAV_KEY);
    if (!hit) return;
    // 先删再跳转：避免重复消费（写删不是原子的，先删更安全）
    await cache.delete(PENDING_NAV_KEY);
    const pending = (await hit.json()) as PendingNav;
    // 只接受站内路径，防止 SW 被投毒后把用户导到站外
    if (!pending.href.startsWith('/') || pending.href.startsWith('//')) return;
    if (window.location.pathname !== pending.href) {
      window.history.pushState({}, '', pending.href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  } catch {
    // 读不到就当没有 —— 不能因为唤醒路由失败而挡住页面渲染
  }
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
    // 注册失败（非 HTTPS、浏览器策略等）不阻断应用
  });

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; href?: string } | null;
    if (data?.type === 'notificationclick' && typeof data.href === 'string') {
      // 快路径：页面活着时直接消费，避免走 CacheStorage
      if (data.href.startsWith('/') && !data.href.startsWith('//')) {
        window.history.pushState({}, '', data.href);
        window.dispatchEvent(new PopStateEvent('popstate'));
        void caches.open(NAV_CACHE).then((c) => c.delete(PENDING_NAV_KEY)).catch(() => {});
      }
    }
  });
}

export function SWRegister(): null {
  useEffect(() => {
    registerServiceWorker();

    // 三个唤醒路径都要消费：iOS 会用不同方式恢复页面
    void consumePendingNav();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('pageshow', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('pageshow', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, []);

  return null;
}

function onWake(): void {
  void consumePendingNav();
}
