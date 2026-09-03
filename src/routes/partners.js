const express = require('express');
const { db, audit, today, nowStamp, getSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 合作單位：學校認輔、企業 EAP、社會局委託、司法轉介。
// 這類案源的費用不向個案收，而是按月彙整向單位請款。
const FIELDS = ['name', 'type', 'contact', 'phone', 'email', 'address', 'tax_id', 'contract_no',
  'contract_start', 'contract_end', 'rate', 'quota_sessions', 'settle_note', 'note',
  // 機構核銷：多久核銷一次、哪幾個月、要附什麼資料
  'billing_cycle', 'billing_months', 'billing_docs'];

router.get('/partners', requireStaff('partners'), (req, res) => {
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM clients c WHERE c.partner_id = p.id AND c.active = 1) AS client_count,
      (SELECT COUNT(*) FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE c.partner_id = p.id AND a.status = 'done') AS used_sessions
    FROM partners p ORDER BY p.active DESC, p.id`).all();
  res.json(rows.map(p => ({
    ...p,
    remaining: p.quota_sessions ? p.quota_sessions - p.used_sessions : null,
    expiring: p.contract_end && p.contract_end <= require('../db').addDays(today(), 60)
  })));
});

router.post('/partners', requireStaff('partners'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫單位名稱' });
  const cols = FIELDS.filter(f => b[f] !== undefined);
  const info = db.prepare(`INSERT INTO partners (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(f => ['rate', 'quota_sessions'].includes(f) ? (Number(b[f]) || 0) : String(b[f] ?? '')));
  audit('staff', req.user.id, req.user.name, '新增合作單位', b.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/partners/:id', requireStaff('partners'), (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此單位' });
  const b = req.body || {};
  const data = {};
  for (const f of FIELDS) if (b[f] !== undefined) data[f] = ['rate', 'quota_sessions'].includes(f) ? (Number(b[f]) || 0) : String(b[f] ?? '');
  if (b.active !== undefined) data.active = b.active ? 1 : 0;
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE partners SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), p.id);
  audit('staff', req.user.id, req.user.name, '修改合作單位', p.name);
  res.json({ ok: true });
});

// 單位明細：個案名單與請款紀錄
router.get('/partners/:id', requireStaff('partners'), (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此單位' });
  res.json({
    ...p,
    clients: db.prepare(`SELECT c.id, c.code, c.name, c.status, u.name AS counselor_name,
        (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS sessions
      FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
      WHERE c.partner_id = ? AND c.active = 1 ORDER BY c.id DESC`).all(p.id),
    settlements: db.prepare('SELECT * FROM settlements WHERE partner_id = ? ORDER BY month DESC').all(p.id),
    groups: db.prepare('SELECT id, name, status, start_date FROM groups WHERE partner_id = ?').all(p.id)
  });
});

// 產生某月請款單：彙整該單位個案當月已完成的晤談，依議定價計費
router.post('/settlements', requireStaff('partners'), (req, res) => {
  const partnerId = Number(req.body && req.body.partner_id) || 0;
  const month = (req.body && req.body.month) || today().slice(0, 7);
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);
  if (!p) return res.status(400).json({ error: '請選擇合作單位' });
  if (db.prepare('SELECT 1 FROM settlements WHERE partner_id = ? AND month = ?').get(partnerId, month)) {
    return res.status(400).json({ error: '該月請款單已存在' });
  }
  const rows = db.prepare(`SELECT a.id, a.fee FROM appointments a JOIN clients c ON c.id = a.client_id
    WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?`).all(partnerId, month);
  if (!rows.length) return res.status(400).json({ error: '該月無可請款的晤談紀錄' });
  const rate = p.rate || 0;
  const amount = rate ? rows.length * rate : rows.reduce((s, r) => s + r.fee, 0);
  const info = db.prepare(`INSERT INTO settlements (partner_id, month, sessions, amount, created_by)
    VALUES (?,?,?,?,?)`).run(partnerId, month, rows.length, amount, req.user.id);
  audit('staff', req.user.id, req.user.name, '產生請款單', p.name, { month, sessions: rows.length, amount });
  res.json({ id: info.lastInsertRowid, sessions: rows.length, amount });
});

