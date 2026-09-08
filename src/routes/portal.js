const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, audit, today, addDays, getSetting, nowStamp } = require('../db');
const {
  CLIENT_COOKIE, signToken, setAuthCookie, clearAuthCookie, requireClient,
  loginLockedMinutes, loginFailed, loginSucceeded, rateLimit, clientIp
} = require('../auth');
const { SCALE_KEYS, score, publicScales } = require('../scales');
const plans = require('../plans');
const line = require('../line');
const { freeSlots, conflictOf } = require('./schedule');
const { consentsForClient } = require('../consents');

const router = express.Router();
const loginRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: 'portal:' });

// 個案在專區自行改期或取消，心理師的行程就變了——沒有通知的話他只能靠自己重看行事曆。
// 未綁定 LINE 或未串接時，pushFlex 會記成「待人工發送」，不會靜靜地漏掉。
async function notifyCounselor(counselorId, title, text) {
  const u = db.prepare('SELECT name, line_user_id FROM users WHERE id = ? AND active = 1').get(Number(counselorId) || 0);
  if (!u || !u.line_user_id) return;
  try {
    await line.pushFlex({
      to: u.line_user_id, kind: 'schedule_change',
      flex: line.card({
        title, subtitle: getSetting('center_name'), altText: `${title}：${text}`,
        body: [{ type: 'text', size: 'sm', wrap: true, color: '#3b4a55', text }]
      })
    });
  } catch (e) { console.error('通知心理師失敗：', e.message); }
}

// 專區可選的方案：與對外預約表單同一份名單（啟用中＋開放線上顯示）。
// 舊個案臨時要約伴侶諮商或親職諮詢時，時長與費用都要跟著方案走，
// 不能一律套用系統預設的 50 分鐘與預設收費。
function portalPlanRows() {
  return db.prepare('SELECT * FROM service_plans WHERE active = 1 AND portal_visible = 1 ORDER BY sort, id').all();
}
function portalPlanPublic(p) {
  return {
    id: p.id, name: p.name, appt_type: p.appt_type, intro: p.intro || '',
    session_minutes: plans.sessionMinutes(p),
    default_mode: p.default_mode || 'onsite',
    fee_mode: p.fee_mode,
    fee_options: plans.parseOptions(p.fee_options),
    // client_pay 才是個案自己要付的錢（補助方案已扣掉給付）
    client_pay: Math.max(0, p.fee - p.subsidy_amount),
    subsidy_amount: p.subsidy_amount, venue_fee: p.venue_fee || 0
  };
}
// 方案若訂了專屬費率名單，就只有名單內且開放預約的心理師能接；沒訂就是全所都能接。
// 規則與對外表單的 planPublic 相同，兩邊不能各判一套。
function planAllowsCounselor(planId, counselorId) {
  const rates = db.prepare(`SELECT counselor_id, bookable FROM plan_counselors
    WHERE plan_id = ? AND active = 1 AND (topic_id IS NULL OR topic_id = 0)`).all(Number(planId) || 0);
  if (!rates.length) return true;
  return rates.some(r => r.counselor_id === Number(counselorId) && r.bookable);
}
// 專區帶進來的方案：必須是「開放線上顯示」的，才不會讓個案繞過表單約到停用的方案
function portalPlan(planId) {
  if (!planId) return null;
  const p = plans.getPlan(planId);
  return p && p.active && p.portal_visible ? p : null;
}

// 家人代訂：授權由櫃檯建立（client_family），專區只讀。
// 沒有授權就約不到別人的時段，也看不到對方的任何資料；
// 代訂看得到的僅止於「時間、心理師、狀態」這些排程資訊，紀錄與量表一律不開放。
function bookableMembers(clientId) {
  return db.prepare(`SELECT c.id, c.name, c.code, f.relationship
    FROM client_family f JOIN clients c ON c.id = f.member_id
    WHERE f.client_id = ? AND f.can_book = 1 AND c.active = 1 ORDER BY c.name`).all(Number(clientId) || 0);
}
// 這次要替誰預約：沒帶就是自己；帶了就必須在授權名單內
function targetClient(req, forId) {
  if (!forId || Number(forId) === req.client.id) return req.client;
  const ok = bookableMembers(req.client.id).some(m => m.id === Number(forId));
  return ok ? db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(Number(forId)) : null;
}
// 本人與被授權家人的預約：改期／取消時用來判斷這筆能不能動
function ownedAppointment(req, apptId) {
  const ids = [req.client.id, ...bookableMembers(req.client.id).map(m => m.id)];
  return db.prepare(`SELECT * FROM appointments WHERE id = ? AND client_id IN (${ids.map(() => '?').join(',')})`)
    .get(apptId, ...ids) || null;
}

