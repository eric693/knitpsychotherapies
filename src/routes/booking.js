// 線上預約表單（公開，免登入）與後台的申請處理。
//
// 設計重點：
//  1. 個案看不到諮商室配置——表單只讓人選方案、主題、心理師與時段，
//     空間由系統在成立預約時自動指派（只有 2-3 間，見 plans.pickRoom）。
//  2. 表單送出的是「預約申請」，不直接寫進排程；櫃檯確認後才成立預約，
//     避免有人在線上把補助方案的名額佔走。方案可個別設定免審（require_review=0）。
//  3. 補助方案的資格（年齡、每年次數）與心理師人次上限在表單端就先擋，
//     個案不會白填一輪才被退。

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit, today, addDays, getSetting, nowStamp, ageYears, nextClientCode } = require('../db');
const { requireStaff, rateLimit } = require('../auth');
const plans = require('../plans');
const line = require('../line');
const schedule = require('./schedule');

const router = express.Router();

// 公開端點的節流：同一 IP 每 10 分鐘最多 20 次查詢、5 次送單
const publicRead = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, prefix: 'bookread:' });
const publicWrite = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, prefix: 'bookwrite:' });

function planPublic(p) {
  const topics = db.prepare('SELECT id, name, fee, fee_options FROM plan_topics WHERE plan_id = ? AND active = 1 ORDER BY sort, id')
    .all(p.id);
  // 有設定專屬費率且開放預約的心理師優先；完全沒設定費率的方案則開放給所有在職心理師
  const rates = db.prepare(`SELECT pc.counselor_id, pc.bookable FROM plan_counselors pc
    WHERE pc.plan_id = ? AND pc.active = 1 AND (pc.topic_id IS NULL OR pc.topic_id = 0)`).all(p.id);
  const all = db.prepare(`SELECT id, name, title, license_type, specialty, online_only, intro FROM users
    WHERE active = 1 AND portal_bookable = 1 AND role IN ('counselor','supervisor','admin')
    ORDER BY id`).all();
  const counselors = rates.length
    ? all.filter(u => rates.some(r => r.counselor_id === u.id && r.bookable))
    : all;
  return {
    id: p.id, name: p.name, kind: p.kind, appt_type: p.appt_type,
    fee_mode: p.fee_mode, fee: p.fee, fee_options: plans.parseOptions(p.fee_options),
    session_minutes: plans.sessionMinutes(p),
    age_min: p.age_min, age_max: p.age_max, quota_per_year: p.quota_per_year,
    default_mode: p.default_mode || 'onsite',
    subsidy_amount: p.subsidy_amount,
    // client_pay 才是民眾要付的錢；補助方案就是那筆場地費
    client_pay: Math.max(0, p.fee - p.subsidy_amount),
    self_pay: Math.max(0, p.fee - p.subsidy_amount),
    venue_fee: p.venue_fee || 0,
    intro: p.intro, topics, counselors
  };
}

// ---- 公開：表單設定 ----
router.get('/public/booking-config', publicRead, (req, res) => {
  const enabled = getSetting('booking_form_enabled', '1') === '1';
  const rows = db.prepare('SELECT * FROM service_plans WHERE active = 1 AND portal_visible = 1 ORDER BY sort, id').all();
  res.json({
    enabled,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    notice: getSetting('booking_notice'),
    privacy: getSetting('booking_privacy'),
    crisis_note: getSetting('ui_crisis_note'),
    line_add_friend_url: getSetting('line_add_friend_url'),
    line_official_id: getSetting('line_official_id'),
    portal_url: require('../line').portalUrl(),
    lead_days: Number(getSetting('booking_lead_days', '1')),
    max_days: Number(getSetting('booking_max_days', '45')),
    require_birth: getSetting('booking_require_birth', '1') === '1',
    plans: rows.map(planPublic)
  });
});

