// 同意書適用性判斷：同一套規則要給所方個案頁與個案專區共用，兩邊看到的清單才會一致。
//
// 篩選兩層：
//   audience  依年齡分群（'' 全部 / child / teen / minor / adult）
//   plan_ids  依方案（逗號分隔的 service_plans.id；留空表示不限方案）
//             國軍、青壯、療育這類方案專屬的同意書，只有實際走該方案的個案才需要簽，
//             否則新個案一進來就看到十來張同意書，不知道哪張跟自己有關。
//
// 「這位個案有哪些方案」＝ 預約、收費單、預約申請三處出現過的 plan_id 聯集：
// 櫃檯直接排約、線上申請、只先開收費單三種進案途徑都算數。

const { db, ageYears } = require('./db');

// 兒少再分兒童與青少年：同意書與表單的用語、適用對象都不同。
function ageGroupOf(birthDate) {
  const age = birthDate ? ageYears(birthDate) : null;
  if (age === null) return '';
  if (age < 12) return 'child';
  if (age < 18) return 'teen';
  return 'adult';
}

function parsePlanIds(v) {
  return String(v || '').split(',').map(s => Number(s.trim())).filter(n => n > 0);
}

// 個案關聯到的方案 id（去重）
function clientPlanIds(clientId) {
  const rows = db.prepare(`
    SELECT DISTINCT plan_id FROM (
      SELECT plan_id FROM appointments     WHERE client_id = ? AND ifnull(plan_id,0) > 0
      UNION SELECT plan_id FROM invoices         WHERE client_id = ? AND ifnull(plan_id,0) > 0
      UNION SELECT plan_id FROM booking_requests WHERE client_id = ? AND ifnull(plan_id,0) > 0
    )`).all(clientId, clientId, clientId);
  return rows.map(r => r.plan_id);
}

// 逐案指派：櫃檯直接指定這位個案要簽哪幾張。有指派就以指派為準，自動規則不再套用。
function assignedKeys(clientId) {
  return db.prepare('SELECT key FROM client_consents WHERE client_id = ?').all(clientId).map(r => r.key);
}

// 這位個案該看到的同意書清單（已排序）。assigned 有值時只列指派的那幾張。
function consentsForClient(client) {
  const all = db.prepare('SELECT * FROM consent_templates ORDER BY sort, id').all();
  const assigned = assignedKeys(client.id);
  if (assigned.length) return all.filter(t => assigned.includes(t.key));
  const ctx = { group: ageGroupOf(client.birth_date), planIds: clientPlanIds(client.id) };
  return all.filter(t => (!t.minor_only || client.is_minor) && consentFits(t, ctx));
}

// t：同意書範本；ctx：{ group 年齡分群, planIds 個案的方案 id 陣列 }
function consentFits(t, ctx = {}) {
  const group = typeof ctx === 'string' ? ctx : ctx.group;   // 舊呼叫法（只傳年齡分群）仍可用
  const planIds = (typeof ctx === 'string' ? null : ctx.planIds) || null;
  const a = t.audience || '';
  if (a && group) {
    if (a === 'minor') { if (group !== 'child' && group !== 'teen') return false; }
    else if (a !== group) return false;
  }
  const need = parsePlanIds(t.plan_ids);
  // planIds 為 null 表示呼叫端沒帶方案資訊，此時不做方案篩選（維持舊行為）
  if (need.length && planIds && !need.some(id => planIds.includes(id))) return false;
  return true;
}

module.exports = { ageGroupOf, consentFits, clientPlanIds, parsePlanIds, assignedKeys, consentsForClient };
