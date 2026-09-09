const express = require('express');
const { db, audit, today, addDays, getSetting, listSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// ---- 請假／不可預約時段 ----
// 優先於 availability：請假區間內的時段不會出現在可預約清單，也擋櫃檯下訂。

router.get('/time-off', requireStaff('hr'), (req, res) => {
  const { counselor_id = '', from = today(), to = '' } = req.query;
  const where = ['t.end_date >= ?'], args = [from];
  if (to) { where.push('t.start_date <= ?'); args.push(to); }
  if (counselor_id) { where.push('t.counselor_id = ?'); args.push(Number(counselor_id)); }
  res.json(db.prepare(`SELECT t.*, u.name AS counselor_name FROM time_off t
    JOIN users u ON u.id = t.counselor_id WHERE ${where.join(' AND ')}
    ORDER BY t.start_date`).all(...args));
});

router.post('/time-off', requireStaff('hr'), (req, res) => {
  const b = req.body || {};
  const cid = Number(b.counselor_id) || req.user.id;
  if (req.user.role !== 'admin' && cid !== req.user.id) {
    return res.status(403).json({ error: '僅能登錄自己的請假' });
  }
  if (!b.start_date) return res.status(400).json({ error: '請填寫起始日期' });
  const end = b.end_date || b.start_date;
  if (end < b.start_date) return res.status(400).json({ error: '結束日期不可早於起始日期' });
  const allDay = b.all_day === undefined ? 1 : (b.all_day ? 1 : 0);
  // 請假期間若已有預約，先擋下來請人工改期，避免個案被放鴿子
  const clash = db.prepare(`SELECT a.date, a.start_time, c.name AS client_name FROM appointments a
    JOIN clients c ON c.id = a.client_id
    WHERE a.counselor_id = ? AND a.status IN ('booked','arrived') AND a.date BETWEEN ? AND ?
      ${allDay ? '' : 'AND a.start_time < ? AND a.end_time > ?'}
    ORDER BY a.date, a.start_time`).all(...(allDay ? [cid, b.start_date, end] : [cid, b.start_date, end, b.end_time || '23:59', b.start_time || '00:00']));
  if (clash.length && !b.force) {
    return res.status(400).json({
      error: `此期間尚有 ${clash.length} 筆預約（最近：${clash[0].date} ${clash[0].start_time} ${clash[0].client_name}），請先改期或勾選仍要登錄`,
      clashes: clash
    });
  }
  const info = db.prepare(`INSERT INTO time_off (counselor_id, start_date, end_date, all_day, start_time, end_time, reason)
    VALUES (?,?,?,?,?,?,?)`).run(cid, b.start_date, end, allDay,
    allDay ? '' : (b.start_time || ''), allDay ? '' : (b.end_time || ''), b.reason || '');
  audit('staff', req.user.id, req.user.name, '登錄請假', String(cid), { from: b.start_date, to: end });
  res.json({ id: info.lastInsertRowid });
});

// 請假日期或事由填錯時就地修正，不必刪掉重登
router.put('/time-off/:id', requireStaff('hr'), (req, res) => {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此紀錄' });
  if (req.user.role !== 'admin' && t.counselor_id !== req.user.id) {
    return res.status(403).json({ error: '僅能修改自己的請假' });
  }
  const b = { ...t, ...req.body };
  const end = b.end_date || b.start_date;
  if (!b.start_date) return res.status(400).json({ error: '請填寫起始日期' });
  if (end < b.start_date) return res.status(400).json({ error: '結束日期不可早於起始日期' });
  const allDay = b.all_day ? 1 : 0;
  db.prepare(`UPDATE time_off SET start_date = ?, end_date = ?, all_day = ?, start_time = ?, end_time = ?, reason = ?
    WHERE id = ?`).run(b.start_date, end, allDay,
    allDay ? '' : (b.start_time || ''), allDay ? '' : (b.end_time || ''), b.reason || '', t.id);
  audit('staff', req.user.id, req.user.name, '修改請假', String(t.counselor_id), { from: b.start_date, to: end });
  res.json({ ok: true });
});

router.delete('/time-off/:id', requireStaff('hr'), (req, res) => {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此紀錄' });
  if (req.user.role !== 'admin' && t.counselor_id !== req.user.id) {
    return res.status(403).json({ error: '僅能刪除自己的請假' });
  }
  db.prepare('DELETE FROM time_off WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

// ---- 繼續教育積分 ----
// 心理師執業執照每 6 年更新，期間須完成規定積分；其中專業品質、專業倫理、
// 專業相關法規三類合計另有下限。此處以設定值計算，實際規定以主管機關公告為準。

router.get('/ce-credits', requireStaff('hr'), (req, res) => {
  const userId = req.user.role === 'admin' || req.user.role === 'supervisor'
    ? (Number(req.query.user_id) || null) : req.user.id;
  const where = [], args = [];
  if (userId) { where.push('c.user_id = ?'); args.push(userId); }
  res.json(db.prepare(`SELECT c.*, u.name AS user_name FROM ce_credits c JOIN users u ON u.id = c.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.date DESC`).all(...args));
});

router.post('/ce-credits', requireStaff('hr'), (req, res) => {
  const b = req.body || {};
  const uid = Number(b.user_id) || req.user.id;
  if (req.user.role !== 'admin' && uid !== req.user.id) {
    return res.status(403).json({ error: '僅能登錄自己的積分' });
  }
  if (!b.title) return res.status(400).json({ error: '請填寫課程名稱' });
  const info = db.prepare(`INSERT INTO ce_credits (user_id, date, title, organizer, category, hours, credits, cert_no, note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(uid, b.date || today(), b.title, b.organizer || '',
    b.category || '專業課程', Number(b.hours) || 0, Number(b.credits) || 0, b.cert_no || '', b.note || '');
  res.json({ id: info.lastInsertRowid });
});

router.delete('/ce-credits/:id', requireStaff('hr'), (req, res) => {
  const c = db.prepare('SELECT * FROM ce_credits WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此紀錄' });
  if (req.user.role !== 'admin' && c.user_id !== req.user.id) {
    return res.status(403).json({ error: '僅能刪除自己的積分' });
  }
  db.prepare('DELETE FROM ce_credits WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// 積分彙總：以「執照更新日往前推一個週期」為計算區間
router.get('/ce-summary', requireStaff('hr'), (req, res) => {
  const cycle = Number(getSetting('ce_cycle_years', '6'));
  const required = Number(getSetting('ce_required_credits', '120'));
  const requiredSpecial = Number(getSetting('ce_required_special', '12'));
  // 特定類別合計下限之外，「專業倫理」另有個別下限，需分開檢核
  const requiredEthics = Number(getSetting('ce_required_ethics', '2'));
  const special = ['專業品質', '專業倫理', '專業相關法規'];
  const users = db.prepare(`SELECT id, name, license_type, license_no, license_expiry FROM users
    WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id`).all();
  const scope = req.user.role === 'staff' ? users.filter(u => u.id === req.user.id) : users;
  const rows = scope.map(u => {
    // 未填執照更新日時，以今日往前推一個週期作為概算區間
    const end = u.license_expiry || today();
    const start = addDays(end, -Math.round(cycle * 365.25));
    const list = db.prepare('SELECT category, credits, hours FROM ce_credits WHERE user_id = ? AND date BETWEEN ? AND ?')
      .all(u.id, start, end > today() ? today() : end);
    const total = list.reduce((s, r) => s + r.credits, 0);
    const specialTotal = list.filter(r => special.includes(r.category)).reduce((s, r) => s + r.credits, 0);
    const ethicsTotal = list.filter(r => r.category === '專業倫理').reduce((s, r) => s + r.credits, 0);
    const daysLeft = u.license_expiry
      ? Math.round((new Date(u.license_expiry + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000)
      : null;
    return {
      ...u, cycle_start: start, cycle_end: end,
      total_credits: Math.round(total * 10) / 10,
      special_credits: Math.round(specialTotal * 10) / 10,
      ethics_credits: Math.round(ethicsTotal * 10) / 10,
      total_hours: Math.round(list.reduce((s, r) => s + r.hours, 0) * 10) / 10,
      ok: total >= required && specialTotal >= requiredSpecial && ethicsTotal >= requiredEthics,
      days_left: daysLeft,
      alert: daysLeft !== null && daysLeft <= Number(getSetting('license_alert_days', '180'))
    };
  });
  res.json({ required, required_special: requiredSpecial, required_ethics: requiredEthics,
    cycle, categories: listSetting('ce_categories'), rows });
});

// ---- 心理師報酬與扣繳 ----
// 外聘心理師、督導的鐘點多屬執行業務所得（9A／9B），所方為扣繳義務人，
// 須代扣所得稅並於達門檻時扣繳二代健保補充保費。所得稅率、起扣點皆可於系統設定調整。

// 依給付總額與所得類別算出應扣金額。薪資所得（50）走薪資扣繳表，
// 非本系統試算範圍，故僅計補充保費，所得稅留給人工填。
function calcDeduction(gross, incomeType) {
  const rate = Number(getSetting('withholding_rate', '0.1'));
  const taxMin = Number(getSetting('withholding_min', '20010'));
  const nhiRate = Number(getSetting('nhi_supplement_rate', '0.0211'));
  const nhiMin = Number(getSetting('nhi_supplement_min', '20000'));
  const withholding = incomeType === '50' || gross < taxMin ? 0 : Math.round(gross * rate);
  const nhi = gross >= nhiMin ? Math.round(gross * nhiRate) : 0;
  return { withholding, nhi_supplement: nhi, net: gross - withholding - nhi };
}

// 試算：前端輸入金額時即時顯示，不寫入資料
router.get('/payouts/preview', requireStaff('payouts'), (req, res) => {
  const gross = Number(req.query.gross) || 0;
  res.json({ gross, ...calcDeduction(gross, req.query.income_type || '9B') });
});

router.get('/payouts', requireStaff('payouts'), (req, res) => {
  const { month = '', user_id = '', status = '' } = req.query;
  const where = [], args = [];
  if (month) { where.push('p.month = ?'); args.push(month); }
  if (user_id) { where.push('p.user_id = ?'); args.push(Number(user_id)); }
  if (status) { where.push('p.status = ?'); args.push(status); }
  // 行政人員只看得到自己的報酬明細
  if (req.user.role === 'staff') { where.push('p.user_id = ?'); args.push(req.user.id); }
  const rows = db.prepare(`SELECT p.*, u.name AS user_name, u.license_type
    FROM payouts p JOIN users u ON u.id = p.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.month DESC, u.name, p.id DESC LIMIT 500`).all(...args);
  const sum = k => rows.reduce((a, b) => a + b[k], 0);
  res.json({
    rows,
    total_gross: sum('gross'),
    total_withholding: sum('withholding'),
    total_nhi: sum('nhi_supplement'),
    total_net: sum('net')
  });
});

// 依當月已完成晤談自動帶出鐘點：省去人工逐筆加總，金額仍可手改
router.get('/payouts/suggest', requireStaff('payouts'), (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const from = month + '-01', to = month + '-31';
  res.json(db.prepare(`SELECT u.id AS user_id, u.name AS user_name, u.license_type,
      COUNT(*) AS sessions, COALESCE(SUM(a.fee), 0) AS fee_total
    FROM appointments a JOIN users u ON u.id = a.counselor_id
    WHERE a.status = 'done' AND a.date BETWEEN ? AND ?
    GROUP BY u.id ORDER BY u.name`).all(from, to));
});

router.post('/payouts', requireStaff('payouts'), (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(b.user_id) || 0);
  if (!u) return res.status(400).json({ error: '請選擇心理師' });
  if (!b.month) return res.status(400).json({ error: '請選擇給付月份' });
  const gross = Number(b.gross) || 0;
  const auto = calcDeduction(gross, b.income_type || '9B');
  // 允許人工覆寫試算結果（例如已另行申報或適用免扣繳）
  const withholding = b.withholding === undefined || b.withholding === '' ? auto.withholding : Number(b.withholding) || 0;
  const nhi = b.nhi_supplement === undefined || b.nhi_supplement === '' ? auto.nhi_supplement : Number(b.nhi_supplement) || 0;
  const info = db.prepare(`INSERT INTO payouts
    (user_id, month, item, sessions, gross, income_type, withholding, nhi_supplement, net, note, pay_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    u.id, b.month, b.item || '晤談鐘點', Number(b.sessions) || 0, gross, b.income_type || '9B',
    withholding, nhi, gross - withholding - nhi, b.note || '', String(b.pay_date || ''));
  audit('staff', req.user.id, req.user.name, '新增報酬單', u.name, { month: b.month, gross });
  res.json({ id: info.lastInsertRowid });
});

router.put('/payouts/:id', requireStaff('payouts'), (req, res) => {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此報酬單' });
  if (p.status === 'paid') return res.status(400).json({ error: '已付款的報酬單不可修改，請先取消付款' });
  const b = { ...p, ...req.body };
  const gross = Number(b.gross) || 0;
  const withholding = Number(b.withholding) || 0;
  const nhi = Number(b.nhi_supplement) || 0;
  db.prepare(`UPDATE payouts SET month = ?, item = ?, sessions = ?, gross = ?, income_type = ?,
      withholding = ?, nhi_supplement = ?, net = ?, note = ?, pay_date = ? WHERE id = ?`).run(
    b.month, b.item || '', Number(b.sessions) || 0, gross, b.income_type,
    withholding, nhi, gross - withholding - nhi, b.note || '', String(b.pay_date || ''), p.id);
  audit('staff', req.user.id, req.user.name, '修改報酬單', String(p.user_id), { id: p.id });
  res.json({ ok: true });
});

// 「請心理師確認後我們再撥款」：沒確認過的月份，撥款一律先擋下並說明是哪一位、哪個月。
// 帶 override 可放行（有人就是先匯了款、或本人當面確認過），但會留在稽核軌跡裡，
// 而不是靜悄悄地繞過這道關卡。
function confirmGate(rows, override) {
  if (override) return '';
  const need = [];
  for (const key of new Set(rows.map(r => `${r.user_id}|${r.month}`))) {
    const [uid, month] = key.split('|');
    const st = db.prepare('SELECT status FROM payout_months WHERE user_id = ? AND month = ?').get(Number(uid), month);
    if (!st || st.status !== 'confirmed') {
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(uid));
      need.push(`${u ? u.name : uid}（${month}）${st && st.status === 'disputed' ? '回報有疑義'
        : st ? '尚未確認' : '尚未送出月結'}`);
    }
  }
  return need.length ? `以下月結尚未由本人確認，請先處理：${need.join('、')}` : '';
}

router.post('/payouts/:id/pay', requireStaff('payouts'), (req, res) => {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此報酬單' });
  const paid = p.status !== 'paid';
  // 只有「要付款」時才擋；取消付款是修正動作，不受此限
  if (paid) {
    const blocked = confirmGate([p], (req.body || {}).override);
    if (blocked) return res.status(400).json({ error: blocked, need_confirm: true });
  }
  db.prepare('UPDATE payouts SET status = ?, paid_at = ? WHERE id = ?')
    .run(paid ? 'paid' : 'pending', paid ? today() : '', p.id);
  audit('staff', req.user.id, req.user.name, paid ? '報酬付款' : '取消報酬付款', String(p.user_id),
    { id: p.id, override: paid && (req.body || {}).override ? '未經本人確認即付款' : undefined });
  res.json({ ok: true });
});

router.delete('/payouts/:id', requireStaff('payouts'), (req, res) => {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此報酬單' });
  if (p.status === 'paid') return res.status(400).json({ error: '已付款的報酬單不可刪除' });
  db.prepare('DELETE FROM payouts WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除報酬單', String(p.user_id), { id: p.id });
  res.json({ ok: true });
});

// 各類所得扣繳暨免扣繳憑單所需的年度彙總（依所得人、所得類別）
router.get('/payouts/withholding-summary', requireStaff('payouts'), (req, res) => {
  const year = req.query.year || today().slice(0, 4);
  res.json(db.prepare(`SELECT u.name AS user_name, u.license_type, p.income_type,
      SUM(p.gross) AS gross, SUM(p.withholding) AS withholding,
      SUM(p.nhi_supplement) AS nhi_supplement, SUM(p.net) AS net, COUNT(*) AS items
    FROM payouts p JOIN users u ON u.id = p.user_id
    WHERE substr(p.month, 1, 4) = ? AND p.status = 'paid'
    GROUP BY u.id, p.income_type ORDER BY u.name`).all(year));
});

// ---- 勞務報酬單：自動拆成數筆低於扣繳門檻的給付 ----
//
// 單次給付達 20,010 元才代扣 10% 所得稅、達 20,000 元才扣 2.11% 補充保費（門檻可於設定調整），
// 所方習慣把一次結算拆成數次給付，逐筆低於門檻。這裡把拆法算好、逐筆建立報酬單，
// 並以 batch_id 記住它們原屬同一次結算，之後仍看得出總額是多少。
//
// 提醒：拆單只是把「給付」分次，不改變全年所得總額；年度扣繳憑單仍以全年累計申報，
// 是否適用免扣繳請與記帳單位確認。

// 拆單上限：預設取設定值，同時不得超過所得稅起扣點與補充保費門檻（各減 1 元）
function splitCap(max) {
  const taxMin = Number(getSetting('withholding_min', '20010'));
  const nhiMin = Number(getSetting('nhi_supplement_min', '20000'));
  const limit = Math.max(1, Math.min(taxMin - 1, nhiMin - 1));
  const want = Math.floor(Number(max) || Number(getSetting('payout_split_max', '19999')));
  return Math.max(1, Math.min(want > 0 ? want : limit, limit));
}

// 平均拆成 n 筆（n = 無條件進位的最少筆數），除不盡的餘數分給前面幾筆，
// 因此每筆金額最多只差 1 元，且都不超過上限。
function splitAmounts(gross, cap) {
  const total = Math.max(0, Math.round(Number(gross) || 0));
  if (!total) return [];
  const n = Math.ceil(total / cap);
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

// 依起始日與間隔天數排出每筆的支領日期；未指定起始日時不填日期，留給人工填。
function splitPlan(b) {
  const cap = splitCap(b.max);
  const incomeType = b.income_type || '9B';
  const amounts = splitAmounts(b.gross, cap);
  const start = String(b.start_date || '');
  const step = Math.max(0, Math.floor(Number(b.interval_days === undefined || b.interval_days === ''
    ? getSetting('payout_split_interval_days', '0') : b.interval_days) || 0));
  const parts = amounts.map((amount, i) => {
    const payDate = start ? addDays(start, step * i) : '';
    return {
      seq: i + 1,
      pay_date: payDate,
      month: payDate ? payDate.slice(0, 7) : String(b.month || today().slice(0, 7)),
      gross: amount,
      ...calcDeduction(amount, incomeType)
    };
  });
  const sum = k => parts.reduce((a, r) => a + r[k], 0);
  return {
    cap,
    income_type: incomeType,
    parts,
    total_gross: sum('gross'),
    total_withholding: sum('withholding'),
    total_nhi: sum('nhi_supplement'),
    total_net: sum('net')
  };
}

router.get('/payouts/split-preview', requireStaff('payouts'), (req, res) => {
  res.json(splitPlan(req.query || {}));
});

router.post('/payouts/split', requireStaff('payouts'), (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(b.user_id) || 0);
  if (!u) return res.status(400).json({ error: '請選擇心理師' });
  if (!Number(b.gross)) return res.status(400).json({ error: '請填寫給付總額' });
  if (!b.month && !b.start_date) return res.status(400).json({ error: '請選擇給付月份或起始支領日' });
  const plan = splitPlan(b);
  if (!plan.parts.length) return res.status(400).json({ error: '給付總額須大於 0' });

  const batchId = `PB${Date.now().toString(36).toUpperCase()}${u.id}`;
  const item = b.item || '晤談鐘點';
  const sessions = Number(b.sessions) || 0;
  const ins = db.prepare(`INSERT INTO payouts
    (user_id, month, item, sessions, gross, income_type, withholding, nhi_supplement, net, note,
     pay_date, batch_id, batch_seq, batch_total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = db.transaction(() => plan.parts.map(p => ins.run(
    u.id, p.month, item, p.seq === 1 ? sessions : 0, p.gross, plan.income_type,
    p.withholding, p.nhi_supplement, p.net, String(b.note || ''),
    p.pay_date, batchId, p.seq, plan.parts.length).lastInsertRowid))();

  audit('staff', req.user.id, req.user.name, '拆單建立報酬單', u.name,
    { batchId, parts: plan.parts.length, total: plan.total_gross });
  res.json({ batch_id: batchId, ids, ...plan });
});

// 同一批拆單一次付款／一次刪除，避免只處理到其中幾筆
router.post('/payouts/batch/:batchId/pay', requireStaff('payouts'), (req, res) => {
  const rows = db.prepare('SELECT * FROM payouts WHERE batch_id = ?').all(req.params.batchId);
  if (!rows.length) return res.status(404).json({ error: '找不到此批報酬單' });
  const paid = rows.some(r => r.status !== 'paid');
  if (paid) {
    const blocked = confirmGate(rows, (req.body || {}).override);
    if (blocked) return res.status(400).json({ error: blocked, need_confirm: true });
  }
  db.prepare('UPDATE payouts SET status = ?, paid_at = ? WHERE batch_id = ?')
    .run(paid ? 'paid' : 'pending', paid ? today() : '', req.params.batchId);
  audit('staff', req.user.id, req.user.name, paid ? '報酬付款（整批）' : '取消報酬付款（整批）',
    String(rows[0].user_id), { batchId: req.params.batchId, count: rows.length });
  res.json({ ok: true, count: rows.length });
});

router.delete('/payouts/batch/:batchId', requireStaff('payouts'), (req, res) => {
  const rows = db.prepare('SELECT * FROM payouts WHERE batch_id = ?').all(req.params.batchId);
  if (!rows.length) return res.status(404).json({ error: '找不到此批報酬單' });
  if (rows.some(r => r.status === 'paid')) return res.status(400).json({ error: '已付款的報酬單不可刪除' });
  db.prepare('DELETE FROM payouts WHERE batch_id = ?').run(req.params.batchId);
  audit('staff', req.user.id, req.user.name, '刪除報酬單（整批）', String(rows[0].user_id),
    { batchId: req.params.batchId, count: rows.length });
  res.json({ ok: true, count: rows.length });
});

// ---- 勞務報酬單列印 ----
const RESIDENCY_OPTIONS = [
  ['local', '本國籍'],
  ['local_abroad', '本國籍但未在台居住'],
  ['foreign_183', '外國籍在台滿 183 天'],
  ['foreign_lt183', '外國籍在台未滿 183 天']
];

function rocDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return '';
  return `${Number(m[1]) - 1911} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}

function slipHtml(u, rows, opts) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = n => Number(n || 0).toLocaleString('en-US');
  const check = on => (on ? '■' : '□');
  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const dateCell = r => rocDate(r.pay_date) || `${esc(r.month)}（日期待填）`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(opts.title)}－${esc(u.name)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; color: #1c2b2b; font-size: 13px; }
  h1 { font-size: 20px; text-align: center; letter-spacing: 4px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 10px; }
  th, td { border: 1px solid #666; padding: 6px 8px; vertical-align: top; }
  th { background: #eef3f3; width: 110px; text-align: left; font-weight: 600; }
  .amt { text-align: right; }
  .money th { width: auto; text-align: center; background: #eef3f3; }
  .sign { margin-top: 22px; line-height: 2.4; }
  .note { margin-top: 10px; font-size: 11.5px; color: #667; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
<h1>${esc(opts.title)}</h1>
<table>
  <tr><th>單位名稱</th><td>${esc(opts.centerName)}</td><th>統一編號</th><td>${esc(opts.taxId)}</td></tr>
  <tr><th>單位地址</th><td colspan="3">${esc(opts.address)}</td></tr>
  <tr><th>姓名</th><td>${esc(u.name)}</td><th>填表日期</th><td>${esc(rocDate(opts.formDate))}</td></tr>
  <tr><th>身分別</th><td colspan="3">${RESIDENCY_OPTIONS.map(([k, label]) =>
    `${check((u.residency || 'local') === k)} ${label}`).join('　')}
    <div style="font-size:11.5px;color:#667">（天數以一年度為基準）</div></td></tr>
  <tr><th>聯絡電話</th><td>${esc(u.phone)}</td><th>身分證字號</th><td>${esc(u.id_no)}</td></tr>
  <tr><th>居留證／護照號碼</th><td>${esc(u.passport_no)}</td><th>所得類別</th><td>${esc(opts.incomeTypeLabel)}</td></tr>
  <tr><th>戶籍地址</th><td colspan="3">${esc(u.household_address)}</td></tr>
  <tr><th>通訊地址</th><td colspan="3">${u.mailing_address ? esc(u.mailing_address) : '■ 同戶籍地址'}</td></tr>
  <tr><th>勞務內容</th><td colspan="3">${esc(opts.service)}${opts.item ? `　（${esc(opts.item)}）` : ''}</td></tr>
</table>
<table class="money">
  <tr><th>領款金額</th><th>日期</th><th>支領金額</th><th>代扣所得稅</th><th>二代健保</th><th>支領淨額</th></tr>
  ${rows.map((r, i) => `<tr>
    <td class="amt">${i + 1}</td><td>${dateCell(r)}</td>
    <td class="amt">${money(r.gross)} 元</td><td class="amt">${money(r.withholding)}</td>
    <td class="amt">${money(r.nhi_supplement)}</td><td class="amt">${money(r.net)} 元</td></tr>`).join('')}
  <tr><td colspan="2"><strong>合計</strong></td>
    <td class="amt"><strong>${money(sum('gross'))} 元</strong></td>
    <td class="amt"><strong>${money(sum('withholding'))}</strong></td>
    <td class="amt"><strong>${money(sum('nhi_supplement'))}</strong></td>
    <td class="amt"><strong>${money(sum('net'))} 元</strong></td></tr>
</table>
<table>
  <tr><th>付款方式</th><td colspan="3">■ 匯款　　銀行：${esc(u.bank_name)}　　帳號：${esc(u.bank_account)}　　戶名：${esc(u.bank_holder || u.name)}</td></tr>
</table>
<div class="sign">上述資料經本人確認無誤，領款人：${opts.sign
    ? `<img src="${opts.sign}" alt="領款人簽名" style="height:52px;vertical-align:middle">`
      + `<br><span style="font-size:12px;color:#667">（本人於個案管理系統線上簽名確認　${esc(opts.signed_at)}）</span>`
    : '______________________（簽名）'}
  <br>經手人：${esc(opts.handler)}</div>
${opts.note ? `<div class="note">${esc(opts.note)}</div>` : ''}
<script>if (location.hash !== '#noprint') setTimeout(() => window.print(), 300);<\/script>
</body></html>`;
}

// 列印勞務報酬單：可指定一批拆單（batch）或自行勾選的數筆（ids），同一位領款人印成一張
router.get('/payouts/slip', requireStaff('payouts'), (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(n => Number(n)).filter(Boolean);
  const batch = String(req.query.batch || '');
  if (!ids.length && !batch) return res.status(400).send('請指定要列印的報酬單');
  const rows = batch
    ? db.prepare('SELECT * FROM payouts WHERE batch_id = ? ORDER BY batch_seq, id').all(batch)
    : db.prepare(`SELECT * FROM payouts WHERE id IN (${ids.map(() => '?').join(',')})
        ORDER BY pay_date, id`).all(...ids);
  if (!rows.length) return res.status(404).send('找不到報酬單');
  // 行政人員只能印自己的（與 /payouts 清單同一道限制）
  if (req.user.role === 'staff' && rows.some(r => r.user_id !== req.user.id)) {
    return res.status(403).send('無權檢視他人的報酬單');
  }
  if (new Set(rows.map(r => r.user_id)).size > 1) {
    return res.status(400).send('一次只能列印同一位領款人的報酬單');
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(rows[0].user_id);
  const label = { '9A': '執行業務所得（9A）', '9B': '稿費講演鐘點費（9B）', 50: '薪資所得（50）' };
  audit('staff', req.user.id, req.user.name, '列印勞務報酬單', u.name,
    { ids: rows.map(r => r.id), batch });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(slipHtml(u, rows, {
    centerName: getSetting('center_name', '織心心理治療所'),
    taxId: getSetting('center_tax_id', ''),
    address: getSetting('center_address', ''),
    title: getSetting('payout_slip_title', '勞務報酬單'),
    note: getSetting('payout_slip_note', ''),
    service: getSetting('payout_slip_service', '心理治療（55 心理師）'),
    handler: getSetting('payout_slip_handler', '') || req.user.name,
    incomeTypeLabel: label[rows[0].income_type] || rows[0].income_type,
    item: rows[0].item,
    // 該月的月結若已由本人線上簽名確認，就把簽名貼在領款人欄，不必再簽一次紙本
    ...(() => {
      const st = db.prepare("SELECT sign_image, confirmed_at FROM payout_months WHERE user_id = ? AND month = ? AND status = 'confirmed'")
        .get(rows[0].user_id, rows[0].month);
      return st && st.sign_image ? { sign: st.sign_image, signed_at: st.confirmed_at } : {};
    })(),
    formDate: today()
  }));
});

module.exports = router;
