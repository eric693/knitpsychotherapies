#!/usr/bin/env node
// 匯入所內原本用 Google 試算表管的「諮商室使用表」。
//
// 用法：
//   node scripts/import-room-sheet.js <檔案> --week=2025-02-17          # 試算（不寫入）
//   node scripts/import-room-sheet.js <檔案> --week=2025-02-17 --apply  # 實際寫入
//
// 檔案吃 Google 試算表匯出的 .html 或 .csv（副檔名決定用哪個解析器）：
//   第 2 列是表頭，A 欄是空間（rowspan 跨整個區塊），
//   其後每 3 欄為一天：時段 / 使用者 / 使用心理師。
// 相鄰且同人的 30 分鐘格會合併成一筆晤談。
//
// 缺的個案與心理師一律自動建立（心理師建成停用帳號，待補資料後啟用）。

const fs = require('fs');
const path = require('path');
const { db, audit, nextClientCode, addDays, today } = require('../src/db');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');   // xlsx 有上百週，預設只印每週小計
const weekArg = (args.find(a => a.startsWith('--week=')) || '').slice(7);

if (!file || !weekArg) {
  console.error('用法：node scripts/import-room-sheet.js <檔案> --week=YYYY-MM-DD [--apply] [--verbose]');
  console.error('  csv/html：--week 為該表的週一');
  console.error('  xlsx    ：一次讀完所有分頁，週次由分頁名稱推算，--week 只取年份當起算年');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(weekArg)) {
  console.error('--week 需為 YYYY-MM-DD');
  process.exit(1);
}

// 試算表的空間名稱 → 系統裡的諮商室名稱
const ROOM_ALIAS = {
  '諮商室1': '諮商室 A',
  '諮商室2': '諮商室 B',
  '諮商室3': '諮商室Ｃ',
  '團體室': '團體室',
  '遊戲治療室': '遊戲治療室'
};

// ---- 解析 HTML ----------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// 回傳二維陣列，並把 rowspan/colspan 展開成實際格子
function parseTable(html) {
  const body = html.slice(html.indexOf('<tbody'));
  const rowsHtml = [...body.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m => m[0]);
  const grid = [];
  const pending = []; // rowspan 佔位：{ col, rows, text }
  rowsHtml.forEach((rowHtml, r) => {
    const row = [];
    for (const p of pending) {
      if (p.rows > 0) { row[p.col] = p.text; p.rows -= 1; }
    }
    const cells = [...rowHtml.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)];
    let col = 0;
    for (const [, attrs, inner] of cells) {
      if (/class="row-header/.test(attrs)) continue; // 列號欄
      while (row[col] !== undefined) col += 1;
      const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
      const rowspan = Number((attrs.match(/rowspan="(\d+)"/) || [])[1] || 1);
      const colspan = Number((attrs.match(/colspan="(\d+)"/) || [])[1] || 1);
      for (let c = 0; c < colspan; c += 1) {
        row[col + c] = text;
        if (rowspan > 1) pending.push({ col: col + c, rows: rowspan - 1, text });
      }
      col += colspan;
    }
    grid[r] = row;
  });
  return grid;
}

// CSV 版（Google 試算表「下載 → CSV」）：空間只寫在區塊第一列，其餘留白，往下補齊
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  let room = '';
  for (const r of rows) {
    if ((r[0] || '').trim()) room = r[0].trim(); else r[0] = room;
  }
  return rows;
}

const WEEKDAY_COL = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

// 表頭那列：含「空間」與「時段」。每個「時段」欄的右邊兩欄就是該日的個案與使用心理師。
function findHeader(grid) {
  return grid.find(r => r && r.some(c => (c || '').trim() === '空間') && r.some(c => (c || '').trim() === '時段')) || null;
}

function dayBlocks(headerRow) {
  const blocks = [];
  headerRow.forEach((cell, i) => {
    if ((cell || '').trim() !== '時段') return;
    blocks.push({ dayIndex: blocks.length, timeCol: i, clientCol: i + 1, counselorCol: i + 2 });
  });
  return blocks;
}

// 表頭的日欄有時直接寫日期（「2026-06-15」「6/16週二」），有就以它為準，
// 比分頁名稱可靠；只寫「週一…週日」的舊分頁才退回用分頁名稱推算的週一。
function mondayFromHeader(headerRow, blocks, fallbackYear) {
  for (const b of blocks) {
    const raw = (headerRow[b.clientCol] || '').trim();
    let full = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
    if (!full) {
      const md = /(?:^|[^\d])(\d{1,2})[\/月](\d{1,2})/.exec(raw);
      if (md && fallbackYear) full = [null, String(fallbackYear), md[1], md[2]];
    }
    if (!full) continue;
    const date = `${full[1]}-${String(Number(full[2])).padStart(2, '0')}-${String(Number(full[3])).padStart(2, '0')}`;
    if (Number.isNaN(new Date(date + 'T00:00:00').getTime())) continue;
    return addDays(date, -b.dayIndex);
  }
  return null;
}

