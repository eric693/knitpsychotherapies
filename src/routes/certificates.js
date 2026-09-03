// 證明書：在職證明書、離職證明書、治療證明。
//
// 三種都是「一張紙、幾個欄位、一段聲明」，所方常要臨時改字（改用途、加備註、
// 換稱謂），因此版面與文字整份存在 data（JSON）裡：標題、每一列的欄位名與內容、
// 聲明段落、機構抬頭、核章欄位，逐張都能改，也能自行增列或刪列。
// 套版只負責帶入預設值與當事人資料，不限制所方最後怎麼寫。

const express = require('express');
const { db, audit, today, getSetting, listSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

const KINDS = {
  employment: { label: '在職證明書', module: 'hr', subject: 'user' },
  resignation: { label: '離職證明書', module: 'hr', subject: 'user' },
  treatment: { label: '治療證明', module: 'clients', subject: 'client' },
  profile: { label: '基本資料表', module: 'clients', subject: 'client' },
  // 公部門補助方案（青壯、國軍等）要交出去的兩張表
  plan_detail: { label: '方案服務明細', module: 'clients', subject: 'client' },
  referral: { label: '方案轉介單', module: 'clients', subject: 'client' },
  // 所內轉介到身心科／診所用的轉介單，一式三聯並附醫師回覆欄
  referral_clinic: { label: '轉介單（一式三聯）', module: 'clients', subject: 'client' }
};

// 流水編號：前綴 + 西元年月 + 四碼序號，如 KC2026090001。
// 作廢的號碼不回收，證明書才連號可查。
function nextCertNo() {
  const prefix = getSetting('cert_prefix', 'KC');
  const ym = today().slice(0, 7).replace('-', '');
  const row = db.prepare('SELECT cert_no FROM certificates WHERE cert_no LIKE ? ORDER BY cert_no DESC LIMIT 1')
    .get(`${prefix}${ym}%`);
  const seq = row ? Number(row.cert_no.slice(-4)) + 1 : 1;
  return `${prefix}${ym}${String(seq).padStart(4, '0')}`;
}

function rocText(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `民國 ${Number(m[1]) - 1911} 年 ${Number(m[2])} 月 ${Number(m[3])} 日` : '';
}

const GENDER = { male: '男', female: '女', other: '' };

function orgBlock(kind) {
  const rows = [
    { label: kind === 'resignation' ? '機構名稱' : '單位名稱', value: getSetting('center_name', '') },
    { label: '統一編號', value: getSetting('center_tax_id', '') },
    { label: kind === 'resignation' ? '機構負責人' : '負責人', value: getSetting('center_director', '') },
    { label: kind === 'resignation' ? '地址' : '單位地址', value: getSetting('center_address', '') },
    { label: '聯絡電話', value: getSetting('center_phone', '') }
  ];
  // 統編與電話沒填就不印，免得留一行空白
  return rows.filter(r => r.value || ['單位名稱', '機構名稱', '負責人', '機構負責人'].includes(r.label));
}

// 當事人資料：帶得出來的先填好，帶不出來的留空給人工補
function subjectRows(kind, subject, extra = {}) {
  const u = subject || {};
  if (kind === 'employment') {
    return [
      { label: '姓名', value: u.name || '' },
      { label: '性別', value: GENDER[u.gender] || '' },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '出生年月日', value: rocText(u.birth_date) },
      { label: '服務單位', value: getSetting('center_name', '') },
      { label: '心理字號', value: u.license_no || '' },
      { label: '職稱', value: u.title || u.license_type || '' },
      { label: '到職日期', value: rocText(u.hire_date) },
      { label: '備註', value: '' }
    ];
  }
  if (kind === 'resignation') {
    return [
      { label: '姓名', value: u.name || '' },
      { label: '性別', value: GENDER[u.gender] || '' },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '出生日期', value: rocText(u.birth_date) },
      { label: '任職日期', value: rocText(u.hire_date) },
      { label: '離職日期', value: rocText(u.resign_date) },
      { label: '職稱', value: u.title || u.license_type || '' },
      { label: '服務地點', value: u.work_place || getSetting('center_address', '') },
      { label: '備註', value: '' }
    ];
  }
  if (kind === 'plan_detail') {
    return [
      { label: '民眾姓名', value: u.name || '' },
      { label: '民眾身分證字號', value: u.id_no || '' },
      { label: '提供心理諮商合作機構名稱', value: getSetting('center_name', '') },
      { label: '合作機構代碼', value: getSetting('center_org_code', '') },
      { label: '同意書檔案名稱', value: '' }
    ];
  }
  if (kind === 'referral_clinic') {
    return [
      { label: '原醫事機構', value: getSetting('center_name', '') },
      { label: '機構代碼', value: getSetting('center_org_code', '') },
      { label: '機構電話', value: getSetting('center_phone', '') },
      { label: '機構地址', value: getSetting('center_address', '') },
      { label: '姓名', value: u.name || '' },
      { label: '性別', value: GENDER[u.gender] || '□男　□女' },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '出生日期', value: rocText(u.birth_date) },
      { label: '聯絡電話', value: u.phone || '' },
      { label: '聯絡人／關係', value: u.emergency_name
        ? `${u.emergency_name}（${u.emergency_relationship || ''}）${u.emergency_phone || ''}` : '' },
      { label: '聯絡地址', value: u.address || '' },
      { label: '轉介原因（可複選）', value: reasonChecklist() },
      { label: '建議轉介機構', value: getSetting('referral_clinic_targets', '') },
      { label: '轉介回覆（由醫療端填寫）', value:
        listSetting('referral_reply_options').map(o => '☐ ' + o).join('　')
        + '\n補充說明：＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿'
        + '\n醫師簽名：＿＿＿＿＿＿＿＿＿＿　日期：＿＿＿＿＿＿＿＿＿＿' },
      { label: '轉介日期', value: '中華民國 ＿＿＿ 年 ＿＿ 月 ＿＿ 日' }
    ];
  }
  if (kind === 'referral') {
    const b = extra.bsrs;
    const mark = on => (on ? '■' : '□');
    return [
      { label: '原醫事機構', value: getSetting('center_name', '') },
      { label: '機構代碼', value: getSetting('center_org_code', '') },
      { label: '機構電話', value: getSetting('center_phone', '') },
      { label: '機構地址', value: getSetting('center_address', '') },
      { label: '姓名', value: u.name || '' },
      { label: '性別', value: GENDER[u.gender] ? `${GENDER[u.gender]}` : '□男　□女' },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '出生日期', value: rocText(u.birth_date) },
      { label: '聯絡電話', value: u.phone || '' },
      { label: '聯絡人／關係', value: u.emergency_name
        ? `${u.emergency_name}（${u.emergency_relationship || ''}）${u.emergency_phone || ''}` : '' },
      { label: '聯絡地址', value: u.address || '' },
      { label: '個案狀況', value:
        `${mark(b && b.total >= 15)}1. BSRS-5 前五題總分大於 15 分`
        + `　${mark(b && b.alert)}2. BSRS-5 附加題分數 2 分以上`
        + `　□3. 其他經評估有轉介或長期介入之需要（請說明）：＿＿＿＿＿＿＿＿`
        + (b ? `\n（最近一次 BSRS-5：${b.date}　總分 ${b.total}）` : '') },
      { label: '轉介原因（可複選）', value: reasonChecklist() },
      { label: '建議轉介機構', value: getSetting('referral_targets_default', '') },
      { label: '轉介日期', value: `中華民國 ＿＿＿ 年 ＿＿ 月 ＿＿ 日` }
    ];
  }
  if (kind === 'profile') {
    const pick = (v, opts) => (v ? String(v) : opts);
    return [
      { label: '姓名', value: u.name || '' },
      { label: '性別', value: pick(GENDER[u.gender], '男 ／ 女（請圈選）') },
      { label: '生日', value: rocText(u.birth_date) || '民國＿＿＿年＿＿＿月＿＿＿日' },
      { label: '電話', value: u.phone || '' },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '教育程度', value: pick(u.education, '博士 ／ 碩士 ／ 學士 ／ 高中 ／ 國中 ／ 國小及以下（請圈選）') },
      { label: '地址', value: u.address || '' },
      { label: '婚姻狀態', value: pick(u.marital, '已婚 ／ 未婚 ／ 分居 ／ 離異 ／ 其他＿＿＿＿＿（請圈選）') },
      { label: '有無子女', value: '有＿＿＿＿＿＿＿＿＿＿＿＿；無' },
      { label: '家中同住成員', value: '' },
      { label: '主要困擾', value: u.main_issue || '' },
      { label: '重大傷病卡', value: '有，診斷名＿＿＿＿＿＿＿＿＿＿；無' },
      { label: '身心障礙手冊', value: '有，類別／程度＿＿＿＿＿＿＿＿；無' },
      { label: '是否就診過兒童心智科或精神科', value: '有，民國＿＿＿年於＿＿＿＿＿＿醫院就診；否' },
      { label: '是否做過心理衡鑑', value: '有 ／ 無' },
      { label: '是否做過心理諮商', value: '有 ／ 無' },
      { label: '是否用藥', value: '目前服用＿＿＿＿＿；曾經服用＿＿＿＿＿藥物，維持多長時間＿＿＿＿＿；無' },
      { label: '重大醫療史（手術、住院）', value: u.history || '' },
      { label: '如何得知本治療所資訊', value: pick(u.source, '路過看到；＿＿＿＿＿介紹；網路搜尋；其他＿＿＿＿＿') }
    ];
  }
  return [
    { label: '案主姓名', value: u.name || '' },
    { label: '身分證字號', value: u.id_no || '' },
    { label: '來談日期', value: extra.visit_range || '' },
    { label: '晤談次數', value: extra.sessions ? `${extra.sessions} 次` : '' },
    { label: '心理師', value: extra.counselor_name || '' },
    { label: '治療主題', value: u.main_issue || '' }
  ];
}

