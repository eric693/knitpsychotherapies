// LINE 官方帳號（Messaging API）推播：預約通知、晤談提醒、心理師行程。
//
// 一律以 Flex Message 送出——手機上看得清楚，且按鈕可直接打電話或開個案專區。
// 未設定 Channel access token 時完全不對外連線，只把訊息內容記進 notifications
// 表供人工發送，行為與原本的 webhook 通道一致（不把個資送到未設定的外部服務）。
//
// 推播對象靠 clients.line_user_id / users.line_user_id；綁定流程見 routes/line.js。

const crypto = require('crypto');
const { db, getSetting, nowStamp } = require('./db');

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

function lineEnabled() { return !!getSetting('line_channel_token', '').trim(); }
function brandColor() {
  const c = getSetting('line_flex_color', '#0e7c7b').trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#0e7c7b';
}
function centerInfo() {
  return {
    name: getSetting('center_name', '織心心理治療所'),
    phone: getSetting('center_phone', ''),
    address: getSetting('center_address', '')
  };
}
// 卡片上的說明文字：所方可在「LINE 串接」頁改寫，留空就用這裡的預設。
// {center} 機構名稱、{phone} 電話、{hours} 取消期限時數、{name} 對方姓名，寫在文字裡即自動代入。
const TEXT_DEFAULTS = {
  line_text_help_intro: '點下方「開始預約」填寫表單，送出後我們會在這裡通知您預約結果與晤談提醒。',
  line_text_help_note: '已是本所個案並收到 6 碼綁定碼，直接在此輸入即可接收提醒。\n電話預約：{phone}\n如遇立即危機請撥 1925 或 119，本帳號非緊急聯絡管道。',
  line_text_bound: '{name} 您好，之後預約成立與晤談提醒都會透過這裡通知您。',
  line_text_bound_note: '本帳號僅提供預約與行政通知，不處理晤談內容；如遇立即危機請撥 1925 或 119。',
  line_text_request_intro: '我們將盡快與您確認，確認後會再以此通知您。',
  line_text_request_note: '此為預約申請，尚未成立。若急需協助請直接來電；如遇立即危機請撥 1925 或 119。',
  line_text_booked_note: '請提前 10 分鐘到所。如需改期或取消，請提前 {hours} 小時來電告知。',
  line_text_remind_note: '如需改期或取消，請提前 {hours} 小時來電；未於期限前告知者，本所得依公告收取部分費用。',
  line_text_receipt_note: '如需紙本收據或補印，請於下次晤談時或來電告知。'
};

// 取一段卡片文字：設定留空就用預設，再把 {center}／{phone}／{hours}／{name} 代進去。
// 代入後仍是空字串（例如沒填電話又整段只有電話）時回空字串，呼叫端據此決定要不要放這一段。
function msgText(key, vars = {}) {
  const c = centerInfo();
  const fill = { center: c.name, phone: c.phone, hours: getSetting('cancel_hours', '24'), ...vars };
  const raw = getSetting(key, '').trim() || TEXT_DEFAULTS[key] || '';
  return raw.split('\n')
    // 代入值是空的那一行整行拿掉（例如沒填電話時的「電話預約：{phone}」），不留半截句子
    .filter(line => (line.match(/\{(\w+)\}/g) || []).every(m => String(fill[m.slice(1, -1)] ?? '').trim()))
    .map(line => line.replace(/\{(\w+)\}/g, (m, k) => String(fill[k] ?? '')))
    .filter(line => line.trim())
    .join('\n');
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayOf(date) {
  const d = new Date(date + 'T00:00:00');
  return isNaN(d) ? '' : WEEKDAY[d.getDay()];
}

// ---- Flex 版型元件 ----------------------------------------------------------
// 只用 LINE 原生元件，不放圖片外連，避免圖床失效或洩漏來源。

function kv(label, value) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: label, color: '#8b97a2', size: 'sm', flex: 2 },
      { type: 'text', text: String(value || '-'), wrap: true, color: '#3b4a55', size: 'sm', flex: 5 }
    ]
  };
}
function sep() { return { type: 'separator', margin: 'md' }; }
function noteBox(text) {
  return {
    type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: '#f4f7f8',
    paddingAll: '10px', cornerRadius: '6px',
    contents: [{ type: 'text', text: String(text), wrap: true, size: 'xs', color: '#6b7a85' }]
  };
}
function actionButton(label, action, style = 'primary') {
  return { type: 'button', style, height: 'sm', color: style === 'primary' ? brandColor() : undefined, action };
}

