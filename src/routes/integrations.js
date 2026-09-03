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
const { db, audit, today, getSetting, ageYears } = require('../db');
const { requireStaff, rateLimit } = require('../auth');
const plans = require('../plans');
const line = require('../line');

const router = express.Router();
const ingestLimit = rateLimit({ windowMs: 60 * 1000, max: 60, prefix: 'gform:' });

// 表單選項常混用全形字（「(２０００／５０分鐘)」），先轉成半形再比對，
// 否則括號裡的價目說明因為 \d 對不到全形數字而不會被剝掉。
function toHalf(t) {
  return String(t || '').replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}
// 選項文字對回資料庫：去掉括號內的價目說明與空白後比對，
// 例如「個別治療／諮商(２０００／５０分鐘)」→ 對到方案「個別治療／諮商（50 分鐘）」。
function normalize(t) {
  return toHalf(t)
    .replace(/[（(][^）)]*[）)]/g, m => (/\d/.test(m) && /元|分鐘|次|場地費|免費/.test(m) ? '' : m))
    .replace(/\s|　|\/|／|-|－|、|,|，/g, '')
    .toLowerCase();
}
function matchPlan(text) {
  const key = normalize(text);
  const rows = db.prepare('SELECT * FROM service_plans WHERE active = 1').all();
  return rows.find(p => normalize(p.name) === key)
    || rows.find(p => key.startsWith(normalize(p.name)) || normalize(p.name).startsWith(key))
    || null;
}
function matchTopic(planId, text) {
  if (!planId || !text) return null;
  const key = normalize(text);
  const rows = db.prepare('SELECT * FROM plan_topics WHERE plan_id = ? AND active = 1').all(planId);
  return rows.find(t => normalize(t.name) === key) || null;
}
// 「鍾芯瑜心理師」→ 取姓名部分比對；「不指定，由所方媒合…」→ 不指定
function matchCounselor(text) {
  const raw = String(text || '').trim();
  if (!raw || /安排|媒合|不指定/.test(raw)) return null;
  const rows = db.prepare("SELECT * FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin')").all();
  return rows.find(u => raw.startsWith(u.name)) || rows.find(u => raw.includes(u.name)) || null;
}
function normGender(t) {
  const v = String(t || '');
  if (/女/.test(v)) return 'female';
  if (/男/.test(v)) return 'male';
  return v ? 'other' : '';
}
// 表單的日期可能是 2001/03/05、2001-03-05 或 ISO 字串
function normDate(t) {
  const v = String(t || '').trim();
  const m = v.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}
function normPhone(t) {
  return String(t || '').replace(/[\s\-()]/g, '').replace(/^\+886/, '0');
}

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

  // 表單的問題標題常帶括號註解與換行（「就診者姓名\n(註：…)」），
  // 因此以「去掉空白後包含關鍵字」比對，並依傳入順序優先取用。
  const keys = Object.keys(f);
  const flat = k => String(k).replace(/\s|　/g, '').toLowerCase();
  const pick = (...want) => {
    for (const w of want) {
      const hit = keys.find(x => flat(x).includes(flat(w)));
      if (hit && String(f[hit]).trim()) return String(f[hit]).trim();
    }
    return '';
  };

  // 姓名／電話：成人段是「就診者姓名」「您的電話」，兒青段是「孩子姓名」「家長的電話」
  const name = pick('就診者姓名', '孩子姓名', '您的姓名', '姓名');
  const childPhone = normPhone(pick('家長的電話'));
  const phone = normPhone(pick('您的電話', '聯絡電話', '手機', '電話')) || childPhone;
  if (!name || !phone) return res.status(400).json({ error: '缺少姓名或聯絡電話' });

  // 同一份回應重送不會產生第二筆（Apps Script 重試、手動補送都可能發生）
  const externalId = String(b.response_id || b.responseId || '').trim();
  if (externalId) {
    const dup = db.prepare('SELECT id FROM booking_requests WHERE external_id = ?').get(externalId);
    if (dup) return res.json({ ok: true, id: dup.id, duplicated: true });
  }

  const category = pick('預約類別');
  const planText = pick('預約項目', '諮商方案', '方案');
  const plan = matchPlan(planText);
  const topicText = pick('諮商主題', '主題');
  const topic = plan ? matchTopic(plan.id, topicText) : null;
  const counselorText = pick('是否指定心理師', '心理師');
  const counselor = matchCounselor(counselorText);
  const birth = normDate(pick('出生年月日', '生日'));
  const client = db.prepare('SELECT * FROM clients WHERE phone = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(phone) || null;

  // 表單沒有選時段的機制，個案填的是「方便預約之時段」文字，一律進 alt_note 由櫃檯排
  const preferred = pick('預約時間', '欲安排之諮商時間', '諮商時間', '時段');
  const mainIssue = pick('主要原因', '主訴', '困擾', '想談');
  const expectation = pick('期待');
  const education = pick('教育程度');

  // 對不到的選項不擋收件，改成櫃檯看得到的提醒；資料照收，人工指定即可
  const notes = [];
  if (planText && !plan) notes.push(`方案未對應：${planText}`);
  if (topicText && !topic) notes.push(`主題未對應：${topicText}`);
  if (counselorText && !counselor && !/安排|媒合|不指定/.test(counselorText)) notes.push(`心理師未對應：${counselorText}`);
  if (/國軍/.test(planText) && !/已完成/.test(pick('國軍方案'))) notes.push('國軍方案：尚未確認已完成國防部預先審核');
  if (!/已加入/.test(pick('我已加入', '官方LINE', 'LINE'))) notes.push('尚未確認已加入官方 LINE 並傳送姓名');

  const info = db.prepare(`INSERT INTO booking_requests
    (name, phone, email, gender, birth_date, is_new, client_id, plan_id, topic_id, counselor_id,
     date, start_time, alt_note, mode, fee_choice, main_issue, expectation, source, consent,
     topic_other, address, id_no, emergency_name, emergency_phone, emergency_relationship,
     category, education, guardian_name, guardian_phone, form_answers, external_id, reply_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,'','',?,?,?,?,?,'google_form',1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    name, phone, pick('您的email', '家長email', '信箱', 'email'),
    normGender(pick('生理性別', '性別')), birth,
    client ? 0 : 1, client ? client.id : null,
    plan ? plan.id : null, topic ? topic.id : null, counselor ? counselor.id : null,
    preferred, plan && plan.default_mode === 'online' ? 'online' : 'onsite',
    plan ? plan.fee : 0, mainIssue, expectation,
    topicText && !topic ? topicText : '',
    pick('地址'), pick('身分證字號', '身分證').toUpperCase(),
    pick('緊急聯絡人姓名', '緊急聯絡人'), normPhone(pick('緊急聯絡人電話')),
    pick('緊急聯絡人關係'),
    category, education, pick('家長姓名'), childPhone,
    // 表單問題會增刪，整份回應原封不動留一份，櫃檯在申請頁展開就看得到
    JSON.stringify(f), externalId, notes.join('；'));

  const id = info.lastInsertRowid;
  audit('system', null, 'Google 表單', '表單預約同步', String(id), { name, plan: planText, matched: !!plan });

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

  res.json({
    ok: true, id,
    matched: { plan: plan ? plan.name : null, topic: topic ? topic.name : null,
      counselor: counselor ? counselor.name : null },
    warnings: notes,
    age: ageYears(birth, today())
  });
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
