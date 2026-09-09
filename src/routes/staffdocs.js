// 所方 ↔ 心理師之間的文件與月結。
//
// 兩件事原本都靠人工來回：
//  1. 空白表單與機構紀錄格式用 LINE 或隨身碟傳，版本一亂就有人拿舊格式寫紀錄，
//     督考時才發現。改成所方上傳一份、心理師自己下載，並標明版本與更新日期。
//  2. 撥款前要確認金額，櫃檯得一個一個問。改成一位心理師一個月一張月結單，
//     送出後由本人核對、手寫簽名確認；有疑義可以直接回覆說明。
//     沒確認的月份，撥款時會被擋下 —— 這正是「確認後我們再撥款」的意思。

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, audit, today, nowStamp, listSetting, UPLOAD_DIR } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// ---- 文件庫 ----------------------------------------------------------------

const ALLOWED = {
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.zip': 'application/zip'
};
const MAX_MB = 30;
function decodeFilename(name) {
  try {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    return utf8.includes('�') ? name : utf8;
  } catch { return name; }
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(decodeFilename(file.originalname)).toLowerCase();
      cb(null, `doc-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeFilename(file.originalname)).toLowerCase();
    cb(ALLOWED[ext] ? null : new Error(`不支援的檔案類型（${ext || '無副檔名'}）`), !!ALLOWED[ext]);
  }
});
function handleUpload(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `檔案不可超過 ${MAX_MB} MB` : (err.message || '上傳失敗')
    });
  });
}
// 上傳與刪除屬所方作業（管理者與行政），下載則是全所同仁都要能拿到。
// 不能用「有沒有 hr 模組」來判斷 —— 心理師的預設模組就含 hr（他們要看自己的請假與時數），
// 那樣等於人人都能改文件庫。所以看身分：管理者、行政，或另外被授予設定權限的人。
function canManageDocs(user, modules) {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'staff' || (modules || []).includes('settings');
}
function requireDocManager(req, res, next) {
  if (canManageDocs(req.user, req.userModules)) return next();
  res.status(403).json({ error: '文件由所方維護，如需新增請洽行政' });
}

router.get('/staff-documents', requireStaff(), (req, res) => {
  const manage = canManageDocs(req.user, req.userModules);
  // 停用的只有維護者看得到（要能改回啟用），其他人看到的一律是現行版本
  const rows = db.prepare(`SELECT d.*, u.name AS uploader_name FROM staff_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    ${manage ? '' : 'WHERE d.active = 1'}
    ORDER BY d.sort, d.category, d.id DESC`).all();
  res.json({
    can_manage: manage,
    categories: listSetting('staff_doc_categories', '機構紀錄格式,空白表單,作業規範,合約與報酬,其他'),
    rows
  });
});

router.post('/staff-documents', requireStaff(), requireDocManager, handleUpload, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim() || (req.file ? decodeFilename(req.file.originalname) : '');
  const url = String(b.url || '').trim();
  const cleanup = () => { if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {}); };
  if (!title) { cleanup(); return res.status(400).json({ error: '請填寫文件名稱' }); }
  // 一筆就是一份文件：不是上傳檔案，就是一條外部連結，兩者要有其一
  if (!req.file && !url) return res.status(400).json({ error: '請選擇檔案或填寫連結網址' });
  if (url && !/^https?:\/\//i.test(url)) { cleanup(); return res.status(400).json({ error: '連結網址請以 http(s):// 開頭' }); }
  const info = db.prepare(`INSERT INTO staff_documents
    (title, category, version, note, stored_name, orig_name, size, mime, url, sort, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    title, String(b.category || '').trim(), String(b.version || '').trim(), String(b.note || '').trim(),
    req.file ? req.file.filename : '', req.file ? decodeFilename(req.file.originalname) : '',
    req.file ? req.file.size : 0, req.file ? (req.file.mimetype || '') : '',
    req.file ? '' : url, Number(b.sort) || 0, req.user.id);
  audit('staff', req.user.id, req.user.name, '新增所方文件', title, { version: b.version || '' });
  res.json({ id: info.lastInsertRowid });
});

