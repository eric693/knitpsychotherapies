// 收據：晤談結束後個案若需要就開一張，帶流水編號；當下不要、事後再要也能補開。
//
// 與收費單分開的理由：收費單是帳（該收多少、收了沒），收據是給個案的憑證。
// 個案報稅／向公司請款常常是幾個月後才來要，屆時不該去動已經結掉的帳，
// 只要依原收費單補開一張收據即可。開錯則作廢並重開新號，兩張互相勾稽。

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, audit, today, nowStamp, getSetting, listSetting, nextReceiptNo, withUniqueRetry, UPLOAD_DIR } = require('../db');
const { requireStaff } = require('../auth');
const line = require('../line');

const router = express.Router();

function centerBlock() {
  return {
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director'),
    center_tax_id: getSetting('center_tax_id'),
    receipt_footer: getSetting('receipt_footer'),
    receipt_title: getSetting('receipt_title_default', '心理諮商服務費收據'),
    receipt_stamp_enabled: getSetting('receipt_stamp_enabled', '1'),
    receipt_stamp_note: getSetting('receipt_stamp_note', '本執行費收據印花稅總繳'),
    receipt_stamp_authority: getSetting('receipt_stamp_authority', '臺中市'),
    receipt_stamp_payer: getSetting('receipt_stamp_payer'),
    receipt_seal_image: getSetting('receipt_seal_image'),
    receipt_seal_size: getSetting('receipt_seal_size', '192'),
    receipt_stamp_image: getSetting('receipt_stamp_image')
  };
}

// 收據圖片：LINE 的圖片訊息只吃網址，而這台機器上沒有可以把網頁轉圖的元件，
// 所以由櫃檯的瀏覽器把收據畫面畫成 PNG 上傳，伺服器落地後給 LINE 一條公開網址。
// 這樣個案收到的就是與我們開立、列印完全同一份版面（要拿去申請保險的就是這張）。
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `receipt-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.png`)
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(file.mimetype === 'image/png' ? null : new Error('收據圖片只接受 PNG'), file.mimetype === 'image/png')
});
function removeImage(r) {
  if (!r || !r.image_name) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(r.image_name))); } catch { /* 檔案不在就算了 */ }
  db.prepare("UPDATE receipts SET image_name = '' WHERE id = ?").run(r.id);
}

