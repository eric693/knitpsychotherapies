// 方案別（社會局／衛福部補助方案、自費方案、合作單位方案）的取價、額度與抽成計算。
//
// 三個層級由細到粗覆寫：心理師費率（plan_counselors）→ 主題（plan_topics）→ 方案（service_plans）。
// 額度有兩種，兩者互不相干，違反的原因也要分開講清楚：
//   1. 個案額度：某方案每人每年可用幾次（如衛福部青壯年方案一年 3 次）
//   2. 心理師人次上限：某方案每位心理師一週／一月可排幾人次（如一週 6 人次）
// 兩種上限都可在方案設定調整，也可針對個別心理師另訂（plan_counselors.week_limit）。

const { db, getSetting, ageYears } = require('./db');

// 佔用額度的預約狀態：已預約、已報到、已完成都算數；
// 取消不算，未到是否算由所方決定（預設算，因為補助方案的名額實際已被占用）。
const COUNTED_STATUSES = ['booked', 'arrived', 'done', 'no_show'];
const COUNTED_SQL = `('${COUNTED_STATUSES.join("','")}')`;

// 晤談時長只有這一個出處：方案有訂就用方案的，沒有才回到系統設定的預設值。
// 原本這個 fallback 散在十幾個檔案裡各寫一次，改預設值時很容易漏掉一處。
function defaultSessionMinutes() {
  return Number(getSetting('session_minutes', '50')) || 50;
}
function sessionMinutes(plan) {
  const p = plan && typeof plan === 'object' ? plan : getPlan(plan);
  return Number(p && p.session_minutes) || defaultSessionMinutes();
}
// 由開始時間與時長推算結束時間（跨午夜取模，維持 HH:MM）
function endTime(start, minutes) {
  const [h, m] = String(start).split(':').map(Number);
  const t = h * 60 + m + (Number(minutes) || defaultSessionMinutes());
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function getPlan(id) {
  return db.prepare('SELECT * FROM service_plans WHERE id = ?').get(Number(id) || 0) || null;
}
function getTopic(id) {
  return db.prepare('SELECT * FROM plan_topics WHERE id = ?').get(Number(id) || 0) || null;
}
function getRate(planId, counselorId, topicId) {
  if (!planId || !counselorId) return null;
  // 先找「方案 × 心理師 × 主題」的專屬費率，沒有才用「方案 × 心理師」的通用費率
  return db.prepare(`SELECT * FROM plan_counselors
      WHERE plan_id = ? AND counselor_id = ? AND active = 1 AND topic_id = ?`)
    .get(Number(planId), Number(counselorId), Number(topicId) || 0)
    || db.prepare(`SELECT * FROM plan_counselors
      WHERE plan_id = ? AND counselor_id = ? AND active = 1 AND (topic_id IS NULL OR topic_id = 0)`)
      .get(Number(planId), Number(counselorId))
    || null;
}

// 指定／派案：呼叫端可以直接給 assign_type，或只給 client_id 由這裡查。
// 個案沒註記時（舊資料）一律當成指定案 —— 這是系統原本的行為，不能因為新增欄位就改變舊帳。
function resolveAssignType({ assign_type, client_id }) {
  const given = String(assign_type || '');
  if (given === 'assigned' || given === 'designated') return given;
  if (client_id) {
    const c = db.prepare('SELECT assign_type FROM clients WHERE id = ?').get(Number(client_id) || 0);
    if (c && c.assign_type === 'assigned') return 'assigned';
  }
  return 'designated';
}

function parseOptions(str) {
  return String(str || '').split(',').map(s => Number(String(s).trim())).filter(n => n > 0);
}

// 這一層（方案或心理師費率）在「指定案／派案」下實際生效的報酬設定。
//
// 指定案與派案的抽成常常不一樣：個案自己點名心理師的（指定案），案源算心理師的，抽成通常較高；
// 所方派給他的（派案），案源是所方，抽成較低。
// 派案那組留空（mode 空字串、percent 與 fixed 皆 0）就代表「沒有另訂」，沿用指定案那組 ——
// 這樣既有資料不必動，只有真的要分開的方案才需要填第二個數字。
function shareOf(row, assignType) {
  if (!row) return null;
  const wantAssigned = assignType === 'assigned';
  const hasAssigned = wantAssigned && (row.share_mode_assigned
    || Number(row.share_percent_assigned) > 0 || Number(row.share_fixed_assigned) > 0);
  const mode = hasAssigned
    ? (row.share_mode_assigned || row.share_mode || '')
    : (row.share_mode || '');
  if (!mode) return null;                     // 這一層沒設定報酬方式，交給上層決定
  return {
    mode,
    percent: hasAssigned && Number(row.share_percent_assigned) > 0
      ? Number(row.share_percent_assigned) : Number(row.share_percent) || 0,
    fixed: hasAssigned && Number(row.share_fixed_assigned) > 0
      ? Number(row.share_fixed_assigned) : Number(row.share_fixed) || 0,
    // 這次用的是不是「派案」那組數字，前端要據此標示，帳才看得懂
    assigned: hasAssigned
  };
}

// 取價：回傳這次晤談的總額、個案要付多少、方案給付多少、心理師分得多少。
//
// 金額有三個角色，分開記才不會互相污染：
//   total        方案總額（帳面上這次服務值多少）
//   subsidy      由補助方案／委辦單位支付的部分
//   client_pay   個案實際要付的錢 = total - subsidy（補助方案就是那 200 元場地費）
// 心理師抽成基數是 total 扣掉場地費（venue_fee）——場地費是所方的收入，不參與拆帳。
// fee_override 讓櫃檯在個案有特殊約定時直接指定「個案要付多少」。
//
// assign_type（指定／派案）決定抽成用哪一組數字；只給 client_id 時自動查出來，
// 呼叫端不必每處都先撈一次個案。
function resolveFee({ plan_id, topic_id, counselor_id, fee_choice, fee_override, assign_type, client_id }) {
  const plan = getPlan(plan_id);
  if (!plan) {
    const pay = Number(fee_override) || 0;
    return { plan: null, topic: null, rate: null, fee_options: [],
      total: pay, fee: pay, client_pay: pay, subsidy_amount: 0, self_pay: pay, venue_fee: 0,
      share_base: pay, counselor_share: 0, share_mode: 'percent', share_percent: 0,
      assign_type: resolveAssignType({ assign_type, client_id }), share_from_assigned: false, share_source: 'none',
      session_minutes: Number(getSetting('session_minutes', '50')), subsidy_program: '' };
  }
  const topic = getTopic(topic_id);
  const rate = getRate(plan.id, counselor_id, topic_id);
  const assignKind = resolveAssignType({ assign_type, client_id });

  // 可選金額方案（伴侶／家族）：以預約時挑選的金額為準，但只接受設定裡列出的選項，
  // 避免前端被改參數後送進任意金額。
  const options = parseOptions((topic && topic.fee_options) || plan.fee_options);
  let total = (rate && rate.fee) || (topic && topic.fee) || plan.fee;
  if (plan.fee_mode === 'choice' && options.length) {
    const picked = Number(fee_choice) || 0;
    if (options.includes(picked)) total = picked;
  }
  const subsidy = Math.min(plan.subsidy_amount || 0, total);
  let clientPay = Math.max(0, total - subsidy);
  // 櫃檯手動指定金額時，改的是「個案要付多少」，方案給付不動
  if (fee_override !== undefined && fee_override !== '' && fee_override !== null) {
    clientPay = Math.max(0, Math.round(Number(fee_override) || 0));
    total = subsidy + clientPay;
  }
  total = Math.max(0, Math.round(total));

  // 場地費全額歸所方，不進心理師的抽成基數
  const venue = Math.min(plan.venue_fee || 0, total);
  const shareBase = Math.max(0, total - venue);
  // 心理師費率優先於方案；同一層裡，派案有另訂就用派案的數字
  const eff = shareOf(rate, assignKind) || shareOf(plan, assignKind) || { mode: 'percent', percent: 0, fixed: 0, assigned: false };
  const shareMode = eff.mode;
  const share = shareMode === 'fixed'
    ? Math.round(eff.fixed)
    : Math.round(shareBase * eff.percent);

  return {
    plan, topic, rate,
    fee_options: options,
    total,
    fee: clientPay,            // 對外一律以「個案要付的錢」為準
    client_pay: clientPay,
    self_pay: clientPay,
    subsidy_amount: subsidy,
    venue_fee: venue,
    share_base: shareBase,
    counselor_share: share,
    share_mode: shareMode,
    share_percent: shareMode === 'percent' ? eff.percent : 0,
    // 這次抽成是照哪一組數字算的：designated 指定案／assigned 派案。
    // 帳單與月結算要能回答「為什麼這筆是 70% 那筆是 55%」。
    assign_type: assignKind,
    share_from_assigned: !!eff.assigned,
    share_source: rate && shareOf(rate, assignKind) ? 'counselor' : 'plan',
    session_minutes: plan.session_minutes || Number(getSetting('session_minutes', '50')),
    subsidy_program: plan.subsidy_program || ''
  };
}

// ---- 個案在某方案的年度使用次數 ----
// 「用了幾次」= 本系統該年度的有效預約 + 人工調整（在他所已用過的次數）
function clientUsage(clientId, planId, year) {
  const y = String(year || new Date().getFullYear());
  const used = db.prepare(`SELECT COUNT(*) n FROM appointments
      WHERE client_id = ? AND plan_id = ? AND substr(date,1,4) = ? AND status IN ${COUNTED_SQL}`)
    .get(Number(clientId), Number(planId), y).n;
  const adj = db.prepare('SELECT * FROM plan_usage_adjustments WHERE client_id = ? AND plan_id = ? AND year = ?')
    .get(Number(clientId), Number(planId), y);
  const plan = getPlan(planId);
  const total = used + (adj ? adj.used_offset : 0);
  const quota = plan ? plan.quota_per_year : 0;
  return {
    year: y,
    plan_id: Number(planId),
    plan_name: plan ? plan.name : '',
    quota,
    used_system: used,
    used_offset: adj ? adj.used_offset : 0,
    used: total,
    remaining: quota ? Math.max(0, quota - total) : null,
    over: !!(quota && total >= quota),
    note: adj ? adj.note : ''
  };
}

// 個案所有「有次數限制」方案的使用情形，供個案頁與預約時顯示
function clientUsageAll(clientId, year) {
  const y = String(year || new Date().getFullYear());
  const plans = db.prepare('SELECT * FROM service_plans WHERE quota_per_year > 0 AND active = 1 ORDER BY sort, id').all();
  return plans.map(p => clientUsage(clientId, p.id, y)).filter(u => u.used > 0 || u.quota > 0);
}

// ---- 心理師在某方案的人次負載 ----
// 週以「週一起算」計，與班表、後台週檢視一致。
function weekRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;          // 0 = 週一
  const start = new Date(d); start.setDate(d.getDate() - dow);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const f = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: f(start), end: f(end) };
}