router.get('/settlements', requireStaff('partners'), (req, res) => {
  const { status = '', partner_id = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('s.status = ?'); args.push(status); }
  if (partner_id) { where.push('s.partner_id = ?'); args.push(Number(partner_id)); }
  res.json(db.prepare(`SELECT s.*, p.name AS partner_name, p.tax_id, p.contact
    FROM settlements s JOIN partners p ON p.id = s.partner_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.status = 'paid', s.month DESC`).all(...args));
});

// 請款單明細（可列印的對帳單：以個案編號列示，不列姓名）
router.get('/settlements/:id', requireStaff('partners'), (req, res) => {
  const s = db.prepare(`SELECT s.*, p.name AS partner_name, p.tax_id, p.contact, p.address, p.rate
    FROM settlements s JOIN partners p ON p.id = s.partner_id WHERE s.id = ?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  const items = db.prepare(`SELECT a.date, a.start_time, a.type, a.fee, c.code AS client_code,
      u.name AS counselor_name
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?
    ORDER BY a.date, a.start_time`).all(s.partner_id, s.month);

  // 明細是即時查詢，總額卻是建立當下的快照。若期間有晤談補登或狀態異動，兩者會對不起來。
  // 這裡只回報差異、不自動改寫金額——請款單是對外文件，數字要由人決定何時更新。
  const current = { sessions: items.length, amount: s.rate ? items.length * s.rate : items.reduce((t, r) => t + r.fee, 0) };
  const mismatch = current.sessions !== s.sessions || current.amount !== s.amount ? current : null;
  res.json({
    ...s, items, mismatch,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director'),
    center_tax_id: getSetting('center_tax_id')
  });
});

// 依目前晤談紀錄重新計算金額。已送出或入帳者不開放，避免對外文件被無聲改動。
router.post('/settlements/:id/recalculate', requireStaff('partners'), (req, res) => {
  const s = db.prepare('SELECT s.*, p.rate FROM settlements s JOIN partners p ON p.id = s.partner_id WHERE s.id = ?')
    .get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  if (s.status !== 'draft') return res.status(400).json({ error: '已送出或已入帳的請款單不可重新計算' });
  const rows = db.prepare(`SELECT a.fee FROM appointments a JOIN clients c ON c.id = a.client_id
    WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?`).all(s.partner_id, s.month);
  const amount = s.rate ? rows.length * s.rate : rows.reduce((t, r) => t + r.fee, 0);
  db.prepare('UPDATE settlements SET sessions = ?, amount = ? WHERE id = ?').run(rows.length, amount, s.id);
  audit('staff', req.user.id, req.user.name, '重算請款單', String(s.id),
    { before: { sessions: s.sessions, amount: s.amount }, after: { sessions: rows.length, amount } });
  res.json({ ok: true, sessions: rows.length, amount });
});

router.post('/settlements/:id/status', requireStaff('partners'), (req, res) => {
  const s = db.prepare('SELECT * FROM settlements WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  const { status, invoice_no = s.invoice_no, note = s.note } = req.body || {};
  if (!['draft', 'sent', 'paid'].includes(status)) return res.status(400).json({ error: '狀態不正確' });
  db.prepare(`UPDATE settlements SET status = ?, invoice_no = ?, note = ?,
    sent_at = CASE WHEN ? IN ('sent','paid') AND sent_at = '' THEN ? ELSE sent_at END,
    paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END WHERE id = ?`)
    .run(status, invoice_no, note, status, nowStamp(), status, nowStamp(), s.id);
  audit('staff', req.user.id, req.user.name, '請款單狀態異動', String(s.id), { status });
  res.json({ ok: true });
});

router.delete('/settlements/:id', requireStaff('partners'), (req, res) => {
  const s = db.prepare('SELECT * FROM settlements WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  if (s.status === 'paid') return res.status(400).json({ error: '已入帳的請款單不可刪除' });
  db.prepare('DELETE FROM settlements WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// ---- 機構核銷總表 ----
//
// 每家單位核銷的頻率不同（有的每月、有的每季 1、4、7、10 月），要附的資料也不同。
// 這張表把「這個月要跟誰核銷、要準備什麼、請款單開了沒」放在同一頁，
// 櫃檯不必再各自記在紙上；核銷方式與應附資料在合作單位資料裡編輯。

const CYCLES = {
  monthly: '每月',
  quarterly: '每季',
  half_year: '每半年',
  yearly: '每年',
  per_case: '逐案結案後',
  other: '其他（見備註）'
};

// 這個月輪不輪到這家單位核銷：每月一律要；指定月份者看月份對不對得上
function dueThisMonth(p, month) {
  const m = Number(String(month).slice(5, 7));
  const list = String(p.billing_months || '').split(/[,，]/).map(x => Number(x.trim())).filter(Boolean);
  if (list.length) return list.includes(m);
  if (p.billing_cycle === 'monthly') return true;
  if (p.billing_cycle === 'quarterly') return [1, 4, 7, 10].includes(m);
  if (p.billing_cycle === 'half_year') return [1, 7].includes(m);
  if (p.billing_cycle === 'yearly') return m === 1;
  return false;
}

function billingRows(month) {
  const partners = db.prepare("SELECT * FROM partners WHERE active = 1 ORDER BY id").all();
  const settle = db.prepare('SELECT * FROM settlements WHERE month = ?').all(month);
  return partners.map(p => {
    const s = settle.find(x => x.partner_id === p.id) || null;
    // 這個月這家單位有多少可核銷的晤談，櫃檯才知道要不要開請款單
    const sessions = db.prepare(`SELECT COUNT(*) n FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?`).get(p.id, month).n;
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      cycle: p.billing_cycle || '',
      cycle_label: CYCLES[p.billing_cycle] || (p.billing_cycle ? p.billing_cycle : '未設定'),
      months: p.billing_months || '',
      docs: p.billing_docs || '',
      settle_note: p.settle_note || '',
      contact: p.contact || '',
      phone: p.phone || '',
      due: dueThisMonth(p, month),
      sessions,
      settlement_status: s ? s.status : 'none',
      settlement_amount: s ? s.amount : 0
    };
  });
}

router.get('/partners-billing', requireStaff('partners'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  res.json({ month, cycles: Object.entries(CYCLES).map(([k, v]) => ({ key: k, label: v })), rows: billingRows(month) });
});

const SETTLE_LABEL = { none: '尚未開立', draft: '草稿', sent: '已請款', paid: '已入帳' };

// 列印／匯出：就是所方原本那張「機構核銷」表（機構名稱、核銷方式、核銷需要資料）
router.get('/partners-billing/print', requireStaff('partners'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const forWord = req.query.format === 'doc';
  const onlyDue = req.query.due === '1';
  const rows = billingRows(month).filter(r => !onlyDue || r.due);
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nl = v => esc(v).replace(/\n/g, '<br>');
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>機構核銷－${esc(month)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
    color: #1c2b2b; font-size: 13px; line-height: 1.8; }
  h1 { font-size: 20px; text-align: center; letter-spacing: 3px; margin: 0 0 4px; }
  .sub { text-align: center; font-size: 12px; color: #667; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #444; padding: 7px 9px; vertical-align: top; }
  th { background: #f2f5f5; text-align: left; }
  .due { color: #b4381f; font-weight: 600; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
<h1>${esc(getSetting('center_name', ''))}　機構核銷</h1>
<div class="sub">${esc(month)}　${onlyDue ? '（僅列本月應核銷）' : ''}共 ${rows.length} 家</div>
<table><tr><th style="width:22%">機構名稱</th><th style="width:18%">核銷方式</th>
  <th>核銷需要資料</th><th style="width:18%">本月狀態</th></tr>
${rows.map(r => `<tr><td>${esc(r.name)}</td>
  <td>${esc(r.cycle_label)}${r.months ? `（${esc(r.months)} 月）` : ''}</td>
  <td>${nl(r.docs) || '－'}${r.settle_note ? `<div style="color:#667">${nl(r.settle_note)}</div>` : ''}</td>
  <td>${r.due ? '<span class="due">本月應核銷</span><br>' : ''}
    可核銷 ${r.sessions} 次<br>請款單：${esc(SETTLE_LABEL[r.settlement_status])}</td></tr>`).join('')}
</table>
${forWord ? '' : '<script>if (location.hash !== \'#noprint\') setTimeout(() => window.print(), 300);<\/script>'}
</body></html>`;
  audit('staff', req.user.id, req.user.name, forWord ? '匯出機構核銷表（Word）' : '列印機構核銷表', month);
  if (forWord) {
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="partners_billing_${month}.doc"`);
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  res.send(html);
});

module.exports = router;
