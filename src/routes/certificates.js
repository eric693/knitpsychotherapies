// 證明書：在職證明書、離職證明書、治療證明。
//
// 三種都是「一張紙、幾個欄位、一段聲明」，所方常要臨時改字（改用途、加備註、
// 換稱謂），因此版面與文字整份存在 data（JSON）裡：標題、每一列的欄位名與內容、
// 聲明段落、機構抬頭、核章欄位，逐張都能改，也能自行增列或刪列。
// 套版只負責帶入預設值與當事人資料，不限制所方最後怎麼寫。

const express = require('express');
const { db, audit, today, getSetting, setSetting, listSetting, ageYears } = require('../db');
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
  referral_clinic: { label: '轉介單（一式三聯）', module: 'clients', subject: 'client' },
  // 兒少：未成年個案的基本資料表，以及家長申請早療補助要附的療育紀錄
  profile_minor: { label: '未成年個案基本資料表', module: 'clients', subject: 'client' },
  early_intervention: { label: '早療補助療育紀錄', module: 'clients', subject: 'client' },
  // 官方版補助表單：學齡前走早療（社會局），學齡走弱勢療育訓練費（醫療補助計畫）
  ei_official: { label: '早療補助官方表單（表一～表三）', module: 'clients', subject: 'client' },
  disadv_official: { label: '弱勢療育補助記錄卡（表件二）', module: 'clients', subject: 'client' }
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

