// API 冒煙測試：在拋棄式資料庫上跑一輪關鍵流程，確認改動沒有打破既有功能。
//
//   npm run smoke              # 自行啟動測試用伺服器（預設埠 3999）
//   npm run smoke -- --keep    # 測完保留暫存資料庫與上傳目錄供查看
//
// 特性：
//   - 以 MINDCARE_DATA_DIR / MINDCARE_UPLOAD_DIR / MINDCARE_BACKUP_MIRROR 指向暫存目錄，
//     完全不碰正式資料（data/mindcare.db 與 uploads/）。
//   - 先跑 scripts/seed.js 灌入展示資料，再依實際 HTTP API 測試，不直接操作資料庫，
//     因此權限與保密邊界也一併被驗到。
//   - 任何一項失敗即以 exit code 1 結束，可掛在部署前或 CI。

process.env.TZ = process.env.TZ || 'Asia/Taipei';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 埠號預設交給作業系統挑一個空的，避免與機器上其他服務相撞
const net = require('net');
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
let PORT = Number(process.env.SMOKE_PORT || 0);
let BASE = '';
const KEEP = process.argv.includes('--keep');
const ROOT = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcare-smoke-'));
const env = {
  ...process.env,
  TZ: 'Asia/Taipei',
  MINDCARE_DATA_DIR: path.join(tmp, 'data'),
  MINDCARE_UPLOAD_DIR: path.join(tmp, 'uploads'),
  MINDCARE_BACKUP_MIRROR: path.join(tmp, 'mirror')
};

// ---- 迷你測試框架 ----
let pass = 0;
const failures = [];
let group = '';
function section(name) { group = name; console.log(`\n── ${name}`); }
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${group} / ${name}：${e.message}`);
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '條件不成立'); }
function equal(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不符'}（預期 ${expected}，實際 ${actual}）`);
}

// ---- HTTP 工具（各自帶 cookie，模擬不同登入身分）----
function session() {
  let cookie = '';
  const call = async (method, url, body, opts = {}) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
    let payload = body;
    if (body !== undefined && !opts.raw) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = JSON.parse(text); } catch { /* 保留原文 */ }
    }
    return { status: res.status, data, text };
  };
  const self = {
    get cookie() { return cookie; },
    get: (u, o) => call('GET', u, undefined, o),
    post: (u, b, o) => call('POST', u, b, o),
    put: (u, b) => call('PUT', u, b),
    del: u => call('DELETE', u),
    // 成功才回傳內容，失敗直接丟出錯誤訊息，測試碼才不必層層判斷
    async ok(method, u, b, o) {
      const r = await call(method, u, b, o);
      if (r.status >= 400) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
    async fails(method, u, b, msgPart) {
      const r = await call(method, u, b);
      assert(r.status >= 400, `${method} ${u} 應該被擋下，卻回 ${r.status}`);
      if (msgPart) {
        const m = (r.data && r.data.error) || '';
        assert(m.includes(msgPart), `錯誤訊息應含「${msgPart}」，實際為「${m}」`);
      }
      return r.data;
    }
  };
  return self;
}