// 收據涵蓋的收費單明細。合併開立時個案要看得到「哪幾次、各多少錢」，
// 否則拿一張只有總額的收據去申請保險會被退件。
function linesOf(receiptId) {
  return db.prepare(`SELECT i.id, i.date, i.item, i.amount, a.date AS service_date,
      u.name AS counselor_name, p.name AS plan_name
    FROM receipt_invoices ri
    JOIN invoices i ON i.id = ri.invoice_id
    LEFT JOIN appointments a ON a.id = i.appointment_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = COALESCE(i.plan_id, a.plan_id)
    WHERE ri.receipt_id = ? ORDER BY COALESCE(a.date, i.date), i.id`).all(Number(receiptId) || 0);
}
// 給個案的公開連結：不必登入就能開，所以 token 要夠長；作廢或重開時一併換掉，
// 舊連結就失效，個案手上不會留著一張已經無效的憑證。
function ensureShareToken(r) {
  if (r.share_token) return r.share_token;
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE receipts SET share_token = ? WHERE id = ?').run(t, r.id);
  return t;
}
function publicBase(req) {
  const configured = String(getSetting('portal_public_url', '') || getSetting('booking_public_url', '') || '').trim();
  if (configured) {
    try { return new URL(configured).origin; } catch { /* 設定填錯就退回用請求標頭推 */ }
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function shareUrl(req, r) { return `${publicBase(req)}/receipt/${ensureShareToken(r)}`; }

const LIST_SQL = `SELECT r.*, c.name AS client_name, c.code AS client_code, u.name AS issuer_name,
    i.status AS invoice_status
  FROM receipts r
  JOIN clients c ON c.id = r.client_id
  LEFT JOIN users u ON u.id = r.issued_by
  LEFT JOIN invoices i ON i.id = r.invoice_id`;

router.get('/receipts', requireStaff('billing'), (req, res) => {
  const { from = '', to = '', client_id = '', q = '', status = '' } = req.query;
  const where = [], args = [];
  if (from) { where.push('r.date >= ?'); args.push(from); }
  if (to) { where.push('r.date <= ?'); args.push(to); }
  if (client_id) { where.push('r.client_id = ?'); args.push(Number(client_id)); }
  if (status) { where.push('r.status = ?'); args.push(status); }
  if (q) {
    where.push('(r.receipt_no LIKE ? OR c.name LIKE ? OR c.code LIKE ? OR r.title LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = db.prepare(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.date DESC, r.id DESC LIMIT 500`).all(...args);
  res.json({
    rows,
    total_amount: rows.filter(r => r.status === 'valid').reduce((a, b) => a + b.amount, 0),
    pay_methods: listSetting('pay_methods', '現金,轉帳,信用卡,行動支付,其他')
  });
});

// 尚未開立收據的收費單：櫃檯要補開時直接從這裡挑，不必自己核對
router.get('/receipts/pending', requireStaff('billing'), (req, res) => {
  const rows = db.prepare(`SELECT i.*, c.name AS client_name, c.code AS client_code,
      u.name AS counselor_name, p.name AS plan_name, a.date AS service_date
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    LEFT JOIN appointments a ON a.id = i.appointment_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN service_plans p ON p.id = COALESCE(i.plan_id, a.plan_id)
    WHERE i.status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.invoice_id = i.id AND r.status = 'valid')
      AND NOT EXISTS (SELECT 1 FROM receipt_invoices ri JOIN receipts r2 ON r2.id = ri.receipt_id
        WHERE ri.invoice_id = i.id AND r2.status = 'valid')
    ORDER BY i.paid_at DESC, i.id DESC LIMIT 200`).all();
  res.json(rows);
});

router.get('/receipts/:id', requireStaff('billing'), (req, res) => {
  const r = db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  res.json({ ...r, ...centerBlock(), lines: linesOf(r.id),
    share_url: r.status === 'valid' ? shareUrl(req, r) : '' });
});

// 開立（或補開）收據。
// 帶 invoice_id 即依該筆收費單開立；不帶則為手動開立（如代收代付、雜項）。
router.post('/receipts', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  // 一張收據可以涵蓋同一個案的多筆收費單：individual 收費單各自留著（帳不動），
  // 收據上以明細列出每一次的日期與金額，總額為加總。
  const ids = [...new Set((Array.isArray(b.invoice_ids) ? b.invoice_ids : (b.invoice_id ? [b.invoice_id] : []))
    .map(Number).filter(Boolean))];
  const invoices = ids.map(id => db.prepare(`SELECT i.*, a.date AS service_date, a.counselor_id, a.plan_id AS appt_plan_id
    FROM invoices i LEFT JOIN appointments a ON a.id = i.appointment_id WHERE i.id = ?`).get(id));
  for (let k = 0; k < ids.length; k++) {
    const v = invoices[k];
    if (!v) return res.status(404).json({ error: `找不到收費單（編號 ${ids[k]}）` });
    if (v.status === 'void') return res.status(400).json({ error: '已作廢的收費單不可開立收據' });
    const dup = db.prepare(`SELECT r.receipt_no FROM receipts r
      LEFT JOIN receipt_invoices ri ON ri.receipt_id = r.id
      WHERE r.status = 'valid' AND (r.invoice_id = ? OR ri.invoice_id = ?)`).get(v.id, v.id);
    if (dup && !b.allow_duplicate) {
      return res.status(400).json({ error: `其中一筆收費單已開立收據（${dup.receipt_no}），如需重開請先作廢原收據` });
    }
  }
  // 合併只在同一個個案之內成立 —— 憑證抬頭與個案編號只有一個，混不得
  if (invoices.length > 1 && new Set(invoices.map(v => v.client_id)).size > 1) {
    return res.status(400).json({ error: '只能合併同一位個案的收費單' });
  }
  const inv = invoices[0] || null;
  const clientId = Number(b.client_id) || (inv && inv.client_id) || 0;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(400).json({ error: '請選擇個案' });

  const invoiceTotal = invoices.reduce((a, v) => a + v.amount, 0);
  // 合併多筆時金額一律以加總為準，不接受手動改 —— 憑證金額與帳必須對得起來
  const amount = invoices.length > 1
    ? invoiceTotal
    : Math.max(0, Math.round(Number(b.amount !== undefined && b.amount !== '' ? b.amount : invoiceTotal)));
  if (!amount) return res.status(400).json({ error: '請填寫金額' });

  const planName = b.plan_name || (inv && inv.appt_plan_id
    ? (db.prepare('SELECT name FROM service_plans WHERE id = ?').get(inv.appt_plan_id) || {}).name || '' : '');
  const counselorName = b.counselor_name || (inv && inv.counselor_id
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(inv.counselor_id) || {}).name || '' : '');

  // 合併開立時，服務項目寫成「心理諮商服務費（N 次）」，服務日期寫成起訖，
  // 明細另外逐筆列在收據上；只有一筆時維持原本的寫法。
  const dates = invoices.map(v => v.service_date || v.date).filter(Boolean).sort();
  const itemText = invoices.length > 1
    ? `心理諮商服務費（${invoices.length} 次）`
    : (inv ? inv.item : '心理諮商服務費');
  const serviceDate = invoices.length > 1
    ? (dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`) : '')
    : (inv ? inv.service_date || inv.date : '');

  // 號碼與寫入綁在一起重試：撞號時重算一個再寫，不會靜靜地開出重號憑證
  const { no, info } = withUniqueRetry(() => {
    const receiptNo = nextReceiptNo();
    const row = db.prepare(`INSERT INTO receipts
      (receipt_no, invoice_id, client_id, date, title, tax_id, item, amount, method,
       plan_name, counselor_name, service_date, note, reissue_of, issued_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receiptNo, inv ? inv.id : null, client.id,
      b.date || (inv && inv.paid_at ? inv.paid_at.slice(0, 10) : today()),
      String(b.title || client.name), String(b.tax_id || '').trim(),
      String(b.item || itemText), amount,
      String(b.method || (inv ? inv.method : '') || ''),
      planName, counselorName,
      b.service_date || serviceDate,
      String(b.note || ''), String(b.reissue_of || ''), req.user.id);
    // 明細：合併開立時逐筆記下涵蓋了哪些收費單
    const link = db.prepare('INSERT INTO receipt_invoices (receipt_id, invoice_id) VALUES (?,?)');
    for (const v of invoices) link.run(row.lastInsertRowid, v.id);
    // 收費單上也留一份收據號，帳務畫面才看得出這筆已開過憑證
    for (const v of invoices) {
      if (!v.receipt_no) db.prepare('UPDATE invoices SET receipt_no = ? WHERE id = ?').run(receiptNo, v.id);
    }
    return { no: receiptNo, info: row };
  });
  audit('staff', req.user.id, req.user.name, '開立收據', client.code,
    { receipt_no: no, amount, invoices: ids.length });
  res.json({ id: info.lastInsertRowid, receipt_no: no, merged: ids.length });
});

// 修正非金額欄位：抬頭打錯、統編漏填、項目寫法要調整，不必為了這些重開新號。
// 編號、金額與日期屬憑證要素，錯了必須走作廢＋重開，這裡一律不動。
router.put('/receipts/:id', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  if (r.status !== 'valid') return res.status(400).json({ error: '已作廢的收據不可修改' });
  const b = req.body || {};
  const title = String(b.title !== undefined ? b.title : r.title).trim();
  if (!title) return res.status(400).json({ error: '抬頭不可空白' });
  const taxId = String(b.tax_id !== undefined ? b.tax_id : r.tax_id).trim();
  if (taxId && !/^\d{8}$/.test(taxId)) return res.status(400).json({ error: '統一編號應為 8 碼數字' });
  const item = String(b.item !== undefined ? b.item : r.item).trim();
  if (!item) return res.status(400).json({ error: '項目不可空白' });
  db.prepare('UPDATE receipts SET title = ?, tax_id = ?, item = ?, note = ? WHERE id = ?')
    .run(title, taxId, item, String(b.note !== undefined ? b.note : r.note), r.id);
  audit('staff', req.user.id, req.user.name, '修改收據抬頭與項目', r.receipt_no,
    { before: { title: r.title, tax_id: r.tax_id, item: r.item } });
  res.json({ ok: true });
});