// 線上預約的最早可約日：除了「最快幾天後」，再加一道「前一天幾點截止」。
// 例如截止 21:00：20:59 還約得到明天，21:00 之後明天就整天關閉，
// 避免有人深夜下訂隔天早上、櫃檯來不及看到，個案卻以為預約成立直接跑來。
function earliestBookableDate(leadDays) {
  const lead = Number(leadDays !== undefined ? leadDays : getSetting('booking_lead_days', '1')) || 0;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const addD = (d, n) => {
    const x = new Date(d + 'T00:00:00');
    x.setDate(x.getDate() + n);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  };
  let min = addD(todayStr, lead);
  const cutoff = String(getSetting('booking_cutoff_time', '')).trim();
  if (/^\d{2}:\d{2}$/.test(cutoff)) {
    const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // 已過今天的截止時間 → 最早只能約後天（即「隔天」已關閉）
    if (nowHm >= cutoff && min <= addD(todayStr, 1)) min = addD(todayStr, 2);
  }
  return min;
}

// 某個時段是否還收得到線上預約：除了「最早可約日」，再加一道「晤談前至少幾小時」。
// 兩個門檻同時生效，取較嚴格者；回傳空字串表示可以，否則回傳擋下的理由。
function bookingCutoffReason(date, startTime) {
  const min = earliestBookableDate();
  if (date < min) {
    const cutoff = getSetting('booking_cutoff_time', '');
    return `此時段已截止線上預約（最早可約 ${min}`
      + (cutoff ? `；前一天 ${cutoff} 後即關閉隔天時段` : '') + '）';
  }
  const hours = Number(getSetting('booking_cutoff_hours', '0')) || 0;
  if (hours > 0 && /^\d{2}:\d{2}$/.test(String(startTime || ''))) {
    const startAt = new Date(`${date}T${startTime}:00`);
    if (startAt.getTime() - Date.now() < hours * 3600 * 1000) {
      return `線上預約須於晤談開始前 ${hours} 小時完成，此時段已截止`;
    }
  }
  return '';
}