// 個案端只提供行政功能（預約、量表、費用、同意書），不提供任何晤談紀錄內容
router.post('/login', loginRateLimit, (req, res) => {
  const { phone = '', password = '' } = req.body || {};
  const lockKey = `client:${phone}`;
  const locked = loginLockedMinutes(lockKey);
  if (locked) return res.status(429).json({ error: `登入失敗次數過多，請 ${locked} 分鐘後再試` });
  const c = db.prepare('SELECT * FROM clients WHERE phone = ? AND active = 1 AND portal_enabled = 1').get(phone);
  if (!c || !c.password_hash || !bcrypt.compareSync(password, c.password_hash)) {
    loginFailed(lockKey);
    return res.status(401).json({ error: '手機號碼或密碼錯誤' });
  }
  loginSucceeded(lockKey);
  setAuthCookie(res, CLIENT_COOKIE, signToken({ t: 'client', id: c.id }), req);
  audit('client', c.id, c.name, '個案端登入');
  res.json({ ok: true, must_change_password: !!c.must_change_password });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res, CLIENT_COOKIE, req);
  res.json({ ok: true });
});

router.put('/password', requireClient, (req, res) => {
  const { old_password = '', new_password = '' } = req.body || {};
  if (!bcrypt.compareSync(old_password, req.client.password_hash)) return res.status(400).json({ error: '舊密碼不正確' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密碼至少 6 碼' });
  db.prepare('UPDATE clients SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 10), req.client.id);
  res.json({ ok: true });
});

router.get('/me', requireClient, (req, res) => {
  const c = req.client;
  // 只列跟這位個案有關的同意書（逐案指派優先，否則依年齡分群＋方案），跟所方個案頁同一套規則
  const templates = consentsForClient(c);
  const signed = db.prepare('SELECT key, version, agreed FROM consents WHERE client_id = ?').all(c.id);
  res.json({
    id: c.id, name: c.name, code: c.code, phone: c.phone,
    must_change_password: !!c.must_change_password,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    portal_note: getSetting('ui_portal_note'),
    crisis_note: getSetting('ui_crisis_note'),
    booking_enabled: getSetting('portal_booking_enabled', '1') === '1',
    plans: portalPlanRows().map(portalPlanPublic),
    family: bookableMembers(c.id),
    reschedule_enabled: getSetting('portal_reschedule_enabled', '1') === '1',
    cancel_hours: Number(getSetting('cancel_hours', '24')),
    no_show_fee_rate: Number(getSetting('no_show_fee_rate', '0.5')),
    no_show_fee_fixed: Number(getSetting('no_show_fee_fixed', '0')),
    counselor: c.counselor_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.counselor_id) : null,
    pending_consents: templates
      .filter(t => !signed.some(s => s.key === t.key && s.version === t.version))
      .map(t => ({ key: t.key, title: t.title })),
    pending_tasks: db.prepare('SELECT id, scale, due_date FROM assessment_tasks WHERE client_id = ? AND done_id IS NULL').all(c.id)
  });
});

// ---- 我的預約 ----
router.get('/appointments', requireClient, (req, res) => {
  const hours = Number(getSetting('cancel_hours', '24'));
  // 自己的，加上被授權代訂的家人的——家長要在同一頁看到孩子的時間，否則等於沒法管
  const ids = [req.client.id, ...bookableMembers(req.client.id).map(m => m.id)];
  const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.type, a.mode, a.status, a.fee, a.note,
      a.meeting_url, a.counselor_id, a.plan_id, a.client_id, a.reschedule_count, a.cancel_requested_at,
      u.name AS counselor_name, p.name AS plan_name, c.name AS client_name
    FROM appointments a LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = a.plan_id
    JOIN clients c ON c.id = a.client_id
    WHERE a.client_id IN (${ids.map(() => '?').join(',')})
    ORDER BY a.date DESC, a.start_time DESC LIMIT 120`).all(...ids);
  // 由後端算出「還能不能自行改期／取消」，前端只負責顯示，規則不會兩邊各算一套
  res.json(rows.map(a => {
    const msLeft = new Date(`${a.date}T${a.start_time}:00`).getTime() - Date.now();
    return {
      ...a,
      // 家人的約標上是誰的，避免整頁時間混在一起分不出來
      for_name: a.client_id === req.client.id ? '' : a.client_name,
      can_self_serve: a.status === 'booked' && msLeft >= hours * 3600 * 1000 && !a.cancel_requested_at,
      // 已過的時間不再顯示「申請取消」，那是櫃檯要結案的狀態
      late: a.status === 'booked' && msLeft > 0 && msLeft < hours * 3600 * 1000
    };
  }));
});

// 可預約時段：僅開放主責心理師（未指定則全所心理師）。
// 帶 plan_id 時整段以方案為準：時長、可接的心理師、方案人次上限與資格都跟著換，
// 否則個案在專區約伴侶諮商，會拿到 50 分鐘的格子而實際要 90 分鐘。
router.get('/slots', requireClient, (req, res) => {
  const date = req.query.date || today();
  const plan = portalPlan(req.query.plan_id);
  if (req.query.plan_id && !plan) return res.status(400).json({ error: '此方案目前未開放線上預約，請來電洽詢' });
  // 替家人預約時，心理師與方案資格都要以「那位家人」為準，不是登入的這個人
  const forClient = targetClient(req, req.query.for_client_id);
  if (!forClient) return res.status(403).json({ error: '未授權替這位家人預約，請來電洽詢' });
  const minutes = plans.sessionMinutes(plan);
  // 與對外表單同一套：最快幾天後 + 前一天幾點截止
  const minDate = (() => {
    const byLead = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
    const byCutoff = plans.earliestBookableDate(getSetting('portal_book_lead_days', '1'));
    return byLead > byCutoff ? byLead : byCutoff;
  })();
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  const base = { min_date: minDate, max_date: maxDate, session_minutes: minutes,
    for_client_id: forClient.id, for_name: forClient.id === req.client.id ? '' : forClient.name };
  if (date < minDate || date > maxDate) return res.json({ ...base, counselors: [] });
  const counselors = (forClient.counselor_id
    ? db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').all(forClient.counselor_id)
    : db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor') ORDER BY id").all())
    .filter(u => !plan || planAllowsCounselor(plan.id, u.id));
  // 年齡與年度次數不合格就整天不出時段，並把原因講清楚，
  // 不要讓個案挑完時段送出才被退。
  const check = plan ? plans.checkBooking({ plan_id: plan.id, client: forClient, date }) : null;
  const enforce = getSetting('plan_quota_enforce', '1') === '1';
  const planError = check && check.errors.length && enforce ? check.errors[0] : '';
  res.json({
    ...base,
    plan_error: planError,
    // 方案有指定心理師名單時，主責心理師可能不在名單裡，畫面要說明而不是只顯示空白
    plan_no_counselor: !!plan && !counselors.length,
    counselors: counselors.map(u => {
      // 心理師該方案的每週／每月人次滿了就不出時段，與對外表單同一套
      const load = plan ? plans.counselorLoad(u.id, plan.id, date) : null;
      const full = load && load.week_full
        ? `本週此方案已排滿 ${load.week_used}/${load.week_limit} 人次`
        : (load && load.month_full ? `本月此方案已排滿 ${load.month_used}/${load.month_limit} 人次` : '');
      return {
        id: u.id, name: u.name, full,
        slots: planError || full ? []
          : freeSlots(u.id, date, minutes).filter(sl => !plans.bookingCutoffReason(date, sl.start_time))
      };
    })
  });
});

// 個案自行送出預約（狀態為 booked，櫃檯可再調整；不可自行指定費用）
router.post('/appointments', requireClient, async (req, res) => {
  if (getSetting('portal_booking_enabled', '1') !== '1') return res.status(403).json({ error: '目前未開放線上預約，請來電預約' });
  const { date = '', start_time = '', counselor_id, note = '' } = req.body || {};
  // 與對外表單同一套：最快幾天後 + 前一天幾點截止
  const minDate = (() => {
    const byLead = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
    const byCutoff = plans.earliestBookableDate(getSetting('portal_book_lead_days', '1'));
    return byLead > byCutoff ? byLead : byCutoff;
  })();
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  if (!date || date < minDate || date > maxDate) return res.status(400).json({ error: `可預約範圍為 ${minDate} 至 ${maxDate}` });
  // 替家人預約時，以下每一項（主責心理師、方案資格、費用、初談與否）都以那位家人為準
  const forClient = targetClient(req, req.body.for_client_id);
  if (!forClient) return res.status(403).json({ error: '未授權替這位家人預約，請來電洽詢' });
  const proxy = forClient.id !== req.client.id;
  const cid = Number(counselor_id) || forClient.counselor_id;
  if (!cid) return res.status(400).json({ error: '請選擇心理師' });
  if (forClient.counselor_id && cid !== forClient.counselor_id) {
    return res.status(400).json({ error: '如需更換心理師請來電洽詢' });
  }
  // 方案決定晤談長度、類型（伴侶／親職…）、形式與收費；沒帶方案就維持原本的預設收費
  const plan = portalPlan(req.body.plan_id);
  if (req.body.plan_id && !plan) return res.status(400).json({ error: '此方案目前未開放線上預約，請來電洽詢' });
  if (plan && !planAllowsCounselor(plan.id, cid)) {
    return res.status(400).json({ error: `「${plan.name}」需由本所指定的心理師進行，請來電洽詢` });
  }
  const cutoffReason = plans.bookingCutoffReason(date, start_time);
  if (cutoffReason) return res.status(400).json({ error: `${cutoffReason}，請改約其他時間或來電洽詢。` });
  const slot = freeSlots(cid, date, plans.sessionMinutes(plan)).find(s => s.start_time === start_time);
  if (!slot) return res.status(400).json({ error: '此時段已被預約或非開放時段，請重新選擇' });
  // 方案資格：年齡、年度次數與該心理師的人次上限，與對外表單同一套規則
  if (plan) {
    const check = plans.checkBooking({ plan_id: plan.id, client: forClient, counselor_id: cid, date });
    if (check.errors.length && getSetting('plan_quota_enforce', '1') === '1') {
      return res.status(400).json({ error: `${check.errors[0]}，請改約其他時間或來電洽詢。` });
    }
  }
  const counselor = db.prepare('SELECT name, line_user_id FROM users WHERE id = ?').get(cid);
  const counselorRow = db.prepare('SELECT online_only, meeting_room_url FROM users WHERE id = ?').get(cid) || {};
  // 只接視訊的心理師一律線上；否則照方案的預設形式
  const mode = counselorRow.online_only ? 'online' : ((plan && plan.default_mode) || 'onsite');
  const meetingUrl = mode === 'online' ? (counselorRow.meeting_room_url || '') : '';
  const type = plan ? plan.appt_type
    : (db.prepare("SELECT 1 FROM appointments WHERE client_id = ? AND status = 'done'").get(forClient.id) ? 'individual' : 'intake');
  // fee 存「個案要付的錢」，方案給付的部分另存 subsidy_amount；抽成一併算好，
  // 免得櫃檯之後還要為個案端排的約補一次帳。
  const quote = plan
    ? plans.resolveFee({ plan_id: plan.id, counselor_id: cid, fee_choice: req.body.fee_choice, client_id: forClient.id })
    : null;
  const fee = quote ? quote.fee : Number(getSetting(type === 'intake' ? 'intake_fee' : 'default_fee', '2000'));
  // 方案設「線上預約需櫃檯確認才成立」時，專區送出的是預約申請而非直接佔位，
  // 與對外表單同一套流程（櫃檯在「預約申請」頁確認後才成立），
  // 補助方案的名額才不會被線上直接搶走。
  if (plan && plan.require_review) {
    const reqInfo = db.prepare(`INSERT INTO booking_requests
      (name, phone, email, gender, birth_date, is_new, client_id, plan_id, counselor_id,
       date, start_time, mode, fee_choice, main_issue, source, line_user_id, consent, status)
      VALUES (?,?,?,?,?, 0, ?,?,?,?,?,?,?,?, 'portal', ?, 1, 'new')`).run(
      forClient.name, forClient.phone || req.client.phone, forClient.email || '', forClient.gender || '',
      forClient.birth_date || '', forClient.id, plan.id, cid, date, start_time, mode,
      quote ? quote.fee : 0,
      (proxy ? `由${req.client.name}於個案專區代訂。` : '') + String(note || ''),
      forClient.line_user_id || '');
    audit('client', req.client.id, req.client.name, '個案端預約申請', req.client.code,
      { date, start_time, plan: plan.name, for: proxy ? forClient.code : '' });
    if (counselor && counselor.line_user_id) {
      try {
        await line.pushFlex({
          to: counselor.line_user_id, kind: 'booking_staff',
          flex: line.counselorBookingFlex({
            counselor_name: counselor.name,
            b: { name: `${forClient.name}（${forClient.code}）`, date, start_time,
              plan_name: plan.name, main_issue: note }
          })
        });
      } catch (e) { console.error('個案端預約申請通知心理師失敗：', e.message); }
    }
    return res.json({ pending: true, request_id: reqInfo.lastInsertRowid, plan_name: plan.name,
      message: '已收到您的預約申請，我們確認後會盡快與您聯繫。' });
  }
  // 諮商室由系統指派（個案端不顯示空間配置）；排滿時留空由櫃檯安排，
  // 週檢視的「未指定空間」清單會列出來。視訊晤談不佔空間。
  const roomId = mode === 'online' ? null : plans.pickRoom({ date, start_time, end_time: slot.end_time });
  const info = db.prepare(`INSERT INTO appointments
    (client_id, counselor_id, room_id, date, start_time, end_time, type, mode, status, fee, subsidy_amount,
     plan_id, counselor_share, meeting_url, source, note)
    VALUES (?,?,?,?,?,?,?,?, 'booked', ?,?,?,?,?, 'portal', ?)`).run(
    forClient.id, cid, roomId, date, start_time, slot.end_time, type, mode,
    fee, quote ? quote.subsidy_amount : 0, plan ? plan.id : null, quote ? quote.counselor_share : 0,
    meetingUrl, (proxy ? `由${req.client.name}於個案專區代訂。` : '') + String(note || ''));
  audit('client', req.client.id, req.client.name, proxy ? '個案端代訂家人預約' : '個案端預約',
    req.client.code, { date, start_time, plan: plan ? plan.name : '', for: proxy ? forClient.code : '' });
  // 心理師端通知：個案自己在專區排進來的，跟線上申請成立時一樣要讓心理師知道
  if (counselor && counselor.line_user_id) {
    try {
      await line.pushFlex({
        to: counselor.line_user_id, kind: 'booking_staff',
        flex: line.counselorBookingFlex({
          counselor_name: counselor.name, kind: '新排入的晤談',
          b: { name: `${forClient.name}（${forClient.code}）`, date, start_time,
            plan_name: plan ? plan.name : '', main_issue: note }
        })
      });
    } catch (e) { console.error('個案端預約通知心理師失敗：', e.message); }
  }
  res.json({ id: info.lastInsertRowid, room_id: roomId, end_time: slot.end_time, mode, fee,
    plan_name: plan ? plan.name : '', for_name: proxy ? forClient.name : '' });
});

// ---- 待櫃檯確認的預約申請 ----
// 方案設了「需櫃檯確認」時，專區送出的是申請而不是預約。若不一併列出來，
// 個案會以為送出後石沉大海，隔天又送一次。
router.get('/booking-requests', requireClient, (req, res) => {
  const ids = [req.client.id, ...bookableMembers(req.client.id).map(m => m.id)];
  const rows = db.prepare(`SELECT b.id, b.date, b.start_time, b.status, b.created_at, b.client_id,
      u.name AS counselor_name, p.name AS plan_name, c.name AS client_name
    FROM booking_requests b
    LEFT JOIN users u ON u.id = b.counselor_id
    LEFT JOIN service_plans p ON p.id = b.plan_id
    JOIN clients c ON c.id = b.client_id
    WHERE b.client_id IN (${ids.map(() => '?').join(',')}) AND b.status = 'new'
    ORDER BY b.date, b.start_time`).all(...ids);
  res.json(rows.map(r => ({ ...r, for_name: r.client_id === req.client.id ? '' : r.client_name })));
});
// 還沒被櫃檯處理的申請，個案可以自己撤回（已成立的走預約取消那條路）
router.post('/booking-requests/:id/cancel', requireClient, (req, res) => {
  const ids = [req.client.id, ...bookableMembers(req.client.id).map(m => m.id)];
  const b = db.prepare(`SELECT * FROM booking_requests WHERE id = ?
    AND client_id IN (${ids.map(() => '?').join(',')})`).get(req.params.id, ...ids);
  if (!b) return res.status(404).json({ error: '找不到此預約申請' });
  if (b.status !== 'new') return res.status(400).json({ error: '此申請已由櫃檯處理，請來電洽詢' });
  db.prepare("UPDATE booking_requests SET status = 'cancelled', reply_note = ? WHERE id = ?")
    .run('個案於專區自行撤回', b.id);
  audit('client', req.client.id, req.client.name, '個案端撤回預約申請', req.client.code,
    { date: b.date, start_time: b.start_time });
  res.json({ ok: true });
});

// 改期：與線上預約走同一套規則（開放時段、提前天數、不換心理師），
// 且必須在免收費取消期限之前；逾期者一律只能提出申請由櫃檯處理。
router.post('/appointments/:id/reschedule', requireClient, async (req, res) => {
  if (getSetting('portal_reschedule_enabled', '1') !== '1') {
    return res.status(403).json({ error: '目前未開放線上改期，請來電洽詢' });
  }
  // 自己的約，或被授權代訂的家人的約，都可以改期／取消
  const a = ownedAppointment(req, req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  if (a.status !== 'booked') return res.status(400).json({ error: '此預約無法自行改期，請來電洽詢' });
  const hours = Number(getSetting('cancel_hours', '24'));
  if (new Date(`${a.date}T${a.start_time}:00`).getTime() - Date.now() < hours * 3600 * 1000) {
    return res.status(400).json({ error: `距晤談時間已不足 ${hours} 小時，請直接來電改期` });
  }
  const { date = '', start_time = '' } = req.body || {};
  // 與對外表單同一套：最快幾天後 + 前一天幾點截止
  const minDate = (() => {
    const byLead = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
    const byCutoff = plans.earliestBookableDate(getSetting('portal_book_lead_days', '1'));
    return byLead > byCutoff ? byLead : byCutoff;
  })();
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  if (!date || date < minDate || date > maxDate) return res.status(400).json({ error: `可改期範圍為 ${minDate} 至 ${maxDate}` });
  // 改期沿用原本那筆的方案時長，90 分鐘的伴侶諮商不會被改成 50 分鐘的格子
  const slot = freeSlots(a.counselor_id, date, plans.sessionMinutes(a.plan_id))
    .find(s => s.start_time === start_time);
  if (!slot) return res.status(400).json({ error: '此時段已被預約或非開放時段，請重新選擇' });
  const original = `${a.date} ${a.start_time}`;
  // 可預約時段只看心理師，不看諮商室；若原本的諮商室在新時段已被別人用了，
  // 就把諮商室清空交由櫃檯重新安排（並在備註標明），避免兩組人被排到同一間。
  // 諮商室由系統重新指派；個案端自始不顯示空間配置，只看時間與心理師
  let roomId = a.room_id;
  let roomNote = '';
  if (roomId && conflictOf({
    id: a.id, date, start_time, end_time: slot.end_time, counselor_id: a.counselor_id, room_id: roomId
  })) {
    roomId = plans.pickRoom({ date, start_time, end_time: slot.end_time, exclude_appointment_id: a.id });
    roomNote = roomId ? '' : '；改期後諮商室待重新安排';
  }
  db.prepare(`UPDATE appointments SET date = ?, start_time = ?, end_time = ?, reminded_at = '',
      room_id = ?, rescheduled_from = ?, reschedule_count = reschedule_count + 1,
      note = ? WHERE id = ?`).run(
    date, start_time, slot.end_time, roomId, original,
    (a.note ? a.note + '；' : '') + `個案自行改期（原 ${original}）` + roomNote, a.id);
  const who = db.prepare('SELECT id, name, code FROM clients WHERE id = ?').get(a.client_id) || req.client;
  audit('client', req.client.id, req.client.name, '個案端改期', req.client.code,
    { from: original, to: `${date} ${start_time}`, for: who.id === req.client.id ? '' : who.code });
  await notifyCounselor(a.counselor_id, '個案自行改期',
    `${who.name}（${who.code}）已將晤談由 ${original} 改為 ${date} ${start_time}。`);
  res.json({ ok: true, date, start_time, end_time: slot.end_time });
});

// 取消：期限內直接取消；不足時數者只留下取消申請與事由（預約仍然有效），
// 由櫃檯決定是否依未到比例計費（不讓個案端自行決定收費結果）。
// 櫃檯是從排程頁與首頁待辦的「個案申請取消」看到這件事。
router.post('/appointments/:id/cancel', requireClient, async (req, res) => {
  // 自己的約，或被授權代訂的家人的約，都可以改期／取消
  const a = ownedAppointment(req, req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  if (a.status !== 'booked') return res.status(400).json({ error: '此預約無法自行取消，請來電洽詢' });
  const reason = String((req.body && req.body.reason) || '').trim();
  // 家人代訂的約，通知與紀錄要寫「是誰的晤談」，不是操作的那個人
  const who = db.prepare('SELECT id, name, code FROM clients WHERE id = ?').get(a.client_id) || req.client;
  const hours = Number(getSetting('cancel_hours', '24'));
  const start = new Date(`${a.date}T${a.start_time}:00`);
  if (start.getTime() < Date.now()) return res.status(400).json({ error: '此晤談時間已過，請來電與我們聯繫' });
  if (start.getTime() - Date.now() < hours * 3600 * 1000) {
    if (a.cancel_requested_at) return res.status(400).json({ error: '已收到您的取消申請，我們會盡快與您聯繫' });
    const charge = plans.noShowCharge(a.fee);
    db.prepare('UPDATE appointments SET cancel_requested_at = ?, cancel_request_reason = ? WHERE id = ?')
      .run(nowStamp(), reason || '個案申請取消', a.id);
    // 櫃檯是從排程頁與首頁待辦的「個案申請取消」看到這件事（cancel_requested_at），
    // 個案檔案的晤談歷程也會列出申請時間與事由。
    audit('client', req.client.id, req.client.name, '個案端申請取消', req.client.code,
      { date: a.date, for: who.id === req.client.id ? '' : who.code });
    return res.json({
      ok: true, pending: true,
      message: `距晤談時間已不足 ${hours} 小時，已為您送出取消申請並通知櫃檯；`
        + `依所內規定，逾期取消可能收取${charge.fixed ? `行政規費 ${charge.amount} 元` : `原費用之 ${Math.round(charge.rate * 100)}%`}。`
    });
  }
  db.prepare("UPDATE appointments SET status = 'cancelled', cancel_reason = ? WHERE id = ?")
    .run(reason || '個案自行取消', a.id);
  audit('client', req.client.id, req.client.name, '個案端取消預約', req.client.code,
    { date: a.date, for: who.id === req.client.id ? '' : who.code });
  await notifyCounselor(a.counselor_id, '個案取消晤談',
    `${who.name}（${who.code}）已取消 ${a.date} ${a.start_time} 的晤談`
    + `${reason ? `，事由：${reason}` : ''}。此時段已釋出，可於「候補遞補」頁安排。`);
  res.json({ ok: true, pending: false, message: '已取消預約' });
});

// ---- 量表填寫 ----
router.get('/scales', requireClient, (req, res) => res.json(publicScales()));

router.post('/assessments', requireClient, (req, res) => {
  const { scale = '', answers, task_id } = req.body || {};
  if (!SCALE_KEYS.includes(scale)) return res.status(400).json({ error: '未知的量表' });
  let s;
  try { s = score(scale, answers); } catch (e) { return res.status(400).json({ error: e.message }); }
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO assessments (client_id, scale, date, answers, total, severity, alert, filled_by)
      VALUES (?,?,?,?,?,?,?, 'client')`).run(
      req.client.id, scale, today(), JSON.stringify(answers), s.total, s.severity, s.alert);
    if (task_id) db.prepare('UPDATE assessment_tasks SET done_id = ? WHERE id = ? AND client_id = ?')
      .run(info.lastInsertRowid, Number(task_id), req.client.id);
    if (s.alert) db.prepare("UPDATE clients SET risk_level = 'high' WHERE id = ?").run(req.client.id);
    return info.lastInsertRowid;
  });
  const id = tx();
  audit('client', req.client.id, req.client.name, '個案端填寫量表', req.client.code, { scale, total: s.total });
  // 命中危險題時，回傳求助資訊由前端顯著提示
  res.json({
    id, total: s.total, severity: s.severity, alert: s.alert,
    crisis_note: s.alert ? getSetting('ui_crisis_note') : ''
  });
});

