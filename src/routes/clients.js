const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { db, audit, today, nowStamp, nextClientCode, ageYears, getSetting, UPLOAD_DIR } = require('../db');
const { requireStaff, requireAdmin, canViewClientNotes, clientIp } = require('../auth');

const { createCloseFollowUps } = require('./aftercare');
const { ageGroupOf, clientPlanIds, parsePlanIds, assignedKeys, consentsForClient } = require('../consents');

const router = express.Router();

const CLIENT_FIELDS = [
  'name', 'id_no', 'gender', 'birth_date', 'phone', 'email', 'address', 'occupation', 'education', 'marital',
  'source', 'referrer', 'partner_id', 'counselor_id', 'status', 'risk_level', 'main_issue', 'history', 'diagnosis',
  'is_minor', 'guardian_name', 'guardian_relationship', 'guardian_phone',
  'emergency_name', 'emergency_relationship', 'emergency_phone', 'note',
  'intake_date', 'close_date', 'close_reason', 'portal_enabled',
  // 指定案／派案：年報表類別代碼要分這兩種（自費 0／1、機構 30／31）
  'assign_type',
  // 兒少個案的就學資料（未成年基本資料表、早療補助表單會用到）
  'school', 'grade'
];

function pick(body) {
  const out = {};
  for (const f of CLIENT_FIELDS) {
    if (body[f] === undefined) continue;
    out[f] = ['counselor_id', 'partner_id'].includes(f) ? (Number(body[f]) || null)
      : ['is_minor', 'portal_enabled'].includes(f) ? (body[f] ? 1 : 0)
        : String(body[f] ?? '');
  }
  if (out.id_no) out.id_no = out.id_no.toUpperCase().trim();
  return out;
}

// 民法成年年齡（112 年起為 18 歲）：有生日就依生日判定，避免漏勾而跳過法定代理人同意書。
// 受監護宣告者仍需人工勾選，故只在「未滿成年」時強制設 1，不會把人工勾選的成年案改回 0。
function applyMinor(data, birthDate) {
  const bd = data.birth_date || birthDate || '';
  if (!bd) return;
  const age = ageYears(bd);
  if (age !== null && age < Number(getSetting('adult_age', '18'))) data.is_minor = 1;
}

// 身分證統一編號格式檢核（A123456789）；居留證號等其他格式僅存不檢核
function idNoWarning(idNo) {
  if (!idNo) return '';
  if (!/^[A-Z][12]\d{8}$/.test(idNo)) return '';
  const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const n = letters.indexOf(idNo[0]) + 10;
  let sum = Math.floor(n / 10) + (n % 10) * 9;
  for (let i = 1; i < 9; i++) sum += Number(idNo[i]) * (9 - i);
  sum += Number(idNo[9]);
  return sum % 10 === 0 ? '' : '身分證統一編號檢查碼不符，請確認是否輸入錯誤';
}

// 個案清單：諮商師預設只看自己的個案，可切換全所（僅顯示基本欄位，不含晤談內容）
// 清單只回畫表格要用的欄位。個案數上千時，`SELECT c.*` 會把病史、住址、
// 甚至個案端的密碼雜湊一起送到每個櫃檯的瀏覽器，既慢也不該給。
const CLIENT_LIST_COLUMNS = `c.id, c.code, c.name, c.gender, c.birth_date, c.phone,
  c.counselor_id, c.status, c.risk_level, c.is_minor, c.portal_enabled, c.created_at`;