// 兒少再分兒童與青少年：紙本與方案的用語不同（兒童講「上課」「家長」，
// 青少年多半自己來談），分層依生日推算，未填生日則以未成年一概稱之。
function ageGroup(birthDate) {
  const age = birthDate ? ageYears(birthDate) : null;
  if (age === null) return { key: 'minor', label: '未成年' };
  if (age < 12) return { key: 'child', label: '兒童' };
  if (age < 18) return { key: 'teen', label: '青少年' };
  return { key: 'adult', label: '成人' };
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
  if (kind === 'profile_minor') {
    const pick = (v, opts) => (v ? String(v) : opts);
    return [
      { label: '姓名', value: u.name || '' },
      { label: '生日', value: rocText(u.birth_date) || '民國＿＿＿年＿＿＿月＿＿＿日' },
      { label: '身分證號碼', value: u.id_no || '' },
      { label: '性別', value: pick(GENDER[u.gender], '男 ／ 女（請圈選）') },
      { label: '電話', value: u.phone || '' },
      { label: '就讀學校', value: u.school || '' },
      { label: '年級', value: u.grade || '' },
      { label: '主要照顧者（監護人）', value: u.guardian_name
        ? `${u.guardian_name}（${u.guardian_relationship || ''}）${u.guardian_phone || ''}` : '' },
      { label: '地址', value: u.address || '' },
      { label: '家中同住成員', value: '' },
      { label: '醫院評估', value: '是，在＿＿＿＿＿＿醫院；否（＿＿＿＿＿＿）' },
      { label: '綜合報告書', value: '有：語言 ／ 心理 ／ 職能 ／ 物理（請圈選）；無' },
      { label: '目前療育課程', value: '語言 ／ 心理 ／ 職能 ／ 物理（請圈選）' },
      { label: '重大醫療史', value: u.history || '' },
      { label: '壓力或創傷事件', value: '' },
      { label: '主要困擾', value: u.main_issue || '' },
      { label: '其他想讓心理師知道的事', value: '' }
    ];
  }
  if (kind === 'ei_official' || kind === 'disadv_official') {
    const mark = '□';
    return [
      { label: '兒童姓名', value: u.name || '' },
      { label: '性別', value: GENDER[u.gender] || '□男　□女' },
      { label: '出生日期', value: rocText(u.birth_date) },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '戶籍地址', value: u.address || '' },
      { label: '申請人（主要照顧者）', value: u.guardian_name
        ? `${u.guardian_name}（${u.guardian_relationship || ''}）${u.guardian_phone || ''}` : '' },
      { label: '申請月份', value: extra.month || '' },
      ...(kind === 'ei_official' ? [
        { label: '兒童遲緩狀況', value:
          `${mark}身心障礙證明，第＿＿＿類，程度：${mark}輕度 ${mark}中度 ${mark}重度 ${mark}極重度\n`
          + `${mark}發展遲緩證明，類別：${mark}認知 ${mark}語言 ${mark}動作 ${mark}社會情緒 ${mark}聽力 ${mark}其他發展\n`
          + `${mark}疑似發展遲緩證明，類別：${mark}認知 ${mark}語言 ${mark}動作 ${mark}社會情緒 ${mark}聽力 ${mark}其他發展` },
        { label: '申請別', value: `${mark}首次申請，完成通報日：＿＿＿年＿＿月＿＿日　${mark}低收入戶（請檢附低收證明）` },
        { label: '應備文件', value: [
          '1. 申請表【表一】', '2. 療育紀錄卡－交通補助【表二】',
          '3. 療育紀錄卡－療育補助【表三】（貼附收據正本）',
          '4. 有效期限內身障證明、評估報告書或區域級以上醫院相關科別診斷證明書影本',
          '5. 三個月內電子戶籍謄本或新式戶口名簿影本', '6. 兒童（或監護人）郵局存摺封面影本',
          '7. 低收入戶證明影本', '8. 其他文件證明＿＿＿＿＿＿＿＿'
        ].map(x => mark + x).join('\n') },
        { label: '撥款帳戶', value: '郵局局號：□□□□□□□　帳號：□□□□□□□\n'
          + `戶名：${mark}同受補助兒童　${mark}同申請人` }
      ] : [
        { label: '補助項目', value: '療育訓練費補助' }
      ])
    ];
  }
  if (kind === 'early_intervention') {
    return [
      { label: '兒童姓名', value: u.name || '' },
      { label: '出生日期', value: rocText(u.birth_date) },
      { label: '身分證字號', value: u.id_no || '' },
      { label: '主要照顧者（監護人）', value: u.guardian_name || '' },
      { label: '療育單位', value: getSetting('center_name', '') },
      { label: '單位地址／電話', value: `${getSetting('center_address', '')}　${getSetting('center_phone', '')}` },
      { label: '療育項目', value: getSetting('early_intervention_item', '心理治療') },
      { label: '申請月份', value: extra.month || '' }
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
function gridFor(kind, subject, opts = {}) {
  if (kind === 'profile') {
    return { label: '晤談紀錄（每次晤談由櫃檯填寫）', headers: ['日期', '時間', '簽名', '收費'], rows: 12 };
  }
  if (kind === 'profile_minor') {
    return { label: '上課紀錄（每次上課由家長簽名）', headers: ['上課日期', '時間', '家長簽名', '收費'], rows: 12 };
  }
  if (kind === 'ei_official' || kind === 'disadv_official') {
    const data = subject ? earlyInterventionRows(subject.id, opts.month) : [];
    return {
      label: '療育明細（依本所紀錄帶出，送件時請貼附收據正本並蓋章）',
      headers: ['療育日期', '療育項目', '療育單位', '療育人員（蓋章）', '自費金額', '收據號碼'],
      rows: Math.max(4, data.length),
      data
    };
  }
  if (kind === 'early_intervention') {
    const data = subject ? earlyInterventionRows(subject.id, opts.month) : [];
    return {
      label: '療育紀錄（申請補助時請併附收據正本，並由療育單位及療育人員蓋章）',
      headers: ['療育日期', '療育項目', '療育單位', '療育人員（蓋章）', '自費金額', '收據號碼'],
      rows: Math.max(4, data.length),
      data
    };
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
  if (kind === 'profile' || kind === 'profile_minor') return [];
  if (['early_intervention', 'ei_official', 'disadv_official'].includes(kind)) {
    return [
      { label: '療育人員（蓋章）', value: '' },
      { label: '療育單位（蓋章）', value: '' }
    ];
  }
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

// 早療補助的療育紀錄：某月（未指定則整年）已完成的晤談，
// 逐次列出日期、療育人員與自費金額，並附上該次的收據號碼（家長要貼收據正本）。
function earlyInterventionRows(clientId, month) {
  const like = month ? `${month}-%` : '%';
  const item = getSetting('early_intervention_item', '心理治療');
  const center = getSetting('center_name', '');
  const rows = db.prepare(`SELECT a.date, a.fee, u.name AS counselor_name,
      (SELECT GROUP_CONCAT(rc.receipt_no, '、') FROM receipts rc
        JOIN invoices i ON i.id = rc.invoice_id
        WHERE i.appointment_id = a.id AND rc.status = 'valid') AS receipt_nos
    FROM appointments a LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.client_id = ? AND a.status = 'done' AND a.date LIKE ?
    ORDER BY a.date`).all(clientId, like);
  return rows.map(r => [
    r.date ? `${Number(r.date.slice(0, 4)) - 1911}/${r.date.slice(5, 7)}/${r.date.slice(8, 10)}` : '',
    item, center, r.counselor_name || '', String(r.fee || 0), r.receipt_nos || ''
  ]);
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

// 每一種表單的預設內容都可以改：把改好的版面「存成預設」後，
// 之後開立同類表單就以它為底（settings 的 cert_tpl_<kind>），
// 而姓名、日期、療程等會隨個案變動的欄位仍照樣自動帶入。
function savedTemplate(kind) {
  try {
    const raw = getSetting(`cert_tpl_${kind}`, '');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// 合併：文字以所方存的預設為準，值若是系統帶得出來的（同欄位名有值）就用系統的
function mergeTemplate(base, saved) {
  if (!saved) return base;
  const autofill = new Map((base.rows || []).filter(r => r.value).map(r => [r.label, r.value]));
  return {
    ...base,
    ...saved,
    rows: (saved.rows || []).map(r => ({ label: r.label, value: autofill.get(r.label) || r.value || '' })),
    // 表格資料（療程明細等）一律用系統當下算出來的，只沿用標題與欄位名
    grid: base.grid && saved.grid
      ? { ...saved.grid, data: base.grid.data || [], rows: Math.max(saved.grid.rows || 0, (base.grid.data || []).length) }
      : (base.grid || saved.grid || null)
  };
}

// 套版：帶出這一張證明書的預設內容，前端再逐欄修改
function buildTemplate(kind, subjectId, purpose = '', month = '') {
  const def = KINDS[kind];
  const statementRaw = getSetting(`cert_${kind}_statement`, '');
  let subject = null, extra = {};
  if (def.subject === 'user' && subjectId) {
    subject = db.prepare('SELECT * FROM users WHERE id = ?').get(subjectId) || null;
  } else if (def.subject === 'client' && subjectId) {
    subject = db.prepare('SELECT * FROM clients WHERE id = ?').get(subjectId) || null;
    if (subject && kind === 'treatment') extra = treatmentFacts(subject.id);
    if (subject && kind === 'referral') extra = { bsrs: latestBsrs(subject.id) };
    if (['early_intervention', 'ei_official', 'disadv_official'].includes(kind)) extra = { month };
  }
  return {
    kind,
    subject_id: subject ? subject.id : 0,
    subject_name: subject ? subject.name : '',
    purpose,
    data: {
      title: kind === 'profile_minor' && subject
        ? getSetting('cert_profile_minor_title', def.label)
          .replace('未成年', ageGroup(subject.birth_date).label)
        : getSetting(`cert_${kind}_title`, def.label),
      subtitle: kind === 'treatment' ? getSetting('center_name', '') : '',
      rows: subjectRows(kind, subject, extra),
      statement_label: kind === 'treatment' ? '單位聲明' : '',
      statement: statementRaw.replace('{purpose}', purpose || '＿＿＿＿'),
      org: orgBlock(kind),
      signatures: signatureRows(kind),
      // 基本資料表背面的簽到欄：空白格數可自行增減，欄位名稱也能改
      grid: gridFor(kind, subject, { month }),
      // 官方表單走專屬版面（蓋章格、收據浮貼處），其餘用通用版面
      layout: kind === 'ei_official' ? 'ei_official' : (kind === 'disadv_official' ? 'disadv_official' : ''),
      form_note: kind === 'ei_official' ? getSetting('ei_form2_note', '')
        : (kind === 'disadv_official' ? getSetting('disadv_form_note', '') : ''),
      form_note2: kind === 'ei_official' ? getSetting('ei_form3_note', '') : '',
      stamp_cells: kind === 'ei_official' ? Number(getSetting('ei_form2_cells', '12')) || 12 : 0,
      transport_fee: Number(getSetting('ei_transport_fee', '200')) || 200,
      authority: kind === 'ei_official' ? getSetting('ei_official_authority', '')
        : (kind === 'disadv_official' ? getSetting('disadv_official_authority', '') : ''),
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
  const tpl = buildTemplate(kind, Number(req.query.subject_id) || 0, String(req.query.purpose || ''),
    String(req.query.month || ''));
  tpl.data = mergeTemplate(tpl.data, savedTemplate(kind));
  tpl.has_saved_template = !!savedTemplate(kind);
  res.json(tpl);
});

// 存成預設：把這份版面（標題、欄位名稱與固定文字、聲明、表格欄位）記起來，
// 之後同類表單都以它開始；個案姓名等會變動的欄位仍即時帶入。
router.post('/certificates/template/:kind', requireStaff('settings'), (req, res) => {
  const kind = req.params.kind;
  if (!KINDS[kind]) return res.status(404).json({ error: '找不到此類別' });
  const data = cleanData((req.body || {}).data);
  if (!data.title) return res.status(400).json({ error: '請填寫標題' });
  // 存的是「版面與固定文字」，不是某一位當事人的資料：
  // 開立畫面多半是在某位個案身上改的，若原封不動存起來，下一位個案就會看到上一位的
  // 姓名、身分證字號與療程明細。因此凡是系統自動帶入的欄位一律清空，表格資料也不存。
  const base = buildTemplate(kind, Number((req.body || {}).subject_id) || 0,
    String((req.body || {}).purpose || ''), String((req.body || {}).month || '')).data;
  const auto = new Map((base.rows || []).filter(r => r.value).map(r => [r.label, r.value]));
  data.rows = data.rows.map(r => (auto.get(r.label) === r.value ? { ...r, value: '' } : r));
  if (data.grid) data.grid = { ...data.grid, data: [] };
  setSetting(`cert_tpl_${kind}`, JSON.stringify(data));
  audit('staff', req.user.id, req.user.name, '設定表單預設內容', KINDS[kind].label);
  res.json({ ok: true });
});

// 回復系統預設（清掉所方存的版面）
router.delete('/certificates/template/:kind', requireStaff('settings'), (req, res) => {
  const kind = req.params.kind;
  if (!KINDS[kind]) return res.status(404).json({ error: '找不到此類別' });
  setSetting(`cert_tpl_${kind}`, '');
  audit('staff', req.user.id, req.user.name, '回復表單預設內容', KINDS[kind].label);
  res.json({ ok: true });
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
    layout: ['ei_official', 'disadv_official'].includes(d.layout) ? d.layout : '',
    form_note: String(d.form_note || ''),
    form_note2: String(d.form_note2 || ''),
    stamp_cells: Math.min(40, Math.max(0, Math.round(Number(d.stamp_cells) || 0))),
    transport_fee: Math.max(0, Math.round(Number(d.transport_fee) || 0)),
    authority: String(d.authority || ''),
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

// 官方補助表單的版面（臺中市早療交通及療育補助表一～表三、弱勢療育訓練費補助表件二）。
// 這些表要蓋章、要浮貼收據正本，欄位位置固定，因此不走通用版面；
// 表格內的文字（注意事項、應備文件、蓋章格數）一樣存在 data 裡，逐張可改。
function officialHtml(c, data, forWord) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nl = v => esc(v).replace(/\n/g, '<br>');
  const row = label => (data.rows.find(r => r.label === label) || { value: '' }).value;
  const head = title => `<div class="hd">${esc(data.authority)}</div>
    <h1>${esc(title)}</h1>
    <div class="line">兒童姓名：<b>${esc(row('兒童姓名'))}</b>　　月　份：${esc(row('申請月數') || row('申請月份'))}</div>`;
  const dataRows = (data.grid && data.grid.data) || [];
  const blank = n => Array.from({ length: n }, () => '');

  // 表一：申請表（欄位逐列，內容都可改字）
  const form1 = `<section>
    <div class="hd">${esc(data.authority)}</div>
    <h1>${esc(data.title)}（表一）</h1>
    <div class="no">編號：${esc(c.cert_no)}</div>
    <table>${data.rows.map(r => `<tr><th>${esc(r.label)}</th><td>${nl(r.value)}</td></tr>`).join('')}</table>
    ${data.statement ? `<div class="stmt">${nl(data.statement)}</div>` : ''}
    <div class="gridlb">審核欄（由受理單位填寫）</div>
    <table class="grid"><tr><th>月份</th><th>交通費</th><th>療育費</th><th>合計</th></tr>
      ${blank(4).map(() => '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>').join('')}
      <tr><td>總計</td><td>核定交通補助＿＿＿元</td><td>核定療育補助＿＿＿元</td><td>＿＿＿元</td></tr></table>
    <div class="sign">承辦人：<span></span>　單位主管：<span></span></div>
    <div class="date">${esc(data.footer_date)}</div>
  </section>`;

  // 表二：交通補助紀錄卡（每格一次療育，蓋三個章）
  const cells = Array.from({ length: data.stamp_cells || 12 }, (_, i) => {
    const d = dataRows[i] || [];
    return `<td class="cell">
      <div>療育日期：${esc(d[0] || '')}</div>
      <div>療育項目：${esc(d[1] || '')}（蓋章）</div>
      <div>療育單位：${esc(d[2] || '')}（蓋章）</div>
      <div>療育人員：${esc(d[3] || '')}（蓋章）</div></td>`;
  });
  const cellRows = [];
  for (let i = 0; i < cells.length; i += 4) cellRows.push(`<tr>${cells.slice(i, i + 4).join('')}</tr>`);
  const form2 = `<section>
    ${head('早期療育紀錄卡－交通補助（表二）')}
    <div class="note">※ 療育日期、項目、單位、人員請確實填寫核章；若有塗改請療育人員務必加蓋職章！</div>
    <table class="grid stamp">${cellRows.join('')}</table>
    <div class="calc">（本欄由受理單位填寫）核定金額：＿＿＿年＿＿月，核定交通費 ＿＿＿ 次 × ${esc(data.transport_fee || 200)} 元，合計＿＿＿＿＿元</div>
    ${data.form_note ? `<div class="note">${nl(data.form_note)}</div>` : ''}
  </section>`;

  // 表三／表件二：療育（訓練）費補助紀錄卡，右側浮貼收據正本
  const feeRows = (dataRows.length ? dataRows : [[], [], [], []]).map(d => `<tr>
    <td>療育單位：${esc(d[2] || '')}<br>療育項目：${esc(d[1] || '')}<br>療育人員（蓋章）：${esc(d[3] || '')}
      <div class="paste">收據正本浮貼處${d[5] ? `<br><span class="rc">收據號碼：${esc(d[5])}</span>` : ''}</div></td>
    <td>${esc(d[0] || '　月　日')}</td>
    <td class="amt">${esc(d[4] || '')}</td>
    <td>&nbsp;</td></tr>`).join('');
  const feeTitle = data.layout === 'disadv_official'
    ? `${esc(data.title)}（表件二　療育訓練費補助記錄表）`
    : '早期療育紀錄卡－療育補助（表三）';
  const form3 = `<section>
    ${head(feeTitle)}
    ${data.form_note2 ? `<div class="note">${nl(data.form_note2)}</div>` : ''}
    <table class="grid"><tr><th>單位蓋章及收據正本</th><th>日期</th><th>自費金額</th><th>核定金額<br>（審核人員填寫）</th></tr>
      ${feeRows}</table>
    <div class="calc">（審核人員填寫）療育費補助合計：＿＿＿＿＿元</div>
    ${data.layout === 'disadv_official' && data.form_note ? `<div class="note">${nl(data.form_note)}</div>` : ''}
    <div class="sign">${data.signatures.map(r => `${esc(r.label)}：<span>${esc(r.value)}</span>`).join('　')}</div>
    <div class="date">${esc(data.footer_date)}</div>
  </section>`;

  const pages = data.layout === 'disadv_official'
    ? [`<section>
        <div class="hd">${esc(data.authority)}</div>
        <h1>${esc(data.title)}</h1>
        <div class="no">編號：${esc(c.cert_no)}</div>
        <table>${data.rows.map(r => `<tr><th>${esc(r.label)}</th><td>${nl(r.value)}</td></tr>`).join('')}</table>
      </section>`, form3]
    : [form1, form2, form3];

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(data.title)}－${esc(c.subject_name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
    color: #1c2b2b; font-size: 12.5px; line-height: 1.8; }
  section { page-break-after: always; }
  section:last-child { page-break-after: auto; }
  .hd { text-align: center; font-size: 13px; }
  h1 { font-size: 18px; text-align: center; letter-spacing: 2px; margin: 4px 0 10px; }
  .no { text-align: right; font-size: 11.5px; color: #667; }
  .line { margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 10px; }
  th, td { border: 1px solid #444; padding: 6px 8px; vertical-align: top; }
  th { background: #f2f5f5; width: 130px; text-align: left; }
  table.grid th { width: auto; text-align: center; }
  td.cell { width: 25%; height: 92px; font-size: 11.5px; }
  .paste { margin-top: 6px; border: 1px dashed #888; height: 70px; padding: 4px; color: #778; font-size: 11px; }
  .rc { color: #445; }
  .amt { text-align: right; }
  .note { font-size: 11.5px; color: #556; white-space: pre-wrap; margin-bottom: 8px; }
  .calc { margin: 8px 0; font-size: 12px; }
  .stmt { white-space: pre-wrap; margin: 10px 0; }
  .gridlb { font-weight: 600; margin: 12px 0 6px; }
  .sign { margin-top: 14px; }
  .sign span { display: inline-block; min-width: 150px; border-bottom: 1px solid #444; }
  .date { margin-top: 16px; text-align: center; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
${c.status === 'void' ? `<div class="hd" style="color:#b4381f">【已作廢】${esc(c.void_reason)}</div>` : ''}
${pages.join('')}
${forWord ? '' : '<script>if (location.hash !== \'#noprint\') setTimeout(() => window.print(), 300);<\/script>'}
</body></html>`;
}

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
  res.send(data.layout ? officialHtml(c, data, forWord) : certHtml(c, data, forWord));
});

module.exports = router;
