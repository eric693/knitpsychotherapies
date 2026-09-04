// LINE 官方帳號：綁定、Webhook、以及各種 Flex 推播的觸發點。
//
// 綁定流程刻意不讓櫃檯手抄 userId：
//   後台為個案／心理師產生 6 碼驗證碼 → 對方在官方帳號輸入 → Webhook 收到後完成綁定。
// 驗證碼有效期預設 1 天，用過即失效。

const express = require('express');
const crypto = require('crypto');
const { db, audit, today, addDays, getSetting, setSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const line = require('../line');

const router = express.Router();

// ---- Webhook（LINE 平台呼叫，免登入，靠簽章驗證）----
router.post('/line/webhook', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  if (!line.verifySignature(raw, req.headers['x-line-signature'])) {
    // 簽章不符就當作不是 LINE 送來的，直接忽略（仍回 200，避免對方持續重送）
    return res.status(200).end();
  }
  const events = (req.body && req.body.events) || [];
  for (const ev of events) {
    try { await handleEvent(ev); } catch (e) { console.error('LINE webhook 處理失敗：', e.message); }
  }
  res.json({ ok: true });
});

function bindingWelcome(name) {
  return line.card({
    title: '綁定完成',
    subtitle: getSetting('center_name'),
    altText: '綁定完成',
    body: [
      { type: 'text', size: 'sm', wrap: true, color: '#3b4a55',
        text: `${name} 您好，之後預約成立與晤談提醒都會透過這裡通知您。` },
      line.noteBox('本帳號僅提供預約與行政通知，不處理晤談內容；如遇立即危機請撥 1925 或 119。')
    ]
  });
}

// 個案在官方帳號要預約時，發給他一條「只屬於這個人」的表單連結：
// 網址帶的是隨機 token，表單送出時由後端換回 LINE userId，
// 預約成立、提醒與收據才推得回同一個人，過程中 userId 不會出現在網址列。
function bookingLinkFor(lineUserId) {
  const base = getSetting('booking_public_url', '').trim();
  if (!base) return '';
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO booking_links (token, line_user_id, expires_at) VALUES (?,?,?)')
    .run(token, lineUserId, addDays(today(), 3));
  return `${base}${base.includes('?') ? '&' : '?'}bk=${token}`;
}

function helpFlex(lineUserId) {
  const url = lineUserId ? bookingLinkFor(lineUserId) : getSetting('booking_public_url', '');
  const phone = getSetting('center_phone', '');
  return line.card({
    title: getSetting('center_name'),
    subtitle: '線上預約與提醒',
    altText: '線上預約',
    body: [
      { type: 'text', size: 'sm', wrap: true, color: '#3b4a55',
        text: '點下方「開始預約」填寫表單，送出後我們會在這裡通知您預約結果與晤談提醒。' },
      line.noteBox('已是本所個案並收到 6 碼綁定碼，直接在此輸入即可接收提醒。\n'
        + (phone ? `電話預約：${phone}\n` : '')
        + '如遇立即危機請撥 1925 或 119，本帳號非緊急聯絡管道。')
    ],
    footer: [
      ...(url ? [line.actionButton('開始預約', { type: 'uri', label: '開始預約', uri: url })] : []),
      ...(phone ? [line.actionButton('打電話給諮商所', { type: 'uri', label: '打電話給諮商所', uri: `tel:${phone}` }, 'secondary')] : [])
    ]
  });
}