function clientListWhere(query) {
  const { status = '', q = '', counselor_id = '', risk = '' } = query;
  const where = ['c.active = 1'], args = [];
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (risk) { where.push('c.risk_level = ?'); args.push(risk); }
  if (counselor_id) { where.push('c.counselor_id = ?'); args.push(Number(counselor_id)); }
  if (q) { where.push('(c.name LIKE ? OR c.code LIKE ? OR c.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return { sql: where.join(' AND '), args };
}

router.get('/clients', requireStaff('clients'), (req, res) => {
  const { sql, args } = clientListWhere(req.query);
  // 分頁：預設一頁 100 筆。舊呼叫端沒帶 page 時行為不變（拿到第一頁與總筆數）
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM clients c WHERE ${sql}`).get(...args).n;
  const rows = db.prepare(`
    SELECT ${CLIENT_LIST_COLUMNS}, u.name AS counselor_name,
      (SELECT COUNT(*) FROM session_notes n WHERE n.client_id = c.id) AS note_count,
      (SELECT MAX(date) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS last_session,
      (SELECT MIN(date) FROM appointments a WHERE a.client_id = c.id AND a.date >= date('now','localtime') AND a.status IN ('booked','arrived')) AS next_session
    FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
    WHERE ${sql} ORDER BY c.status = 'closed', c.created_at DESC
    LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
  const list = rows.map(r => ({ ...r, age: ageYears(r.birth_date) }));
  // 帶 page 的呼叫端要分頁資訊；沒帶的（舊版前端、匯出）維持拿到陣列
  if (req.query.page || req.query.limit) return res.json({ rows: list, total, page, limit });
  res.json(list);
});

// 下拉選單專用：只回 id／編號／姓名，2900 筆約 100 KB，不必為了選個人載整包個案資料
router.get('/clients/options', requireStaff('clients'), (req, res) => {
  const { sql, args } = clientListWhere(req.query);
  res.json(db.prepare(`SELECT c.id, c.code, c.name FROM clients c
    WHERE ${sql} ORDER BY c.status = 'closed', c.name`).all(...args));
});

// 重複個案：舊資料匯入時同一個人被開了兩個以上案號，排約時要挑很久，
// 統計與額度也會被拆開算。這支把疑似重複的整理出來，附各自的預約與紀錄筆數供人工判斷。
router.get('/clients/duplicates', requireStaff('clients'), (req, res) => {
  const rows = db.prepare(`SELECT c.id, c.code, c.name, c.phone, c.id_no, c.birth_date, c.status,
      c.counselor_id, u.name AS counselor_name,
      (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id) AS appointments,
      (SELECT COUNT(*) FROM session_notes n WHERE n.client_id = c.id) AS notes,
      (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id) AS invoices,
      (SELECT MAX(a.date) FROM appointments a WHERE a.client_id = c.id) AS last_appointment
    FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
    WHERE c.active = 1 AND c.merged_into IS NULL ORDER BY c.name, c.code`).all();
  const groups = [];
  const push = (key, kind, list) => {
    if (list.length < 2) return;
    groups.push({ key, kind, clients: list });
  };
  const byName = new Map();
  const byPhone = new Map();
  const byIdNo = new Map();
  for (const c of rows) {
    if (c.name) byName.set(c.name, (byName.get(c.name) || []).concat(c));
    const ph = String(c.phone || '').replace(/\D/g, '');
    if (ph.length >= 8) byPhone.set(ph, (byPhone.get(ph) || []).concat(c));
    if (c.id_no) byIdNo.set(c.id_no, (byIdNo.get(c.id_no) || []).concat(c));
  }
  // 身分證字號一樣幾乎可以確定是同一人，優先列出
  for (const [idno, list] of byIdNo) push(idno, '同身分證字號', list);
  for (const [name, list] of byName) push(name, '同姓名', list);
  for (const [phone, list] of byPhone) {
    // 同手機但不同姓名才另外列（同姓名的已在上面）
    if (new Set(list.map(c => c.name)).size > 1) push(phone, '同手機', list);
  }
  groups.sort((a, b) => b.clients.length - a.clients.length || a.key.localeCompare(b.key));
  res.json({ total: groups.length, groups });
});

router.get('/clients/:id', requireStaff('clients'), (req, res) => {
  const c = db.prepare(`SELECT c.*, u.name AS counselor_name, p.name AS partner_name FROM clients c
    LEFT JOIN users u ON u.id = c.counselor_id
    LEFT JOIN partners p ON p.id = c.partner_id WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  delete c.password_hash;
  const consents = db.prepare('SELECT id, key, title, agreed, signer_name, signer_role, version, signed_at FROM consents WHERE client_id = ? ORDER BY signed_at DESC').all(c.id);
  const templates = db.prepare('SELECT * FROM consent_templates ORDER BY sort, id').all()
    .filter(t => !t.minor_only || c.is_minor);
  res.json({
    ...c,
    age: ageYears(c.birth_date),
    can_view_notes: canViewClientNotes(req.user, c),
    consents,
    age_group: ageGroupOf(c.birth_date),
    plan_ids: clientPlanIds(c.id),
    // 逐案指派的同意書 key；有指派時個案專區只列這幾張，空陣列表示照年齡與方案自動判斷
    assigned_consents: assignedKeys(c.id),
    pending_consents: consentsForClient(c)
      .filter(t => !consents.some(s => s.key === t.key && s.version === t.version))
      .map(t => ({ key: t.key, title: t.title })),
    appointments: db.prepare(`SELECT a.*, u.name AS counselor_name, sp.name AS plan_name FROM appointments a
      LEFT JOIN users u ON u.id = a.counselor_id
      LEFT JOIN service_plans sp ON sp.id = a.plan_id
      WHERE a.client_id = ? ORDER BY a.date DESC, a.start_time DESC LIMIT 30`).all(c.id),
    // 可代訂的家人，以及「誰可以替這位個案訂」——兩個方向櫃檯都要看得到
    family: familyOf(c.id),
    family_of: db.prepare(`SELECT f.id, f.relationship, f.can_book, c.id AS client_id, c.name, c.code
      FROM client_family f JOIN clients c ON c.id = f.client_id WHERE f.member_id = ?`).all(c.id),
    // 這位個案用到的方案若須在補助單位系統另行註冊／簽到（如國軍方案），把網址一併帶出來
    plan_links: db.prepare(`SELECT DISTINCT sp.id, sp.name, sp.register_url, sp.signin_url
      FROM appointments a JOIN service_plans sp ON sp.id = a.plan_id
      WHERE a.client_id = ? AND (sp.register_url != '' OR sp.signin_url != '')`).all(c.id),
    assessments: db.prepare('SELECT id, scale, date, total, severity, alert, filled_by FROM assessments WHERE client_id = ? ORDER BY date DESC').all(c.id),
    packages: db.prepare('SELECT * FROM packages WHERE client_id = ? ORDER BY id DESC').all(c.id),
    invoices: db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY date DESC, id DESC LIMIT 30').all(c.id),
    risk_events: db.prepare('SELECT * FROM risk_events WHERE client_id = ? ORDER BY date DESC').all(c.id),
    unpaid: db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM invoices WHERE client_id = ? AND status = 'unpaid'").get(c.id).n,
    groups: db.prepare(`SELECT g.id, g.name, g.status, m.status AS member_status FROM group_members m
      JOIN groups g ON g.id = m.group_id WHERE m.client_id = ?`).all(c.id)
  });
});

// 個案專區以手機號碼當帳號，兩位個案填同一支號碼會登入到別人的資料，
// 因此建檔與修改時都擋下重複（家人共用號碼的情形請留空，改由櫃檯代為操作）。
function phoneTaken(phone, excludeId) {
  const p = String(phone || '').trim();
  if (!p) return null;
  return db.prepare(`SELECT name, code FROM clients WHERE phone = ? AND active = 1 AND id != ?`)
    .get(p, Number(excludeId) || 0);
}

router.post('/clients', requireStaff('clients'), (req, res) => {
  const data = pick(req.body);
  if (!data.name) return res.status(400).json({ error: '請填寫姓名' });
  const dup = phoneTaken(data.phone);
  if (dup) {
    return res.status(400).json({ error: `手機 ${data.phone} 已是「${dup.name}（${dup.code}）」的號碼；`
      + '個案專區以手機登入，重複會登入到別人的資料。如為家人共用，請將此欄留空。' });
  }
  data.code = req.body.code || nextClientCode();
  if (db.prepare('SELECT 1 FROM clients WHERE code = ?').get(data.code)) {
    return res.status(400).json({ error: '個案編號重複' });
  }
  if (!data.intake_date) data.intake_date = today();
  applyMinor(data);
  const warn = idNoWarning(data.id_no);
  // 個案端預設密碼為手機末 6 碼（首次登入強制更換）
  const phone = (data.phone || '').replace(/\D/g, '');
  data.password_hash = phone.length >= 6 ? bcrypt.hashSync(phone.slice(-6), 10) : '';
  const cols = Object.keys(data);
  const info = db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(k => data[k]));
  audit('staff', req.user.id, req.user.name, '新增個案', data.code);
  res.json({ id: info.lastInsertRowid, code: data.code, warning: warn });
});

router.put('/clients/:id', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const data = pick(req.body);
  if (!Object.keys(data).length) return res.json({ ok: true });
  if (data.phone !== undefined) {
    const dup = phoneTaken(data.phone, c.id);
    if (dup) {
      return res.status(400).json({ error: `手機 ${data.phone} 已是「${dup.name}（${dup.code}）」的號碼；`
        + '個案專區以手機登入，重複會登入到別人的資料。如為家人共用，請將此欄留空。' });
    }
  }
  if (data.status === 'closed' && !data.close_date) data.close_date = today();
  applyMinor(data, c.birth_date);
  const warn = idNoWarning(data.id_no);
  db.prepare(`UPDATE clients SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), c.id);
  audit('staff', req.user.id, req.user.name, '修改個案資料', c.code);
  // 由未結案轉為結案時，依系統設定自動建立結案後的關懷追蹤點
  let followUps = 0;
  if (data.status === 'closed' && c.status !== 'closed') {
    followUps = createCloseFollowUps({ ...c, ...data }, req.user.id);
  }
  res.json({ ok: true, warning: warn, follow_ups: followUps });
});

// 停用（軟刪除）：心理紀錄依規定需保存，不提供實體刪除。
// 未來的預約要一併取消，否則會繼續佔用心理師時段與諮商室，排班表上出現已結案個案的幽靈預約。
// 永久刪除個案（僅管理者，且必須明確帶 purge=1）。
// 用途是清掉展示資料或誤建、重複的資料；正式個案請用停用（保留歷史紀錄）。
// 相關資料多數設有 ON DELETE CASCADE，沒有的四張表在此一併清理，附件實體檔也刪掉。
router.delete('/clients/:id/purge', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const counts = {};
  for (const t of ['appointments', 'session_notes', 'invoices', 'receipts', 'assessments', 'attachments']) {
    counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE client_id = ?`).get(c.id).n;
  }
  // 附件實體檔：資料列會被 CASCADE 刪掉，檔案要自己清
  const files = db.prepare('SELECT stored_name FROM attachments WHERE client_id = ?').all(c.id);
  db.transaction(() => {
    // 這四張表沒有 CASCADE，先解除關聯再刪個案
    db.prepare('UPDATE supervisions SET client_id = NULL WHERE client_id = ?').run(c.id);
    db.prepare('UPDATE intakes SET client_id = NULL WHERE client_id = ?').run(c.id);
    db.prepare('DELETE FROM notifications WHERE client_id = ?').run(c.id);
    // 預約與線上預約申請互相指來指去（appointments.booking_request_id、
    // booking_requests.appointment_id），兩個外鍵都沒有 CASCADE，
    // 因此先把雙向關聯解開，再刪申請與個案。
    db.prepare(`UPDATE appointments SET booking_request_id = NULL
      WHERE client_id = ?`).run(c.id);
    db.prepare(`UPDATE booking_requests SET appointment_id = NULL
      WHERE appointment_id IN (SELECT id FROM appointments WHERE client_id = ?)`).run(c.id);
    db.prepare('DELETE FROM booking_requests WHERE client_id = ?').run(c.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
  })();
  for (const f of files) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(f.stored_name))); } catch (e) { /* 檔案已不在 */ }
  }
  audit('staff', req.user.id, req.user.name, '永久刪除個案', c.code, { name: c.name, ...counts });
  res.json({ ok: true, code: c.code, name: c.name, removed: counts });
});

router.delete('/clients/:id', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  let cancelled = 0;
  db.transaction(() => {
    db.prepare("UPDATE clients SET active = 0, status = 'closed', close_date = CASE WHEN close_date = '' THEN ? ELSE close_date END WHERE id = ?")
      .run(today(), c.id);
    const info = db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = '個案停用'
      WHERE client_id = ? AND status IN ('booked','arrived') AND date >= ?`).run(c.id, today());
    cancelled = info.changes;
    // 未完成的團體成員身分一併標記退出
    db.prepare("UPDATE group_members SET status = 'dropped' WHERE client_id = ? AND status = 'active'").run(c.id);
  })();
  const followUps = c.status !== 'closed'
    ? createCloseFollowUps({ ...c, status: 'closed', close_date: c.close_date || today() }, req.user.id)
    : 0;
  audit('staff', req.user.id, req.user.name, '停用個案', c.code, { cancelled_appointments: cancelled });
  res.json({ ok: true, cancelled_appointments: cancelled, follow_ups: followUps });
});

