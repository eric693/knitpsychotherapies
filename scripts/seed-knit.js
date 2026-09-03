// 依織心心理治療所官網（https://www.knitpsychotherapies.com/）的服務項目與心理師名單，
// 建立心理師帳號、治療主題與服務方案。
//   node scripts/seed-knit.js
//
// 可重複執行：以名稱比對，已存在者更新內容，不會產生重複資料，也不會動到既有預約。
// 收費金額官網未公開，以下一律是暫定值，請於後台「方案設定」逐一改成本所實際收費。

const bcrypt = require('bcryptjs');
const { db, getSetting } = require('../src/db');

// ---- 心理師 ----
// 密碼一律為初始密碼，請各位心理師首次登入後自行修改。
const INIT_PASSWORD = 'knit2026';
// 心理師名單、證書字號與專長取自所方官網的心理師介紹頁，
// 供收據、證明書落款與線上預約表單顯示；日後異動請以後台「帳號權限」為準（重跑本檔不會蓋掉已改過的簡介）。
const COUNSELORS = [
  { username: 'chung', name: '鍾芯瑜', title: '', license_type: '臨床心理師', license_no: '心理字第001923號',
    specialty: '兒童青少年（注意力不足／過動症、自閉症、情緒調節困難、親子溝通、創傷療育）、成人親職諮商、創傷療育、伴侶諮商',
    intro: '治療取向：系統觀與依附理論、創傷知情與身體經驗。' },
  { username: 'lo', name: '羅捷', title: '', license_type: '臨床心理師', license_no: '心理字第002045號',
    specialty: '自閉症類群與注意力不足過動症評估介入、兒童早期療育、兒童青少年情緒行為困擾、依附與手足議題、親職教養諮詢、兒童遊戲治療、創傷知情',
    intro: '治療取向：現象學心理學，以關係脈絡與發展適應為中心。' },
  { username: 'chueh', name: '闕靖惠', title: '', license_type: '臨床心理師', license_no: '心理字第001839號',
    specialty: '親職與家庭關係（正向教養、親子溝通、代際創傷）、成人情緒困擾與強迫行為、睡眠困擾、悲傷輔導、職場與職涯心理、正念減壓',
    intro: '工作風格：真誠、接納、思辨、引導。' },
  { username: 'chang-wl', name: '張文藍', title: '', license_type: '臨床心理師', license_no: '心理字第002093號',
    specialty: '兒童早期療育、兒童遊戲治療、兒童青少年情緒行為困擾、自閉症與注意力不足過動症評估介入、親職教養諮詢、創傷知情、物質成癮、人際與自我探索',
    intro: '工作風格：接納、好奇、幽默，重視當下經驗與共同參與。' },
  { username: 'chuang', name: '莊育涵', title: '', license_type: '臨床心理師', license_no: '心理字第002257號',
    specialty: '兒童發展評估與早期療育、自閉症類群與注意力不足過動症評估介入、兒童青少年個別與團體治療、親子互動介入、依附關係、創傷知情照護',
    intro: '工作風格：溫暖接納、重視關係、親職合作。' },
  { username: 'chang-yl', name: '張益綸', title: '', license_type: '諮商心理師', license_no: '諮心字第003036號',
    specialty: '大學生人際關係與戀愛議題、成人職場壓力與生涯規劃、親密關係與溝通困境',
    intro: '治療取向：存在主義／意義取向、關係取向心理諮商。' },
  { username: 'hsu', name: '許峰益', title: '', license_type: '諮商心理師', license_no: '諮心字第004510號',
    specialty: '兒青情緒調節、人際互動、注意力與過動、自傷、網路成癮、霸凌與創傷；親子關係與正向教養；成人情緒壓力、親密關係、職場困境、長者心理健康',
    intro: '工作風格：溫暖、陪伴、同理、合作、引導，採多元學派整合。' },
  { username: 'hsiao', name: '蕭如軒', title: '', license_type: '諮商心理師', license_no: '諮心字第007035號',
    specialty: '青少年與大學生發展（人際關係、情緒壓力、自我認同、學習生涯）、成人家庭關係、人際界限、感情議題、情緒調適、哀傷失落',
    intro: '工作風格：真誠、溫暖、引導、同理，重視優勢觀點。' }
];