// ---- 公開：可預約時段 ----
// 只回傳「時段」，不含諮商室；心理師該方案本週人次滿了就整週不出時段，
// 並回報下週的剩餘人次，讓個案自己改約下週。
router.get('/public/booking-slots', publicRead, (req, res) => {
  const counselorId = Number(req.query.counselor_id) || 0;
  const planId = Number(req.query.plan_id) || 0;
  if (!counselorId) return res.status(400).json({ error: '請選擇心理師' });
  const plan = planId ? plans.getPlan(planId) : null;
  const minutes = plans.sessionMinutes(plan);
  const max = Number(getSetting('booking_max_days', '45'));
  // 最早可約日已含「前一天幾點截止」的規則
  const minDate = plans.earliestBookableDate();
  const from = req.query.from && req.query.from > minDate ? req.query.from : minDate;
  const days = Math.min(Number(req.query.days) || 21, max);

  const out = [];
  const weekNotes = new Map();
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (date > addDays(today(), max)) break;
    let slots = schedule.freeSlots(counselorId, date, minutes)
      .filter(sl => !plans.bookingCutoffReason(date, sl.start_time));
    let full = null;
    if (plan && slots.length) {
      const load = plans.counselorLoad(counselorId, plan.id, date);
      if (load.week_full) {
        full = { reason: `本週此方案已排滿 ${load.week_used}/${load.week_limit} 人次`, next_week: plans.nextWeekHint(counselorId, plan.id, date) };
        weekNotes.set(load.week_start, full);
        slots = [];
      } else if (load.month_full) {
        full = { reason: `本月此方案已排滿 ${load.month_used}/${load.month_limit} 人次` };
        slots = [];
      }
    }
    out.push({ date, slots, full });
  }
  // 一併回報可預約區間，表單與測試都看得出「今天到底能不能約明天」
  res.json({ min_date: minDate, max_date: addDays(today(), max), days: out, notes: [...weekNotes.values()] });
});