// 重設個案端密碼為手機末 6 碼
router.post('/clients/:id/reset-password', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const phone = (c.phone || '').replace(/\D/g, '');
  if (phone.length < 6) return res.status(400).json({ error: '個案未留存有效手機號碼，無法重設' });
  db.prepare('UPDATE clients SET password_hash = ?, must_change_password = 1 WHERE id = ?')
    .run(bcrypt.hashSync(phone.slice(-6), 10), c.id);
  audit('staff', req.user.id, req.user.name, '重設個案端密碼', c.code);
  res.json({ ok: true, password: phone.slice(-6) });
});

// ---- 同意書 ----

router.get('/consent-templates', requireStaff(), (req, res) => {
  res.json(db.prepare('SELECT * FROM consent_templates ORDER BY sort, id').all());
});

// 逐案指派同意書：櫃檯直接指定這位個案要簽哪幾張（空陣列＝清除指派，回到年齡與方案自動判斷）。
router.put('/clients/:id/consent-assignments', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const valid = new Set(db.prepare('SELECT key FROM consent_templates').all().map(r => r.key));
  const keys = [...new Set((Array.isArray(req.body?.keys) ? req.body.keys : [])
    .map(k => String(k)).filter(k => valid.has(k)))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM client_consents WHERE client_id = ?').run(c.id);
    const ins = db.prepare('INSERT INTO client_consents (client_id, key, assigned_by) VALUES (?,?,?)');
    for (const k of keys) ins.run(c.id, k, req.user.id);
  });
  tx();
  audit('staff', req.user.id, req.user.name, keys.length ? '指派同意書' : '清除同意書指派', c.code, { keys });
  res.json({ ok: true, keys });
});