async function handleEvent(ev) {
  const lineUserId = ev.source && ev.source.userId;
  if (!lineUserId) return;

  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    const text = String(ev.message.text || '').trim();
    const code = (text.match(/\d{6}/) || [])[0];
    if (code) {
      const bind = db.prepare("SELECT * FROM line_bindings WHERE code = ? AND status = 'pending'").get(code);
      if (bind && (!bind.expires_at || bind.expires_at >= today())) {
        const name = bind.client_id
          ? (db.prepare('SELECT name FROM clients WHERE id = ?').get(bind.client_id) || {}).name
          : (db.prepare('SELECT name FROM users WHERE id = ?').get(bind.user_id) || {}).name;
        if (bind.client_id) db.prepare('UPDATE clients SET line_user_id = ? WHERE id = ?').run(lineUserId, bind.client_id);
        if (bind.user_id) db.prepare('UPDATE users SET line_user_id = ? WHERE id = ?').run(lineUserId, bind.user_id);
        db.prepare("UPDATE line_bindings SET status = 'done', line_user_id = ?, bound_at = ? WHERE id = ?")
          .run(lineUserId, nowStamp(), bind.id);
        audit('system', null, 'LINE', '完成 LINE 綁定', String(bind.client_id || bind.user_id || ''));
        await line.replyMessages(ev.replyToken, [bindingWelcome(name || '您')]);
        return;
      }
      await line.replyMessages(ev.replyToken, [line.textMessage('綁定碼不正確或已失效，請向諮商所索取新的綁定碼。')]);
      return;
    }
    await line.replyMessages(ev.replyToken, [helpFlex(lineUserId)]);
    return;
  }

  // 晤談提醒卡片上的「我會準時前往／需要改期」——個案按一下就回覆，不必打字也不必打電話。
  if (ev.type === 'postback') {
    const data = new URLSearchParams(String((ev.postback && ev.postback.data) || ''));
    const act = data.get('act');
    const id = Number(data.get('id')) || 0;
    const client = db.prepare('SELECT * FROM clients WHERE line_user_id = ? AND active = 1').get(lineUserId);
    const appt = id ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(id) : null;
    // 只認自己的預約：換人綁定或轉傳卡片都動不到別人的資料
    if (!client || !appt || appt.client_id !== client.id) {
      await line.replyMessages(ev.replyToken, [line.textMessage('這筆預約已經有變動，請直接來電與我們確認。')]);
      return;
    }
    if (appt.status !== 'booked' && appt.status !== 'arrived') {
      await line.replyMessages(ev.replyToken, [line.textMessage('這筆晤談已不在預約狀態，若有疑問請來電洽詢。')]);
      return;
    }
    if (act === 'confirm') {
      db.prepare('UPDATE appointments SET confirmed_at = ? WHERE id = ?').run(nowStamp(), appt.id);
      audit('client', client.id, client.name, '以 LINE 確認出席', client.code, { id: appt.id });
      await line.replyMessages(ev.replyToken, [line.textMessage(
        `已為您記錄：${appt.date} ${appt.start_time} 準時前往，我們到時見。`)]);
      return;
    }
    if (act === 'change') {
      // 改期不在 LINE 上直接改（要看空檔與收費規則），改為記下申請並提醒櫃檯
      db.prepare(`UPDATE appointments SET cancel_requested_at = ?,
          cancel_request_reason = CASE WHEN cancel_request_reason = '' THEN 'LINE 回覆需要改期或取消' ELSE cancel_request_reason END
        WHERE id = ?`).run(nowStamp(), appt.id);
      audit('client', client.id, client.name, '以 LINE 提出改期／取消', client.code, { id: appt.id });
      const phone = getSetting('center_phone', '');
      await line.replyMessages(ev.replyToken, [line.textMessage(
        `已收到您的改期／取消需求（${appt.date} ${appt.start_time}），櫃檯會與您聯繫。`
        + (phone ? `\n急需處理請直接來電 ${phone}。` : ''))]);
      return;
    }
    await line.replyMessages(ev.replyToken, [line.textMessage('收到，若需協助請直接來電。')]);
    return;
  }

  // 加好友當下就給預約入口，個案不必再問「要怎麼預約」
  if (ev.type === 'follow') {
    await line.replyMessages(ev.replyToken, [helpFlex(lineUserId)]);
  }
}

// ---- 後台：串接設定 ----
//
// 所方在這裡貼上 LINE Developers 後台的 Channel access token 與 Channel secret，
// 按「驗證連線」確認打得通，再按「設定 Webhook」把回呼網址寫回 LINE，
// 綁定與自動回覆就會生效，不必自己到 LINE 後台貼網址。

const LINE_SETTING_KEYS = ['line_official_name', 'line_official_id', 'line_add_friend_url', 'line_reminder_hours',
  'line_counselor_daily_enabled', 'line_counselor_daily_time', 'line_flex_color', 'booking_public_url'];