// 回傳 { slots, monday }；monday 為 null 表示表頭沒寫日期，要由呼叫端決定
function parseSheet(raw, kind, fallbackYear) {
  const grid = kind === 'grid' ? raw : (kind ? parseCsv(raw) : parseTable(raw));
  const headerRow = findHeader(grid);
  if (!headerRow) return null;   // 空白或非使用表的分頁
  const blocks = dayBlocks(headerRow);
  if (blocks.length < 7) return null;
  const slots = [];
  for (const row of grid) {
    if (!row || row === headerRow) continue;
    const room = (row[0] || '').trim();
    if (!ROOM_ALIAS[room]) continue;
    for (const b of blocks) {
      const time = (row[b.timeCol] || '').trim();
      const m = time.match(/^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/);
      if (!m) continue;
      const client = (row[b.clientCol] || '').trim();
      const counselor = (row[b.counselorCol] || '').trim();
      if (!client && !counselor) continue;
      slots.push({ room, dayIndex: b.dayIndex, start: m[1], end: m[2], client, counselor });
    }
  }
  return { slots, monday: mondayFromHeader(headerRow, blocks, fallbackYear) };
}

// 相鄰、同一天同一室同一組人的格子合併成一筆
function mergeSlots(slots) {
  const key = s => [s.room, s.dayIndex, s.client, s.counselor].join('|');
  const byKey = new Map();
  for (const s of slots) {
    if (!byKey.has(key(s))) byKey.set(key(s), []);
    byKey.get(key(s)).push(s);
  }
  const out = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    let cur = null;
    for (const s of list) {
      if (cur && cur.end === s.start) { cur.end = s.end; continue; }
      if (cur) out.push(cur);
      cur = { ...s };
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => (a.dayIndex - b.dayIndex) || a.start.localeCompare(b.start) || a.room.localeCompare(b.room));
}

// ---- 對應到系統資料 ------------------------------------------------------

// 格子裡除了姓名還常夾註記：「吳維妮 視訊」「黃子倪伴侶」「（轉帳）楊心慈」「陳小戈(大學」
// 「顏晉亦/于琁」（伴侶兩人）。這裡把註記剝到 note，並據以決定晤談類型與形式。
const TAGS = [
  { re: /視訊/, apply: o => { o.mode = 'online'; } },
  { re: /伴侶/, apply: o => { o.type = 'couple'; } },
  { re: /家族/, apply: o => { o.type = 'family'; } },
  { re: /團體/, apply: o => { o.type = 'group'; } },
  { re: /初談/, apply: o => { o.type = 'intake'; } }
];
const NOISE = /視訊|轉帳|伴侶|家族|團體|大學生|無收據|複診|\d+\s*分/g;

// 姓名後面的方案字樣：所方在使用表上用它區分該次算哪個方案
const PLAN_TAG = /(學生|教師|國軍|捷運|馬太鞍|青壯)$/;

// 使用表的姓名尾端數字＝該個案在該方案下的第幾次晤談（「王小美11」＝第 11 次），
// 不是名字的一部分；剝下來記到備註，姓名保持乾淨，才不會一個人被拆成好幾筆個案。
function peelSequence(name) {
  const m = /^(.+?)(\d{1,2})$/.exec(name);
  if (!m) return { name, seq: null };
  return { name: m[1], seq: Number(m[2]) };
}