// ---- 家人代訂授權 ----
// 家長要在專區替孩子排時間、或一方要替伴侶排，都是「替另一筆個案預約」。
// 每個人仍是獨立的個案（各自的病歷、紀錄與收費），這裡只授權「誰能替誰排時間」，
// 而且只有櫃檯能建立——不讓任何人自行宣稱是誰的家屬。
router.get('/clients/:id/family', requireStaff('clients'), (req, res) => {
  res.json(familyOf(req.params.id));
});
function familyOf(clientId) {
  return db.prepare(`SELECT f.id, f.member_id, f.relationship, f.can_book, f.note,
      c.name AS member_name, c.code AS member_code, c.active AS member_active
    FROM client_family f JOIN clients c ON c.id = f.member_id
    WHERE f.client_id = ? ORDER BY c.name`).all(Number(clientId) || 0);
}
router.post('/clients/:id/family', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const memberId = Number(req.body?.member_id) || 0;
  const member = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(memberId);
  if (!member) return res.status(400).json({ error: '請選擇要授權代訂的家人（需為在案的個案）' });
  if (member.id === c.id) return res.status(400).json({ error: '不需授權替自己預約' });
  const dup = db.prepare('SELECT 1 FROM client_family WHERE client_id = ? AND member_id = ?').get(c.id, member.id);
  if (dup) return res.status(400).json({ error: `已授權可替${member.name}預約` });
  const info = db.prepare(`INSERT INTO client_family (client_id, member_id, relationship, can_book, note)
    VALUES (?,?,?,?,?)`).run(c.id, member.id, String(req.body?.relationship || '').slice(0, 20),
    req.body?.can_book === 0 || req.body?.can_book === false ? 0 : 1, String(req.body?.note || '').slice(0, 200));
  audit('staff', req.user.id, req.user.name, '授權家人代訂', c.code,
    { member: member.code, relationship: req.body?.relationship || '' });
  res.json({ id: info.lastInsertRowid, family: familyOf(c.id) });
});
router.put('/clients/:id/family/:fid', requireStaff('clients'), (req, res) => {
  const row = db.prepare('SELECT * FROM client_family WHERE id = ? AND client_id = ?')
    .get(req.params.fid, req.params.id);
  if (!row) return res.status(404).json({ error: '找不到此授權' });
  db.prepare('UPDATE client_family SET relationship = ?, can_book = ?, note = ? WHERE id = ?').run(
    req.body?.relationship === undefined ? row.relationship : String(req.body.relationship).slice(0, 20),
    req.body?.can_book === undefined ? row.can_book : (req.body.can_book ? 1 : 0),
    req.body?.note === undefined ? row.note : String(req.body.note).slice(0, 200), row.id);
  res.json({ ok: true, family: familyOf(row.client_id) });
});
router.delete('/clients/:id/family/:fid', requireStaff('clients'), (req, res) => {
  const row = db.prepare(`SELECT f.*, c.code, m.code AS member_code FROM client_family f
      JOIN clients c ON c.id = f.client_id JOIN clients m ON m.id = f.member_id
    WHERE f.id = ? AND f.client_id = ?`).get(req.params.fid, req.params.id);
  if (!row) return res.status(404).json({ error: '找不到此授權' });
  db.prepare('DELETE FROM client_family WHERE id = ?').run(row.id);
  audit('staff', req.user.id, req.user.name, '取消家人代訂授權', row.code, { member: row.member_code });
  res.json({ ok: true, family: familyOf(row.client_id) });
});