const MASK = '••••••••';

function maskSecret(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  return `${MASK}${t.slice(-4)}`;
}
function webhookUrl(req) {
  const base = getSetting('booking_public_url', '').replace(/\/booking\.html.*$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/line/webhook`;
}

router.get('/line/settings', requireStaff('settings'), (req, res) => {
  const out = { webhook_url: webhookUrl(req), enabled: line.lineEnabled() };
  for (const k of LINE_SETTING_KEYS) out[k] = getSetting(k, '');
  // 權杖與密鑰只回傳遮罩後的尾碼，畫面上看得出「有沒有填、是不是同一組」，但不外流內容
  out.line_channel_token = maskSecret(getSetting('line_channel_token', ''));
  out.line_channel_secret = maskSecret(getSetting('line_channel_secret', ''));
  res.json(out);
});

router.put('/line/settings', requireStaff('settings'), (req, res) => {
  const b = req.body || {};
  for (const k of LINE_SETTING_KEYS) if (b[k] !== undefined) setSetting(k, String(b[k]));
  // 遮罩值代表「沒改」，直接略過；要清空請送空字串
  for (const k of ['line_channel_token', 'line_channel_secret']) {
    if (b[k] === undefined) continue;
    const v = String(b[k]).trim();
    if (v.startsWith(MASK)) continue;
    setSetting(k, v);
  }
  audit('staff', req.user.id, req.user.name, '修改 LINE 串接設定', '',
    Object.keys(b).filter(k => !/token|secret/.test(k)).join(','));
  res.json({ ok: true, enabled: line.lineEnabled() });
});

// 驗證連線：向 LINE 取官方帳號資訊，確認權杖有效
router.post('/line/verify', requireStaff('settings'), async (req, res) => {
  const token = getSetting('line_channel_token', '').trim();
  if (!token) return res.status(400).json({ error: '尚未填入 Channel access token' });
  try {
    const r = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(400).json({ error: `LINE 回覆 HTTP ${r.status}：${d.message || '權杖可能已失效'}` });
    }
    audit('staff', req.user.id, req.user.name, 'LINE 連線驗證', d.basicId || '');
    res.json({ ok: true, basic_id: d.basicId, display_name: d.displayName, premium_id: d.premiumId });
  } catch (e) {
    res.status(400).json({ error: '無法連線至 LINE：' + String(e.message || e).slice(0, 120) });
  }
});

// 把 Webhook 網址寫回 LINE，並請 LINE 實際打一次回來確認通得過
router.post('/line/webhook-endpoint', requireStaff('settings'), async (req, res) => {
  const token = getSetting('line_channel_token', '').trim();
  if (!token) return res.status(400).json({ error: '尚未填入 Channel access token' });
  if (!getSetting('line_channel_secret', '').trim()) {
    return res.status(400).json({ error: '尚未填入 Channel secret，Webhook 無法驗證簽章' });
  }
  const url = String((req.body || {}).url || webhookUrl(req));
  if (!/^https:\/\/\S+$/.test(url)) return res.status(400).json({ error: 'Webhook 網址必須是 https 開頭' });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const put = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
      method: 'PUT', headers, body: JSON.stringify({ endpoint: url })
    });
    if (!put.ok) {
      const d = await put.json().catch(() => ({}));
      return res.status(400).json({ error: `設定 Webhook 失敗（HTTP ${put.status}）：${d.message || ''}` });
    }
    const test = await fetch('https://api.line.me/v2/bot/channel/webhook/test', {
      method: 'POST', headers, body: JSON.stringify({ endpoint: url })
    });
    const td = await test.json().catch(() => ({}));
    audit('staff', req.user.id, req.user.name, '設定 LINE Webhook', url);
    res.json({
      ok: true, url,
      reachable: !!(td && td.success),
      detail: td && td.detail ? String(td.detail) : (td.success ? '連線正常' : '已設定，但 LINE 測試未通過，請確認網域可對外連線')
    });
  } catch (e) {
    res.status(400).json({ error: '無法連線至 LINE：' + String(e.message || e).slice(0, 120) });
  }
});

// 綁定情形一覽：誰綁了、誰還沒綁，直接在這裡發綁定碼或解除
router.get('/line/bindings', requireStaff(), (req, res) => {
  // 個案可能上百位，因此支援關鍵字（姓名／編號／電話）與綁定狀態篩選
  const q = String(req.query.q || '').trim();
  const filter = ['bound', 'unbound'].includes(req.query.filter) ? req.query.filter : '';
  const where = ['active = 1'];
  const args = [];
  if (q) {
    where.push('(name LIKE ? OR code LIKE ? OR phone LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (filter === 'bound') where.push("IFNULL(line_user_id,'') <> ''");
  if (filter === 'unbound') where.push("IFNULL(line_user_id,'') = ''");
  const clientRows = db.prepare(`SELECT id, code, name, phone, line_user_id FROM clients
    WHERE ${where.join(' AND ')} ORDER BY IFNULL(line_user_id,'') = '' DESC, id DESC LIMIT 200`).all(...args);
  const clientTotal = db.prepare(`SELECT COUNT(*) n FROM clients WHERE ${where.join(' AND ')}`).get(...args).n;
  // 綁定時間取自綁定紀錄，讓櫃檯判斷這組綁定是什麼時候建立的
  const boundAt = id => (db.prepare(`SELECT bound_at FROM line_bindings
    WHERE status = 'done' AND ${id.client ? 'client_id' : 'user_id'} = ?
    ORDER BY id DESC LIMIT 1`).get(id.client || id.user) || {}).bound_at || '';
  res.json({
    staff: db.prepare(`SELECT id, name, title, role, line_user_id FROM users
      WHERE active = 1 AND role IN ('counselor','supervisor','admin','staff') ORDER BY id`).all()
      .map(u => ({
        id: u.id, name: u.name, title: u.title, role: u.role,
        bound: !!u.line_user_id, bound_at: u.line_user_id ? boundAt({ user: u.id }) : ''
      })),
    clients: clientRows.map(c => ({
      id: c.id, code: c.code, name: c.name, phone: c.phone,
      bound: !!c.line_user_id, bound_at: c.line_user_id ? boundAt({ client: c.id }) : ''
    })),
    client_total: clientTotal,
    pending: db.prepare(`SELECT b.id, b.code, b.expires_at, b.created_at,
        c.name AS client_name, u.name AS user_name, b.user_id
      FROM line_bindings b LEFT JOIN clients c ON c.id = b.client_id LEFT JOIN users u ON u.id = b.user_id
      WHERE b.status = 'pending' AND b.expires_at >= ? ORDER BY b.id DESC LIMIT 50`).all(today())
  });
});

// ---- 後台：綁定管理 ----

router.post('/line/bind-code', requireStaff(), (req, res) => {
  const b = req.body || {};
  const clientId = Number(b.client_id) || null;
  const userId = Number(b.user_id) || null;
  if (!clientId && !userId) return res.status(400).json({ error: '請指定個案或心理師' });
  // 心理師只能替自己產生綁定碼，除非有帳號管理權限
  if (userId && userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能為自己產生綁定碼' });
  }
  // 同一對象只留最新一組碼：舊的先作廢，免得兩組碼同時流通說不清哪組有效
  db.prepare(`UPDATE line_bindings SET status = 'expired'
    WHERE status = 'pending' AND ${clientId ? 'client_id' : 'user_id'} = ?`).run(clientId || userId);
  const code = String(crypto.randomInt(100000, 999999));
  db.prepare(`INSERT INTO line_bindings (code, client_id, user_id, expires_at) VALUES (?,?,?,?)`)
    .run(code, clientId, userId, addDays(today(), 1));
  audit('staff', req.user.id, req.user.name, '產生 LINE 綁定碼', String(clientId || userId));
  res.json({ code, expires_at: addDays(today(), 1), add_friend_url: getSetting('line_add_friend_url') });
});

// 心理師自助綁定：加好友後若沒綁定，系統只把他當一般民眾回覆預約說明，
// 收不到自己的行程推播。這支讓本人在「我的工作台」直接拿到碼與帶碼的聊天室連結。
router.get('/my/line', requireStaff(), (req, res) => {
  const u = db.prepare('SELECT line_user_id FROM users WHERE id = ?').get(req.user.id) || {};
  const enabled = !!getSetting('line_channel_token');
  const out = {
    enabled,
    bound: !!u.line_user_id,
    official_name: getSetting('line_official_name', ''),
    add_friend_url: getSetting('line_add_friend_url', ''),
    daily_time: getSetting('line_counselor_daily_time', '20:00'),
    daily_enabled: getSetting('line_counselor_daily_enabled', '1') === '1'
  };
  if (!enabled || out.bound) return res.json(out);
  let bind = db.prepare(`SELECT code, expires_at FROM line_bindings
    WHERE user_id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at >= date('now','localtime'))
    ORDER BY id DESC LIMIT 1`).get(req.user.id);
  if (!bind) {
    db.prepare("UPDATE line_bindings SET status = 'expired' WHERE status = 'pending' AND user_id = ?")
      .run(req.user.id);
    const expires_at = addDays(today(), 1);
    const ins = db.prepare('INSERT INTO line_bindings (code, user_id, expires_at) VALUES (?,?,?)');
    for (let i = 0; i < 10 && !bind; i++) {
      const code = String(crypto.randomInt(100000, 1000000));
      try { ins.run(code, req.user.id, expires_at); bind = { code, expires_at }; }
      catch (e) { if (i === 9) throw e; }
    }
  }
  const oa = getSetting('line_official_id', '');
  res.json({
    ...out, code: bind.code, expires_at: bind.expires_at,
    message_url: oa ? `https://line.me/R/oaMessage/${encodeURIComponent(oa)}/?${encodeURIComponent(bind.code)}` : ''
  });
});
router.delete('/my/line', requireStaff(), (req, res) => {
  db.prepare("UPDATE users SET line_user_id = '' WHERE id = ?").run(req.user.id);
  db.prepare("UPDATE line_bindings SET status = 'revoked' WHERE user_id = ? AND status = 'done'").run(req.user.id);
  audit('staff', req.user.id, req.user.name, '解除自己的 LINE 綁定');
  res.json({ ok: true });
});