// 附在表單後面的表格：基本資料表是空白簽到表，方案服務明細則直接把已完成的晤談填進去
function gridFor(kind, subject) {
  if (kind === 'profile') {
    return { label: '晤談紀錄（每次晤談由櫃檯填寫）', headers: ['日期', '時間', '簽名', '收費'], rows: 12 };
  }
  if (kind === 'plan_detail') {
    const data = subject ? planSessionRows(subject.id, 'subsidy') : [];
    return {
      label: '心理諮商服務明細',
      headers: ['服務次數', '日期（民國 年/月/日）', '心理諮商服務提供人員姓名',
        '面對面方式執行', '通訊方式執行', '民眾簽名', '同意書檔案名稱'],
      rows: Math.max(3, data.length),
      data
    };
  }
  return null;
}

function signatureRows(kind) {
  if (kind === 'profile') return [];
  if (kind === 'plan_detail') return [{ label: '合作機構核章', value: '' }];
  if (kind === 'referral' || kind === 'referral_clinic') {
    return [
      { label: '心理諮商服務人員簽章', value: '' },
      { label: '機構核章', value: '' }
    ];
  }
  if (kind === 'treatment') {
    const lic = getSetting('center_director_license', '');
    return [
      { label: '本人／法定代理人', value: '' },
      { label: '單位負責人', value: getSetting('center_director', '') + (lic ? `（${lic}）` : '') },
      { label: '單位核章', value: '' },
      { label: '核章日期', value: '' }
    ];
  }
  if (kind === 'resignation') {
    return [{ label: '機構', value: '' }, { label: '負責人', value: '' }];
  }
  return [{ label: '單位核章', value: '' }];
}