// 未到（no_show）要收多少：所內同意書多半寫「行政規費 X 元」這種固定金額，
// 但也有依比例收的做法。設定了固定金額就以它為準，否則回到比例。
// 回傳 { amount, note, fixed }，各處共用同一套算法，畫面與帳才不會各算各的。
function noShowCharge(fee) {
  const fixed = Math.max(0, Math.round(Number(getSetting('no_show_fee_fixed', '0')) || 0));
  const base = Math.max(0, Math.round(Number(fee) || 0));
  if (fixed > 0) {
    // 原費用低於固定規費時只收原費用，不會出現「收得比原價貴」
    const amount = Math.min(fixed, base || fixed);
    return { amount, fixed: true, rate: base ? amount / base : 0, note: `未到行政規費 ${amount} 元` };
  }
  const rate = Number(getSetting('no_show_fee_rate', '0.5')) || 0;
  return { amount: Math.round(base * rate), fixed: false, rate, note: `原費用 ${base} 之 ${Math.round(rate * 100)}%` };
}

function counselorLoad(counselorId, planId, dateStr, excludeApptId) {
  const plan = getPlan(planId);
  const rate = getRate(planId, counselorId, null);
  const wk = weekRange(dateStr);
  const month = dateStr.slice(0, 7);
  const ex = excludeApptId ? Number(excludeApptId) : 0;

  const weekUsed = db.prepare(`SELECT COUNT(*) n FROM appointments
      WHERE counselor_id = ? AND plan_id = ? AND date BETWEEN ? AND ? AND status IN ${COUNTED_SQL} AND id != ?`)
    .get(Number(counselorId), Number(planId), wk.start, wk.end, ex).n;
  const monthUsed = db.prepare(`SELECT COUNT(*) n FROM appointments
      WHERE counselor_id = ? AND plan_id = ? AND substr(date,1,7) = ? AND status IN ${COUNTED_SQL} AND id != ?`)
    .get(Number(counselorId), Number(planId), month, ex).n;

  // 人工調整的已用人次（他所已接、系統外排的場次），加在系統統計之上
  const adj = (type, key) => (db.prepare(`SELECT used_offset FROM plan_counselor_usage_adj
    WHERE plan_id = ? AND counselor_id = ? AND period_type = ? AND period_key = ?`)
    .get(Number(planId), Number(counselorId), type, key) || {}).used_offset || 0;
  const weekOffset = adj('week', wk.start);
  const monthOffset = adj('month', month);

  // -1 表示沿用方案設定；方案為 0 則再退回系統預設值
  const pick = (rateVal, planVal, settingKey) => {
    if (rateVal !== undefined && rateVal !== null && rateVal >= 0) return rateVal;
    if (planVal > 0) return planVal;
    return Number(getSetting(settingKey, '0')) || 0;
  };
  const weekLimit = pick(rate ? rate.week_limit : -1, plan ? plan.counselor_week_limit : 0, 'plan_default_week_limit');
  const monthLimit = pick(rate ? rate.month_limit : -1, plan ? plan.counselor_month_limit : 0, 'plan_default_month_limit');

  const weekTotal = weekUsed + weekOffset;
  const monthTotal = monthUsed + monthOffset;
  return {
    week_start: wk.start, week_end: wk.end, month,
    week_used: weekTotal, week_limit: weekLimit,
    week_system_used: weekUsed, week_offset: weekOffset,
    week_remaining: weekLimit ? Math.max(0, weekLimit - weekTotal) : null,
    month_used: monthTotal, month_limit: monthLimit,
    month_system_used: monthUsed, month_offset: monthOffset,
    month_remaining: monthLimit ? Math.max(0, monthLimit - monthTotal) : null,
    week_full: !!(weekLimit && weekTotal >= weekLimit),
    month_full: !!(monthLimit && monthTotal >= monthLimit)
  };
}

