// Google 表單一筆回應 → 後台的「線上預約申請」。
// 抽出來共用：Apps Script 觸發器（src/routes/integrations.js）與
// 回應試算表的補匯入（scripts/import-form-responses.js）走的是同一套對應規則，
// 兩邊結果才會一致，改規則也只要改這裡。

const { db, audit, today, ageYears } = require('./db');

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

// answers：{ 題目標題: 作答 }；opts.externalId：Google 的回應識別碼（用來去重）
function ingest(answers, opts = {}) {
  const f = answers || {};
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

  // 姓名／電話：成人段是「就診者姓名」「您的電話」，兒青段是「孩子姓名」「家長的電話」。
  // 舊回應留的是當年的題目名稱，表單改過版就對不到，所以再加一層「看內容」的退路：
  // 任何一格長得像台灣手機／市話的就當電話，任何題目名帶「名」的就當姓名。
  const looksPhone = v => /^(0\d{8,9}|886\d{8,9})$/.test(normPhone(v));
  const anyPhone = () => {
    const hit = keys.find(k => looksPhone(f[k]));
    return hit ? normPhone(f[hit]) : '';
  };
  const anyName = () => {
    const hit = keys.find(k => /名/.test(flat(k)) && !/名稱|報名|簽名/.test(flat(k))
      && String(f[k] || '').trim() && !looksPhone(f[k]));
    return hit ? String(f[hit]).trim() : '';
  };
  const name = pick('就診者姓名', '孩子姓名', '您的姓名', '姓名', '名字') || anyName();
  const childPhone = normPhone(pick('家長的電話', '家長電話'));
  const phone = normPhone(pick('您的電話', '聯絡電話', '手機', '電話')) || childPhone || anyPhone();
  if (!name || !phone) {
    // 對不到就把「收到哪些題目」記進稽核軌跡（只記題目名，不記作答內容），
    // 才查得出是表單改版還是真的沒填；否則只看得到一句 400。
    audit('system', null, 'Google 表單', '表單回應缺姓名或電話',
      externalId, { titles: keys, has_name: !!name, has_phone: !!phone });
    return { error: '缺少姓名或聯絡電話', titles: keys };
  }

  // 同一份回應重送不會產生第二筆（Apps Script 重試、手動補送都可能發生）
  const externalId = String(opts.externalId || '').trim();
  if (externalId) {
    const dup = db.prepare('SELECT id FROM booking_requests WHERE external_id = ?').get(externalId);
    if (dup) return { ok: true, id: dup.id, duplicated: true };
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

  return {
    ok: true, id, counselor, plan, topic, name, preferred,
    matched: { plan: plan ? plan.name : null, topic: topic ? topic.name : null,
      counselor: counselor ? counselor.name : null },
    warnings: notes,
    age: ageYears(birth, today())
  };
}

module.exports = { ingest, normalize, normPhone, normDate, normGender };