router.get('/assessments', requireClient, (req, res) => {
  res.json(db.prepare(`SELECT id, scale, date, total, severity FROM assessments
    WHERE client_id = ? ORDER BY date DESC`).all(req.client.id));
});

// ---- 同意書線上簽署 ----
router.get('/consents', requireClient, (req, res) => {
  const templates = consentsForClient(req.client);
  const signed = db.prepare('SELECT key, version, agreed, signer_name, signed_at FROM consents WHERE client_id = ?').all(req.client.id);
  res.json(templates.map(t => ({
    key: t.key, title: t.title, body: t.body, version: t.version,
    required: t.required, allow_decline: t.allow_decline, minor_only: t.minor_only,
    signed: signed.find(s => s.key === t.key && s.version === t.version) || null
  })));
});

router.post('/consents', requireClient, (req, res) => {
  const { key = '', agreed = 1, signer_name = '', signature = '' } = req.body || {};
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(key);
  if (!t) return res.status(400).json({ error: '找不到此同意書' });
  if (!agreed && !t.allow_decline) return res.status(400).json({ error: '此同意書為必要項目' });
  if (!signer_name) return res.status(400).json({ error: '請填寫簽署人姓名' });
  if (!signature) return res.status(400).json({ error: '請完成簽名' });
  // 該不該出現在這位個案面前，由 consentsForClient 一處決定（逐案指派優先，否則年齡＋方案）
  if (!consentsForClient(req.client).some(x => x.key === t.key)) {
    return res.status(400).json({ error: '此同意書不適用' });
  }
  const role = t.minor_only ? 'guardian' : 'client';
  db.prepare(`INSERT INTO consents (client_id, key, title, body, version, agreed, signer_name, signer_role, signature, signed_ip)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    req.client.id, t.key, t.title, t.body, t.version, agreed ? 1 : 0, signer_name, role, signature, clientIp(req));
  audit('client', req.client.id, req.client.name, '個案端簽署同意書', `${req.client.code}/${t.key}`);
  res.json({ ok: true });
});

// ---- 費用與方案 ----
router.get('/billing', requireClient, (req, res) => {
  res.json({
    invoices: db.prepare(`SELECT id, date, item, amount, status, method, receipt_no, payer
      FROM invoices WHERE client_id = ? AND status != 'void' ORDER BY date DESC, id DESC LIMIT 60`).all(req.client.id),
    packages: db.prepare(`SELECT name, sessions_total, sessions_used, (sessions_total - sessions_used) AS remaining,
      expire_date, status FROM packages WHERE client_id = ? ORDER BY id DESC`).all(req.client.id),
    unpaid: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM invoices WHERE client_id = ? AND status = 'unpaid'").get(req.client.id).n,
    // 已開立的收據：個案自己查得到編號與金額，需要紙本時報編號給櫃檯即可補印
    receipts: db.prepare(`SELECT receipt_no, date, item, amount, title FROM receipts
      WHERE client_id = ? AND status = 'valid' ORDER BY date DESC, id DESC LIMIT 60`).all(req.client.id)
  });
});

// ---- 公告 ----
router.get('/announcements', requireClient, (req, res) => {
  res.json(db.prepare(`SELECT id, title, content, publish_date FROM announcements
    WHERE audience IN ('all','client') AND publish_date <= date('now','localtime')
    ORDER BY pinned DESC, publish_date DESC LIMIT 20`).all());
});

// ---- LINE 綁定（個案自助）----
// 加好友一定要由本人在 LINE 點下去，系統無法代勞；能做的是把「加好友」與「回報綁定碼」
// 兩步都放到個案專區，並把綁定碼直接做進聊天室連結，個案只要按送出即可，不必手動輸入。
function officialMessageUrl(code) {
  const id = getSetting('line_official_id', '');   // 例如 @032cjyby
  if (!id || !code) return '';
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(code)}`;
}
router.get('/line', requireClient, (req, res) => {
  const c = db.prepare('SELECT line_user_id FROM clients WHERE id = ?').get(req.client.id) || {};
  const enabled = !!getSetting('line_channel_token');
  const out = {
    enabled,
    bound: !!c.line_user_id,
    official_name: getSetting('line_official_name', ''),
    official_id: getSetting('line_official_id', ''),
    add_friend_url: getSetting('line_add_friend_url', ''),
    reminder_hours: Number(getSetting('line_reminder_hours', '24'))
  };
  if (!enabled || out.bound) return res.json(out);
  // 沿用還沒過期的那組碼，重整頁面不會一直換新碼讓人混淆
  let bind = db.prepare(`SELECT code, expires_at FROM line_bindings
    WHERE client_id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at >= date('now','localtime'))
    ORDER BY id DESC LIMIT 1`).get(req.client.id);
  if (!bind) {
    db.prepare("UPDATE line_bindings SET status = 'expired' WHERE status = 'pending' AND client_id = ?")
      .run(req.client.id);
    const expires_at = addDays(today(), 1);
    const ins = db.prepare('INSERT INTO line_bindings (code, client_id, expires_at) VALUES (?,?,?)');
    // code 有唯一索引，萬一撞到別人手上還沒用掉的碼就再抽一次
    for (let i = 0; i < 10 && !bind; i++) {
      const code = String(crypto.randomInt(100000, 1000000));
      try { ins.run(code, req.client.id, expires_at); bind = { code, expires_at }; }
      catch (e) { if (i === 9) throw e; }
    }
  }
  res.json({ ...out, code: bind.code, expires_at: bind.expires_at, message_url: officialMessageUrl(bind.code) });
});
// 個案自己解除綁定（換手機、不想再收提醒），不必打電話請櫃檯處理
router.delete('/line', requireClient, (req, res) => {
  db.prepare("UPDATE clients SET line_user_id = '' WHERE id = ?").run(req.client.id);
  db.prepare("UPDATE line_bindings SET status = 'revoked' WHERE client_id = ? AND status = 'done'")
    .run(req.client.id);
  audit('client', req.client.id, req.client.name, '解除 LINE 綁定');
  res.json({ ok: true });
});

module.exports = router;