// ---- 公開：送出預約申請 ----
router.post('/public/bookings', publicWrite, async (req, res) => {
  if (getSetting('booking_form_enabled', '1') !== '1') {
    return res.status(400).json({ error: '線上預約目前暫停開放，請直接來電預約' });
  }
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').replace(/\s|-/g, '');
  if (!name) return res.status(400).json({ error: '請填寫姓名' });
  if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: '請填寫正確的手機號碼（09 開頭共 10 碼）' });
  if (!b.consent) return res.status(400).json({ error: '請先閱讀並同意個人資料蒐集告知事項' });

  const plan = plans.getPlan(b.plan_id);
  if (!plan || !plan.active || !plan.portal_visible) return res.status(400).json({ error: '請選擇方案' });
  const topic = b.topic_id ? plans.getTopic(b.topic_id) : null;
  // 「由諮商所安排合適之心理師」＝不指定心理師，此時只收可配合時段，由櫃檯排
  const counselorId = Number(b.counselor_id) || 0;
  const counselor = counselorId
    ? db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(counselorId) : null;
  if (counselorId && !counselor) return res.status(400).json({ error: '請重新選擇心理師' });
  // 只接受線上通訊諮商的心理師，一律以視訊成立
  const mode = counselor && counselor.online_only ? 'online' : (b.mode === 'online' ? 'online' : (plan.default_mode || 'onsite'));
  const date = String(b.date || '').trim();
  const startTime = String(b.start_time || '').trim();

  const birth = String(b.birth_date || '').trim();
  if (getSetting('booking_require_birth', '1') === '1' && !birth) {
    return res.status(400).json({ error: '請填寫出生日期（方案資格核對用）' });
  }
  // 年齡資格在表單就先擋，免得個案白等一輪才被退件
  if (birth) {
    const age = ageYears(birth, date || today());
    if (plan.age_min && age < plan.age_min) return res.status(400).json({ error: `「${plan.name}」限 ${plan.age_min} 歲以上` });
    if (plan.age_max && age > plan.age_max) return res.status(400).json({ error: `「${plan.name}」限 ${plan.age_max} 歲以下` });
  }

  // 已建檔的舊個案（以手機比對）：一併檢查年度額度與心理師人次上限
  const client = db.prepare('SELECT * FROM clients WHERE phone = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(phone) || null;
  if (date) {
    const minDate = plans.earliestBookableDate();
    const max = Number(getSetting('booking_max_days', '45'));
    const cutoffReason = plans.bookingCutoffReason(date, startTime);
    if (cutoffReason) return res.status(400).json({ error: `${cutoffReason}，請改約其他時間或直接來電。` });
    if (date > addDays(today(), max)) return res.status(400).json({ error: `最遠只能預約 ${max} 天內的時段` });
    const check = plans.checkBooking({ plan_id: plan.id, client, counselor_id: counselorId, date, birth_date: birth });
    if (check.errors.length && getSetting('plan_quota_enforce', '1') === '1') {
      const hint = check.next_week
        ? `　可改約下週（${check.next_week.week_start} 起，尚餘 ${check.next_week.remaining ?? '不限'} 人次）`
        : '';
      return res.status(400).json({ error: check.errors[0] + hint });
    }
  }
  if (counselorId && date && startTime) {
    const minutes = plans.sessionMinutes(plan);
    const taken = !schedule.freeSlots(counselorId, date, minutes).some(s => s.start_time === startTime);
    if (taken) return res.status(400).json({ error: '此時段剛剛已被預約，請另選時段' });
  }

  const quote = plans.resolveFee({ plan_id: plan.id, topic_id: topic ? topic.id : null,
    counselor_id: counselorId, fee_choice: b.fee_choice });

  // 從 LINE 官方帳號的專屬連結進來的：以 token 換回 userId，不讓 userId 走網址列
  let lineUserId = String(b.line_user_id || '').trim();
  if (b.booking_token) {
    const link = db.prepare('SELECT * FROM booking_links WHERE token = ?').get(String(b.booking_token));
    if (link && (!link.expires_at || link.expires_at >= today())) {
      lineUserId = link.line_user_id;
      db.prepare('UPDATE booking_links SET used_at = ? WHERE id = ?').run(nowStamp(), link.id);
    }
  }

  const info = db.prepare(`INSERT INTO booking_requests
    (name, phone, email, gender, birth_date, is_new, client_id, plan_id, topic_id, counselor_id,
     date, start_time, alt_note, mode, fee_choice, partner_name, main_issue, expectation,
     source, line_user_id, consent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    name, phone, String(b.email || '').trim(), String(b.gender || ''), birth,
    client ? 0 : 1, client ? client.id : null, plan.id, topic ? topic.id : null, counselorId || null,
    date, startTime, String(b.alt_note || ''), mode,
    quote.fee, String(b.partner_name || ''), String(b.main_issue || ''), String(b.expectation || ''),
    lineUserId ? 'line' : 'web', lineUserId);
  // 地址、身分證字號與緊急聯絡人：比照原本的紙本／Google 表單，建檔時直接帶入個案資料
  db.prepare(`UPDATE booking_requests SET topic_other = ?, address = ?, id_no = ?,
      emergency_name = ?, emergency_phone = ?, emergency_relationship = ? WHERE id = ?`).run(
    String(b.topic_other || '').slice(0, 100), String(b.address || '').slice(0, 200),
    String(b.id_no || '').trim().toUpperCase().slice(0, 20),
    String(b.emergency_name || '').slice(0, 50), String(b.emergency_phone || '').slice(0, 30),
    String(b.emergency_relationship || '').slice(0, 30), info.lastInsertRowid);

  const id = info.lastInsertRowid;
  audit('client', client ? client.id : null, name, '線上預約申請', String(id), { plan: plan.name, date, startTime });

  const payload = {
    name, plan_name: plan.name, topic_name: topic ? topic.name : '',
    counselor_name: counselor ? counselor.name : '', date, start_time: startTime,
    alt_note: b.alt_note || '', fee: quote.fee, main_issue: b.main_issue || ''
  };
  // 個案若從 LINE 進來就回推一張「已收到申請」卡片
  if (lineUserId) {
    await line.pushFlex({ to: lineUserId, flex: line.bookingReceivedFlex(payload),
      kind: 'booking', client_id: client ? client.id : null });
  }
  // 心理師端提醒：有人指名預約你
  if (counselor && counselor.line_user_id) {
    await line.pushFlex({
      to: counselor.line_user_id,
      flex: line.counselorBookingFlex({ counselor_name: counselor.name, b: payload }),
      kind: 'booking_staff'
    });
  }

  res.json({
    ok: true, id,
    require_review: !!plan.require_review,
    message: plan.require_review
      ? '已收到您的預約申請，我們確認後會盡快與您聯繫。'
      : '已收到您的預約申請。',
    fee: quote.fee, self_pay: quote.self_pay,
    line_add_friend_url: getSetting('line_add_friend_url'),
    portal_url: require('../line').portalUrl(),
    center_phone: getSetting('center_phone')
  });
});

// ---- 後台：處理申請 ----

const BOOKING_SQL = `SELECT b.*, p.name AS plan_name, p.quota_per_year, t.name AS topic_name,
    u.name AS counselor_name, c.code AS client_code, c.name AS client_db_name
  FROM booking_requests b
  LEFT JOIN service_plans p ON p.id = b.plan_id
  LEFT JOIN plan_topics t ON t.id = b.topic_id
  LEFT JOIN users u ON u.id = b.counselor_id
  LEFT JOIN clients c ON c.id = b.client_id`;

// 申請可能累積上千筆（舊表單一次匯入），因此支援關鍵字、方案、心理師、
// 狀態與送出日期區間的篩選，全部在資料庫端過濾，不把整批資料丟給前端。
router.get('/bookings', requireStaff('bookings'), (req, res) => {
  const { status = '', q = '', plan_id = '', counselor_id = '', from = '', to = '', limit = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('b.status = ?'); args.push(status); }
  if (q) {
    where.push('(b.name LIKE ? OR b.phone LIKE ? OR b.email LIKE ? OR b.main_issue LIKE ? OR b.alt_note LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  if (plan_id === 'none') where.push('b.plan_id IS NULL');
  else if (plan_id) { where.push('b.plan_id = ?'); args.push(Number(plan_id)); }
  if (counselor_id === 'none') where.push('b.counselor_id IS NULL');
  else if (counselor_id) { where.push('b.counselor_id = ?'); args.push(Number(counselor_id)); }
  if (from) { where.push('date(b.created_at) >= ?'); args.push(from); }
  if (to) { where.push('date(b.created_at) <= ?'); args.push(to); }
  const cap = Math.min(2000, Math.max(50, Number(limit) || 300));
  const rows = db.prepare(`${BOOKING_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.status = 'new' DESC, b.created_at DESC LIMIT ${cap}`).all(...args);
  const total = db.prepare(`SELECT COUNT(*) n FROM booking_requests b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n;
  res.set('X-Total-Count', String(total));
  res.json(rows.map(r => ({
    ...r,
    age: ageYears(r.birth_date, r.date || today()),
    // 舊個案：直接把該方案今年用了幾次一起帶出來，櫃檯不必再點進個案頁查
    usage: r.client_id && r.plan_id && r.quota_per_year
      ? plans.clientUsage(r.client_id, r.plan_id, (r.date || today()).slice(0, 4)) : null
  })));
});

router.get('/bookings/:id', requireStaff('bookings'), (req, res) => {
  const b = db.prepare(`${BOOKING_SQL} WHERE b.id = ?`).get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  const check = b.plan_id
    ? plans.checkBooking({
      plan_id: b.plan_id,
      client: b.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(b.client_id) : null,
      counselor_id: b.counselor_id, date: b.date || today(), birth_date: b.birth_date
    })
    : { errors: [], warnings: [] };
  const slots = b.counselor_id && b.date ? schedule.freeSlots(b.counselor_id, b.date) : [];
  res.json({ ...b, check, slots, age: ageYears(b.birth_date, b.date || today()),
    topic_display: b.topic_name || b.topic_other || '' });
});

// 修正申請內容：電話打錯、方案選錯、主訴要補，成立預約前先改好再確認。
// 已成立的申請不再開放修改，該改的是排程上的那筆晤談。
const BOOKING_EDIT_FIELDS = ['name', 'phone', 'email', 'gender', 'birth_date', 'plan_id', 'topic_id',
  'counselor_id', 'date', 'start_time', 'alt_note', 'mode', 'fee_choice', 'partner_name',
  'main_issue', 'expectation', 'reply_note', 'education', 'guardian_name', 'guardian_phone'];
router.put('/bookings/:id', requireStaff('bookings'), (req, res) => {
  const b = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  if (b.status === 'confirmed') {
    return res.status(400).json({ error: '已成立的申請請直接修改排程上的晤談' });
  }
  const body = req.body || {};
  const data = {};
  for (const f of BOOKING_EDIT_FIELDS) {
    if (body[f] === undefined) continue;
    data[f] = ['plan_id', 'topic_id', 'counselor_id'].includes(f)
      ? (Number(body[f]) || null)
      : (f === 'fee_choice' ? Math.max(0, Number(body[f]) || 0) : String(body[f]));
  }
  if (data.name !== undefined && !String(data.name).trim()) {
    return res.status(400).json({ error: '姓名不可空白' });
  }
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE booking_requests SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), b.id);
  audit('staff', req.user.id, req.user.name, '修改預約申請', b.name, { id: b.id });
  res.json({ ok: true });
});

