const express = require('express');
const { db, audit, today, getSetting, addDays, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const { sendNotification } = require('../notify');
const { ensureToken, resetToken } = require('../ics');
const plans = require('../plans');
const line = require('../line');
const { endTime, defaultSessionMinutes } = plans;

const router = express.Router();

// 時段重疊判定：同一諮商師或同一諮商室在同日不得有時間交疊的有效預約
function conflictOf({ id, date, start_time, end_time, counselor_id, room_id, client_id }) {
  const args = [date, end_time, start_time];
  const rows = db.prepare(`SELECT a.*, c.name AS client_name, u.name AS counselor_name, r.name AS room_name
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN rooms r ON r.id = a.room_id
    WHERE a.date = ? AND a.status IN ('booked','arrived')
      AND a.start_time < ? AND a.end_time > ?`).all(...args);
  for (const r of rows) {
    if (id && r.id === Number(id)) continue;
    if (r.counselor_id === Number(counselor_id)) return { row: r, kind: '心理師' };
    if (room_id && r.room_id === Number(room_id)) return { row: r, kind: '諮商室' };
    // 同一位個案同時段被排兩筆（多半是重複建檔或櫃檯重按），個案分身乏術，一併擋下
    if (client_id && r.client_id === Number(client_id)) return { row: r, kind: '個案' };
  }
  return null;
}

// 日期與時間的基本檢查：格式錯、時間顛倒、年份打錯（2062 之類）都在這裡擋掉，
// 避免變成一筆永遠不會發生、卻一直佔著時段與額度的預約。
function checkDateTime({ date, start_time, end_time }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '日期格式有誤';
  if (!/^\d{2}:\d{2}$/.test(start_time || '')) return '時間格式有誤';
  if (Number.isNaN(new Date(date + 'T00:00:00').getTime())) return '日期不存在，請重新選擇';
  if (end_time && end_time <= start_time) return '結束時間需晚於開始時間';
  const min = addDays(today(), -365), max = addDays(today(), 730);
  if (date < min) return `日期 ${date} 早於一年前，請確認是否打錯年份`;
  if (date > max) return `日期 ${date} 超過兩年後，請確認是否打錯年份`;
  return '';
}

// 請假衝突：全天假擋整日，時段假只擋交疊的時間
function timeOffOf(counselorId, date, start, end) {
  return db.prepare(`SELECT * FROM time_off WHERE counselor_id = ? AND ? BETWEEN start_date AND end_date
      AND (all_day = 1 OR (start_time < ? AND end_time > ?))`)
    .get(Number(counselorId), date, end || '23:59', start || '00:00');
}

// 視訊連結：只收 http(s)，避免把 javascript: 之類的內容存進去後在前端被點開
function cleanMeetingUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('視訊連結請填完整網址（http:// 或 https:// 開頭）');
  if (url.length > 500) throw new Error('視訊連結過長');
  return url;
}


const LIST_SQL = `SELECT a.*, c.name AS client_name, c.code AS client_code, c.risk_level, c.phone AS client_phone,
    u.name AS counselor_name, r.name AS room_name, sp.name AS plan_name, pt.name AS topic_name,
    sp.register_url AS plan_register_url, sp.signin_url AS plan_signin_url,
    (SELECT COUNT(*) FROM session_notes n WHERE n.appointment_id = a.id) AS has_note
  FROM appointments a
  LEFT JOIN clients c ON c.id = a.client_id
  LEFT JOIN users u ON u.id = a.counselor_id
  LEFT JOIN rooms r ON r.id = a.room_id
  LEFT JOIN service_plans sp ON sp.id = a.plan_id
  LEFT JOIN plan_topics pt ON pt.id = a.topic_id`;