// 方案服務明細（如青壯方案附表 2）：把該案在補助方案下已完成的晤談逐次列出，
// 面對面／通訊依預約當時的形式帶入，民眾簽名與同意書檔名留白由現場填。
function planSessionRows(clientId, planKind) {
  const rows = db.prepare(`SELECT a.date, a.mode, u.name AS counselor_name, sp.kind AS plan_kind
    FROM appointments a
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans sp ON sp.id = a.plan_id
    WHERE a.client_id = ? AND a.status = 'done' AND (? = '' OR sp.kind = ?)
    ORDER BY a.date, a.start_time`).all(clientId, planKind || '', planKind || '');
  return rows.map((r, i) => [
    String(i + 1),
    r.date ? `${Number(r.date.slice(0, 4)) - 1911}/${r.date.slice(5, 7)}/${r.date.slice(8, 10)}` : '',
    r.counselor_name || '',
    r.mode === 'online' ? '' : '✓',
    r.mode === 'online' ? '✓' : '',
    '', ''
  ]);
}

// 轉介原因：設定裡每行寫「類別：選項、選項…」，印成一行一類、每個選項前加勾選框
function reasonChecklist() {
  return String(getSetting('referral_reasons', '')).split('\n').map(line => {
    const [cat, opts] = line.split('：');
    return opts ? `${cat}：${opts.split('、').map(o => '□' + o).join('　')}` : line;
  }).join('\n');
}

