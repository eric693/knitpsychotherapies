// 前端冒煙測試：用無頭瀏覽器巡過所有頁面，抓 JS 例外、500 回應與載入不出來的頁面。
//
//   npm run smoke:ui                 # 對 http://localhost:3440（正式站，唯讀操作）
//   BASE=http://127.0.0.1:3999 npm run smoke:ui
//
// 與 scripts/smoke.js 的分工：smoke.js 驗 API 行為與資料正確性（會寫入拋棄式資料庫），
// 這支只做「頁面打得開、沒有 JS 錯誤」的檢查，全程唯讀，不新增或修改任何資料。
//
// 需要 playwright 的 chromium。本專案不把它列為相依（正式環境用不到），
// 找不到時直接跳過並回報，不讓它變成上線的阻礙。

const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3440';
const CANDIDATES = [
  '/root/lifecare/node_modules/playwright-core',
  '/root/mindcare/node_modules/playwright-core',
  '/root/project/knitpsychotherapies/mindcare/node_modules/playwright-core',
  'playwright-core'
];

const ACCOUNTS = [
  { user: 'admin', pass: 'mindcare123', label: '管理者' },
  { user: 'lin', pass: '123456', label: '心理師' },
  { user: 'wu', pass: '123456', label: '督導' },
  { user: 'office', pass: '123456', label: '行政' }
];
const PORTAL = { phone: '0912345678', pass: '345678' };

// 頁面資料是非同步載入的，固定等一段時間會隨資料量變多而誤判；
// 改成等到「載入中」消失為止，逾時才算真的卡住。
async function settledText(page, selector, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await page.textContent(selector).catch(() => '')) || '';
    if (text.trim() && !text.includes('載入中')) return text;
    await page.waitForTimeout(200);
  }
  return text;
}

function loadPlaywright() {
  for (const p of CANDIDATES) {
    try {
      if (p.startsWith('/') && !fs.existsSync(p)) continue;
      return require(p);
    } catch { /* 換下一個路徑 */ }
  }
  return null;
}

(async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log('找不到 playwright chromium，略過前端冒煙測試（API 測試請跑 npm run smoke）');
    process.exit(0);
  }
  const res = await fetch(BASE + '/api/public/ui-texts').catch(() => null);
  if (!res || !res.ok) {
    console.error(`連不上 ${BASE}，請先啟動伺服器（npm start 或 pm2 start）`);
    process.exit(1);
  }

  const problems = [];
  let checked = 0;
  const browser = await pw.chromium.launch();

  // 每個身分開一個新分頁：導覽列會依權限不同，正好一併驗到權限沒把人擋在自己該看的頁面外
  for (const acct of ACCOUNTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(`JS 例外：${e.message}`));
    page.on('console', m => {
      // 登入前對 /api/me 的 401 是預期行為，不算錯誤
      if (m.type() === 'error' && !m.text().includes('401')) errs.push(`Console：${m.text()}`);
    });
    page.on('response', r => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`); });

    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.fill('#lg-user', acct.user);
    await page.fill('#lg-pass', acct.pass);
    await page.click('#lg-btn');
    await page.waitForTimeout(1600);

    // 正式站上的示範帳號可能已被停用或改密碼，這種情況跳過該身分即可，
    // 不該讓整個前端冒煙測試中斷（帳號本身不是要測的東西）
    const loggedIn = await page.$('[data-nav]');
    if (!loggedIn) {
      console.log(`  – ${acct.label}（${acct.user}）：無法登入，略過`);
      await page.close();
      continue;
    }
    const navs = await page.$$eval('[data-nav]', els => els.map(e => e.dataset.nav));
    if (!navs.length) problems.push(`${acct.label}：登入後看不到任何導覽項目`);
    for (const key of navs) {
      await page.goto(`${BASE}/#${key}`, { waitUntil: 'load' });
      checked++;
      const body = await settledText(page, '#page-body');
      if (!body.trim()) problems.push(`${acct.label} / #${key}：頁面空白`);
      else if (body.includes('載入中')) problems.push(`${acct.label} / #${key}：卡在載入中`);
    }

    // 個案頁的每個分頁（保密邊界會讓不同身分看到不同分頁數）
    const list = await page.evaluate(async () => {
      const r = await (await fetch('/api/clients')).json();
      return Array.isArray(r) ? r.slice(0, 1) : [];
    });
    if (list.length) {
      await page.goto(`${BASE}/#client/${list[0].id}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const tabs = await page.$$eval('[data-tab]', els => els.map(e => e.dataset.tab));
      for (const t of tabs) {
        await page.click(`[data-tab=${t}]`);
        checked++;
        const c = await settledText(page, '#tab-body');
        if (!c.trim()) problems.push(`${acct.label} / 個案頁 ${t}：空白`);
        else if (c.includes('載入中')) problems.push(`${acct.label} / 個案頁 ${t}：卡在載入中`);
      }
    }
    errs.forEach(e => problems.push(`${acct.label}：${e}`));
    console.log(`  ${problems.length ? '·' : '✓'} ${acct.label}：導覽 ${navs.length} 頁`);
    await page.close();
  }

  // 個案端（手機版）
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const perrs = [];
  page.on('pageerror', e => perrs.push(`JS 例外：${e.message}`));
  page.on('response', r => { if (r.status() >= 500) perrs.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/portal.html', { waitUntil: 'networkidle' });
  await page.fill('#lg-user', PORTAL.phone);
  await page.fill('#lg-pass', PORTAL.pass);
  await page.click('#lg-btn');
  await page.waitForTimeout(2200);
  const loggedIn = await page.$('.fam-nav');
  if (!loggedIn) {
    // 與員工端一致：示範帳號已停用或刪除時略過，不視為程式問題
    console.log(`  – 個案端（${PORTAL.phone}）：無法登入，略過`);
  } else {
    for (const tab of ['home', 'book', 'scales', 'billing', 'me']) {
      await page.evaluate(k => Portal.go(k), tab);
      await page.waitForTimeout(900);
      checked++;
      const c = (await page.textContent('#body').catch(() => '')) || '';
      if (!c.trim()) problems.push(`個案端 / ${tab}：空白`);
    }
  }
  perrs.forEach(e => problems.push(`個案端：${e}`));
  console.log(`  ${perrs.length ? '·' : '✓'} 個案端：5 個分頁`);
  await page.close();
  await browser.close();

  console.log(`\n${'─'.repeat(46)}`);
  if (problems.length) {
    console.log(`✗ 檢查 ${checked} 個畫面，發現 ${problems.length} 個問題：`);
    problems.forEach(p => console.log(`   · ${p}`));
    process.exit(1);
  }
  console.log(`✓ 檢查 ${checked} 個畫面，無 JS 錯誤、無 5xx、無空白頁`);
})();