router.get('/appointments', requireStaff('schedule'), (req, res) => {
  const { date = '', from = '', to = '', counselor_id = '', client_id = '', status = '' } = req.query;
  const where = [], args = [];
  if (date) { where.push('a.date = ?'); args.push(date); }
  if (from) { where.push('a.date >= ?'); args.push(from); }
  if (to) { where.push('a.date <= ?'); args.push(to); }
  if (counselor_id) { where.push('a.counselor_id = ?'); args.push(Number(counselor_id)); }
  if (client_id) { where.push('a.client_id = ?'); args.push(Number(client_id)); }
  if (status) { where.push('a.status = ?'); args.push(status); }
  // 沒有任何條件時預設只回近三個月，避免一支網址就把全所的預約撈走
  if (!where.length) {
    where.push("a.date >= date('now','localtime','-3 months')");
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
  const sql = `${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY a.date, a.start_time LIMIT ?`;
  res.json(db.prepare(sql).all(...args, limit));
});

// 週檢視：回傳七天的預約，前端排成時間表
router.get('/schedule/week', requireStaff('schedule'), (req, res) => {
  const start = req.query.start || today();
  const end = addDays(start, 6);
  res.json({
    start, end,
    counselors: db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id").all(),
    rooms: db.prepare('SELECT id, name FROM rooms WHERE active = 1 ORDER BY id').all(),
    availability: db.prepare('SELECT * FROM availability WHERE start_time < end_time ORDER BY weekday, start_time').all(),
    time_off: db.prepare(`SELECT t.*, u.name AS counselor_name FROM time_off t JOIN users u ON u.id = t.counselor_id
      WHERE t.end_date >= ? AND t.start_date <= ?`).all(start, end),
    group_sessions: db.prepare(`SELECT s.*, g.name AS group_name, g.counselor_id, u.name AS counselor_name,
        r.name AS room_name,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS member_count
      FROM group_sessions s JOIN groups g ON g.id = s.group_id
      LEFT JOIN users u ON u.id = g.counselor_id LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.date BETWEEN ? AND ? AND s.status != 'cancelled' ORDER BY s.date, s.start_time`).all(start, end),
    appointments: db.prepare(`${LIST_SQL} WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_time`).all(start, end)
  });
});

router.post('/appointments', requireStaff('schedule'), async (req, res) => {
  const b = req.body || {};
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(Number(b.client_id) || 0);
  if (!client) return res.status(400).json({ error: '請選擇個案' });
  if (!b.counselor_id) return res.status(400).json({ error: '請選擇心理師' });
  if (!b.date || !b.start_time) return res.status(400).json({ error: '請填寫日期與時間' });
  const dtErr = checkDateTime({ date: b.date, start_time: b.start_time, end_time: b.end_time });
  if (dtErr) return res.status(400).json({ error: dtErr });
  // 方案可有自己的時長（40／50／80 分鐘），未指定結束時間時依方案推算
  const planMinutes = b.plan_id ? plans.resolveFee({ plan_id: b.plan_id }).session_minutes : 0;
  const end_time = b.end_time || endTime(b.start_time, planMinutes || defaultSessionMinutes());
  const hit = conflictOf({ ...b, end_time, client_id: client.id });
  if (hit) {
    return res.status(400).json({
      error: hit.kind === '個案'
        ? `${client.name} 在 ${hit.row.date} ${hit.row.start_time}-${hit.row.end_time} 已有另一筆預約（${hit.row.counselor_name || ''}），請確認是否重複`
        : `${hit.kind}時段衝突：${hit.row.date} ${hit.row.start_time}-${hit.row.end_time} 已有預約`
    });
  }
  const off = timeOffOf(b.counselor_id, b.date, b.start_time, end_time);
  if (off) return res.status(400).json({ error: `該心理師於 ${off.start_date}~${off.end_date} 請假（${off.reason || '不可預約'}）` });
  let meeting_url;
  try { meeting_url = cleanMeetingUrl(b.meeting_url); } catch (e) { return res.status(400).json({ error: e.message }); }
  // 視訊晤談未指定連結時，帶入該心理師的固定會議室（帳號設定），省去每次貼上；
  // 非視訊則不留連結，避免形式與連結不一致
  if ((b.mode || 'onsite') === 'online') {
    if (!meeting_url) {
      const u = db.prepare('SELECT meeting_room_url FROM users WHERE id = ?').get(Number(b.counselor_id));
      meeting_url = (u && u.meeting_room_url) || '';
    }
  } else {
    meeting_url = '';
  }
  // 方案別決定金額、補助拆帳與心理師報酬；沒帶方案時維持原本的預設收費
  const quote = plans.resolveFee({
    plan_id: b.plan_id, topic_id: b.topic_id, counselor_id: b.counselor_id,
    fee_choice: b.fee_choice,
    fee_override: b.fee !== undefined && b.fee !== '' ? b.fee : undefined,
    client_id: b.client_id                   // 指定／派案決定抽成用哪一組比例
  });
  // fee 存「個案要付的錢」；方案給付的部分另存 subsidy_amount，兩者相加才是總額
  const fee = b.plan_id || (b.fee !== undefined && b.fee !== '')
    ? quote.fee
    : Number(getSetting(b.type === 'intake' ? 'intake_fee' : 'default_fee', '2000'));

  // 方案額度：個案年度次數與心理師每週／每月人次上限。
  // 超額預設擋下（可由設定改為僅警示），櫃檯確認要排時可帶 override 放行並留稽核。
  const check = plans.checkBooking({
    plan_id: b.plan_id, client, counselor_id: b.counselor_id, date: b.date
  });
  if (check.errors.length && !b.override && getSetting('plan_quota_enforce', '1') === '1') {
    return res.status(400).json({
      error: check.errors.join('；'), errors: check.errors,
      next_week: check.next_week, usage: check.usage, load: check.load, can_override: true
    });
  }

  // 諮商室：櫃檯可指定，未指定則自動挑一間空的（個案端不顯示空間配置）。
  // 視訊晤談不在所內進行，一律不佔空間，否則諮商室使用表會被視訊塞滿看不出真正的空檔。
  const roomId = b.mode === 'online'
    ? null
    : (Number(b.room_id) || plans.pickRoom({ date: b.date, start_time: b.start_time, end_time }));

  const info = db.prepare(`INSERT INTO appointments
    (client_id, counselor_id, room_id, date, start_time, end_time, type, mode, status, fee, subsidy_amount, package_id,
     plan_id, topic_id, counselor_share, source, note, meeting_url, created_by)
    VALUES (?,?,?,?,?,?,?,?,'booked',?,?,?,?,?,?,?,?,?,?)`).run(
    client.id, Number(b.counselor_id), roomId, b.date, b.start_time, end_time,
    b.type || (quote.plan ? quote.plan.appt_type : 'individual'), b.mode || 'onsite',
    fee, quote.subsidy_amount, Number(b.package_id) || null,
    Number(b.plan_id) || null, Number(b.topic_id) || null, quote.counselor_share,
    b.source || 'staff', b.note || '', meeting_url, req.user.id);
  audit('staff', req.user.id, req.user.name, '新增預約', client.code,
    { date: b.date, time: b.start_time, plan_id: b.plan_id || null, override: !!b.override });
  // 全所只有 2-3 間，排滿時要講清楚，不要靜悄悄留一筆沒有空間的預約
  const warnings = [...check.warnings];
  if (!roomId && b.mode !== 'online') warnings.push('此時段所有諮商室都已排滿，這筆預約尚未指定空間，請確認場地安排');
  // 櫃檯直接排約也要推「預約已成立」給個案（原本只有線上申請確認時才推），
  // 否則同一件事在 LINE 上有沒有通知，取決於這筆預約是從哪個入口進來的。
  let notify = null;
  if (client.line_user_id) {
    const quotePlan = quote.plan;
    notify = await line.pushFlex({
      to: client.line_user_id, kind: 'booking_confirm', client_id: client.id,
      appointment_id: info.lastInsertRowid, user: req.user,
      flex: line.bookingConfirmedFlex({
        date: b.date, start_time: b.start_time, end_time,
        counselor_name: (db.prepare('SELECT name FROM users WHERE id = ?').get(Number(b.counselor_id)) || {}).name || '',
        plan_name: quotePlan ? quotePlan.name : '', topic_name: quote.topic ? quote.topic.name : '',
        mode: b.mode || 'onsite', fee, self_pay: quote.self_pay, subsidy_amount: quote.subsidy_amount,
        meeting_url
      })
    });
  }
  res.json({ id: info.lastInsertRowid, room_id: roomId, warnings, usage: check.usage, notify });
});

router.put('/appointments/:id', requireStaff('schedule'), (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  if (a.status === 'done') return res.status(400).json({ error: '已完成的晤談不可修改，請改用取消或新增紀錄' });
  const b = { ...a, ...req.body };
  // 改時間或改方案時要重算結束時間：方案各有自己的時長（40／50／80 分鐘），
  // 原本一律用系統預設 50 分，導致把預約改成 80 分鐘的伴侶方案後仍顯示 20:00-20:50。
  // 只在時間或方案真的變動時重算，避免蓋掉刻意手動調整過的時長。
  const planChanged = req.body.plan_id !== undefined
    && (Number(req.body.plan_id) || 0) !== (Number(a.plan_id) || 0);
  if (!req.body.end_time && (req.body.start_time || planChanged)) {
    const planMinutes = b.plan_id ? plans.resolveFee({ plan_id: b.plan_id }).session_minutes : 0;
    b.end_time = endTime(b.start_time, planMinutes || defaultSessionMinutes());
  }
  const dtErr = checkDateTime({ date: b.date, start_time: b.start_time, end_time: b.end_time });
  if (dtErr) return res.status(400).json({ error: dtErr });
  const hit = conflictOf({ ...b, id: a.id, client_id: a.client_id });
  if (hit) {
    return res.status(400).json({
      error: hit.kind === '個案'
        ? `這位個案在 ${hit.row.date} ${hit.row.start_time}-${hit.row.end_time} 已有另一筆預約，請確認是否重複`
        : `${hit.kind}時段衝突：${hit.row.start_time}-${hit.row.end_time} 已有預約`
    });
  }
  let meeting_url;
  try { meeting_url = cleanMeetingUrl(b.meeting_url); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (b.mode === 'online') {
    if (!meeting_url) {
      const u = db.prepare('SELECT meeting_room_url FROM users WHERE id = ?').get(Number(b.counselor_id));
      meeting_url = (u && u.meeting_room_url) || '';
    }
  } else {
    // 改回到所（或其他形式）時一併清掉連結，避免留著失效的舊會議室
    meeting_url = '';
  }
  // 改方案／改主題／改心理師都會影響金額與報酬，一律重算一次
  const quote = plans.resolveFee({
    plan_id: b.plan_id, topic_id: b.topic_id, counselor_id: b.counselor_id,
    fee_choice: b.fee_choice,
    fee_override: req.body.fee !== undefined && req.body.fee !== '' ? req.body.fee : (b.plan_id ? undefined : b.fee),
    client_id: b.client_id || a.client_id
  });
  const check = plans.checkBooking({
    plan_id: b.plan_id, client: db.prepare('SELECT * FROM clients WHERE id = ?').get(a.client_id),
    counselor_id: b.counselor_id, date: b.date, appointment_id: a.id
  });
  if (check.errors.length && !req.body.override && getSetting('plan_quota_enforce', '1') === '1') {
    return res.status(400).json({ error: check.errors.join('；'), errors: check.errors,
      next_week: check.next_week, can_override: true });
  }
  // 改成視訊就把空間退掉，改回到所才重新指派
  const roomId = b.mode === 'online' ? null : (Number(b.room_id)
    || plans.pickRoom({ date: b.date, start_time: b.start_time, end_time: b.end_time, exclude_appointment_id: a.id }));
  db.prepare(`UPDATE appointments SET counselor_id = ?, room_id = ?, date = ?, start_time = ?, end_time = ?,
    type = ?, mode = ?, fee = ?, subsidy_amount = ?, plan_id = ?, topic_id = ?, counselor_share = ?,
    note = ?, meeting_url = ? WHERE id = ?`).run(
    Number(b.counselor_id), roomId, b.date, b.start_time, b.end_time,
    b.type, b.mode, quote.fee, quote.subsidy_amount, Number(b.plan_id) || null, Number(b.topic_id) || null,
    quote.counselor_share, b.note || '', meeting_url, a.id);
  audit('staff', req.user.id, req.user.name, '修改預約', String(a.id));
  res.json({ ok: true });
});

// 狀態異動：報到 / 完成 / 取消 / 未到
router.post('/appointments/:id/status', requireStaff('schedule'), (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  const { status, cancel_reason = '' } = req.body || {};
  if (!['booked', 'arrived', 'done', 'cancelled', 'no_show'].includes(status)) {
    return res.status(400).json({ error: '狀態不正確' });
  }
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(a.client_id);
  const willCharge = status === 'done' || status === 'no_show';
  const warnings = [];

  // 回復先前因「完成／未到」產生的費用：退回方案次數、刪除尚未收款的自動收費單。
  // 已收款者不動（收款是實際發生的事實），改以警示提醒人工處理退費。
  const reverseCharge = () => {
    if (!a.charged) return;
    if (a.package_id) {
      db.prepare('UPDATE packages SET sessions_used = MAX(sessions_used - 1, 0) WHERE id = ?').run(a.package_id);
      db.prepare(`UPDATE packages SET status = 'active'
        WHERE id = ? AND status = 'used_up' AND sessions_used < sessions_total`).run(a.package_id);
    }
    const autos = db.prepare("SELECT * FROM invoices WHERE appointment_id = ? AND status != 'void'").all(a.id);
    for (const inv of autos) {
      // 已收款或已退費的單都動不得（都代表金流已經發生過），只出警示請人工處理
      if (inv.status === 'paid' || inv.status === 'refunded') {
        warnings.push(inv.status === 'refunded'
          ? `此預約的收費單已辦理退費（${inv.amount} 元），狀態異動不會更動該筆帳，請確認金流是否需再處理`
          : `此預約已有收款紀錄（收據 ${inv.receipt_no || inv.id}，${inv.amount} 元），請另行辦理退費或作廢`);
      } else {
        db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
      }
    }
  };

  const applyCharge = () => {
    if (status === 'done') {
      if (a.package_id) {
        // 由方案扣次；扣完自動標記用畢
        db.prepare('UPDATE packages SET sessions_used = sessions_used + 1 WHERE id = ?').run(a.package_id);
        db.prepare(`UPDATE packages SET status = 'used_up' WHERE id = ? AND sessions_used >= sessions_total`).run(a.package_id);
      } else if (a.fee > 0 || a.subsidy_amount > 0) {
        // 收費單只跟個案收「他要付的錢」（補助方案就是場地費），
        // 由方案給付的部分另記在 subsidy_amount 供核銷，不會讓個案看到一張 1800 的帳單
        const q = plans.resolveFee({ plan_id: a.plan_id, topic_id: a.topic_id,
          counselor_id: a.counselor_id, fee_override: a.fee, client_id: a.client_id });
        db.prepare(`INSERT INTO invoices (client_id, appointment_id, date, item, amount, status, payer,
            plan_id, topic_id, subsidy_program, subsidy_amount, self_pay)
                    VALUES (?,?,?,?,?, 'unpaid', ?,?,?,?,?,?)`).run(
          a.client_id, a.id, a.date,
          `${a.date} ${q.plan ? q.plan.name : '晤談費用'}${a.subsidy_amount ? '（自付場地費）' : ''}`, a.fee,
          q.plan && q.plan.kind === 'subsidy'
            ? getSetting('payer_type_default', '自費').replace(/^自費$/, '心理健康支持方案')
            : getSetting('payer_type_default', '自費'),
          a.plan_id || null, a.topic_id || null, q.subsidy_program, a.subsidy_amount || 0, a.fee);
        // 心理師報酬在結案當下鎖定，日後改方案費率不會回頭改動已結算的月份
        if (!a.counselor_share) {
          db.prepare('UPDATE appointments SET counselor_share = ? WHERE id = ?').run(q.counselor_share, a.id);
        }
      }
      // 初談完成後個案由 intake 轉為進行中
      if (client && client.status === 'intake') db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client.id);
    }
    // 未到：依設定收取固定行政規費或原費用的比例
    if (status === 'no_show') {
      const charge = plans.noShowCharge(a.fee);
      if (charge.amount > 0) {
        db.prepare(`INSERT INTO invoices (client_id, appointment_id, date, item, amount, status, payer, note)
                    VALUES (?,?,?,?,?, 'unpaid', ?, ?)`).run(
          a.client_id, a.id, a.date, `${a.date} 未到收費`, charge.amount,
          getSetting('payer_type_default', '自費'), charge.note);
      }
    }
  };

  const tx = db.transaction(() => {
    db.prepare('UPDATE appointments SET status = ?, cancel_reason = ? WHERE id = ?').run(status, cancel_reason, a.id);
    // 先全部回沖再依新狀態重算，狀態任意來回切換都不會重複計費或漏退次數
    if (a.charged) reverseCharge();
    if (willCharge) applyCharge();
    db.prepare('UPDATE appointments SET charged = ? WHERE id = ?').run(willCharge ? 1 : 0, a.id);
  });
  tx();
  audit('staff', req.user.id, req.user.name, '預約狀態異動', client ? client.code : String(a.id), { status });
  // 取消／未到會把時段空出來，順手回報候補名單中可遞補的人選，讓櫃檯當下就能通知
  const opening = (status === 'cancelled' || status === 'no_show') && a.date >= today()
    ? { date: a.date, start_time: a.start_time, end_time: a.end_time, counselor_id: a.counselor_id,
      candidates: matchWaitlist(a.counselor_id, a.date, a.start_time) }
    : null;
  res.json({ ok: true, warnings, opening });
});

router.delete('/appointments/:id', requireStaff('schedule'), (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  if (a.status === 'done') return res.status(400).json({ error: '已完成的晤談不可刪除' });
  if (db.prepare('SELECT 1 FROM session_notes WHERE appointment_id = ?').get(a.id)) {
    return res.status(400).json({ error: '此預約已有晤談紀錄，不可刪除' });
  }
  db.prepare('DELETE FROM appointments WHERE id = ?').run(a.id);
  audit('staff', req.user.id, req.user.name, '刪除預約', String(a.id));
  const opening = a.date >= today()
    ? { date: a.date, start_time: a.start_time, end_time: a.end_time, counselor_id: a.counselor_id,
      candidates: matchWaitlist(a.counselor_id, a.date, a.start_time) }
    : null;
  res.json({ ok: true, opening });
});

// ---- 諮商室 ----
router.get('/rooms', requireStaff(), (req, res) => {
  res.json(db.prepare('SELECT * FROM rooms ORDER BY active DESC, id').all());
});
// 空間使用狀況：全所只有 2-3 間，櫃檯要能一眼看出某天哪間還空著。
// 晤談與團體場次都算占用；個案端與線上表單一律看不到這份資料。
router.get('/rooms/usage', requireStaff('schedule'), (req, res) => {
  const date = req.query.date || today();
  const rooms = db.prepare('SELECT id, name, capacity, note FROM rooms WHERE active = 1 ORDER BY id').all();
  const appts = db.prepare(`SELECT a.room_id, a.start_time, a.end_time, a.status, a.mode,
      c.name AS client_name, c.code AS client_code, u.name AS counselor_name,
      p.name AS plan_name, p.kind AS plan_kind
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    WHERE a.date = ? AND a.status IN ('booked','arrived','done') ORDER BY a.start_time`).all(date);
  const sessions = db.prepare(`SELECT s.room_id, s.start_time, s.end_time, g.name AS group_name,
      u.name AS counselor_name
    FROM group_sessions s JOIN groups g ON g.id = s.group_id
    LEFT JOIN users u ON u.id = g.counselor_id
    WHERE s.date = ? AND s.status != 'cancelled' ORDER BY s.start_time`).all(date);
  res.json({
    date,
    rooms: rooms.map(r => ({
      ...r,
      bookings: [
        ...appts.filter(a => a.room_id === r.id).map(a => ({
          start_time: a.start_time, end_time: a.end_time, kind: 'appointment',
          title: `${a.client_code} ${a.client_name}`, counselor_name: a.counselor_name, status: a.status
        })),
        ...sessions.filter(s => s.room_id === r.id).map(s => ({
          start_time: s.start_time, end_time: s.end_time, kind: 'group',
          title: s.group_name, counselor_name: s.counselor_name, status: 'booked'
        }))
      ].sort((x, y) => x.start_time.localeCompare(y.start_time))
    })),
    // 已排入但還沒指定空間的晤談：到所形式卻沒有房間，櫃檯要補指定
    unassigned: appts.filter(a => !a.room_id && a.mode !== 'online').map(a => ({
      start_time: a.start_time, end_time: a.end_time,
      title: `${a.client_code} ${a.client_name}`, counselor_name: a.counselor_name
    }))
  });
});

router.post('/rooms', requireStaff('settings'), (req, res) => {
  const { name = '', capacity = 1, note = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: '請填寫名稱' });
  const info = db.prepare('INSERT INTO rooms (name, capacity, note) VALUES (?,?,?)').run(name, Number(capacity) || 1, note);
  res.json({ id: info.lastInsertRowid });
});
router.put('/rooms/:id', requireStaff('settings'), (req, res) => {
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此諮商室' });
  const { name = r.name, capacity = r.capacity, note = r.note, active = r.active } = req.body || {};
  db.prepare('UPDATE rooms SET name = ?, capacity = ?, note = ?, active = ? WHERE id = ?')
    .run(name, Number(capacity) || 1, note, active ? 1 : 0, r.id);
  res.json({ ok: true });
});

