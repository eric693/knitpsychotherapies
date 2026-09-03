// 把既有資料庫的機構資訊改成「織心心理治療所」。
// 設定預設值只在欄位不存在時寫入，既有資料庫仍留著舊值，故用這支一次覆蓋。
//   node scripts/rebrand.js
const { db, setSetting, getSetting } = require('../src/db');

const VALUES = {
  center_name: '織心心理治療所',
  center_phone: '04-23937306',
  center_address: '411 臺中市太平區樹孝路39號',
  center_email: 'knitpsychotherapy@gmail.com',
  ui_staff_login_title: '織心心理治療所',
  ui_staff_login_sub: '心理治療所管理系統',
  ui_portal_title: '織心個案專區',
  ui_portal_login_sub: '預約、量表填寫與費用查詢',
  receipt_prefix: 'KN',
  case_code_prefix: 'K',
  line_official_name: '織心心理治療所',
  // LINE 官方帳號加好友連結：待本所提供後填入，後台「整合設定」也可直接改
  line_add_friend_url: '',
  booking_public_url: 'https://knitpsychotherapies.crownai.ink/booking.html'
};

for (const [k, v] of Object.entries(VALUES)) {
  const old = getSetting(k, '');
  if (old !== v) {
    setSetting(k, v);
    console.log(`${k}: ${old || '(空)'} → ${v}`);
  }
}

// 治療室若資料庫還沒建過就先給兩間（個案端不會看到，僅供後台指派）
if (!db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) {
  db.prepare("INSERT INTO rooms (name, capacity, note) VALUES ('治療室 A', 4, '個別／伴侶皆可')").run();
  db.prepare("INSERT INTO rooms (name, capacity, note) VALUES ('遊戲治療室', 4, '兒童青少年')").run();
  console.log('已建立 2 間治療室');
}
console.log('完成。');
