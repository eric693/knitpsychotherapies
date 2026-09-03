#!/usr/bin/env node
// 修正「諮商室使用表」匯入時把姓名尾端數字當成名字的一部分而拆出的重複個案。
//
// 使用表上「王小美11」的 11 是該個案在該方案下的第 11 次晤談，不是名字。
// 早期匯入沒有剝掉，於是同一個人被拆成「王小美」「王小美1」「王小美2」…。
// 這支把它們合併回同一筆個案，次數則寫進該筆預約的備註（「第 11 次」）。
//
//   node scripts/merge-sheet-clients.js          # 試算，不寫入
//   node scripts/merge-sheet-clients.js --apply  # 實際合併

const { db, audit } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const PLAN_TAG = /(學生|教師|國軍|捷運|馬太鞍|青壯)$/;

// 參照 clients(id) 的所有表，合併時一併改指到保留的個案
const REF_TABLES = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  .map(r => r.name)
  .filter(t => db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'client_id'));

function peel(name) {
  const m = /^(.+?)(\d{1,2})$/.exec(name);
  let base = m ? m[1] : name, seq = m ? Number(m[2]) : null;
  const tag = PLAN_TAG.exec(base);
  if (tag) base = base.slice(0, -tag[1].length);
  return { base, seq, tag: tag ? tag[1] : null };
}

const clients = db.prepare('SELECT * FROM clients').all();
const groups = new Map();
for (const c of clients) {
  const { base, seq, tag } = peel(c.name);
  if (!base) continue;
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push({ ...c, seq, tag });
}

// 只處理真的有被拆開的姓名（同一個 base 有兩筆以上，或單筆但名字帶數字／方案字樣）
const targets = [...groups].filter(([, list]) => list.length > 1 || list[0].seq || list[0].tag);

let merged = 0, renamed = 0, tagged = 0, skipped = [];
const run = db.transaction(() => {
  for (const [base, list] of targets) {
    // 有填個資的那筆最可信；否則留 id 最小（最早建立）的
    const score = c => (c.id_no ? 8 : 0) + (c.phone ? 4 : 0) + (c.birth_date ? 2 : 0) + (c.email ? 1 : 0);
    const keep = list.slice().sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
    const drop = list.filter(c => c.id !== keep.id);

    // 兩筆以上都有個資且不一致，可能是同名不同人，先不動、列出來人工確認
    const withId = list.filter(c => c.id_no).map(c => c.id_no);
    if (new Set(withId).size > 1) { skipped.push(`${base}：${list.map(c => c.name).join('、')}（身分證字號不同，未合併）`); continue; }

    for (const c of list) {
      // 把該筆個案原本名字帶的次數／方案字樣寫進它自己的預約備註
      const appts = db.prepare('SELECT id, note FROM appointments WHERE client_id = ?').all(c.id);
      for (const a of appts) {
        const add = [c.seq ? `第 ${c.seq} 次` : '', c.tag || ''].filter(Boolean);
        if (!add.length) continue;
        const note = [...new Set([...(a.note ? a.note.split('；') : []), ...add])].join('；');
        if (note !== (a.note || '')) { tagged += 1; if (APPLY) db.prepare('UPDATE appointments SET note = ? WHERE id = ?').run(note, a.id); }
      }
    }
    for (const c of drop) {
      for (const t of REF_TABLES) {
        if (APPLY) db.prepare(`UPDATE ${t} SET client_id = ? WHERE client_id = ?`).run(keep.id, c.id);
      }
      if (APPLY) db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
      merged += 1;
    }
    if (keep.name !== base) { renamed += 1; if (APPLY) db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(base, keep.id); }
  }
  if (APPLY) audit('system', null, '整理', '合併使用表重複個案', `合併 ${merged} 筆、更名 ${renamed} 筆`);
});
run();

console.log(`個案總數 ${clients.length} → ${clients.length - merged}`);
console.log(`  合併掉重複個案 ${merged} 筆、姓名去掉尾數／方案字樣 ${renamed} 筆、預約備註補上次數 ${tagged} 筆`);
if (skipped.length) console.log('\n需人工確認：\n' + skipped.map(s => '  - ' + s).join('\n'));
console.log(APPLY ? '\n已寫入資料庫。' : '\n以上為試算，未寫入。加上 --apply 才會實際合併。');