// 諮商室使用表：空間 × 星期 × 時段的週檢視，比照所內原本用的 Google 試算表。
// 每格標明「個案」與「使用心理師」，櫃檯一眼看出哪間空著、誰在用。
router.get('/rooms/week', requireStaff('schedule'), (req, res) => {
  const start = req.query.start || today();
  const end = addDays(start, 6);
  const rooms = db.prepare('SELECT id, name, capacity, note FROM rooms WHERE active = 1 ORDER BY id').all();
  const appts = db.prepare(`SELECT a.id, a.room_id, a.date, a.start_time, a.end_time, a.status, a.mode, a.type,
      c.name AS client_name, c.code AS client_code, u.name AS counselor_name,
      p.name AS plan_name, p.kind AS plan_kind
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    WHERE a.date BETWEEN ? AND ? AND a.status IN ('booked','arrived','done')
    ORDER BY a.date, a.start_time`).all(start, end);
  const sessions = db.prepare(`SELECT s.id, s.room_id, s.date, s.start_time, s.end_time,
      g.name AS group_name, u.name AS counselor_name,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS member_count
    FROM group_sessions s JOIN groups g ON g.id = s.group_id
    LEFT JOIN users u ON u.id = g.counselor_id
    WHERE s.date BETWEEN ? AND ? AND s.status != 'cancelled'
    ORDER BY s.date, s.start_time`).all(start, end);
  res.json({
    start, end,
    // 表格格線沿用排班表的設定，各所作息不同
    grid: {
      start: getSetting('shift_start', '09:00'),
      end: getSetting('shift_end', '21:00'),
      step: Number(getSetting('shift_step', '30'))
    },
    rooms,
    items: [
      ...appts.map(a => ({
        kind: 'appointment', id: a.id, room_id: a.room_id, date: a.date,
        start_time: a.start_time, end_time: a.end_time, status: a.status, mode: a.mode,
        client: `${a.client_code} ${a.client_name}`, counselor: a.counselor_name || '',
        plan: a.plan_name || '', plan_kind: a.plan_kind || ''
      })),
      ...sessions.map(s => ({
        kind: 'group', room_id: s.room_id, date: s.date,
        start_time: s.start_time, end_time: s.end_time, status: 'booked', mode: 'onsite',
        client: `${s.group_name}（團體 ${s.member_count} 人）`, counselor: s.counselor_name || ''
      }))
    ],
    // 到所卻沒指定空間的晤談：這張表上看不到，另外列出來提醒補指定
    unassigned: appts.filter(a => !a.room_id && a.mode !== 'online').map(a => ({
      // 帶上 id，畫面上那條提醒才能點一下直接開該筆預約去補指定空間
      id: a.id, date: a.date, start_time: a.start_time,
      client: `${a.client_code} ${a.client_name}`, counselor: a.counselor_name || ''
    }))
  });
});