// 下週同一心理師同方案還剩幾人次：本週滿了要能直接告訴櫃檯「改約下週」
function nextWeekHint(counselorId, planId, dateStr) {
  const wk = weekRange(dateStr);
  const d = new Date(wk.start + 'T00:00:00');
  d.setDate(d.getDate() + 7);
  const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const load = counselorLoad(counselorId, planId, next);
  return { date: next, week_start: load.week_start, week_end: load.week_end,
    used: load.week_used, limit: load.week_limit, remaining: load.week_remaining };
}

// 預約前檢查：年齡資格、個案年度額度、心理師人次上限。
// errors 會擋下預約（可由 override 放行並留稽核），warnings 只提醒。
function checkBooking({ plan_id, client, counselor_id, date, appointment_id, birth_date }) {
  const plan = getPlan(plan_id);
  const out = { errors: [], warnings: [], usage: null, load: null, next_week: null };
  if (!plan) return out;

  const bd = (client && client.birth_date) || birth_date || '';
  const age = ageYears(bd, date);
  if ((plan.age_min || plan.age_max) && bd) {
    if (plan.age_min && age < plan.age_min) out.errors.push(`${plan.name}限 ${plan.age_min} 歲以上（目前 ${age} 歲）`);
    if (plan.age_max && age > plan.age_max) out.errors.push(`${plan.name}限 ${plan.age_max} 歲以下（目前 ${age} 歲）`);
  } else if ((plan.age_min || plan.age_max) && !bd) {
    out.warnings.push(`${plan.name}有年齡限制（${plan.age_min || 0}-${plan.age_max || '不限'} 歲），此個案未填生日，請先確認資格`);
  }

  if (client && plan.quota_per_year > 0) {
    const usage = clientUsage(client.id, plan.id, String(date || '').slice(0, 4));
    out.usage = usage;
    // 本筆預約本身要算進去，所以判斷「已用 >= 額度」即為超額
    if (usage.over) {
      out.errors.push(`${client.name} ${usage.year} 年的「${plan.name}」已使用 ${usage.used}/${usage.quota} 次，額度已用完`);
    } else if (usage.remaining === 1) {
      out.warnings.push(`這是 ${client.name} ${usage.year} 年「${plan.name}」的最後 1 次（已用 ${usage.used}/${usage.quota}）`);
    }
  }

  if (counselor_id && date) {
    const load = counselorLoad(counselor_id, plan.id, date, appointment_id);
    out.load = load;
    if (load.week_full) {
      out.next_week = nextWeekHint(counselor_id, plan.id, date);
      out.errors.push(`該心理師本週（${load.week_start}~${load.week_end}）的「${plan.name}」已排滿 ${load.week_used}/${load.week_limit} 人次`);
    }
    if (load.month_full) {
      out.errors.push(`該心理師本月（${load.month}）的「${plan.name}」已排滿 ${load.month_used}/${load.month_limit} 人次`);
    }
  }
  return out;
}

