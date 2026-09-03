#!/usr/bin/env node
// 把 Google 表單的「回應試算表」補匯入成後台的線上預約申請。
//
// 為什麼需要這支：Apps Script 的 backfill() 只拿得到「該筆回應當時、且現在仍存在」
// 的題目，表單改版後舊回應會缺姓名、email 等欄位而收不進來。回應試算表保留了每一
// 個欄位（含後來刪掉的題目），所以歷史資料一律走這裡。
//
// 用法：
//   1. 表單 →「回應」分頁 → 試算表圖示開啟 → 檔案 → 下載 → 逗號分隔值 (.csv)
//   2. node scripts/import-form-responses.js <檔案.csv>          # 試算，不寫入
//      node scripts/import-form-responses.js <檔案.csv> --apply  # 實際寫入
//
// 可重複執行：以「時間戳記＋姓名」去重，重跑不會產生第二筆。

const fs = require('fs');
const { ingest } = require('../src/form-ingest');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
if (!file) {
  console.error('用法：node scripts/import-form-responses.js <回應試算表.csv> [--apply]');
  process.exit(1);
}

// 試算表的作答本身可能含逗號與換行，所以照 CSV 規則自己切，不能用 split(',')
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
if (rows.length < 2) { console.error('這個檔案沒有資料列'); process.exit(1); }
const headers = rows[0].map(h => h.trim());
console.log(`欄位 ${headers.length} 個、資料 ${rows.length - 1} 列`);
console.log(APPLY ? '模式：實際寫入\n' : '模式：試算（不寫入），確認無誤後加 --apply\n');

let ok = 0, dup = 0, fail = 0;
const failReasons = new Map();
for (let i = 1; i < rows.length; i++) {
  const answers = {};
  headers.forEach((h, j) => { if (h && String(rows[i][j] || '').trim()) answers[h] = rows[i][j]; });
  // 時間戳記是試算表自帶的欄位，不是表單題目，拿來當去重的識別碼
  const stamp = answers['時間戳記'] || answers['Timestamp'] || `列${i}`;
  const externalId = `sheet:${stamp}`;

  if (!APPLY) {
    // 試算時不寫入，只把姓名／電話／方案挑出來讓人先看過
    const keys = Object.keys(answers);
    const g = (...w) => {
      for (const k of w) { const h = keys.find(x => x.replace(/\s/g, '').includes(k)); if (h) return answers[h]; }
      return '';
    };
    const name = g('姓名', '名字'), phone = g('電話', '手機');
    if (!name || !phone) { fail++; failReasons.set(stamp, `缺姓名或電話（欄位：${keys.join('｜')}）`); }
    else { ok++; if (ok <= 5) console.log(`  ${stamp}  ${name}  ${phone}  ${g('預約項目', '方案') || '(未選方案)'}`); }
    continue;
  }

  const out = ingest(answers, { externalId });
  if (out.error) { fail++; failReasons.set(stamp, `${out.error}（欄位：${(out.titles || []).join('｜')}）`); }
  else if (out.duplicated) dup++;
  else {
    ok++;
    if (out.warnings.length) console.log(`  #${out.id} ${out.name}：${out.warnings.join('；')}`);
  }
}

console.log(`\n${APPLY ? '已匯入' : '可匯入'} ${ok} 筆${dup ? `、已存在略過 ${dup} 筆` : ''}${fail ? `、無法匯入 ${fail} 筆` : ''}`);
if (fail) {
  console.log('\n無法匯入的（前 10 筆）：');
  [...failReasons].slice(0, 10).forEach(([k, v]) => console.log(`  ${k}：${v}`));
  console.log('多半是當年那筆真的沒填姓名或電話，可在試算表裡補齊後重跑。');
}
if (!APPLY) console.log('確認無誤後加 --apply 實際寫入。');