// 用不到的同意書範本：沒人簽過就刪掉，簽過的保留（簽署紀錄要對得回範本）
router.delete('/consent-templates/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此範本' });
  // 簽署紀錄以 key 對應範本，簽過的不能刪，否則舊簽署會找不到出處
  const signed = db.prepare('SELECT COUNT(*) n FROM consents WHERE key = ?').get(t.key).n;
  if (signed) {
    return res.status(400).json({ error: `已有 ${signed} 筆簽署紀錄，此範本不可刪除；如不再使用請改為非必要並改寫內容` });
  }
  db.prepare('DELETE FROM consent_templates WHERE id = ?').run(t.id);
  audit('staff', req.user.id, req.user.name, '刪除同意書範本', t.title);
  res.json({ ok: true, deactivated: false });
});

// 還原成系統內建的版本：改壞了或想回到原文時用；內容有變動一樣會遞增版本，
// 已簽署的舊版仍保留當時的全文快照，不受影響。
router.post('/consent-templates/:id/reset', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此範本' });
  const { CONSENT_TEMPLATE_DEFAULTS } = require('../db');
  const d = CONSENT_TEMPLATE_DEFAULTS.find(x => x.key === t.key);
  if (!d) return res.status(400).json({ error: '這是所方自建的範本，沒有系統預設可還原' });
  const center = getSetting('center_name', '本所');
  const phone = getSetting('center_phone', '');
  const fill = v => String(v || '').replace(/\{center\}/g, center).replace(/\{phone\}/g, phone);
  const body = fill(d.body);
  const version = body !== t.body ? t.version + 1 : t.version;
  db.prepare(`UPDATE consent_templates SET title = ?, body = ?, version = ?, required = ?, allow_decline = ?,
      minor_only = ?, sign_block = ?, copy_labels = ?, audience = ?, plan_ids = ? WHERE id = ?`)
    .run(d.title, body, version, d.required, d.allow_decline, d.minor_only,
      fill(d.sign_block), fill(d.copy_labels), d.audience || '', t.plan_ids, t.id);
  audit('staff', req.user.id, req.user.name, '還原同意書範本', t.key, { version });
  res.json({ ok: true, version });
});