// 最近一次 BSRS-5：轉介單的「個案狀況」要據此勾選
function latestBsrs(clientId) {
  return db.prepare(`SELECT date, total, alert FROM assessments
    WHERE client_id = ? AND scale = 'BSRS5' ORDER BY date DESC, id DESC LIMIT 1`).get(clientId) || null;
}

// 治療證明要填的來談期間、次數與心理師，從已完成的晤談算出來
function treatmentFacts(clientId) {
  const r = db.prepare(`SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS sessions
    FROM appointments WHERE client_id = ? AND status = 'done'`).get(clientId) || {};
  const counselor = db.prepare(`SELECT u.name, COUNT(*) n FROM appointments a JOIN users u ON u.id = a.counselor_id
    WHERE a.client_id = ? AND a.status = 'done' GROUP BY u.id ORDER BY n DESC LIMIT 1`).get(clientId);
  return {
    sessions: r.sessions || 0,
    counselor_name: counselor ? counselor.name : '',
    visit_range: r.first_date
      ? (r.first_date === r.last_date ? rocText(r.first_date) : `${rocText(r.first_date)} 至 ${rocText(r.last_date)}`)
      : ''
  };
}

// 套版：帶出這一張證明書的預設內容，前端再逐欄修改
function buildTemplate(kind, subjectId, purpose = '') {
  const def = KINDS[kind];
  const statementRaw = getSetting(`cert_${kind}_statement`, '');
  let subject = null, extra = {};
  if (def.subject === 'user' && subjectId) {
    subject = db.prepare('SELECT * FROM users WHERE id = ?').get(subjectId) || null;
  } else if (def.subject === 'client' && subjectId) {
    subject = db.prepare('SELECT * FROM clients WHERE id = ?').get(subjectId) || null;
    if (subject && kind === 'treatment') extra = treatmentFacts(subject.id);
    if (subject && kind === 'referral') extra = { bsrs: latestBsrs(subject.id) };
  }
  return {
    kind,
    subject_id: subject ? subject.id : 0,
    subject_name: subject ? subject.name : '',
    purpose,
    data: {
      title: getSetting(`cert_${kind}_title`, def.label),
      subtitle: kind === 'treatment' ? getSetting('center_name', '') : '',
      rows: subjectRows(kind, subject, extra),
      statement_label: kind === 'treatment' ? '單位聲明' : '',
      statement: statementRaw.replace('{purpose}', purpose || '＿＿＿＿'),
      org: orgBlock(kind),
      signatures: signatureRows(kind),
      // 基本資料表背面的簽到欄：空白格數可自行增減，欄位名稱也能改
      grid: gridFor(kind, subject),
      // 聯別：一式數聯的表單，每一聯各印一頁並在頁尾標明是哪一聯
      copies: kind === 'referral_clinic'
        ? listSetting('referral_clinic_copies').filter(Boolean)
        : [],
      footer_date: `中華民國 ${new Date().getFullYear() - 1911} 年 ${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日`
    }
  };
}