// 刪除諮商室：已被排過的空間不真的刪掉（歷史紀錄要留），改為停用
router.delete('/rooms/:id', requireStaff('settings'), (req, res) => {
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此諮商室' });
  const used = db.prepare('SELECT COUNT(*) n FROM appointments WHERE room_id = ?').get(r.id).n
    + db.prepare('SELECT COUNT(*) n FROM group_sessions WHERE room_id = ?').get(r.id).n;
  if (used) {
    db.prepare('UPDATE rooms SET active = 0 WHERE id = ?').run(r.id);
    audit('staff', req.user.id, req.user.name, '停用諮商室', r.name);
    return res.json({ ok: true, deactivated: true, used });
  }
  try {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(r.id);
  } catch (e) {
    // 還有其他表引用這間空間時退回停用，不讓使用者看到資料庫錯誤
    db.prepare('UPDATE rooms SET active = 0 WHERE id = ?').run(r.id);
    audit('staff', req.user.id, req.user.name, '停用諮商室（尚有關聯資料）', r.name);
    return res.json({ ok: true, deactivated: true, used: 0 });
  }
  audit('staff', req.user.id, req.user.name, '刪除諮商室', r.name);
  res.json({ ok: true, deactivated: false });
});

// ---- 心理師可預約時段 ----
// 同一天內重疊或相接的時段合併成一段再存。
// 不合併的話，重疊區間會在 freeSlots 產生「同一個時間出現兩次」的重複時段。
function mergeRanges(blocks) {
  const byDay = new Map();
  for (const b of blocks) {
    const wd = Number(b.weekday);
    if (!byDay.has(wd)) byDay.set(wd, []);
    byDay.get(wd).push({ start_time: b.start_time, end_time: b.end_time, note: b.note || '' });
  }
  const out = [];
  for (const [wd, list] of byDay) {
    list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    let cur = null;
    for (const r of list) {
      if (cur && r.start_time <= cur.end_time) {
        // 重疊或相接：延長現有區段，備註保留先出現的那筆
        if (r.end_time > cur.end_time) cur.end_time = r.end_time;
        if (!cur.note && r.note) cur.note = r.note;
      } else {
        cur = { weekday: wd, start_time: r.start_time, end_time: r.end_time, note: r.note };
        out.push(cur);
      }
    }
  }
  return out.sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
}
// 排班有兩層：week_start 為空的是「每週固定班」，填了週一日期的是「該週專用班」。
// 某位心理師某一週只要有專用班，那一週就整週以專用班為準（含「那週完全不排」的情形，
// 用一筆 00:00-00:00 的佔位資料表示，否則刪光後會被誤認為沒設定而回頭沿用固定班）。
const PLACEHOLDER = { start_time: '00:00', end_time: '00:00' };
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hasWeekPlan(counselorId, weekStart) {
  return !!db.prepare('SELECT 1 FROM availability WHERE counselor_id = ? AND week_start = ? LIMIT 1')
    .get(Number(counselorId), weekStart);
}
// 某位心理師在某一天實際適用的時段（已解析固定班／該週專用班）
function availabilityOn(counselorId, dateStr) {
  const weekStart = mondayOf(dateStr);
  const weekday = new Date(dateStr + 'T00:00:00').getDay();
  const scope = hasWeekPlan(counselorId, weekStart) ? weekStart : '';
  return db.prepare(`SELECT * FROM availability WHERE counselor_id = ? AND week_start = ? AND weekday = ?
    AND start_time < end_time ORDER BY start_time`).all(Number(counselorId), scope, weekday);
}

