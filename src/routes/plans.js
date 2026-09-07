// 方案別設定（方案 × 主題 × 心理師）、額度管理，以及每位心理師每月的收支結算。

const express = require('express');
const { db, audit, today, getSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const {
  resolveFee, clientUsage, clientUsageAll, counselorLoad, nextWeekHint, checkBooking, parseOptions, noShowCharge
} = require('../plans');

const router = express.Router();

const PLAN_FIELDS = ['name', 'kind', 'appt_type', 'fee_mode', 'fee', 'fee_options', 'subsidy_amount',
  'subsidy_program', 'session_minutes', 'age_min', 'age_max', 'quota_per_year',
  'counselor_week_limit', 'counselor_month_limit', 'share_mode', 'share_percent', 'share_fixed',
  // 所內派案的另一組抽成（留空＝派案沿用指定案的數字）
  'share_mode_assigned', 'share_percent_assigned', 'share_fixed_assigned',
  'portal_visible', 'require_review', 'note', 'intro', 'sort', 'active', 'default_mode', 'venue_fee',
  // 年報表用：類別代碼（如 0 指定／1 派案／3 機構／30 機構指定／31 機構派案）與個案編碼標記（如「青壯」「國軍」）
  'report_code', 'code_prefix',
  // 方案的外部作業網址（如國軍方案的個案註冊與晤談簽到）
  'register_url', 'signin_url'];

function normalizePlan(b, base = {}) {
  const d = { ...base };
  for (const f of PLAN_FIELDS) if (b[f] !== undefined) d[f] = b[f];
  d.name = String(d.name || '').trim();
  d.kind = ['self', 'subsidy', 'partner'].includes(d.kind) ? d.kind : 'self';
  d.fee_mode = d.fee_mode === 'choice' ? 'choice' : 'fixed';
  d.share_mode = d.share_mode === 'fixed' ? 'fixed' : 'percent';
  // 抽成比例允許填 60 或 0.6 兩種寫法，一律收斂成 0~1
  let pct = Number(d.share_percent) || 0;
  if (pct > 1) pct = pct / 100;
  d.share_percent = Math.min(Math.max(pct, 0), 1);
  // 派案那組同樣接受 55 或 0.55；留空或 0 代表沿用指定案的比例
  d.share_mode_assigned = ['percent', 'fixed'].includes(d.share_mode_assigned) ? d.share_mode_assigned : '';
  let apct = Number(d.share_percent_assigned) || 0;
  if (apct > 1) apct = apct / 100;
  d.share_percent_assigned = Math.min(Math.max(apct, 0), 1);
  d.share_fixed_assigned = Math.max(0, Math.round(Number(d.share_fixed_assigned) || 0));
  d.fee_options = parseOptions(d.fee_options).join(',');
  for (const n of ['fee', 'subsidy_amount', 'venue_fee', 'session_minutes', 'age_min', 'age_max', 'quota_per_year',
    'counselor_week_limit', 'counselor_month_limit', 'share_fixed', 'sort']) {
    d[n] = Math.max(0, Math.round(Number(d[n]) || 0));
  }
  for (const n of ['portal_visible', 'require_review', 'active']) d[n] = d[n] ? 1 : 0;
  for (const s of ['subsidy_program', 'note', 'intro', 'report_code', 'code_prefix',
    'register_url', 'signin_url']) d[s] = String(d[s] || '').trim();
  d.appt_type = String(d.appt_type || 'individual');
  d.default_mode = d.default_mode === 'online' ? 'online' : 'onsite';
  return d;
}

// ---- 方案 ----

router.get('/service-plans', requireStaff(), (req, res) => {
  const plans = db.prepare('SELECT * FROM service_plans ORDER BY active DESC, sort, id').all();
  const topics = db.prepare('SELECT * FROM plan_topics ORDER BY sort, id').all();
  const rates = db.prepare(`SELECT pc.*, u.name AS counselor_name FROM plan_counselors pc
    JOIN users u ON u.id = pc.counselor_id ORDER BY pc.plan_id, u.name`).all();
  const ym = today().slice(0, 7);
  const used = db.prepare(`SELECT plan_id, COUNT(*) n FROM appointments
    WHERE substr(date,1,7) = ? AND status IN ('booked','arrived','done','no_show') GROUP BY plan_id`).all(ym);
  const usedMap = Object.fromEntries(used.map(r => [r.plan_id, r.n]));
  res.json(plans.map(p => ({
    ...p,
    fee_option_list: parseOptions(p.fee_options),
    topics: topics.filter(t => t.plan_id === p.id),
    rates: rates.filter(r => r.plan_id === p.id),
    month_sessions: usedMap[p.id] || 0
  })));
});

router.post('/service-plans', requireStaff('settings'), (req, res) => {
  const d = normalizePlan(req.body || {}, { active: 1, portal_visible: 1, require_review: 1, share_percent: 0.6 });
  if (!d.name) return res.status(400).json({ error: '請填寫方案名稱' });
  const cols = PLAN_FIELDS.join(', ');
  const info = db.prepare(`INSERT INTO service_plans (${cols}) VALUES (${PLAN_FIELDS.map(() => '?').join(',')})`)
    .run(...PLAN_FIELDS.map(f => d[f]));
  audit('staff', req.user.id, req.user.name, '新增方案', d.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/service-plans/:id', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const d = normalizePlan(req.body || {}, p);
  if (!d.name) return res.status(400).json({ error: '請填寫方案名稱' });
  db.prepare(`UPDATE service_plans SET ${PLAN_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...PLAN_FIELDS.map(f => d[f]), p.id);
  audit('staff', req.user.id, req.user.name, '修改方案', d.name);
  res.json({ ok: true });
});

// 已被預約引用過的方案不刪除只停用，否則歷史帳目會失去方案別
router.delete('/service-plans/:id', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE plan_id = ?').get(p.id).n;
  if (used) {
    db.prepare('UPDATE service_plans SET active = 0 WHERE id = ?').run(p.id);
    audit('staff', req.user.id, req.user.name, '停用方案', p.name, { used });
    return res.json({ ok: true, disabled: true, message: `此方案已有 ${used} 筆預約使用，已改為停用（保留歷史紀錄）` });
  }
  db.prepare('DELETE FROM service_plans WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除方案', p.name);
  res.json({ ok: true });
});

// ---- 主題 ----

router.post('/service-plans/:id/topics', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '請填寫主題名稱' });
  const info = db.prepare(`INSERT INTO plan_topics
    (plan_id, name, fee, fee_options, note, sort, active, report_code, code_prefix)
    VALUES (?,?,?,?,?,?,1,?,?)`).run(p.id, name, Math.max(0, Number(b.fee) || 0),
    parseOptions(b.fee_options).join(','), String(b.note || ''), Number(b.sort) || 0,
    String(b.report_code || '').trim(), String(b.code_prefix || '').trim());
  audit('staff', req.user.id, req.user.name, '新增方案主題', `${p.name}／${name}`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/topics/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM plan_topics WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此主題' });
  const b = { ...t, ...req.body };
  db.prepare(`UPDATE plan_topics SET name = ?, fee = ?, fee_options = ?, note = ?, sort = ?, active = ?,
      report_code = ?, code_prefix = ? WHERE id = ?`)
    .run(String(b.name || t.name).trim(), Math.max(0, Number(b.fee) || 0),
      parseOptions(b.fee_options).join(','), String(b.note || ''), Number(b.sort) || 0, b.active ? 1 : 0,
      String(b.report_code || '').trim(), String(b.code_prefix || '').trim(), t.id);
  audit('staff', req.user.id, req.user.name, '修改方案主題', String(b.name || t.name));
  res.json({ ok: true });
});

router.delete('/topics/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM plan_topics WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此主題' });
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE topic_id = ?').get(t.id).n;
  if (used) {
    db.prepare('UPDATE plan_topics SET active = 0 WHERE id = ?').run(t.id);
    return res.json({ ok: true, disabled: true, message: `此主題已有 ${used} 筆預約使用，已改為停用` });
  }
  db.prepare('DELETE FROM plan_topics WHERE id = ?').run(t.id);
  audit('staff', req.user.id, req.user.name, '刪除方案主題', t.name);
  res.json({ ok: true });
});

// ---- 心理師費率（方案 × 心理師 [× 主題]）----

router.post('/service-plans/:id/rates', requireStaff('settings'), (req, res) => {
  const p = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const b = req.body || {};
  const counselorId = Number(b.counselor_id) || 0;
  if (!counselorId) return res.status(400).json({ error: '請選擇心理師' });
  const topicId = Number(b.topic_id) || null;
  const exists = db.prepare(`SELECT id FROM plan_counselors WHERE plan_id = ? AND counselor_id = ?
    AND ((topic_id IS NULL AND ? IS NULL) OR topic_id = ?)`).get(p.id, counselorId, topicId, topicId);
  if (exists) return res.status(400).json({ error: '此心理師在該方案（主題）已設定費率，請直接編輯' });
  let pct = Number(b.share_percent) || 0;
  if (pct > 1) pct = pct / 100;
  let apct = Number(b.share_percent_assigned) || 0;
  if (apct > 1) apct = apct / 100;
  const info = db.prepare(`INSERT INTO plan_counselors
    (plan_id, counselor_id, topic_id, fee, share_mode, share_percent, share_fixed,
     share_mode_assigned, share_percent_assigned, share_fixed_assigned,
     week_limit, month_limit, bookable, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(p.id, counselorId, topicId,
    Math.max(0, Number(b.fee) || 0), b.share_mode === 'fixed' || b.share_mode === 'percent' ? b.share_mode : '',
    Math.min(Math.max(pct, 0), 1), Math.max(0, Number(b.share_fixed) || 0),
    ['percent', 'fixed'].includes(b.share_mode_assigned) ? b.share_mode_assigned : '',
    Math.min(Math.max(apct, 0), 1), Math.max(0, Number(b.share_fixed_assigned) || 0),
    b.week_limit === '' || b.week_limit === undefined ? -1 : Number(b.week_limit),
    b.month_limit === '' || b.month_limit === undefined ? -1 : Number(b.month_limit),
    b.bookable === false ? 0 : 1);
  audit('staff', req.user.id, req.user.name, '設定心理師方案費率', p.name, { counselorId });
  res.json({ id: info.lastInsertRowid });
});

router.put('/rates/:id', requireStaff('settings'), (req, res) => {
  const r = db.prepare('SELECT * FROM plan_counselors WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此費率設定' });
  const b = { ...r, ...req.body };
  let pct = Number(b.share_percent) || 0;
  if (pct > 1) pct = pct / 100;
  let apct = Number(b.share_percent_assigned) || 0;
  if (apct > 1) apct = apct / 100;
  db.prepare(`UPDATE plan_counselors SET fee = ?, share_mode = ?, share_percent = ?, share_fixed = ?,
      share_mode_assigned = ?, share_percent_assigned = ?, share_fixed_assigned = ?,
      week_limit = ?, month_limit = ?, bookable = ?, active = ? WHERE id = ?`).run(
    Math.max(0, Number(b.fee) || 0),
    b.share_mode === 'fixed' || b.share_mode === 'percent' ? b.share_mode : '',
    Math.min(Math.max(pct, 0), 1), Math.max(0, Number(b.share_fixed) || 0),
    ['percent', 'fixed'].includes(b.share_mode_assigned) ? b.share_mode_assigned : '',
    Math.min(Math.max(apct, 0), 1), Math.max(0, Number(b.share_fixed_assigned) || 0),
    b.week_limit === '' ? -1 : Number(b.week_limit), b.month_limit === '' ? -1 : Number(b.month_limit),
    b.bookable ? 1 : 0, b.active ? 1 : 0, r.id);
  audit('staff', req.user.id, req.user.name, '修改心理師方案費率', String(r.id));
  res.json({ ok: true });
});

router.delete('/rates/:id', requireStaff('settings'), (req, res) => {
  db.prepare('DELETE FROM plan_counselors WHERE id = ?').run(req.params.id);
  audit('staff', req.user.id, req.user.name, '刪除心理師方案費率', String(req.params.id));
  res.json({ ok: true });
});

// ---- 取價試算與額度查詢（預約表單即時顯示）----

router.get('/plan-quote', requireStaff(), (req, res) => {
  const q = req.query;
  const quote = resolveFee({
    plan_id: q.plan_id, topic_id: q.topic_id, counselor_id: q.counselor_id,
    fee_choice: q.fee_choice, fee_override: q.fee_override,
    // 指定／派案會影響抽成，估價時就要按這位個案的註記算，不然預約單上的報酬是錯的
    client_id: q.client_id, assign_type: q.assign_type
  });
  const client = q.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(q.client_id)) : null;
  const check = q.plan_id
    ? checkBooking({ plan_id: q.plan_id, client, counselor_id: q.counselor_id,
      date: q.date || today(), appointment_id: q.appointment_id })
    : { errors: [], warnings: [] };
  res.json({
    fee: quote.fee,                       // 個案要付的錢（畫面上的「費用」欄位）
    total: quote.total,                   // 方案總額
    client_pay: quote.client_pay,
    venue_fee: quote.venue_fee,           // 場地費（所方收入，不列入抽成）
    share_base: quote.share_base,
    fee_options: quote.fee_options, subsidy_amount: quote.subsidy_amount,
    self_pay: quote.self_pay, counselor_share: quote.counselor_share,
    // 讓預約單說得出「這筆為什麼抽這個數」：是指定案還是派案、用的是哪一層的設定
    assign_type: quote.assign_type,
    share_mode: quote.share_mode, share_percent: quote.share_percent,
    share_from_assigned: quote.share_from_assigned, share_source: quote.share_source,
    session_minutes: quote.session_minutes, subsidy_program: quote.subsidy_program,
    plan_name: quote.plan ? quote.plan.name : '', topic_name: quote.topic ? quote.topic.name : '',
    ...check
  });
});

// 某位心理師某方案的人次負載（本週／本月／下週）
router.get('/plan-load', requireStaff(), (req, res) => {
  const { counselor_id, plan_id, date = today() } = req.query;
  if (!counselor_id || !plan_id) return res.status(400).json({ error: '請指定心理師與方案' });
  res.json({
    ...counselorLoad(Number(counselor_id), Number(plan_id), date),
    next_week: nextWeekHint(Number(counselor_id), Number(plan_id), date)
  });
});

// 方案人次看板：每位心理師在各限量方案的本週／本月用量，一眼看出誰還能排
router.get('/plan-board', requireStaff('schedule'), (req, res) => {
  const date = req.query.date || today();
  const plans = db.prepare(`SELECT * FROM service_plans WHERE active = 1
    AND (counselor_week_limit > 0 OR counselor_month_limit > 0 OR quota_per_year > 0) ORDER BY sort, id`).all();
  const counselors = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY name").all();
  const rows = [];
  for (const p of plans) {
    for (const c of counselors) {
      const load = counselorLoad(c.id, p.id, date);
      if (!load.week_limit && !load.month_limit && !load.week_used && !load.month_used) continue;
      // 帶出這位心理師是否另有個別上限，看板上才分得出「沿用方案」與「個別調整」
      const ov = db.prepare(`SELECT week_limit, month_limit FROM plan_counselors
        WHERE plan_id = ? AND counselor_id = ? AND topic_id IS NULL`).get(p.id, c.id) || {};
      rows.push({
        plan_id: p.id, plan_name: p.name, counselor_id: c.id, counselor_name: c.name,
        plan_week_limit: p.counselor_week_limit, plan_month_limit: p.counselor_month_limit,
        override_week: ov.week_limit === undefined ? -1 : ov.week_limit,
        override_month: ov.month_limit === undefined ? -1 : ov.month_limit,
        ...load, next_week: load.week_full ? nextWeekHint(c.id, p.id, date) : null
      });
    }
  }
  res.json({ date, rows });
});

// 已用人次可以人工填成實際數字（他所已接的案、系統外排的場次）。
// 存的是差額，之後系統內新增預約仍會照常累加。
router.put('/plan-board/usage', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const planId = Number(b.plan_id) || 0;
  const counselorId = Number(b.counselor_id) || 0;
  const date = b.date || today();
  if (!planId || !counselorId) return res.status(400).json({ error: '請指定方案與心理師' });
  const canEditOthers = req.user.role === 'admin' || req.userModules.includes('settings');
  if (!canEditOthers && counselorId !== req.user.id) {
    return res.status(403).json({ error: '只能調整自己的已用人次' });
  }
  const load = counselorLoad(counselorId, planId, date);
  const save = (type, key, systemUsed, wanted) => {
    if (wanted === undefined || wanted === null || wanted === '') return;
    const offset = Math.max(0, Math.floor(Number(wanted) || 0)) - systemUsed;
    db.prepare(`INSERT INTO plan_counselor_usage_adj (plan_id, counselor_id, period_type, period_key, used_offset, note, updated_at)
      VALUES (?,?,?,?,?,?,datetime('now','localtime'))
      ON CONFLICT (plan_id, counselor_id, period_type, period_key)
      DO UPDATE SET used_offset = excluded.used_offset, note = excluded.note, updated_at = excluded.updated_at`)
      .run(planId, counselorId, type, key, offset, String(b.note || ''));
  };
  save('week', load.week_start, load.week_system_used, b.week_used);
  save('month', load.month, load.month_system_used, b.month_used);
  audit('staff', req.user.id, req.user.name, '調整方案已用人次', String(planId),
    { counselorId, week_used: b.week_used, month_used: b.month_used });
  res.json({ ok: true, ...counselorLoad(counselorId, planId, date) });
});

// 直接在人次看板調整某位心理師在某方案的上限，不必繞到方案設定頁改費率。
// -1 沿用方案設定、0 不限、>0 個別上限。
// 心理師可以調整「自己」的上限（自己接多少自己最清楚）；要改別人的則需 settings 權限。
router.put('/plan-board/limit', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const planId = Number(b.plan_id) || 0;
  const counselorId = Number(b.counselor_id) || 0;
  if (!planId || !counselorId) return res.status(400).json({ error: '請指定方案與心理師' });
  const canEditOthers = req.user.role === 'admin' || req.userModules.includes('settings');
  if (!canEditOthers && counselorId !== req.user.id) {
    return res.status(403).json({ error: '只能調整自己的人次上限' });
  }
  const plan = db.prepare('SELECT name FROM service_plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: '找不到此方案' });
  const norm = v => {
    if (v === '' || v === null || v === undefined) return -1;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
  };
  const week = norm(b.week_limit);
  const month = norm(b.month_limit);
  const row = db.prepare(`SELECT id FROM plan_counselors
    WHERE plan_id = ? AND counselor_id = ? AND topic_id IS NULL`).get(planId, counselorId);
  if (row) {
    db.prepare('UPDATE plan_counselors SET week_limit = ?, month_limit = ?, active = 1 WHERE id = ?')
      .run(week, month, row.id);
  } else {
    db.prepare(`INSERT INTO plan_counselors (plan_id, counselor_id, topic_id, week_limit, month_limit)
      VALUES (?,?,NULL,?,?)`).run(planId, counselorId, week, month);
  }
  audit('staff', req.user.id, req.user.name, '調整方案人次上限', plan.name,
    { counselorId, week_limit: week, month_limit: month });
  res.json({ ok: true, week_limit: week, month_limit: month });
});

// ---- 個案的方案使用次數（標記用了幾次青壯年方案）----

router.get('/clients/:id/plan-usage', requireStaff('clients'), (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const rows = clientUsageAll(req.params.id, year);
  const history = db.prepare(`SELECT a.date, a.start_time, a.status, a.fee, p.name AS plan_name,
      t.name AS topic_name, u.name AS counselor_name
    FROM appointments a
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.client_id = ? AND a.plan_id IS NOT NULL AND substr(a.date,1,4) = ?
    ORDER BY a.date DESC`).all(Number(req.params.id), year);
  res.json({ year, rows, history });
});

// 人工調整已用次數（例如個案在其他諮商所已使用過的次數）
router.put('/clients/:id/plan-usage', requireStaff('clients'), (req, res) => {
  const b = req.body || {};
  const planId = Number(b.plan_id) || 0;
  const year = String(b.year || new Date().getFullYear());
  if (!planId) return res.status(400).json({ error: '請指定方案' });
  const offset = Math.max(0, Number(b.used_offset) || 0);
  db.prepare(`INSERT INTO plan_usage_adjustments (client_id, plan_id, year, used_offset, note, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(client_id, plan_id, year) DO UPDATE SET
      used_offset = excluded.used_offset, note = excluded.note,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(Number(req.params.id), planId, year, offset, String(b.note || ''), req.user.id, nowStamp());
  audit('staff', req.user.id, req.user.name, '調整方案已用次數', String(req.params.id), { planId, year, offset });
  res.json({ ok: true, usage: clientUsage(req.params.id, planId, year) });
});

// ---- 每位心理師每月收支 ----
//
// 收入面以「已完成的晤談」為準（未到只收部分費用，故另計）；
// 心理師報酬取當時鎖定的 counselor_share，沒有的（舊資料或無方案）才即時試算。
// 實收金額另外由收費單的收款狀態算，讓所方看得出「該收多少」與「實際收到多少」的差。
router.get('/plan-income', requireStaff('reports'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const counselorFilter = Number(req.query.counselor_id) || 0;
  const appts = db.prepare(`SELECT a.*, u.name AS counselor_name, p.name AS plan_name, p.kind AS plan_kind,
      t.name AS topic_name, c.name AS client_name, c.code AS client_code
    FROM appointments a
    JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    LEFT JOIN clients c ON c.id = a.client_id
    WHERE substr(a.date,1,7) = ? AND a.status IN ('done','no_show')
      ${counselorFilter ? 'AND a.counselor_id = ?' : ''}
    ORDER BY a.date, a.start_time`).all(...(counselorFilter ? [month, counselorFilter] : [month]));

  // 收費單以月份彙整，用來對照實收
  const invoices = db.prepare(`SELECT i.*, a.counselor_id,
      (SELECT COALESCE(SUM(amount),0) FROM refunds rf WHERE rf.invoice_id = i.id) AS refunded
    FROM invoices i LEFT JOIN appointments a ON a.id = i.appointment_id
    WHERE substr(i.date,1,7) = ? AND i.status != 'void'`).all(month);

  const byCounselor = new Map();
  const ensure = (id, name) => {
    if (!byCounselor.has(id)) {
      byCounselor.set(id, {
        counselor_id: id, counselor_name: name, sessions: 0, no_shows: 0,
        gross: 0, subsidy: 0, self_pay: 0, venue: 0, share: 0, center: 0,
        collected: 0, uncollected: 0, plans: new Map()
      });
    }
    return byCounselor.get(id);
  };

  for (const a of appts) {
    const row = ensure(a.counselor_id, a.counselor_name);
    const q = resolveFee({ plan_id: a.plan_id, topic_id: a.topic_id, counselor_id: a.counselor_id,
      fee_override: a.fee, client_id: a.client_id });
    // 未到只收部分費用：固定規費時換算成等效比例，各項才會一致縮放
    const rate = a.status === 'no_show' ? noShowCharge(a.fee).rate : 1;
    // 未到只收部分費用：個案自付與方案給付都按同一比例計，心理師報酬亦然
    const clientPay = Math.round((a.fee || 0) * rate);
    const subsidy = Math.round((a.subsidy_amount || 0) * rate);
    const gross = clientPay + subsidy;
    const venue = Math.round((q.venue_fee || 0) * rate);
    const share = Math.round((a.counselor_share || q.counselor_share) * rate);

    if (a.status === 'no_show') row.no_shows++; else row.sessions++;
    row.gross += gross; row.subsidy += subsidy; row.self_pay += clientPay;
    row.venue += venue; row.share += share; row.center += gross - share;

    const key = a.plan_id || 0;
    if (!row.plans.has(key)) {
      row.plans.set(key, {
        plan_id: a.plan_id, plan_name: a.plan_name || '未指定方案', plan_kind: a.plan_kind || '',
        sessions: 0, gross: 0, subsidy: 0, self_pay: 0, venue: 0, share: 0, center: 0
      });
    }
    const pr = row.plans.get(key);
    pr.sessions++; pr.gross += gross; pr.subsidy += subsidy; pr.self_pay += clientPay;
    pr.venue += venue; pr.share += share; pr.center += gross - share;
  }

  for (const inv of invoices) {
    if (!inv.counselor_id) continue;
    if (counselorFilter && inv.counselor_id !== counselorFilter) continue;
    const row = byCounselor.get(inv.counselor_id);
    if (!row) continue;
    if (inv.status === 'paid') row.collected += inv.amount - (inv.refunded || 0);
    else if (inv.status === 'unpaid') row.uncollected += inv.amount;
  }

  const payouts = db.prepare(`SELECT p.*, u.name AS counselor_name FROM payouts p
    JOIN users u ON u.id = p.user_id WHERE p.month = ?`).all(month);

  const rows = [...byCounselor.values()].map(r => ({
    ...r,
    plans: [...r.plans.values()].sort((a, b) => b.gross - a.gross),
    payout_recorded: payouts.filter(p => p.user_id === r.counselor_id).reduce((a, b) => a + b.gross, 0),
    payout_status: payouts.some(p => p.user_id === r.counselor_id && p.status === 'paid') ? 'paid'
      : payouts.some(p => p.user_id === r.counselor_id) ? 'pending' : 'none'
  })).sort((a, b) => b.gross - a.gross);

  const total = rows.reduce((acc, r) => ({
    sessions: acc.sessions + r.sessions, no_shows: acc.no_shows + r.no_shows,
    gross: acc.gross + r.gross, subsidy: acc.subsidy + r.subsidy, self_pay: acc.self_pay + r.self_pay,
    venue: acc.venue + r.venue, share: acc.share + r.share, center: acc.center + r.center,
    collected: acc.collected + r.collected, uncollected: acc.uncollected + r.uncollected
  }), { sessions: 0, no_shows: 0, gross: 0, subsidy: 0, self_pay: 0, venue: 0, share: 0, center: 0,
    collected: 0, uncollected: 0 });

  res.json({ month, rows, total });
});

// 單一心理師的當月明細（可列印給心理師對帳）
router.get('/plan-income/:counselorId/detail', requireStaff('reports'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const cid = Number(req.params.counselorId);
  const u = db.prepare('SELECT id, name, title FROM users WHERE id = ?').get(cid);
  if (!u) return res.status(404).json({ error: '找不到此心理師' });
  const rows = db.prepare(`SELECT a.date, a.start_time, a.end_time, a.status, a.fee, a.subsidy_amount, a.counselor_share,
      c.code AS client_code, c.name AS client_name, p.name AS plan_name, t.name AS topic_name,
      (SELECT i.status FROM invoices i WHERE i.appointment_id = a.id AND i.status != 'void' LIMIT 1) AS invoice_status
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    WHERE a.counselor_id = ? AND substr(a.date,1,7) = ? AND a.status IN ('done','no_show')
    ORDER BY a.date, a.start_time`).all(cid, month);
  const detail = rows.map(r => {
    const share = r.counselor_share || resolveFee({ fee_override: r.fee }).counselor_share;
    return { ...r, counselor_share: r.status === 'no_show'
      ? Math.round(share * noShowCharge(r.fee).rate) : share };
  });
  res.json({
    month, counselor: u, rows: detail,
    total_gross: detail.reduce((a, b) => a + (b.fee || 0) + (b.subsidy_amount || 0), 0),
    total_share: detail.reduce((a, b) => a + (b.counselor_share || 0), 0),
    center_name: getSetting('center_name')
  });
});

// ---- 心理師年報表（督考用）----
//
// 督考要的是「一位心理師一整年、紀錄與收費並排」的一份表：
// 每一列是一次晤談，同時看得到治療摘要、費用、拆帳，以及對應的收據號，
// 才能逐筆把紀錄對回收據。分月呈現、另附各方案（合作單位）與自費／機構的彙總。
//
// 治療摘要屬晤談紀錄內容，僅管理者、督導與該心理師本人看得到；
// 其他有報表權限者看到的是「＊＊＊」，該列仍看得到有沒有寫紀錄。

// 民國日期：1140601（年報表的個案編碼沿用這個寫法）
function rocCompact(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${Number(m[1]) - 1911}${m[2]}${m[3]}` : '';
}

// 治療摘要：取晤談紀錄裡最能代表「今日治療情形」的欄位，串成 50～100 字的一段。
function noteSummary(n) {
  if (!n) return '';
  const parts = [n.objective, n.assessment, n.intervention, n.plan]
    .map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = parts.join('；');
  return text.length > 150 ? text.slice(0, 150) + '…' : text;
}

// 個案編碼：初評日期（該案最早一次晤談）＋方案標記＋該標記下的累計次數，
// 例如 1140601_22、1140601_青壯1。標記取主題設定，主題沒設就取方案設定。
function caseCodeMap(clientIds) {
  if (!clientIds.length) return { codes: new Map(), firstDates: new Map() };
  const rows = db.prepare(`SELECT a.id, a.client_id, a.date,
      COALESCE(NULLIF(t.code_prefix, ''), p.code_prefix, '') AS prefix
    FROM appointments a
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    WHERE a.client_id IN (${clientIds.map(() => '?').join(',')})
      AND a.status IN ('done','no_show')
    ORDER BY a.date, a.start_time, a.id`).all(...clientIds);
  const firstDates = new Map(), seq = new Map(), codes = new Map();
  for (const r of rows) {
    if (!firstDates.has(r.client_id)) firstDates.set(r.client_id, r.date);
    const key = `${r.client_id}|${r.prefix}`;
    const n = (seq.get(key) || 0) + 1;
    seq.set(key, n);
    codes.set(r.id, `${rocCompact(firstDates.get(r.client_id))}_${r.prefix}${n}`);
  }
  return { codes, firstDates };
}

// 年報表的「類別」：方案上填的是指定案代碼（自費 0、機構 30），
// 派案則是該代碼 +1（1、31）——這是所方年報表原本的編法。
// 個案沒註記指定／派案時（舊資料），就照方案填的代碼原樣印出。
function reportCategory(planCode, assignType) {
  const code = String(planCode || '');
  if (!code || assignType !== 'assigned') return code;
  return /^\d+$/.test(code) ? String(Number(code) + 1) : code;
}

function annualReport(counselorId, year, canSeeSummary) {
  const u = db.prepare('SELECT id, name, title, license_type FROM users WHERE id = ?').get(counselorId);
  if (!u) return null;
  const like = `${year}-%`;
  const appts = db.prepare(`SELECT a.*, c.code AS client_code, c.name AS client_name,
      c.assign_type,
      p.name AS plan_name, p.kind AS plan_kind,
      COALESCE(NULLIF(t.report_code, ''), p.report_code, '') AS report_code,
      t.name AS topic_name
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    LEFT JOIN plan_topics t ON t.id = a.topic_id
    WHERE a.counselor_id = ? AND a.date LIKE ? AND a.status IN ('done','no_show')
    ORDER BY a.date, a.start_time`).all(counselorId, like);

  const apptIds = appts.map(a => a.id);
  const clientIds = [...new Set(appts.map(a => a.client_id).filter(Boolean))];
  const { codes } = caseCodeMap(clientIds);

  const inChunk = ids => (ids.length ? ids.map(() => '?').join(',') : 'NULL');
  // 收據：收費單上的收據號，或另行開立的收據（作廢者不列）
  const money = db.prepare(`SELECT i.appointment_id, i.status AS invoice_status, i.amount, i.method,
      i.receipt_no AS invoice_receipt_no,
      (SELECT GROUP_CONCAT(rc.receipt_no, '、') FROM receipts rc
        WHERE rc.invoice_id = i.id AND rc.status = 'valid') AS receipt_nos
    FROM invoices i WHERE i.appointment_id IN (${inChunk(apptIds)}) AND i.status != 'void'`).all(...apptIds);
  const moneyMap = new Map(money.map(m => [m.appointment_id, m]));

  const notes = db.prepare(`SELECT * FROM session_notes
    WHERE counselor_id = ? AND date LIKE ?`).all(counselorId, like);
  const noteByAppt = new Map(notes.filter(n => n.appointment_id).map(n => [n.appointment_id, n]));
  const noteByDay = new Map(notes.map(n => [`${n.client_id}|${n.date}`, n]));

  const rows = appts.map(a => {
    const q = resolveFee({ plan_id: a.plan_id, topic_id: a.topic_id, counselor_id: a.counselor_id,
      fee_override: a.fee, client_id: a.client_id });
    const rate = a.status === 'no_show' ? noShowCharge(a.fee).rate : 1;
    const clientPay = Math.round((a.fee || 0) * rate);
    const subsidy = Math.round((a.subsidy_amount || 0) * rate);
    const gross = clientPay + subsidy;
    const share = Math.round((a.counselor_share || q.counselor_share) * rate);
    const note = noteByAppt.get(a.id) || noteByDay.get(`${a.client_id}|${a.date}`) || null;
    const inv = moneyMap.get(a.id) || null;
    return {
      appointment_id: a.id,
      date: a.date,
      month: Number(a.date.slice(5, 7)),
      case_code: codes.get(a.id) || '',
      client_id: a.client_id,
      client_code: a.client_code || '',
      client_name: a.client_name || '',
      counselor_name: u.name,
      summary: canSeeSummary ? noteSummary(note) : (note ? '＊＊＊（無檢視權限）' : ''),
      note_status: !note ? 'missing' : (note.locked ? 'signed' : 'draft'),
      fee: gross,
      self_pay: clientPay,
      subsidy,
      category: reportCategory(a.report_code, a.assign_type),
      assign_type: a.assign_type || '',
      center: gross - share,
      share,
      plan_id: a.plan_id || 0,
      plan_name: a.plan_name || '未指定方案',
      plan_kind: a.plan_kind || 'self',
      topic_name: a.topic_name || '',
      status: a.status,
      receipt_no: (inv && (inv.receipt_nos || inv.invoice_receipt_no)) || '',
      invoice_status: inv ? inv.invoice_status : 'none',
      pay_method: (inv && inv.method) || ''
    };
  });

  const blank = extra => ({ sessions: 0, fee: 0, center: 0, share: 0, no_receipt: 0, no_note: 0, ...extra });
  const addTo = (acc, r) => {
    acc.sessions++; acc.fee += r.fee; acc.center += r.center; acc.share += r.share;
    if (!r.receipt_no) acc.no_receipt++;
    if (r.note_status === 'missing') acc.no_note++;
    return acc;
  };

  const months = Array.from({ length: 12 }, (_, i) => {
    const mRows = rows.filter(r => r.month === i + 1);
    return {
      month: i + 1,
      label: `${i + 1}月`,
      rows: mRows,
      total: mRows.reduce(addTo, blank()),
      self: mRows.filter(r => r.plan_kind === 'self').reduce(addTo, blank()),
      org: mRows.filter(r => r.plan_kind !== 'self').reduce(addTo, blank())
    };
  });

  const byPlan = new Map();
  for (const r of rows) {
    const key = r.plan_id;
    if (!byPlan.has(key)) {
      byPlan.set(key, blank({ plan_id: key, plan_name: r.plan_name, plan_kind: r.plan_kind, rows: [] }));
    }
    const p = byPlan.get(key);
    p.rows.push(r);
    addTo(p, r);
  }

  return {
    year: String(year),
    counselor: u,
    can_see_summary: canSeeSummary,
    rows,
    months,
    plans: [...byPlan.values()].sort((a, b) => b.fee - a.fee),
    self_total: rows.filter(r => r.plan_kind === 'self').reduce(addTo, blank()),
    org_total: rows.filter(r => r.plan_kind !== 'self').reduce(addTo, blank()),
    total: rows.reduce(addTo, blank()),
    center_name: getSetting('center_name', '織心心理治療所')
  };
}

// 摘要屬紀錄內容：管理者、督導、以及該心理師本人才看得到
function canSeeSummaryFor(user, counselorId) {
  return user.role === 'admin' || user.role === 'supervisor' || user.id === Number(counselorId);
}

// 有哪些心理師該年有服務量（年報表挑人用）
router.get('/annual-report', requireStaff('reports'), (req, res) => {
  const year = String(req.query.year || today().slice(0, 4));
  res.json({
    year,
    counselors: db.prepare(`SELECT u.id, u.name, u.title, COUNT(*) AS sessions
      FROM appointments a JOIN users u ON u.id = a.counselor_id
      WHERE a.date LIKE ? AND a.status IN ('done','no_show')
      GROUP BY u.id ORDER BY u.name`).all(`${year}-%`)
  });
});

router.get('/annual-report/:counselorId', requireStaff('reports'), (req, res) => {
  const year = String(req.query.year || today().slice(0, 4));
  const data = annualReport(Number(req.params.counselorId), year, canSeeSummaryFor(req.user, req.params.counselorId));
  if (!data) return res.status(404).json({ error: '找不到此心理師' });
  audit('staff', req.user.id, req.user.name, '檢視心理師年報表', data.counselor.name,
    { year, sessions: data.total.sessions });
  res.json(data);
});

const ANNUAL_HEADERS = ['日期', '編碼', '個案', '心理師', '治療摘要/報告', '費用', '類別',
  '所方', '心理師報酬', '收據號', '收款', '紀錄'];
const NOTE_LABEL = { missing: '未寫', draft: '未定稿', signed: '已定稿' };
const INV_LABEL = { paid: '已收', unpaid: '未收', none: '未開單' };

function annualRow(r) {
  return [r.date, r.case_code, r.client_code || r.client_name, r.counselor_name, r.summary,
    r.fee, r.category, r.center, r.share, r.receipt_no,
    INV_LABEL[r.invoice_status] || r.invoice_status, NOTE_LABEL[r.note_status]];
}

// Excel 2003 XML：一個工作表對一個月，另加各方案與年度彙總，開起來就是所方原本那本年報表
function annualExcel(data) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = v => (typeof v === 'number'
    ? `<Cell ss:StyleID="n"><Data ss:Type="Number">${v}</Data></Cell>`
    : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`);
  const sheet = (name, rows) => `<Worksheet ss:Name="${esc(name).slice(0, 28)}"><Table>
${rows.map(r => `<Row>${r.map(cell).join('')}</Row>`).join('\n')}
</Table></Worksheet>`;
  const totalRow = (label, t) => [label, '', '', '', '', t.fee, '', t.center, t.share,
    `未附收據 ${t.no_receipt} 筆`, `${t.sessions} 人次`, `未寫紀錄 ${t.no_note} 筆`];

  const monthSheets = data.months.map(m => sheet(m.label, [
    [`${data.center_name}　${data.year} 年度　${data.counselor.name}　${m.label}`],
    [], ANNUAL_HEADERS,
    ...m.rows.map(annualRow),
    [], totalRow('本月合計', m.total),
    totalRow('　自費案', m.self), totalRow('　機構案', m.org)
  ]));
  const planSheets = data.plans.map(p => sheet(p.plan_name, [
    [`${data.counselor.name}　${data.year} 年度　${p.plan_name}`],
    [], ANNUAL_HEADERS, ...p.rows.map(annualRow), [], totalRow('合計', p)
  ]));
  const summary = sheet('年度彙總', [
    [`${data.center_name}　${data.year} 年度　${data.counselor.name} 年報表`],
    [], ['項目', '人次', '費用合計', '所方', '心理師報酬', '未附收據', '未寫紀錄'],
    ...data.months.map(m => [m.label, m.total.sessions, m.total.fee, m.total.center, m.total.share,
      m.total.no_receipt, m.total.no_note]),
    [], ['自費', data.self_total.sessions, data.self_total.fee, data.self_total.center,
      data.self_total.share, data.self_total.no_receipt, data.self_total.no_note],
    ['機構', data.org_total.sessions, data.org_total.fee, data.org_total.center,
      data.org_total.share, data.org_total.no_receipt, data.org_total.no_note],
    ['全年', data.total.sessions, data.total.fee, data.total.center, data.total.share,
      data.total.no_receipt, data.total.no_note],
    [], ['方案別'], ['方案', '人次', '費用合計', '所方', '心理師報酬', '未附收據', '未寫紀錄'],
    ...data.plans.map(p => [p.plan_name, p.sessions, p.fee, p.center, p.share, p.no_receipt, p.no_note])
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="n"><NumberFormat ss:Format="#,##0"/></Style></Styles>
${summary}
${monthSheets.join('\n')}
${planSheets.join('\n')}
</Workbook>`;
}

function annualPrintHtml(data) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = n => Number(n || 0).toLocaleString('en-US');
  const totalLine = (label, t) => `<tr class="sum"><td colspan="5">${esc(label)}　${t.sessions} 人次</td>
    <td class="amt">${money(t.fee)}</td><td></td><td class="amt">${money(t.center)}</td>
    <td class="amt">${money(t.share)}</td><td colspan="3">未附收據 ${t.no_receipt} 筆／未寫紀錄 ${t.no_note} 筆</td></tr>`;
  const table = rows => `<table><thead><tr>${ANNUAL_HEADERS.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(r.date)}</td><td>${esc(r.case_code)}</td><td>${esc(r.client_code || r.client_name)}</td>
      <td>${esc(r.counselor_name)}</td><td class="sm">${esc(r.summary)}</td>
      <td class="amt">${money(r.fee)}</td><td>${esc(r.category)}</td>
      <td class="amt">${money(r.center)}</td><td class="amt">${money(r.share)}</td>
      <td>${esc(r.receipt_no) || '<span class="warn">未附</span>'}</td>
      <td>${esc(INV_LABEL[r.invoice_status] || r.invoice_status)}</td>
      <td>${r.note_status === 'missing' ? '<span class="warn">未寫</span>' : esc(NOTE_LABEL[r.note_status])}</td>
    </tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(data.counselor.name)}　${esc(data.year)} 年度報表</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; color: #1c2b2b; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 18px 0 6px; page-break-before: always; }
  h2:first-of-type { page-break-before: avoid; }
  .sub { font-size: 12px; color: #667; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 11.5px; margin-bottom: 8px; }
  th, td { border: 1px solid #c9d6d6; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #e6efef; }
  .amt { text-align: right; }
  .sm { font-size: 11px; max-width: 320px; }
  .sum { background: #f3f7f7; font-weight: 600; }
  .warn { color: #b4381f; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .foot { margin-top: 12px; font-size: 11px; color: #778; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
<h1>${esc(data.center_name)}　${esc(data.year)} 年度心理師報表－${esc(data.counselor.name)}</h1>
<div class="sub">全年 ${data.total.sessions} 人次　費用合計 ${money(data.total.fee)}　所方 ${money(data.total.center)}　
  心理師報酬 ${money(data.total.share)}　未附收據 ${data.total.no_receipt} 筆　未寫紀錄 ${data.total.no_note} 筆
  ${data.can_see_summary ? '' : '（治療摘要因權限未顯示）'}</div>
${data.months.filter(m => m.rows.length).map(m => `<h2>${esc(m.label)}</h2>
  ${table(m.rows)}
  <table>${totalLine('本月合計', m.total)}${totalLine('　自費案', m.self)}${totalLine('　機構案', m.org)}</table>`).join('')}
<h2>年度彙總</h2>
<table><thead><tr><th>項目</th><th>人次</th><th>費用合計</th><th>所方</th><th>心理師報酬</th><th>未附收據</th><th>未寫紀錄</th></tr></thead>
<tbody>${data.months.map(m => `<tr><td>${m.label}</td><td>${m.total.sessions}</td>
  <td class="amt">${money(m.total.fee)}</td><td class="amt">${money(m.total.center)}</td>
  <td class="amt">${money(m.total.share)}</td><td>${m.total.no_receipt}</td><td>${m.total.no_note}</td></tr>`).join('')}
${[['自費', data.self_total], ['機構', data.org_total], ['全年', data.total]].map(([label, t]) =>
    `<tr class="sum"><td>${label}</td><td>${t.sessions}</td><td class="amt">${money(t.fee)}</td>
      <td class="amt">${money(t.center)}</td><td class="amt">${money(t.share)}</td>
      <td>${t.no_receipt}</td><td>${t.no_note}</td></tr>`).join('')}
${data.plans.map(p => `<tr><td>方案：${esc(p.plan_name)}</td><td>${p.sessions}</td>
  <td class="amt">${money(p.fee)}</td><td class="amt">${money(p.center)}</td>
  <td class="amt">${money(p.share)}</td><td>${p.no_receipt}</td><td>${p.no_note}</td></tr>`).join('')}
</tbody></table>
<div class="foot">本表含個案相關資料與紀錄摘要，請依個人資料保護法與所內作業辦法妥善保管。</div>
<script>if (location.hash !== '#noprint') setTimeout(() => window.print(), 400);<\/script>
</body></html>`;
}

router.get('/annual-report/:counselorId/export', requireStaff('reports'), (req, res) => {
  const year = String(req.query.year || today().slice(0, 4));
  const format = req.query.format === 'pdf' ? 'pdf' : 'xls';
  const data = annualReport(Number(req.params.counselorId), year, canSeeSummaryFor(req.user, req.params.counselorId));
  if (!data) return res.status(404).json({ error: '找不到此心理師' });
  audit('staff', req.user.id, req.user.name, '匯出心理師年報表', data.counselor.name,
    { year, format, sessions: data.total.sessions });
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(annualPrintHtml(data));
  }
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="annual_${data.counselor.id}_${year}.xls"`);
  res.send(annualExcel(data));
});

module.exports = router;
