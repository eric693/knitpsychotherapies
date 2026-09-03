// Google 表單同步：所內原本的 Google 預約表單填完後，
// 由表單的 Apps Script 觸發器把回應 POST 到這裡，直接寫進後台的「線上預約申請」。
//
// 為什麼是 Apps Script 而不是我們去輪詢：Google 表單沒有公開的讀取 API，
// 且回應含身分證字號等敏感資料，由表單端主動推送（帶共用密鑰）比我們拿著
// 一把 Google 帳號金鑰去撈安全得多，也不必授權整個雲端硬碟。
//
// 對應規則刻意做成「照文字比對」：表單選項寫什麼，就對回後台同名的方案／主題／心理師，
// 對不到時仍收單並在後台標示「需人工指定」，資料不會因為改了幾個字就掉。

const express = require('express');
const crypto = require('crypto');
const { db, audit, getSetting } = require('../db');
const { ingest } = require('../form-ingest');
const { requireStaff, rateLimit } = require('../auth');
const plans = require('../plans');
const line = require('../line');

const router = express.Router();
const ingestLimit = rateLimit({ windowMs: 60 * 1000, max: 60, prefix: 'gform:' });

// 密鑰比對採固定長度比較，避免以回應時間猜測密鑰
function secretOk(given) {
  const want = getSetting('google_form_secret', '').trim();
  if (!want) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Apps Script 觸發器打進來的端點（免登入，靠共用密鑰）
router.post('/integrations/google-form', ingestLimit, async (req, res) => {
  const b = req.body || {};
  if (!secretOk(b.secret || req.headers['x-form-secret'])) {
    return res.status(401).json({ error: '密鑰不正確' });
  }
  const f = b.answers || b;   // 允許直接把答案物件送上來
  const out = ingest(f, { externalId: b.response_id || b.responseId || '' });
  if (out.error) return res.status(400).json(out);
  if (out.duplicated) return res.json({ ok: true, id: out.id, duplicated: true });
  const { counselor, plan, topic, name, preferred } = out;
  const planText = out.matched.plan || '';
  const topicText = out.matched.topic || '';

  // 指名的心理師若已綁定 LINE，同步推一張卡片讓他知道有人預約
  if (counselor && counselor.line_user_id) {
    await line.pushFlex({
      to: counselor.line_user_id, kind: 'booking_staff',
      flex: line.counselorBookingFlex({
        counselor_name: counselor.name,
        kind: '新的預約申請（Google 表單）',
        b: { name, plan_name: plan ? plan.name : planText, topic_name: topic ? topic.name : topicText,
          date: '', alt_note: preferred, main_issue: '' }
      })
    }).catch(() => {});
  }

  res.json({ ok: true, id: out.id, matched: out.matched, warnings: out.warnings, age: out.age });
});

// 後台：同步設定與 Apps Script 程式碼（貼到表單的指令碼編輯器即可）
router.get('/integrations/google-form', requireStaff('settings'), (req, res) => {
  const secret = getSetting('google_form_secret', '');
  const base = getSetting('booking_public_url', '').replace(/\/booking\.html.*$/, '')
    || `${req.protocol}://${req.get('host')}`;
  const endpoint = `${base}/api/integrations/google-form`;
  const recent = db.prepare(`SELECT b.id, b.name, b.created_at, b.status, b.reply_note,
      p.name AS plan_name, u.name AS counselor_name
    FROM booking_requests b
    LEFT JOIN service_plans p ON p.id = b.plan_id
    LEFT JOIN users u ON u.id = b.counselor_id
    WHERE b.source = 'google_form' ORDER BY b.id DESC LIMIT 30`).all();
  res.json({
    enabled: !!secret,
    secret,
    endpoint,
    form_url: getSetting('google_form_url', ''),
    script: appsScript(endpoint, secret || '請先產生密鑰'),
    recent,
    total: db.prepare("SELECT COUNT(*) n FROM booking_requests WHERE source = 'google_form'").get().n
  });
});

router.put('/integrations/google-form', requireStaff('settings'), (req, res) => {
  const b = req.body || {};
  const { setSetting } = require('../db');
  if (b.regenerate) setSetting('google_form_secret', crypto.randomBytes(24).toString('hex'));
  else if (b.secret !== undefined) setSetting('google_form_secret', String(b.secret).trim());
  if (b.form_url !== undefined) setSetting('google_form_url', String(b.form_url).trim());
  audit('staff', req.user.id, req.user.name, '修改 Google 表單同步設定');
  res.json({ ok: true, secret: getSetting('google_form_secret', '') });
});

// 貼到 Google 表單「擴充功能 → Apps Script」的程式碼；設定「表單提交時」觸發器即可。
// onFormSubmit 只有被觸發器呼叫時才拿得到 e（表單提交事件）；在編輯器裡按「執行」
// 是沒有 e 的，所以這裡把它導去補送最新一筆，而不是拋 e.response 的錯。
function appsScript(endpoint, secret) {
  return `// 織心｜Google 表單 → 治療所後台同步
// 1. 在表單畫面右上「⋮ → 指令碼編輯器」貼上本段程式碼並儲存
// 2. 左側「觸發條件 → 新增觸發條件」：執行函式 onFormSubmit、事件來源「來自表單」、
//    事件類型「表單提交時」，儲存並授權
// 3. 之後每筆回應都會即時寫入後台的「線上預約申請」
//
// 想手動試一次：在編輯器上方的函式選單挑 syncLatest（補送最新一筆）或
// backfill（補送全部歷史回應）再按執行，不要直接執行 onFormSubmit——
// 手動執行沒有表單提交事件，Google 不會傳 e 進來。

const ENDPOINT = '${endpoint}';
const SECRET = '${secret}';

function onFormSubmit(e) {
  // 在編輯器裡手動按「執行」時 e 是 undefined，導去補送最新一筆，避免報錯
  if (!e || !e.response) {
    console.log('沒有表單提交事件（多半是在編輯器裡手動執行），改為補送最新一筆回應。');
    return syncLatest();
  }
  return send_(e.response);
}

// 把一筆回應送到後台。回傳後台的回應內容，方便在執行紀錄裡看結果。
function send_(response) {
  const answers = {};
  response.getItemResponses().forEach(function (r) {
    answers[r.getItem().getTitle()] = r.getResponse();
  });
  const payload = {
    secret: SECRET,
    response_id: response.getId(),
    submitted_at: response.getTimestamp().toISOString(),
    answers: answers
  };
  const res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const body = res.getContentText();
  if (res.getResponseCode() >= 300) {
    console.error('同步失敗：' + res.getResponseCode() + ' ' + body);
  } else {
    console.log('已同步：' + body);
  }
  return body;
}

// 手動補送最新一筆回應（用來測試設定是否正確）
function syncLatest() {
  const all = FormApp.getActiveForm().getResponses();
  if (!all.length) {
    console.log('這份表單目前還沒有任何回應。');
    return;
  }
  return send_(all[all.length - 1]);
}

// 補送歷史回應：在編輯器選這個函式執行一次即可（重複送不會產生第二筆）
function backfill() {
  const all = FormApp.getActiveForm().getResponses();
  console.log('共 ' + all.length + ' 筆回應要補送');
  all.forEach(function (response) { send_(response); });
  console.log('補送完成');
}`;
}

module.exports = router;