router.get('/availability', requireStaff('schedule'), (req, res) => {
  const { counselor_id = '', week_start = '' } = req.query;
  // week_start 帶入某週的週一時，回該週實際適用的班表；沒有專用班就回固定班
  const scope = week_start ? (hasWeekPlan(counselor_id, mondayOf(week_start)) ? mondayOf(week_start) : '') : '';
  const sql = `SELECT av.*, u.name AS counselor_name FROM availability av JOIN users u ON u.id = av.counselor_id
    WHERE av.week_start = ? AND av.start_time < av.end_time
    ${counselor_id ? 'AND av.counselor_id = ?' : ''} ORDER BY av.counselor_id, av.weekday, av.start_time`;
  const rows = counselor_id
    ? db.prepare(sql).all(scope, Number(counselor_id))
    : db.prepare(sql).all(scope);
  res.set('X-Availability-Scope', scope || 'fixed');
  res.json(rows);
});
// 這一週是沿用固定班還是有自己的班表（畫面上要顯示狀態）
router.get('/availability/week-info', requireStaff('schedule'), (req, res) => {
  const cid = Number(req.query.counselor_id) || req.user.id;
  const weekStart = mondayOf(req.query.week_start || today());
  res.json({ counselor_id: cid, week_start: weekStart, custom: hasWeekPlan(cid, weekStart) });
});
// 取消某週的專用班，改回沿用固定班
router.delete('/availability/week', requireStaff('schedule'), (req, res) => {
  const cid = Number(req.query.counselor_id) || req.user.id;
  if (req.user.role !== 'admin' && cid !== req.user.id) {
    return res.status(403).json({ error: '僅能設定自己的可預約時段' });
  }
  const weekStart = mondayOf(req.query.week_start || today());
  const r = db.prepare('DELETE FROM availability WHERE counselor_id = ? AND week_start = ?').run(cid, weekStart);
  audit('staff', req.user.id, req.user.name, '取消單週排班', String(cid), { week_start: weekStart });
  res.json({ ok: true, removed: r.changes });
});
router.post('/availability', requireStaff('schedule'), (req, res) => {
  const { counselor_id, weekday, start_time, end_time, note = '' } = req.body || {};
  if (!counselor_id || weekday === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: '請填寫心理師、星期與時段' });
  }
  // 非管理者只能設定自己的時段
  if (req.user.role !== 'admin' && Number(counselor_id) !== req.user.id) {
    return res.status(403).json({ error: '僅能設定自己的可預約時段' });
  }
  if (end_time <= start_time) return res.status(400).json({ error: '結束時間需晚於開始時間' });
  const cid = Number(counselor_id);
  const wd = Number(weekday);
  const scope = req.body.week_start ? mondayOf(req.body.week_start) : '';
  const same = db.prepare(`SELECT * FROM availability WHERE counselor_id = ? AND weekday = ? AND week_start = ?
    AND start_time < end_time`).all(cid, wd, scope);
  const merged = mergeRanges(same.concat([{ weekday: wd, start_time, end_time, note }]));
  const write = db.transaction(() => {
    db.prepare('DELETE FROM availability WHERE counselor_id = ? AND weekday = ? AND week_start = ?').run(cid, wd, scope);
    const ins = db.prepare('INSERT INTO availability (counselor_id, weekday, start_time, end_time, note, week_start) VALUES (?,?,?,?,?,?)');
    for (const v of merged) ins.run(cid, v.weekday, v.start_time, v.end_time, v.note || '', scope);
  });
  write();
  res.json({ ok: true, count: merged.length });
});
router.delete('/availability/:id', requireStaff('schedule'), (req, res) => {
  const a = db.prepare('SELECT * FROM availability WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此時段' });
  if (req.user.role !== 'admin' && a.counselor_id !== req.user.id) {
    return res.status(403).json({ error: '僅能刪除自己的可預約時段' });
  }
  db.prepare('DELETE FROM availability WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// 整週排班一次覆寫：心理師在排班表上點選格子後整批送出，
// 逐格新增太瑣碎，故以「先刪後寫」的方式替換該心理師的整份可預約時段。
router.post('/availability/bulk', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const cid = Number(b.counselor_id) || req.user.id;
  if (req.user.role !== 'admin' && cid !== req.user.id) {
    return res.status(403).json({ error: '僅能設定自己的可預約時段' });
  }
  const blocks = Array.isArray(b.blocks) ? b.blocks : [];
  for (const v of blocks) {
    const wd = Number(v.weekday);
    if (!(wd >= 0 && wd <= 6)) return res.status(400).json({ error: '星期格式有誤' });
    if (!/^\d{2}:\d{2}$/.test(v.start_time || '') || !/^\d{2}:\d{2}$/.test(v.end_time || '')) {
      return res.status(400).json({ error: '時間格式有誤' });
    }
    if (v.end_time <= v.start_time) return res.status(400).json({ error: '結束時間需晚於開始時間' });
  }
  const scope = b.week_start ? mondayOf(b.week_start) : '';
  const merged = mergeRanges(blocks);
  const write = db.transaction(() => {
    db.prepare('DELETE FROM availability WHERE counselor_id = ? AND week_start = ?').run(cid, scope);
    const ins = db.prepare('INSERT INTO availability (counselor_id, weekday, start_time, end_time, note, week_start) VALUES (?,?,?,?,?,?)');
    for (const v of merged) ins.run(cid, v.weekday, v.start_time, v.end_time, v.note || '', scope);
    // 單週排成「完全不開放」時留一筆佔位，否則會被當成沒設定而沿用固定班
    if (scope && !merged.length) ins.run(cid, 0, PLACEHOLDER.start_time, PLACEHOLDER.end_time, '整週不開放', scope);
  });
  write();
  audit('staff', req.user.id, req.user.name, scope ? `更新 ${scope} 當週排班` : '更新固定班表',
    String(cid), { blocks: merged.length });
  res.json({ ok: true, count: merged.length });
});

// 行事曆：任意日期區間的預約、團體場次、請假與可預約時段，前端排成月曆／日檢視
router.get('/schedule/calendar', requireStaff('schedule'), (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || addDays(from, 30);
  const cid = Number(req.query.counselor_id) || 0;
  const only = (sql, extra) => (cid ? `${sql} AND ${extra}` : sql);
  res.json({
    from, to, counselor_id: cid || '',
    counselors: db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id").all(),
    // 帶上 week_start，前端依「該週有專用班就用專用班」自行解析
    availability: cid
      ? db.prepare(`SELECT * FROM availability WHERE counselor_id = ? AND start_time < end_time
          ORDER BY weekday, start_time`).all(cid)
      : db.prepare('SELECT * FROM availability WHERE start_time < end_time ORDER BY weekday, start_time').all(),
    time_off: db.prepare(only(`SELECT t.*, u.name AS counselor_name FROM time_off t JOIN users u ON u.id = t.counselor_id
      WHERE t.end_date >= ? AND t.start_date <= ?`, 't.counselor_id = ' + cid)).all(from, to),
    group_sessions: db.prepare(only(`SELECT s.*, g.name AS group_name, g.counselor_id, u.name AS counselor_name, r.name AS room_name
      FROM group_sessions s JOIN groups g ON g.id = s.group_id
      LEFT JOIN users u ON u.id = g.counselor_id LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.date BETWEEN ? AND ? AND s.status != 'cancelled'`, '(g.counselor_id = ' + cid + ' OR g.co_counselor_id = ' + cid + ')'))
      .all(from, to),
    appointments: db.prepare(only(`${LIST_SQL} WHERE a.date BETWEEN ? AND ?`, 'a.counselor_id = ' + cid) + ' ORDER BY a.date, a.start_time')
      .all(from, to)
  });
});

// 指定心理師某日的可預約時段（扣掉已被預約的），個案端與櫃檯共用
// minutesOverride：方案有自己的時長（如 40 分鐘的大學生方案、80 分鐘的伴侶諮商）時帶入，
// 未帶則沿用系統預設的晤談長度。
function freeSlots(counselorId, date, minutesOverride) {
  const minutes = Number(minutesOverride) || defaultSessionMinutes();
  const ranges = availabilityOn(counselorId, date);
  const booked = db.prepare(`SELECT start_time, end_time FROM appointments
    WHERE counselor_id = ? AND date = ? AND status IN ('booked','arrived')`).all(counselorId, date);
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmt = v => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  // 請假與團體帶領時段一併排除
  const offs = db.prepare(`SELECT all_day, start_time, end_time FROM time_off
    WHERE counselor_id = ? AND ? BETWEEN start_date AND end_date`).all(counselorId, date);
  if (offs.some(o => o.all_day)) return [];
  const busy = booked.concat(
    offs.map(o => ({ start_time: o.start_time, end_time: o.end_time })),
    db.prepare(`SELECT s.start_time, s.end_time FROM group_sessions s JOIN groups g ON g.id = s.group_id
      WHERE s.date = ? AND s.status != 'cancelled' AND (g.counselor_id = ? OR g.co_counselor_id = ?)`)
      .all(date, counselorId, counselorId));
  // 時段起點以「系統設定的時段間隔」為刻度（預設 30 分，即整點與半點），
  // 而不是從排班起點一節接一節往後推——否則 80 分鐘的方案會排出 14:20、15:40 這種怪時間。
  const step = Math.max(5, Number(getSetting('booking_slot_step', '30')) || 30);
  const out = [];
  for (const r of ranges) {
    const rs = toMin(r.start_time), re = toMin(r.end_time);
    for (let s = Math.max(Math.ceil(rs / step) * step, rs); s + minutes <= re; s += step) {
      const e = s + minutes;
      if (busy.some(b => b.start_time && s < toMin(b.end_time) && e > toMin(b.start_time))) continue;
      // 舊資料若仍有重疊時段，這裡再去一次重，確保同一開始時間只出現一次
      if (out.some(o => o.start_time === fmt(s))) continue;
      out.push({ start_time: fmt(s), end_time: fmt(e) });
    }
  }
  return out.sort((a, b) => a.start_time.localeCompare(b.start_time));
}
router.get('/slots', requireStaff('schedule'), (req, res) => {
  const { counselor_id, date } = req.query;
  if (!counselor_id || !date) return res.status(400).json({ error: '請指定心理師與日期' });
  res.json(freeSlots(Number(counselor_id), date));
});

// ---- 行事曆訂閱網址 ----
// 訂閱網址等同一把免登入的鑰匙，因此只能取得自己的，且可隨時重設讓舊網址失效。
function calendarUrl(req, token) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/calendar/${token}/mindcare.ics`;
}
router.get('/my/calendar-url', requireStaff(), (req, res) => {
  const token = ensureToken(req.user.id);
  res.json({ url: calendarUrl(req, token) });
});
router.post('/my/calendar-url/reset', requireStaff(), (req, res) => {
  const token = resetToken(req.user.id);
  audit('staff', req.user.id, req.user.name, '重設行事曆訂閱網址', String(req.user.id));
  res.json({ url: calendarUrl(req, token) });
});

// ---- 候補遞補 ----
// 取消釋出的時段最容易空掉。這裡把候補名單（來電登記中 new／waiting 的案件）
// 依「指定心理師 → 緊急度 → 等候天數 → 希望時段是否吻合」排序，讓櫃檯一眼看到該通知誰。

const PERIODS = [
  { key: '上午', from: '00:00', to: '12:00' },
  { key: '下午', from: '12:00', to: '18:00' },
  { key: '晚上', from: '18:00', to: '23:59' }
];
function periodOf(start) {
  const p = PERIODS.find(x => start >= x.from && start < x.to);
  return p ? p.key : '';
}
// 希望時段是自由文字（如「平日晚上、週六上午」），只做寬鬆比對當加分用，不當硬性條件
function preferMatch(text, date, start) {
  const t = String(text || '');
  if (!t) return 0;
  let score = 0;
  const wd = new Date(date + 'T00:00:00').getDay();
  if (t.includes(periodOf(start))) score += 2;
  if (t.includes('平日') && wd >= 1 && wd <= 5) score += 1;
  if (t.includes('週末') && (wd === 0 || wd === 6)) score += 1;
  if (t.includes('週' + ['日', '一', '二', '三', '四', '五', '六'][wd])) score += 2;
  return score;
}

function matchWaitlist(counselorId, date, start_time) {
  const days = Number(getSetting('waitlist_match_days', '14'));
  const rows = db.prepare(`SELECT i.*, u.name AS assigned_name, p.name AS preferred_name
    FROM intakes i
    LEFT JOIN users u ON u.id = i.assigned_counselor_id
    LEFT JOIN users p ON p.id = i.preferred_counselor_id
    WHERE i.status IN ('new','waiting','assigned')
    ORDER BY i.created_at`).all();
  const cid = Number(counselorId);
  return rows.map(r => {
    // 指定了別位心理師的案件不列入（避免通知到不想換人的來電者）
    const named = r.assigned_counselor_id || r.preferred_counselor_id;
    if (named && Number(named) !== cid) return null;
    const waitDays = Math.floor((Date.now() - new Date(r.created_at.replace(' ', 'T')).getTime()) / 86400000);
    let score = 0;
    if (Number(r.assigned_counselor_id) === cid) score += 6;
    else if (Number(r.preferred_counselor_id) === cid) score += 4;
    if (r.urgency === 'high') score += 5;
    else if (r.urgency === 'low') score -= 1;
    score += preferMatch(r.preferred_time, date, start_time);
    score += Math.min(waitDays / 7, 3);
    // 近期已為同一時段通知過就不重複打擾
    const notifiedSame = r.waitlist_notified_slot === `${date} ${start_time}`;
    return {
      id: r.id, name: r.name, phone: r.phone, urgency: r.urgency, status: r.status,
      issue: r.issue, preferred_time: r.preferred_time,
      counselor_name: r.assigned_name || r.preferred_name || '',
      wait_days: waitDays, recent: waitDays <= days,
      notified_at: r.waitlist_notified_at, notified_same_slot: notifiedSame,
      score: Math.round(score * 10) / 10
    };
  }).filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 10);
}

function waitlistMessage({ name, date, start_time, end_time, counselor_name }) {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(date + 'T00:00:00').getDay()];
  return getSetting('waitlist_template', '')
    .replace('{name}', name || '')
    .replace('{date}', date)
    .replace('{weekday}', weekday)
    .replace('{time}', `${start_time}-${end_time}`)
    .replace('{counselor}', counselor_name || '')
    .replace('{center}', getSetting('center_name'))
    .replace('{phone}', getSetting('center_phone'));
}

// 近期釋出的時段（取消／未到，且該時段目前確實沒有其他有效預約占用）＋可遞補人選
router.get('/waitlist/openings', requireStaff('schedule'), (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || addDays(from, 30);
  const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.counselor_id, a.status, a.cancel_reason,
      u.name AS counselor_name
    FROM appointments a LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.date BETWEEN ? AND ? AND a.status IN ('cancelled','no_show')
    ORDER BY a.date, a.start_time`).all(from, to);
  const open = rows.filter(r => !conflictOf({
    id: r.id, date: r.date, start_time: r.start_time, end_time: r.end_time, counselor_id: r.counselor_id
  }) && !timeOffOf(r.counselor_id, r.date, r.start_time, r.end_time));
  res.json(open.map(r => {
    const candidates = matchWaitlist(r.counselor_id, r.date, r.start_time);
    return { ...r, candidate_count: candidates.length, candidates };
  }));
});

