// 行事曆訂閱（iCalendar / .ics）
//
// 心理師多半用手機日曆看班表。訂閱網址不走 Cookie 驗證（日曆 App 無法登入），
// 改以每位心理師一組隨機 token；因此輸出內容刻意「去識別化」：
// 只帶個案編號、晤談類型與地點，不含姓名、電話、主訴或任何晤談內容。
// token 可隨時重設，舊網址即刻失效。

const crypto = require('crypto');
const { db, today, addDays, getSetting } = require('./db');

function newToken() { return crypto.randomBytes(24).toString('hex'); }

// 取得（必要時建立）某位心理師的訂閱 token
function ensureToken(userId) {
  const u = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
  if (u && u.calendar_token) return u.calendar_token;
  const t = newToken();
  db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(t, userId);
  return t;
}
function resetToken(userId) {
  const t = newToken();
  db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(t, userId);
  return t;
}

// RFC 5545：逗號、分號、反斜線需跳脫，換行以 \n 表示
function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function stamp(date, time) {
  return `${date.replace(/-/g, '')}T${String(time || '00:00').replace(':', '')}00`;
}
// 超過 75 位元組需折行，否則部分日曆 App 會讀不到
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 73) return line;
  const out = [];
  let cur = Buffer.alloc(0);
  for (const ch of line) {
    const b = Buffer.from(ch, 'utf8');
    if (cur.length + b.length > 73) { out.push(cur.toString('utf8')); cur = Buffer.alloc(0); }
    cur = Buffer.concat([cur, b]);
  }
  out.push(cur.toString('utf8'));
  return out.join('\r\n ');
}

const TYPE_TW = {
  intake: '初談', individual: '個別諮商', couple: '伴侶諮商',
  family: '家族諮商', group: '團體諮商', assessment: '心理衡鑑'
};

function buildCalendar(token) {
  const u = db.prepare('SELECT * FROM users WHERE calendar_token = ? AND active = 1').get(token);
  if (!u) return null;
  const from = addDays(today(), -30);
  const to = addDays(today(), 180);
  const center = getSetting('center_name', '織心心理治療所');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Knit//Schedule//ZH-TW',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(center + '－' + u.name + ' 班表')}`,
    'X-WR-TIMEZONE:Asia/Taipei',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Taipei', 'BEGIN:STANDARD',
    'DTSTART:19700101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST',
    'END:STANDARD', 'END:VTIMEZONE'
  ];
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ev = ({ uid, date, start, end, summary, desc, location, allDay, endDate }) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@mindcare`, `DTSTAMP:${now}`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${addDays(endDate || date, 1).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART;TZID=Asia/Taipei:${stamp(date, start)}`, `DTEND;TZID=Asia/Taipei:${stamp(date, end)}`);
    }
    lines.push(fold(`SUMMARY:${esc(summary)}`));
    if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
    if (location) lines.push(fold(`LOCATION:${esc(location)}`));
    lines.push('END:VEVENT');
  };

  // 個別晤談：以個案編號代替姓名
  for (const a of db.prepare(`SELECT a.*, c.code AS client_code, r.name AS room_name
    FROM appointments a LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN rooms r ON r.id = a.room_id
    WHERE a.counselor_id = ? AND a.date BETWEEN ? AND ? AND a.status != 'cancelled'
    ORDER BY a.date, a.start_time`).all(u.id, from, to)) {
    ev({
      uid: `appt-${a.id}`, date: a.date, start: a.start_time, end: a.end_time,
      summary: `${TYPE_TW[a.type] || '晤談'} ${a.client_code || ''}${a.status === 'no_show' ? '（未到）' : ''}`,
      desc: a.mode === 'online' ? `視訊晤談${a.meeting_url ? '\n' + a.meeting_url : ''}` : '',
      location: a.mode === 'online' ? '視訊' : (a.room_name || center)
    });
  }
  // 團體場次
  for (const g of db.prepare(`SELECT s.*, gr.name AS group_name, r.name AS room_name
    FROM group_sessions s JOIN groups gr ON gr.id = s.group_id LEFT JOIN rooms r ON r.id = s.room_id
    WHERE (gr.counselor_id = ? OR gr.co_counselor_id = ?) AND s.date BETWEEN ? AND ? AND s.status != 'cancelled'`)
    .all(u.id, u.id, from, to)) {
    ev({
      uid: `gs-${g.id}`, date: g.date, start: g.start_time, end: g.end_time,
      summary: `團體：${g.group_name}（第 ${g.session_no} 次）`,
      location: g.room_name || center
    });
  }
  // 請假／不可預約
  for (const t of db.prepare(`SELECT * FROM time_off WHERE counselor_id = ? AND end_date >= ? AND start_date <= ?`)
    .all(u.id, from, to)) {
    ev({
      uid: `off-${t.id}`, date: t.start_date, endDate: t.end_date, allDay: !!t.all_day,
      start: t.start_time || '00:00', end: t.end_time || '23:59',
      summary: `請假${t.reason ? '：' + t.reason : ''}`
    });
  }
  lines.push('END:VCALENDAR');
  return { user: u, body: lines.join('\r\n') + '\r\n' };
}

module.exports = { ensureToken, resetToken, buildCalendar };