// 卡片外框：標題列用主色，內容自行帶入
function card({ title, subtitle, body, footer, altText }) {
  return {
    type: 'flex',
    altText: altText || title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: brandColor(), paddingAll: '14px',
        contents: [
          { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'md' },
          ...(subtitle ? [{ type: 'text', text: subtitle, color: '#e6f2f2', size: 'xs', margin: 'xs', wrap: true }] : [])
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
      ...(footer && footer.length
        ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
        : {})
    }
  };
}

// ---- 各種訊息 --------------------------------------------------------------

// 預約申請已收到（尚未成立，等櫃檯確認）
function bookingReceivedFlex(b) {
  const c = centerInfo();
  return card({
    title: '已收到您的預約申請',
    subtitle: `${c.name}`,
    altText: `已收到預約申請：${b.date || '未指定日期'} ${b.start_time || ''}`,
    body: [
      { type: 'text', text: msgText('line_text_request_intro'), size: 'sm', color: '#3b4a55', wrap: true },
      sep(),
      kv('姓名', b.name),
      kv('方案', b.plan_name),
      ...(b.topic_name ? [kv('主題', b.topic_name)] : []),
      ...(b.counselor_name ? [kv('心理師', b.counselor_name)] : []),
      kv('希望時段', b.date ? `${b.date}（${weekdayOf(b.date)}）${b.start_time || ''}` : (b.alt_note || '由所方安排')),
      ...(b.fee ? [kv('您需支付', `NT$ ${Number(b.fee).toLocaleString('zh-TW')}`)] : []),
      noteBox(msgText('line_text_request_note'))
    ],
    footer: c.phone ? [actionButton('打電話給諮商所', { type: 'uri', label: '打電話給諮商所', uri: `tel:${c.phone}` })] : []
  });
}

// 個案專區網址：設定沒填時由線上預約表單網址推得，讓卡片上的「個案專區」按鈕
// 不必每個呼叫端各自帶一次，個案也才知道有這個地方可以看自己的預約。
function portalUrl() {
  const u = (getSetting('portal_public_url', '')
    || getSetting('booking_public_url', '').replace(/\/booking\.html.*$/, '/portal.html')).trim();
  return /^https?:\/\//.test(u) ? u : '';
}

// 預約成立
function bookingConfirmedFlex(a) {
  const c = centerInfo();
  const footer = [];
  if (a.meeting_url) footer.push(actionButton('進入視訊晤談', { type: 'uri', label: '進入視訊晤談', uri: a.meeting_url }));
  const portal = a.portal_url || portalUrl();
  if (portal) footer.push(actionButton('個案專區', { type: 'uri', label: '個案專區', uri: portal }, 'secondary'));
  if (c.phone) footer.push(actionButton('改期或取消請來電', { type: 'uri', label: '改期或取消請來電', uri: `tel:${c.phone}` }, 'secondary'));
  return card({
    title: '預約已成立',
    subtitle: c.name,
    altText: `預約已成立：${a.date}（${weekdayOf(a.date)}）${a.start_time}`,
    body: [
      { type: 'text', text: `${a.date}（${weekdayOf(a.date)}）${a.start_time}-${a.end_time}`,
        weight: 'bold', size: 'lg', color: '#3b4a55', wrap: true },
      sep(),
      kv('心理師', a.counselor_name),
      ...(a.plan_name ? [kv('方案', a.plan_name)] : []),
      ...(a.topic_name ? [kv('主題', a.topic_name)] : []),
      kv('形式', a.mode === 'online' ? '線上視訊' : '到所晤談'),
      ...(a.mode === 'online' ? [] : [kv('地點', c.address || c.name)]),
      ...(a.fee ? [kv('您需支付', `NT$ ${Number(a.self_pay !== undefined ? a.self_pay : a.fee).toLocaleString('zh-TW')}`
        + `${a.subsidy_amount ? `（方案另給付 ${a.subsidy_amount}）` : ''}`)] : []),
      noteBox(a.notice || msgText('line_text_booked_note'))
    ],
    footer
  });
}