// 指定時段的候補人選（含可直接發送的訊息文字）
router.get('/waitlist/matches', requireStaff('schedule'), (req, res) => {
  const { counselor_id, date, start_time, end_time } = req.query;
  if (!counselor_id || !date || !start_time) return res.status(400).json({ error: '請指定心理師、日期與時間' });
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(counselor_id));
  const end = end_time || endTime(start_time, defaultSessionMinutes());
  res.json(matchWaitlist(Number(counselor_id), date, start_time).map(c => ({
    ...c,
    message: waitlistMessage({ name: c.name, date, start_time, end_time: end, counselor_name: u ? u.name : '' })
  })));
});

// 發送遞補通知：與晤談提醒共用發送機制（未設定 webhook 時只記錄為人工發送）
router.post('/waitlist/notify', requireStaff('schedule'), async (req, res) => {
  const b = req.body || {};
  const intake = db.prepare('SELECT * FROM intakes WHERE id = ?').get(Number(b.intake_id) || 0);
  if (!intake) return res.status(404).json({ error: '找不到此候補案件' });
  if (!b.date || !b.start_time) return res.status(400).json({ error: '請指定釋出的時段' });
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(b.counselor_id) || 0);
  const end = b.end_time || endTime(b.start_time, defaultSessionMinutes());
  const content = String(b.message || '').trim()
    || waitlistMessage({ name: intake.name, date: b.date, start_time: b.start_time, end_time: end, counselor_name: u ? u.name : '' });
  const result = await sendNotification({
    kind: 'waitlist', client_id: intake.client_id || null,
    target: intake.phone, content, user: req.user
  });
  db.prepare('UPDATE intakes SET waitlist_notified_at = ?, waitlist_notified_slot = ? WHERE id = ?')
    .run(nowStamp(), `${b.date} ${b.start_time}`, intake.id);
  audit('staff', req.user.id, req.user.name, '通知候補遞補', String(intake.id), { date: b.date, time: b.start_time });
  res.json({ ok: true, ...result });
});