// 這張證明書要哪個模組權限：在職／離職看人事，治療證明看個案
function checkAccess(req, res, kind) {
  const mod = (KINDS[kind] || KINDS.employment).module;
  if (req.user.role === 'admin' || (req.userModules || []).includes(mod)) return true;
  res.status(403).json({ error: '無權限開立此類證明書' });
  return false;
}

router.get('/certificates/kinds', requireStaff(), (req, res) => {
  res.json(Object.entries(KINDS).map(([key, v]) => ({ key, label: v.label, subject: v.subject, module: v.module })));
});

// 開立在職／離職證明時挑人用：只回姓名與職稱，不需要「帳號權限」模組
router.get('/certificates/staff-options', requireStaff('hr'), (req, res) => {
  res.json(db.prepare(`SELECT id, name, title, license_type FROM users
    WHERE active = 1 ORDER BY name`).all());
});

// 套版預覽：選好類別與當事人後，先把預設內容帶出來
router.get('/certificates/template', requireStaff(), (req, res) => {
  const kind = KINDS[req.query.kind] ? req.query.kind : 'employment';
  if (!checkAccess(req, res, kind)) return;
  res.json(buildTemplate(kind, Number(req.query.subject_id) || 0, String(req.query.purpose || '')));
});

router.get('/certificates', requireStaff(), (req, res) => {
  const { kind = '', q = '', from = '', to = '', status = '' } = req.query;
  const where = [], args = [];
  // 沒有人事權限的看不到在職／離職證明，沒有個案權限的看不到治療證明
  const allowed = Object.keys(KINDS).filter(k =>
    req.user.role === 'admin' || (req.userModules || []).includes(KINDS[k].module));
  if (!allowed.length) return res.json({ rows: [] });
  where.push(`c.kind IN (${allowed.map(() => '?').join(',')})`);
  args.push(...allowed);
  if (kind) { where.push('c.kind = ?'); args.push(kind); }
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (from) { where.push('c.issue_date >= ?'); args.push(from); }
  if (to) { where.push('c.issue_date <= ?'); args.push(to); }
  if (q) { where.push('(c.cert_no LIKE ? OR c.subject_name LIKE ? OR c.purpose LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  res.json({
    rows: db.prepare(`SELECT c.*, u.name AS issuer_name FROM certificates c
      LEFT JOIN users u ON u.id = c.issued_by
      WHERE ${where.join(' AND ')} ORDER BY c.issue_date DESC, c.id DESC LIMIT 300`).all(...args)
      .map(r => ({ ...r, data: JSON.parse(r.data || '{}'), kind_label: KINDS[r.kind].label }))
  });
});

function getCert(req, res) {
  const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!c) { res.status(404).json({ error: '找不到此證明書' }); return null; }
  if (!checkAccess(req, res, c.kind)) return null;
  return c;
}

router.get('/certificates/:id', requireStaff(), (req, res) => {
  const c = getCert(req, res);
  if (!c) return;
  res.json({ ...c, data: JSON.parse(c.data || '{}'), kind_label: KINDS[c.kind].label });
});

// 內容一律以前端送來的 data 為準（每一欄都可改），只把空白列丟掉
function cleanData(d = {}) {
  const list = v => (Array.isArray(v) ? v
    .map(r => ({ label: String(r.label || '').trim(), value: String(r.value === undefined ? '' : r.value) }))
    .filter(r => r.label || r.value) : []);
  return {
    title: String(d.title || '').trim(),
    subtitle: String(d.subtitle || '').trim(),
    rows: list(d.rows),
    statement_label: String(d.statement_label || '').trim(),
    statement: String(d.statement || ''),
    org: list(d.org),
    signatures: list(d.signatures),
    grid: d.grid && Array.isArray(d.grid.headers) && d.grid.headers.length ? {
      label: String(d.grid.label || ''),
      headers: d.grid.headers.map(h => String(h || '').trim()).filter(Boolean),
      rows: Math.min(60, Math.max(1, Math.round(Number(d.grid.rows) || 1))),
      // 已填好的資料列（如方案服務明細的每次晤談）；每格都可改字
      data: Array.isArray(d.grid.data)
        ? d.grid.data.slice(0, 60).map(r => (Array.isArray(r) ? r : []).map(v => String(v === undefined ? '' : v)))
        : []
    } : null,
    copies: Array.isArray(d.copies)
      ? d.copies.map(x => String(x || '').trim()).filter(Boolean).slice(0, 6) : [],
    footer_date: String(d.footer_date || '')
  };
}