// 刪除申請：測試資料、重複送出或明顯亂填的可以直接移除。
// 已成立的申請保留，才能追溯這筆晤談是怎麼來的。
router.delete('/bookings/:id', requireStaff('bookings'), (req, res) => {
  const b = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  if (b.status === 'confirmed') {
    return res.status(400).json({ error: '已成立的申請不可刪除，請改為取消該筆晤談' });
  }
  db.prepare('DELETE FROM booking_requests WHERE id = ?').run(b.id);
  audit('staff', req.user.id, req.user.name, '刪除預約申請', b.name, { id: b.id, status: b.status });
  res.json({ ok: true });
});

// 未建檔者一鍵建檔：把表單資料帶進個案基本資料，省去重打一次
router.post('/bookings/:id/create-client', requireStaff('clients'), (req, res) => {
  const b = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  if (b.client_id) return res.status(400).json({ error: '此申請已對應個案' });
  const exist = db.prepare('SELECT * FROM clients WHERE phone = ? AND active = 1').get(b.phone);
  if (exist) {
    db.prepare('UPDATE booking_requests SET client_id = ? WHERE id = ?').run(exist.id, b.id);
    return res.json({ client_id: exist.id, matched: true });
  }
  const code = nextClientCode();
  const adultAge = Number(getSetting('adult_age', '18'));
  const age = ageYears(b.birth_date, today());
  // 個案端預設密碼為手機末 6 碼、首次登入強制更換（與手動建檔、匯入一致）；
  // 少了這段，從預約申請建檔的個案會沒有密碼，個案專區怎麼按都登不進去。
  const digits = String(b.phone || '').replace(/\D/g, '');
  const pwHash = digits.length >= 6 ? bcrypt.hashSync(digits.slice(-6), 10) : '';
  const info = db.prepare(`INSERT INTO clients
    (code, name, gender, birth_date, phone, email, address, id_no, education,
     emergency_name, emergency_phone, emergency_relationship,
     guardian_name, guardian_phone,
     counselor_id, status, main_issue, note, source, is_minor, intake_date,
     password_hash, must_change_password, assign_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'intake',?,?,?,?,?,?,?,?)`).run(
    code, b.name, b.gender || '', b.birth_date || '', b.phone, b.email || '',
    b.address || '', b.id_no || '', b.education || '',
    b.emergency_name || '', b.emergency_phone || '', b.emergency_relationship || '',
    b.guardian_name || '', b.guardian_phone || '',
    b.counselor_id || null, b.main_issue || '',
    // 表單問的「期待得到的幫忙」沒有對應的個案欄位，接進備註才不會在建檔時掉掉
    b.expectation ? `個案於預約表單填寫的期待：${b.expectation}` : '',
    b.source === 'google_form' ? 'Google 預約表單' : '線上預約表單',
    age !== null && age < adultAge ? 1 : 0, today(), pwHash, pwHash ? 1 : 0,
    // 個案在預約表單自己點名心理師的算「指定案」，其餘由所方派案（年報表類別代碼要分）
    b.counselor_id ? 'designated' : 'assigned');
  db.prepare('UPDATE booking_requests SET client_id = ? WHERE id = ?').run(info.lastInsertRowid, b.id);
  audit('staff', req.user.id, req.user.name, '由預約申請建檔', code);
  res.json({ client_id: info.lastInsertRowid, code });
});