// ---- 晤談提醒 ----
// 台灣諮商所多以電話或 LINE 提醒。系統不代發訊息（避免把個資送出去），
// 而是產生可直接複製貼上的文字，並記錄已通知時間避免重複打擾。
router.get('/reminders', requireStaff('schedule'), (req, res) => {
  const date = req.query.date || addDays(today(), 1);
  const rows = db.prepare(`${LIST_SQL} WHERE a.date = ? AND a.status = 'booked' ORDER BY a.start_time`).all(date);
  const tpl = getSetting('reminder_template', '');
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(date + 'T00:00:00').getDay()];
  // 視訊晤談：連結一併帶進提醒訊息。範本可自行放 {meeting}，沒放的話補在最後一行。
  const withMeeting = (text, a) => {
    const line = a.mode === 'online' && a.meeting_url ? `視訊連結：${a.meeting_url}` : '';
    if (text.includes('{meeting}')) return text.replace('{meeting}', line);
    return line ? `${text}\n${line}` : text;
  };
  res.json({
    date,
    rows: rows.map(a => ({
      ...a,
      message: withMeeting(tpl
        .replace('{client}', a.client_name)
        .replace('{counselor}', a.counselor_name || '')
        .replace('{date}', a.date)
        .replace('{weekday}', weekday)
        .replace('{time}', `${a.start_time}-${a.end_time}`)
        .replace('{center}', getSetting('center_name'))
        .replace('{cancel_hours}', getSetting('cancel_hours', '24'))
        .replace('{phone}', getSetting('center_phone')), a)
    }))
  });
});