// 未指定諮商室時自動指派：個案端與線上表單一律看不到空間配置，
// 由系統挑一間該時段沒被占用的諮商室（只有 2-3 間，取編號最小的即可）。
function pickRoom({ date, start_time, end_time, exclude_appointment_id }) {
  if (getSetting('room_auto_assign', '1') !== '1') return null;
  const rooms = db.prepare('SELECT * FROM rooms WHERE active = 1 ORDER BY id').all();
  if (!rooms.length) return null;
  const busy = new Set(db.prepare(`SELECT room_id FROM appointments
      WHERE date = ? AND status IN ('booked','arrived') AND start_time < ? AND end_time > ?
        AND room_id IS NOT NULL AND id != ?`)
    .all(date, end_time, start_time, Number(exclude_appointment_id) || 0).map(r => r.room_id));
  // 團體場次也會占用空間，只有 2-3 間時漏算就會兩組人撞在同一間
  for (const r of db.prepare(`SELECT room_id FROM group_sessions
      WHERE date = ? AND status != 'cancelled' AND start_time < ? AND end_time > ? AND room_id IS NOT NULL`)
    .all(date, end_time, start_time)) busy.add(r.room_id);
  const free = rooms.find(r => !busy.has(r.id));
  return free ? free.id : null;
}

module.exports = {
  defaultSessionMinutes, sessionMinutes, endTime,
  COUNTED_STATUSES, getPlan, getTopic, getRate, parseOptions, resolveFee, resolveAssignType, shareOf,
  clientUsage, clientUsageAll, counselorLoad, nextWeekHint, weekRange, checkBooking, pickRoom, noShowCharge,
  earliestBookableDate, bookingCutoffReason
};
