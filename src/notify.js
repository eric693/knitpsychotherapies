const { db, getSetting, audit } = require('./db');

// 對外提醒發送。
//
// 有兩條可用的通道，這支負責在送出當下決定走哪一條：
//   line     官方帳號（Messaging API）直接推給已綁定的個案 —— 免費、看得到已讀、可附按鈕
//   webhook  所方自家簡訊商／自建 bot 的接收網址，系統以 JSON POST 過去由對方發送
// 都不適用時記為「待人工發送」，訊息仍留在紀錄裡供櫃檯自己貼。
//
// 通道由系統設定的「提醒發送通道」決定：
//   auto     已綁定 LINE 的走 LINE，其餘走 webhook（預設，也是多數所方的實際做法）
//   line     只用 LINE；沒綁定的記為人工，不送簡訊
//   webhook  只用 webhook，不論有沒有綁 LINE
//   manual   一律人工
//
// 送出內容刻意只帶姓名、電話與訊息本文，不含晤談紀錄等敏感欄位。

// LINE 發的是「櫃檯畫面上那段文字」而不是提醒卡片：櫃檯常會臨時改一句
// （例如加上「今天下雨請提早出門」），送出的內容要跟他看到的一致。
// 排程自動推的那條仍用 Flex 卡片（帶「我會準時前往／需要改期」按鈕），兩者用途不同。
async function sendViaLine({ to, content, kind, client_id, appointment_id }) {
  const line = require('./line');
  return line.pushText({ to, text: content, kind, client_id, appointment_id });
}

async function sendNotification({ kind = 'reminder', client_id = null, appointment_id = null,
  target = '', content = '', user = null }) {
  const url = getSetting('notify_webhook_url', '').trim();
  const token = getSetting('notify_webhook_token', '').trim();
  // 設定值打錯時退回 auto，而不是靜悄悄地變成「只走 webhook」——
  // 通道選錯的後果是個案收不到提醒，不能靠猜
  const raw = getSetting('notify_channel', 'auto');
  const mode = ['auto', 'line', 'webhook', 'manual'].includes(raw) ? raw : 'auto';
  const insert = (channel, status, error) => db.prepare(`INSERT INTO notifications
    (kind, client_id, appointment_id, channel, target, content, status, error, sent_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(kind, client_id, appointment_id, channel, target, content,
    status, error, user ? user.id : null).lastInsertRowid;

  // ---- LINE 優先 ----
  const lineUserId = client_id
    ? (db.prepare('SELECT line_user_id FROM clients WHERE id = ?').get(client_id) || {}).line_user_id
    : '';
  const lineUsable = require('./line').lineEnabled() && lineUserId;
  if ((mode === 'auto' || mode === 'line') && lineUsable) {
    const out = await sendViaLine({ to: lineUserId, content, kind, client_id, appointment_id });
    if (out.status === 'sent') {
      if (user) audit('staff', user.id, user.name, '發送提醒（LINE）', String(client_id || ''), { kind });
      return { channel: 'line', status: 'sent', message: '已由官方帳號送出' };
    }
    // LINE 送失敗：auto 模式退回 webhook，只用 LINE 的模式就據實回報，不悄悄改走簡訊
    if (mode === 'line') {
      return { channel: 'line', status: 'failed', message: `LINE 發送失敗：${out.error || '未知原因'}` };
    }
  }
  if (mode === 'line') {
    // 分清楚是「所方還沒接 LINE」還是「這個人沒綁定」——兩者要做的事完全不同
    const why = require('./line').lineEnabled() ? '個案尚未綁定 LINE' : '尚未設定 LINE 官方帳號';
    insert('manual', 'manual', why);
    return { channel: 'manual', status: 'manual', message: `${why}，已記錄為人工發送` };
  }
  if (mode === 'manual') {
    insert('manual', 'manual', '');
    return { channel: 'manual', status: 'manual', message: '已記錄為人工發送' };
  }

  // ---- webhook（簡訊商／自建 bot）----
  if (!url) {
    insert('manual', 'manual', '');
    return { channel: 'manual', status: 'manual', message: '未設定發送通道，已記錄為人工發送' };
  }
  if (!target) {
    insert('webhook', 'failed', '個案未留聯絡電話');
    return { channel: 'webhook', status: 'failed', message: '個案未留聯絡電話，未送出' };
  }

  try {
    // 逾時 10 秒即放棄，避免櫃檯畫面卡住
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ kind, to: target, message: content }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 200);
      insert('webhook', 'failed', `HTTP ${resp.status} ${body}`);
      return { channel: 'webhook', status: 'failed', message: `發送失敗（HTTP ${resp.status}）` };
    }
    insert('webhook', 'sent', '');
    if (user) audit('staff', user.id, user.name, '發送提醒', String(client_id || ''), { kind });
    return { channel: 'webhook', status: 'sent', message: '已送出' };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '連線逾時' : String(e.message || e).slice(0, 200);
    insert('webhook', 'failed', msg);
    return { channel: 'webhook', status: 'failed', message: `發送失敗：${msg}` };
  }
}

module.exports = { sendNotification };