router.put('/consent-templates/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此範本' });
  const { title = t.title, body = t.body, required, allow_decline, minor_only,
    sign_block = t.sign_block, copy_labels = t.copy_labels, audience = t.audience,
    plan_ids = t.plan_ids } = req.body || {};
  // 內容有變動即遞增版本，已簽署者需重新簽署新版（簽署欄只影響紙本版面，不動版本）
  const version = body !== t.body ? t.version + 1 : t.version;
  db.prepare(`UPDATE consent_templates SET title = ?, body = ?, version = ?, required = ?, allow_decline = ?,
      minor_only = ?, sign_block = ?, copy_labels = ?, audience = ?, plan_ids = ? WHERE id = ?`)
    .run(title, body, version,
      required === undefined ? t.required : (required ? 1 : 0),
      allow_decline === undefined ? t.allow_decline : (allow_decline ? 1 : 0),
      minor_only === undefined ? t.minor_only : (minor_only ? 1 : 0), String(sign_block || ''),
      String(copy_labels || ''), String(audience || ''),
      parsePlanIds(Array.isArray(plan_ids) ? plan_ids.join(',') : plan_ids).join(','), t.id);
  audit('staff', req.user.id, req.user.name, '修改同意書範本', t.key, { version });
  res.json({ ok: true, version });
});

// ---- 重複個案合併 ----
//
// 線上表單一個人用不同電話送兩次就會變成兩筆個案，紀錄與收費各自散在兩邊。
// 合併＝把「要併走的那筆」底下的資料全部改掛到「要留下的那筆」，
// 並把搬過哪幾列記在 client_merges.moved，需要時整批搬回去（還原）。
//
// 只搬資料、不刪除個案：被併走的個案改為停用並標記 merged_into，仍查得到。
const MERGE_TABLES = ['appointments', 'session_notes', 'treatment_plans', 'assessments', 'assessment_tasks',
  'risk_events', 'supervisions', 'consents', 'packages', 'invoices', 'messages', 'intakes',
  'group_members', 'group_attendance', 'attachments', 'notifications', 'assessment_reports',
  'safety_plans', 'referrals', 'follow_ups', 'refunds', 'plan_usage_adjustments', 'receipts',
  'booking_requests', 'line_bindings', 'certificates'];
// client_consents 不搬：它是 UNIQUE(client_id, key)，兩筆個案指派到同一張同意書時整批 UPDATE 會撞鍵。
// 指派只是「這位個案要簽哪幾張」的操作提示，留下的那筆維持自己的指派即可（被併走的已停用）。

router.post('/clients/:id/merge', requireStaff('clients'), (req, res) => {
  const keptId = Number(req.params.id);
  const mergedId = Number((req.body || {}).merged_id) || 0;
  if (keptId === mergedId) return res.status(400).json({ error: '不能跟自己合併' });
  const kept = db.prepare('SELECT * FROM clients WHERE id = ?').get(keptId);
  const merged = db.prepare('SELECT * FROM clients WHERE id = ?').get(mergedId);
  if (!kept || !merged) return res.status(404).json({ error: '找不到個案' });
  if (merged.merged_into) return res.status(400).json({ error: '這筆已經被合併過了' });

  const moved = {};
  db.transaction(() => {
    for (const t of MERGE_TABLES) {
      const ids = db.prepare(`SELECT id FROM ${t} WHERE client_id = ?`).all(mergedId).map(r => r.id);
      if (!ids.length) continue;
      db.prepare(`UPDATE ${t} SET client_id = ? WHERE client_id = ?`).run(keptId, mergedId);
      moved[t] = ids;
    }
    // 留下的那筆若缺欄位，用被併走的補齊（不覆蓋已填的）
    const fill = ['phone', 'email', 'address', 'id_no', 'birth_date', 'gender', 'guardian_name',
      'guardian_phone', 'emergency_name', 'emergency_phone', 'school', 'grade'];
    const patch = {};
    for (const f of fill) if (!kept[f] && merged[f]) patch[f] = merged[f];
    if (Object.keys(patch).length) {
      db.prepare(`UPDATE clients SET ${Object.keys(patch).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(patch), keptId);
    }
    db.prepare(`UPDATE clients SET active = 0, merged_into = ?, portal_enabled = 0,
        note = ? WHERE id = ?`)
      .run(keptId, (merged.note ? merged.note + '；' : '') + `已合併至 ${kept.code}`, mergedId);
    db.prepare(`INSERT INTO client_merges (kept_id, merged_id, kept_code, merged_code, merged_name, moved, operator_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run(keptId, mergedId, kept.code, merged.code, merged.name, JSON.stringify(moved), req.user.id);
  })();

  const counts = Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length]));
  audit('staff', req.user.id, req.user.name, '合併個案', `${merged.code} → ${kept.code}`, counts);
  res.json({ ok: true, moved: counts });
});

router.get('/client-merges', requireStaff('clients'), (req, res) => {
  res.json(db.prepare(`SELECT m.*, u.name AS operator_name FROM client_merges m
    LEFT JOIN users u ON u.id = m.operator_id ORDER BY m.id DESC LIMIT 100`).all()
    .map(m => ({ ...m, moved: JSON.parse(m.moved || '{}') })));
});

