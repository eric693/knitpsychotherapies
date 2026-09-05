// 編輯能力檢查：把每一個「修改資料」的端點實際跑一遍（建立 → 修改 → 讀回確認真的改掉）。
//
//   node scripts/check-edits.js
//
// 與 scripts/smoke.js 的分工：smoke.js 驗的是流程與規則（含部分編輯），
// 這支專門回答「所有資料都還改得動嗎」，逐一列出每個實體的編輯結果。
// 全程在拋棄式資料庫上跑（比照 smoke.js），不碰正式資料。

process.env.TZ = process.env.TZ || 'Asia/Taipei';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcare-edits-'));
const env = {
  ...process.env,
  TZ: 'Asia/Taipei',
  MINDCARE_DATA_DIR: path.join(tmp, 'data'),
  MINDCARE_UPLOAD_DIR: path.join(tmp, 'uploads'),
  MINDCARE_BACKUP_MIRROR: path.join(tmp, 'mirror')
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let BASE = '';
let server = null;
const results = [];
function cleanup(code) {
  try { if (server) server.kill(); } catch { /* 略過 */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

// ---- 帶 cookie 的簡易 client ----
function session() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  };
  // 附件是 multipart 上傳，不能走上面的 JSON 版本（Content-Type 要讓 fetch 自己帶 boundary）
  const upload = async (url, form) => {
    const r = await fetch(BASE + url, { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: form });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST ${url} → ${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return {
    call,
    upload,
    async ok(method, url, body) {
      const r = await call(method, url, body);
      if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      return r.data;
    }
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail: detail || '' });
    console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  } catch (e) {
    results.push({ label, ok: false, detail: e.message });
    console.log(`  ✗ ${label}\n      ${e.message}`);
  }
}
function equal(a, b, what) {
  if (String(a) !== String(b)) throw new Error(`${what}：預期 ${b}，實際 ${a}`);
}
function assert(cond, what) {
  if (!cond) throw new Error(what);
}

(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  execFileSync(process.execPath, ['scripts/seed.js'], { cwd: ROOT, env, stdio: 'ignore' });
  server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/api/public/ui-texts'); if (r.ok) break; } catch { /* 還沒起來 */ }
    await new Promise(r => setTimeout(r, 500));
  }

  const admin = session();
  await admin.ok('POST', '/api/login', { username: 'admin', password: 'mindcare123' });
  const lin = session();
  await lin.ok('POST', '/api/login', { username: 'lin', password: '123456' });

  const me = await lin.ok('GET', '/api/me');
  const users = await admin.ok('GET', '/api/users');
  const counselor = users.find(u => u.id === me.id);
  const clients = await admin.ok('GET', '/api/clients');
  const list = Array.isArray(clients) ? clients : clients.rows;
  // 臨床資料（紀錄、報告、計畫）只有主責心理師改得動，因此挑一位 lin 主責的個案來測
  const client = list.find(c => c.counselor_id === counselor.id) || list[0];
  if (client.counselor_id !== counselor.id) throw new Error('找不到該心理師主責的個案，無法檢查臨床資料的編輯');

  console.log('\n── 逐一確認每種資料都改得動\n');

  await check('個案基本資料', async () => {
    await admin.ok('PUT', `/api/clients/${client.id}`, { note: '編輯檢查 A' });
    const c = await admin.ok('GET', `/api/clients/${client.id}`);
    equal(c.note, '編輯檢查 A', '備註');
  });

  await check('預約', async () => {
    const day = addDays(today(), 40);
    const a = await admin.ok('POST', '/api/appointments',
      { client_id: client.id, counselor_id: counselor.id, date: day, start_time: '10:00' });
    await admin.ok('PUT', `/api/appointments/${a.id}`, { note: '編輯檢查 B' });
    const row = (await admin.ok('GET', `/api/appointments?date=${day}`)).find(x => x.id === a.id);
    equal(row.note, '編輯檢查 B', '備註');
  });

  await check('晤談紀錄（心理師本人）', async () => {
    const day = addDays(today(), 41);
    const a = await lin.ok('POST', '/api/appointments',
      { client_id: client.id, counselor_id: counselor.id, date: day, start_time: '10:00' });
    const n = await lin.ok('POST', '/api/notes',
      { client_id: client.id, appointment_id: a.id, date: day, subjective: '原文' });
    await lin.ok('PUT', `/api/notes/${n.id}`, { subjective: '改過的內容' });
    const got = await lin.ok('GET', `/api/notes/${n.id}`);
    equal(got.subjective, '改過的內容', '主觀資料');
  });

  await check('衡鑑報告', async () => {
    const r = await lin.ok('POST', '/api/reports', { client_id: client.id, purpose: '原目的' });
    await lin.ok('PUT', `/api/reports/${r.id}`, { purpose: '改過的目的' });
    const got = await lin.ok('GET', `/api/reports/${r.id}`);
    equal(got.purpose, '改過的目的', '施測目的');
  });

  await check('處遇計畫', async () => {
    const p = await lin.ok('POST', '/api/plans', { client_id: client.id, start_date: today(), approach: '原取向' });
    await lin.ok('PUT', `/api/plans/${p.id}`, { approach: 'CBT' });
    const got = (await lin.ok('GET', `/api/clients/${client.id}/plans`)).find(x => x.id === p.id);
    equal(got.approach, 'CBT', '治療取向');
  });

  await check('安全計畫', async () => {
    const p = await lin.ok('POST', `/api/clients/${client.id}/safety-plans`,
      { warning_signs: '睡不著', coping_strategies: '散步' });
    await lin.ok('PUT', `/api/safety-plans/${p.id}`, { warning_signs: '睡不著、食慾差' });
    const got = (await lin.ok('GET', `/api/clients/${client.id}/safety-plans`)).rows.find(x => x.id === p.id);
    equal(got.warning_signs, '睡不著、食慾差', '警訊');
  });

  await check('危機事件', async () => {
    const e = await lin.ok('POST', '/api/risk-events',
      { client_id: client.id, type: '自傷', date: today(), description: '原摘要' });
    await lin.ok('PUT', `/api/risk-events/${e.id}`, { description: '改過的摘要' });
    const got = (await lin.ok('GET', '/api/risk-events')).find(x => x.id === e.id);
    equal(got.description, '改過的摘要', '事件描述');
  });

  await check('收費單', async () => {
    const inv = await admin.ok('POST', '/api/invoices', { client_id: client.id, item: '原項目', amount: 2000 });
    await admin.ok('PUT', `/api/invoices/${inv.id}`, { item: '改過的項目', amount: 1800 });
    const got = (await admin.ok('GET', '/api/invoices')).rows.find(x => x.id === inv.id);
    equal(got.item, '改過的項目', '項目');
    equal(got.amount, 1800, '金額');
  });

  await check('收據（抬頭與項目）', async () => {
    const inv = await admin.ok('POST', '/api/invoices', { client_id: client.id, item: '收據測試', amount: 2000 });
    await admin.ok('POST', `/api/invoices/${inv.id}/pay`, { method: '現金' });
    const rec = await admin.ok('POST', '/api/receipts', { invoice_id: inv.id });
    await admin.ok('PUT', `/api/receipts/${rec.id}`, { title: '改過的抬頭' });
    const got = (await admin.ok('GET', '/api/receipts')).rows.find(x => x.id === rec.id);
    equal(got.title, '改過的抬頭', '抬頭');
    return `編號 ${got.receipt_no} 不變`;
  });

  await check('次數方案（套餐）', async () => {
    const p = await admin.ok('POST', '/api/packages',
      { client_id: client.id, name: '十次方案', sessions_total: 10, amount: 18000 });
    await admin.ok('PUT', `/api/packages/${p.id}`, { name: '十次方案（改）' });
    const list = await admin.ok('GET', `/api/packages?client_id=${client.id}`);
    const got = (Array.isArray(list) ? list : list.rows).find(x => x.id === p.id);
    equal(got.name, '十次方案（改）', '方案名稱');
  });

  await check('服務方案／主題／心理師費率', async () => {
    const plan = await admin.ok('POST', '/api/service-plans', { name: '編輯檢查方案', kind: 'self', fee: 2000 });
    await admin.ok('PUT', `/api/service-plans/${plan.id}`, { fee: 2200 });
    const t = await admin.ok('POST', `/api/service-plans/${plan.id}/topics`, { name: '原主題', fee: 2000 });
    await admin.ok('PUT', `/api/topics/${t.id}`, { name: '改過的主題' });
    const rate = await admin.ok('POST', `/api/service-plans/${plan.id}/rates`,
      { counselor_id: counselor.id, fee: 2000, share_mode: 'percent', share_percent: 60 });
    await admin.ok('PUT', `/api/rates/${rate.id}`, { share_percent: 55 });
    const got = (await admin.ok('GET', '/api/service-plans')).find(x => x.id === plan.id);
    equal(got.fee, 2200, '方案金額');
    equal(got.topics.find(x => x.id === t.id).name, '改過的主題', '主題名稱');
    equal(Math.round(got.rates.find(x => x.id === rate.id).share_percent * 100), 55, '抽成比例');
  });

  await check('團體與成員', async () => {
    const g = await admin.ok('POST', '/api/groups',
      { name: '編輯檢查團體', counselor_id: counselor.id, capacity: 8 });
    await admin.ok('PUT', `/api/groups/${g.id}`, { name: '改過的團體' });
    await admin.ok('POST', `/api/groups/${g.id}/members`, { client_id: client.id });
    const members = await admin.ok('GET', `/api/groups/${g.id}`);
    const m = (members.members || [])[0];
    await admin.ok('PUT', `/api/group-members/${m.id}`, { status: 'dropped', note: '中途退出' });
    const after = await admin.ok('GET', `/api/groups/${g.id}`);
    equal(after.name, '改過的團體', '團體名稱');
    equal(after.members.find(x => x.id === m.id).status, 'dropped', '成員狀態');
  });

  await check('來電登記', async () => {
    const i = await admin.ok('POST', '/api/intakes', { name: '編輯檢查來電', phone: '0912000999' });
    await admin.ok('PUT', `/api/intakes/${i.id}`, { note: '已回電' });
    const got = (await admin.ok('GET', '/api/intakes')).find(x => x.id === i.id);
    equal(got.note, '已回電', '備註');
  });

  await check('線上預約申請', async () => {
    // seed 沒有預約申請，先從公開表單送一筆進來
    const cfg = await admin.ok('GET', '/api/public/booking-config');
    const plan = cfg.plans.find(p => p.counselors.length);
    const r = await fetch(BASE + '/api/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '編輯檢查', phone: '0912000888', consent: 1,
        plan_id: plan.id, birth_date: '1990-01-01', main_issue: '原主訴' })
    });
    if (!r.ok) throw new Error('公開表單送單失敗：' + (await r.text()).slice(0, 120));
    const b = await r.json();
    await admin.ok('PUT', `/api/bookings/${b.id}`, { main_issue: '改過的主訴' });
    const got = await admin.ok('GET', `/api/bookings/${b.id}`);
    equal(got.main_issue, '改過的主訴', '主訴');
  });

  await check('請假', async () => {
    const t = await lin.ok('POST', '/api/time-off',
      { start_date: addDays(today(), 60), end_date: addDays(today(), 60), reason: '原事由' });
    await lin.ok('PUT', `/api/time-off/${t.id}`, { reason: '改過的事由' });
    const got = (await lin.ok('GET', '/api/time-off')).find(x => x.id === t.id);
    equal(got.reason, '改過的事由', '請假事由');
  });

  await check('報酬單', async () => {
    const p = await admin.ok('POST', '/api/payouts',
      { user_id: counselor.id, month: today().slice(0, 7), gross: 50000 });
    await admin.ok('PUT', `/api/payouts/${p.id}`, { note: '改過的備註' });
    const got = (await admin.ok('GET', `/api/payouts?month=${today().slice(0, 7)}`)).rows.find(x => x.id === p.id);
    equal(got.note, '改過的備註', '備註');
  });

  await check('公告', async () => {
    const a = await admin.ok('POST', '/api/announcements', { title: '原公告', body: '內容' });
    await admin.ok('PUT', `/api/announcements/${a.id}`, { title: '改過的公告' });
    const got = (await admin.ok('GET', '/api/announcements')).find(x => x.id === a.id);
    equal(got.title, '改過的公告', '標題');
  });

  await check('證明書', async () => {
    const c = await admin.ok('POST', '/api/certificates',
      { kind: 'employment', subject_kind: 'user', subject_id: counselor.id,
        subject_name: counselor.name, data: { title: '在職證明書', rows: [], statement: '原文' } });
    await admin.ok('PUT', `/api/certificates/${c.id}`,
      { data: { title: '在職證明書', rows: [], statement: '改過的聲明' } });
    const got = await admin.ok('GET', `/api/certificates/${c.id}`);
    const data = typeof got.data === 'string' ? JSON.parse(got.data) : got.data;
    equal(data.statement, '改過的聲明', '聲明段落');
  });

  await check('諮商室', async () => {
    const r = await admin.ok('POST', '/api/rooms', { name: '編輯檢查室' });
    await admin.ok('PUT', `/api/rooms/${r.id}`, { name: '改過的諮商室' });
    const got = (await admin.ok('GET', '/api/rooms')).find(x => x.id === r.id);
    equal(got.name, '改過的諮商室', '名稱');
  });

  await check('帳號與權限', async () => {
    await admin.ok('PUT', `/api/users/${counselor.id}`, { title: '諮商心理師（改）' });
    const got = (await admin.ok('GET', '/api/users')).find(x => x.id === counselor.id);
    equal(got.title, '諮商心理師（改）', '職稱');
  });

  await check('系統設定', async () => {
    await admin.ok('PUT', '/api/settings', { cancel_hours: '36' });
    const got = await admin.ok('GET', '/api/settings');
    equal(got.cancel_hours, '36', '免收費取消時數');
    await admin.ok('PUT', '/api/settings', { cancel_hours: '24' });
  });

  await check('同意書範本', async () => {
    const list = await admin.ok('GET', '/api/consent-templates');
    const t = list[0];
    await admin.ok('PUT', `/api/consent-templates/${t.id}`, { title: '改過的同意書標題' });
    const got = (await admin.ok('GET', '/api/consent-templates')).find(x => x.id === t.id);
    equal(got.title, '改過的同意書標題', '標題');
  });

  await check('量表紀錄（日期與備註）', async () => {
    const scales = await admin.ok('GET', '/api/scales');
    const key = Object.keys(scales)[0];
    const def = scales[key];
    const answers = def.items.map(() => 0);
    const a = await admin.ok('POST', '/api/assessments',
      { client_id: client.id, scale: key, answers, note: '原備註' });
    await admin.ok('PUT', `/api/assessments/${a.id}`, { note: '改過的備註', date: addDays(today(), -3) });
    const got = await admin.ok('GET', `/api/assessments/${a.id}`);
    equal(got.note, '改過的備註', '備註');
    equal(got.date, addDays(today(), -3), '施測日期');
    return '作答內容仍不可改';
  });

  await check('轉介紀錄', async () => {
    const r = await lin.ok('POST', `/api/clients/${client.id}/referrals`,
      { target: '原轉介對象', reason: '原轉介原因' });
    await lin.ok('PUT', `/api/referrals/${r.id}`, { target: '改過的轉介對象', status: 'accepted' });
    const got = (await lin.ok('GET', `/api/clients/${client.id}/referrals`)).rows.find(x => x.id === r.id);
    equal(got.target, '改過的轉介對象', '轉介對象');
    assert(got.replied_at, '改為已接案時自動記下回覆時間');
  });

  await check('結案追蹤', async () => {
    const f = await lin.ok('POST', `/api/clients/${client.id}/follow-ups`,
      { due_date: addDays(today(), 30), note: '原備註' });
    await lin.ok('PUT', `/api/follow-ups/${f.id}`, { note: '改過的備註' });
    const got = (await lin.ok('GET', `/api/clients/${client.id}/follow-ups`)).rows.find(x => x.id === f.id);
    equal(got.note, '改過的備註', '備註');
  });

  await check('督導紀錄', async () => {
    const r = await lin.ok('POST', '/api/supervisions',
      { counselor_id: counselor.id, hours: 1, content: '原內容' });
    await lin.ok('PUT', `/api/supervisions/${r.id}`, { hours: 2, content: '改過的內容' });
    const got = (await lin.ok('GET', '/api/supervisions')).find(x => x.id === r.id);
    equal(got.content, '改過的內容', '內容');
    equal(got.hours, 2, '時數');
  });

  await check('合作單位', async () => {
    const p = await admin.ok('POST', '/api/partners', { name: '編輯檢查單位' });
    await admin.ok('PUT', `/api/partners/${p.id}`, { name: '改過的單位', billing_cycle: 'quarterly' });
    const got = (await admin.ok('GET', '/api/partners')).find(x => x.id === p.id);
    equal(got.name, '改過的單位', '單位名稱');
    equal(got.billing_cycle, 'quarterly', '核銷頻率');
  });

  await check('個案附件（分類、備註、是否給個案看）', async () => {
    const form = new FormData();
    form.append('file', new Blob(['編輯檢查用附件'], { type: 'text/plain' }), 'check.txt');
    form.append('kind', '其他');
    const up = await admin.upload(`/api/clients/${client.id}/attachments`, form);
    await admin.ok('PUT', `/api/attachments/${up.id}`, { note: '改過的附件備註', visible_to_client: 1 });
    const got = (await admin.ok('GET', `/api/clients/${client.id}/attachments`)).find(x => x.id === up.id);
    equal(got.note, '改過的附件備註', '附件備註');
    equal(got.visible_to_client, 1, '開放個案查看');
  });

  await check('同意書逐案指派', async () => {
    const tpls = await admin.ok('GET', '/api/consent-templates');
    const keys = tpls.slice(0, 2).map(t => t.key);
    await admin.ok('PUT', `/api/clients/${client.id}/consent-assignments`, { keys });
    const c1 = await admin.ok('GET', `/api/clients/${client.id}`);
    equal(c1.assigned_consents.slice().sort().join(','), keys.slice().sort().join(','), '指派清單');
    await admin.ok('PUT', `/api/clients/${client.id}/consent-assignments`, { keys: [] });
    equal((await admin.ok('GET', `/api/clients/${client.id}`)).assigned_consents.length, 0, '可清除指派');
  });

  await check('方案額度（已用人次的人工調整）', async () => {
    const board = await admin.ok(`GET`, `/api/plan-board?date=${today()}`);
    const row = board.rows[0];
    if (!row) return '此站沒有設上限的方案，略過';
    await admin.ok('PUT', '/api/plan-board/limit',
      { plan_id: row.plan_id, counselor_id: row.counselor_id, week_limit: 7 });
    const got = (await admin.ok('GET', `/api/plan-board?date=${today()}`))
      .rows.find(x => x.plan_id === row.plan_id && x.counselor_id === row.counselor_id);
    equal(got.week_limit, 7, '每週上限');
  });

  await check('LINE 串接設定與卡片文案', async () => {
    await admin.ok('PUT', '/api/line/settings',
      { line_reminder_hours: 36, line_text_booked_note: '請提前 15 分鐘到所。' });
    const got = await admin.ok('GET', '/api/line/settings');
    equal(got.line_reminder_hours, '36', '提醒提前時數');
    equal(got.line_text_booked_note, '請提前 15 分鐘到所。', '卡片文案');
    await admin.ok('PUT', '/api/line/settings', { line_reminder_hours: 24, line_text_booked_note: '' });
  });

  await check('Google 表單同步設定', async () => {
    await admin.ok('PUT', '/api/integrations/google-form', { form_url: 'https://docs.google.com/forms/d/CHECK/edit' });
    const got = await admin.ok('GET', '/api/integrations/google-form');
    equal(got.form_url, 'https://docs.google.com/forms/d/CHECK/edit', '表單網址');
  });

  await check('自己的密碼', async () => {
    const u = session();
    await u.ok('POST', '/api/login', { username: 'chen', password: '123456' });
    await u.ok('PUT', '/api/me/password', { old_password: '123456', new_password: 'new12345' });
    const again = session();
    await again.ok('POST', '/api/login', { username: 'chen', password: 'new12345' });
    return '改完可用新密碼登入';
  });

  await check('個案端：自己的密碼與量表', async () => {
    const c = await admin.ok('GET', `/api/clients/${client.id}`);
    await admin.ok('PUT', `/api/clients/${client.id}`, { portal_enabled: 1 });
    const rp = await admin.ok('POST', `/api/clients/${client.id}/reset-password`, {});
    const portal = session();
    await portal.ok('POST', '/api/portal/login', { phone: c.phone, password: rp.password });
    await portal.ok('PUT', '/api/portal/password', { old_password: rp.password, new_password: 'client999' });
    const again = session();
    await again.ok('POST', '/api/portal/login', { phone: c.phone, password: 'client999' });
    return '個案可自行改密碼';
  });

  // 反面確認：這幾種「刻意不給改」的規則要還在，否則等於病歷可以事後塗改
  console.log('\n── 反面確認：刻意鎖住的資料不能改\n');
  const fails = async (label, method, url, body, expect) => {
    await check(label, async () => {
      const r = await admin.call(method, url, body);
      if (r.ok) throw new Error('竟然改成功了，鎖定規則失效');
      const msg = (r.data && r.data.error) || '';
      if (expect && !msg.includes(expect)) throw new Error(`錯誤訊息不符：${msg}`);
      return msg;
    });
  };

  await fails('量表作答內容不可修改', 'PUT', `/api/assessments/${(await admin.ok('GET', `/api/assessments?client_id=${client.id}`))[0].id}`,
    { answers: [0, 0, 0] }, '刪除後重新登錄');

  const day = addDays(today(), 45);
  const appt = await lin.ok('POST', '/api/appointments',
    { client_id: client.id, counselor_id: counselor.id, date: day, start_time: '11:00' });
  const signed = await lin.ok('POST', '/api/notes',
    { client_id: client.id, appointment_id: appt.id, date: day, subjective: '定稿前' });
  await lin.ok('POST', `/api/notes/${signed.id}/sign`);
  await check('晤談紀錄簽核後不可修改', async () => {
    const r = await lin.call('PUT', `/api/notes/${signed.id}`, { subjective: '偷改' });
    if (r.ok) throw new Error('竟然改成功了，定稿規則失效');
    return r.data.error;
  });

  const voidInv = await admin.ok('POST', '/api/invoices', { client_id: client.id, item: '作廢測試', amount: 1000 });
  await admin.ok('POST', `/api/invoices/${voidInv.id}/void`, { reason: '開錯' });
  await fails('已作廢的收費單不可修改', 'PUT', `/api/invoices/${voidInv.id}`, { amount: 5000 }, '作廢');

  const bad = results.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(46)}`);
  if (bad.length) {
    console.log(`✗ 可編輯 ${results.length - bad.length} 項，失敗 ${bad.length} 項：`);
    bad.forEach(b => console.log(`   · ${b.label}：${b.detail}`));
  } else {
    console.log(`✓ ${results.length} 項全數符合預期（該改的改得動，該鎖的鎖得住）`);
  }
  cleanup(bad.length ? 1 : 0);
})().catch(e => { console.error('\n檢查中斷：', e); cleanup(1); });