// 換新版：舊檔直接換掉並更新版本與時間，心理師下載到的永遠是現行版本。
// 要保留舊版就另開一筆並把舊的停用，不要在同一筆上來回改。
router.put('/staff-documents/:id', requireStaff(), requireDocManager, handleUpload, (req, res) => {
  const d = db.prepare('SELECT * FROM staff_documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '找不到此文件' });
  const b = req.body || {};
  const set = {
    title: b.title !== undefined ? String(b.title).trim() : d.title,
    category: b.category !== undefined ? String(b.category).trim() : d.category,
    version: b.version !== undefined ? String(b.version).trim() : d.version,
    note: b.note !== undefined ? String(b.note).trim() : d.note,
    sort: b.sort !== undefined ? Number(b.sort) || 0 : d.sort,
    active: b.active !== undefined ? (Number(b.active) ? 1 : 0) : d.active
  };
  if (!set.title) return res.status(400).json({ error: '文件名稱不可空白' });
  if (req.file) {
    if (d.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(d.stored_name))); } catch { /* 檔案不在就算了 */ } }
    Object.assign(set, {
      stored_name: req.file.filename, orig_name: decodeFilename(req.file.originalname),
      size: req.file.size, mime: req.file.mimetype || '', url: ''
    });
  }
  const cols = Object.keys(set);
  db.prepare(`UPDATE staff_documents SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map(k => set[k]), nowStamp(), d.id);
  audit('staff', req.user.id, req.user.name, req.file ? '更新所方文件（換檔）' : '修改所方文件', set.title);
  res.json({ ok: true });
});

router.delete('/staff-documents/:id', requireStaff(), requireDocManager, (req, res) => {
  const d = db.prepare('SELECT * FROM staff_documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '找不到此文件' });
  if (d.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(d.stored_name))); } catch { /* 略 */ } }
  db.prepare('DELETE FROM staff_documents WHERE id = ?').run(d.id);
  audit('staff', req.user.id, req.user.name, '刪除所方文件', d.title);
  res.json({ ok: true });
});

router.get('/staff-documents/:id/download', requireStaff(), (req, res) => {
  const d = db.prepare('SELECT * FROM staff_documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).send('找不到此文件');
  if (!d.active && !canManageDocs(req.user, req.userModules)) {
    return res.status(404).send('此文件已停用');
  }
  if (!d.stored_name) return res.redirect(d.url);
  const full = path.join(UPLOAD_DIR, path.basename(d.stored_name));
  if (!fs.existsSync(full)) return res.status(404).send('檔案已不存在，請洽行政重新上傳');
  audit('staff', req.user.id, req.user.name, '下載所方文件', d.title);
  res.download(full, d.orig_name || d.title);
});

// ---- 當月薪資的月結確認 -----------------------------------------------------

function monthRows(userId, month) {
  return db.prepare(`SELECT id, month, item, sessions, gross, income_type, withholding,
      nhi_supplement, net, status, pay_date, paid_at, note
    FROM payouts WHERE user_id = ? AND month = ? ORDER BY pay_date, id`).all(Number(userId) || 0, month);
}
function monthTotals(rows) {
  const sum = k => rows.reduce((a, b) => a + (b[k] || 0), 0);
  return { count: rows.length, gross: sum('gross'), withholding: sum('withholding'),
    nhi_supplement: sum('nhi_supplement'), net: sum('net') };
}
function statusOf(userId, month) {
  return db.prepare('SELECT * FROM payout_months WHERE user_id = ? AND month = ?')
    .get(Number(userId) || 0, month) || null;
}

// 所方：某月各心理師的結算與確認狀態
router.get('/payout-months', requireStaff('payouts'), (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const users = db.prepare(`SELECT DISTINCT u.id, u.name FROM payouts p JOIN users u ON u.id = p.user_id
    WHERE p.month = ? ORDER BY u.name`).all(month);
  res.json({
    month,
    rows: users.map(u => {
      const rows = monthRows(u.id, month);
      const st = statusOf(u.id, month);
      return {
        user_id: u.id, user_name: u.name,
        ...monthTotals(rows),
        paid: rows.filter(r => r.status === 'paid').length,
        confirm_status: st ? st.status : '',
        sent_at: st ? st.sent_at : '', confirmed_at: st ? st.confirmed_at : '',
        reply_note: st ? st.reply_note : '', has_sign: !!(st && st.sign_image)
      };
    })
  });
});

// 送出給心理師確認。可指定 user_ids，未指定就是該月全部有報酬單的人。
// 重送不會清掉已確認的簽名 —— 已經確認過的就不再打擾。
router.post('/payout-months/send', requireStaff('payouts'), (req, res) => {
  const month = String((req.body || {}).month || '').trim() || today().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '月份格式應為 YYYY-MM' });
  const ids = Array.isArray((req.body || {}).user_ids) ? (req.body || {}).user_ids.map(Number).filter(Boolean) : [];
  const users = (ids.length
    ? ids.map(id => db.prepare('SELECT id, name FROM users WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare(`SELECT DISTINCT u.id, u.name FROM payouts p JOIN users u ON u.id = p.user_id
        WHERE p.month = ?`).all(month));
  if (!users.length) return res.status(400).json({ error: `${month} 沒有任何報酬單可送出` });
  const ins = db.prepare(`INSERT INTO payout_months (user_id, month, status, sent_at, sent_by)
    VALUES (?,?, 'sent', ?, ?)
    ON CONFLICT(user_id, month) DO UPDATE SET
      status = CASE WHEN payout_months.status = 'confirmed' THEN 'confirmed' ELSE 'sent' END,
      sent_at = excluded.sent_at, sent_by = excluded.sent_by`);
  const tx = db.transaction(() => { for (const u of users) ins.run(u.id, month, nowStamp(), req.user.id); });
  tx();
  audit('staff', req.user.id, req.user.name, '送出月結給心理師確認', month, { count: users.length });
  res.json({ ok: true, month, count: users.length });
});

// 所方處理疑義：記下處理說明並改回待確認，讓心理師重新核對
router.post('/payout-months/:userId/:month/reopen', requireStaff('payouts'), (req, res) => {
  const st = statusOf(req.params.userId, req.params.month);
  if (!st) return res.status(404).json({ error: '找不到此月結' });
  db.prepare(`UPDATE payout_months SET status = 'sent', handled_at = ?, handled_note = ?,
      confirmed_at = '', sign_image = '', reply_note = '' WHERE id = ?`)
    .run(nowStamp(), String((req.body || {}).note || '').slice(0, 500), st.id);
  audit('staff', req.user.id, req.user.name, '重送月結供確認', `${req.params.month}／使用者 ${req.params.userId}`);
  res.json({ ok: true });
});

// 心理師：我的月結（預設本月；帶 month 可看別月）
router.get('/my/payout-months', requireStaff(), (req, res) => {
  const months = db.prepare(`SELECT DISTINCT month FROM payouts WHERE user_id = ?
    ORDER BY month DESC LIMIT 24`).all(req.user.id).map(r => r.month);
  const month = req.query.month || months[0] || today().slice(0, 7);
  const rows = monthRows(req.user.id, month);
  const st = statusOf(req.user.id, month);
  res.json({
    month, months, rows, ...monthTotals(rows),
    // 沒送出前不讓確認：金額還可能在調整，先簽了反而說不清楚
    confirm_status: st ? st.status : '',
    sent_at: st ? st.sent_at : '', confirmed_at: st ? st.confirmed_at : '',
    reply_note: st ? st.reply_note : '', handled_note: st ? st.handled_note : '',
    sign_image: st ? st.sign_image : ''
  });
});

// 心理師確認：手寫簽名一併存下來，並記時間與來源 IP，事後對帳說得清楚
router.post('/my/payout-months/:month/confirm', requireStaff(), (req, res) => {
  const month = String(req.params.month);
  const st = statusOf(req.user.id, month);
  if (!st || st.status === '') return res.status(400).json({ error: '這個月的結算尚未送出，請洽行政' });
  if (st.status === 'confirmed') return res.status(400).json({ error: '這個月已經確認過了' });
  const sign = String((req.body || {}).sign_image || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sign)) {
    return res.status(400).json({ error: '請在簽名欄簽名後再送出' });
  }
  if (sign.length > 400000) return res.status(400).json({ error: '簽名圖片過大，請重新簽一次' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  db.prepare(`UPDATE payout_months SET status = 'confirmed', confirmed_at = ?, confirm_ip = ?,
      sign_image = ?, reply_note = '' WHERE id = ?`).run(nowStamp(), ip, sign, st.id);
  audit('staff', req.user.id, req.user.name, '確認當月報酬', month);
  res.json({ ok: true });
});

// 有疑義：不簽名，留下說明給所方
router.post('/my/payout-months/:month/dispute', requireStaff(), (req, res) => {
  const month = String(req.params.month);
  const st = statusOf(req.user.id, month);
  if (!st) return res.status(400).json({ error: '這個月的結算尚未送出，請洽行政' });
  const note = String((req.body || {}).note || '').trim();
  if (!note) return res.status(400).json({ error: '請說明哪裡有疑義，行政才知道要查什麼' });
  db.prepare(`UPDATE payout_months SET status = 'disputed', reply_note = ?, confirmed_at = '',
      sign_image = '' WHERE id = ?`).run(note.slice(0, 1000), st.id);
  audit('staff', req.user.id, req.user.name, '回報當月報酬有疑義', month);
  res.json({ ok: true });
});

module.exports = router;
module.exports.statusOf = statusOf;
module.exports.canManageDocs = canManageDocs;