// ---- 治療主題（各方案共用同一組）----
const TOPICS = ['自我探索', '情緒困擾', '壓力調適', '親密關係', '原生家庭/親子關係',
  '人際關係', '生涯議題', '心理疾患', '創傷與失落', '兒童青少年適應', '其他'];

// ---- 服務方案 ----
// 方案名稱刻意與「織心心理治療所 預約表單」的「預約項目」選項同名，
// 表單同步才對得回來（比對時會自動去掉選項後面括號裡的價目說明）。
// 表單沒有的方案（通訊諮商、EMDR、初次評估）一樣留著，供後台自行排約使用。
const VENUE_FEE = 0;   // 目前兩個補助方案都不收場地費，個案 0 元
const PLANS = [
  { name: '個別治療／諮商（50 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 2000, session_minutes: 50 },
  { name: '兒青個別治療／諮商（50 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 2000, session_minutes: 50, age_max: 18 },
  { name: '兒青團體治療（50 分鐘）', kind: 'self', appt_type: 'group',
    fee: 1000, session_minutes: 50, age_max: 18,
    intro: '須至少先進行一次個別課程。' },
  { name: '親職諮詢（50 分鐘）', kind: 'self', appt_type: 'family',
    fee: 2000, session_minutes: 50 },
  { name: '伴侶諮商', kind: 'self', appt_type: 'couple',
    fee: 0, session_minutes: 80,
    intro: '費用請傳訊至官方 LINE，由專員向您說明。' },
  { name: '國軍方案（40 分鐘）', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 40, quota_per_year: 6, code_prefix: '國軍',
    // 國防部系統：個案註冊與每次晤談簽到都在這裡做
    register_url: 'https://gpwd-mhcp.mnd.gov.tw/registerpage?id=93&token=53c4ee67-a721-4071-9387-8efafb3941d6',
    signin_url: 'https://gpwd-mhcp.mnd.gov.tw/signpage?id=93&token=df59aef9-729c-4f3c-acba-1379a437d4cc',
    subsidy_program: '國軍心理健康支持方案',
    intro: '國防部所屬人員六次免費，需先於國防部系統完成預先審核。' },
  { name: '青壯方案（50 分鐘）', kind: 'subsidy', appt_type: 'individual',
    fee: 1800, session_minutes: 50, age_min: 15, age_max: 45, quota_per_year: 3, code_prefix: '青壯',
    subsidy_program: '青壯世代心理健康支持方案',
    intro: '15-45 歲三次免費。' },
  { name: '通訊（視訊）諮商（50 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 2000, session_minutes: 50, default_mode: 'online' },
  { name: 'EMDR 眼動減敏重整療法（80 分鐘）', kind: 'self', appt_type: 'individual',
    fee: 3000, session_minutes: 80,
    intro: '需先完成初次評估，由受訓心理師執行。' }
];

const SHARE_PERCENT = 0.6;   // 心理師抽成預設值，後台可逐方案／逐心理師調整

// ---- 心理師帳號 ----
const findUser = db.prepare('SELECT * FROM users WHERE username = ? OR name = ?');
for (const c of COUNSELORS) {
  const exist = findUser.get(c.username, c.name);
  if (exist) {
    // 證書字號與專長只在後台還沒填時帶入，避免蓋掉所方自己更新過的內容
    db.prepare(`UPDATE users SET name = ?, title = ?, license_type = ?, online_only = ?,
        intro = CASE WHEN intro = '' THEN ? ELSE intro END,
        license_no = CASE WHEN license_no = '' THEN ? ELSE license_no END,
        specialty = CASE WHEN specialty = '' THEN ? ELSE specialty END,
        role = CASE WHEN role = 'admin' THEN role ELSE 'counselor' END, active = 1 WHERE id = ?`)
      .run(c.name, c.title || '', c.license_type, c.online_only || 0, c.intro || '',
        c.license_no || '', c.specialty || '', exist.id);
    console.log(`更新心理師：${c.name}`);
  } else {
    db.prepare(`INSERT INTO users (username, password_hash, name, role, title, license_type,
        online_only, intro, license_no, specialty)
      VALUES (?,?,?,'counselor',?,?,?,?,?,?)`).run(
      c.username, bcrypt.hashSync(INIT_PASSWORD, 10), c.name, c.title || '',
      c.license_type, c.online_only || 0, c.intro || '', c.license_no || '', c.specialty || '');
    console.log(`新增心理師：${c.name}（帳號 ${c.username}，初始密碼 ${INIT_PASSWORD}）`);
  }
}

// ---- 方案與主題 ----
const PLAN_COLS = ['name', 'kind', 'appt_type', 'fee_mode', 'fee', 'fee_options', 'subsidy_amount',
  'subsidy_program', 'session_minutes', 'age_min', 'age_max', 'quota_per_year',
  'counselor_week_limit', 'counselor_month_limit', 'share_mode', 'share_percent', 'share_fixed',
  'portal_visible', 'require_review', 'note', 'intro', 'sort', 'active', 'default_mode', 'venue_fee',
  // 年報表的個案編碼標記（如 1140601_青壯1）；類別代碼由所方自行在方案設定填
  'code_prefix', 'register_url', 'signin_url'];

const findPlan = db.prepare('SELECT * FROM service_plans WHERE name = ?');
const insTopic = db.prepare('INSERT INTO plan_topics (plan_id, name, sort) VALUES (?,?,?)');
const hasTopic = db.prepare('SELECT id FROM plan_topics WHERE plan_id = ? AND name = ?');

PLANS.forEach((p, idx) => {
  const row = {
    name: p.name,
    kind: p.kind,
    appt_type: p.appt_type,
    fee_mode: p.fee_mode || 'fixed',
    fee: p.fee,
    fee_options: p.fee_options || '',
    // 補助方案：個案只付場地費，其餘由方案給付
    subsidy_amount: p.kind === 'subsidy' ? Math.max(0, p.fee - VENUE_FEE) : 0,
    venue_fee: p.kind === 'subsidy' ? VENUE_FEE : 0,
    subsidy_program: p.subsidy_program || '',
    session_minutes: p.session_minutes || 0,
    age_min: p.age_min || 0,
    age_max: p.age_max || 0,
    quota_per_year: p.quota_per_year || 0,
    counselor_week_limit: p.counselor_week_limit || 0,
    counselor_month_limit: 0,
    share_mode: 'percent',
    share_percent: SHARE_PERCENT,
    share_fixed: 0,
    portal_visible: 1,
    require_review: 1,
    note: '',
    intro: p.intro || '',
    sort: idx + 1,
    active: 1,
    default_mode: p.default_mode || 'onsite',
    code_prefix: p.code_prefix || '',
    register_url: p.register_url || '',
    signin_url: p.signin_url || ''
  };
  const exist = findPlan.get(p.name);
  // 已在後台調整過的編碼標記不被重跑 seed 覆蓋
  if (exist && exist.code_prefix) row.code_prefix = exist.code_prefix;
  // 網址若已在後台改過（換 token）就不覆蓋
  if (exist && exist.register_url) row.register_url = exist.register_url;
  if (exist && exist.signin_url) row.signin_url = exist.signin_url;
  let planId;
  if (exist) {
    db.prepare(`UPDATE service_plans SET ${PLAN_COLS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...PLAN_COLS.map(c => row[c]), exist.id);
    planId = exist.id;
    console.log(`更新方案：${p.name}`);
  } else {
    planId = db.prepare(`INSERT INTO service_plans (${PLAN_COLS.join(',')})
      VALUES (${PLAN_COLS.map(() => '?').join(',')})`).run(...PLAN_COLS.map(c => row[c])).lastInsertRowid;
    console.log(`新增方案：${p.name}`);
  }
  TOPICS.forEach((t, i) => { if (!hasTopic.get(planId, t)) insTopic.run(planId, t, i + 1); });
});

// 舊的示範方案若沒被任何預約引用就移除，避免表單上出現兩套方案
const keep = new Set(PLANS.map(p => p.name));
for (const p of db.prepare('SELECT * FROM service_plans').all()) {
  if (keep.has(p.name)) continue;
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE plan_id = ?').get(p.id).n;
  if (used) {
    db.prepare('UPDATE service_plans SET active = 0, portal_visible = 0 WHERE id = ?').run(p.id);
    console.log(`停用舊方案（已有 ${used} 筆預約）：${p.name}`);
  } else {
    db.prepare('DELETE FROM service_plans WHERE id = ?').run(p.id);
    console.log(`移除舊方案：${p.name}`);
  }
}

console.log(`\n完成。方案 ${PLANS.length} 個、主題 ${TOPICS.length} 項、心理師 ${COUNSELORS.length} 位。`);
console.log(`機構名稱：${getSetting('center_name')}`);