function normalizeCell(raw) {
  const out = { name: '', type: 'individual', mode: 'onsite', notes: [] };
  let text = String(raw).trim();
  for (const t of TAGS) if (t.re.test(text)) t.apply(out);

  // 括號註記整段搬到備註（括號沒關的也一併吃掉，試算表裡很常見）
  text = text.replace(/[（(]([^）)]*)[）)]?/g, (_, inner) => {
    if (inner.trim()) out.notes.push(inner.trim());
    return ' ';
  });
  const leftover = text.match(NOISE);
  if (leftover) out.notes.push(...leftover.map(x => x.trim()));
  text = text.replace(NOISE, ' ');

  // 一格兩人＝伴侶／家族場次：主要個案掛第一位，其餘記在備註
  const parts = text.split(/[\/／、]/).map(x => x.replace(/\s+/g, '').trim()).filter(Boolean);
  const first = peelSequence(parts[0] || '');
  out.name = first.name;
  out.seq = first.seq;
  if (first.seq) out.notes.push(`第 ${first.seq} 次`);
  const tag = PLAN_TAG.exec(out.name);
  if (tag) { out.planTag = tag[1]; out.name = out.name.slice(0, -tag[1].length); out.notes.push(tag[1]); }
  if (parts.length > 1) {
    if (out.type === 'individual') out.type = 'couple';
    out.notes.push('同時出席：' + parts.slice(1).join('、'));
  }
  out.note = [...new Set(out.notes)].join('；');
  return out;
}

const created = { clients: [], counselors: [] };

