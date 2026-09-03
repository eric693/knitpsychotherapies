// 匯入註冊表：每種匯入在此定義一次（欄位、驗證、重複比對、寫入方式）。
//
// 定義集中在一處，路由只負責權限、檔案與流程，因此新增一種匯入只要在這裡加一筆，
// 範本下載、預覽驗證與實際匯入都會自動具備。
//
// 匯入一律走「上傳 → 預覽並逐列驗證 → 確認後寫入」三步，不做無預覽的直接匯入：
// 諮商所手上的舊資料多半是自己維護的 Excel，品質不一，讓所方先看到哪幾列有問題，
// 比匯入後再清理省事得多。且**只要有一列錯誤就整批拒絕**，避免出現匯入到一半的殘缺資料。
//
// 刻意不提供「晤談紀錄」匯入：SOAP 內容屬心理紀錄，逐筆確認撰寫者與簽核狀態才有意義，
// 批次灌入會破壞紀錄可信度。歷史紀錄建議留在原系統，需要時以個案附件保存掃描檔。
const bcrypt = require('bcryptjs');
const { db, today, getSetting, ageYears, nextClientCode } = require('./db');
const { SCALES, score } = require('./scales');

// ---- 共用的欄位轉換 ----

const trim = v => String(v ?? '').trim();

// 日期：接受 2026-01-05、2026/1/5、20260105、民國 115-01-05
function toDate(raw) {
  const s = trim(raw).replace(/[／.]/g, '/');
  if (!s) return '';
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 民國年：三碼或兩碼年份，加 1911
  m = /^(\d{2,3})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(m[1]) + 1911;
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  return null;   // null 代表格式無法辨識，與「未填」的空字串區分
}

// 時間：接受 14:00、14：00、1400、下午2點 之類的常見寫法
function toTime(raw) {
  const s = trim(raw).replace(/：/g, ':');
  if (!s) return '';
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
  m = /^(\d{3,4})$/.exec(s);
  if (m) {
    const v = m[1].padStart(4, '0');
    return `${v.slice(0, 2)}:${v.slice(2)}`;
  }
  return null;
}

