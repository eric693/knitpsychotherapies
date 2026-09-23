// 補發個案端密碼：把「專區開著、卻沒有密碼」的個案補上預設密碼（號碼末 6 碼）。
//
// 為什麼會有這種個案：建檔當下沒留手機（兒青個案的號碼常常只填在法定代理人電話，
// 家人共用一支手機時系統本來就要櫃檯把本人欄留空），而密碼只在建檔那一刻由手機產生，
// 於是專區開了卻永遠登不進去 —— 家長也就沒辦法進去綁 LINE。
//
//   node scripts/fix-portal-logins.js          # 只看清單，不寫入
//   node scripts/fix-portal-logins.js --apply  # 實際補發
//
// 補發的密碼一律標記為「首次登入須更換」。已經有密碼的個案不會被動到。

const { db, audit } = require('../src/db');
const bcrypt = require('bcryptjs');

const apply = process.argv.includes('--apply');
const digits = s => String(s || '').replace(/\D/g, '');
// 本人手機優先，沒有就用法定代理人電話（與 src/routes/clients.js 的 portalPhone 同一套規則）
const portalPhone = c => [c.phone, c.guardian_phone].map(digits).find(d => d.length >= 6) || '';

const rows = db.prepare(`SELECT id, code, name, phone, guardian_phone, is_minor, password_hash
  FROM clients WHERE active = 1 AND portal_enabled = 1`).all();

const fixable = [], stuck = [];
for (const c of rows) {
  if (c.password_hash) continue;
  const p = portalPhone(c);
  if (p) fixable.push({ ...c, use: p, pw: p.slice(-6) });
  else stuck.push(c);
}

console.log(`專區開啟中的個案 ${rows.length} 位，其中沒有密碼的 ${fixable.length + stuck.length} 位。\n`);

if (fixable.length) {
  console.log(`可補發（${fixable.length} 位）：`);
  for (const c of fixable) {
    const src = digits(c.phone).length >= 6 ? '本人手機' : '法代電話';
    console.log(`  ${c.code}  ${c.name}${c.is_minor ? '（未成年）' : ''}　${src} ${c.use}　密碼 ${c.pw}`);
  }
}
if (stuck.length) {
  console.log(`\n無號碼可用、需櫃檯補資料（${stuck.length} 位）：`);
  for (const c of stuck) console.log(`  ${c.code}  ${c.name}`);
}

// 一支手機對到多位個案：登入會進到其中一位，其餘家人要在個案頁設「授權家人代訂」才看得到
const byPhone = new Map();
for (const c of rows) {
  const p = portalPhone(c);
  if (p) byPhone.set(p, [...(byPhone.get(p) || []), c]);
}
const shared = [...byPhone.entries()].filter(([, l]) => l.length > 1);
if (shared.length) {
  console.log(`\n一支手機對到多位個案（${shared.length} 組）——`
    + `家長登入後只會看到其中一位，其餘請到個案頁設「授權家人代訂」：`);
  for (const [p, l] of shared) console.log(`  ${p}　${l.map(c => `${c.code} ${c.name}`).join(' ／ ')}`);
}

if (!apply) {
  console.log('\n以上為試算，未寫入任何資料。確認無誤後加 --apply 實際補發。');
  process.exit(0);
}

const upd = db.prepare('UPDATE clients SET password_hash = ?, must_change_password = 1 WHERE id = ?');
db.transaction(() => {
  for (const c of fixable) upd.run(bcrypt.hashSync(c.pw, 10), c.id);
})();
audit('staff', 0, '系統維護', '批次補發個案端密碼', `${fixable.length} 位`);
console.log(`\n已補發 ${fixable.length} 位的預設密碼（首次登入須更換）。`);