router.post('/certificates', requireStaff(), (req, res) => {
  const b = req.body || {};
  const kind = KINDS[b.kind] ? b.kind : 'employment';
  if (!checkAccess(req, res, kind)) return;
  const data = cleanData(b.data);
  if (!data.title) return res.status(400).json({ error: '請填寫證明書標題' });
  const subjectId = Number(b.subject_id) || 0;
  const isUser = KINDS[kind].subject === 'user';
  const subject = subjectId
    ? db.prepare(`SELECT id, name FROM ${isUser ? 'users' : 'clients'} WHERE id = ?`).get(subjectId)
    : null;
  const name = String(b.subject_name || (subject && subject.name) || '').trim();
  if (!name) return res.status(400).json({ error: '請填寫當事人姓名' });

  const no = nextCertNo();
  const info = db.prepare(`INSERT INTO certificates
    (cert_no, kind, user_id, client_id, subject_name, issue_date, purpose, data, issued_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(no, kind,
    isUser ? (subject ? subject.id : null) : null,
    isUser ? null : (subject ? subject.id : null),
    name, String(b.issue_date || today()), String(b.purpose || ''),
    JSON.stringify(data), req.user.id);
  audit('staff', req.user.id, req.user.name, '開立證明書', `${KINDS[kind].label}／${name}`, { cert_no: no });
  res.json({ id: info.lastInsertRowid, cert_no: no });
});

router.put('/certificates/:id', requireStaff(), (req, res) => {
  const c = getCert(req, res);
  if (!c) return;
  if (c.status === 'void') return res.status(400).json({ error: '已作廢的證明書不可修改，請重新開立' });
  const b = req.body || {};
  const data = cleanData({ ...JSON.parse(c.data || '{}'), ...(b.data || {}) });
  if (!data.title) return res.status(400).json({ error: '請填寫證明書標題' });
  db.prepare(`UPDATE certificates SET subject_name = ?, issue_date = ?, purpose = ?, data = ? WHERE id = ?`)
    .run(String(b.subject_name || c.subject_name).trim(), String(b.issue_date || c.issue_date),
      String(b.purpose === undefined ? c.purpose : b.purpose), JSON.stringify(data), c.id);
  audit('staff', req.user.id, req.user.name, '修改證明書', c.cert_no);
  res.json({ ok: true });
});

// 作廢：已交出去的證明書不刪除，留紀錄才查得到誰在何時開過
router.post('/certificates/:id/void', requireStaff(), (req, res) => {
  const c = getCert(req, res);
  if (!c) return;
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '請填寫作廢原因' });
  db.prepare("UPDATE certificates SET status = 'void', void_reason = ? WHERE id = ?").run(reason, c.id);
  audit('staff', req.user.id, req.user.name, '作廢證明書', c.cert_no, { reason });
  res.json({ ok: true });
});

router.delete('/certificates/:id', requireStaff(), (req, res) => {
  const c = getCert(req, res);
  if (!c) return;
  if (c.status !== 'void') return res.status(400).json({ error: '請先作廢再刪除' });
  db.prepare('DELETE FROM certificates WHERE id = ?').run(c.id);
  audit('staff', req.user.id, req.user.name, '刪除證明書', c.cert_no);
  res.json({ ok: true });
});

// 列印／匯出：同一份 HTML，format=doc 時以 Word 開啟（開了還能繼續改字）
function certHtml(c, data, forWord) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nl = v => esc(v).replace(/\n/g, '<br>');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(data.title)}－${esc(c.subject_name)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
    color: #1c2b2b; font-size: 14px; line-height: 1.9; }
  .sub { text-align: center; font-size: 15px; margin-bottom: 4px; }
  h1 { font-size: 24px; text-align: center; letter-spacing: 8px; margin: 0 0 6px; }
  .no { text-align: right; font-size: 12px; color: #667; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 18px; }
  th, td { border: 1px solid #444; padding: 8px 10px; }
  th { background: #f2f5f5; width: 130px; text-align: left; font-weight: 600; }
  .stmt { margin: 18px 0 26px; }
  .stmt .lb { font-weight: 600; margin-bottom: 4px; }
  .org { margin-top: 26px; line-height: 2.1; }
  .sign { margin-top: 30px; line-height: 3; }
  .sign span { display: inline-block; min-width: 220px; border-bottom: 1px solid #444; }
  .date { margin-top: 34px; text-align: center; letter-spacing: 2px; }
  .void { color: #b4381f; text-align: center; font-size: 18px; margin-bottom: 8px; }
  .gridlb { font-weight: 600; margin: 18px 0 6px; }
  section { page-break-after: always; }
  section:last-child { page-break-after: auto; }
  .copytag { margin-top: 16px; text-align: right; color: #667; font-size: 12px; }
  table.grid th { background: #f2f5f5; width: auto; text-align: center; }
  table.grid td { height: 30px; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
${(data.copies && data.copies.length ? data.copies : [null]).map(copyLabel => `<section>
${c.status === 'void' ? `<div class="void">【已作廢】${esc(c.void_reason)}</div>` : ''}
${data.subtitle ? `<div class="sub">${esc(data.subtitle)}</div>` : ''}
<h1>${esc(data.title)}</h1>
<div class="no">編號：${esc(c.cert_no)}</div>
<table>${data.rows.map(r => `<tr><th>${esc(r.label)}</th><td>${nl(r.value)}</td></tr>`).join('')}</table>
${data.statement ? `<div class="stmt">${data.statement_label
    ? `<div class="lb">${esc(data.statement_label)}</div>` : ''}${nl(data.statement)}</div>` : ''}
${data.grid ? `${data.grid.label ? `<div class="gridlb">${esc(data.grid.label)}</div>` : ''}
<table class="grid"><tr>${data.grid.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
${(data.grid.data || []).map(row =>
    `<tr>${data.grid.headers.map((h, i) => `<td>${esc(row[i] || '')}</td>`).join('')}</tr>`).join('')}
${Array.from({ length: Math.max(0, data.grid.rows - (data.grid.data || []).length) }, () =>
    `<tr>${data.grid.headers.map(() => '<td>&nbsp;</td>').join('')}</tr>`).join('')}</table>` : ''}
<div class="org">${data.org.map(r => `${esc(r.label)}：${esc(r.value)}`).join('<br>')}</div>
${data.signatures.length ? `<div class="sign">${data.signatures.map(r =>
    `${esc(r.label)}：<span>${esc(r.value)}</span>`).join('<br>')}</div>` : ''}
<div class="date">${esc(data.footer_date)}</div>
${copyLabel ? `<div class="copytag">${esc(copyLabel)}</div>` : ''}
</section>`).join('')}
${forWord ? '' : '<script>if (location.hash !== \'#noprint\') setTimeout(() => window.print(), 300);<\/script>'}
</body></html>`;
}

router.get('/certificates/:id/print', requireStaff(), (req, res) => {
  const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).send('找不到此證明書');
  const mod = KINDS[c.kind].module;
  if (req.user.role !== 'admin' && !(req.userModules || []).includes(mod)) {
    return res.status(403).send('無權限檢視此類證明書');
  }
  const data = JSON.parse(c.data || '{}');
  const forWord = req.query.format === 'doc';
  db.prepare('UPDATE certificates SET print_count = print_count + 1, last_printed_at = ? WHERE id = ?')
    .run(new Date().toISOString().slice(0, 16).replace('T', ' '), c.id);
  audit('staff', req.user.id, req.user.name, forWord ? '匯出證明書（Word）' : '列印證明書',
    `${KINDS[c.kind].label}／${c.subject_name}`, { cert_no: c.cert_no });
  if (forWord) {
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cert_${c.cert_no}.doc"`);
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  res.send(certHtml(c, data, forWord));
});

module.exports = router;
