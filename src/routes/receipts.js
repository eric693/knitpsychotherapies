// 收據：晤談結束後個案若需要就開一張，帶流水編號；當下不要、事後再要也能補開。
//
// 與收費單分開的理由：收費單是帳（該收多少、收了沒），收據是給個案的憑證。
// 個案報稅／向公司請款常常是幾個月後才來要，屆時不該去動已經結掉的帳，
// 只要依原收費單補開一張收據即可。開錯則作廢並重開新號，兩張互相勾稽。

const express = require('express');
const { db, audit, today, nowStamp, getSetting, listSetting, nextReceiptNo, withUniqueRetry } = require('../db');
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
    receipt_stamp_image: getSetting('receipt_stamp_image')
  };
}

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
    ORDER BY i.paid_at DESC, i.id DESC LIMIT 200`).all();
  res.json(rows);
});

router.get('/receipts/:id', requireStaff('billing'), (req, res) => {
  const r = db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  res.json({ ...r, ...centerBlock() });
});

// 開立（或補開）收據。
// 帶 invoice_id 即依該筆收費單開立；不帶則為手動開立（如代收代付、雜項）。
router.post('/receipts', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  let inv = null;
  if (b.invoice_id) {
    inv = db.prepare(`SELECT i.*, a.date AS service_date, a.counselor_id, a.plan_id AS appt_plan_id
      FROM invoices i LEFT JOIN appointments a ON a.id = i.appointment_id WHERE i.id = ?`).get(Number(b.invoice_id));
    if (!inv) return res.status(404).json({ error: '找不到此收費單' });
    if (inv.status === 'void') return res.status(400).json({ error: '已作廢的收費單不可開立收據' });
    const dup = db.prepare("SELECT receipt_no FROM receipts WHERE invoice_id = ? AND status = 'valid'").get(inv.id);
    if (dup && !b.allow_duplicate) {
      return res.status(400).json({ error: `此收費單已開立收據（${dup.receipt_no}），如需重開請先作廢原收據` });
    }
  }
  const clientId = Number(b.client_id) || (inv && inv.client_id) || 0;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(400).json({ error: '請選擇個案' });

  const amount = Math.max(0, Math.round(Number(b.amount !== undefined && b.amount !== '' ? b.amount : (inv ? inv.amount : 0))));
  if (!amount) return res.status(400).json({ error: '請填寫金額' });

  const planName = b.plan_name || (inv && inv.appt_plan_id
    ? (db.prepare('SELECT name FROM service_plans WHERE id = ?').get(inv.appt_plan_id) || {}).name || '' : '');
  const counselorName = b.counselor_name || (inv && inv.counselor_id
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(inv.counselor_id) || {}).name || '' : '');

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
      String(b.item || (inv ? inv.item : '心理諮商服務費')), amount,
      String(b.method || (inv ? inv.method : '') || ''),
      planName, counselorName,
      b.service_date || (inv ? inv.service_date || inv.date : ''),
      String(b.note || ''), String(b.reissue_of || ''), req.user.id);
    // 收費單上也留一份收據號，帳務畫面才看得出這筆已開過憑證
    if (inv && !inv.receipt_no) db.prepare('UPDATE invoices SET receipt_no = ? WHERE id = ?').run(receiptNo, inv.id);
    return { no: receiptNo, info: row };
  });
  audit('staff', req.user.id, req.user.name, '開立收據', client.code, { receipt_no: no, amount });
  res.json({ id: info.lastInsertRowid, receipt_no: no });
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
  db.prepare("UPDATE receipts SET status = 'void', void_reason = ? WHERE id = ?").run(reason, r.id);
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
      if (r.invoice_id) db.prepare('UPDATE invoices SET receipt_no = ? WHERE id = ?').run(newNo, r.invoice_id);
    })();
    return newNo;
  });
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

// 以 LINE 推播收據內容（個案已綁定官方帳號時）
router.post('/receipts/:id/line', requireStaff('billing'), async (req, res) => {
  const r = db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此收據' });
  const c = db.prepare('SELECT line_user_id FROM clients WHERE id = ?').get(r.client_id);
  const out = await line.pushFlex({
    to: c ? c.line_user_id : '', flex: line.receiptFlex(r), kind: 'receipt',
    client_id: r.client_id, user: req.user
  });
  res.json(out);
});

module.exports = router;