// 作廢：憑證不可塗改，錯了就作廢留痕，需要的話另開新號
router.post('/receipts/:id/void', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  if (r.status === 'void') return res.status(400).json({ error: '此收據已作廢' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '請填寫作廢原因' });
  // 作廢的同時讓公開連結與已產出的圖片失效 —— 個案手上不該還留著一張開得起來的憑證
  db.prepare("UPDATE receipts SET status = 'void', void_reason = ?, share_token = '' WHERE id = ?")
    .run(reason, r.id);
  removeImage(r);
  audit('staff', req.user.id, req.user.name, '作廢收據', r.receipt_no, { reason });
  res.json({ ok: true });
});

// 撤銷作廢：作廢當下按錯時用；若已因重開而產生後續收據則不允許撤銷（號碼會重複勾稽）
router.post('/receipts/:id/unvoid', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  if (r.status !== 'void') return res.status(400).json({ error: '此收據不是作廢狀態' });
  const reissued = db.prepare("SELECT receipt_no FROM receipts WHERE reissue_of = ? AND status = 'valid'")
    .get(r.receipt_no);
  if (reissued) {
    return res.status(400).json({ error: `已重開為 ${reissued.receipt_no}，如要恢復本張請先作廢重開的那張` });
  }
  db.prepare("UPDATE receipts SET status = 'valid', void_reason = '' WHERE id = ?").run(r.id);
  audit('staff', req.user.id, req.user.name, '撤銷作廢收據', r.receipt_no, { was: r.void_reason });
  res.json({ ok: true });
});