// 成立預約：寫進排程、指派諮商室、鎖定方案金額與心理師報酬，並以 LINE 通知雙方
router.post('/bookings/:id/confirm', requireStaff('bookings'), async (req, res) => {
  const b = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  if (b.status === 'confirmed') return res.status(400).json({ error: '此申請已成立預約' });
  const body = req.body || {};
  const clientId = Number(body.client_id) || b.client_id;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId || 0);
  if (!client) return res.status(400).json({ error: '請先建立或指定個案' });
  const counselorId = Number(body.counselor_id) || b.counselor_id;
  if (!counselorId) return res.status(400).json({ error: '請指定心理師' });
  const date = String(body.date || b.date || '');
  const startTime = String(body.start_time || b.start_time || '');
  if (!date || !startTime) return res.status(400).json({ error: '請指定日期與時間' });

  const quote = plans.resolveFee({
    plan_id: b.plan_id, topic_id: b.topic_id, counselor_id: counselorId,
    fee_choice: b.fee_choice, fee_override: body.fee
  });
  const endT = schedule.endTime(startTime, quote.session_minutes);

  const check = plans.checkBooking({ plan_id: b.plan_id, client, counselor_id: counselorId, date });
  if (check.errors.length && !body.override) {
    return res.status(400).json({ error: check.errors.join('；'), errors: check.errors,
      next_week: check.next_week, can_override: true });
  }

  const hit = schedule.conflictOf({ date, start_time: startTime, end_time: endT, counselor_id: counselorId });
  if (hit) return res.status(400).json({ error: `${hit.kind}時段衝突：${hit.row.start_time}-${hit.row.end_time} 已有預約` });

  // 諮商室由系統指派；個案端與表單自始至終都看不到空間配置。
  // 視訊晤談不佔空間（通訊諮商在線上進行），諮商室使用表才不會被灌爆。
  const mode = b.mode || (quote.plan && quote.plan.default_mode) || 'onsite';
  const roomId = mode === 'online'
    ? null
    : (Number(body.room_id) || plans.pickRoom({ date, start_time: startTime, end_time: endT }));

  const info = db.prepare(`INSERT INTO appointments
    (client_id, counselor_id, room_id, date, start_time, end_time, type, mode, status, fee, subsidy_amount,
     plan_id, topic_id, counselor_share, source, note, booking_request_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,'booked',?,?,?,?,?,'portal',?,?,?)`).run(
    client.id, counselorId, roomId, date, startTime, endT,
    (quote.plan && quote.plan.appt_type) || 'individual',
    mode, quote.fee, quote.subsidy_amount,
    b.plan_id || null, b.topic_id || null, quote.counselor_share,
    b.main_issue ? `線上預約：${b.main_issue}`.slice(0, 300) : '線上預約', b.id, req.user.id);

  db.prepare(`UPDATE booking_requests SET status = 'confirmed', appointment_id = ?, client_id = ?,
      counselor_id = ?, date = ?, start_time = ?, handled_by = ?, handled_at = ?, reply_note = ? WHERE id = ?`)
    .run(info.lastInsertRowid, client.id, counselorId, date, startTime, req.user.id, nowStamp(),
      String(body.reply_note || ''), b.id);

  audit('staff', req.user.id, req.user.name, '線上預約成立', client.code, { date, startTime, override: !!body.override });

  const counselor = db.prepare('SELECT name, line_user_id, meeting_room_url FROM users WHERE id = ?').get(counselorId);
  const payload = {
    date, start_time: startTime, end_time: endT, counselor_name: counselor ? counselor.name : '',
    plan_name: quote.plan ? quote.plan.name : '', topic_name: quote.topic ? quote.topic.name : '',
    mode: b.mode, fee: quote.fee, self_pay: quote.self_pay, subsidy_amount: quote.subsidy_amount,
    meeting_url: b.mode === 'online' && counselor ? counselor.meeting_room_url : ''
  };
  const notify = await line.pushFlex({
    to: client.line_user_id || b.line_user_id, flex: line.bookingConfirmedFlex(payload),
    kind: 'booking_confirm', client_id: client.id, appointment_id: info.lastInsertRowid, user: req.user
  });
  if (counselor && counselor.line_user_id) {
    await line.pushFlex({
      to: counselor.line_user_id, kind: 'booking_staff',
      flex: line.counselorBookingFlex({
        counselor_name: counselor.name, kind: '新排入的晤談',
        b: { name: `${client.name}（${client.code}）`, plan_name: payload.plan_name, topic_name: payload.topic_name,
          date, start_time: startTime, main_issue: b.main_issue }
      })
    });
  }
  res.json({ ok: true, appointment_id: info.lastInsertRowid, room_id: roomId,
    warnings: check.warnings, notify });
});