// 標記已提醒；若系統設定填了 webhook，改由系統送出簡訊／LINE 並記錄結果。
// 未設定 webhook 時維持原本行為（人工發送後標記），發送紀錄一律留存供查。
router.post('/appointments/:id/remind', requireStaff('schedule'), async (req, res) => {
  const a = db.prepare(`SELECT a.*, c.name AS client_name, c.phone AS client_phone
    FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.id = ?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  const content = String(req.body && req.body.message || '');
  const result = await sendNotification({
    kind: 'reminder', client_id: a.client_id, appointment_id: a.id,
    target: a.client_phone, content, user: req.user
  });
  db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowStamp(), a.id);
  res.json({ ok: true, ...result });
});

// 發送紀錄查詢（含失敗原因，便於追查漏通知）
router.get('/notifications', requireStaff('schedule'), (req, res) => {
  const { from = '', to = '', status = '' } = req.query;
  const where = [], args = [];
  if (from) { where.push('n.created_at >= ?'); args.push(from + ' 00:00'); }
  if (to) { where.push('n.created_at <= ?'); args.push(to + ' 23:59'); }
  if (status) { where.push('n.status = ?'); args.push(status); }
  res.json(db.prepare(`SELECT n.*, c.name AS client_name, c.code AS client_code, u.name AS sent_by_name
    FROM notifications n LEFT JOIN clients c ON c.id = n.client_id LEFT JOIN users u ON u.id = n.sent_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY n.id DESC LIMIT 300`).all(...args));
});

module.exports = router;
module.exports.freeSlots = freeSlots;
module.exports.endTime = endTime;
module.exports.conflictOf = conflictOf;
module.exports.checkDateTime = checkDateTime;
module.exports.matchWaitlist = matchWaitlist;
module.exports.availabilityOn = availabilityOn;
module.exports.mondayOf = mondayOf;
