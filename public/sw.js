// 織心心理治療所管理系統 Service Worker
//
// 策略刻意保守，因為這是有個案資料的系統：
//   - HTML 與 /api 一律不快取（避免看到舊版頁面或舊資料，也不把個案資料留在裝置上）
//   - 只快取靜態外殼（css / js / icons），且採「網路優先、失敗才用快取」
//   - 換版本時改 CACHE 名稱即可，舊快取會在 activate 一併清掉
const CACHE = 'mindcare-shell-v1';
const SHELL = [
  '/css/style.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 個案資料與頁面本身永遠走網路，離線時不提供舊內容
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  if (req.mode === 'navigate' || req.destination === 'document') return;
  if (!/\.(css|js|png|svg|ico|woff2?)$/.test(url.pathname)) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(req, fresh.clone());
        // 靜態檔網址會帶版本號（/js/app.js?v=…），每次改版都是一個新網址；
        // 若不清掉同一支檔案的舊版本，快取會隨著部署次數一路長大。
        const same = (await cache.keys())
          .filter(k => new URL(k.url).pathname === url.pathname && k.url !== req.url);
        await Promise.all(same.map(k => cache.delete(k)));
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});

// 前端部署新版後可送訊息要求立即接手
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