router.post('/bookings/:id/reject', requireStaff('bookings'), async (req, res) => {
  const b = db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  const reason = String((req.body || {}).reply_note || '').trim();
  db.prepare(`UPDATE booking_requests SET status = 'rejected', reply_note = ?, handled_by = ?, handled_at = ?
    WHERE id = ?`).run(reason, req.user.id, nowStamp(), b.id);
  audit('staff', req.user.id, req.user.name, '線上預約未成立', String(b.id), { reason });
  let notify = null;
  if (b.line_user_id || b.client_id) {
    const c = b.client_id ? db.prepare('SELECT line_user_id FROM clients WHERE id = ?').get(b.client_id) : null;
    const to = (c && c.line_user_id) || b.line_user_id;
    if (to) {
      notify = await line.pushFlex({
        to, kind: 'booking_reject', client_id: b.client_id,
        flex: line.card({
          title: '預約申請未能成立',
          subtitle: getSetting('center_name'),
          altText: '預約申請未能成立',
          body: [
            { type: 'text', size: 'sm', wrap: true, color: '#3b4a55',
              text: reason || '您申請的時段目前無法安排，請來電與我們討論其他時段，謝謝。' },
            line.noteBox(`聯絡電話：${getSetting('center_phone')}`)
          ]
        })
      });
    }
  }
  res.json({ ok: true, notify });
});

module.exports = router;