function toInt(raw) {
  const s = trim(raw).replace(/[,，$元\s]/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Excel 把手機當數字存會吃掉開頭的 0，補回來並提醒
function toPhone(raw) {
  let s = trim(raw).replace(/[-\s()]/g, '');
  if (!s) return { value: '', warn: '' };
  if (/^9\d{8}$/.test(s)) return { value: `0${s}`, warn: '手機開頭的 0 已自動補回（Excel 存成數字時會消失）' };
  return { value: s, warn: '' };
}

const GENDER = { 男: 'male', 女: 'female', 其他: 'other', male: 'male', female: 'female', other: 'other', M: 'male', F: 'female' };
const CLIENT_STATUS = { 初談: 'intake', 進行中: 'active', 暫停: 'paused', 已結案: 'closed', 結案: 'closed' };
const RISK = { 低: 'low', 中: 'medium', 高: 'high', low: 'low', medium: 'medium', high: 'high' };
const APPT_TYPE = { 初談: 'intake', 個別諮商: 'individual', 伴侶諮商: 'couple', 家族諮商: 'family', 團體諮商: 'group', 心理衡鑑: 'assessment' };
const APPT_STATUS = { 已預約: 'booked', 已報到: 'arrived', 完成: 'done', 已完成: 'done', 取消: 'cancelled', 已取消: 'cancelled', 未到: 'no_show' };
const APPT_MODE = { 到所: 'onsite', 現場: 'onsite', 視訊: 'online', 線上: 'online', 電話: 'phone', 外展: 'outreach' };
const INV_STATUS = { 未收款: 'unpaid', 未收: 'unpaid', 已收款: 'paid', 已收: 'paid', 作廢: 'void' };
const YES = v => /^[1yY是有真]/.test(trim(v));

// 身分證統一編號檢查碼（與 routes/clients.js 同一套規則）
function idNoLooksWrong(idNo) {
  if (!/^[A-Z][12]\d{8}$/.test(idNo)) return false;   // 非標準格式（如居留證）不檢核
  const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const n = letters.indexOf(idNo[0]) + 10;
  let sum = Math.floor(n / 10) + (n % 10) * 9;
  for (let i = 1; i < 9; i++) sum += Number(idNo[i]) * (9 - i);
  sum += Number(idNo[9]);
  return sum % 10 !== 0;
}

// ---- 匯入定義 ----

const IMPORTS = [
  {
    key: 'clients',
    module: 'clients',
    title: '個案名冊',
    description: '建立個案主檔。以身分證統一編號、個案編號或手機比對重複，同一人不會重覆建檔。',
    columns: [
      { key: 'name', label: '姓名', required: true },
      { key: 'code', label: '個案編號', hint: '留空由系統自動產生（C+年份+流水）' },
      { key: 'id_no', label: '身分證統一編號', hint: '用於比對重複、通報與補助核銷' },
      { key: 'gender', label: '性別', hint: '男／女／其他' },
      { key: 'birth_date', label: '出生日期', hint: '可填 2001-03-15、2001/3/15 或民國 90/3/15' },
      { key: 'phone', label: '手機', hint: '個案專區的登入帳號；請將欄位設為文字格式，否則開頭的 0 會消失' },
      { key: 'email', label: 'Email' },
      { key: 'address', label: '通訊地址' },
      { key: 'occupation', label: '職業／就讀學校' },
      { key: 'marital', label: '婚姻狀況' },
      { key: 'counselor', label: '主責心理師', hint: '填系統中的心理師姓名，須完全相符' },
      { key: 'partner', label: '合作單位', hint: '填系統中的合作單位名稱，須完全相符' },
      { key: 'source', label: '轉介來源' },
      { key: 'referrer', label: '轉介單位／人' },
      { key: 'status', label: '狀態', hint: '初談／進行中／暫停／已結案（留空為初談）' },
      { key: 'risk_level', label: '風險等級', hint: '低／中／高（留空為低）' },
      { key: 'main_issue', label: '主訴問題' },
      { key: 'history', label: '過往就醫／諮商史' },
      { key: 'diagnosis', label: '醫療診斷' },
      { key: 'guardian_name', label: '法定代理人' },
      { key: 'guardian_relationship', label: '法代關係' },
      { key: 'guardian_phone', label: '法代電話' },
      { key: 'emergency_name', label: '緊急聯絡人' },
      { key: 'emergency_relationship', label: '緊急聯絡人關係' },
      { key: 'emergency_phone', label: '緊急聯絡人電話' },
      { key: 'intake_date', label: '初談日期' },
      { key: 'close_date', label: '結案日期' },
      { key: 'close_reason', label: '結案原因' },
      { key: 'note', label: '備註' }
    ],
    sample: [
      {
        name: '王小美', id_no: 'A234567890', gender: '女', birth_date: '1996/5/20',
        phone: '0912345678', occupation: '軟體工程師', counselor: '林筱雯',
        source: '自行求助', status: '進行中', risk_level: '中',
        main_issue: '工作壓力與情緒低落', intake_date: '2026/6/6',
        emergency_name: '王大明', emergency_relationship: '父', emergency_phone: '0922333444'
      },
      {
        name: '李承翰', gender: '男', birth_date: '2012/9/3', phone: '0933555777',
        occupation: '文昌國中八年級', counselor: '陳柏宇', partner: '市立文昌國中',
        source: '學校輔導室', status: '進行中', main_issue: '同儕衝突與注意力困難',
        guardian_name: '李美玲', guardian_relationship: '母', guardian_phone: '0933555888',
        intake_date: '2026/6/12'
      }
    ],

    parse(row, ctx) {
      const errors = [], warnings = [];
      const name = trim(row.name);
      if (!name) errors.push('姓名為必填');

      const idNo = trim(row.id_no).toUpperCase();
      if (idNo && idNoLooksWrong(idNo)) warnings.push('身分證統一編號檢查碼不符，仍會匯入，請自行確認');

      const phone = toPhone(row.phone);
      if (phone.warn) warnings.push(phone.warn);
      if (phone.value && !/^09\d{8}$/.test(phone.value)) {
        warnings.push('手機非 09 開頭的 10 碼，將不會開通個案專區登入');
      }

      const birthDate = toDate(row.birth_date);
      if (birthDate === null) errors.push(`出生日期「${trim(row.birth_date)}」無法辨識`);
      const intakeDate = toDate(row.intake_date);
      if (intakeDate === null) errors.push(`初談日期「${trim(row.intake_date)}」無法辨識`);
      const closeDate = toDate(row.close_date);
      if (closeDate === null) errors.push(`結案日期「${trim(row.close_date)}」無法辨識`);

      // 未成年依生日自動判定，與手動建檔的規則一致
      const adultAge = Number(getSetting('adult_age', '18'));
      const age = birthDate ? ageYears(birthDate) : null;
      const isMinor = age !== null && age < adultAge ? 1 : 0;
      if (isMinor && !trim(row.guardian_name)) {
        warnings.push(`依出生日期為 ${age} 歲（未滿 ${adultAge} 歲），已標記為未成年，但未填法定代理人`);
      }

      const counselorName = trim(row.counselor);
      let counselorId = null;
      if (counselorName) {
        const u = ctx.counselors.get(counselorName);
        if (!u) errors.push(`找不到心理師「${counselorName}」，請先於帳號權限建立或修正姓名`);
        else counselorId = u.id;
      }
      const partnerName = trim(row.partner);
      let partnerId = null;
      if (partnerName) {
        const p = ctx.partners.get(partnerName);
        if (!p) errors.push(`找不到合作單位「${partnerName}」，請先於合作單位建立或修正名稱`);
        else partnerId = p.id;
      }

      const genderRaw = trim(row.gender);
      if (genderRaw && !GENDER[genderRaw]) warnings.push(`性別「${genderRaw}」無法辨識，將留空`);
      const statusRaw = trim(row.status);
      if (statusRaw && !CLIENT_STATUS[statusRaw]) warnings.push(`狀態「${statusRaw}」無法辨識，將設為初談`);
      const riskRaw = trim(row.risk_level);
      if (riskRaw && !RISK[riskRaw]) warnings.push(`風險等級「${riskRaw}」無法辨識，將設為低`);

      const status = CLIENT_STATUS[statusRaw] || 'intake';
      if (status === 'closed' && !closeDate) warnings.push('狀態為已結案但未填結案日期，將以匯入日期補上');

      return {
        errors, warnings,
        data: {
          name, code: trim(row.code), id_no: idNo,
          gender: GENDER[genderRaw] || '', birth_date: birthDate || '', phone: phone.value,
          email: trim(row.email), address: trim(row.address), occupation: trim(row.occupation),
          marital: trim(row.marital), counselor_id: counselorId, partner_id: partnerId,
          source: trim(row.source), referrer: trim(row.referrer),
          status, risk_level: RISK[riskRaw] || 'low',
          main_issue: trim(row.main_issue), history: trim(row.history), diagnosis: trim(row.diagnosis),
          is_minor: isMinor,
          guardian_name: trim(row.guardian_name), guardian_relationship: trim(row.guardian_relationship),
          guardian_phone: toPhone(row.guardian_phone).value,
          emergency_name: trim(row.emergency_name), emergency_relationship: trim(row.emergency_relationship),
          emergency_phone: toPhone(row.emergency_phone).value,
          intake_date: intakeDate || '', close_date: closeDate || '',
          close_reason: trim(row.close_reason), note: trim(row.note)
        }
      };
    },

    // 同一個檔案內重複也要擋，否則兩列同一人會建成兩筆
    conflict(d, seen) {
      for (const [k, v] of [['身分證統一編號', d.id_no], ['個案編號', d.code], ['手機', d.phone]]) {
        if (!v) continue;
        const token = `${k}:${v}`;
        if (seen.has(token)) return `檔案中有其他列使用相同的${k}「${v}」`;
        seen.add(token);
      }
      return null;
    },

    // 先比身分證，再比個案編號，最後比手機；皆空則視為新資料（同名同姓不當作重複）
    findExisting(d) {
      if (d.id_no) {
        const c = db.prepare("SELECT id, name, code FROM clients WHERE id_no = ? AND id_no != ''").get(d.id_no);
        if (c) return { ...c, matched_by: '身分證統一編號' };
      }
      if (d.code) {
        const c = db.prepare('SELECT id, name, code FROM clients WHERE code = ?').get(d.code);
        if (c) return { ...c, matched_by: '個案編號' };
      }
      if (d.phone) {
        const c = db.prepare("SELECT id, name, code FROM clients WHERE phone = ? AND phone != ''").get(d.phone);
        if (c) return { ...c, matched_by: '手機' };
      }
      return null;
    },

    insert(d) {
      // 個案端預設密碼為手機末 6 碼，首次登入強制更換（與手動建檔一致）
      const hash = /^09\d{8}$/.test(d.phone) ? bcrypt.hashSync(d.phone.slice(-6), 10) : '';
      const info = db.prepare(`INSERT INTO clients
        (code, name, id_no, gender, birth_date, phone, email, address, occupation, marital,
         counselor_id, partner_id, source, referrer, status, risk_level, main_issue, history, diagnosis,
         is_minor, guardian_name, guardian_relationship, guardian_phone,
         emergency_name, emergency_relationship, emergency_phone,
         intake_date, close_date, close_reason, note, password_hash, must_change_password)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(d.code || nextClientCode(), d.name, d.id_no, d.gender, d.birth_date, d.phone, d.email,
          d.address, d.occupation, d.marital, d.counselor_id, d.partner_id, d.source, d.referrer,
          d.status, d.risk_level, d.main_issue, d.history, d.diagnosis, d.is_minor,
          d.guardian_name, d.guardian_relationship, d.guardian_phone,
          d.emergency_name, d.emergency_relationship, d.emergency_phone,
          d.intake_date || today(),
          d.status === 'closed' ? (d.close_date || today()) : d.close_date,
          d.close_reason, d.note, hash, hash ? 1 : 0);
      return info.lastInsertRowid;
    },

    // 更新模式：只覆蓋檔案中有填的欄位，避免把既有資料洗成空白
    update(existing, d) {
      const cur = db.prepare('SELECT * FROM clients WHERE id = ?').get(existing.id);
      const keep = (v, old) => (v === '' || v === undefined || v === null ? old : v);
      db.prepare(`UPDATE clients SET name = ?, id_no = ?, gender = ?, birth_date = ?, phone = ?, email = ?,
          address = ?, occupation = ?, marital = ?, counselor_id = ?, partner_id = ?, source = ?, referrer = ?,
          status = ?, risk_level = ?, main_issue = ?, history = ?, diagnosis = ?, is_minor = ?,
          guardian_name = ?, guardian_relationship = ?, guardian_phone = ?,
          emergency_name = ?, emergency_relationship = ?, emergency_phone = ?,
          intake_date = ?, close_date = ?, close_reason = ?, note = ? WHERE id = ?`)
        .run(keep(d.name, cur.name), keep(d.id_no, cur.id_no), keep(d.gender, cur.gender),
          keep(d.birth_date, cur.birth_date), keep(d.phone, cur.phone), keep(d.email, cur.email),
          keep(d.address, cur.address), keep(d.occupation, cur.occupation), keep(d.marital, cur.marital),
          d.counselor_id === null ? cur.counselor_id : d.counselor_id,
          d.partner_id === null ? cur.partner_id : d.partner_id,
          keep(d.source, cur.source), keep(d.referrer, cur.referrer),
          keep(d.status, cur.status), keep(d.risk_level, cur.risk_level),
          keep(d.main_issue, cur.main_issue), keep(d.history, cur.history), keep(d.diagnosis, cur.diagnosis),
          d.birth_date ? d.is_minor : cur.is_minor,
          keep(d.guardian_name, cur.guardian_name), keep(d.guardian_relationship, cur.guardian_relationship),
          keep(d.guardian_phone, cur.guardian_phone),
          keep(d.emergency_name, cur.emergency_name), keep(d.emergency_relationship, cur.emergency_relationship),
          keep(d.emergency_phone, cur.emergency_phone),
          keep(d.intake_date, cur.intake_date), keep(d.close_date, cur.close_date),
          keep(d.close_reason, cur.close_reason), keep(d.note, cur.note), cur.id);
      return cur.id;
    }
  },

  {
    key: 'client_phones',
    module: 'clients',
    // 這張表只補既有個案的手機，永遠不新增，因此匯入時固定走「更新」
    updateOnly: true,
    title: '個案手機（只更新手機欄）',
    description: '舊資料匯入時沒帶手機的個案，用這張表把手機補上——手機是個案專區的登入帳號，'
      + '沒有手機就沒有帳號、也收不到 LINE 綁定引導。只會覆蓋手機欄，其他資料一律不動；'
      + '個案原本沒有密碼時，一併設定預設密碼（手機末 6 碼，首次登入強制更換）。'
      + '只需要「個案編號、姓名（選填核對用）、手機」三欄。',
    columns: [
      { key: 'code', label: '個案編號', required: true, hint: '如 G20261234，用來對到系統裡的個案' },
      { key: 'name', label: '姓名', hint: '選填；有填就會與系統資料核對，不符即擋下，避免對錯人' },
      { key: 'phone', label: '手機', required: true, hint: '09 開頭共 10 碼；請將欄位設為文字格式，否則開頭的 0 會消失' }
    ],
    sample: [
      { code: 'G20261234', name: '王小美', phone: '0912345678' },
      { code: 'G20261235', name: '陳大明', phone: '0922333444' }
    ],

    parse(row, ctx) {
      const errors = [], warnings = [];
      const code = trim(row.code);
      const name = trim(row.name);
      const phone = toPhone(row.phone);
      if (!code) errors.push('缺少個案編號');
      if (phone.warning) warnings.push(phone.warning);
      if (!phone.value) errors.push('缺少手機');
      else if (!/^09\d{8}$/.test(phone.value)) errors.push(`手機格式有誤：${phone.value}`);

      const c = code ? ctx.clientsByCode.get(code) : null;
      if (code && !c) errors.push(`系統中找不到個案編號「${code}」`);
      // 對到人但姓名不符：多半是編號抄錯，寧可擋下也不要把手機寫到別人身上
      if (c && name && c.name !== name) errors.push(`編號 ${code} 在系統中是「${c.name}」，與檔案的「${name}」不符`);
      // 手機被別人用了：個案專區以手機登入，重複會登入到別人的資料
      if (!errors.length && phone.value) {
        const taken = db.prepare("SELECT code, name FROM clients WHERE phone = ? AND active = 1 AND code != ?")
          .get(phone.value, code);
        if (taken) errors.push(`手機 ${phone.value} 已是「${taken.name}（${taken.code}）」的號碼`);
      }
      if (c && c.phone && c.phone !== phone.value) warnings.push(`原本的手機 ${c.phone} 將被覆蓋`);
      return { errors, warnings, data: { code, name, phone: phone.value } };
    },

    conflict(d, seen) {
      for (const [k, v] of [['個案編號', d.code], ['手機', d.phone]]) {
        if (!v) continue;
        const token = `${k}:${v}`;
        if (seen.has(token)) return `檔案中有其他列使用相同的${k}「${v}」`;
        seen.add(token);
      }
      return null;
    },

    findExisting(d) {
      const c = db.prepare('SELECT id, name, code, phone FROM clients WHERE code = ?').get(d.code);
      return c ? { ...c, matched_by: '個案編號' } : null;
    },

    // 這張表只補既有個案的手機，不建檔；對不到人在 parse 就已擋下
    insert() {
      throw new Error('此匯入只更新既有個案的手機，請在匯入時選擇「更新既有資料」');
    },

    update(existing, d) {
      const cur = db.prepare('SELECT * FROM clients WHERE id = ?').get(existing.id);
      // 沒有密碼的個案順便開通專區帳號；已有密碼者不動，避免把人家改過的密碼洗掉
      const hash = cur.password_hash ? cur.password_hash : bcrypt.hashSync(d.phone.slice(-6), 10);
      const mustChange = cur.password_hash ? cur.must_change_password : 1;
      db.prepare('UPDATE clients SET phone = ?, password_hash = ?, must_change_password = ? WHERE id = ?')
        .run(d.phone, hash, mustChange, cur.id);
      return cur.id;
    }
  },

  {
    key: 'appointments',
    module: 'schedule',
    title: '晤談紀錄（排程與出席）',
    description: '匯入歷史晤談的日期、心理師與出席狀態，供服務量統計與心理師報酬計算。'
      + '不含 SOAP 內容——晤談內容屬心理紀錄，需逐筆撰寫與簽核，系統不提供批次灌入。',
    columns: [
      { key: 'client_code', label: '個案編號', hint: '與個案名冊的編號對應；或改填身分證統一編號' },
      { key: 'client_id_no', label: '個案身分證統一編號', hint: '未填個案編號時用此比對' },
      { key: 'date', label: '晤談日期', required: true },
      { key: 'start_time', label: '開始時間', required: true, hint: '例 14:00' },
      { key: 'end_time', label: '結束時間', hint: '留空依系統設定的晤談時長自動推算' },
      { key: 'counselor', label: '心理師', required: true, hint: '填系統中的心理師姓名，須完全相符' },
      { key: 'room', label: '諮商室', hint: '填系統中的諮商室名稱' },
      { key: 'type', label: '晤談類型', hint: '初談／個別諮商／伴侶諮商／家族諮商／心理衡鑑' },
      { key: 'mode', label: '形式', hint: '到所／視訊／電話／外展' },
      { key: 'status', label: '狀態', hint: '完成／取消／未到（留空為完成）' },
      { key: 'fee', label: '費用' },
      { key: 'note', label: '備註' }
    ],
    sample: [
      { client_code: 'C2026001', date: '2026/6/6', start_time: '14:00', counselor: '林筱雯', room: '諮商室 A', type: '初談', mode: '到所', status: '完成', fee: '2500' },
      { client_code: 'C2026001', date: '2026/6/13', start_time: '14:00', counselor: '林筱雯', room: '諮商室 A', type: '個別諮商', mode: '到所', status: '完成', fee: '2000' }
    ],

    parse(row, ctx) {
      const errors = [], warnings = [];

      const code = trim(row.client_code);
      const idNo = trim(row.client_id_no).toUpperCase();
      let client = null;
      if (code) client = ctx.clientsByCode.get(code) || null;
      if (!client && idNo) client = ctx.clientsByIdNo.get(idNo) || null;
      if (!client) errors.push(code || idNo ? `找不到個案「${code || idNo}」，請先匯入個案名冊` : '請填個案編號或身分證統一編號');

      const date = toDate(row.date);
      if (date === null) errors.push(`晤談日期「${trim(row.date)}」無法辨識`);
      else if (!date) errors.push('晤談日期為必填');

      const start = toTime(row.start_time);
      if (start === null) errors.push(`開始時間「${trim(row.start_time)}」無法辨識`);
      else if (!start) errors.push('開始時間為必填');

      let end = toTime(row.end_time);
      if (end === null) errors.push(`結束時間「${trim(row.end_time)}」無法辨識`);
      if (start && !end) {
        const mins = require('./plans').defaultSessionMinutes();
        const [h, m] = start.split(':').map(Number);
        const t = h * 60 + m + mins;
        end = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      }
      if (start && end && end <= start) errors.push('結束時間不可早於或等於開始時間');

      const counselorName = trim(row.counselor);
      let counselorId = null;
      if (!counselorName) errors.push('心理師為必填');
      else {
        const u = ctx.counselors.get(counselorName);
        if (!u) errors.push(`找不到心理師「${counselorName}」`);
        else counselorId = u.id;
      }

      const roomName = trim(row.room);
      let roomId = null;
      if (roomName) {
        const r = ctx.rooms.get(roomName);
        if (!r) warnings.push(`找不到諮商室「${roomName}」，將留空`);
        else roomId = r.id;
      }

      const typeRaw = trim(row.type);
      if (typeRaw && !APPT_TYPE[typeRaw]) warnings.push(`晤談類型「${typeRaw}」無法辨識，將設為個別諮商`);
      const statusRaw = trim(row.status);
      if (statusRaw && !APPT_STATUS[statusRaw]) warnings.push(`狀態「${statusRaw}」無法辨識，將設為完成`);
      const modeRaw = trim(row.mode);
      if (modeRaw && !APPT_MODE[modeRaw]) warnings.push(`形式「${modeRaw}」無法辨識，將設為到所`);

      const fee = toInt(row.fee);
      if (fee === null) errors.push(`費用「${trim(row.fee)}」不是數字`);

      // 匯入歷史資料不重跑計費：舊帳多半已在原系統結清，重新開單會產生假的應收
      const status = APPT_STATUS[statusRaw] || 'done';
      if (status === 'done') warnings.push('匯入的完成晤談不會自動產生收費單或扣方案次數，歷史帳款請另行匯入收費明細');

      return {
        errors, warnings,
        data: {
          client_id: client ? client.id : null,
          client_label: client ? `${client.name}（${client.code}）` : (code || idNo),
          date: date || '', start_time: start || '', end_time: end || '',
          counselor_id: counselorId, room_id: roomId,
          type: APPT_TYPE[typeRaw] || 'individual',
          mode: APPT_MODE[modeRaw] || 'onsite',
          status, fee: fee || 0, note: trim(row.note)
        }
      };
    },

    // 同一心理師同一時段只能有一筆有效預約，檔案內與資料庫都要檢查
    conflict(d, seen) {
      if (!d.counselor_id || !d.date || !d.start_time) return null;
      const token = `${d.counselor_id}|${d.date}|${d.start_time}`;
      if (seen.has(token)) return `檔案中有其他列的心理師與時段完全相同（${d.date} ${d.start_time}）`;
      seen.add(token);
      return null;
    },

    findExisting(d) {
      if (!d.client_id || !d.date || !d.start_time) return null;
      const a = db.prepare(`SELECT a.id, c.name, c.code FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE a.client_id = ? AND a.date = ? AND a.start_time = ?`).get(d.client_id, d.date, d.start_time);
      return a ? { ...a, matched_by: '個案＋日期＋時間' } : null;
    },

    insert(d) {
      // 歷史資料已是既成事實，charged 直接標記為已處理，日後改狀態才不會補開收費單
      const info = db.prepare(`INSERT INTO appointments
        (client_id, counselor_id, room_id, date, start_time, end_time, type, mode, status, fee, note, source, charged)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'import', ?)`)
        .run(d.client_id, d.counselor_id, d.room_id, d.date, d.start_time, d.end_time,
          d.type, d.mode, d.status, d.fee, d.note,
          d.status === 'done' || d.status === 'no_show' ? 1 : 0);
      return info.lastInsertRowid;
    },

    update(existing, d) {
      db.prepare(`UPDATE appointments SET counselor_id = ?, room_id = ?, end_time = ?, type = ?, mode = ?,
          status = ?, fee = ?, note = ? WHERE id = ?`)
        .run(d.counselor_id, d.room_id, d.end_time, d.type, d.mode, d.status, d.fee, d.note, existing.id);
      return existing.id;
    }
  },

  {
    key: 'invoices',
    module: 'billing',
    title: '收費明細',
    description: '匯入歷史收費與收款紀錄。已收款者請填收款日期與收據號碼，系統不會重新編號。',
    columns: [
      { key: 'client_code', label: '個案編號', hint: '或改填身分證統一編號' },
      { key: 'client_id_no', label: '個案身分證統一編號' },
      { key: 'date', label: '費用日期', required: true },
      { key: 'item', label: '項目', required: true },
      { key: 'amount', label: '金額', required: true },
      { key: 'payer', label: '付款人別', hint: '自費／企業EAP／學校方案／社會局補助／心理健康支持方案' },
      { key: 'status', label: '狀態', hint: '未收款／已收款／作廢（留空為未收款）' },
      { key: 'method', label: '付款方式', hint: '現金／轉帳／信用卡／行動支付' },
      { key: 'paid_at', label: '收款日期', hint: '狀態為已收款時填寫' },
      { key: 'receipt_no', label: '收據號碼', hint: '留空則已收款者自動編號' },
      { key: 'invoice_no', label: '發票號碼' },
      { key: 'buyer_tax_id', label: '買受人統一編號' },
      { key: 'subsidy_program', label: '補助方案名稱' },
      { key: 'subsidy_no', label: '補助方案序號' },
      { key: 'subsidy_amount', label: '補助金額', hint: '自付差額由系統自動算出' },
      { key: 'note', label: '備註' }
    ],
    sample: [
      { client_code: 'C2026001', date: '2026/6/6', item: '初談費用', amount: '2500', payer: '自費', status: '已收款', method: '信用卡', paid_at: '2026/6/6', receipt_no: 'MC2026060001' },
      { client_code: 'C2026002', date: '2026/7/1', item: '個別諮商', amount: '2000', payer: '心理健康支持方案', status: '已收款', method: '現金', paid_at: '2026/7/1', subsidy_program: '年輕族群心理健康支持方案', subsidy_no: 'YM-115-0031', subsidy_amount: '1600' }
    ],

    parse(row, ctx) {
      const errors = [], warnings = [];

      const code = trim(row.client_code);
      const idNo = trim(row.client_id_no).toUpperCase();
      let client = null;
      if (code) client = ctx.clientsByCode.get(code) || null;
      if (!client && idNo) client = ctx.clientsByIdNo.get(idNo) || null;
      if (!client) errors.push(code || idNo ? `找不到個案「${code || idNo}」，請先匯入個案名冊` : '請填個案編號或身分證統一編號');

      const date = toDate(row.date);
      if (date === null) errors.push(`費用日期「${trim(row.date)}」無法辨識`);
      else if (!date) errors.push('費用日期為必填');

      const item = trim(row.item);
      if (!item) errors.push('項目為必填');

      const amount = toInt(row.amount);
      if (amount === null) errors.push(`金額「${trim(row.amount)}」不是數字`);
      else if (amount <= 0) errors.push('金額須大於 0');

      const statusRaw = trim(row.status);
      if (statusRaw && !INV_STATUS[statusRaw]) warnings.push(`狀態「${statusRaw}」無法辨識，將設為未收款`);
      const status = INV_STATUS[statusRaw] || 'unpaid';

      const paidAt = toDate(row.paid_at);
      if (paidAt === null) errors.push(`收款日期「${trim(row.paid_at)}」無法辨識`);
      if (status === 'paid' && !paidAt) warnings.push('狀態為已收款但未填收款日期，將以費用日期補上');

      const subsidy = toInt(row.subsidy_amount);
      if (subsidy === null) errors.push(`補助金額「${trim(row.subsidy_amount)}」不是數字`);
      else if (amount !== null && subsidy > amount) errors.push('補助金額不可大於總金額');

      const taxId = trim(row.buyer_tax_id);
      if (taxId && !/^\d{8}$/.test(taxId)) warnings.push('買受人統一編號非 8 碼數字，仍會匯入，請自行確認');

      const receiptNo = trim(row.receipt_no);
      if (receiptNo && db.prepare('SELECT 1 FROM invoices WHERE receipt_no = ?').get(receiptNo)) {
        errors.push(`收據號碼「${receiptNo}」在系統中已存在`);
      }

      return {
        errors, warnings,
        data: {
          client_id: client ? client.id : null,
          client_label: client ? `${client.name}（${client.code}）` : (code || idNo),
          date: date || '', item, amount: amount || 0,
          payer: trim(row.payer) || getSetting('payer_type_default', '自費'),
          status, method: trim(row.method),
          paid_at: status === 'paid' ? (paidAt || date || '') : '',
          receipt_no: receiptNo,
          invoice_no: trim(row.invoice_no).toUpperCase(), buyer_tax_id: taxId,
          subsidy_program: trim(row.subsidy_program), subsidy_no: trim(row.subsidy_no),
          subsidy_amount: subsidy || 0, self_pay: (amount || 0) - (subsidy || 0),
          note: trim(row.note)
        }
      };
    },

    conflict(d, seen) {
      if (!d.receipt_no) return null;
      if (seen.has(d.receipt_no)) return `檔案中有其他列使用相同的收據號碼「${d.receipt_no}」`;
      seen.add(d.receipt_no);
      return null;
    },

    findExisting(d) {
      if (!d.receipt_no) return null;
      const i = db.prepare(`SELECT i.id, c.name, c.code FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE i.receipt_no = ?`).get(d.receipt_no);
      return i ? { ...i, matched_by: '收據號碼' } : null;
    },

    insert(d, ctx) {
      // 收據號碼留空且已收款者，沿用系統的年月流水規則編號
      let receiptNo = d.receipt_no;
      if (!receiptNo && d.status === 'paid') receiptNo = ctx.nextReceiptNo();
      const info = db.prepare(`INSERT INTO invoices
        (client_id, date, item, amount, payer, status, method, paid_at, receipt_no,
         invoice_no, buyer_tax_id, subsidy_program, subsidy_no, subsidy_amount, self_pay, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(d.client_id, d.date, d.item, d.amount, d.payer, d.status, d.method, d.paid_at, receiptNo,
          d.invoice_no, d.buyer_tax_id, d.subsidy_program, d.subsidy_no, d.subsidy_amount, d.self_pay, d.note);
      return info.lastInsertRowid;
    }
    // 不提供 update：財務憑證匯入後若要更正，應走收費頁的編輯或作廢，保留軌跡
  },

  {
    key: 'assessments',
    module: 'assessments',
    title: '心理量表結果',
    description: '匯入歷史量表施測的總分與日期。可只填總分，系統依切分點自動判讀；'
      + '填了逐題作答則重新計分，並比對總分是否相符。',
    columns: [
      { key: 'client_code', label: '個案編號', hint: '或改填身分證統一編號' },
      { key: 'client_id_no', label: '個案身分證統一編號' },
      { key: 'scale', label: '量表', required: true, hint: 'PHQ9／GAD7／BSRS5／WHO5／PSS10／ISI' },
      { key: 'date', label: '施測日期', required: true },
      { key: 'total', label: '總分', hint: '未填逐題作答時必填' },
      { key: 'answers', label: '逐題作答', hint: '各題分數以空格分隔（例 1 2 0 3 1 2 1 0 0）；填了會重新計分。'
        + 'CSV 檔請勿用逗號分隔，否則會被當成不同欄位' },
      { key: 'filled_by', label: '填寫者', hint: '所內登錄／個案自填（留空為所內登錄）' },
      { key: 'note', label: '備註' }
    ],
    sample: [
      { client_code: 'C2026001', scale: 'PHQ9', date: '2026/6/6', total: '12' },
      { client_code: 'C2026001', scale: 'GAD7', date: '2026/6/6', answers: '2 2 1 2 1 1 1' }
    ],

    parse(row, ctx) {
      const errors = [], warnings = [];

      const code = trim(row.client_code);
      const idNo = trim(row.client_id_no).toUpperCase();
      let client = null;
      if (code) client = ctx.clientsByCode.get(code) || null;
      if (!client && idNo) client = ctx.clientsByIdNo.get(idNo) || null;
      if (!client) errors.push(code || idNo ? `找不到個案「${code || idNo}」，請先匯入個案名冊` : '請填個案編號或身分證統一編號');

      const scaleKey = trim(row.scale).toUpperCase().replace(/[-\s]/g, '');
      const scale = SCALES[scaleKey];
      if (!scaleKey) errors.push('量表為必填');
      else if (!scale) errors.push(`不支援的量表「${trim(row.scale)}」，可用：${Object.keys(SCALES).join('、')}`);

      const date = toDate(row.date);
      if (date === null) errors.push(`施測日期「${trim(row.date)}」無法辨識`);
      else if (!date) errors.push('施測日期為必填');

      const answersRaw = trim(row.answers);
      let answers = null, total = toInt(row.total);
      if (total === null) errors.push(`總分「${trim(row.total)}」不是數字`);

      // 作答值為選項索引（0 起算），上限是選項數 - 1
      const maxOpt = scale ? scale.options.length - 1 : 0;
      if (answersRaw && scale) {
        answers = answersRaw.split(/[,，\s]+/).filter(x => x !== '').map(Number);
        if (answers.some(n => !Number.isFinite(n))) {
          errors.push('逐題作答含非數字');
          answers = null;
        } else if (answers.length !== scale.items.length) {
          errors.push(`${scaleKey} 應有 ${scale.items.length} 題，檔案填了 ${answers.length} 題`
            + (answers.length === 1 ? '（CSV 檔的逐題作答請改用空格分隔，逗號會被當成欄位分隔）' : ''));
          answers = null;
        } else if (answers.some(n => n < 0 || n > maxOpt)) {
          errors.push(`${scaleKey} 每題分數應介於 0–${maxOpt}`);
          answers = null;
        }
      }

      let scored = null;
      if (scale && answers) {
        scored = score(scaleKey, answers);
        if (trim(row.total) && scored.total !== total) {
          warnings.push(`檔案總分 ${total} 與逐題計分結果 ${scored.total} 不符，將採用計分結果`);
        }
      } else if (scale && !answersRaw) {
        if (!trim(row.total)) errors.push('未填逐題作答時，總分為必填');
        else {
          // 計分題數可能少於題目數（如 BSRS5 第 6 題為附加題不計入總分）
          const count = scale.scoreItems || scale.items.length;
          const maxTotal = count * maxOpt;
          if (total > maxTotal) errors.push(`${scaleKey} 總分上限為 ${maxTotal}，檔案填了 ${total}`);
          else {
            // 只有總分時依切分點判讀，但無法得知危險題是否命中
            const cut = scale.cuts.find(c => total >= c[0] && total <= c[1]);
            scored = { total, severity: cut ? cut[2] : '', alert: 0 };
            if (scale.alertIndex !== undefined) {
              warnings.push('只填總分無法判斷危險題是否命中，如需風險警示請改填逐題作答');
            }
          }
        }
      }

      const filledRaw = trim(row.filled_by);
      const filledBy = /個案|自填|client/i.test(filledRaw) ? 'client' : 'staff';

      return {
        errors, warnings,
        data: {
          client_id: client ? client.id : null,
          client_label: client ? `${client.name}（${client.code}）` : (code || idNo),
          scale: scaleKey, date: date || '',
          total: scored ? scored.total : (total || 0),
          severity: scored ? scored.severity : '',
          alert: scored ? (scored.alert ? 1 : 0) : 0,
          answers: JSON.stringify(answers || []),
          filled_by: filledBy, note: trim(row.note)
        }
      };
    },

    conflict(d, seen) {
      if (!d.client_id || !d.scale || !d.date) return null;
      const token = `${d.client_id}|${d.scale}|${d.date}`;
      if (seen.has(token)) return `檔案中有其他列的個案、量表與施測日期完全相同`;
      seen.add(token);
      return null;
    },

    findExisting(d) {
      if (!d.client_id || !d.scale || !d.date) return null;
      const a = db.prepare(`SELECT a.id, c.name, c.code FROM assessments a JOIN clients c ON c.id = a.client_id
        WHERE a.client_id = ? AND a.scale = ? AND a.date = ?`).get(d.client_id, d.scale, d.date);
      return a ? { ...a, matched_by: '個案＋量表＋日期' } : null;
    },

    insert(d) {
      const info = db.prepare(`INSERT INTO assessments
        (client_id, scale, date, answers, total, severity, alert, filled_by, note)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(d.client_id, d.scale, d.date, d.answers, d.total, d.severity, d.alert, d.filled_by, d.note);
      // 匯入的歷史量表若命中危險題，仍需拉高風險等級——舊資料也可能揭露尚未處理的風險
      if (d.alert) db.prepare("UPDATE clients SET risk_level = 'high' WHERE id = ?").run(d.client_id);
      return info.lastInsertRowid;
    },

    update(existing, d) {
      db.prepare(`UPDATE assessments SET answers = ?, total = ?, severity = ?, alert = ?, filled_by = ?, note = ?
        WHERE id = ?`).run(d.answers, d.total, d.severity, d.alert, d.filled_by, d.note, existing.id);
      if (d.alert) db.prepare("UPDATE clients SET risk_level = 'high' WHERE id = ?").run(d.client_id);
      return existing.id;
    }
  }
];

const BY_KEY = Object.fromEntries(IMPORTS.map(i => [i.key, i]));

function listImports() {
  return IMPORTS.map(i => ({
    key: i.key, module: i.module, title: i.title, description: i.description,
    columns: i.columns, updatable: !!i.update, update_only: !!i.updateOnly
  }));
}

function getImport(key) { return BY_KEY[key] || null; }

// 每次匯入前準備一次對照表，避免逐列查詢造成上千次 SQL
function buildContext() {
  const counselors = new Map();
  for (const u of db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin')").all()) {
    counselors.set(u.name, u);
  }
  const partners = new Map();
  for (const p of db.prepare('SELECT id, name FROM partners WHERE active = 1').all()) partners.set(p.name, p);
  const rooms = new Map();
  for (const r of db.prepare('SELECT id, name FROM rooms WHERE active = 1').all()) rooms.set(r.name, r);

  const clientsByCode = new Map(), clientsByIdNo = new Map();
  for (const c of db.prepare('SELECT id, code, name, id_no, phone FROM clients WHERE active = 1').all()) {
    clientsByCode.set(c.code, c);
    if (c.id_no) clientsByIdNo.set(c.id_no, c);
  }

  // 收據號碼在同一批匯入內要連號，故在記憶體中遞增，不每次查資料庫
  const prefix = getSetting('receipt_prefix', 'MC');
  const ym = today().slice(0, 7).replace('-', '');
  const last = db.prepare('SELECT receipt_no FROM invoices WHERE receipt_no LIKE ? ORDER BY receipt_no DESC LIMIT 1')
    .get(`${prefix}${ym}%`);
  let seq = last ? Number(last.receipt_no.slice(-4)) : 0;

  return {
    counselors, partners, rooms, clientsByCode, clientsByIdNo,
    nextReceiptNo: () => `${prefix}${ym}${String(++seq).padStart(4, '0')}`
  };
}

// 表頭比對：標籤與欄位鍵都接受，忽略空白與全半形括號。
// 範本的表頭會標「（必填）」，所方也常自行加「*」或「必填」註記，比對前一併去除。
function mapHeader(def, header) {
  const norm = s => String(s || '').trim()
    .replace(/[（(]\s*必填\s*[）)]/g, '')
    .replace(/[*＊]/g, '')
    .replace(/[\s（）()]/g, '')
    .toLowerCase();
  const byLabel = new Map();
  for (const c of def.columns) {
    byLabel.set(norm(c.label), c.key);
    byLabel.set(norm(c.key), c.key);
  }
  const mapping = header.map(h => byLabel.get(norm(h)) || null);
  const matched = def.columns.filter(c => mapping.includes(c.key)).map(c => c.key);
  const missingRequired = def.columns.filter(c => c.required && !matched.includes(c.key)).map(c => c.label);
  const unknown = header.filter((h, i) => trim(h) && !mapping[i]);
  return { mapping, matched, missingRequired, unknown };
}

// 逐列驗證：回傳可直接呈現於畫面的結果，commit 時會再跑一次（不信任前端送回的資料）
function validate(def, table, ctx) {
  const { mapping, missingRequired, unknown } = mapHeader(def, table.header);
  if (missingRequired.length) {
    return { fatal: `檔案缺少必要欄位：${missingRequired.join('、')}`, missingRequired, unknown };
  }
  const seen = new Set();
  const rows = table.rows.map(r => {
    const raw = {};
    mapping.forEach((key, i) => { if (key) raw[key] = r.cells[i] ?? ''; });
    const parsed = def.parse(raw, ctx);
    const errors = [...parsed.errors];
    if (!errors.length && def.conflict) {
      const c = def.conflict(parsed.data, seen);
      if (c) errors.push(c);
    }
    const existing = errors.length ? null : def.findExisting(parsed.data);
    return {
      row_no: r.row_no, data: parsed.data,
      errors, warnings: parsed.warnings,
      existing: existing ? { id: existing.id, name: existing.name || '', code: existing.code || '', matched_by: existing.matched_by } : null
    };
  });
  return {
    unknown,
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter(r => !r.errors.length && !r.existing).length,
      duplicate: rows.filter(r => !r.errors.length && r.existing).length,
      error: rows.filter(r => r.errors.length).length,
      warning: rows.filter(r => !r.errors.length && r.warnings.length).length
    }
  };
}

module.exports = { IMPORTS, listImports, getImport, buildContext, validate, mapHeader, toDate, toTime, toInt, toPhone };