// 晤談提醒（個案）
function reminderFlex(a) {
  const c = centerInfo();
  const footer = [];
  // 讓個案直接在提醒卡片上回覆是否前來：按下去以 postback 回傳，不需要打字。
  // 沒有 id（測試推播）時不放按鈕，避免按了找不到對應預約。
  if (a.id) {
    footer.push(actionButton('我會準時前往', { type: 'postback', label: '我會準時前往',
      data: `act=confirm&id=${a.id}`, displayText: '我會準時前往' }));
    footer.push(actionButton('需要改期或取消', { type: 'postback', label: '需要改期或取消',
      data: `act=change&id=${a.id}`, displayText: '需要改期或取消' }, 'secondary'));
  }
  if (a.meeting_url) footer.push(actionButton('進入視訊晤談', { type: 'uri', label: '進入視訊晤談', uri: a.meeting_url }));
  const rPortal = a.portal_url || portalUrl();
  if (rPortal) footer.push(actionButton('個案專區', { type: 'uri', label: '個案專區', uri: rPortal }, 'secondary'));
  if (c.phone) footer.push(actionButton('聯絡諮商所', { type: 'uri', label: '聯絡諮商所', uri: `tel:${c.phone}` }, 'secondary'));
  return card({
    title: '晤談提醒',
    subtitle: c.name,
    altText: `晤談提醒：${a.date}（${weekdayOf(a.date)}）${a.start_time}`,
    body: [
      { type: 'text', text: `${a.date}（${weekdayOf(a.date)}）${a.start_time}-${a.end_time}`,
        weight: 'bold', size: 'lg', color: '#3b4a55', wrap: true },
      sep(),
      kv('心理師', a.counselor_name),
      ...(a.plan_name ? [kv('方案', a.plan_name)] : []),
      kv('形式', a.mode === 'online' ? '線上視訊' : '到所晤談'),
      ...(a.mode === 'online' ? [] : [kv('地點', c.address || c.name)]),
      noteBox(msgText('line_text_remind_note'))
    ],
    footer
  });
}

// 心理師的每日行程（隔日）
function counselorScheduleFlex({ counselor_name, date, rows, title = '明日晤談行程' }) {
  const c = centerInfo();
  const lines = rows.length ? rows.map(r => ({
    type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: `${r.start_time}`, size: 'sm', color: brandColor(), flex: 2, weight: 'bold' },
      { type: 'text', text: `${r.client_name}（${r.client_code}）${r.plan_name ? '｜' + r.plan_name : ''}${r.mode === 'online' ? '｜視訊' : ''}`,
        size: 'sm', color: '#3b4a55', flex: 6, wrap: true }
    ]
  })) : [{ type: 'text', text: '這天沒有排定的晤談。', size: 'sm', color: '#8b97a2' }];
  return card({
    title,
    subtitle: `${date}（${weekdayOf(date)}）${counselor_name} 心理師`,
    altText: `${title}：${date} 共 ${rows.length} 場`,
    body: [
      { type: 'text', text: `共 ${rows.length} 場`, size: 'sm', color: '#8b97a2' },
      sep(),
      ...lines,
      ...(rows.some(r => r.risk_level === 'high')
        ? [noteBox('名單中有高風險個案，請留意安全計畫與危機資源。')] : [])
    ],
    footer: c.phone ? [] : []
  });
}

// 心理師收到新的預約申請／新排入的個案
function counselorBookingFlex({ counselor_name, b, kind = '新的預約申請' }) {
  return card({
    title: kind,
    subtitle: `${counselor_name} 心理師`,
    altText: `${kind}：${b.name} ${b.date || ''} ${b.start_time || ''}`,
    body: [
      kv('個案', b.name),
      kv('方案', b.plan_name),
      ...(b.topic_name ? [kv('主題', b.topic_name)] : []),
      kv('希望時段', b.date ? `${b.date}（${weekdayOf(b.date)}）${b.start_time || ''}` : (b.alt_note || '未指定')),
      ...(b.main_issue ? [kv('主訴', String(b.main_issue).slice(0, 60))] : []),
      ...(b.quota_note ? [noteBox(b.quota_note)] : [])
    ],
    footer: b.admin_url ? [actionButton('開啟後台處理', { type: 'uri', label: '開啟後台處理', uri: b.admin_url })] : []
  });
}

// 收據開立通知
function receiptFlex(r) {
  const c = centerInfo();
  return card({
    title: '收據已開立',
    subtitle: c.name,
    altText: `收據 ${r.receipt_no}　NT$ ${r.amount}`,
    body: [
      kv('收據編號', r.receipt_no),
      kv('日期', r.date),
      kv('項目', r.item),
      kv('金額', `NT$ ${Number(r.amount).toLocaleString('zh-TW')}`),
      ...(r.title ? [kv('抬頭', r.title)] : []),
      noteBox(msgText('line_text_receipt_note'))
    ]
  });
}

function textMessage(text) { return { type: 'text', text: String(text).slice(0, 4900) }; }

// ---- 送出 ------------------------------------------------------------------