// 重開：作廢原收據並以相同內容開新號，兩張互相勾稽
router.post('/receipts/:id/reissue', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  const b = req.body || {};
  const reason = String(b.reason || '重開').trim();
  const no = withUniqueRetry(() => {
    const newNo = nextReceiptNo();
    db.transaction(() => {
      if (r.status === 'valid') {
        db.prepare("UPDATE receipts SET status = 'void', void_reason = ? WHERE id = ?")
          .run(`重開為 ${newNo}：${reason}`, r.id);
      }
      db.prepare(`INSERT INTO receipts
        (receipt_no, invoice_id, client_id, date, title, tax_id, item, amount, method,
         plan_name, counselor_name, service_date, note, reissue_of, issued_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        newNo, r.invoice_id, r.client_id, b.date || r.date,
        String(b.title !== undefined ? b.title : r.title), String(b.tax_id !== undefined ? b.tax_id : r.tax_id),
        String(b.item !== undefined ? b.item : r.item),
        Math.max(0, Math.round(Number(b.amount !== undefined && b.amount !== '' ? b.amount : r.amount))),
        String(b.method !== undefined ? b.method : r.method),
        r.plan_name, r.counselor_name, r.service_date,
        String(b.note !== undefined ? b.note : r.note), r.receipt_no, req.user.id);
      // 明細（涵蓋哪幾筆收費單）跟著搬到新收據，合併開立的那幾次不會在重開後消失
      const olds = db.prepare('SELECT invoice_id FROM receipt_invoices WHERE receipt_id = ?').all(r.id);
      const link = db.prepare('INSERT INTO receipt_invoices (receipt_id, invoice_id) VALUES (?,?)');
      const newId = db.prepare('SELECT id FROM receipts WHERE receipt_no = ?').get(newNo).id;
      for (const o of olds) link.run(newId, o.invoice_id);
      const invIds = olds.length ? olds.map(o => o.invoice_id) : (r.invoice_id ? [r.invoice_id] : []);
      for (const iid of invIds) db.prepare('UPDATE invoices SET receipt_no = ? WHERE id = ?').run(newNo, iid);
      db.prepare("UPDATE receipts SET share_token = '' WHERE id = ?").run(r.id);
    })();
    return newNo;
  });
  removeImage(r);
  audit('staff', req.user.id, req.user.name, '重開收據', r.receipt_no, { new_no: no, reason });
  res.json({ ok: true, receipt_no: no });
});

// 補印：記錄補印次數與時間，事後有人問「這張印過幾次」查得到
router.post('/receipts/:id/printed', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  db.prepare('UPDATE receipts SET print_count = print_count + 1, last_printed_at = ? WHERE id = ?')
    .run(nowStamp(), r.id);
  audit('staff', req.user.id, req.user.name, '補印收據', r.receipt_no);
  res.json({ ok: true });
});

// 以 LINE 傳收據給個案。
// 前端會把收據畫面轉成 PNG 一起送上來，此時推的是「圖片訊息」——
// 個案手機上看到的就是我們開立的那張收據本身，可以直接存檔拿去申請保險。
// 沒帶圖（或圖片送失敗）時退回原本的摘要卡片，並附上可開啟完整收據的連結。
router.post('/receipts/:id/line', requireStaff('billing'), receiptUpload.single('image'), async (req, res) => {
  const r = db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(req.params.id);
  if (!r) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* 略 */ } }
    return res.status(404).json({ error: '找不到此收據' });
  }
  if (r.status !== 'valid') return res.status(400).json({ error: '已作廢的收據不可傳送' });
  const c = db.prepare('SELECT line_user_id FROM clients WHERE id = ?').get(r.client_id);
  const url = shareUrl(req, r);
  if (req.file) {
    removeImage(r);   // 換新圖時把上一張刪掉，uploads 不會愈積愈多
    db.prepare('UPDATE receipts SET image_name = ? WHERE id = ?').run(req.file.filename, r.id);
    const imgUrl = `${publicBase(req)}/receipt/${ensureShareToken(r)}/image.png`;
    const out = await line.pushMessages({
      to: c ? c.line_user_id : '',
      messages: [line.imageMessage(imgUrl), line.receiptFlex({ ...r, share_url: url })],
      summary: `收據 ${r.receipt_no}　NT$ ${r.amount}`,
      kind: 'receipt', client_id: r.client_id, user: req.user
    });
    return res.json({ ...out, image_url: imgUrl, share_url: url });
  }
  const out = await line.pushFlex({
    to: c ? c.line_user_id : '', flex: line.receiptFlex({ ...r, share_url: url }), kind: 'receipt',
    client_id: r.client_id, user: req.user
  });
  res.json({ ...out, share_url: url });
});

// ---- 個案端：憑連結檢視收據（免登入）----
// 個案收到的 LINE 連結就是這一條。token 是隨機 32 碼，作廢或重開時會清掉讓舊連結失效。
function byToken(token) {
  const t = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(t)) return null;
  return db.prepare(`${LIST_SQL} WHERE r.share_token = ? AND r.status = 'valid'`).get(t) || null;
}
router.get('/public/receipts/:token', (req, res) => {
  const r = byToken(req.params.token);
  if (!r) return res.status(404).json({ error: '這張收據的連結已失效，請與諮商所聯繫' });
  // 個案端只需要憑證本身，不給內部欄位（開立人、補印次數、收費單編號等）
  // 個案端拿到的就是憑證本身（含開立人，與列印出來的那張同一份版面），
  // 但內部欄位（收費單編號、補印次數、token、圖檔名）一律不出去。
  const { invoice_id, issued_by, print_count, last_printed_at, share_token, image_name,
    invoice_status, ...safe } = r;
  const lines = linesOf(r.id).map(({ id, ...l }) => l);
  res.json({ ...safe, ...centerBlock(), lines });
});

module.exports = router;
