// 預約異動紀錄（見 db.js 的 appointment_events）。
// 每個會改動預約的地方呼叫一次 logApptEvent；寫入失敗只記 log，不讓主要流程跟著失敗 ——
// 預約本身成立與否比「工作台少一行」重要得多。

const { db } = require('./db');

function logApptEvent(e) {
  try {
    const appt = e.appointment_id
      ? db.prepare('SELECT client_id, counselor_id, date, start_time FROM appointments WHERE id = ?').get(e.appointment_id)
      : null;
    const clientId = e.client_id || (appt && appt.client_id) || null;
    if (!clientId) return;
    db.prepare(`INSERT INTO appointment_events
      (client_id, counselor_id, appointment_id, booking_request_id, kind, date, start_time,
       from_date, from_time, actor_type, actor_name, via, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      clientId,
      e.counselor_id || (appt && appt.counselor_id) || null,
      e.appointment_id || null, e.booking_request_id || null, e.kind,
      e.date || (appt && appt.date) || '', e.start_time || (appt && appt.start_time) || '',
      e.from_date || '', e.from_time || '',
      e.actor_type || 'staff', e.actor_name || '', e.via || '', String(e.note || '').slice(0, 200));
  } catch (err) {
    console.error('預約異動紀錄寫入失敗：', err.message);
  }
}

module.exports = { logApptEvent };