// 還原合併：把當初搬過去的那幾列原樣搬回來，個案重新啟用
router.post('/client-merges/:id/undo', requireStaff('clients'), (req, res) => {
  const m = db.prepare('SELECT * FROM client_merges WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '找不到此合併紀錄' });
  if (m.undone_at) return res.status(400).json({ error: '此合併已還原過' });
  let moved = {};
  try { moved = JSON.parse(m.moved || '{}'); } catch { moved = {}; }
  db.transaction(() => {
    for (const [t, ids] of Object.entries(moved)) {
      if (!MERGE_TABLES.includes(t) || !Array.isArray(ids) || !ids.length) continue;
      db.prepare(`UPDATE ${t} SET client_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(m.merged_id, ...ids);
    }
    db.prepare("UPDATE clients SET active = 1, merged_into = NULL WHERE id = ?").run(m.merged_id);
    db.prepare('UPDATE client_merges SET undone_at = ? WHERE id = ?').run(nowStamp(), m.id);
  })();
  audit('staff', req.user.id, req.user.name, '還原個案合併', `${m.merged_code} ← ${m.kept_code}`);
  res.json({ ok: true });
});

// ---- 同意書列印／匯出 ----
//
// 紙本仍是所內的主要簽署方式：空白版一次印兩聯（個案留存聯、織心留存聯），
// 內容取自範本，範本文字在「系統設定 → 同意書範本」隨時可改；
// 已在系統簽署的則印出簽署當下的全文快照與簽名圖，兩者都可另存 PDF 或匯出 Word 再排版。
function consentDocHtml(opts) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const org = {
    name: getSetting('center_name', ''),
    phone: getSetting('center_phone', ''),
    address: getSetting('center_address', ''),
    license: getSetting('center_license_no', '')
  };
  const copy = (label, signed) => `<section>
    <div class="org">${esc(org.name)}</div>
    <h1>${esc(opts.title)}</h1>
    <div class="body">${esc(opts.body)}</div>
    <div class="foot">
      ${org.address ? `<div class="org-info">${esc(org.address)}${org.phone ? `　電話 ${esc(org.phone)}` : ''}</div>` : ''}
      ${signed ? `<div class="signed">
        <div>簽署人：${esc(signed.signer_name)}（${signed.signer_role === 'guardian' ? '法定代理人' : '本人'}）
          ${signed.agreed ? '' : '　<strong>【不同意】</strong>'}</div>
        <div>簽署時間：${esc(signed.signed_at)}　版本：${signed.version}</div>
        ${signed.signature ? `<div><img src="${esc(signed.signature)}" alt="簽名" class="sig"></div>` : ''}
      </div>` : `<div class="lines">${opts.signBlock ? esc(opts.signBlock)
    : `<div>本人簽名：____________________　　日期：____________________</div>
       <div>諮商／臨床心理師簽名：____________________（諮／臨 心字＿＿＿＿＿號）　　日期：____________________</div>`}
      </div>`}
      <div class="tag">［${esc(label)}］</div>
    </div>
  </section>`;
  const copies = opts.signed
    ? [copy('簽署紀錄', opts.signed)]
    : opts.copies.map(label => copy(label, null));
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(opts.title)}${opts.subject ? '－' + esc(opts.subject) : ''}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
    color: #1c2b2b; font-size: 13.5px; line-height: 1.9; }
  section { page-break-after: always; }
  section:last-child { page-break-after: auto; }
  .org { text-align: center; font-size: 15px; }
  h1 { font-size: 20px; text-align: center; letter-spacing: 4px; margin: 4px 0 14px; }
  .body { white-space: pre-wrap; }
  .foot { margin-top: 22px; }
  .org-info { font-size: 12px; color: #667; margin-bottom: 10px; }
  .lines { white-space: pre-wrap; }
  .lines div { margin-bottom: 16px; }
  .signed { border: 1px solid #c9d6d6; padding: 10px 12px; border-radius: 6px; }
  .sig { height: 90px; margin-top: 6px; }
  .tag { margin-top: 14px; text-align: right; color: #667; font-size: 12px; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
${copies.join('\n')}
${opts.forWord ? '' : '<script>if (location.hash !== \'#noprint\') setTimeout(() => window.print(), 300);<\/script>'}
</body></html>`;
}

function sendDoc(res, html, forWord, filename) {
  if (forWord) {
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.doc"`);
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  res.send(html);
}

// 空白版：預設印兩聯（個案留存聯、織心留存聯），copies=1 只印一份
router.get('/consent-templates/:key/print', requireStaff('consents'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(req.params.key);
  if (!t) return res.status(404).send('找不到此同意書範本');
  const forWord = req.query.format === 'doc';
  const two = String(req.query.copies || '2') !== '1';
  const org = getSetting('center_name', '本所');
  // 聯別名稱可逐份自訂（如公部門方案寫成「存根聯、收執聯」）
  const labels = String(t.copy_labels || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
  audit('staff', req.user.id, req.user.name, forWord ? '匯出同意書空白版（Word）' : '列印同意書空白版', t.title);
  sendDoc(res, consentDocHtml({
    title: t.title, body: t.body, forWord, signBlock: t.sign_block || '',
    copies: labels.length ? (two ? labels : labels.slice(0, 1))
      : (two ? ['個案留存聯', `${org}留存聯`] : ['個案留存聯'])
  }), forWord, `consent_${t.key}`);
});

// 已簽署版：印出簽署當下的全文快照與簽名
router.get('/consents/:id/print', requireStaff('consents'), (req, res) => {
  const row = db.prepare('SELECT * FROM consents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('找不到此簽署紀錄');
  const c = db.prepare('SELECT code, name FROM clients WHERE id = ?').get(row.client_id) || {};
  const forWord = req.query.format === 'doc';
  audit('staff', req.user.id, req.user.name, forWord ? '匯出已簽同意書（Word）' : '列印已簽同意書',
    `${c.code || ''}/${row.key}`);
  sendDoc(res, consentDocHtml({
    title: row.title, body: row.body, signed: row, subject: c.name || '', forWord, copies: []
  }), forWord, `consent_${row.key}_${c.code || row.client_id}`);
});

router.get('/clients/:id/consents/:key', requireStaff('consents'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(req.params.key);
  if (!t) return res.status(404).json({ error: '找不到此同意書' });
  const signed = db.prepare('SELECT * FROM consents WHERE client_id = ? AND key = ? ORDER BY id DESC LIMIT 1')
    .get(req.params.id, req.params.key);
  res.json({ template: t, signed: signed || null });
});

// 由所內裝置當場簽署（個案端也可簽，見 portal.js）
router.post('/clients/:id/consents', requireStaff('consents'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const { key, agreed = 1, signer_name = '', signer_role = 'client', signature = '' } = req.body || {};
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(key || '');
  if (!t) return res.status(400).json({ error: '找不到此同意書範本' });
  if (!agreed && !t.allow_decline) return res.status(400).json({ error: '此同意書為必要項目，不得選擇不同意' });
  if (!signer_name) return res.status(400).json({ error: '請填寫簽署人姓名' });
  if (c.is_minor && t.minor_only && signer_role !== 'guardian') {
    return res.status(400).json({ error: '此同意書須由法定代理人簽署' });
  }
  db.prepare(`INSERT INTO consents (client_id, key, title, body, version, agreed, signer_name, signer_role, signature, signed_ip)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(c.id, t.key, t.title, t.body, t.version, agreed ? 1 : 0, signer_name, signer_role, signature, clientIp(req));
  audit('staff', req.user.id, req.user.name, '登錄同意書', `${c.code}/${t.key}`, { agreed: !!agreed });
  res.json({ ok: true });
});

router.get('/consents/:id', requireStaff('consents'), (req, res) => {
  const row = db.prepare('SELECT * FROM consents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到此紀錄' });
  res.json(row);
});

// ---- 結案摘要（結案時產出，內容取自處遇計畫與晤談次數）----
router.get('/clients/:id/summary', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const done = db.prepare("SELECT COUNT(*) n FROM appointments WHERE client_id = ? AND status = 'done'").get(c.id).n;
  const first = db.prepare("SELECT MIN(date) d FROM appointments WHERE client_id = ? AND status = 'done'").get(c.id).d;
  const last = db.prepare("SELECT MAX(date) d FROM appointments WHERE client_id = ? AND status = 'done'").get(c.id).d;
  const plan = db.prepare('SELECT * FROM treatment_plans WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  const goals = plan ? db.prepare('SELECT * FROM plan_goals WHERE plan_id = ? ORDER BY sort, id').all(plan.id) : [];
  const scales = db.prepare(`SELECT scale, MIN(date) first_date, MAX(date) last_date FROM assessments
                             WHERE client_id = ? GROUP BY scale`).all(c.id).map(s => {
    const f = db.prepare('SELECT total, severity FROM assessments WHERE client_id = ? AND scale = ? ORDER BY date LIMIT 1').get(c.id, s.scale);
    const l = db.prepare('SELECT total, severity FROM assessments WHERE client_id = ? AND scale = ? ORDER BY date DESC LIMIT 1').get(c.id, s.scale);
    return { ...s, first_total: f.total, first_severity: f.severity, last_total: l.total, last_severity: l.severity };
  });
  res.json({
    client: { code: c.code, name: c.name, main_issue: c.main_issue, intake_date: c.intake_date, close_date: c.close_date, close_reason: c.close_reason },
    sessions: done, first_date: first, last_date: last,
    center_name: getSetting('center_name'),
    plan: plan ? { ...plan, goals } : null,
    scales,
    risk_events: db.prepare('SELECT date, type, severity, status FROM risk_events WHERE client_id = ? ORDER BY date').all(c.id),
    referrals: db.prepare('SELECT date, direction, target, reason, status FROM referrals WHERE client_id = ? ORDER BY date').all(c.id),
    follow_ups: db.prepare('SELECT due_date, kind, status, channel, result FROM follow_ups WHERE client_id = ? ORDER BY due_date').all(c.id)
  });
});

module.exports = router;