function logNotification({ kind, client_id, appointment_id, channel, target, content, status, error, user, payload }) {
  const info = db.prepare(`INSERT INTO notifications
      (kind, client_id, appointment_id, channel, target, content, status, error, sent_by, payload)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(kind, client_id || null, appointment_id || null, channel,
    target || '', content || '', status, error || '', user ? user.id : null,
    payload ? JSON.stringify(payload).slice(0, 20000) : '');
  return info.lastInsertRowid;
}

// 重送一則失敗的推播：用當初存下來的訊息內容再打一次，成功就把該筆改為已送出
async function retryNotification(id, user) {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  if (!n) return { ok: false, error: '找不到此通知' };
  if (n.status === 'sent') return { ok: false, error: '這筆已經送出過了' };
  if (!lineEnabled()) return { ok: false, error: '尚未設定 LINE 權杖，無法重送' };
  if (!n.target) return { ok: false, error: '沒有收件對象（對方尚未綁定 LINE）' };
  let flex = null;
  try { flex = n.payload ? JSON.parse(n.payload) : null; } catch { flex = null; }
  const message = flex || textMessage(n.content || '（原訊息內容未保存）');
  const r = await callLine(PUSH_URL, { to: n.target, messages: [message] });
  db.prepare(`UPDATE notifications SET status = ?, error = ?, retry_count = retry_count + 1,
      last_retry_at = datetime('now','localtime') WHERE id = ?`)
    .run(r.ok ? 'sent' : 'failed', r.error || '', n.id);
  if (user) {
    db.prepare('UPDATE notifications SET sent_by = ? WHERE id = ?').run(user.id, n.id);
  }
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// 自動重試：每日維護時把最近失敗、重試未滿上限的再送一次（每筆最多 3 次）
async function retryFailedNotifications(max = 20) {
  if (!lineEnabled()) return { tried: 0, sent: 0 };
  const rows = db.prepare(`SELECT id FROM notifications
    WHERE status = 'failed' AND resolved = 0 AND retry_count < 3 AND target != ''
      AND created_at >= datetime('now','localtime','-3 days')
    ORDER BY id DESC LIMIT ?`).all(max);
  let sent = 0;
  for (const r of rows) {
    const out = await retryNotification(r.id, null);
    if (out.ok) sent++;
  }
  return { tried: rows.length, sent };
}

async function callLine(url, body) {
  const token = getSetting('line_channel_token', '').trim();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (!resp.ok) {
      const t = (await resp.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `LINE HTTP ${resp.status} ${t}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'LINE 連線逾時' : String(e.message || e).slice(0, 200) };
  } finally { clearTimeout(timer); }
}

// 推播一則 Flex 給某個 LINE 使用者。
// to 為空（未綁定）或未設定 token 時不對外連線，只記為待人工發送。
async function pushFlex({ to, flex, kind = 'line', client_id = null, appointment_id = null, user = null, summary = '' }) {
  const content = summary || (flex && flex.altText) || '';
  if (!lineEnabled()) {
    logNotification({ kind, client_id, appointment_id, channel: 'manual', target: to, content, status: 'manual' });
    return { status: 'manual', message: '尚未設定 LINE official 帳號，已記錄為待人工通知' };
  }
  if (!to) {
    logNotification({ kind, client_id, appointment_id, channel: 'line', target: '', content,
      status: 'failed', error: '尚未綁定 LINE' });
    return { status: 'failed', message: '對方尚未綁定 LINE 官方帳號' };
  }
  const r = await callLine(PUSH_URL, { to, messages: [flex] });
  logNotification({ kind, client_id, appointment_id, channel: 'line', target: to, content,
    status: r.ok ? 'sent' : 'failed', error: r.error, user, payload: flex });
  return r.ok ? { status: 'sent', message: '已以 LINE 推播' } : { status: 'failed', message: r.error };
}

async function replyMessages(replyToken, messages) {
  if (!lineEnabled() || !replyToken) return { ok: false };
  return callLine(REPLY_URL, { replyToken, messages });
}

// Webhook 簽章驗證：LINE 以 channel secret 對 raw body 做 HMAC-SHA256。
// 驗不過就當作不是 LINE 送來的，直接丟掉。
function verifySignature(rawBody, signature) {
  const secret = getSetting('line_channel_secret', '').trim();
  if (!secret || !signature) return false;
  const mac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(mac), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  lineEnabled, weekdayOf, centerInfo,
  card, kv, noteBox, actionButton, textMessage, msgText, TEXT_DEFAULTS,
  bookingReceivedFlex, bookingConfirmedFlex, reminderFlex, portalUrl,
  counselorScheduleFlex, counselorBookingFlex, receiptFlex,
  pushFlex, replyMessages, verifySignature, logNotification,
  retryNotification, retryFailedNotifications
};