function findOrCreateCounselor(name) {
  const row = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (row) return row.id;
  created.counselors.push(name);
  if (!APPLY) return -1;
  // 停用帳號：先讓排班對得上，帳密與證照等所方補齊後再啟用
  const username = 'imported_' + Buffer.from(name).toString('hex').slice(0, 12);
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, name, role, active)
     VALUES (?, '', ?, 'counselor', 0)`
  ).run(username, name);
  return info.lastInsertRowid;
}

function findOrCreateClient(name) {
  const row = db.prepare('SELECT id FROM clients WHERE name = ?').get(name);
  if (row) return row.id;
  created.clients.push(name);
  if (!APPLY) return -1;
  const info = db.prepare(
    `INSERT INTO clients (code, name, status) VALUES (?, ?, 'active')`
  ).run(nextClientCode(), name);
  return info.lastInsertRowid;
}

function roomId(sheetName) {
  const name = ROOM_ALIAS[sheetName];
  const row = db.prepare('SELECT id FROM rooms WHERE name = ?').get(name);
  if (!row) throw new Error(`系統中找不到諮商室「${name}」（試算表寫 ${sheetName}）`);
  return row.id;
}

// ---- 分頁名稱 → 該週週一 ------------------------------------------------

// 分頁名稱形如「113-119」（1/13-1/19）、「1013-1019」（10/13-10/19），可能被引號包住。
// 只寫月日沒有年份，因此依分頁順序推算：月份一旦倒退就是跨年。
function sheetWeeks(names, startYear) {
  let year = startYear, prevMonday = null;
  return names.map(rawName => {
    const t = rawName.replace(/[「」『』\s]/g, '');
    const m = /^(\d{2,4})-(\d{2,4})$/.exec(t);
    if (!m) return { name: rawName, monday: null };
    // 「113」可能是 1/13 也可能是 11/3，「61」是 6/1 — 用「上一頁的下一週」挑最接近的解讀
    const head = m[1];
    const cands = [];
    for (const cut of [1, 2]) {
      if (head.length - cut < 1 || head.length - cut > 2) continue;
      const month = Number(head.slice(0, cut));
      const day = Number(head.slice(cut));
      if (!month || month > 12 || !day || day > 31) continue;
      for (const y of [year, year + 1]) {
        const start = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const d = new Date(start + 'T00:00:00');
        if (Number.isNaN(d.getTime()) || d.getDate() !== day) continue;
        cands.push(addDays(start, -((d.getDay() + 6) % 7)));
      }
    }
    if (!cands.length) return { name: rawName, monday: null };
    const expect = prevMonday ? addDays(prevMonday, 7) : null;
    const pick = expect
      ? cands.reduce((a, b) => (Math.abs(Date.parse(b) - Date.parse(expect)) < Math.abs(Date.parse(a) - Date.parse(expect)) ? b : a))
      : cands[0];
    prevMonday = pick;
    year = Number(pick.slice(0, 4));
    return { name: rawName, monday: pick };
  });
}

// ---- 主流程 --------------------------------------------------------------

const problems = [];
const tidied = [];
const TODAY = today();

// 一張表（已解析成 slots）→ 待寫入的晤談列
function toRows(slots, monday) {
  const rows = [];
  for (const s of slots) {
    const date = addDays(monday, s.dayIndex);
    const c = normalizeCell(s.client);
    if (!c.name) { problems.push(`${date} ${s.start} ${s.room}：只有心理師「${s.counselor}」沒有個案，略過`); continue; }
    if (!s.counselor) { problems.push(`${date} ${s.start} ${s.room}：個案「${s.client}」沒有填使用心理師，略過`); continue; }
    if (c.name !== s.client.trim()) tidied.push(`${s.client} → ${c.name}${c.note ? '（' + c.note + '）' : ''}`);
    // 還沒發生的排班留在「已預約」，不能當成已完成的晤談
    const status = date > TODAY ? 'booked' : 'done';
    rows.push({ ...s, date, clientName: c.name, type: c.type, mode: c.mode, status, note: c.note });
  }
  return rows;
}

// 收集所有分頁（xlsx 一次讀完；csv／html 只有一張，週次由 --week 指定）
const batches = []; // { label, monday, slots }
if (/\.xlsx$/i.test(file)) {
  const { readSheets } = require('../src/xlsx-read');
  const sheets = readSheets(fs.readFileSync(file));
  const weeks = sheetWeeks(sheets.map(sh => sh.name), Number(weekArg.slice(0, 4)));
  sheets.forEach((sh, i) => {
    const { monday: byName, name } = weeks[i];
    // parseSheet 吃二維陣列；xlsx 的空間欄同樣只寫在區塊第一列，往下補齊
    const grid = sh.rows.map(r => r.cells.slice());
    let room = '';
    for (const r of grid) { if ((r[0] || '').trim()) room = r[0].trim(); else r[0] = room; }
    const parsed = parseSheet(grid, 'grid', byName ? Number(byName.slice(0, 4)) : null);
    if (!parsed) { problems.push(`分頁「${name}」不是使用表的格式，略過`); return; }
    const monday = parsed.monday || byName;
    if (!monday) { problems.push(`分頁「${name}」看不出是哪一週（表頭沒日期、分頁名也解不出），略過`); return; }
    if (parsed.monday && byName && parsed.monday !== byName) {
      problems.push(`分頁「${name}」：表頭日期為 ${parsed.monday} 那週，與分頁名稱推算的 ${byName} 不同，以表頭為準`);
    }
    batches.push({ label: name, monday, slots: mergeSlots(parsed.slots) });
  });
} else {
  const raw = fs.readFileSync(file, 'utf8');
  batches.push({
    label: path.basename(file),
    monday: weekArg,
    slots: mergeSlots((parseSheet(raw, /\.csv$/i.test(file)) || { slots: [] }).slots)
  });
}

console.log(`檔案：${path.basename(file)}（${batches.length} 週）\n`);

let total = 0, skipped = 0;
const run = db.transaction(() => {
  for (const b of batches) {
    const rows = toRows(b.slots, b.monday);
    if (!rows.length) continue;
    console.log(`── ${b.label}　${b.monday} ～ ${addDays(b.monday, 6)}　${rows.length} 筆`);
    for (const r of rows) {
      const cid = findOrCreateClient(r.clientName);
      const uid = findOrCreateCounselor(r.counselor);
      const rid = roomId(r.room);
      const dup = APPLY && db.prepare(
        `SELECT id FROM appointments WHERE client_id = ? AND date = ? AND start_time = ?`
      ).get(cid, r.date, r.start);
      if (dup) { skipped += 1; continue; }
      total += 1;
      if (VERBOSE) {
        console.log(`   ${r.date} ${r.start}-${r.end}  ${ROOM_ALIAS[r.room]}  ${r.clientName} / ${r.counselor}${r.note ? '（' + r.note + '）' : ''}`);
      }
      if (!APPLY) continue;
      db.prepare(
        `INSERT INTO appointments (client_id, counselor_id, room_id, date, start_time, end_time,
                                   type, mode, status, source, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff', ?)`
      ).run(cid, uid, rid, r.date, r.start, r.end, r.type, r.mode, r.status, r.note);
    }
  }
  if (APPLY) audit('system', null, '匯入', '諮商室使用表匯入', `${path.basename(file)} 共 ${total} 筆`);
});
run();

console.log(`\n合計 ${total} 筆${skipped ? `，另有 ${skipped} 筆已存在略過` : ''}`);
if (created.clients.length) console.log(`新建個案 ${new Set(created.clients).size} 位：${[...new Set(created.clients)].join('、')}`);
if (created.counselors.length) console.log(`新建心理師（停用帳號，待補資料）：${[...new Set(created.counselors)].join('、')}`);
if (tidied.length) console.log(`\n名稱含註記已整理 ${tidied.length} 筆，例如：\n` + [...new Set(tidied)].slice(0, 15).map(t => '  - ' + t).join('\n'));
if (problems.length) console.log('\n需注意：\n' + problems.map(p => '  - ' + p).join('\n'));
console.log(APPLY ? '\n已寫入資料庫。' : '\n以上為試算，未寫入。加上 --apply 才會實際匯入。');