// 作廢還沒被使用的綁定碼（發錯人、或對方說沒收到要重發）
router.delete('/line/bind-code/:id', requireStaff(), (req, res) => {
  const row = db.prepare("SELECT * FROM line_bindings WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到待使用的綁定碼' });
  if (row.user_id && row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能作廢自己的綁定碼' });
  }
  db.prepare("UPDATE line_bindings SET status = 'expired' WHERE id = ?").run(row.id);
  audit('staff', req.user.id, req.user.name, '作廢 LINE 綁定碼', String(row.client_id || row.user_id || ''));
  res.json({ ok: true });
});

router.delete('/line/binding', requireStaff(), (req, res) => {
  const clientId = Number(req.query.client_id) || 0;
  const userId = Number(req.query.user_id) || 0;
  if (userId && userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能解除自己的綁定' });
  }
  if (!clientId && !userId) return res.status(400).json({ error: '請指定個案或心理師' });
  if (clientId) db.prepare("UPDATE clients SET line_user_id = '' WHERE id = ?").run(clientId);
  if (userId) db.prepare("UPDATE users SET line_user_id = '' WHERE id = ?").run(userId);
  // 綁定紀錄一併標為已解除，並作廢同一對象未使用的碼，狀態才不會前後矛盾
  db.prepare(`UPDATE line_bindings SET status = 'revoked'
    WHERE status = 'done' AND ${clientId ? 'client_id' : 'user_id'} = ?`).run(clientId || userId);
  db.prepare(`UPDATE line_bindings SET status = 'expired'
    WHERE status = 'pending' AND ${clientId ? 'client_id' : 'user_id'} = ?`).run(clientId || userId);
  audit('staff', req.user.id, req.user.name, '解除 LINE 綁定', String(clientId || userId));
  res.json({ ok: true });
});

router.get('/line/status', requireStaff(), (req, res) => {
  res.json({
    enabled: line.lineEnabled(),
    official_name: getSetting('line_official_name'),
    add_friend_url: getSetting('line_add_friend_url'),
    reminder_hours: Number(getSetting('line_reminder_hours', '24')),
    daily_enabled: getSetting('line_counselor_daily_enabled', '1') === '1',
    daily_time: getSetting('line_counselor_daily_time', '20:00'),
    me_bound: !!req.user.line_user_id,
    clients_bound: db.prepare("SELECT COUNT(*) n FROM clients WHERE line_user_id != '' AND active = 1").get().n,
    clients_total: db.prepare('SELECT COUNT(*) n FROM clients WHERE active = 1').get().n,
    staff_bound: db.prepare("SELECT COUNT(*) n FROM users WHERE line_user_id != '' AND active = 1").get().n,
    recent: db.prepare(`SELECT n.*, c.name AS client_name FROM notifications n
      LEFT JOIN clients c ON c.id = n.client_id
      WHERE n.channel IN ('line','manual') ORDER BY n.id DESC LIMIT 50`).all()
  });
});

// 未送出的推播：沒設定權杖時記成「待人工發送」，送失敗的則留下錯誤訊息。
// 這張清單是為了「不要靜靜地漏掉提醒」，可逐筆重送或標記為已人工處理。
router.get('/notifications/failed', requireStaff('messages'), (req, res) => {
  const rows = db.prepare(`SELECT n.*, c.name AS client_name, c.code AS client_code
    FROM notifications n LEFT JOIN clients c ON c.id = n.client_id
    WHERE n.status IN ('failed','manual') AND n.resolved = 0
    ORDER BY n.id DESC LIMIT 200`).all();
  res.json({
    rows,
    line_enabled: line.lineEnabled(),
    failed: rows.filter(r => r.status === 'failed').length,
    manual: rows.filter(r => r.status === 'manual').length
  });
});

router.post('/notifications/:id/retry', requireStaff('messages'), async (req, res) => {
  const r = await line.retryNotification(Number(req.params.id), req.user);
  if (!r.ok) return res.status(400).json({ error: r.error });
  audit('staff', req.user.id, req.user.name, '重送通知', String(req.params.id));
  res.json({ ok: true });
});

// 標記為已人工處理（例如已改用電話通知），不再列在待處理清單
router.post('/notifications/:id/resolve', requireStaff('messages'), (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此通知' });
  const on = n.resolved ? 0 : 1;
  db.prepare('UPDATE notifications SET resolved = ? WHERE id = ?').run(on, n.id);
  audit('staff', req.user.id, req.user.name, on ? '標記通知已處理' : '取消通知已處理', String(n.id));
  res.json({ ok: true, resolved: on });
});

// ---- 推播：晤談提醒（個案）----

function apptForFlex(id) {
  return db.prepare(`SELECT a.*, c.name AS client_name, c.code AS client_code, c.line_user_id,
      c.risk_level, u.name AS counselor_name, p.name AS plan_name, t.name AS topic_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    WHERE a.id = ?`).get(id);
}

router.post('/line/remind/:id', requireStaff('schedule'), async (req, res) => {
  const a = apptForFlex(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  const out = await line.pushFlex({
    to: a.line_user_id, flex: line.reminderFlex(a), kind: 'reminder',
    client_id: a.client_id, appointment_id: a.id, user: req.user
  });
  if (out.status === 'sent') db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
  res.json(out);
});

// 整批推播某日的晤談提醒（預設明日）
router.post('/line/remind-batch', requireStaff('schedule'), async (req, res) => {
  const date = String((req.body || {}).date || addDays(today(), 1));
  const rows = db.prepare(`SELECT a.id FROM appointments a WHERE a.date = ? AND a.status = 'booked'`).all(date);
  const results = [];
  for (const r of rows) {
    const a = apptForFlex(r.id);
    const out = await line.pushFlex({
      to: a.line_user_id, flex: line.reminderFlex(a), kind: 'reminder',
      client_id: a.client_id, appointment_id: a.id, user: req.user
    });
    if (out.status === 'sent') db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
    results.push({ id: a.id, client_name: a.client_name, ...out });
  }
  audit('staff', req.user.id, req.user.name, 'LINE 批次晤談提醒', date, { count: results.length });
  res.json({ date, count: results.length,
    sent: results.filter(r => r.status === 'sent').length, results });
});

// ---- 推播：心理師行程 ----

function counselorSchedule(counselorId, date) {
  return db.prepare(`SELECT a.start_time, a.end_time, a.mode, c.name AS client_name, c.code AS client_code,
      c.risk_level, p.name AS plan_name
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    WHERE a.counselor_id = ? AND a.date = ? AND a.status IN ('booked','arrived')
    ORDER BY a.start_time`).all(counselorId, date);
}

async function pushCounselorDay(counselor, date, title) {
  const rows = counselorSchedule(counselor.id, date);
  return line.pushFlex({
    to: counselor.line_user_id, kind: 'staff_schedule',
    flex: line.counselorScheduleFlex({ counselor_name: counselor.name, date, rows, title }),
    summary: `${title}：${date} 共 ${rows.length} 場`
  });
}

router.post('/line/counselor-schedule', requireStaff('schedule'), async (req, res) => {
  const b = req.body || {};
  const date = String(b.date || addDays(today(), 1));
  const targets = b.counselor_id
    ? db.prepare('SELECT id, name, line_user_id FROM users WHERE id = ?').all(Number(b.counselor_id))
    : db.prepare(`SELECT id, name, line_user_id FROM users WHERE active = 1
        AND role IN ('counselor','supervisor','admin') AND line_user_id != ''`).all();
  const results = [];
  for (const u of targets) {
    const rows = counselorSchedule(u.id, date);
    if (!rows.length && !b.include_empty) continue;
    results.push({ counselor: u.name, ...(await pushCounselorDay(u, date, b.title || '晤談行程')) });
  }
  audit('staff', req.user.id, req.user.name, 'LINE 推播心理師行程', date, { count: results.length });
  res.json({ date, results });
});

// 心理師自己測試：確認綁定與卡片樣式
router.post('/line/test', requireStaff(), async (req, res) => {
  if (!req.user.line_user_id) return res.status(400).json({ error: '您尚未綁定 LINE 官方帳號' });
  const out = await pushCounselorDay(req.user, String((req.body || {}).date || addDays(today(), 1)), '晤談行程（測試）');
  res.json(out);
});

// ---- 排程：每日自動推播 ----
// server.js 每 10 分鐘呼叫一次；到了設定時間且當天尚未推過就送出。
let lastDailyRun = '';
async function runDailyPush() {
  if (getSetting('line_counselor_daily_enabled', '1') !== '1' || !line.lineEnabled()) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const at = getSetting('line_counselor_daily_time', '20:00');
  const day = today();
  if (lastDailyRun === day || hhmm < at) return;
  lastDailyRun = day;
  const date = addDays(day, 1);
  const staff = db.prepare(`SELECT id, name, line_user_id FROM users
    WHERE active = 1 AND role IN ('counselor','supervisor','admin') AND line_user_id != ''`).all();
  for (const u of staff) {
    const rows = counselorSchedule(u.id, date);
    if (!rows.length) continue;
    try { await pushCounselorDay(u, date, '明日晤談行程'); } catch (e) { console.error('LINE 行程推播失敗：', e.message); }
  }
  // 個案的晤談提醒：依設定的提前時數，推明天有晤談且尚未提醒過的個案
  const hours = Number(getSetting('line_reminder_hours', '24'));
  if (hours >= 12) {
    const appts = db.prepare(`SELECT id FROM appointments WHERE date = ? AND status = 'booked' AND reminded_at = ''`).all(date);
    for (const r of appts) {
      const a = apptForFlex(r.id);
      if (!a || !a.line_user_id) continue;
      try {
        const out = await line.pushFlex({ to: a.line_user_id, flex: line.reminderFlex(a), kind: 'reminder',
          client_id: a.client_id, appointment_id: a.id });
        if (out.status === 'sent') db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
      } catch (e) { console.error('LINE 晤談提醒失敗：', e.message); }
    }
  }
}

module.exports = router;
module.exports.runDailyPush = runDailyPush;