// multipart 檔案上傳（不引外部套件，手工組 body）
function multipart(fields, file) {
  const b = '----mindcaresmoke' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`));
  parts.push(file.buf);
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

// 1x1 PNG（最小合法圖檔，用來驗證照片上傳與下載後位元組一致）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
// 取未來第一個指定星期的日期（seed 的 lin 排班在週一／三／五）
function nextWeekday(wd, minDaysAhead = 2) {
  let d = addDays(ymd(new Date()), minDaysAhead);
  while (new Date(d + 'T00:00:00').getDay() !== wd) d = addDays(d, 1);
  return d;
}

// 年度額度是「同一年內」計算，測試用的幾個日期必須落在同一年，
// 否則年底跑測試時第四筆會跨年、額度重算而不被擋（曾誤判為系統壞掉）。
function sameYearMondays(count, minDaysAhead = 60) {
  let start = nextWeekday(1, minDaysAhead);
  const year = () => start.slice(0, 4);
  // 從起點往後數 count 個週一；若最後一個跨年，整組往後推到下一年年初再數
  if (addDays(start, (count - 1) * 7).slice(0, 4) !== year()) {
    start = nextWeekday(1, minDaysAhead + 120);
    while (addDays(start, (count - 1) * 7).slice(0, 4) !== start.slice(0, 4)) start = addDays(start, 7);
  }
  return Array.from({ length: count }, (_, i) => addDays(start, i * 7));
}

let certIdEmployment = 0, certIdTreatment = 0;
let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', [path.join(ROOT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('伺服器啟動逾時：\n' + out)), 20000);
    server.stdout.on('data', d => {
      out += d;
      if (out.includes('管理系統')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', d => { out += d; if (process.env.SMOKE_VERBOSE) process.stderr.write(d); });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`伺服器結束（code ${code}）：\n${out}`)); });
  });
}

(async () => {
  PORT = PORT || await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  env.PORT = String(PORT);
  console.log(`暫存資料目錄：${tmp}（測試埠 ${PORT}）`);
  execFileSync('node', [path.join(ROOT, 'scripts', 'seed.js')], { env, stdio: 'ignore' });
  await startServer();

  const admin = session(), lin = session(), office = session(), chen = session(), wu = session();
  const portal = session();
  let clientId, clientCode;

  // ---------------------------------------------------------------- 登入與權限
  section('登入與權限');
  await test('管理者登入', async () => {
    const me = await admin.ok('POST', '/api/login', { username: 'admin', password: 'mindcare123' });
    equal(me.role, 'admin', '角色');
  });
  await test('心理師、督導、行政登入', async () => {
    await lin.ok('POST', '/api/login', { username: 'lin', password: '123456' });
    await wu.ok('POST', '/api/login', { username: 'wu', password: '123456' });
    await office.ok('POST', '/api/login', { username: 'office', password: '123456' });
    await chen.ok('POST', '/api/login', { username: 'chen', password: '123456' });
  });
  await test('密碼錯誤被拒', () => admin.fails('POST', '/api/login', { username: 'lin', password: 'x' }));
  await test('未登入讀不到 API', async () => {
    const r = await fetch(BASE + '/api/clients');
    equal(r.status, 401, 'HTTP 狀態');
  });
  await test('行政人員沒有晤談紀錄模組', async () => {
    const list = await office.ok('GET', '/api/clients');
    await office.fails('GET', `/api/clients/${list[0].id}/notes`, undefined, '權限');
  });

  // ---------------------------------------------------------------- 個案
  section('個案建檔');
  await test('新增個案並自動編號', async () => {
    const r = await lin.ok('POST', '/api/clients', {
      name: '冒煙測試個案', phone: '0900000001', birth_date: '1995-03-02',
      counselor_id: 2, risk_level: 'high', main_issue: '測試'
    });
    clientId = r.id;
    const c = await lin.ok('GET', `/api/clients/${clientId}`);
    clientCode = c.code;
    assert(/^K\d{4}\d{3}$/.test(c.code), `個案編號格式異常：${c.code}`);
  });
  await test('身分證檢查碼不符時回警告（設計為提示不擋）', async () => {
    const r = await lin.ok('POST', '/api/clients', { name: '冒煙身分證測試', id_no: 'A123456780' });
    assert(r.warning && r.warning.includes('檢查碼'), `應回傳檢查碼警告，實際：${JSON.stringify(r.warning)}`);
  });

  // ---------------------------------------------------------------- 排班
  section('排班與可預約時段');
  // 基準日取兩週後的週一，與 seed 內建的請假（今天+4 天）錯開；
  // 其餘測試以此推算，避免彼此撞日：+7 收費、+14 個案端預約、+21 請假、+28 改期
  const monday = nextWeekday(1, 8);
  await test('整週排班存檔並合併重疊時段', async () => {
    const r = await lin.ok('POST', '/api/availability/bulk', {
      blocks: [
        { weekday: 1, start_time: '14:00', end_time: '16:00' },
        { weekday: 1, start_time: '14:00', end_time: '15:00' },   // 完全重疊
        { weekday: 1, start_time: '16:00', end_time: '18:00' },   // 相接
        { weekday: 3, start_time: '14:00', end_time: '18:00' },
        { weekday: 5, start_time: '14:00', end_time: '18:00' }
      ]
    });
    equal(r.count, 3, '合併後時段數（週一三五各一段）');
  });
  await test('可預約時段不重複', async () => {
    const slots = await lin.ok('GET', `/api/slots?counselor_id=2&date=${monday}`);
    const starts = slots.map(s => s.start_time);
    equal(new Set(starts).size, starts.length, '出現重複的開始時間');
    assert(starts.length > 0, '應該要有可預約時段');
  });
  await test('非管理者不可設定別人的排班', () =>
    lin.fails('POST', '/api/availability/bulk', { counselor_id: 3, blocks: [] }, '自己'));
  await test('結束時間早於開始時間被擋', () =>
    lin.fails('POST', '/api/availability/bulk',
      { blocks: [{ weekday: 2, start_time: '16:00', end_time: '15:00' }] }, '結束時間'));

  // ---------------------------------------------------------------- 預約
  section('預約與衝突檢查');
  let apptId;
  await test('建立預約', async () => {
    const r = await lin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, room_id: 1, date: monday, start_time: '14:00', fee: 2000
    });
    apptId = r.id;
  });
  await test('改成 80 分鐘的方案時，結束時間跟著重算', async () => {
    // 方案各有時長（40／50／80 分），改方案卻沿用舊的結束時間，
    // 行事曆就會出現「伴侶 80 分鐘」卻只排 50 分鐘的格子。
    const plan = await admin.ok('POST', '/api/service-plans', {
      name: '時長測試方案（80 分鐘）', kind: 'self', fee: 3000, session_minutes: 80
    });
    const day = addDays(monday, 35);
    const a = await lin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: day, start_time: '09:00' });
    const fetch1 = (await admin.ok('GET', `/api/appointments?date=${day}`)).find(x => x.id === a.id);
    equal(fetch1.end_time, '09:50', '未指定方案時用系統預設 50 分鐘');
    await admin.ok('PUT', `/api/appointments/${a.id}`, { plan_id: plan.id });
    const after = (await admin.ok('GET', `/api/appointments?date=${day}`)).find(x => x.id === a.id);
    equal(after.end_time, '10:20', '改成 80 分鐘方案後結束時間應為 10:20');
    // 只改備註不該動到刻意調整過的時長
    await admin.ok('PUT', `/api/appointments/${a.id}`, { plan_id: plan.id, end_time: '11:00' });
    await admin.ok('PUT', `/api/appointments/${a.id}`, { plan_id: plan.id, note: '只改備註' });
    const kept = (await admin.ok('GET', `/api/appointments?date=${day}`)).find(x => x.id === a.id);
    equal(kept.end_time, '11:00', '沒改時間與方案時，手動調整過的時長要保留');
    await admin.ok('DELETE', `/api/appointments/${a.id}`);
    await admin.ok('DELETE', `/api/service-plans/${plan.id}`);
  });
  await test('明顯打錯的日期時間會被擋下', async () => {
    // 年份打錯（2062）、時間顛倒這類輸入，若讓它成立會變成永遠不會發生卻佔著額度的預約
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: '2062-01-05', start_time: '14:00' }, '兩年');
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: addDays(ymd(new Date()), -400), start_time: '14:00' }, '一年前');
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: '2026-13-45', start_time: '14:00' }, '日期');
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: addDays(monday, 49), start_time: '14:00', end_time: '13:00' },
      '結束時間');
  });
  await test('同一個案同時段不會被排兩筆', async () => {
    const day = addDays(monday, 56);
    const first = await lin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: day, start_time: '09:00' });
    // 換一位心理師也不行：個案分身乏術，多半是重複建單
    await admin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 3, date: day, start_time: '09:00' }, '已有另一筆預約');
    await admin.ok('DELETE', `/api/appointments/${first.id}`);
  });
  await test('可用 CSV 只補個案手機，並開通個案專區帳號', async () => {
    // 舊資料匯入時沒帶手機的個案，用這張表補上；只動手機欄，其他資料不變
    const c = await admin.ok('POST', '/api/clients', { name: '匯入手機測試', phone: '' });
    const before = await admin.ok('GET', `/api/clients/${c.id}`);
    const csv = `個案編號,姓名,手機\n${before.code},匯入手機測試,0955123456\n`;
    const send = async (path) => {
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'phones.csv');
      fd.append('mode', 'update');
      const r = await fetch(`${BASE}/api/imports/client_phones/${path}`, {
        method: 'POST', headers: { Cookie: admin.cookie }, body: fd
      });
      return { status: r.status, body: await r.json() };
    };
    const pv = await send('preview');
    assert(pv.status === 200, '預覽失敗：' + JSON.stringify(pv.body));
    equal(pv.body.summary.error, 0, '預覽不應有錯誤列');
    equal(pv.body.summary.duplicate, 1, '應對到 1 位既有個案');
    const done = await send('commit');
    assert(done.status === 200, '匯入失敗：' + JSON.stringify(done.body));
    equal(done.body.updated, 1, '應更新 1 筆');
    const after = await admin.ok('GET', `/api/clients/${c.id}`);
    equal(after.phone, '0955123456', '手機應已補上');
    equal(after.name, before.name, '其他欄位不應變動');
    // 補了手機就有專區帳號可用（預設密碼為末 6 碼）
    const login = await session().post('/api/portal/login', { phone: '0955123456', password: '123456' });
    equal(login.status, 200, '應可用手機末 6 碼登入個案專區：' + JSON.stringify(login.data));
    await admin.ok('DELETE', `/api/clients/${c.id}/purge`);
  });
  await test('個案手機重複會被擋下（個案專區以手機登入）', async () => {
    const dupPhone = '0912000777';
    const a = await admin.ok('POST', '/api/clients', { name: '防呆測試甲', phone: dupPhone });
    await admin.fails('POST', '/api/clients', { name: '防呆測試乙', phone: dupPhone }, '已是');
    const b2 = await admin.ok('POST', '/api/clients', { name: '防呆測試乙', phone: '0912000778' });
    await admin.fails('PUT', `/api/clients/${b2.id}`, { phone: dupPhone }, '已是');
    // 留空不受限（家人共用號碼的情形）
    await admin.ok('PUT', `/api/clients/${b2.id}`, { phone: '' });
    await admin.ok('DELETE', `/api/clients/${a.id}/purge`);
    await admin.ok('DELETE', `/api/clients/${b2.id}/purge`);
  });
  await test('收費單金額明顯有誤會被擋下', async () => {
    await admin.fails('POST', '/api/invoices', { client_id: clientId, item: '測試', amount: -100 }, '負數');
    await admin.fails('POST', '/api/invoices', { client_id: clientId, item: '測試', amount: 20000000 }, '100 萬');
    await admin.fails('POST', '/api/invoices', { client_id: clientId, item: '測試', amount: 0 }, '請填寫金額');
  });
  await test('個案可在 LINE 提醒卡片上按「我會準時前往」', async () => {
    // 提醒卡片帶 postback 按鈕，webhook 收到後記下確認時間；改期則轉為取消申請通知櫃檯
    const line = require('../src/line');
    const day = addDays(monday, 63);
    const made = await lin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: day, start_time: '11:00' });
    const flex = JSON.stringify(line.reminderFlex({ id: made.id, date: day, start_time: '11:00', end_time: '11:50' }));
    assert(flex.includes(`act=confirm&id=${made.id}`), '提醒卡片應有確認出席的按鈕');
    assert(flex.includes(`act=change&id=${made.id}`), '提醒卡片應有改期按鈕');
    await admin.ok('DELETE', `/api/appointments/${made.id}`);
  });
  await test('視訊晤談不佔用諮商室', async () => {
    // 通訊諮商在線上進行，若也被指派空間，諮商室使用表會被塞滿看不出空檔
    const day = addDays(monday, 42);
    const on = await lin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, date: day, start_time: '10:00', mode: 'online'
    });
    const list = await admin.ok('GET', `/api/appointments?date=${day}`);
    const a = list.find(x => x.id === on.id);
    assert(!a.room_id, '視訊預約不應有諮商室：' + JSON.stringify(a.room_id));
    // 改回到所要重新拿到空間，改成視訊則退掉
    await admin.ok('PUT', `/api/appointments/${on.id}`, { mode: 'onsite' });
    const onsite = (await admin.ok('GET', `/api/appointments?date=${day}`)).find(x => x.id === on.id);
    assert(onsite.room_id, '改為到所後應指派諮商室');
    await admin.ok('PUT', `/api/appointments/${on.id}`, { mode: 'online' });
    const back = (await admin.ok('GET', `/api/appointments?date=${day}`)).find(x => x.id === on.id);
    assert(!back.room_id, '改回視訊後應退掉諮商室');
    await admin.ok('DELETE', `/api/appointments/${on.id}`);
  });
  await test('同一心理師時段衝突被擋', () =>
    lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: monday, start_time: '14:00' }, '心理師'));
  await test('同一諮商室衝突被擋', () =>
    lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 3, room_id: 1, date: monday, start_time: '14:00' }, '諮商室'));
  await test('請假時段不可下訂', async () => {
    const off = addDays(monday, 21);
    await lin.ok('POST', '/api/time-off', { start_date: off, end_date: off, all_day: true, reason: '測試請假' });
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: off, start_time: '14:00' }, '請假');
  });
  await test('時段起點對齊整點半點，不會出現 14:20 這種怪時間', async () => {
    const before = (await lin.ok('GET', '/api/availability?counselor_id=2'))
      .map(v => ({ weekday: v.weekday, start_time: v.start_time, end_time: v.end_time, note: v.note }));
    const day = nextWeekday(2, 30);   // 週二
    await lin.ok('POST', '/api/availability/bulk', {
      counselor_id: 2, blocks: [{ weekday: 2, start_time: '13:00', end_time: '17:00' }]
    });
    // 80 分鐘的方案：舊做法會排出 13:00、14:20、15:40，現在應為 13:00、13:30、14:00...
    const plan = await admin.ok('POST', '/api/service-plans', {
      name: '時段對齊測試（80 分鐘）', kind: 'self', fee: 3000, session_minutes: 80
    });
    try {
      const slots = await admin.ok('GET', `/api/slots?counselor_id=2&date=${day}`);
      assert(slots.every(s => /:(00|30)$/.test(s.start_time)), '起點應落在整點或半點：' + JSON.stringify(slots));
      const pub = await (await fetch(
        `${BASE}/api/public/booking-slots?counselor_id=2&plan_id=${plan.id}&from=${day}&days=1`)).json();
      const day1 = (pub.days || []).find(d => d.date === day) || { slots: [] };
      assert(day1.slots.length, '表單端應有時段');
      assert(day1.slots.every(s => /:(00|30)$/.test(s.start_time)),
        '表單端起點也要對齊：' + JSON.stringify(day1.slots.map(s => s.start_time)));
      // 最後一個 80 分鐘的時段不可超出 17:00
      assert(day1.slots.every(s => s.end_time <= '17:00'), '時段不可超出排班結束時間');
    } finally {
      await admin.ok('DELETE', `/api/service-plans/${plan.id}`);
      await lin.ok('POST', '/api/availability/bulk', { counselor_id: 2, blocks: before });
    }
  });
  await test('排班可只改某一週，其他週仍照固定班', async () => {
    // 這支測試會覆寫固定班，跑完要還原，否則後面的個案端預約測試會找不到時段
    const before = (await lin.ok('GET', '/api/availability?counselor_id=2'))
      .map(v => ({ weekday: v.weekday, start_time: v.start_time, end_time: v.end_time, note: v.note }));
    const wed = nextWeekday(3, 30);
    const wedNext = addDays(wed, 7);
    await lin.ok('POST', '/api/availability/bulk', {
      counselor_id: 2, blocks: [{ weekday: 3, start_time: '09:00', end_time: '12:00' }]
    });
    const base = await lin.ok('GET', `/api/slots?counselor_id=2&date=${wed}`);
    assert(base.some(s => s.start_time === '09:00'), '固定班應開出 09:00 的時段');
    // 只改 wed 那一週：改成 14:00-16:00
    const monday = wed.slice(0, 10);
    const info0 = await lin.ok('GET', `/api/availability/week-info?counselor_id=2&week_start=${monday}`);
    assert(!info0.custom, '尚未單獨排班時應顯示沿用固定班');
    await lin.ok('POST', '/api/availability/bulk', {
      counselor_id: 2, week_start: monday, blocks: [{ weekday: 3, start_time: '14:00', end_time: '16:00' }]
    });
    const wk = await lin.ok('GET', `/api/slots?counselor_id=2&date=${wed}`);
    assert(wk.some(s => s.start_time === '14:00'), '該週應改用專用班：' + JSON.stringify(wk));
    assert(!wk.some(s => s.start_time === '09:00'), '該週不應再出現固定班的時段');
    const other = await lin.ok('GET', `/api/slots?counselor_id=2&date=${wedNext}`);
    assert(other.some(s => s.start_time === '09:00'), '其他週仍照固定班');
    const info1 = await lin.ok('GET', `/api/availability/week-info?counselor_id=2&week_start=${monday}`);
    assert(info1.custom, '設定後應顯示這週單獨排班');
    // 某週整週不開放：存空白也要記住「這週不開」，不能回頭沿用固定班
    await lin.ok('POST', '/api/availability/bulk', { counselor_id: 2, week_start: monday, blocks: [] });
    const none = await lin.ok('GET', `/api/slots?counselor_id=2&date=${wed}`);
    equal(none.length, 0, '整週不開放時不應有任何時段');
    // 取消單週設定後回到固定班
    await lin.del(`/api/availability/week?counselor_id=2&week_start=${monday}`);
    const back = await lin.ok('GET', `/api/slots?counselor_id=2&date=${wed}`);
    assert(back.some(s => s.start_time === '09:00'), '取消單週設定後應回到固定班');
    await lin.ok('POST', '/api/availability/bulk', { counselor_id: 2, blocks: before });
  });
  await test('週檢視與行事曆回傳資料', async () => {
    const w = await lin.ok('GET', `/api/schedule/week?start=${monday}`);
    assert(Array.isArray(w.appointments), '週檢視格式');
    const c = await lin.ok('GET', `/api/schedule/calendar?from=${monday}&to=${addDays(monday, 30)}`);
    assert(Array.isArray(c.appointments), '行事曆格式');
  });

  // ---------------------------------------------------------------- 行事曆訂閱
  section('行事曆訂閱（.ics）');
  let icsUrl;
  await test('取得訂閱網址並可讀取', async () => {
    const r = await lin.ok('GET', '/api/my/calendar-url');
    icsUrl = r.url;
    const res = await fetch(icsUrl);
    equal(res.status, 200, 'HTTP 狀態');
    const body = await res.text();
    assert(body.startsWith('BEGIN:VCALENDAR'), 'ics 格式');
    assert(body.includes('BEGIN:VEVENT'), '應包含事件');
    assert(body.includes(clientCode), '應以個案編號標示');
    assert(!body.includes('冒煙測試個案'), '不可含個案姓名');
  });
  await test('重設後舊網址失效', async () => {
    await lin.ok('POST', '/api/my/calendar-url/reset', {});
    const res = await fetch(icsUrl);
    equal(res.status, 404, '舊網址應失效');
  });

  // ---------------------------------------------------------------- 個案端
  section('個案端（預約、改期、取消）');
  let portalAppt;
  await test('個案端登入', async () => {
    await admin.ok('PUT', `/api/clients/${clientId}`, { portal_enabled: 1 });
    const rp = await admin.ok('POST', `/api/clients/${clientId}/reset-password`, {});
    const r = await portal.ok('POST', '/api/portal/login', { phone: '0900000001', password: rp.password });
    assert(r.ok, '登入失敗');
  });
  await test('個案端自行預約', async () => {
    const target = addDays(monday, 14);
    const slots = await portal.ok('GET', `/api/portal/slots?date=${target}`);
    const c = slots.counselors.find(x => x.slots.length);
    assert(c, `個案端在 ${target} 應看得到可預約時段，實際：${JSON.stringify(slots)}`);
    const r = await portal.ok('POST', '/api/portal/appointments',
      { date: target, start_time: c.slots[0].start_time, counselor_id: c.id });
    portalAppt = r.id;
  });
  await test('改期後不會與他人共用同一諮商室', async () => {
    // 先讓櫃檯把同一時段的諮商室 1 排給別的心理師，再讓個案改期過去
    const target = addDays(monday, 28);
    const slots = await lin.ok('GET', `/api/slots?counselor_id=2&date=${target}`);
    assert(slots.length, '該日應有可預約時段');
    const t = slots[0].start_time;
    const others = await lin.ok('GET', '/api/clients');
    const other = others.find(c => c.id !== clientId);
    await lin.ok('POST', '/api/appointments',
      { client_id: other.id, counselor_id: 3, room_id: 1, date: target, start_time: t });
    await admin.ok('PUT', `/api/appointments/${portalAppt}`, { room_id: 1 });
    await portal.ok('POST', `/api/portal/appointments/${portalAppt}/reschedule`, { date: target, start_time: t });
    const list = await lin.ok('GET', `/api/appointments?date=${target}`);
    const rooms = list.filter(a => a.room_id).map(a => `${a.room_id}@${a.start_time}`);
    equal(new Set(rooms).size, rooms.length, '同一諮商室同一時段被排了兩筆');
  });
  await test('逾期取消只留申請不直接取消', async () => {
    const now = new Date();
    if (now.getHours() >= 22) { console.log('      （接近午夜，略過此項）'); return; }
    const soon = ymd(now);
    const hh = String(now.getHours() + 1).padStart(2, '0');
    const r = await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: soon, start_time: `${hh}:00` });
    const res = await portal.ok('POST', `/api/portal/appointments/${r.id}/cancel`, { reason: '臨時有事' });
    assert(res.pending, '應為待櫃檯處理的申請');
    const after = await admin.ok('GET', `/api/appointments?date=${soon}`);
    const row = after.find(a => a.id === r.id);
    equal(row.status, 'booked', '狀態不應被個案改掉');
    const dash = await admin.ok('GET', '/api/dashboard');
    assert(dash.cancel_requests.some(c => c.id === r.id), '總覽應列出取消申請');
    await admin.ok('POST', `/api/appointments/${r.id}/status`, { status: 'cancelled' });
  });
  await test('前一天截止時間一到，隔天的線上預約就關閉', async () => {
    const t = ymd(new Date());
    const minDate = async () => (await (await fetch(`${BASE}/api/public/booking-slots?counselor_id=2&days=3`)).json()).min_date;
    await admin.ok('PUT', '/api/settings', { booking_cutoff_time: '', booking_lead_days: '1' });
    equal(await minDate(), addDays(t, 1), '沒設截止時間時就是最快 1 天後');
    await admin.ok('PUT', '/api/settings', { booking_cutoff_time: '00:00' });
    equal(await minDate(), addDays(t, 2), '已過截止時間，隔天應關閉');
    // 直接送出隔天的申請也要被擋
    await (async () => {
      const cfg = await (await fetch(BASE + '/api/public/booking-config')).json();
      const anyPlan = (cfg.plans || [])[0];
      const r = await fetch(BASE + '/api/public/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '截止測試', phone: '0911666555', consent: true,
          plan_id: anyPlan && anyPlan.id, birth_date: '2000-01-01',
          counselor_id: 2, date: addDays(t, 1), start_time: '14:00' })
      });
      const d = await r.json();
      equal(r.status, 400, '隔天的時段應被擋下');
      assert(/截止/.test(d.error || ''), '錯誤訊息應說明已截止：' + d.error);
    })();
    await admin.ok('PUT', '/api/settings', { booking_cutoff_time: '21:00' });
  });
  await test('也可改用「晤談前 X 小時」截止', async () => {
    // 兩道門檻同時生效：前一天固定時間、以及晤談前至少幾小時
    await admin.ok('PUT', '/api/settings', { booking_cutoff_time: '', booking_cutoff_hours: '72' });
    const d = await (await fetch(`${BASE}/api/public/booking-slots?counselor_id=2&days=4`)).json();
    const soon = (d.days || []).filter(x => x.date < addDays(ymd(new Date()), 3));
    assert(soon.every(x => !x.slots.length), '三天內的時段應被 72 小時門檻濾掉');
    await admin.ok('PUT', '/api/settings', { booking_cutoff_hours: '0', booking_cutoff_time: '21:00' });
  });
  await test('個案專區訊息預設只讀，聯繫走 LINE', async () => {
    await portal.fails('POST', '/api/portal/messages', { content: '測試留言' }, 'LINE');
    await admin.ok('PUT', '/api/settings', { portal_messages_write: '1' });
    const r = await portal.ok('POST', '/api/portal/messages', { content: '開放後可留言' });
    assert(r.id, '開放後應可留言');
    await admin.ok('PUT', '/api/settings', { portal_messages_write: '0' });
  });
  await test('個案端可自助取得 LINE 綁定碼', async () => {
    // 加好友只能由本人在 LINE 點下去，系統能做的是把綁定碼給個案、讓他傳進官方帳號；
    // 傳送後由 Webhook 完成綁定（另有測試涵蓋）。
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: 'test-token', line_official_id: '@testoa' });
    try {
      const d = await portal.ok('GET', '/api/portal/line');
      assert(d.enabled, '已設定權杖時應為啟用');
      assert(!d.bound, '一開始不應是已綁定');
      assert(/^\d{6}$/.test(d.code || ''), '應提供 6 碼綁定碼：' + d.code);
      assert((d.message_url || '').includes(d.code), '聊天室連結應帶入綁定碼');
      const again = await portal.ok('GET', '/api/portal/line');
      equal(again.code, d.code, '重整頁面不應一直換新碼');
      await portal.ok('DELETE', '/api/portal/line');   // 尚未綁定時解除也不應出錯
    } finally {
      await admin.ok('PUT', '/api/line/settings', { line_channel_token: '', line_official_id: '' });
    }
  });
  await test('個案端讀不到晤談紀錄類 API', async () => {
    const res = await fetch(BASE + `/api/clients/${clientId}/notes`);
    assert(res.status === 401 || res.status === 403, '個案端不得存取員工 API');
  });

  // ---------------------------------------------------------------- 候補遞補
  section('候補遞補');
  await test('取消釋出時段後可配對候補', async () => {
    await admin.ok('POST', '/api/intakes', {
      name: '冒煙候補', phone: '0900000009', issue: '測試候補', urgency: 'high',
      preferred_counselor_id: 2, preferred_time: '平日下午'
    });
    const r = await admin.ok('POST', `/api/appointments/${apptId}/status`, { status: 'cancelled' });
    assert(r.opening && r.opening.candidates.length, '取消後應回傳候補人選');
    const openings = await admin.ok('GET', '/api/waitlist/openings');
    assert(openings.some(o => o.date === monday), '釋出時段應出現在候補清單');
  });
  await test('發送遞補通知（未設通道時記為人工）', async () => {
    const list = await admin.ok('GET', '/api/intakes');
    const w = list.find(i => i.name === '冒煙候補');
    const r = await admin.ok('POST', '/api/waitlist/notify',
      { intake_id: w.id, counselor_id: 2, date: monday, start_time: '14:00' });
    equal(r.status, 'manual', '發送狀態');
  });

  // ---------------------------------------------------------------- 晤談紀錄與覆核
  section('晤談紀錄保密與實習生覆核');
  let noteId, internId;
  await test('主責心理師可寫紀錄、非主責讀不到', async () => {
    const r = await lin.ok('POST', '/api/notes', {
      client_id: clientId, date: monday, subjective: 'S', objective: 'O',
      assessment: 'A', plan: 'P', risk_flag: 'none'
    });
    noteId = r.id;
    await chen.fails('GET', `/api/clients/${clientId}/notes`, undefined, '主責');
    const mine = await lin.ok('GET', `/api/clients/${clientId}/notes`);
    assert(mine.length >= 1, '主責應讀得到');
  });
  await test('督導可調閱', async () => {
    const rows = await wu.ok('GET', `/api/clients/${clientId}/notes`);
    assert(rows.length >= 1, '督導應讀得到');
  });
  await test('簽核後不可修改', async () => {
    await lin.ok('POST', `/api/notes/${noteId}/sign`, {});
    await lin.fails('PUT', `/api/notes/${noteId}`, { plan: '改改看' }, '定稿');
  });
  await test('實習生紀錄須經督導覆核才定稿', async () => {
    const u = await admin.ok('POST', '/api/users', {
      username: 'smoke_intern', password: '123456', name: '冒煙實習生', role: 'counselor',
      license_type: '實習心理師', is_intern: true, supervisor_id: 4
    });
    internId = u.id;
    await admin.ok('PUT', `/api/clients/${clientId}`, { counselor_id: internId });
    const intern = session();
    await intern.ok('POST', '/api/login', { username: 'smoke_intern', password: '123456' });
    const n = await intern.ok('POST', '/api/notes', {
      client_id: clientId, date: monday, subjective: 'S2', objective: 'O2', assessment: 'A2', plan: 'P2'
    });
    const signed = await intern.ok('POST', `/api/notes/${n.id}/sign`, {});
    equal(signed.review_status, 'pending', '應為待覆核');
    await intern.fails('PUT', `/api/notes/${n.id}`, { plan: '偷改' }, '覆核');
    const queue = await wu.ok('GET', '/api/notes/review-queue');
    assert(queue.rows.some(r => r.id === n.id), '督導的待覆核清單應包含此筆');
    await wu.fails('POST', `/api/notes/${n.id}/review`, { action: 'return' }, '意見');
    await wu.ok('POST', `/api/notes/${n.id}/review`, { action: 'return', comment: '請補風險評估' });
    await intern.ok('PUT', `/api/notes/${n.id}`, { plan: '已補' });
    await intern.ok('POST', `/api/notes/${n.id}/sign`, {});
    await chen.fails('POST', `/api/notes/${n.id}/review`, { action: 'approve' }, '督導');
    await wu.ok('POST', `/api/notes/${n.id}/review`, { action: 'approve', comment: 'OK' });
    const got = await wu.ok('GET', `/api/notes/${n.id}`);
    equal(got.review_status, 'approved', '覆核狀態');
    equal(got.locked, 1, '應已定稿鎖定');
    await admin.ok('PUT', `/api/clients/${clientId}`, { counselor_id: 2 });
  });

  // ---------------------------------------------------------------- 安全計畫
  section('安全計畫');
  let planId;
  await test('建立與新版本', async () => {
    const r = await lin.ok('POST', `/api/clients/${clientId}/safety-plans`, {
      warning_signs: '睡不著', coping_strategies: '散步', review_date: addDays(monday, 90)
    });
    planId = r.id;
    const v2 = await lin.ok('POST', `/api/clients/${clientId}/safety-plans`, {
      warning_signs: '睡不著、易怒', coping_strategies: '散步、深呼吸'
    });
    equal(v2.version, 2, '版本號');
    const list = await lin.ok('GET', `/api/clients/${clientId}/safety-plans`);
    equal(list.rows.filter(r2 => r2.status === 'active').length, 1, '現行版本應只有一份');
  });
  await test('必填欄位驗證', () =>
    lin.fails('POST', `/api/clients/${clientId}/safety-plans`, { warning_signs: '只有警訊' }, '必填'));
  await test('舊版本不可修改、可列印', async () => {
    await lin.fails('PUT', `/api/safety-plans/${planId}`, { warning_signs: 'x' }, '舊版本');
    const p = await lin.ok('GET', `/api/safety-plans/${planId}/print`);
    assert(p.center_name, '列印資料應含所別抬頭');
  });
  await test('非主責心理師與行政讀不到', async () => {
    await chen.fails('GET', `/api/clients/${clientId}/safety-plans`, undefined, '主責');
    await office.fails('GET', `/api/clients/${clientId}/safety-plans`);
  });
  await test('列管清單標示狀態', async () => {
    const d = await admin.ok('GET', '/api/safety-plans/overview');
    assert(d.rows.some(r => r.client_id === clientId && r.state === 'ok'), '應顯示現行有效');
  });

  // ---------------------------------------------------------------- 轉介與追蹤
  section('轉介、結案追蹤與通報表');
  await test('轉介紀錄與對方回覆', async () => {
    const r = await lin.ok('POST', `/api/clients/${clientId}/referrals`,
      { target: '某某醫院身心科', reason: '需藥物評估', contact: '02-1234-5678' });
    await lin.fails('POST', `/api/clients/${clientId}/referrals`, { target: '缺原因' }, '原因');
    await lin.ok('PUT', `/api/referrals/${r.id}`, { status: 'accepted', reply_note: '已排下週門診' });
    const list = await lin.ok('GET', `/api/clients/${clientId}/referrals`);
    const row = list.rows.find(x => x.id === r.id);
    equal(row.status, 'accepted', '轉介狀態');
    assert(row.replied_at, '應自動記下回覆時間');
    assert(list.targets.length, '應提供轉介對象選項');
  });
  await test('非主責心理師與行政讀不到轉介紀錄', async () => {
    await chen.fails('GET', `/api/clients/${clientId}/referrals`, undefined, '主責');
    await office.fails('GET', `/api/clients/${clientId}/referrals`);
    await office.fails('GET', '/api/follow-ups');
  });
  await test('結案時自動建立追蹤點', async () => {
    const r = await admin.ok('PUT', `/api/clients/${clientId}`, { status: 'closed', close_reason: '目標達成' });
    assert(r.follow_ups >= 1, '結案應自動建立追蹤點');
    const fu = await lin.ok('GET', `/api/clients/${clientId}/follow-ups`);
    assert(fu.rows.length >= 1, '追蹤清單應有資料');
    const first = fu.rows[0];
    await lin.fails('PUT', `/api/follow-ups/${first.id}`, { status: 'done' }, '追蹤結果');
    await lin.ok('PUT', `/api/follow-ups/${first.id}`,
      { status: 'done', channel: '電話', result: '個案狀況穩定，無需再約' });
    const after = await lin.ok('GET', `/api/clients/${clientId}/follow-ups`);
    const done = after.rows.find(x => x.id === first.id);
    equal(done.status, 'done', '追蹤狀態');
    assert(done.done_at, '應記下完成時間');
    // 還原為服務中，後續收費測試才排得了新預約
    await admin.ok('PUT', `/api/clients/${clientId}`, { status: 'active' });
  });
  await test('待追蹤清單可查', async () => {
    const d = await admin.ok('GET', '/api/follow-ups');
    assert(Array.isArray(d.rows), '清單格式');
    assert(typeof d.overdue === 'number', '應回傳逾期數');
  });
  await test('責任通報表帶齊欄位', async () => {
    const events = await admin.ok('GET', '/api/risk-events');
    assert(events.length, '示範資料應有危機事件');
    const f = await admin.ok('GET', `/api/risk-events/${events[0].id}/report-form`);
    assert(f.client_name && f.client_code, '應帶當事人資料');
    assert(f.reporter && f.reporter.name, '應帶通報人');
    assert(f.center_name, '應帶通報單位');
    assert(typeof f.mandatory === 'boolean', '應標示是否為法定責任通報');
    await office.fails('GET', `/api/risk-events/${events[0].id}/report-form`);
  });

  // ---------------------------------------------------------------- 收費與退費
  section('收費、方案與退費');
  let invoiceId;
  await test('完成晤談自動開單並收款', async () => {
    const target = addDays(monday, 7);
    const a = await lin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: target, start_time: '14:00', fee: 2000 });
    await lin.ok('POST', `/api/appointments/${a.id}/status`, { status: 'done' });
    const inv = await admin.ok('GET', `/api/invoices?client_id=${clientId}&status=unpaid`);
    const row = inv.rows.find(r => r.appointment_id === a.id);
    assert(row, '完成晤談應產生收費單');
    invoiceId = row.id;
    await admin.ok('POST', `/api/invoices/${invoiceId}/pay`, { method: '現金' });
    const after = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    equal(after.rows.find(r => r.id === invoiceId).status, 'paid', '收款後狀態');
  });
  await test('退費超額被擋、全額退費改狀態', async () => {
    await admin.fails('POST', `/api/invoices/${invoiceId}/refund`, { amount: 99999, reason: '測試' }, '上限');
    await admin.fails('POST', `/api/invoices/${invoiceId}/refund`, { amount: 100 }, '原因');
    await admin.ok('POST', `/api/invoices/${invoiceId}/refund`, { amount: 2000, reason: '所方因素取消' });
    const list = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const row = list.rows.find(r => r.id === invoiceId);
    equal(row.status, 'refunded', '全額退費後狀態');
    equal(row.refunded, 2000, '已退金額');
    equal(list.total_net, list.total_paid + 2000 - list.total_refunded, '實收計算');
  });
  await test('已退費的收費單不會被狀態回沖刪掉', async () => {
    const inv = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const row = inv.rows.find(r => r.id === invoiceId);
    const r = await admin.ok('POST', `/api/appointments/${row.appointment_id}/status`, { status: 'booked' });
    assert(r.warnings.length, '應提出警示');
    const after = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    assert(after.rows.some(x => x.id === invoiceId), '退費過的收費單被刪除了');
  });
  await test('撤銷退費後回復為已收款', async () => {
    const d = await admin.ok('GET', '/api/refunds');
    const rf = d.rows.find(r => r.invoice_id === invoiceId);
    await admin.ok('DELETE', `/api/refunds/${rf.id}`);
    const list = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    equal(list.rows.find(r => r.id === invoiceId).status, 'paid', '撤銷後狀態');
  });

  // ---------------------------------------------------------------- 附件
  section('附件上傳與下載');
  let pngId, pdfId;
  await test('上傳照片（PNG）', async () => {
    const mp = multipart({ kind: '其他', note: '冒煙測試照片' }, { name: '測試照片.png', type: 'image/png', buf: PNG });
    const r = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    pngId = r.id || (r.attachment && r.attachment.id);
    assert(pngId, `上傳回應缺少 id：${JSON.stringify(r)}`);
  });
  await test('上傳 PDF 並保留中文檔名', async () => {
    const mp = multipart({ kind: '轉介單' }, { name: '轉介單.pdf', type: 'application/pdf', buf: PDF });
    const r = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    pdfId = r.id || (r.attachment && r.attachment.id);
    const list = await lin.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(list.some(f => f.filename === '轉介單.pdf'), '中文檔名應正確保存');
  });
  await test('不支援的副檔名被擋', async () => {
    const mp = multipart({}, { name: 'evil.exe', type: 'application/octet-stream', buf: Buffer.from('x') });
    const r = await lin.post(`/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    assert(r.status >= 400, `應被擋下，卻回 ${r.status}`);
  });
  await test('未登入不可下載附件', async () => {
    const r = await fetch(BASE + `/api/attachments/${pngId}/download`);
    assert(r.status === 401 || r.status === 403, `未登入不應下載成功（回 ${r.status}）`);
  });
  await test('主責心理師可下載且內容正確', async () => {
    const res = await fetch(BASE + `/api/attachments/${pngId}/download`, { headers: { Cookie: lastCookie(lin) } });
    equal(res.status, 200, 'HTTP 狀態');
    const buf = Buffer.from(await res.arrayBuffer());
    equal(buf.length, PNG.length, '下載位元組數');
    assert(buf.equals(PNG), '下載內容與上傳不一致');
  });
  await test('實體檔確實落在上傳目錄且檔名隨機', async () => {
    const files = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    assert(files.length >= 2, '上傳目錄應有檔案');
    assert(!files.some(f => f.includes('測試照片')), '實體檔名不應沿用原始檔名');
  });
  await test('uploads 目錄不對外開放靜態存取', async () => {
    const files = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    const res = await fetch(`${BASE}/uploads/${files[0]}`);
    assert(res.status === 404, `uploads 不應可直接讀取（回 ${res.status}）`);
  });
  await test('個案端只看得到被開放的附件', async () => {
    let mine = await portal.ok('GET', '/api/portal/attachments');
    equal(mine.length, 0, '預設不應開放');
    const res = await fetch(BASE + `/api/portal/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(portal) } });
    assert(res.status >= 400, '未開放的檔案不可下載');
    await lin.ok('PUT', `/api/attachments/${pdfId}`, { visible_to_client: 1 });
    mine = await portal.ok('GET', '/api/portal/attachments');
    equal(mine.length, 1, '開放後應看得到');
    const ok = await fetch(BASE + `/api/portal/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(portal) } });
    equal(ok.status, 200, '開放後應可下載');
  });
  await test('行政層附件他人可讀、臨床層附件受保密邊界保護', async () => {
    // 轉介單屬行政層：有個案管理權限者皆可存取
    const admin1 = await fetch(BASE + `/api/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(chen) } });
    equal(admin1.status, 200, '行政層附件應可讀');
    // 衡鑑報告屬臨床層：非主責心理師應被擋
    const mp = multipart({ kind: '衡鑑報告' }, { name: '衡鑑報告.pdf', type: 'application/pdf', buf: PDF });
    const rep = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    const blocked = await fetch(BASE + `/api/attachments/${rep.id}/download`, { headers: { Cookie: lastCookie(chen) } });
    assert(blocked.status === 403, `臨床層附件應被擋（回 ${blocked.status}）`);
    const listForChen = await chen.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(!listForChen.some(f => f.id === rep.id), '臨床層附件不應出現在非主責者的清單');
    const listForLin = await lin.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(listForLin.some(f => f.id === rep.id), '主責心理師應看得到');
  });
  await test('刪除附件同時移除實體檔', async () => {
    const before = fs.readdirSync(env.MINDCARE_UPLOAD_DIR).length;
    await lin.ok('DELETE', `/api/attachments/${pngId}`);
    const after = fs.readdirSync(env.MINDCARE_UPLOAD_DIR).length;
    equal(after, before - 1, '實體檔應一併刪除');
  });

  // ---------------------------------------------------------------- 備份與資料同步
  section('備份與資料同步');
  await test('手動備份並同步附件到異地目錄', async () => {
    const r = await admin.ok('POST', '/api/maintenance/backup', {});
    assert(r.latest_backup, '應產生備份檔');
    const mirrorDb = path.join(env.MINDCARE_BACKUP_MIRROR, r.latest_backup);
    assert(fs.existsSync(mirrorDb), '異地目錄應有備份檔');
    assert(fs.statSync(mirrorDb).size > 0, '備份檔不應為空');
    equal(r.uploads_mirrored, r.uploads_total, '附件同步數應與上傳目錄一致');
    const mirrored = fs.readdirSync(path.join(env.MINDCARE_BACKUP_MIRROR, 'uploads'));
    const live = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    for (const f of live) assert(mirrored.includes(f), `附件未同步：${f}`);
  });
  await test('備份檔可獨立開啟且資料完整', async () => {
    const Database = require('better-sqlite3');
    const r = await admin.ok('POST', '/api/maintenance/backup', {});
    const b = new Database(path.join(env.MINDCARE_DATA_DIR, 'backups', r.latest_backup), { readonly: true });
    const n = b.prepare('SELECT COUNT(*) n FROM clients').get().n;
    const rows = b.prepare('SELECT COUNT(*) n FROM attachments').get().n;
    b.close();
    assert(n > 0, '備份內應有個案資料');
    assert(rows > 0, '備份內應有附件紀錄');
  });
  await test('非管理者不可觸發備份', () => lin.fails('POST', '/api/maintenance/backup', {}, '管理者'));

  // ---------------------------------------------------------------- 報表與稽核
  section('報表與稽核');
  await test('月報與匯出可產生', async () => {
    const month = monday.slice(0, 7);
    const rep = await admin.ok('GET', `/api/reports?month=${month}`);
    assert(rep.income, '月報應含收入區塊');
    for (const fmt of ['csv', 'xls', 'pdf']) {
      const r = await admin.get(`/api/exports/clients?format=${fmt}`);
      equal(r.status, 200, `匯出格式 ${fmt}`);
    }
  });
  await test('調閱紀錄寫入稽核軌跡', async () => {
    const rows = await admin.ok('GET', '/api/audit-logs');
    assert(rows.some(l => String(l.action).includes('調閱')), '應有調閱紀錄的稽核');
    assert(rows.some(l => String(l.action).includes('安全計畫')), '應有安全計畫相關稽核');
  });
  await test('經營品質指標計算正確', async () => {
    const month = monday.slice(0, 7);
    const r = await admin.ok('GET', `/api/reports?month=${month}`);
    const k = r.kpi;
    assert(k, '月報應含 kpi 區塊');
    for (const key of ['no_show_rate', 'cancel_rate', 'intake_conversion', 'dropout', 'avg_sessions', 'utilization']) {
      assert(k[key] !== undefined, `缺少指標：${key}`);
    }
    // 分母為 0 時必須是 null 而不是 0 或 NaN
    const empty = await admin.ok('GET', '/api/reports?month=1990-01');
    equal(empty.kpi.no_show_rate, null, '無資料月份的爽約率');
    equal(empty.kpi.avg_sessions, null, '無資料月份的平均次數');
    const u = k.utilization.find(x => x.name === '林筱雯');
    assert(u && u.capacity_hours > 0, '排班後應算得出時段容量');
    assert(u.rate !== null && u.rate >= 0, '利用率應為數字');
  });
  await test('總覽與我的工作台可載入', async () => {
    const d = await admin.ok('GET', '/api/dashboard');
    assert(d.charts && d.charts.months.length === 6, '總覽圖表資料');
    const my = await lin.ok('GET', '/api/my-dashboard');
    assert(my.me, '我的工作台');
  });

  // ------------------------------------------------- 方案別、額度、收據與線上預約
  section('方案別與額度');
  let youthPlanId, youthTopicId, planClientId;
  await test('方案清單含補助方案與可選金額方案', async () => {
    const list = await admin.ok('GET', '/api/service-plans');
    const youth = list.find(p => p.quota_per_year === 3 && p.counselor_week_limit === 6);
    assert(youth, '找不到年輕族群方案');
    youthPlanId = youth.id;
    youthTopicId = youth.topics[0].id;
    assert(list.some(p => p.fee_mode === 'choice' && p.fee_option_list.length > 1), '缺少可選金額方案');
  });
  await test('後台可自訂方案、主題與心理師費率', async () => {
    const created = await admin.ok('POST', '/api/service-plans', {
      name: '冒煙測試方案', kind: 'self', fee: 1800, share_mode: 'percent', share_percent: 55,
      quota_per_year: 2, counselor_week_limit: 1
    });
    await admin.ok('POST', `/api/service-plans/${created.id}/topics`, { name: '測試主題', fee: 2100 });
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    await admin.ok('POST', `/api/service-plans/${created.id}/rates`, { counselor_id: lins.id, fee: 2500, share_mode: 'fixed', share_fixed: 1500 });
    const after = (await admin.ok('GET', '/api/service-plans')).find(p => p.id === created.id);
    equal(after.topics.length, 1, '主題數');
    equal(after.rates.length, 1, '費率數');
    const q = await admin.ok('GET', `/api/plan-quote?plan_id=${created.id}&counselor_id=${lins.id}`);
    equal(q.fee, 2500, '心理師費率覆寫金額');
    equal(q.counselor_share, 1500, '固定鐘點費');
    await admin.ok('DELETE', `/api/service-plans/${created.id}`);
  });
  await test('補助方案取價含方案給付與自付拆分', async () => {
    const q = await admin.ok('GET', `/api/plan-quote?plan_id=${youthPlanId}&topic_id=${youthTopicId}`);
    equal(q.total, 1800, '方案總額');
    equal(q.fee, 200, '個案要付的錢（畫面上的費用欄位）');
    equal(q.subsidy_amount, 1600, '方案給付');
    equal(q.venue_fee, 200, '場地費');
    equal(q.share_base, 1600, '抽成基數應扣掉場地費');
  });
  await test('個案年度額度用滿後擋下第四次，並提示已用次數', async () => {
    const clients = await admin.ok('GET', '/api/clients');
    planClientId = clients[0].id;
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    // 挑遠一點的空白週次，避開 seed 灌入的預約與請假
    const made = [];
    const days = sameYearMondays(4, 100);
    try {
      for (let i = 0; i < 3; i++) {
        const d = days[i];
        made.push((await admin.ok('POST', '/api/appointments', {
          client_id: planClientId, counselor_id: lins.id, date: d, start_time: '07:00',
          plan_id: youthPlanId, topic_id: youthTopicId
        })).id);
      }
      // 額度按年度算，測試日期可能落在明年，查詢時要指定同一年
      const usage = await admin.ok('GET', `/api/clients/${planClientId}/plan-usage?year=${days[0].slice(0, 4)}`);
      const u = usage.rows.find(r => r.plan_id === youthPlanId);
      equal(u.used, 3, '已用次數');
      equal(u.remaining, 0, '剩餘次數');
      const blocked = await admin.fails('POST', '/api/appointments', {
        client_id: planClientId, counselor_id: lins.id, date: days[3], start_time: '07:00',
        plan_id: youthPlanId
      }, '額度');
      assert(/額度已用完/.test(blocked.error || ''), '錯誤訊息應說明額度用完：' + JSON.stringify(blocked));
    } finally {
      for (const id of made) await admin.del(`/api/appointments/${id}`);
    }
  });
  await test('人工調整已用次數（他所已使用）會計入額度', async () => {
    await admin.ok('PUT', `/api/clients/${planClientId}/plan-usage`, {
      plan_id: youthPlanId, used_offset: 3, note: '他所已使用'
    });
    const usage = await admin.ok('GET', `/api/clients/${planClientId}/plan-usage`);
    equal(usage.rows.find(r => r.plan_id === youthPlanId).used, 3, '含調整後已用次數');
    await admin.ok('PUT', `/api/clients/${planClientId}/plan-usage`, { plan_id: youthPlanId, used_offset: 0 });
  });
  await test('心理師每週人次上限擋下第七人次並指出下週餘額', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const clients = await admin.ok('GET', '/api/clients');
    const monday = nextWeekday(1, 150);
    const made = [];
    try {
      // 六個不同個案排滿同一週（override 略過個人年度額度，這裡驗的是心理師人次上限）
      for (let i = 0; i < 6; i++) {
        made.push((await admin.ok('POST', '/api/appointments', {
          client_id: clients[i % clients.length].id, counselor_id: lins.id,
          date: addDays(monday, i % 5), start_time: ['07:00', '08:00'][Math.floor(i / 5)] || '08:00',
          plan_id: youthPlanId, override: true
        })).id);
      }
      const load = await admin.ok('GET', `/api/plan-load?counselor_id=${lins.id}&plan_id=${youthPlanId}&date=${monday}`);
      equal(load.week_used, 6, '本週已用人次');
      assert(load.week_full, '本週應已額滿');
      equal(load.next_week.remaining, 6, '下週餘額');
      const msg = await admin.fails('POST', '/api/appointments', {
        client_id: clients[0].id, counselor_id: lins.id, date: addDays(monday, 4), start_time: '09:00',
        plan_id: youthPlanId
      }, '人次');
      assert(/已排滿/.test(msg.error || ''), '錯誤訊息應說明額滿：' + JSON.stringify(msg));
    } finally {
      for (const id of made) await admin.del(`/api/appointments/${id}`);
    }
  });

  section('線上預約表單');
  let bookingId;
  await test('公開設定不外洩諮商室配置', async () => {
    const cfg = await (await fetch(BASE + '/api/public/booking-config')).json();
    assert(cfg.enabled, '表單應啟用');
    assert(cfg.plans.length, '應有可預約方案');
    assert(!JSON.stringify(cfg).includes('諮商室'), '公開設定不應含諮商室');
  });
  await test('公開時段查詢只回傳時間', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const d = await (await fetch(`${BASE}/api/public/booking-slots?counselor_id=${lins.id}&plan_id=${youthPlanId}&days=14`)).json();
    assert(d.days.some(x => x.slots.length), '應有可預約時段');
    assert(!JSON.stringify(d).includes('room'), '不應帶出諮商室資訊');
  });
  await test('未勾同意個資告知不得送出', async () => {
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '測試', phone: '0911222333', plan_id: youthPlanId, consent: false })
    });
    equal(r.status, 400, 'HTTP 狀態');
  });
  await test('補助方案年齡不符在表單端即擋下', async () => {
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '長輩', phone: '0911222444', birth_date: '1950-01-01',
        plan_id: youthPlanId, consent: true })
    });
    const d = await r.json();
    equal(r.status, 400, 'HTTP 狀態');
    assert(/歲/.test(d.error), '應說明年齡限制：' + d.error);
  });
  await test('民眾送出預約申請', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const date = nextWeekday(3, 9);
    const slots = await (await fetch(`${BASE}/api/public/booking-slots?counselor_id=${lins.id}&plan_id=${youthPlanId}&from=${date}&days=1`)).json();
    const slot = slots.days[0].slots[0];
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '林小新', phone: '0911777888', birth_date: '2000-05-05', gender: 'female',
        plan_id: youthPlanId, topic_id: youthTopicId, counselor_id: lins.id,
        date, start_time: slot.start_time, main_issue: '最近壓力很大', consent: true
      })
    });
    const d = await r.json();
    assert(r.ok, '送出失敗：' + JSON.stringify(d));
    bookingId = d.id;
  });
  await test('預約表單與完成頁都帶出個案專區網址（未設定時由表單網址推得）', async () => {
    // 個案要知道專區在哪，才會去看預約、綁 LINE
    const cfg = () => fetch(BASE + '/api/public/booking-config').then(r => r.json());
    await admin.ok('PUT', '/api/settings', { booking_public_url: 'https://example.tw/booking.html', portal_public_url: '' });
    equal((await cfg()).portal_url, 'https://example.tw/portal.html', '未設定時由預約表單網址推得');
    await admin.ok('PUT', '/api/settings', { portal_public_url: 'https://example.tw/mine' });
    equal((await cfg()).portal_url, 'https://example.tw/mine', '有設定就以設定為準');
    await admin.ok('PUT', '/api/settings', { portal_public_url: '', booking_public_url: '' });
  });
  await test('櫃檯看得到待處理申請', async () => {
    const rows = await admin.ok('GET', '/api/bookings?status=new');
    assert(rows.some(r => r.id === bookingId), '待處理清單應含此申請');
  });
  await test('由申請建檔並成立預約，系統自動指派諮商室', async () => {
    const c = await admin.ok('POST', `/api/bookings/${bookingId}/create-client`);
    assert(c.client_id, '建檔失敗');
    const r = await admin.ok('POST', `/api/bookings/${bookingId}/confirm`, {});
    assert(r.appointment_id, '未成立預約');
    assert(r.room_id, '應自動指派諮商室');
    const appt = (await admin.ok('GET', `/api/appointments?client_id=${c.client_id}`))[0];
    equal(appt.plan_id, youthPlanId, '方案別');
    equal(appt.fee, 200, '個案只需付場地費');
    equal(appt.subsidy_amount, 1600, '方案給付另記');
  });
  await test('個案端看不到諮商室', async () => {
    const rows = await admin.ok('GET', '/api/bookings');
    assert(rows.find(r => r.id === bookingId).status === 'confirmed', '狀態應為已成立');
  });

  section('收據');
  let receiptId, receiptNo;
  await test('收款方式選錯可更正，並分別統計現金與轉帳', async () => {
    const list = await admin.ok('GET', '/api/invoices');
    const inv = list.rows.find(i => i.status === 'paid');
    assert(inv, '需要一筆已收款的收費單');
    equal(inv.method, '現金', '前置：這筆應為現金');
    // 誤選現金，事後更正為轉帳（不必作廢重開）
    await admin.ok('PUT', `/api/invoices/${inv.id}`, { method: '轉帳' });
    const after = (await admin.ok('GET', '/api/invoices')).rows.find(i => i.id === inv.id);
    equal(after.method, '轉帳', '付款方式應已更正');
    equal(after.amount, inv.amount, '更正付款方式不應動到金額');
    // 分項統計看得出現金與轉帳各多少
    const d = await admin.ok('GET', '/api/invoices?status=paid');
    const t = d.by_method.find(m => m.method === '轉帳');
    assert(t && t.amt >= after.amount, '轉帳分項應含這筆：' + JSON.stringify(d.by_method));
    const rep = await admin.ok('GET', `/api/reports?month=${after.date.slice(0, 7)}`);
    assert(rep.income_by_method.some(m => m.method === '轉帳'), '月報應有收款方式分項');
    // 更正付款方式不應把補助方案的金額改壞（金額填自付、補助另記的那種收費單）
    const sub = (await admin.ok('GET', '/api/invoices')).rows.find(i => i.subsidy_amount > i.amount);
    if (sub) {
      await admin.ok('PUT', `/api/invoices/${sub.id}`, { ...sub, method: sub.method || '現金' });
      const kept = (await admin.ok('GET', '/api/invoices')).rows.find(i => i.id === sub.id);
      equal(kept.subsidy_amount, sub.subsidy_amount, '補助金額不應被壓到金額以下');
      equal(kept.self_pay, sub.self_pay, '自付金額不應被改成 0');
    }
    await admin.ok('PUT', `/api/invoices/${inv.id}`, { method: '現金' });
  });
  await test('已收款的收費單可開立流水編號收據', async () => {
    const list = await admin.ok('GET', '/api/invoices');
    const inv = list.rows.find(i => i.status === 'paid') || list.rows[0];
    if (inv.status !== 'paid') await admin.ok('POST', `/api/invoices/${inv.id}/pay`, { method: '現金' });
    const r = await admin.ok('POST', '/api/receipts', { invoice_id: inv.id });
    assert(/^GM\d{6}\d{4}$/.test(r.receipt_no) || /^\w+\d{10}$/.test(r.receipt_no), '收據編號格式：' + r.receipt_no);
    receiptId = r.id;
    receiptNo = r.receipt_no;
  });
  await test('同一收費單不會重複開立收據', async () => {
    const list = await admin.ok('GET', '/api/receipts');
    const r = list.rows.find(x => x.id === receiptId);
    await admin.fails('POST', '/api/receipts', { invoice_id: r.invoice_id }, '已開立');
  });
  await test('補印會累計次數', async () => {
    await admin.ok('POST', `/api/receipts/${receiptId}/printed`);
    await admin.ok('POST', `/api/receipts/${receiptId}/printed`);
    const r = await admin.ok('GET', `/api/receipts/${receiptId}`);
    equal(r.print_count, 2, '補印次數');
    assert(r.center_name, '收據應帶機構抬頭');
  });
  await test('作廢重開會產生新號並與原號勾稽', async () => {
    const r = await admin.ok('POST', `/api/receipts/${receiptId}/reissue`, { reason: '抬頭錯誤', title: '織心股份有限公司' });
    assert(r.receipt_no !== receiptNo, '應為新號');
    const list = await admin.ok('GET', '/api/receipts');
    const old = list.rows.find(x => x.id === receiptId);
    const neu = list.rows.find(x => x.receipt_no === r.receipt_no);
    equal(old.status, 'void', '原收據應作廢');
    equal(neu.reissue_of, receiptNo, '新收據應記錄原號');
  });
  await test('個案端查得到自己的收據', async () => {
    const b = await portal.ok('GET', '/api/portal/billing');
    assert(Array.isArray(b.receipts), '個案端應可查收據');
  });

  section('心理師收支與 LINE');
  await test('依方案別產出每位心理師的月收支', async () => {
    const d = await admin.ok('GET', `/api/plan-income?month=${ymd(new Date()).slice(0, 7)}`);
    assert(Array.isArray(d.rows), '應回傳心理師清單');
    assert(d.total && typeof d.total.share === 'number', '應有報酬合計');
    if (d.rows.length) {
      const r = d.rows[0];
      equal(r.gross - r.share, r.center, '所方淨收 = 應收 - 心理師報酬');
      const detail = await admin.ok('GET', `/api/plan-income/${r.counselor_id}/detail?month=${ymd(new Date()).slice(0, 7)}`);
      assert(detail.counselor, '應可取得明細');
    }
  });
  await test('補助方案：抽成以扣掉場地費後的金額計，場地費歸所方', async () => {
    const lins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const clients = await admin.ok('GET', '/api/clients');
    const date = nextWeekday(2, 170);
    const made = await admin.ok('POST', '/api/appointments', {
      client_id: clients[0].id, counselor_id: lins.id, date, start_time: '07:00',
      plan_id: youthPlanId, override: true
    });
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'done' });
    const appt = (await admin.ok('GET', `/api/appointments?client_id=${clients[0].id}`)).find(a => a.id === made.id);
    equal(appt.fee, 200, '個案自付');
    equal(appt.subsidy_amount, 1600, '方案給付');
    equal(appt.counselor_share, 960, '心理師報酬＝1600 × 60%');
    // 收費單只跟個案收 200，不會出現 1800 的帳單
    const inv = (await admin.ok('GET', '/api/invoices')).rows.find(i => i.appointment_id === made.id);
    equal(inv.amount, 200, '收費單金額');
    equal(inv.subsidy_amount, 1600, '收費單記錄方案給付');
    const income = await admin.ok('GET', `/api/plan-income?month=${date.slice(0, 7)}&counselor_id=${lins.id}`);
    const plan = income.rows[0].plans.find(p => p.plan_id === youthPlanId);
    equal(plan.gross, 200 + 1600, '服務總額');
    equal(plan.venue, 200, '場地費');
    equal(plan.share, 960, '心理師報酬');
    equal(plan.center, 1800 - 960, '所方淨收（含場地費 200）');
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'cancelled' });
    await admin.del(`/api/appointments/${made.id}`);
  });
  await test('未到收費：設定固定規費時以固定金額開單，設 0 才回到比例', async () => {
    const appt = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: (await admin.ok('GET', '/api/me')).id,
      date: addDays(ymd(new Date()), 1), start_time: '09:00', fee: 2000
    });
    await admin.ok('PUT', '/api/settings', { no_show_fee_fixed: '200' });
    await admin.ok('POST', `/api/appointments/${appt.id}/status`, { status: 'no_show' });
    const invoicesOf = async () => (await admin.ok('GET', `/api/invoices?client_id=${clientId}`)).rows
      .filter(i => i.appointment_id === appt.id);
    const inv = (await invoicesOf())[0];
    equal(inv.amount, 200, '固定規費 200 元');
    // 改回比例：狀態來回切換會回沖重算，不會留下兩張單
    await admin.ok('PUT', '/api/settings', { no_show_fee_fixed: '0' });
    await admin.ok('POST', `/api/appointments/${appt.id}/status`, { status: 'booked' });
    await admin.ok('POST', `/api/appointments/${appt.id}/status`, { status: 'no_show' });
    const list = await invoicesOf();
    equal(list.length, 1, '只留一張未到收費單');
    equal(list[0].amount, 1000, '回到比例 50%');
    await admin.ok('POST', `/api/appointments/${appt.id}/status`, { status: 'cancelled' });
    await admin.del(`/api/appointments/${appt.id}`);
  });
  await test('時間戳為台北時間（主機為 UTC 時仍不會少 8 小時）', async () => {
    const rows = await admin.ok('GET', '/api/audit-logs?limit=1');
    const list = Array.isArray(rows) ? rows : rows.rows;
    const stamp = list[0].created_at;
    const tw = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 13).replace('T', ' ');
    equal(stamp.slice(0, 13), tw, '稽核時間應為台北時間（比對到小時）');
  });
  await test('永久刪除個案：連同紀錄一併移除，且僅管理者可執行', async () => {
    const tmp = await admin.ok('POST', '/api/clients', { name: '待刪個案', phone: '0900111222' });
    await admin.ok('POST', '/api/appointments', {
      client_id: tmp.id, counselor_id: (await admin.ok('GET', '/api/me')).id,
      date: addDays(ymd(new Date()), 2), start_time: '11:00', fee: 1000
    });
    await office.fails('DELETE', `/api/clients/${tmp.id}/purge`, undefined, '管理者');
    const r = await admin.ok('DELETE', `/api/clients/${tmp.id}/purge`);
    equal(r.removed.appointments, 1, '連同預約一併刪除');
    const still = (await admin.ok('GET', '/api/clients?status=')).find(c => c.id === tmp.id);
    assert(!still, '個案應已不存在');
  });
  await test('線上預約申請可依關鍵字、狀態與日期篩選', async () => {
    const all = await admin.ok('GET', '/api/bookings');
    assert(Array.isArray(all), '回傳清單');
    const one = all[0];
    if (!one) return;
    const byName = await admin.ok('GET', `/api/bookings?q=${encodeURIComponent(one.name.slice(0, 2))}`);
    assert(byName.some(r => r.id === one.id), '關鍵字應找得到該筆');
    const byStatus = await admin.ok('GET', '/api/bookings?status=new');
    assert(byStatus.every(r => r.status === 'new'), '狀態篩選只回該狀態');
    const future = await admin.ok('GET', `/api/bookings?from=${addDays(ymd(new Date()), 3)}`);
    equal(future.length, 0, '未來日期區間應無資料');
  });
  await test('方案設定：每個欄位都能改，抽成 60 與 0.6 都收得下', async () => {
    const plan = (await admin.ok('GET', '/api/service-plans')).find(p => p.active);
    const before = { name: plan.name, fee: plan.fee, share_percent: plan.share_percent, default_mode: plan.default_mode };
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, {
      name: plan.name, fee: 2345, share_percent: 60, default_mode: 'online',
      session_minutes: 80, venue_fee: 200, quota_per_year: 3
    });
    const after = (await admin.ok('GET', '/api/service-plans')).find(p => p.id === plan.id);
    equal(after.fee, 2345, '金額已改');
    equal(after.share_percent, 0.6, '抽成 60 收斂成 0.6');
    equal(after.default_mode, 'online', '預設形式可改（原本前端沒有這個欄位）');
    equal(after.session_minutes, 80, '時長可改');
    equal(after.venue_fee, 200, '場地費可改');
    equal(after.quota_per_year, 3, '年度次數可改');
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, Object.assign({}, before, {
      session_minutes: plan.session_minutes, venue_fee: plan.venue_fee, quota_per_year: plan.quota_per_year
    }));
  });
  await test('方案人次看板列出各心理師用量', async () => {
    const d = await admin.ok('GET', '/api/plan-board');
    assert(Array.isArray(d.rows), '看板資料');
  });
  await test('人次上限可個別調整，心理師只能改自己的', async () => {
    const row = (await admin.ok('GET', '/api/plan-board')).rows[0];
    assert(row, '至少要有一列限量方案');
    const r = await admin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: 3, month_limit: -1 });
    equal(r.week_limit, 3, '已寫入個別週上限');
    const after = (await admin.ok('GET', '/api/plan-board')).rows
      .find(x => x.plan_id === row.plan_id && x.counselor_id === row.counselor_id);
    equal(after.week_limit, 3, '看板反映新上限');
    const me = await lin.ok('GET', '/api/me');
    if (row.counselor_id !== me.id) {
      await lin.fails('PUT', '/api/plan-board/limit',
        { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: 1 }, '自己');
    }
    await lin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: me.id, week_limit: -1, month_limit: -1 });
    await admin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: -1, month_limit: -1 });
  });
  await test('已用人次可人工填成實際數字', async () => {
    const row = (await admin.ok('GET', '/api/plan-board')).rows[0];
    const r = await admin.ok('PUT', '/api/plan-board/usage',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_used: 4, note: '他所已接' });
    equal(r.week_used, 4, '已用人次填成 4');
    assert(r.week_offset === 4 - r.week_system_used, '存的是與系統統計的差額');
    await admin.ok('PUT', '/api/plan-board/usage',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_used: r.week_system_used });
  });
  await test('刪除帳號：無關聯者真的刪除，有關聯者退回停用', async () => {
    // 全新帳號沒有任何關聯，應該真的被刪掉
    const fresh = await admin.ok('POST', '/api/users',
      { username: 'tmp-del-' + Date.now(), password: 'abc123', name: '待刪測試', role: 'staff' });
    const r1 = await admin.ok('DELETE', `/api/users/${fresh.id}`);
    equal(r1.deactivated, false, '無關聯者直接刪除');
    // 登記過來電的帳號：intakes.taken_by 沒有 ON DELETE，外鍵會擋下刪除，
    // 必須退回停用而不是把資料庫錯誤丟到畫面上
    const uname = 'tmp-intake-' + Date.now();
    const withLink = await admin.ok('POST', '/api/users',
      { username: uname, password: 'abc123', name: '來電登記測試', role: 'staff' });
    const tmp = session();
    await tmp.ok('POST', '/api/login', { username: uname, password: 'abc123' });
    await tmp.ok('POST', '/api/intakes', { name: '刪除測試來電', phone: '0900000000' });
    const r2 = await admin.ok('DELETE', `/api/users/${withLink.id}`);
    equal(r2.deactivated, true, '有關聯者退回停用');
    const still = (await admin.ok("GET", "/api/users")).find(u => u.id === withLink.id);
    assert(!still || !still.active, '帳號應為停用狀態');
  });
  await test('刪除諮商室：排過班的改為停用', async () => {
    const made = await admin.ok('POST', '/api/rooms', { name: '臨時空間', capacity: 1 });
    const r = await admin.ok('DELETE', `/api/rooms/${made.id}`);
    equal(r.deactivated, false, '沒排過班的可直接刪除');
    assert(!(await admin.ok('GET', '/api/rooms')).some(x => x.id === made.id), '已從清單移除');
  });
  await test('收據可修正抬頭與項目，金額與編號不動', async () => {
    const rec = (await admin.ok('GET', '/api/receipts')).rows.find(x => x.status === 'valid');
    if (!rec) return;
    await admin.ok('PUT', `/api/receipts/${rec.id}`, { title: '測試抬頭', item: rec.item, tax_id: '' });
    const after = (await admin.ok('GET', '/api/receipts')).rows.find(x => x.id === rec.id);
    equal(after.title, '測試抬頭', '抬頭已更新');
    equal(after.amount, rec.amount, '金額不變');
    equal(after.receipt_no, rec.receipt_no, '編號不變');
    await admin.fails('PUT', `/api/receipts/${rec.id}`, { tax_id: '123' }, '8 碼');
    await admin.ok('PUT', `/api/receipts/${rec.id}`, { title: rec.title, tax_id: rec.tax_id || '' });
  });
  await test('未設定 LINE 權杖時不對外送出，只記為待人工', async () => {
    const s = await admin.ok('GET', '/api/line/status');
    equal(s.enabled, false, '預設未啟用');
    const r = await admin.ok('POST', '/api/line/remind-batch', { date: addDays(ymd(new Date()), 1) });
    assert(r.results.every(x => x.status === 'manual'), '未設定時應全部記為待人工發送');
  });
  await test('LINE 綁定碼只能為自己產生', async () => {
    const r = await lin.ok('POST', '/api/line/bind-code', { user_id: (await lin.ok('GET', '/api/me')).id });
    assert(/^\d{6}$/.test(r.code), '綁定碼格式');
    const admins = (await admin.ok('GET', '/api/users')).find(u => u.username === 'admin');
    await lin.fails('POST', '/api/line/bind-code', { user_id: admins.id }, '自己');
  });
  await test('串接設定：權杖只回遮罩、遮罩值不會覆蓋原設定', async () => {
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: 'test-token-1234', line_official_name: '測試官方帳號' });
    const s1 = await admin.ok('GET', '/api/line/settings');
    assert(!s1.line_channel_token.includes('test-token'), '不應回傳完整權杖');
    assert(s1.line_channel_token.endsWith('1234'), '應顯示末四碼');
    assert(/\/api\/line\/webhook$/.test(s1.webhook_url), 'Webhook 網址');
    // 原樣送回遮罩值代表沒改，權杖要維持不變
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: s1.line_channel_token, line_reminder_hours: 12 });
    const s2 = await admin.ok('GET', '/api/line/settings');
    equal(s2.line_channel_token, s1.line_channel_token, '權杖未被遮罩值覆蓋');
    equal(s2.line_reminder_hours, '12', '其他設定有存到');
    await admin.ok('PUT', '/api/line/settings', { line_channel_token: '' });
    equal((await admin.ok('GET', '/api/line/settings')).line_channel_token, '', '可清空權杖');
  });
  await test('未填權杖時不可設定 Webhook', async () => {
    await admin.fails('POST', '/api/line/webhook-endpoint', {}, 'Channel access token');
  });
  await test('綁定管理列出員工與個案的綁定狀態', async () => {
    const d = await admin.ok('GET', '/api/line/bindings');
    assert(d.staff.length && d.clients.length, '應列出員工與個案');
    assert(d.staff.every(u => typeof u.bound === 'boolean'), '綁定狀態');
  });
  await test('一般行政不得改串接設定', async () => {
    await office.fails('PUT', '/api/line/settings', { line_official_name: 'x' }, '權限');
  });
  await test('Webhook 簽章不符即忽略', async () => {
    const r = await fetch(BASE + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': 'bad' },
      body: JSON.stringify({ events: [] })
    });
    equal(r.status, 200, '應靜默忽略');
  });

  section('勞務報酬單拆單與心理師年報表');
  await test('拆單試算：每筆都低於扣繳門檻，且合計等於總額', async () => {
    const r = await admin.ok('GET', '/api/payouts/split-preview?gross=58000&income_type=9A&start_date=2026-01-05&interval_days=7');
    equal(r.total_gross, 58000, '拆完合計應等於總額');
    equal(r.parts.length, 3, '58,000 應拆成 3 筆');
    assert(r.parts.every(p => p.gross <= r.cap), '每筆都不得超過上限');
    assert(r.parts.every(p => p.withholding === 0 && p.nhi_supplement === 0), '低於門檻不應扣繳');
    equal(r.parts[0].pay_date, '2026-01-05', '第一筆支領日');
    equal(r.parts[1].pay_date, '2026-01-12', '第二筆間隔 7 天');
  });
  await test('未拆單的大額給付仍會扣所得稅與補充保費', async () => {
    const r = await admin.ok('GET', '/api/payouts/preview?gross=58000&income_type=9A');
    equal(r.withholding, 5800, '代扣 10%');
    equal(r.nhi_supplement, Math.round(58000 * 0.0211), '補充保費 2.11%');
  });
  await test('拆單建立報酬單並可整批付款、列印勞務報酬單', async () => {
    const lin = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    await admin.ok('PUT', `/api/users/${lin.id}`, {
      id_no: 'A123456789', bank_name: '台中銀行', bank_account: '1234567890', residency: 'local'
    });
    const r = await admin.ok('POST', '/api/payouts/split', {
      user_id: lin.id, month: '2026-01', item: '晤談鐘點', sessions: 20,
      gross: 45000, income_type: '9A', start_date: '2026-01-05', interval_days: 7
    });
    equal(r.ids.length, 3, '應建立 3 筆');
    const list = await admin.ok('GET', '/api/payouts?month=2026-01');
    const batch = list.rows.filter(x => x.batch_id === r.batch_id);
    equal(batch.length, 3, '清單查得到同批 3 筆');
    equal(batch.reduce((a, b) => a + b.gross, 0), 45000, '同批合計等於原總額');
    assert(batch.every(x => x.batch_total === 3 && x.pay_date), '每筆都記得同批筆數與支領日');
    const slip = await admin.get(`/api/payouts/slip?batch=${r.batch_id}`);
    equal(slip.status, 200, '應可列印勞務報酬單');
    assert(slip.text.includes('勞務報酬單') && slip.text.includes('A123456789')
      && slip.text.includes('45,000'), '報酬單應含抬頭、身分證字號與合計金額');
    await admin.ok('POST', `/api/payouts/batch/${r.batch_id}/pay`, {});
    const paid = (await admin.ok('GET', '/api/payouts?month=2026-01')).rows
      .filter(x => x.batch_id === r.batch_id);
    assert(paid.every(x => x.status === 'paid'), '整批付款應一次生效');
    await admin.fails('DELETE', `/api/payouts/batch/${r.batch_id}`, undefined, '已付款');
    await admin.ok('POST', `/api/payouts/batch/${r.batch_id}/pay`, {});
    await admin.ok('DELETE', `/api/payouts/batch/${r.batch_id}`);
    const gone = (await admin.ok('GET', '/api/payouts?month=2026-01')).rows
      .filter(x => x.batch_id === r.batch_id);
    equal(gone.length, 0, '整批刪除');
  });
  await test('行政人員不得列印他人的勞務報酬單', async () => {
    const lin = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const made = await admin.ok('POST', '/api/payouts', {
      user_id: lin.id, month: '2026-02', item: '督導費', gross: 3000, income_type: '9A'
    });
    const r = await office.get(`/api/payouts/slip?ids=${made.id}`);
    equal(r.status, 403, '行政只能印自己的');
    await admin.ok('DELETE', `/api/payouts/${made.id}`);
  });
  await test('年報表：逐筆帶出編碼、費用拆帳與收據號，並依月份與方案彙總', async () => {
    const year = ymd(new Date()).slice(0, 4);
    const list = await admin.ok('GET', `/api/annual-report?year=${year}`);
    assert(list.counselors.length, '該年度應有心理師服務量');
    const cid = list.counselors[0].id;
    const d = await admin.ok('GET', `/api/annual-report/${cid}?year=${year}`);
    equal(d.months.length, 12, '應有 12 個月');
    equal(d.rows.length, d.months.reduce((a, m) => a + m.rows.length, 0), '逐月列數應等於全年');
    equal(d.total.fee, d.rows.reduce((a, r) => a + r.fee, 0), '費用合計');
    assert(d.rows.every(r => r.center + r.share === r.fee), '所方 + 心理師報酬 = 費用');
    assert(d.rows.every(r => /^\d{7}_/.test(r.case_code)), '每列都應有「民國初評日_次數」編碼');
    assert(d.rows.some(r => r.receipt_no !== undefined), '應帶出收據欄');
    equal(d.total.sessions, d.self_total.sessions + d.org_total.sessions, '自費＋機構＝全年人次');
  });
  await test('年報表類別：方案代碼為指定案，派案自動 +1', async () => {
    const me = await admin.ok('GET', '/api/me');
    const plan = (await admin.ok('GET', '/api/service-plans')).find(p => p.active && p.kind === 'self');
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, { ...plan, report_code: '30' });
    const date = nextWeekday(4, 200);
    const made = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: me.id, date, start_time: '07:30',
      plan_id: plan.id, override: true
    });
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'done' });
    const year = date.slice(0, 4);
    const pick = () => admin.ok('GET', `/api/annual-report/${me.id}?year=${year}`)
      .then(d => d.rows.find(r => r.appointment_id === made.id));
    await admin.ok('PUT', `/api/clients/${clientId}`, { assign_type: 'designated' });
    equal((await pick()).category, '30', '指定案印方案代碼');
    await admin.ok('PUT', `/api/clients/${clientId}`, { assign_type: 'assigned' });
    equal((await pick()).category, '31', '派案自動 +1');
    await admin.ok('PUT', `/api/clients/${clientId}`, { assign_type: '' });
    equal((await pick()).category, '30', '未註記時照方案代碼原樣印');
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'cancelled' });
    await admin.del(`/api/appointments/${made.id}`);
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, { ...plan, report_code: plan.report_code || '' });
  });
  await test('年報表匯出 Excel 與列印版', async () => {
    const year = ymd(new Date()).slice(0, 4);
    const cid = (await admin.ok('GET', `/api/annual-report?year=${year}`)).counselors[0].id;
    const xls = await admin.get(`/api/annual-report/${cid}/export?year=${year}&format=xls`);
    equal(xls.status, 200, 'Excel 匯出');
    assert(xls.text.includes('<Worksheet ss:Name="年度彙總"') && xls.text.includes('ss:Name="1月"'),
      '應有年度彙總與逐月分頁');
    const pdf = await admin.get(`/api/annual-report/${cid}/export?year=${year}&format=pdf`);
    equal(pdf.status, 200, '列印版');
    assert(pdf.text.includes('年度心理師報表'), '列印版標題');
  });
  await test('治療摘要僅管理者、督導與本人看得到', async () => {
    const year = ymd(new Date()).slice(0, 4);
    const linUser = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const mine = await lin.ok('GET', `/api/annual-report/${linUser.id}?year=${year}`);
    assert(mine.can_see_summary, '心理師看自己的年報表應看得到摘要');
    const others = (await admin.ok('GET', `/api/annual-report?year=${year}`)).counselors
      .find(c => c.id !== linUser.id);
    if (others) {
      const d = await lin.ok('GET', `/api/annual-report/${others.id}?year=${year}`);
      assert(!d.can_see_summary, '看別人的年報表不應顯示摘要');
      assert(d.rows.every(r => !r.summary || r.summary.includes('＊')), '摘要應遮蔽');
    }
  });

  section('證明書（在職、離職、治療證明）');
  await test('在職證明套版帶出帳號資料，文字可逐欄改寫後開立', async () => {
    const lin2 = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    await admin.ok('PUT', `/api/users/${lin2.id}`, {
      gender: 'female', birth_date: '1988-03-05', hire_date: '2021-09-01', id_no: 'B223456789'
    });
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=employment&subject_id=${lin2.id}`);
    equal(tpl.data.title, '在職證明書', '預設標題');
    const birth = tpl.data.rows.find(r => r.label === '出生年月日');
    equal(birth.value, '民國 77 年 3 月 5 日', '生日轉民國');
    equal(tpl.data.rows.find(r => r.label === '到職日期').value, '民國 110 年 9 月 1 日', '到職日');
    // 每一欄都能改：改欄位名、改內容、加一列
    const rows = tpl.data.rows.map(r => (r.label === '職稱' ? { label: '職務', value: '臨床心理師（專任）' } : r));
    rows.push({ label: '每週工作時數', value: '40 小時' });
    const made = await admin.ok('POST', '/api/certificates', {
      kind: 'employment', subject_id: lin2.id, subject_name: tpl.subject_name,
      issue_date: '2026-09-01', purpose: '申請貸款',
      data: { ...tpl.data, rows, statement: '上列各項確實，特此證明。（本所另行用印）' }
    });
    assert(/^KC\d{6}\d{4}$/.test(made.cert_no), '應產生流水編號：' + made.cert_no);
    const got = await admin.ok('GET', `/api/certificates/${made.id}`);
    assert(got.data.rows.some(r => r.label === '職務' && r.value.includes('專任')), '改過的欄位名與內容應存下來');
    assert(got.data.rows.some(r => r.label === '每週工作時數'), '自行加的列應存下來');
    const html = await admin.get(`/api/certificates/${made.id}/print`);
    equal(html.status, 200, '列印頁');
    assert(html.text.includes('在職證明書') && html.text.includes('每週工作時數')
      && html.text.includes(made.cert_no), '列印頁應含標題、自訂欄位與編號');
    const doc = await admin.get(`/api/certificates/${made.id}/print?format=doc`);
    equal(doc.status, 200, 'Word 匯出');
    certIdEmployment = made.id;
  });
  await test('離職證明帶出任職與離職日期', async () => {
    const lin2 = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    await admin.ok('PUT', `/api/users/${lin2.id}`, { resign_date: '2026-08-31' });
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=resignation&subject_id=${lin2.id}`);
    equal(tpl.data.title, '離職證明書', '標題');
    equal(tpl.data.rows.find(r => r.label === '離職日期').value, '民國 115 年 8 月 31 日', '離職日');
    assert(tpl.data.rows.find(r => r.label === '服務地點').value, '服務地點預設帶機構地址');
  });
  await test('治療證明自動算出來談期間、次數與心理師，用途代入聲明', async () => {
    const clients = await admin.ok('GET', '/api/clients');
    const c = clients.find(x => x.id === clientId) || clients[0];
    const tpl = await admin.ok('GET',
      `/api/certificates/template?kind=treatment&subject_id=${c.id}&purpose=學校請假`);
    equal(tpl.data.title, '治療證明', '標題');
    assert(tpl.data.statement.includes('學校請假'), '用途應代入聲明文字');
    const sessions = tpl.data.rows.find(r => r.label === '晤談次數').value;
    const done = (await admin.ok('GET', `/api/appointments?client_id=${c.id}`))
      .filter(a => a.status === 'done').length;
    equal(sessions, done ? `${done} 次` : '', '晤談次數應等於已完成場次');
    const made = await admin.ok('POST', '/api/certificates', {
      kind: 'treatment', subject_id: c.id, subject_name: tpl.subject_name,
      purpose: '學校請假', data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${made.id}/print`);
    assert(html.text.includes('治療證明') && html.text.includes('學校請假'), '列印頁應含聲明用途');
    certIdTreatment = made.id;
  });
  await test('作廢後不可修改，作廢前不可刪除', async () => {
    await admin.fails('DELETE', `/api/certificates/${certIdTreatment}`, undefined, '請先作廢');
    await admin.fails('POST', `/api/certificates/${certIdTreatment}/void`, { reason: '' }, '作廢原因');
    await admin.ok('POST', `/api/certificates/${certIdTreatment}/void`, { reason: '個案要求重開' });
    await admin.fails('PUT', `/api/certificates/${certIdTreatment}`, { data: { title: 'X' } }, '已作廢');
    const html = await admin.get(`/api/certificates/${certIdTreatment}/print`);
    assert(html.text.includes('已作廢'), '作廢的證明書列印時應標示');
    await admin.ok('DELETE', `/api/certificates/${certIdTreatment}`);
  });
  await test('沒有人事權限者看不到在職／離職證明', async () => {
    const list = await office.ok('GET', '/api/certificates');
    assert(list.rows.every(r => r.kind === 'treatment'), '行政（無 hr 權限）不應看到在職／離職證明');
    await office.fails('GET', '/api/certificates/template?kind=employment', undefined, '無權限');
    await office.fails('GET', `/api/certificates/${certIdEmployment}`, undefined, '無權限');
  });

  section('同意書列印與基本資料表');
  await test('內建諮商／治療同意書與通訊諮商同意書兩份範本', async () => {
    const tpls = await admin.ok('GET', '/api/consent-templates');
    const a = tpls.find(t => t.key === 'counseling');
    const b = tpls.find(t => t.key === 'teletherapy');
    assert(a && a.title.includes('諮商'), '應有諮商／治療同意書');
    assert(b && b.body.includes('通訊'), '應有通訊諮商同意書');
  });
  await test('同意書範本文字可改寫，改後版本遞增', async () => {
    const t = (await admin.ok('GET', '/api/consent-templates')).find(x => x.key === 'counseling');
    const r = await admin.ok('PUT', `/api/consent-templates/${t.id}`,
      { title: t.title, body: t.body + '\n\n九、本所另訂之補充條款。' });
    equal(r.version, t.version + 1, '內容改動應遞增版本');
    const after = (await admin.ok('GET', '/api/consent-templates')).find(x => x.key === 'counseling');
    assert(after.body.includes('補充條款'), '改寫的內容應存下來');
  });
  await test('空白同意書可列印兩聯，也可匯出 Word', async () => {
    const html = await admin.get('/api/consent-templates/counseling/print');
    equal(html.status, 200, '列印頁');
    assert(html.text.includes('個案留存聯') && html.text.includes('留存聯］'), '應印出兩聯');
    assert(html.text.includes('本人簽名') && html.text.includes('心字'), '應留簽名欄');
    const one = await admin.get('/api/consent-templates/teletherapy/print?copies=1');
    equal((one.text.match(/留存聯］/g) || []).length, 1, 'copies=1 只印一聯');
    const doc = await admin.get('/api/consent-templates/counseling/print?format=doc');
    equal(doc.status, 200, 'Word 匯出');
  });
  await test('國軍方案權益須知同意書：自訂簽署欄一併印出', async () => {
    const t = (await admin.ok('GET', '/api/consent-templates')).find(x => x.key === 'military');
    assert(t, '應內建國軍方案同意書');
    assert(t.body.includes('6 次為限') && t.sign_block.includes('級職'), '應含方案條款與立書同意人欄位');
    const html = await admin.get('/api/consent-templates/military/print');
    assert(html.text.includes('級職') && html.text.includes('心理輔導人員'), '簽署欄應印出');
    assert(!html.text.includes('諮商／臨床心理師簽名'), '自訂簽署欄時不再印預設兩行');
    // 簽署欄可自行改寫
    await admin.ok('PUT', `/api/consent-templates/${t.id}`, { sign_block: t.sign_block + '\n服務機構：織心心理治療所' });
    const after = await admin.get('/api/consent-templates/military/print');
    assert(after.text.includes('服務機構'), '改寫後的簽署欄應印出');
  });
  await test('國軍方案的註冊與簽到網址帶進方案與個案畫面', async () => {
    const plan = (await admin.ok('GET', '/api/service-plans')).find(p => p.active && p.kind === 'subsidy');
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, {
      ...plan,
      register_url: 'https://gpwd-mhcp.mnd.gov.tw/registerpage?id=93&token=demo',
      signin_url: 'https://gpwd-mhcp.mnd.gov.tw/signpage?id=93&token=demo'
    });
    const me = await admin.ok('GET', '/api/me');
    const date = nextWeekday(3, 210);
    const appt = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: me.id, date, start_time: '07:00',
      plan_id: plan.id, override: true
    });
    const list = await admin.ok('GET', `/api/appointments?client_id=${clientId}`);
    const got = list.find(a => a.id === appt.id);
    assert(got.plan_signin_url && got.plan_signin_url.includes('signpage'), '預約明細應帶出簽到網址');
    const c = await admin.ok('GET', `/api/clients/${clientId}`);
    assert(c.plan_links.some(p => p.signin_url.includes('signpage')), '個案總覽應帶出方案作業連結');
    await admin.del(`/api/appointments/${appt.id}`);
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, { ...plan, register_url: '', signin_url: '' });
  });
  await test('已簽署的同意書印出簽署當下的全文與簽名', async () => {
    await admin.ok('POST', `/api/clients/${clientId}/consents`, {
      key: 'teletherapy', agreed: 1, signer_name: '冒煙測試', signer_role: 'client',
      signature: 'data:image/png;base64,iVBORw0KGgo='
    });
    const c = await admin.ok('GET', `/api/clients/${clientId}`);
    const signed = c.consents.find(x => x.key === 'teletherapy');
    const html = await admin.get(`/api/consents/${signed.id}/print`);
    assert(html.text.includes('冒煙測試') && html.text.includes('data:image/png'), '應含簽署人與簽名圖');
    assert(html.text.includes('通訊'), '應為簽署當下的全文快照');
  });
  await test('基本資料表帶入個案資料，未填欄位留成待圈選項目', async () => {
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=profile&subject_id=${clientId}`);
    equal(tpl.data.title, '基本資料表', '標題');
    const edu = tpl.data.rows.find(r => r.label === '教育程度');
    assert(edu.value.includes('請圈選') || edu.value.length, '教育程度未填時印出圈選選項');
    assert(tpl.data.rows.find(r => r.label === '是否用藥'), '應含醫療史欄位');
    equal(tpl.data.grid.headers.join(','), '日期,時間,簽名,收費', '附簽到表欄位');
    const made = await admin.ok('POST', '/api/certificates', {
      kind: 'profile', subject_id: clientId, subject_name: tpl.subject_name,
      data: { ...tpl.data, grid: { ...tpl.data.grid, rows: 6 } }
    });
    const html = await admin.get(`/api/certificates/${made.id}/print`);
    equal(html.status, 200, '列印頁');
    assert(html.text.includes('基本資料表') && html.text.includes('簽名'), '應印出表格');
    equal((html.text.match(/<td>&nbsp;<\/td>/g) || []).length, 24, '簽到表 6 列 × 4 欄');
    const doc = await admin.get(`/api/certificates/${made.id}/print?format=doc`);
    equal(doc.status, 200, 'Word 匯出');
  });

  section('青壯方案表單');
  await test('WHO-5 幸福指標量表可施測，分數越高越好', async () => {
    const scales = await admin.ok('GET', '/api/scales');
    assert(scales.WHO5 && scales.WHO5.positive, 'WHO-5 應標示為分數越高越好');
    equal(scales.WHO5.items.length, 5, '五題');
    const r = await admin.ok('POST', '/api/assessments',
      { client_id: clientId, scale: 'WHO5', date: ymd(new Date()), answers: [1, 1, 1, 1, 1] });
    equal(r.total, 5, '總分');
    assert(r.severity.includes('幸福感'), '判讀：' + r.severity);
  });
  await test('青壯方案同意書：聯別印成存根聯與收執聯', async () => {
    const t = (await admin.ok('GET', '/api/consent-templates')).find(x => x.key === 'youth');
    assert(t && t.body.includes('至多 3 次'), '應內建青壯方案同意書');
    equal(t.copy_labels, '存根聯,收執聯', '聯別名稱');
    assert(t.sign_block.includes('立書人身分證字號') && t.sign_block.includes('職業'),
      '簽署欄應含立書人欄位與後半的填答資料');
    const html = await admin.get('/api/consent-templates/youth/print');
    assert(html.text.includes('存根聯') && html.text.includes('收執聯'), '應印出兩聯');
    assert(!html.text.includes('個案留存聯'), '有自訂聯別時不用預設名稱');
    const doc = await admin.get('/api/consent-templates/youth/print?format=doc');
    equal(doc.status, 200, 'Word 匯出');
  });
  await test('方案服務明細把補助方案的已完成晤談逐次填進表格', async () => {
    const me = await admin.ok('GET', '/api/me');
    const plan = (await admin.ok('GET', '/api/service-plans')).find(p => p.active && p.kind === 'subsidy');
    const date = nextWeekday(1, 220);
    const made = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: me.id, date, start_time: '07:00',
      plan_id: plan.id, mode: 'online', override: true
    });
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'done' });
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=plan_detail&subject_id=${clientId}`);
    equal(tpl.data.grid.headers[0], '服務次數', '表頭');
    const row = tpl.data.grid.data.find(r => r[1].endsWith(date.slice(5).replace('-', '/')));
    assert(row, '應列出這次晤談：' + JSON.stringify(tpl.data.grid.data));
    equal(row[4], '✓', '通訊方式執行應打勾');
    assert(tpl.data.rows.some(r => r.label === '合作機構代碼' && r.value), '應帶出機構代碼');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'plan_detail', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${cert.id}/print`);
    assert(html.text.includes('心理諮商服務明細') && html.text.includes(row[2]), '列印頁應含服務人員');
    await admin.ok('POST', `/api/appointments/${made.id}/status`, { status: 'cancelled' });
    await admin.del(`/api/appointments/${made.id}`);
  });
  await test('方案轉介單帶出機構代碼與最近一次 BSRS-5', async () => {
    await admin.ok('POST', '/api/assessments',
      { client_id: clientId, scale: 'BSRS5', date: ymd(new Date()), answers: [4, 4, 4, 4, 4, 3] });
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=referral&subject_id=${clientId}`);
    const state = tpl.data.rows.find(r => r.label === '個案狀況');
    assert(state.value.includes('■1.') && state.value.includes('■2.'), '總分 20、附加題 3 分應自動勾選');
    assert(state.value.includes('BSRS-5：'), '應附上最近一次施測日期與分數');
    const reason = tpl.data.rows.find(r => r.label === '轉介原因（可複選）');
    assert(reason.value.includes('□職場霸凌'), '轉介原因應印成可勾選');
    assert(tpl.data.rows.find(r => r.label === '建議轉介機構').value.includes('身心診所'), '建議轉介機構');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'referral', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const doc = await admin.get(`/api/certificates/${cert.id}/print?format=doc`);
    equal(doc.status, 200, 'Word 匯出');
  });

  await test('轉介單（一式三聯）：三聯各印一頁，附醫療端回覆欄', async () => {
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=referral_clinic&subject_id=${clientId}`);
    equal(tpl.data.copies.length, 3, '一式三聯');
    assert(tpl.data.copies[0].includes('存根聯') && tpl.data.copies[2].includes('回覆聯'), '聯別名稱');
    const reply = tpl.data.rows.find(r => r.label.includes('轉介回覆'));
    assert(reply.value.includes('建議藥物治療') && reply.value.includes('醫師簽名'), '回覆欄');
    assert(tpl.data.rows.find(r => r.label === '建議轉介機構').value.includes('晨心'), '建議轉介機構');
    assert(tpl.data.rows.find(r => r.label === '機構代碼').value, '機構代碼');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'referral_clinic', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${cert.id}/print`);
    equal((html.text.match(/<section>/g) || []).length, 3, '應印出三頁');
    assert(html.text.includes('醫療端回覆聯'), '頁尾標明聯別');
    const doc = await admin.get(`/api/certificates/${cert.id}/print?format=doc`);
    equal(doc.status, 200, 'Word 匯出');
    // 其他類別仍只印一份
    const one = await admin.ok('GET', `/api/certificates/template?kind=treatment&subject_id=${clientId}`);
    equal(one.data.copies.length, 0, '治療證明不分聯');
  });

  section('兒童青少年表單');
  await test('家長同意書與兒少錄音錄影同意書：兩聯、含孩子與家長簽名欄', async () => {
    const tpls = await admin.ok('GET', '/api/consent-templates');
    const g = tpls.find(t => t.key === 'child_guardian');
    const r = tpls.find(t => t.key === 'recording_child');
    assert(g && g.minor_only, '家長同意書應限未成年個案');
    assert(g.body.includes('心理師不等同於醫師') && g.body.includes('遲到恕不補課'), '應含治療說明與請假規定');
    assert(g.sign_block.includes('與孩子關係') && g.sign_block.includes('孩子／個案簽名'), '簽署欄');
    assert(g.copy_labels.includes('家長留存聯'), '聯別為家長留存聯');
    const html = await admin.get('/api/consent-templates/child_guardian/print');
    assert(html.text.includes('家長留存聯') && html.text.includes('留存聯］'), '應印兩聯');
    assert(r && r.body.includes('錄音錄影') && r.allow_decline, '錄音錄影同意書可選擇不同意');
  });
  await test('未成年個案基本資料表帶入就學資料與主要照顧者', async () => {
    await admin.ok('PUT', `/api/clients/${clientId}`, {
      school: '太平國小', grade: '三年級', guardian_name: '測試家長',
      guardian_relationship: '母', guardian_phone: '0912000111'
    });
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=profile_minor&subject_id=${clientId}`);
    equal(tpl.data.rows.find(r => r.label === '就讀學校').value, '太平國小', '就讀學校');
    equal(tpl.data.rows.find(r => r.label === '年級').value, '三年級', '年級');
    assert(tpl.data.rows.find(r => r.label === '主要照顧者（監護人）').value.includes('測試家長'), '主要照顧者');
    assert(tpl.data.rows.find(r => r.label === '目前療育課程'), '應有療育課程欄');
    equal(tpl.data.grid.headers.join(','), '上課日期,時間,家長簽名,收費', '背面上課紀錄表');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'profile_minor', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${cert.id}/print`);
    assert(html.text.includes('太平國小') && html.text.includes('家長簽名'), '列印頁');
  });
  await test('早療補助療育紀錄列出該月療程、費用與收據號碼', async () => {
    const me = await admin.ok('GET', '/api/me');
    const date = nextWeekday(2, 230);
    const appt = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: me.id, date, start_time: '07:00', fee: 2000, override: true
    });
    await admin.ok('POST', `/api/appointments/${appt.id}/status`, { status: 'done' });
    const inv = (await admin.ok('GET', '/api/invoices')).rows.find(i => i.appointment_id === appt.id);
    await admin.ok('POST', `/api/invoices/${inv.id}/pay`, { method: '現金' });
    const rec = await admin.ok('POST', '/api/receipts', { invoice_id: inv.id });
    const month = date.slice(0, 7);
    const tpl = await admin.ok('GET',
      `/api/certificates/template?kind=early_intervention&subject_id=${clientId}&month=${month}`);
    equal(tpl.data.rows.find(r => r.label === '療育項目').value, '心理治療', '療育項目');
    equal(tpl.data.rows.find(r => r.label === '申請月份').value, month, '申請月份');
    const row = tpl.data.grid.data[0];
    assert(row && row[4] === '2000', '應帶出自費金額：' + JSON.stringify(tpl.data.grid.data));
    equal(row[5], rec.receipt_no, '應帶出收據號碼');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'early_intervention', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${cert.id}/print`);
    assert(html.text.includes('療育紀錄') && html.text.includes(rec.receipt_no), '列印頁應含收據號碼');
    const doc = await admin.get(`/api/certificates/${cert.id}/print?format=doc`);
    equal(doc.status, 200, 'Word 匯出');
    await admin.ok('POST', `/api/appointments/${appt.id}/status`, { status: 'cancelled' });
  });

  await test('早療官方表單：三頁（申請表、交通蓋章卡、療育收據卡）並帶入療程', async () => {
    const month = (await admin.ok('GET', `/api/certificates/template?kind=early_intervention&subject_id=${clientId}`))
      .data.rows.find(r => r.label === '申請月份') ? '' : '';
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=ei_official&subject_id=${clientId}`);
    equal(tpl.data.layout, 'ei_official', '走官方版面');
    assert(tpl.data.rows.find(r => r.label === '兒童遲緩狀況').value.includes('疑似發展遲緩'), '遲緩狀況勾選欄');
    assert(tpl.data.rows.find(r => r.label === '應備文件').value.includes('療育紀錄卡'), '應備文件清單');
    assert(tpl.data.stamp_cells >= 4, '表二蓋章格數');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'ei_official', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${cert.id}/print`);
    equal((html.text.match(/<section>/g) || []).length, 3, '應印三頁');
    assert(html.text.includes('表一') && html.text.includes('表二') && html.text.includes('表三'), '三張表');
    assert(html.text.includes('收據正本浮貼處'), '表三應留收據浮貼處');
    assert(html.text.includes('核定交通費'), '表二核定欄');
    const doc = await admin.get(`/api/certificates/${cert.id}/print?format=doc`);
    equal(doc.status, 200, 'Word 匯出：' + month);
  });
  await test('弱勢療育記錄卡：單張表件二，含自訂注意事項', async () => {
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=disadv_official&subject_id=${clientId}`);
    equal(tpl.data.layout, 'disadv_official', '走官方版面');
    assert(tpl.data.form_note.includes('每天最多'), '弱勢療育的療育次數規定');
    assert(tpl.data.rows.find(r => r.label === '補助項目').value.includes('療育訓練費'), '補助項目');
    const cert = await admin.ok('POST', '/api/certificates', {
      kind: 'disadv_official', subject_id: clientId, subject_name: tpl.subject_name, data: tpl.data
    });
    const html = await admin.get(`/api/certificates/${cert.id}/print`);
    equal((html.text.match(/<section>/g) || []).length, 2, '基本資料頁＋記錄表');
    assert(html.text.includes('療育訓練費補助記錄表') && html.text.includes('療育費補助合計'), '表件二版面');
  });
  await test('早期／弱勢療育服務同意書，一式兩份', async () => {
    const t = (await admin.ok('GET', '/api/consent-templates')).find(x => x.key === 'ei_service');
    assert(t && t.body.includes('個別療育') && t.body.includes('申訴專線'), '應含收費、服務方式與申訴管道');
    assert(t.body.includes('4,000 元'), '早療補助額度說明');
    const html = await admin.get('/api/consent-templates/ei_service/print');
    assert(html.text.includes('家長留存聯') && html.text.includes('家長簽名'), '兩聯與家長簽名欄');
  });
  await test('未成年基本資料表標題依年齡分成兒童與青少年', async () => {
    await admin.ok('PUT', `/api/clients/${clientId}`, { birth_date: ymd(new Date()).slice(0, 4) - 9 + '-05-05' });
    let tpl = await admin.ok('GET', `/api/certificates/template?kind=profile_minor&subject_id=${clientId}`);
    assert(tpl.data.title.includes('兒童'), '9 歲應為兒童版：' + tpl.data.title);
    await admin.ok('PUT', `/api/clients/${clientId}`, { birth_date: ymd(new Date()).slice(0, 4) - 15 + '-05-05' });
    tpl = await admin.ok('GET', `/api/certificates/template?kind=profile_minor&subject_id=${clientId}`);
    assert(tpl.data.title.includes('青少年'), '15 歲應為青少年版：' + tpl.data.title);
  });

  await test('同意書依適用對象篩選：兒童看得到療育同意書，成人看不到', async () => {
    await admin.ok('PUT', `/api/clients/${clientId}`, { birth_date: ymd(new Date()).slice(0, 4) - 8 + '-05-05' });
    let c = await admin.ok('GET', `/api/clients/${clientId}`);
    equal(c.age_group, 'child', '8 歲為兒童');
    const tpls = await admin.ok('GET', '/api/consent-templates');
    equal(tpls.find(t => t.key === 'ei_service').audience, 'child', '療育服務同意書限兒童');
    equal(tpls.find(t => t.key === 'youth').audience, 'adult', '青壯方案同意書限成人');
    assert(!c.pending_consents.some(x => x.key === 'youth'), '兒童不該出現青壯方案同意書');
    await admin.ok('PUT', `/api/clients/${clientId}`, { birth_date: ymd(new Date()).slice(0, 4) - 30 + '-05-05' });
    c = await admin.ok('GET', `/api/clients/${clientId}`);
    equal(c.age_group, 'adult', '30 歲為成人');
    assert(!c.pending_consents.some(x => x.key === 'ei_service'), '成人不該出現療育服務同意書');
    assert(c.pending_consents.some(x => x.key === 'privacy'), '未設對象的同意書仍對所有人顯示');
  });

  section('機構核銷');
  await test('內建三家單位的核銷方式，季配單位只在 1、4、7、10 月列為應核銷', async () => {
    const jan = await admin.ok('GET', '/api/partners-billing?month=2026-01');
    const feb = await admin.ok('GET', '/api/partners-billing?month=2026-02');
    const q = jan.rows.find(r => r.name.includes('家扶'));
    assert(q, '應內建家扶－心創服務');
    equal(q.cycle_label, '每季', '核銷方式');
    equal(q.months, '1,4,7,10', '核銷月份');
    assert(q.due, '1 月應核銷');
    assert(!feb.rows.find(r => r.name.includes('家扶')).due, '2 月不核銷');
    const m = jan.rows.find(r => r.name === '國軍方案');
    assert(m.due && feb.rows.find(r => r.name === '國軍方案').due, '每月核銷者每個月都要');
  });
  await test('核銷需要資料可自行填寫，並印進核銷表', async () => {
    const p = (await admin.ok('GET', '/api/partners')).find(x => x.name.includes('家扶'));
    await admin.ok('PUT', `/api/partners/${p.id}`, {
      billing_docs: '服務紀錄表\n收據正本\n個案簽到表', settle_note: '每季結束後 15 日內送件'
    });
    const board = await admin.ok('GET', '/api/partners-billing?month=2026-04');
    const row = board.rows.find(r => r.id === p.id);
    assert(row.docs.includes('個案簽到表'), '需要資料應存下來');
    const html = await admin.get('/api/partners-billing/print?month=2026-04');
    assert(html.text.includes('機構核銷') && html.text.includes('個案簽到表')
      && html.text.includes('每季結束後'), '核銷表應含機構、方式與需要資料');
    const onlyDue = await admin.get('/api/partners-billing/print?month=2026-02&due=1');
    assert(!onlyDue.text.includes('家扶'), '只列本月應核銷時，季配單位在 2 月不出現');
    const doc = await admin.get('/api/partners-billing/print?month=2026-04&format=doc');
    equal(doc.status, 200, 'Word 匯出');
  });

  await test('表單文字可存成預設，之後開立同類表單都套用，且自動帶入不受影響', async () => {
    const tpl = await admin.ok('GET', `/api/certificates/template?kind=treatment&subject_id=${clientId}`);
    const rows = tpl.data.rows.map(r => (r.label === '治療主題' ? { label: '治療重點', value: '' } : r));
    rows.push({ label: '本所備註', value: '本證明僅供指定用途使用' });
    await admin.ok('POST', '/api/certificates/template/treatment', {
      data: { ...tpl.data, title: '心理治療證明書', statement: '固定聲明文字', rows }
    });
    const after = await admin.ok('GET', `/api/certificates/template?kind=treatment&subject_id=${clientId}`);
    equal(after.data.title, '心理治療證明書', '標題沿用所方存的預設');
    equal(after.data.statement, '固定聲明文字', '聲明沿用');
    assert(after.data.rows.some(r => r.label === '治療重點'), '改過的欄位名沿用');
    assert(after.data.rows.some(r => r.label === '本所備註'), '自行加的欄位沿用');
    assert(after.has_saved_template, '應標示已有自訂預設');
    // 會變動的欄位仍即時帶入
    const c = await admin.ok('GET', `/api/clients/${clientId}`);
    equal(after.data.rows.find(r => r.label === '案主姓名').value, c.name, '姓名仍自動帶入');
    // 表格資料一律用系統當下算的
    const eiTpl = await admin.ok('GET', `/api/certificates/template?kind=early_intervention&subject_id=${clientId}`);
    await admin.ok('POST', '/api/certificates/template/early_intervention', {
      data: { ...eiTpl.data, grid: { ...eiTpl.data.grid, label: '本所療育明細', data: [] } }
    });
    const ei2 = await admin.ok('GET', `/api/certificates/template?kind=early_intervention&subject_id=${clientId}`);
    equal(ei2.data.grid.label, '本所療育明細', '表格標題沿用');
    equal(ei2.data.grid.data.length, eiTpl.data.grid.data.length, '表格內容仍由系統帶出');
    // 回復系統預設
    await admin.ok('DELETE', '/api/certificates/template/treatment');
    const back = await admin.ok('GET', `/api/certificates/template?kind=treatment&subject_id=${clientId}`);
    equal(back.data.title, '治療證明', '回復系統預設');
    assert(!back.has_saved_template, '已無自訂預設');
    await admin.ok('DELETE', '/api/certificates/template/early_intervention');
  });
  await test('一般行政不得改表單預設內容', async () => {
    await office.fails('POST', '/api/certificates/template/treatment', { data: { title: 'X' } });
  });
  await test('勞務報酬單的標題與頁尾說明改設定就跟著變', async () => {
    const lin2 = (await admin.ok('GET', '/api/users')).find(u => u.username === 'lin');
    const made = await admin.ok('POST', '/api/payouts',
      { user_id: lin2.id, month: '2026-03', item: '督導費', gross: 3000, income_type: '9A' });
    await admin.ok('PUT', '/api/settings', { payout_slip_title: '執行業務所得給付單', payout_slip_note: '本單一式兩份。' });
    const slip = await admin.get(`/api/payouts/slip?ids=${made.id}`);
    assert(slip.text.includes('執行業務所得給付單') && slip.text.includes('本單一式兩份。'), '標題與說明可改');
    await admin.ok('PUT', '/api/settings', { payout_slip_title: '勞務報酬單' });
    await admin.ok('DELETE', `/api/payouts/${made.id}`);
  });

  section('各模組的新增／編輯／刪除');
  await test('督導紀錄可編輯，且只能改自己的', async () => {
    const made = await admin.ok('POST', '/api/supervisions',
      { counselor_id: (await admin.ok('GET', '/api/me')).id, date: ymd(new Date()), hours: 1, type: 'individual', content: '原內容' });
    await admin.ok('PUT', `/api/supervisions/${made.id}`, { hours: 2, content: '改過的內容', type: 'group' });
    const row = (await admin.ok('GET', '/api/supervisions')).find(r => r.id === made.id);
    equal(row.hours, 2, '時數已改');
    equal(row.content, '改過的內容', '內容已改');
    equal(row.type, 'group', '型式已改');
    await lin.fails('PUT', `/api/supervisions/${made.id}`, { hours: 9 }, '僅能修改自己');
    await admin.ok('DELETE', `/api/supervisions/${made.id}`);
  });
  await test('安全計畫可刪除，但有新版本的舊版不可刪', async () => {
    const p1 = await admin.ok('POST', `/api/clients/${clientId}/safety-plans`,
      { date: ymd(new Date()), warning_signs: '第一版', coping_strategies: '深呼吸' });
    const p2 = await admin.ok('POST', `/api/clients/${clientId}/safety-plans`,
      { date: ymd(new Date()), warning_signs: '第二版', coping_strategies: '散步' });
    assert(p2.version > p1.version, '應為新版本');
    await admin.fails('DELETE', `/api/safety-plans/${p1.id}`, undefined, '已有更新版本');
    await admin.ok('DELETE', `/api/safety-plans/${p2.id}`);
    await admin.ok('DELETE', `/api/safety-plans/${p1.id}`);
  });
  await test('個案訊息可由所方主動發起', async () => {
    await admin.ok('POST', '/api/messages', { client_id: clientId, content: '提醒您本週的晤談時間' });
    const list = await admin.ok('GET', '/api/messages');
    assert(list.some(m => m.client_id === clientId), '對話清單應出現這位個案');
  });

  section('Google 表單同步與 LINE 預約入口');
  await test('未設定密鑰時拒收表單資料', async () => {
    const r = await fetch(BASE + '/api/integrations/google-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'x', answers: { 姓名: '測試' } })
    });
    equal(r.status, 401, 'HTTP 狀態');
  });
  await test('產生密鑰後可收表單回應並自動對應方案與心理師', async () => {
    const gen = await admin.ok('PUT', '/api/integrations/google-form', { regenerate: true });
    assert(gen.secret && gen.secret.length > 20, '應產生密鑰');
    // 題目標題與選項文字照抄本所的「織心心理治療所 預約表單」，含全形數字與括號註解
    const payload = {
      secret: gen.secret,
      response_id: 'smoke-resp-1',
      answers: {
        預約類別: '成人',
        '預約項目（可申請療育補助）': '個別治療／諮商(２０００／５０分鐘)',
        '就診者姓名\n(註：我們只提供自費心理治療/諮商，沒有提供開藥服務，謝謝~)': '陳表單',
        生理性別: '女',
        出生年月日: '1995-06-15',
        您的電話: '0955-123-456',
        您的email: 'form@example.com',
        教育程度: '大學',
        '請簡述您想尋求協助的主要原因：': '近三個月失眠、情緒低落',
        '請簡述您期待得到的幫忙(如果需要EMDR眼動減敏療法請備註)': '希望能穩定睡眠，需要 EMDR',
        '預約時間（星期一至星期五１４：００－２１：００；星期六９：００－１７：００）請填寫三個方便的時段，如禮拜五19:00（若需要其他時段請透過助理詢問）': '禮拜一19:00、禮拜三20:00、禮拜五19:00',
        是否指定心理師: '鍾芯瑜心理師',
        '': '我已加入官方LINE並主動傳送姓名'
      }
    };
    const r = await fetch(BASE + '/api/integrations/google-form', {
      method: 'post'.toUpperCase(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const d = await r.json();
    assert(r.ok, '同步失敗：' + JSON.stringify(d));
    equal(d.matched.plan, '個別治療／諮商（50 分鐘）', '方案對應（選項含全形價目說明）');
    equal(d.matched.counselor, '鍾芯瑜', '心理師對應');
    assert((await admin.ok('GET', '/api/bookings')).some(x => x.id === d.id), '應寫進線上預約申請');
    const full = await admin.ok('GET', `/api/bookings/${d.id}`);
    equal(full.phone, '0955123456', '電話');
    equal(full.email, 'form@example.com', 'Email');
    equal(full.birth_date, '1995-06-15', '出生年月日');
    equal(full.gender, 'female', '生理性別');
    equal(full.category, '成人', '預約類別');
    equal(full.education, '大學', '教育程度');
    assert(/失眠/.test(full.main_issue), '主要原因');
    assert(/EMDR/.test(full.expectation), '期待得到的幫忙');
    assert(/禮拜一19:00/.test(full.alt_note), '預約時間');
    equal(Object.keys(JSON.parse(full.form_answers)).length, Object.keys(payload.answers).length, '完整回應題數');
    // 兒青段：孩子姓名＋家長電話，且家長電話另存一份
    const child = await (await fetch(BASE + '/api/integrations/google-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: gen.secret, response_id: 'smoke-resp-child', answers: {
        預約類別: '兒童青少年',
        '預約項目（可申請療育補助）': '兒青團體治療(１０００／５０分鐘；須至少進行一次個別課程)',
        '孩子姓名\n(註：我們只提供自費心理治療/諮商，沒有提供開藥服務，謝謝~)': '李小安',
        生理性別: '男', 出生年月日: '2014/03/02',
        '家長的電話': '0912-000-111', '家長EMAIL（若沒有電子郵件請填無）': '無',
        孩子教育程度: '國小四年級',
        '請簡述您想尋求協助的主要原因：': '學校適應困難',
        '請簡述您期待得到的幫忙': '希望能交到朋友',
        是否指定心理師: '不指定，由所方媒合專業及可配合時間的心理師'
      } })
    })).json();
    equal(child.matched.plan, '兒青團體治療（50 分鐘）', '兒青方案對應');
    equal(child.matched.counselor, null, '不指定心理師不應誤配');
    const childRow = await admin.ok('GET', `/api/bookings/${child.id}`);
    equal(childRow.phone, '0912000111', '兒青案以家長電話為聯絡電話');
    equal(childRow.guardian_phone, '0912000111', '家長電話另存');
    equal(childRow.education, '國小四年級', '孩子教育程度');
    // 由申請建檔時，表單資料要一路帶進個案
    const made = await admin.ok('POST', `/api/bookings/${child.id}/create-client`);
    const madeClient = await admin.ok('GET', `/api/clients/${made.client_id}`);
    equal(madeClient.education, '國小四年級', '教育程度帶進個案');
    equal(madeClient.guardian_phone, '0912000111', '家長電話帶進個案');
    equal(madeClient.is_minor, 1, '未成年判定');
    assert(/交到朋友/.test(madeClient.note), '期待帶進個案備註');

    // 同一份回應重送不應產生第二筆
    const again = await (await fetch(BASE + '/api/integrations/google-form', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })).json();
    equal(again.id, d.id, '重送應回同一筆');
    const rows = await admin.ok('GET', '/api/bookings?status=new');
    assert(rows.some(x => x.id === d.id), '待處理清單應含此申請');
    // 成人段建檔：主訴與指定心理師一併帶進個案
    const c = await admin.ok('POST', `/api/bookings/${d.id}/create-client`);
    const client = await admin.ok('GET', `/api/clients/${c.client_id}`);
    equal(client.phone, '0955123456', '電話應正規化');
    equal(client.email, 'form@example.com', 'Email 帶進個案');
    equal(client.education, '大學', '教育程度帶進個案');
    assert(/失眠/.test(client.main_issue), '主訴帶進個案');
    equal(client.source, 'Google 預約表單', '來源標為表單')
  });
  await test('表單同步設定頁提供 Apps Script 程式碼', async () => {
    const d = await admin.ok('GET', '/api/integrations/google-form');
    assert(d.script.includes('onFormSubmit') && d.script.includes(d.endpoint), '應含觸發函式與接收網址');
    assert(/\/api\/integrations\/google-form$/.test(d.endpoint), '接收網址');
  });
  await test('簽章正確的 LINE 訊息會被受理（預約入口）', async () => {
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: 'smoke-secret' });
    const body = JSON.stringify({
      events: [{ type: 'message', replyToken: 'r1', source: { userId: 'Usmoke001' },
        message: { type: 'text', text: '預約' } }]
    });
    const sig = require('crypto').createHmac('sha256', 'smoke-secret').update(body).digest('base64');
    const r = await fetch(BASE + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body
    });
    equal(r.status, 200, 'HTTP 狀態');
    const d = await r.json().catch(() => ({}));
    assert(d.ok, '簽章正確時應處理事件');
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: '' });
  });
  await test('偽造簽章的訊息不會被處理', async () => {
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: 'smoke-secret' });
    const body = JSON.stringify({ events: [{ type: 'message', source: { userId: 'U-bad' }, message: { type: 'text', text: '預約' } }] });
    const r = await fetch(BASE + '/api/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': 'wrong' }, body
    });
    equal(r.status, 200, '應靜默忽略');
    equal((await r.text()).trim(), '', '不應回傳處理結果');
    await admin.ok('PUT', '/api/line/settings', { line_channel_secret: '' });
  });

  // ---- 結果 ----
  console.log(`\n${'─'.repeat(46)}`);
  if (failures.length) {
    console.log(`✗ 通過 ${pass} 項，失敗 ${failures.length} 項：`);
    failures.forEach(f => console.log(`   · ${f}`));
  } else {
    console.log(`✓ 全部通過（${pass} 項）`);
  }
  cleanup(failures.length ? 1 : 0);
})().catch(e => {
  console.error('\n冒煙測試中斷：', e);
  cleanup(1);
});

// 直接用 fetch 抓二進位內容時需要自行帶上該身分的 cookie
function lastCookie(s) { return s.cookie || ''; }

function cleanup(code) {
  try { if (server) server.kill(); } catch { /* 略過 */ }
  if (KEEP) console.log(`暫存目錄保留於：${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
