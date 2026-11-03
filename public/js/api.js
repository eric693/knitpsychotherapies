// API 呼叫共用：自動處理 JSON、錯誤訊息、401 導回登入

// 員工端的 App 是 const 宣告（不會掛到 window 上），個案端則是 window.App，
// 兩邊寫法不同。原本這裡只看 window.App，員工端因此永遠取不到 —— 連 401 導回
// 登入都沒作用過，session 過期時櫃檯只會看到一則錯誤訊息，不知道是要重新登入。
function currentApp() {
  if (typeof App !== 'undefined' && App) return App;
  return (typeof window !== 'undefined' && window.App) || null;
}

// App.meta（方案、諮商室、心理師、常用參數）只在登入當下抓一次，
// 所以在同一個分頁裡新增方案後，排約視窗的方案下拉還是舊的那一份 ——
// 櫃檯會以為方案沒建成功，跑去個案資料裡硬改。這裡在改到這些資料之後自動重抓，
// 不必要求使用者自己按重新整理。只看路徑前綴，之後新增的端點也一體適用。
const META_PATHS = ['/service-plans', '/plan-topics', '/rooms', '/users', '/settings', '/partners'];
async function metaMayHaveChanged(path) {
  const app = currentApp();
  if (!app || !app.me || !app.meta) return;
  if (!META_PATHS.some(p => path === p || path.startsWith(p + '/'))) return;
  // 等它拿回來再往下走：呼叫端存完多半立刻 App.go() 重畫，
  // 沒等到的話重畫用的還是舊的那一份，等於沒更新。後台設定偶爾多一次請求不礙事。
  try { app.meta = await GET('/meta'); } catch { /* 拿不到就留著舊的，下次登入自然會更新 */ }
}

async function api(path, options = {}) {
  const opts = { headers: {}, credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      const app = currentApp();
      if (app && app.onUnauthorized) app.onUnauthorized();
    }
    throw new Error((data && data.error) || '操作失敗，請稍後再試');
  }
  if (opts.method && opts.method !== 'GET') await metaMayHaveChanged(path);
  return data;
}

const GET = p => api(p);
const POST = (p, body) => api(p, { method: 'POST', body });
const PUT = (p, body) => api(p, { method: 'PUT', body });
const DEL = p => api(p, { method: 'DELETE' });
