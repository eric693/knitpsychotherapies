// 時區：SQLite 的 datetime('now','localtime') 與 JS Date 都吃行程的 TZ。
// 主機是 UTC，若啟動時忘了帶 TZ，所有時間會少 8 小時、凌晨還會跨錯日期，
// 因此在載入資料庫之前先補上預設值（已指定 TZ 時尊重原設定）。
process.env.TZ = process.env.TZ || 'Asia/Taipei';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 資料目錄可由環境變數覆寫，冒煙測試（scripts/smoke.js）藉此跑在拋棄式資料庫上，
// 不會動到正式資料；未設定時維持專案內的 data/。
const DATA_DIR = process.env.MINDCARE_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// 附件實體檔目錄（同樣可覆寫，冒煙測試才不會把測試檔案寫進正式的 uploads/）
const UPLOAD_DIR = process.env.MINDCARE_UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mindcare.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

// 系統預設值與內建同意書範本：改壞了要能一鍵還原，因此集中留一份。
// 這兩個容器由下方各區塊填入，並對外匯出給「還原預設」使用。
const ALL_SETTING_DEFAULTS = {};
const CONSENT_TEMPLATE_DEFAULTS = [];

// 既有資料庫的欄位遷移（日後加欄位補在此，新裝走 schema.sql）
function ensureColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, ddl] of Object.entries(cols)) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
ensureColumns('clients', {
  partner_id: 'INTEGER REFERENCES partners(id)',     // 合作單位（學校／EAP／社會局委託案）
  id_no: "TEXT NOT NULL DEFAULT ''"                  // 身分證統一編號／居留證號（通報與補助核銷用）
});
ensureColumns('users', {
  // 只接受線上通訊諮商的心理師：預約表單會標示，且不排到所內時段
  online_only: 'INTEGER NOT NULL DEFAULT 0',
  intro: "TEXT NOT NULL DEFAULT ''",                  // 預約表單上的簡介（專長取向）
  // 是否出現在公開預約表單的心理師清單（示範帳號、行政兼職者可關掉）
  portal_bookable: 'INTEGER NOT NULL DEFAULT 1',
  // 心理師的固定視訊會議室連結：排視訊晤談時自動帶入，不必每次貼
  meeting_room_url: "TEXT NOT NULL DEFAULT ''",
  // 行事曆訂閱（.ics）用的隨機字串：手機日曆以網址訂閱，故不走 Cookie 驗證。
  // 可隨時重設，舊網址即失效；輸出內容不含個案姓名。
  calendar_token: "TEXT NOT NULL DEFAULT ''",
  // 實習心理師：晤談紀錄需經指定督導覆核後才定稿（心理師法第 2 條實習制度）
  is_intern: 'INTEGER NOT NULL DEFAULT 0',
  supervisor_id: 'INTEGER REFERENCES users(id)'
});
// 在職／離職證明書會用到的人事欄位（性別、生日、到職與離職日）
ensureColumns('users', {
  gender: "TEXT NOT NULL DEFAULT ''",
  birth_date: "TEXT NOT NULL DEFAULT ''",
  hire_date: "TEXT NOT NULL DEFAULT ''",
  resign_date: "TEXT NOT NULL DEFAULT ''",
  work_place: "TEXT NOT NULL DEFAULT ''"                 // 服務地點（預設為機構地址）
});
// 勞務報酬單需載明的領款人資料（扣繳憑單、匯款用；非必填）
ensureColumns('users', {
  id_no: "TEXT NOT NULL DEFAULT ''",                 // 身分證字號／居留證號
  passport_no: "TEXT NOT NULL DEFAULT ''",           // 居留證／護照號碼（外籍者）
  residency: "TEXT NOT NULL DEFAULT 'local'",        // local 本國籍 / local_abroad 本國籍未在台居住 / foreign_183 外籍滿183天 / foreign_lt183 外籍未滿183天
  household_address: "TEXT NOT NULL DEFAULT ''",     // 戶籍地址
  mailing_address: "TEXT NOT NULL DEFAULT ''",       // 通訊地址（同戶籍者留空）
  bank_name: "TEXT NOT NULL DEFAULT ''",
  bank_account: "TEXT NOT NULL DEFAULT ''",
  bank_holder: "TEXT NOT NULL DEFAULT ''"
});
// 同意書列印時的簽署欄：留空用預設兩行（本人簽名、心理師簽名），
// 國軍方案這類需要填單位、級職、身分證字號的，就把整段簽署欄寫在這裡。
ensureColumns('consent_templates', {
  sign_block: "TEXT NOT NULL DEFAULT ''",
  // 列印時的聯別名稱（逗號分隔）：留空用預設的「個案留存聯、機構留存聯」；
  // 公部門方案的同意書常寫成「存根聯、收執聯」，逐份可改。
  copy_labels: "TEXT NOT NULL DEFAULT ''",
  // 適用對象：同意書愈來愈多，個案頁只列出跟這位個案有關的。
  // '' 全部適用 / child 兒童（未滿 12）/ teen 青少年（12-17）/ minor 未成年 / adult 成人
  audience: "TEXT NOT NULL DEFAULT ''",
  // 適用方案：逗號分隔的 service_plans.id，留空表示不限方案。
  // 國軍、青壯這類方案專屬的同意書只給實際走該方案的個案看到，個案專區不會一次列出全部。
  plan_ids: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('session_notes', {
  // 覆核狀態：none 不需覆核（正式心理師）／pending 待督導覆核／approved 已覆核／returned 退回補正
  review_status: "TEXT NOT NULL DEFAULT 'none'",
  reviewer_id: 'INTEGER REFERENCES users(id)',
  reviewed_at: "TEXT NOT NULL DEFAULT ''",
  review_comment: "TEXT NOT NULL DEFAULT ''",
  submitted_at: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('intakes', {
  id_no: "TEXT NOT NULL DEFAULT ''",
  // 候補遞補：最近一次通知釋出時段的時間與內容，避免重複打擾同一位
  waitlist_notified_at: "TEXT NOT NULL DEFAULT ''",
  waitlist_notified_slot: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('appointments', {
  reminded_at: "TEXT NOT NULL DEFAULT ''",           // 晤談提醒已通知時間
  meeting_url: "TEXT NOT NULL DEFAULT ''",           // 視訊晤談連結（mode=online 時使用）
  // 是否已因此次預約產生費用（開立收費單或扣方案次數）。
  // 狀態在「完成／未到」與其他狀態間來回切換時，用它避免重複計費與漏退次數。
  charged: 'INTEGER NOT NULL DEFAULT 0',
  // 改期軌跡：保留原時間並累計改期次數，櫃檯看得出這筆被移動過幾次
  rescheduled_from: "TEXT NOT NULL DEFAULT ''",
  reschedule_count: 'INTEGER NOT NULL DEFAULT 0',
  // 個案端逾期取消只能提出申請，由櫃檯決定是否計費；此欄記申請時間與事由
  cancel_requested_at: "TEXT NOT NULL DEFAULT ''",
  cancel_request_reason: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('invoices', {
  partner_id: 'INTEGER REFERENCES partners(id)',     // 由合作單位付款時填
  settlement_id: 'INTEGER REFERENCES settlements(id)',
  group_session_id: 'INTEGER REFERENCES group_sessions(id)',  // 團體場次收費：用於避免重複點名時重複開單
  // 電子發票（營利事業登記者適用；執行業務所得者僅開收據，留空即可）
  buyer_tax_id: "TEXT NOT NULL DEFAULT ''",          // 買受人統一編號（開立三聯式時填）
  buyer_title: "TEXT NOT NULL DEFAULT ''",           // 發票抬頭
  invoice_no: "TEXT NOT NULL DEFAULT ''",            // 發票號碼（如 AB-12345678）
  invoice_date: "TEXT NOT NULL DEFAULT ''",
  carrier: "TEXT NOT NULL DEFAULT ''",               // 載具號碼（手機條碼／自然人憑證）
  love_code: "TEXT NOT NULL DEFAULT ''",             // 捐贈碼
  // 政府補助方案（如衛福部年輕族群心理健康支持方案）：補助額與自付差額分開記
  subsidy_program: "TEXT NOT NULL DEFAULT ''",
  subsidy_no: "TEXT NOT NULL DEFAULT ''",            // 方案序號／個案代碼
  subsidy_amount: 'INTEGER NOT NULL DEFAULT 0',      // 由方案支付金額
  self_pay: 'INTEGER NOT NULL DEFAULT 0'             // 個案自付差額
});
ensureColumns('risk_events', {
  // 責任通報時限：建案時依類型帶入應完成通報時間，逾時未通報會在清單警示
  report_due_at: "TEXT NOT NULL DEFAULT ''"
});

// 個案附件：轉介單、診斷證明、同意書掃描、衡鑑報告等。
// 檔案存在 uploads/ 下並以隨機檔名保存，原始檔名另存資料庫，
// 下載一律經 API 檢查權限，不開放靜態目錄直接讀取。
db.exec(`CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '其他',           -- 轉介單／診斷證明／同意書掃描／衡鑑報告／其他
  filename TEXT NOT NULL,                      -- 原始檔名（顯示與下載用）
  stored_name TEXT NOT NULL,                   -- 實際落地檔名（隨機，避免路徑穿越與撞名）
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  visible_to_client INTEGER NOT NULL DEFAULT 0, -- 是否開放個案端下載
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_att_client ON attachments(client_id, created_at);`);

// 心理師報酬與扣繳（外聘心理師／督導多為執行業務所得）
db.exec(`CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                         -- YYYY-MM
  item TEXT NOT NULL DEFAULT '',               -- 晤談鐘點／督導費／團體帶領
  sessions INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0,            -- 給付總額
  income_type TEXT NOT NULL DEFAULT '9B',      -- 9A 執行業務所得 / 9B 稿費講演 / 50 薪資所得
  withholding INTEGER NOT NULL DEFAULT 0,      -- 代扣所得稅
  nhi_supplement INTEGER NOT NULL DEFAULT 0,   -- 二代健保補充保費
  net INTEGER NOT NULL DEFAULT 0,              -- 實付金額
  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待付 / paid 已付
  paid_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_payout_user ON payouts(user_id, month);

-- 對外提醒發送紀錄（簡訊／LINE 走 webhook；未設定時記為待人工發送）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'reminder',       -- reminder 晤談提醒 / custom
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'manual',      -- webhook / manual
  target TEXT NOT NULL DEFAULT '',             -- 手機號或 LINE ID
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- sent 已送出 / failed 失敗 / manual 人工發送
  error TEXT NOT NULL DEFAULT '',
  sent_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);`);
// 推播失敗要能重送：把訊息內容（Flex JSON）與重試次數留著，
// 否則失敗的提醒只會靜靜地留在清單裡，沒人會發現個案沒收到。
ensureColumns('notifications', {
  payload: "TEXT NOT NULL DEFAULT ''",            // 原始訊息（JSON），重送時直接用
  retry_count: 'INTEGER NOT NULL DEFAULT 0',
  last_retry_at: "TEXT NOT NULL DEFAULT ''",
  resolved: 'INTEGER NOT NULL DEFAULT 0'          // 人工確認已另行處理，不再列在待處理
});

// 報酬單拆單：同一筆報酬拆成數筆各低於扣繳門檻時，用 batch_* 記住它們原屬同一次結算
ensureColumns('payouts', {
  pay_date: "TEXT NOT NULL DEFAULT ''",              // 支領日期（列印勞務報酬單用）
  batch_id: "TEXT NOT NULL DEFAULT ''",              // 同批拆單共用的識別碼
  batch_seq: 'INTEGER NOT NULL DEFAULT 0',           // 該批中的第幾筆（1 起）
  batch_total: 'INTEGER NOT NULL DEFAULT 0'          // 該批共幾筆
});
db.exec('CREATE INDEX IF NOT EXISTS idx_payout_batch ON payouts(batch_id)');

// 心理衡鑑報告書（WAIS、MMPI、魏氏、投射測驗等）：屬晤談內容層級的高敏感資料，
// 讀寫比照晤談紀錄的保密邊界（僅主責心理師、督導、管理者），定稿後不可修改。
db.exec(`CREATE TABLE IF NOT EXISTS assessment_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  test_date TEXT NOT NULL,                     -- 施測日期
  report_date TEXT NOT NULL DEFAULT '',        -- 報告完成日
  purpose TEXT NOT NULL DEFAULT '',            -- 轉介問題／評估目的
  referral_source TEXT NOT NULL DEFAULT '',    -- 轉介單位／人
  instruments TEXT NOT NULL DEFAULT '',        -- 施測工具（每行一項）
  background TEXT NOT NULL DEFAULT '',         -- 背景資料與病史
  observation TEXT NOT NULL DEFAULT '',        -- 行為觀察與測驗態度
  results TEXT NOT NULL DEFAULT '',            -- 測驗結果敘述
  scores TEXT NOT NULL DEFAULT '[]',           -- 分數表 JSON：[{instrument,index,score,norm,interpretation}]
  impression TEXT NOT NULL DEFAULT '',         -- 綜合摘要與臨床印象
  recommendation TEXT NOT NULL DEFAULT '',     -- 建議
  validity TEXT NOT NULL DEFAULT 'valid',      -- valid 結果可信 / caution 解釋需保留 / invalid 不宜採用
  locked INTEGER NOT NULL DEFAULT 0,
  signed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_report_client ON assessment_reports(client_id, test_date);`);

// 個案端自填初談問卷：派案／建檔前先由個案在手機填寫，櫃檯建檔時一鍵帶入，
// 內容屬行政與主訴層級（非晤談紀錄），來電登記人員即可檢視。
db.exec(`CREATE TABLE IF NOT EXISTS intake_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_id INTEGER REFERENCES intakes(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,                  -- 免登入填寫連結用的隨機碼
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  marital TEXT NOT NULL DEFAULT '',
  emergency_name TEXT NOT NULL DEFAULT '',
  emergency_relationship TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  guardian_name TEXT NOT NULL DEFAULT '',
  guardian_relationship TEXT NOT NULL DEFAULT '',
  guardian_phone TEXT NOT NULL DEFAULT '',
  main_issue TEXT NOT NULL DEFAULT '',         -- 主訴
  history TEXT NOT NULL DEFAULT '',            -- 過往就醫／諮商史、用藥
  expectation TEXT NOT NULL DEFAULT '',        -- 期待
  preferred_time TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  bsrs_answers TEXT NOT NULL DEFAULT '',       -- BSRS-5 作答（JSON，選填）
  bsrs_total INTEGER NOT NULL DEFAULT -1,      -- -1 表示未填
  bsrs_alert INTEGER NOT NULL DEFAULT 0,       -- 附加題（自殺意念）命中
  status TEXT NOT NULL DEFAULT 'sent',         -- sent 已發送 / done 已填寫 / used 已建檔帶入
  expires_at TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_intakeform_status ON intake_forms(status, created_at);`);

// 前台可編輯文字（系統設定頁維護；清空即隱藏該區塊）
const UI_TEXT_DEFAULTS = {
  ui_staff_login_title: '織心心理治療所',
  ui_staff_login_sub: '心理治療所管理系統',
  // 登入頁的提示框：正式站一律留空，不在公開頁面寫出任何帳號密碼；
  // 要做展示時才在「系統設定 → 前台文字」填入內容
  ui_demo_staff: '',
  ui_portal_title: '織心個案專區',
  ui_portal_login_sub: '預約、量表填寫與費用查詢',
  ui_portal_login_hint: '首次登入密碼為手機末 6 碼；忘記密碼請來電治療所。',
  ui_demo_portal: '',
  ui_portal_note: '本專區僅提供預約與行政事項；晤談內容請於晤談時與心理師討論。',
  ui_crisis_note: '如遇立即危機請撥打 1925（安心專線）或 119；本系統非緊急通報管道。'
};
const UI_TEXT_KEYS = Object.keys(UI_TEXT_DEFAULTS);

{
  const SETTING_DEFAULTS = {
    ...UI_TEXT_DEFAULTS,
    center_name: '織心心理治療所',
    center_phone: '04-23937306',
    center_address: '411 臺中市太平區樹孝路39號',
    // 機構登記資料：收據／報表抬頭與核銷文件需載明
    center_license_no: '',              // 治療所開業執照字號
    center_director: '',                // 負責心理師
    center_tax_id: '',                  // 機構統一編號（營利事業登記者）
    center_email: 'knitpsychotherapy@gmail.com',
    session_minutes: '50',
    default_fee: '2000',
    intake_fee: '2500',
    cancel_hours: '24',                 // 免收費取消門檻（小時）
    no_show_fee_rate: '0.5',            // 未到收費比例（未填固定金額時採用）
    // 未到固定收費：本所同意書寫明「行政規費 200 元」，填了就以固定金額為準，
    // 留 0 才回頭用上面的比例計算
    no_show_fee_fixed: '0',
    case_code_prefix: 'K',
    receipt_prefix: 'KN',
    counseling_types: '初談,個別諮商,伴侶諮商,家族諮商,團體諮商,心理衡鑑',
    approach_options: 'CBT 認知行為,個人中心,心理動力,家族系統,DBT 辯證行為,ACT 接納承諾,敘事治療,遊戲治療,EMDR,其他',
    source_options: '自行求助,親友介紹,學校輔導室,醫療院所轉介,社會局／家防中心,企業EAP,法院裁定,其他',
    close_reasons: '目標達成,個案自行結束,轉介他處,失聯,搬遷,經濟因素,其他',
    risk_types: '自殺意念,自傷行為,傷人威脅,兒少保護,家庭暴力,性侵害,精神症狀惡化,其他',
    report_channels: '113保護專線,關懷e起來,自殺防治通報系統,警政單位,衛生局,醫療院所,學校,其他',
    pay_methods: '現金,轉帳,信用卡,行動支付,其他',
    payer_types: '自費,企業EAP,學校方案,社會局補助,心理健康支持方案,保險給付,其他',
    payer_type_default: '自費',
    // 責任通報時限：下列類型建案時自動帶出應完成通報時間，逾時未通報在危機清單警示
    mandatory_report_types: '兒少保護,家庭暴力,性侵害,自殺意念,自傷行為',
    report_deadline_hours: '24',
    // 政府補助方案：開立收費單時可選，補助額與自付差額分開記帳以利核銷
    subsidy_programs: '年輕族群心理健康支持方案,長者心理健康支持方案,女性心理健康支持方案',
    // 成年年齡（民法 112 年起為 18 歲）：依生日自動判定是否需法定代理人同意
    adult_age: '18',
    // 執行業務所得扣繳：稅率與起扣點、二代健保補充保費費率與起扣門檻
    withholding_rate: '0.1',
    withholding_min: '20010',           // 單次給付達此金額才扣繳所得稅
    nhi_supplement_rate: '0.0211',
    nhi_supplement_min: '20000',        // 單次給付達此金額才扣補充保費
    // 勞務報酬單：一次給付達門檻就得代扣，所方習慣把同一筆結算拆成數次給付。
    // 上限預設 19999（同時低於所得稅起扣點 20010 與補充保費門檻 20000），
    // 拆出的每筆間隔天數預設 0（同日多筆），可於設定調整。
    payout_split_max: '19999',
    payout_split_interval_days: '0',
    payout_slip_service: '心理治療（55 心理師）',   // 勞務報酬單的勞務內容欄
    payout_slip_handler: '',                        // 經手人（留空時印製表當下的操作者）
    payout_slip_title: '勞務報酬單',
    payout_slip_note: '本單依所得稅法及全民健康保險補充保險費規定辦理；單次給付未達起扣門檻者免予扣繳，'
      + '年度所得仍以扣繳憑單全年累計金額為準。',
    // ---- 證明書（在職、離職、治療證明）----
    // 標題與聲明文字都可改；開立時仍可逐張再改，這裡只是預設值。
    cert_prefix: 'KC',                  // 證明書流水編號前綴
    center_director_license: '',        // 負責心理師證書字號（如 心理字1923號）
    cert_employment_title: '在職證明書',
    cert_employment_statement: '上列各項確實。特此證明。',
    cert_resignation_title: '離職證明書',
    cert_resignation_statement: '以上各項確實，特此證明。',
    cert_treatment_title: '治療證明',
    cert_profile_title: '基本資料表',
    cert_profile_statement: '',
    // 公部門補助方案的表單：服務明細（附表 2）與轉介單
    cert_plan_detail_title: '心理諮商服務明細',
    cert_plan_detail_statement: '',
    cert_referral_title: '心理健康支持方案轉介單',
    cert_referral_statement: '',
    // 所內自用的轉介單（轉介到身心科／診所），一式三聯並附醫師回覆欄
    cert_referral_clinic_title: '轉介單',
    cert_profile_minor_title: '未成年個案基本資料表',
    cert_profile_minor_statement: '',
    cert_early_intervention_title: '早期療育補助療育紀錄',
    // 早療補助（如臺中市發展遲緩兒童交通及療育補助）送件時的提醒文字
    cert_early_intervention_statement: '本表為本所開立之療育紀錄，供家長辦理早期療育補助之用；'
      + '申請時請依主管機關規定併附收據正本與相關證明文件，並由療育單位及療育人員蓋章。',
    early_intervention_item: '心理治療',   // 療育項目（早療紀錄卡的填法）
    // 官方版早療補助表單（臺中市發展遲緩兒童交通及療育補助）：
    // 表一申請表、表二交通補助紀錄卡、表三療育補助紀錄卡的固定文字，格式若改版於此調整。
    cert_ei_official_title: '發展遲緩兒童交通及療育補助申請表',
    cert_disadv_official_title: '弱勢醫療記錄卡－療育訓練費補助',
    cert_disadv_official_statement: '',
    disadv_official_authority: '臺中市政府辦理低收入戶及弱勢兒童及少年醫療補助計畫',
    disadv_form_note: '一、療育次數：(1) 同一院所相同療育項目，每天最多 1 次；(2) 同一院所不同療育項目，每天最多 2 次；'
      + '(3) 不同院所相同療育項目，每天最多 2 次；(4) 不同院所不同療育項目，每天最多 2 次。\n'
      + '二、療育單位：以健保特約醫院或本府核可之早期療育單位為限。\n'
      + '三、療育日期：以診斷書開立日期後之療育才可受理。\n'
      + '四、執行療育人員：需為本局核可之療育人員，並請蓋職章（姓名、職務）。\n'
      + '五、療育項目：包括認知學習、物理治療、職能治療、語言治療、感覺統合治療、音樂治療、遊戲治療、'
      + '心理治療、藝術治療、戲劇治療、聽覺復健。\n'
      + '六、療育單據：(1) 須為正本，請務必黏貼於上方黏貼處；(2) 單位收據需有立案字號、地址、統編、電話、'
      + '機構章、療育日期、療育項目及其單價；(3) 如採預付方式，請於收據上註明療育日期，並請執行療育人員加蓋職章。\n'
      + '七、掛號費、健保給付項目之基本部分負擔不予補助。',
    ei_official_authority: '臺中市政府社會局',
    ei_transport_fee: '200',              // 每趟次交通費補助額
    ei_form2_cells: '12',                 // 表二每頁的療育蓋章格數
    ei_form2_note: '1. 補助次數：同一天交通費補助不超過 2 次；同一天同一療育單位僅補助一次交通費；'
      + '家中兄弟姊妹同天至同單位進行療育課程，交通費以一次計算。\n'
      + '2. 療育日期：醫檢證明開立後且完成通報，交通費補助始可受理。\n'
      + '3. 療育項目：包括物理治療、職能治療、語言治療、心理治療、針灸治療（限領有身障證明者）、'
      + '水中運動治療、聽覺復健、認知學習、音樂療育、遊戲療育、藝術療育、戲劇療育、定向訓練、馬術療育、體適能。\n'
      + '4. 療育單位：以健保特約醫院或本局核可之早期療育單位為限。',
    ei_form3_note: '※ 療育日期、項目、單位、人員請確實填寫核章；若有塗改請療育人員務必加蓋職章！'
      + '收據正本請浮貼於各單位欄位下方。',
    cert_referral_clinic_statement: '',
    referral_clinic_copies: '第一聯　本所存根聯,第二聯　醫療端留存聯,第三聯　醫療端回覆聯',
    referral_clinic_targets: '蕭芸嶙身心診所　電話 04-23939203　411 臺中市太平區樹孝路 501 號\n'
      + '晨心身心診所　電話 04-22780799　411 臺中市太平區中興路 158 號 1 樓',
    referral_reply_options: '建議藥物治療,暫不需藥物、持續追蹤,建議持續心理治療',
    center_org_code: 'XY03190057',      // 衛福部方案的合作機構代碼
    // 轉介單「建議轉介機構」預設值（每行一家；列印時整段可改）
    referral_targets_default: '蕭芸嶙身心診所　電話 04-23939203　411 臺中市太平區樹孝路 501 號\n'
      + '國軍臺中總醫院精神科　電話 04-23934191　411 臺中市太平區中山路二段 348 號',
    // 轉介單的轉介原因清單（每行一組「類別：選項、選項…」，列印成可勾選的段落）
    referral_reasons: '（1）情感／人際關係：家庭成員問題、職場人際關係、夫妻問題、喪親喪偶、感情因素、長期照顧壓力\n'
      + '（2）精神健康／物質濫用：憂鬱傾向或罹患憂鬱症、罹患其他精神疾病、酒精濫用、藥物濫用\n'
      + '（3）工作／經濟：職場工作壓力、職場霸凌、失業、債務\n'
      + '（4）生理疾病：慢性化的疾病問題（如久病不癒）、急性化的疾病問題（如初得知患病）\n'
      + '（5）校園問題：學校適應問題、課業壓力、校園霸凌、同儕相處問題、生涯規劃\n'
      + '（6）其他：＿＿＿＿＿＿＿＿＿＿',
    cert_treatment_statement: '此份文件提供 {purpose} 做為接受本所心理治療證明之用，不改做其他用途，'
      + '案主需自負保管及保密責任。',
    // 對外提醒發送。通道：auto 已綁 LINE 的走官方帳號、其餘走 webhook（預設）／
    // line 只用官方帳號／webhook 只用 webhook／manual 一律人工。
    notify_channel: 'auto',
    // webhook 是所方自家簡訊商或自建 bot 的接收網址；留空則沒綁 LINE 的人只能人工發送
    notify_webhook_url: '',
    notify_webhook_token: '',
    supervision_required_hours: '20',   // 年度督導時數目標
    audit_retention_days: '1825',       // 心理紀錄相關稽核軌跡保留 5 年
    note_lock_days: '7',                // 晤談紀錄應於幾日內完成簽核
    portal_booking_enabled: '1',        // 個案端可否自行送出預約申請
    portal_book_lead_days: '1',         // 個案端最早可約幾天後
    portal_book_max_days: '60',
    // 紀錄保存：心理師法施行細則規定紀錄應保存，所內政策以此年限提示可歸檔／銷毀
    record_retention_years: '7',
    // 繼續教育：執業執照每 6 年更新一次，期間應完成之積分與特定類別下限
    ce_cycle_years: '6',
    ce_required_credits: '120',
    ce_required_special: '12',          // 專業品質＋專業倫理＋專業相關法規合計下限
    ce_required_ethics: '2',            // 其中「專業倫理」類別之個別下限
    ce_categories: '專業課程,專業品質,專業倫理,專業相關法規,療育補助人員時數',
    license_alert_days: '180',          // 執照更新提前提醒天數
    // 晤談提醒訊息範本（可貼到 LINE／簡訊；{} 內為代入欄位）
    reminder_template: '{client} 您好，提醒您與 {counselor} 心理師的晤談時間為 {date}（{weekday}）{time}，地點 {center}。如需改期請提前 {cancel_hours} 小時來電 {phone}。',
    // 收費逾期：未收款超過此天數列入催繳清單；催繳訊息比照晤談提醒，可貼可自動發送
    overdue_days: '14',
    dunning_template: '{client} 您好，您於 {date} 的「{item}」費用 {amount} 元尚未繳納（已逾期 {days} 天），'
      + '請於下次晤談時或來電 {phone} 完成繳費。如已繳納請忽略本訊息。—— {center}',
    // 排班表：格子的起訖時間與每格分鐘數（所別作息不同，一律可調）
    shift_start: '08:00',
    shift_end: '21:00',
    shift_step: '30',
    // 排班快填按鈕：每行一組「名稱|星期(0=日,逗號分隔)|時段(逗號分隔)」
    shift_quick_fills: '平日 09-12、14-17|1,2,3,4,5|09:00-12:00,14:00-17:00\n平日 18-21|1,2,3,4,5|18:00-21:00\n週六上午|6|09:00-12:00',
    // 結案後追蹤：結案時自動建立的追蹤點（天數，逗號分隔；留空表示不自動建立）
    follow_up_days: '30,90',
    follow_up_channels: '電話,簡訊,LINE,面談,信件',
    // 以下四項原本寫死在前端，改成可自行增修的選項清單
    follow_up_kinds: '結案追蹤,轉介追蹤,高風險關懷,其他',
    refund_reasons: '方案未使用完畢終止,重複收費,所方因素取消晤談,個案結案,其他',
    license_types: '諮商心理師,臨床心理師,實習心理師,無',
    attachment_kinds: '轉介單,診斷證明,同意書掃描,心理衡鑑報告,身分證明,其他',
    referral_targets: '精神科／身心科門診,醫院急診,社福中心／家防中心,學校輔導室,其他諮商所／心理治療所,自殺防治中心,其他',
    // 安全計畫：預設檢視週期，以及印在計畫上的危機資源（可依縣市調整）
    safety_plan_review_days: '90',
    safety_plan_resources: '安心專線 1925（24 小時免費）\n生命線 1995\n張老師 1980\n緊急救護 119／報案 110',
    // 實習心理師紀錄覆核：逾此天數未覆核於待覆核清單以紅字標示
    note_review_days: '7',
    // 候補遞補：時段釋出時通知候補名單的訊息範本
    waitlist_template: '{name} 您好，{center} 有時段釋出：{date}（{weekday}）{time}，{counselor}心理師。'
      + '如需預約請於今日內來電 {phone}，逾時將通知下一位候補。',
    waitlist_match_days: '14',          // 只媒合登記後幾天內仍在候補的來電
    // 個案端是否可自行改期；逾取消期限者一律只能提出申請由櫃檯處理
    portal_reschedule_enabled: '1',
    // 個案端自填初談問卷連結的有效天數
    intake_form_days: '14',
    partner_types: '學校,企業EAP,政府社政,司法轉介,醫療院所,其他',
    time_off_reasons: '特休,病假,事假,研習,督導,公假,其他',
    group_topics: '情緒調適,人際關係,壓力管理,親職教養,悲傷輔導,正念練習'
  };
  Object.assign(ALL_SETTING_DEFAULTS, SETTING_DEFAULTS);
  const has = db.prepare('SELECT 1 FROM settings WHERE key = ?');
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) if (!has.get(k)) ins.run(k, v);
}

// 同意書範本（後台可改內容並遞增版本；已簽署者保存全文快照，不受改版影響）
// 注意：以下為參考範本，正式使用前請由諮商所依《心理師法》與所內規範確認。
{
  const CONSENT_DEFAULTS = CONSENT_TEMPLATE_DEFAULTS;
  CONSENT_DEFAULTS.push(
    {
      key: 'guardian', title: '未成年人接受心理諮商法定代理人同意書', sort: 2, required: 1, allow_decline: 0, minor_only: 1,
      body: `本人為受服務者之法定代理人，同意其接受本所之心理諮商服務，並瞭解下列事項：

一、為建立信任關係，心理師與未成年人之晤談內容原則上予以保密；惟涉及安全風險、依法應通報事項，或經評估有告知必要者，心理師將以適當方式告知法定代理人。
二、法定代理人得與心理師約定親職諮詢時段，瞭解整體處遇方向與可配合之家庭作法。
三、本人同意配合必要之聯繫，並於接獲心理師安全通知時，採取保護未成年人之必要措施。

本人已充分閱讀並理解上述內容，同意上開未成年人接受本所心理諮商服務。`
    },
    {
      key: 'privacy', title: '個人資料蒐集、處理及利用告知同意書', sort: 3, required: 1, allow_decline: 0, minor_only: 0,
      body: `依個人資料保護法第 8 條規定，向您告知下列事項：

一、蒐集機構：本心理諮商所。
二、蒐集目的：辦理心理諮商與心理衡鑑服務、預約與費用管理、依法令應為之通報與紀錄保存、健康與安全之緊急聯繫。
三、個人資料類別：姓名、出生年月日、聯絡方式、地址、緊急聯絡人、心理及健康狀況、晤談與衡鑑紀錄等為提供服務所必要之資料。
四、利用期間、地區、對象及方式：於服務關係存續期間及法令規定之保存期限內，於中華民國境內，由本所及依法令應提供之機關，以電子或紙本方式於蒐集目的必要範圍內利用。
五、當事人權利：您得請求查詢、閱覽、製給複製本、補充或更正、停止蒐集處理利用或刪除您的個人資料。
六、不提供之影響：若不提供必要資料，本所將無法完成報到與服務安排。`
    },
    {
      key: 'counseling', title: '諮商／治療同意書', sort: 6, required: 1, allow_decline: 0, minor_only: 0,
      body: `本人已成年，同意接受本所提供的服務與以下說明：

一、我在諮商／治療中說過的事，會得到專業保密，並由本所針對相關資料進行管理，不對外公開。但我了解以下情形不受此限制：
　（一）談話內容涉及自傷、傷人、家暴或兒虐、性侵事件時，本所會通知我的家人或相關機構，以保護我及他人安全。
　（二）當司法單位循法律程序向本所索取必要相關資訊時。
　（三）為維護我的權益，治療督導者有明瞭諮商過程之權利與責任。

二、心理師雖由治療所聘請，但所方允許心理師有管理個案權力，故若心理師允許，我可以與心理師留聯繫方式，或藉由治療所方與心理師聯繫行政事宜。

三、心理諮商／治療時，若須錄音／影，心理師會於錄音／影前事先取得我的同意，我可以不同意心理師錄音／影，我也不會錄音／影。

四、若因心理師個人督導、記錄整理之需要，要進行諮商過程之錄音，均須經過您的同意方能進行。若您同意，請打勾：□ 我同意接受心理師錄音。

五、心理諮商／治療是持續且共同努力的過程，與心理師討論後可隨時終止心理諮商。

六、心理諮商／治療屬自費服務，在接受諮商／治療後，需依本所之收費方式支付費用。收費標準：個別心理諮商／治療 ＿＿＿＿＿ 元／50 分鐘；雙人（伴侶／親子）諮商／治療 ＿＿＿＿＿ 元／90 分鐘。

七、若因故無法前來，請最晚在前一天與本所聯繫，取消預約。

八、在伴侶諮商／治療中秉持誠信原則及良好療效，心理師不會向其中一方隱瞞另一方透露的重要資訊。如果有任何一方希望分享重要的資訊，建議在雙方都在場時進行，以便一同討論、處理。

※ 本人已經詳細閱讀前述文字並了解其內容，有疑問時可洽詢本所。`
    },
    {
      key: 'teletherapy', title: '通訊諮商／治療同意書', sort: 7, required: 0, allow_decline: 0, minor_only: 0,
      body: `（一）本人已年滿 18 歲，同意接受本所（以下簡稱機構）提供通訊心理諮商服務，並同意配合安裝由機構指定之通訊系統。

（二）進行通訊心理諮商前，本人應於視訊鏡頭前出示含照片之身分證件，供心理師核對身分。心理師亦應出示有效執業執照，供本人核對心理師身分。

（三）心理師應於機構諮商室內提供通訊心理諮商服務，以維護本人諮商內容保密性。

（四）本人應於隱密、不受打擾之空間內接受通訊心理諮商服務，不得私下對諮商內容截圖、錄音、錄影、使他人從旁觀看或進行網路直播等其他活動，以保障雙方隱私。如有相關情形不服勸阻，機構依法處理。

（五）本人同意配合通訊心理諮商相關之系統穩定守則，妥善使用自身之通訊設備。過程中若發現影音設備規格不足或通訊狀態不佳而對諮商造成明顯干擾時，雙方均有權即時提出停止通訊心理諮商程序之要求，並協議因應方式。

（六）本人同意遵守通訊心理諮商之視訊安全與倫理規範，不傳輸涉及國家安全之資料，亦不傳輸任何不符合當地法規、國家法律及國際法律的影音或圖文資訊。

（七）我在心理治療／諮商中說過的事，會得到專業保密，並由本所針對相關資料進行管理，不對外公開。但我了解以下情形不受此限制：
　（1）談話內容涉及自傷、傷人、家暴、兒虐、性侵及其他涉及《精神衛生法》、《家庭暴力防治法》、《兒童及少年福利與權益保障法》、《性侵害犯罪防治法》之通報義務範圍時，本所及心理師會通知我的家人或相關機構（如警政、衛福、社政單位），以保護我及他人安全。
　　我的地址：＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿
　　接受通訊諮商時的地址：＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿
　　緊急聯絡人：＿＿＿＿＿＿（關係：＿＿＿＿）電話：＿＿＿＿＿＿＿＿
　（2）當司法單位循法律程序向本所索取必要相關資訊時。
　（3）為維護我的權益，治療督導者與個案管理者有明瞭諮商過程之權利與責任。
　（4）若伴侶、家族或其他團體心理諮商中，任一成員符合前述情形，諮商內容亦不受保密限制。

（八）本人同意遵守「諮商／治療同意書」上關於諮商費用、出席規則、諮商關係、諮商結束、保密倫理、錄音（影）同意及資料保管、保護生命等相關內容。

（九）本人已熟悉基本網路特性與通訊軟體操作能力。

（十）本人同意由機構執業心理師依專業判斷是否合適，並簽署同意書後，接受通訊心理諮商。

※ 本人已經詳細閱讀前述文字並了解其內容，有疑問時可洽詢本所。`
    },
    {
      key: 'military', audience: 'adult', title: '國軍心理健康照護方案權益須知同意書', sort: 8, required: 0, allow_decline: 0, minor_only: 0,
      sign_block: `立書同意人：
　單位：＿＿＿＿＿＿＿＿　級職：＿＿＿＿＿＿＿＿　姓名：＿＿＿＿＿＿＿＿
　身分證字號：＿＿＿＿＿＿＿＿＿＿＿＿

心理輔導人員：＿＿＿＿＿＿＿＿＿＿

中華民國　＿＿＿　年　＿＿　月　＿＿　日

（本同意書一式兩份，一份個案留存，一份留於合作機構）`,
      body: `一、我的身分符合「國軍心理健康照護方案」補助對象，每次晤談前會主動出示相關身分證明文件，確保我接受服務的資格。

二、我在輔導過程所說的內容，會依相關法規得到專業的保密，但我瞭解我所談的內容在遇到下列情形時，輔導人員會與我討論並且通報相關單位及國防部心理衛生中心（0932-493985），以連結其他系統一起協助我：
　（一）危及自己或他人生命、自由、財產及安全的情況，例如：想自殺或傷害他人。
　（二）涉及相關法律責任，例如：兒童及少年相關法規、性侵害犯罪防治法、家庭暴力防治法……等。

三、為了避免合作方式不同而互相影響，若我有在其他地方同時接受諮商輔導服務，我會主動向服務機構的輔導人員說明。

四、我瞭解同一年度使用本方案以 6 次為限，增加次數由自己付費。

五、若我希望停止諮商輔導服務，我可以隨時提出，但為了保障我的權益，我會主動告知提供服務的機構。

六、我瞭解已預約輔導時間，若須請假，我會事先了解並配合機構的請假規範；如未提前告知請假而無故未到，則該次因無法諮商而產生的行政費用由我自行繳納，若連續 2 次無故未到，合作機構得拒絕提供服務。

七、若我有選擇使用通訊諮商的服務，我會配合簽立並遵守機構提供之「通訊諮商知後同意書」。

八、我已認真閱讀、瞭解以上我所應盡的權利，並同意上述內容及機構安排諮商輔導服務。`
    },
    {
      key: 'youth', audience: 'adult', title: '15-45 歲青壯世代心理健康支持方案同意書', sort: 9, required: 0, allow_decline: 0, minor_only: 0,
      copy_labels: '存根聯,收執聯',
      sign_block: `立　書　人：＿＿＿＿＿＿＿＿＿＿
立書人地址：＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿
立書人身分證字號：＿＿＿＿＿＿＿＿＿＿
立書人電話：＿＿＿＿＿＿＿＿＿＿

合作機構：{center}
合作機構說明人員：＿＿＿＿＿＿＿＿＿＿

中華民國　＿＿＿　年　＿＿　月　＿＿　日

【請繼續填答下列資料】
居住地：＿＿＿＿＿＿＿＿＿＿　生日：民國＿＿＿年＿＿月＿＿日
婚姻狀況（請圈選）：未婚 ／ 已婚 ／ 離婚或分居 ／ 喪偶 ／ 不便回答
教育程度（請圈選）：國中（含）以下 ／ 高中職 ／ 專科 ／ 大學 ／ 研究所以上 ／ 不詳
職業（請圈選）：無業或失業中 ／ 民意代表、主管及經理人員 ／ 專業人員 ／ 技術員及助理專業人員 ／
　事務支援人員 ／ 服務及銷售工作人員 ／ 農、林、漁、牧業生產人員 ／ 技藝有關工作人員 ／
　機械設備操作及組裝人員 ／ 基層技術工及勞力工 ／ 軍人 ／ 學生 ／ 不便回答

※ 同意書之記載如有虛偽不實，填寫人恐觸犯刑法偽造文書或登載不實罪，將依法追究相關法律責任。`,
      body: `本人＿＿＿＿＿＿＿＿在經過合作機構說明後，已充分瞭解本方案內容、風險、益處、相關權益及規範，同意參與衛生福利部 15-45 歲青壯世代心理健康支持方案，並願意遵守下列規定：

一、同意僅使用本方案之補助服務至多 3 次，且如先前已有至其他合作機構接受本案補助之情事，應據實告知。如有虛偽不實，願負一切法律責任，並主動向合作機構繳回第 4 次起之溢領心理諮商補助費用，每次新臺幣壹仟陸佰元整。

二、對於已排定或已預約之心理諮商，如連續 2 次無故未依約接受心理諮商，合作機構得拒絕提供其服務。

三、若接受通訊心理諮商服務，應於接受通訊心理諮商前，於鏡頭出示有效身分證明文件及同意合作機構拍照保存該畫面，以利佐證受補助條件。

四、同意衛生福利部蒐集本人相關個人資料，但僅作為去識別分析、研究及評估本方案政策成效，及稽核本方案合作機構服務品質等公務目的使用。

五、{center}（合作機構）及主管衛生局針對上開本人各項資料，應妥為保管，以供日後相關單位查核服務執行狀況。

衛生福利部　關心您！`
    },
    {
      key: 'child_guardian', audience: 'minor', title: '個別心理治療家長（監護人、主要照顧者）同意書',
      sort: 10, required: 0, allow_decline: 0, minor_only: 1,
      copy_labels: '家長留存聯,{center}留存聯',
      sign_block: `※ 本人已經詳細閱讀前述文字並了解其內容，謹同意下列事項：
□ 同意本人子女＿＿＿＿＿＿＿＿＿＿接受{center}的心理治療服務。

家長（監護人、主要照顧者）簽名：＿＿＿＿＿＿＿＿＿＿　與孩子關係：＿＿＿＿＿＿
孩子／個案簽名：＿＿＿＿＿＿＿＿＿＿
諮商／臨床心理師簽名：＿＿＿＿＿＿＿＿＿＿（諮／臨 心字＿＿＿＿＿號）

中華民國　＿＿＿　年　＿＿　月　＿＿　日`,
      body: `親愛的家長您好！由於貴子女＿＿＿＿＿＿＿＿（身分證字號：＿＿＿＿＿＿＿＿＿＿）至本所接受心理治療，為了增進您對本服務的瞭解，以下做簡略介紹：

一、心理治療／諮商
　所謂「心理治療／諮商」是指孩子因注意力問題、人際與社交問題、情緒困擾、行為問題等影響適應功能表現，故由專業臨床工作者進行轉介。將以心理學方法為基礎，透過與孩子對話互動，引導孩子調整不適應的認知行為模式，如提升對個人狀態的覺察、學習適當的情緒表達與調控方式、增進壓力因應及問題解決知能，或建立合宜的人際互動技巧等，協助其自我調節、成長與適應。另外，亦透過與家長晤談，引導家長理解並貼近孩子的處境，進而調整教養及互動方式，以將療效延展到家中及其他情境。
　另外，心理師不等同於醫師，不會提供藥物治療，但若發現孩子需要更進一步醫療需求，也會協助您取得相關資源。

二、保密協定
　除了專業督導及團隊人員外，我們絕對不會在未經您的同意下揭露治療相關內容。但若有以下情形：（1）貴子女有立即且明顯危害自己或他人生命、自由、財產及安全之情況時；（2）貴子女治療之內容涉及相關法律時（例如受虐待或性侵害），為維護貴子女的最佳權益，我們有責任必須採取對孩子最佳的保護措施，將會主動通報相關單位尋求協助。

三、治療時間、出席及請假規定
　在您簽署同意書後，將開始進行心理治療，心理師會安排孩子進行心理治療的時間，每次治療時間為 50 分鐘。請務必準時，遲到恕不補課。若孩子生病或有事無法來上課，請務必至少在治療當天來電請假；為維護治療品質，無特殊狀況請勿連續請假。治療之結束應由心理師及家長共同討論決議。`
    },
    {
      key: 'recording_child', title: '諮商／治療錄音錄影同意書',
      sort: 11, required: 0, allow_decline: 1, minor_only: 0,
      copy_labels: '個案留存聯,{center}留存聯',
      sign_block: `※ 本人已經詳細閱讀前述文字並了解其內容，有疑問時可洽詢{center}。

本人／法定代理人：＿＿＿＿＿＿＿＿＿＿　（與孩子關係：＿＿＿＿＿＿）
臨床心理師簽名：＿＿＿＿＿＿＿＿＿＿（心字＿＿＿＿＿號）

中華民國　＿＿＿　年　＿＿　月　＿＿　日`,
      body: `本人＿＿＿＿＿＿＿＿（貴子女＿＿＿＿＿＿＿＿）同意接受{center}提供的服務與以下說明：

一、已簽署心理諮商／治療同意書，並了解相關保密、司法通報、請假及收費事項。

二、心理諮商／治療時，若須錄音錄影，心理師會於事前取得我的同意，我可以不同意心理師錄音錄影，我也不會錄音錄影。

三、因心理師個人督導、記錄整理之需要，我同意進行諮商／治療過程之錄音錄影。`
    },
    {
      key: 'ei_service', audience: 'child', title: '早期／弱勢療育服務同意書',
      sort: 12, required: 0, allow_decline: 0, minor_only: 1,
      copy_labels: '家長留存聯,{center}留存聯',
      sign_block: `＊ 本同意書我已詳細閱讀並了解，我願意讓兒童接受貴單位的療育服務並遵守相關規定；
　　本同意書一式兩份，一份由家長自行保存，一份由單位保存。

兒童姓名：＿＿＿＿＿＿＿＿＿＿
家長簽名：＿＿＿＿＿＿＿＿＿＿　　簽名日期：＿＿＿＿ 年 ＿＿ 月 ＿＿ 日`,
      body: `一、服務費用（收費標準不可任意異動，如有異動須先經主管機關核可）
　為使療育能融入兒童日常生活作息中，各項療育應包含與家長溝通諮詢時間；如一堂 60 分鐘，請留 10 至 15 分鐘與家長溝通諮詢，以確保療育成效。
　□＿＿＿＿療育，□個別療育 □團體療育：一堂＿＿＿分鐘；收費＿＿＿＿元
　□＿＿＿＿療育，□個別療育 □團體療育：一堂＿＿＿分鐘；收費＿＿＿＿元

二、服務方式：個別療育是透過一對一的療育方式；團體療育最多為一對三的療育方式，協助兒童減緩在發展上所遇到的問題，並協助家長瞭解兒童所遇到的發展困境。

三、保密：治療專業人員對於兒童的療育過程均會作相關紀錄，並依專業人員倫理規範及個人資料保護法進行保密原則。但以下三種特殊情形不在此限：
　（一）兒童有立即且明顯的危險，涉及兒童個人生命與他人安危時。
　（二）涉及法律責任時，如兒童及少年福利與權益保障法、性別平等教育法、性侵害犯罪防治法、家庭暴力防治法等，但不限於此。
　（三）市府針對申請早期療育費用補助或低收入戶及弱勢兒童少年醫療補助等業務權責依法查調資料。

四、取消療育服務：若因故無法前來進行療育服務，請於 ＿1＿ 天前以電話、通訊軟體或親至單位取消或重新預約。
　單位聯絡電話：{phone}　　通訊軟體 ID：＿＿＿＿＿＿＿＿

五、錄音（影）：治療專業人員為能更瞭解兒童進行療育服務的成效，可能會要求錄音（影）；但在進行錄音（影）前，一定會徵求家長的同意，家長有權利決定是否接受。

六、療育關係：療育關係是一種合作關係，家長有權利參與及知道治療專業人員為兒童所設定之目標及接受療育服務的成效，治療專業人員應定期與家長討論療育目標及達成狀況。

七、終止療育服務：家長有權利終止兒童的療育服務，但建議家長先和治療專業人員溝通過。

八、對於本單位所提供療育服務如有任何疑問，歡迎來電洽詢本單位服務人員：＿＿＿＿＿＿＿＿
　聯絡電話：{phone}；服務時間：週＿＿ 至 週＿＿　＿＿：＿＿ 至 ＿＿：＿＿。

九、另設籍本市 0 至 6 歲（疑似）發展遲緩兒童接受本單位療育服務，業經通報本市各區兒童發展社區資源中心，得申請早期療育費及交通費補助（一般戶最高每月 4,000 元；低收入戶最高每月 6,000 元）。

十、申訴管道：應於事件發生或知悉之日起 14 日內提出。本單位內部申訴專線：{phone}；若對本單位申訴處理仍不滿意，請洽社會局申訴專線：04-22289111 轉 37152、37153。

十一、為瞭解兒童實際接受療育服務之成效與過程，誠摯邀請家長於定期成效評估後填寫本市「早期療育服務家庭服務流程／成效問卷」，俾利協助改善本市早期療育服務。`
    }
  );
  // 既有安裝的內建範本補上適用對象（只補一次，之後所方怎麼改都不再覆蓋）
  if (getSetting('consent_audience_seeded', '') !== '1') {
    const upd = db.prepare("UPDATE consent_templates SET audience = ? WHERE key = ? AND audience = ''");
    for (const t of CONSENT_DEFAULTS) if (t.audience) upd.run(t.audience, t.key);
    setSetting('consent_audience_seeded', '1');
  }
  const hasT = db.prepare('SELECT 1 FROM consent_templates WHERE key = ?');
  const insT = db.prepare(`INSERT INTO consent_templates
      (key, title, body, version, required, allow_decline, minor_only, sort, sign_block, copy_labels, audience)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`);
  // {center} 代入機構名稱，改名時範本不必逐份改寫
  const center = getSetting('center_name', '本所');
  for (const t of CONSENT_DEFAULTS) {
    if (!hasT.get(t.key)) {
      insT.run(t.key, t.title,
        t.body.replace(/\{center\}/g, center).replace(/\{phone\}/g, getSetting('center_phone', '')),
        t.required, t.allow_decline,
        t.minor_only, t.sort, (t.sign_block || '').replace(/\{center\}/g, center),
        (t.copy_labels || '').replace(/\{center\}/g, center), t.audience || '');
    }
  }

}

// 系統簽章密鑰（首次啟動自動產生）
const secretFile = path.join(DATA_DIR, '.secret');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, require('crypto').randomBytes(48).toString('hex'), { mode: 0o600 });
}
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function listSetting(key, fallback = '') {
  return getSetting(key, fallback).split(',').map(s => s.trim()).filter(Boolean);
}

function audit(actorType, actorId, actorName, action, target = '', detail = '') {
  db.prepare('INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, target, detail) VALUES (?,?,?,?,?,?)')
    .run(actorType, actorId, actorName, action, target, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function nowStamp() { return `${today()} ${nowTime()}`; }

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ageYears(birthDate, onDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate), t = onDate ? new Date(onDate) : new Date();
  if (isNaN(b) || isNaN(t)) return null;
  let y = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) y -= 1;
  return Math.max(0, y);
}

// 產生個案編號：前綴 + 西元年 + 三碼流水（同年內遞增）
function nextClientCode() {
  const prefix = getSetting('case_code_prefix', 'C');
  const year = new Date().getFullYear();
  const like = `${prefix}${year}%`;
  // 流水號超過 999 就自然變成 4 位數，所以取號要看「年份之後的整段數字」，
  // 排序也要先比長度（字典序會把 C2026999 排在 C20261000 前面）
  const row = db.prepare(
    'SELECT code FROM clients WHERE code LIKE ? ORDER BY length(code) DESC, code DESC LIMIT 1'
  ).get(like);
  const seq = row ? Number(row.code.slice(`${prefix}${year}`.length)) + 1 : 1;
  return `${prefix}${year}${String(seq).padStart(3, '0')}`;
}

// 安全計畫（Safety Plan）：高風險個案的標準照護文件。
// 與危機事件分開——危機事件記錄「已經發生的事」，安全計畫是「事前約定好怎麼做」，
// 需隨狀況更新，因此保留歷次版本：新版本 version+1，舊版本轉為 archived 仍可查閱。
// 保密層級比照晤談紀錄（主責心理師／督導／管理者）。
db.exec(`CREATE TABLE IF NOT EXISTS safety_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',       -- active 現行版本 / archived 舊版本
  warning_signs TEXT NOT NULL DEFAULT '',      -- 1 警訊（想法、情緒、行為、身體感受）
  coping_strategies TEXT NOT NULL DEFAULT '',  -- 2 自己可以做的因應方式
  distractions TEXT NOT NULL DEFAULT '',       -- 3 可轉移注意力的人事地
  support_contacts TEXT NOT NULL DEFAULT '',   -- 4 可求助的親友（姓名與電話）
  professional_contacts TEXT NOT NULL DEFAULT '', -- 5 專業協助（心理師、醫療院所）
  crisis_resources TEXT NOT NULL DEFAULT '',   -- 6 危機資源（安心專線等）
  environment_safety TEXT NOT NULL DEFAULT '', -- 7 環境安全（降低致命工具可及性）
  reasons_living TEXT NOT NULL DEFAULT '',     -- 8 值得活下去的理由／保護因子
  note TEXT NOT NULL DEFAULT '',
  review_date TEXT NOT NULL DEFAULT '',        -- 預定重新檢視日
  agreed_with_client INTEGER NOT NULL DEFAULT 1, -- 是否與個案共同討論並取得同意
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_safety_client ON safety_plans(client_id, status);`);

// 轉介與結案後追蹤：
// 轉介出去（醫療、社政、其他諮商所）是諮商所天天在做卻最容易沒留痕的一段，
// 出事時「有沒有轉介、對方有沒有接到」是關鍵；結案後的關懷追蹤同理。
// 兩者都掛在個案下，保密層級比照晤談紀錄（僅主責心理師、督導、管理者）。
db.exec(`CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out',       -- out 轉出 / in 轉入（由他處轉介而來）
  target TEXT NOT NULL DEFAULT '',             -- 轉介對象（醫院、社福中心、其他諮商所）
  contact TEXT NOT NULL DEFAULT '',            -- 聯絡方式／窗口
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',         -- sent 已轉出 / accepted 對方已接案 / declined 未接案 / unknown 無回覆
  replied_at TEXT NOT NULL DEFAULT '',
  reply_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_referral_client ON referrals(client_id, date);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER REFERENCES users(id),
  due_date TEXT NOT NULL,                      -- 預定追蹤日
  kind TEXT NOT NULL DEFAULT '結案追蹤',        -- 結案追蹤／轉介追蹤／其他
  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待追蹤 / done 已完成 / skipped 不需追蹤
  channel TEXT NOT NULL DEFAULT '',            -- 電話／簡訊／LINE／面談
  result TEXT NOT NULL DEFAULT '',             -- 追蹤結果摘要
  done_at TEXT NOT NULL DEFAULT '',
  done_by INTEGER REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_followup_due ON follow_ups(status, due_date);`);

// 退費：已收款的收費單若需退還（個案終止方案、重複收費、所方因素取消），
// 不直接改動原收費單金額（收款是已發生的事實），而是另立退費單與原單勾稽，
// 原收費單狀態改為 refunded，報表與對帳皆以「收款 - 退費」計算。
db.exec(`CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',             -- 現金／轉帳／原卡退刷
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_refund_client ON refunds(client_id, date);`);

// ---------------------------------------------------------------------------
// 方案別（衛福部社會局補助方案／自費方案／合作單位方案）
//
// 一個「方案」= 一組收費與給付規則：誰付錢（自費／補助／單位）、一次多少錢、
// 心理師抽成怎麼算、有沒有資格限制（年齡、每年次數）、每位心理師一週能排幾人次。
// 方案下再分「主題」（如伴侶溝通、親職教養），主題可各自覆寫金額；
// 再往下是「心理師 × 方案（×主題）」的個別費率，覆寫方案預設。
// 取價與抽成的優先序：心理師費率 > 主題 > 方案預設（見 src/plans.js resolveFee）。
db.exec(`CREATE TABLE IF NOT EXISTS service_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'self',           -- self 自費 / subsidy 政府補助方案 / partner 合作單位
  appt_type TEXT NOT NULL DEFAULT 'individual',-- 對應預約類型（individual/couple/family/group/intake/assessment）
  fee_mode TEXT NOT NULL DEFAULT 'fixed',      -- fixed 固定金額 / choice 由預約時挑選（伴侶諮商常見）
  fee INTEGER NOT NULL DEFAULT 0,              -- 固定金額，或 choice 模式下的預設值
  fee_options TEXT NOT NULL DEFAULT '',        -- choice 模式可選金額（逗號分隔，如 2400,3000,3600）
  subsidy_amount INTEGER NOT NULL DEFAULT 0,   -- 由方案／補助款支付的金額，其餘為個案自付
  subsidy_program TEXT NOT NULL DEFAULT '',    -- 核銷用方案名稱（帶入收費單 subsidy_program）
  session_minutes INTEGER NOT NULL DEFAULT 0,  -- 0 表示沿用系統設定
  age_min INTEGER NOT NULL DEFAULT 0,          -- 資格年齡下限（0 為不限）
  age_max INTEGER NOT NULL DEFAULT 0,          -- 資格年齡上限（0 為不限）
  quota_per_year INTEGER NOT NULL DEFAULT 0,   -- 每位個案每年可用次數（0 為不限）
  counselor_week_limit INTEGER NOT NULL DEFAULT 0,  -- 每位心理師每週可排人次（0 為不限）
  counselor_month_limit INTEGER NOT NULL DEFAULT 0, -- 每位心理師每月可排人次（0 為不限）
  share_mode TEXT NOT NULL DEFAULT 'percent',  -- percent 抽成比例 / fixed 固定鐘點費
  share_percent REAL NOT NULL DEFAULT 0.6,     -- 心理師分得比例
  share_fixed INTEGER NOT NULL DEFAULT 0,      -- 心理師固定鐘點費
  portal_visible INTEGER NOT NULL DEFAULT 1,   -- 是否出現在線上預約表單
  require_review INTEGER NOT NULL DEFAULT 1,   -- 線上預約是否須櫃檯確認才成立
  note TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',              -- 顯示在預約表單的說明
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS plan_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES service_plans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,              -- 0 表示沿用方案金額
  fee_options TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_plan_topic ON plan_topics(plan_id, active);

-- 心理師 × 方案（可再指定主題）的個別費率與人次上限；未設定者沿用方案預設。
CREATE TABLE IF NOT EXISTS plan_counselors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES service_plans(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES plan_topics(id) ON DELETE CASCADE,
  fee INTEGER NOT NULL DEFAULT 0,              -- 0 沿用上層
  share_mode TEXT NOT NULL DEFAULT '',         -- 空字串沿用方案
  share_percent REAL NOT NULL DEFAULT 0,
  share_fixed INTEGER NOT NULL DEFAULT 0,
  week_limit INTEGER NOT NULL DEFAULT -1,      -- -1 沿用方案，0 不限，>0 個別上限
  month_limit INTEGER NOT NULL DEFAULT -1,
  bookable INTEGER NOT NULL DEFAULT 1,         -- 是否開放此方案的線上預約
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_plan_counselor ON plan_counselors(plan_id, counselor_id);

-- 個案在某方案的已用次數調整：如在他所已使用過的次數，或人工註記補正。
-- 實際已用次數 = 本系統該年度有效預約數 + used_offset。
CREATE TABLE IF NOT EXISTS plan_usage_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES service_plans(id) ON DELETE CASCADE,
  year TEXT NOT NULL,
  used_offset INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(client_id, plan_id, year)
);`);

// 收據：與收費單分離。收費單是「這筆帳」，收據是「開給個案的憑證」，
// 個案當下不要、事後要補，或原本開錯要重開，都不該動到帳。
// 因此收據自成流水號（前綴＋年月＋序號），可補開、可作廢重開，並保留開立與補印紀錄。
db.exec(`CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL UNIQUE,             -- 流水編號，如 GM2026080001
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                          -- 收據日期（通常為收款日）
  title TEXT NOT NULL DEFAULT '',              -- 抬頭（預設個案姓名，可填公司或家長）
  tax_id TEXT NOT NULL DEFAULT '',             -- 統一編號（報帳用）
  item TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  plan_name TEXT NOT NULL DEFAULT '',
  counselor_name TEXT NOT NULL DEFAULT '',
  service_date TEXT NOT NULL DEFAULT '',       -- 服務（晤談）日期
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'valid',        -- valid 有效 / void 已作廢
  void_reason TEXT NOT NULL DEFAULT '',
  reissue_of TEXT NOT NULL DEFAULT '',         -- 重開時記錄原收據號
  print_count INTEGER NOT NULL DEFAULT 0,      -- 補印次數
  last_printed_at TEXT NOT NULL DEFAULT '',
  issued_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_receipt_client ON receipts(client_id, date);
CREATE INDEX IF NOT EXISTS idx_receipt_no ON receipts(receipt_no);`);

// ---- 證明書（在職、離職、治療證明）----
// 版面與文字都存在 data（JSON）裡：標題、每一列的欄位名與內容、聲明段落、
// 機構抬頭與核章欄位皆可逐張改寫，套版只提供預設值，不限制所方怎麼寫。
db.exec(`CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_no TEXT NOT NULL UNIQUE,                -- 流水編號，如 KC2026090001
  kind TEXT NOT NULL DEFAULT 'employment',     -- employment 在職 / resignation 離職 / treatment 治療證明
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,     -- 在職／離職證明的當事人
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, -- 治療證明的個案
  subject_name TEXT NOT NULL DEFAULT '',       -- 當事人姓名（快照，帳號或個案改名不影響已開立的證明）
  issue_date TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',            -- 用途（治療證明的「提供＿＿使用」）
  data TEXT NOT NULL DEFAULT '{}',             -- 版面與文字（JSON）
  status TEXT NOT NULL DEFAULT 'valid',        -- valid 有效 / void 已作廢
  void_reason TEXT NOT NULL DEFAULT '',
  print_count INTEGER NOT NULL DEFAULT 0,
  last_printed_at TEXT NOT NULL DEFAULT '',
  issued_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cert_kind ON certificates(kind, issue_date);
CREATE INDEX IF NOT EXISTS idx_cert_subject ON certificates(user_id, client_id);`);

// 線上預約申請：個案從公開表單（或 LINE）送出的預約需求。
// 個案看不到諮商室配置，只選方案、主題、心理師與時段；諮商室由櫃檯／系統指派。
db.exec(`CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  is_new INTEGER NOT NULL DEFAULT 1,           -- 是否初次預約
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES service_plans(id) ON DELETE SET NULL,
  topic_id INTEGER REFERENCES plan_topics(id) ON DELETE SET NULL,
  counselor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL DEFAULT '',
  alt_note TEXT NOT NULL DEFAULT '',           -- 其他可配合時段
  mode TEXT NOT NULL DEFAULT 'onsite',
  fee_choice INTEGER NOT NULL DEFAULT 0,       -- 可選金額方案（如伴侶諮商）所選金額
  partner_name TEXT NOT NULL DEFAULT '',       -- 伴侶／家族諮商的同行者
  main_issue TEXT NOT NULL DEFAULT '',
  expectation TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',          -- web 表單 / line
  line_user_id TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,          -- 已閱讀並同意個資告知
  status TEXT NOT NULL DEFAULT 'new',          -- new 待處理 / confirmed 已成立 / rejected 未成立 / cancelled 已取消
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  reply_note TEXT NOT NULL DEFAULT '',
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_booking_status ON booking_requests(status, created_at);

-- 心理師在某方案的已用人次人工調整：他所已接的案、系統外排的場次，
-- 讓櫃檯把實際已用人次填成正確數字。實際已用 = 系統內有效預約 + used_offset。
CREATE TABLE IF NOT EXISTS plan_counselor_usage_adj (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES service_plans(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL,                   -- week（以週一為 key）/ month（YYYY-MM）
  period_key TEXT NOT NULL,
  used_offset INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (plan_id, counselor_id, period_type, period_key)
);

-- 家人代訂：個案在專區替家人（孩子、伴侶）預約時，能約的對象只有這張表列出來的人。
-- 每個家人都是自己的一筆個案（有自己的病歷、紀錄與收費），這裡只授權「誰能替誰排時間」，
-- 由櫃檯建立；沒有這筆授權就約不到別人的時段，個案也看不到對方的任何資料。
CREATE TABLE IF NOT EXISTS client_family (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,   -- 代訂的人（在專區登入的那位）
  member_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,   -- 被代訂的家人
  relationship TEXT NOT NULL DEFAULT '',       -- 關係（子女／配偶／…），只作顯示用
  can_book INTEGER NOT NULL DEFAULT 1,         -- 是否仍可代訂（要停用又想留紀錄時設 0）
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (client_id, member_id)
);

-- LINE 綁定驗證碼：個案在官方帳號輸入驗證碼即完成綁定，不必由櫃檯查 userId
CREATE TABLE IF NOT EXISTS line_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  line_user_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待綁定 / done 已綁定 / expired 已失效
  expires_at TEXT NOT NULL DEFAULT '',
  bound_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`);

ensureColumns('service_plans', {
  // 通訊（視訊）諮商這類方案預設就是線上，排約時直接帶入，不必每次改
  default_mode: "TEXT NOT NULL DEFAULT 'onsite'",
  // 場地費：補助方案裡由個案自付、且全額歸所方的部分（不列入心理師抽成基數）。
  // 例：總額 1800 = 方案給付 1600（心理師依此抽成）+ 場地費 200（所方收入）。
  venue_fee: 'INTEGER NOT NULL DEFAULT 0'
});
ensureColumns('booking_requests', {
  topic_other: "TEXT NOT NULL DEFAULT ''",           // 主題選「其他」時的自填內容
  // 以下比照所內原本的 Google 預約表單欄位，建檔時可直接帶進個案基本資料
  address: "TEXT NOT NULL DEFAULT ''",
  id_no: "TEXT NOT NULL DEFAULT ''",                 // 身分證字號（補助方案核銷與通報需要）
  emergency_name: "TEXT NOT NULL DEFAULT ''",
  emergency_phone: "TEXT NOT NULL DEFAULT ''",
  emergency_relationship: "TEXT NOT NULL DEFAULT ''",
  external_id: "TEXT NOT NULL DEFAULT ''",           // 來自 Google 表單時的回應識別碼（避免重複匯入）
  // 本所 Google 預約表單另有的欄位。表單問題會增刪，所以除了下列固定欄位，
  // 整份回應也原封不動存進 form_answers，櫃檯在申請頁看得到，一個字都不會漏。
  category: "TEXT NOT NULL DEFAULT ''",              // 預約類別（成人／兒童青少年）
  education: "TEXT NOT NULL DEFAULT ''",             // 教育程度／孩子教育程度
  guardian_name: "TEXT NOT NULL DEFAULT ''",         // 兒青案的家長姓名（表單只問電話時留空）
  guardian_phone: "TEXT NOT NULL DEFAULT ''",        // 兒青案填的家長電話
  form_answers: "TEXT NOT NULL DEFAULT ''"           // 完整表單回應（JSON：問題 → 作答）
});

ensureColumns('clients', {
  education: "TEXT NOT NULL DEFAULT ''",             // 教育程度（預約表單有問，建檔時一併帶入）
  // 指定案／派案：年報表的類別代碼要分這兩種（自費 指定 0／派案 1、機構 指定 30／派案 31）。
  // 線上預約時個案自己點名心理師的，建檔時記為指定；其餘為派案，之後仍可在個案資料改。
  assign_type: "TEXT NOT NULL DEFAULT ''",           // '' 未註記 / designated 指定 / assigned 派案
  // 兒少個案的就學資料：未成年個案基本資料表與早療補助表單都要填
  school: "TEXT NOT NULL DEFAULT ''",
  grade: "TEXT NOT NULL DEFAULT ''"
});

// LINE 一次性預約連結：個案在官方帳號輸入「預約」即取得專屬網址，
// 網址帶的是隨機 token 而非 userId（userId 不該出現在網址列與瀏覽紀錄裡），
// 表單開啟時再以 token 換回 userId，送出後預約結果才推得回同一個人。
db.exec(`CREATE TABLE IF NOT EXISTS booking_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  line_user_id TEXT NOT NULL DEFAULT '',
  used_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`);
ensureColumns('appointments', {
  // fee 一律是「個案要付的錢」（補助方案就是場地費 200），
  // 由方案支付的部分記在 subsidy_amount，兩者相加才是這次晤談的總額。
  subsidy_amount: 'INTEGER NOT NULL DEFAULT 0',
  plan_id: 'INTEGER REFERENCES service_plans(id)',   // 方案別（收費與抽成依此計算）
  topic_id: 'INTEGER REFERENCES plan_topics(id)',    // 方案下的主題
  counselor_share: 'INTEGER NOT NULL DEFAULT 0',     // 此次晤談的心理師報酬（結算當下鎖定）
  booking_request_id: 'INTEGER REFERENCES booking_requests(id)'
});
ensureColumns('clients', {
  line_user_id: "TEXT NOT NULL DEFAULT ''"           // LINE 官方帳號綁定（提醒推播用）
});

// 指定案與所內派案的抽成常常不一樣：個案自己點名心理師（指定案），案源算心理師的，
// 通常抽成較高；所方派給他的（派案），案源是所方，抽成較低。
// 這裡不另開一張規則表，而是在既有的兩個層級各加一組「派案時的數字」：
//   share_mode_assigned 空字串 / share_percent_assigned 與 share_fixed_assigned 為 0
//   ＝沒有另訂，派案沿用指定案那組。既有資料因此不受影響。
ensureColumns('service_plans', {
  share_mode_assigned: "TEXT NOT NULL DEFAULT ''",
  share_percent_assigned: 'REAL NOT NULL DEFAULT 0',
  share_fixed_assigned: 'INTEGER NOT NULL DEFAULT 0'
});
ensureColumns('plan_counselors', {
  share_mode_assigned: "TEXT NOT NULL DEFAULT ''",
  share_percent_assigned: 'REAL NOT NULL DEFAULT 0',
  share_fixed_assigned: 'INTEGER NOT NULL DEFAULT 0'
});
ensureColumns('users', {
  line_user_id: "TEXT NOT NULL DEFAULT ''"           // 心理師的 LINE 綁定（行程提醒推播）
});
// 排班改為「固定班 + 逐週覆寫」：空字串是每週都套用的固定班，
// 填週一日期（YYYY-MM-DD）則只屬於那一週；某週有自己的設定就整週以它為準。
ensureColumns('availability', {
  week_start: "TEXT NOT NULL DEFAULT ''"
});
// 晤談提醒可請個案在 LINE 上按「會準時前往」，回覆時間記在這裡，
// 櫃檯就看得出哪些人已確認、哪些人還沒回應（未回應不代表不來，只是要多留意）。
ensureColumns('appointments', {
  confirmed_at: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('invoices', {
  plan_id: 'INTEGER REFERENCES service_plans(id)',
  topic_id: 'INTEGER REFERENCES plan_topics(id)',
  // 作廢前的狀態：手滑作廢時要能撤銷回原本的未收／已收
  void_prev_status: "TEXT NOT NULL DEFAULT ''"
});

// 年報表（督考用）欄位：
// report_code 是所方在年報表「類別」欄填的代碼（如 0 指定案／1 派案／3 機構案／30 機構指定／31 機構派案），
// code_prefix 則是個案編碼中接在初評日期後的標記（如「青壯」「國軍」；自費案留空）。
ensureColumns('service_plans', {
  report_code: "TEXT NOT NULL DEFAULT ''",
  code_prefix: "TEXT NOT NULL DEFAULT ''",
  // 方案的外部作業網址：如國軍方案要到國防部系統做個案註冊與每次晤談簽到，
  // 填了之後排程與個案總覽會直接給連結，櫃檯不必自己找網址。
  register_url: "TEXT NOT NULL DEFAULT ''",
  signin_url: "TEXT NOT NULL DEFAULT ''"
});
// 清單頁常用的排序與篩選欄位：資料累積後沒有索引會整表掃描。
// 這些是實際會被 WHERE／ORDER BY 用到的組合（排程看某人某天、收費看狀態與日期…）。
db.exec(`
CREATE INDEX IF NOT EXISTS idx_appt_counselor_date ON appointments(counselor_id, date);
CREATE INDEX IF NOT EXISTS idx_appt_status_date ON appointments(status, date);
CREATE INDEX IF NOT EXISTS idx_inv_status_date ON invoices(status, date);
CREATE INDEX IF NOT EXISTS idx_inv_appt ON invoices(appointment_id);
CREATE INDEX IF NOT EXISTS idx_note_appt ON session_notes(appointment_id);
CREATE INDEX IF NOT EXISTS idx_receipt_invoice ON receipts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_booking_created ON booking_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_assess_scale ON assessments(scale, date);`);

// 憑證號碼不得重號：兩張單同時開立時，「先查最大號再寫入」可能算出同一個號。
// 交給資料庫把關（同一個號寫第二次就失敗），程式收到衝突後重算重試。
// 空字串代表尚未開立憑證，會有很多筆，故以部分索引排除。
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_no_uniq ON receipts(receipt_no) WHERE receipt_no != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_receipt_no_uniq ON invoices(receipt_no) WHERE receipt_no != '';`);

// 憑證流水號：前綴 + 西元年月 + 四碼序號（同月遞增），如 KN2026090001。
// 收費單（收款時）與收據（開立時）共用同一條序列——兩邊各算各的話，
// 同一個月會各自從 0001 開始，等於兩份不同單據印出同一個號。
// 作廢的號碼不回收，才符合憑證連號的要求。
function nextReceiptNo() {
  const prefix = getSetting('receipt_prefix', 'MC');
  const ym = today().slice(0, 7).replace('-', '');
  const like = `${prefix}${ym}%`;
  const max = db.prepare(`SELECT MAX(no) AS no FROM (
      SELECT MAX(receipt_no) AS no FROM receipts WHERE receipt_no LIKE ?
      UNION ALL SELECT MAX(receipt_no) FROM invoices WHERE receipt_no LIKE ?)`).get(like, like);
  const seq = max && max.no ? Number(String(max.no).slice(-4)) + 1 : 1;
  return `${prefix}${ym}${String(seq).padStart(4, '0')}`;
}

// 重號時重算號碼再寫一次；連續失敗才回報，避免無限重試把請求卡住。
function withUniqueRetry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) {
      const dup = String(e.code || '') === 'SQLITE_CONSTRAINT_UNIQUE'
        || /UNIQUE constraint failed/.test(String(e.message || ''));
      if (!dup || i >= tries) throw e;
    }
  }
}

// 月報快照：每月 1 號把上個月的營運數字定版存起來。
// 好處有二：報表不必每次即時重算（資料多了會變慢），
// 以及「當時報的數字」有留底，事後補登或改動不會讓上個月的報表跟著變。
db.exec(`CREATE TABLE IF NOT EXISTS report_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL UNIQUE,                  -- YYYY-MM
  data TEXT NOT NULL DEFAULT '{}',             -- 當月彙總（JSON）
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`);

// 個案合併紀錄：同一個人用不同電話重複建檔時，把資料併到留下的那筆，
// 並記下「哪張表的哪幾列被搬過」，需要時可以整批還原。
db.exec(`CREATE TABLE IF NOT EXISTS client_merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kept_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  merged_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kept_code TEXT NOT NULL DEFAULT '',
  merged_code TEXT NOT NULL DEFAULT '',
  merged_name TEXT NOT NULL DEFAULT '',
  moved TEXT NOT NULL DEFAULT '{}',            -- 各資料表被搬動的列 id（JSON）
  undone_at TEXT NOT NULL DEFAULT '',
  operator_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_merge_kept ON client_merges(kept_id);`);
ensureColumns('clients', {
  merged_into: 'INTEGER REFERENCES clients(id)'   // 被併走的個案指向留下的那筆
});

// 逐案指派同意書：自動規則（年齡分群、方案）之外，櫃檯可以直接指定「這位個案要簽哪幾張」。
// 一旦有指派，個案專區就只列指派的那幾張，自動規則不再套用；清空指派即回到自動判斷。
db.exec(`CREATE TABLE IF NOT EXISTS client_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                             -- consent_templates.key
  assigned_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(client_id, key)
);
CREATE INDEX IF NOT EXISTS idx_client_consents ON client_consents(client_id);`);

// 三張內容已被其他同意書涵蓋的範本收掉（知情同意、緊急聯絡與危機處理、晤談錄音／錄影），
// 並把錄音錄影同意書改為成人也適用。只跑一次；已有簽署紀錄的範本保留不動，舊簽署才找得到出處。
if (getSetting('consent_merge_2026_seeded', '') !== '1') {
  const signed = db.prepare('SELECT COUNT(*) n FROM consents WHERE key = ?');
  const del = db.prepare('DELETE FROM consent_templates WHERE key = ?');
  const unassign = db.prepare('DELETE FROM client_consents WHERE key = ?');
  for (const key of ['informed', 'contact', 'recording']) {
    if (signed.get(key).n) continue;
    del.run(key);
    unassign.run(key);   // 逐案指派也一併移除，否則指派清單會留下不存在的範本
  }
  // 所方若已自行改過標題就不動它
  db.prepare("UPDATE consent_templates SET title = ?, audience = '' WHERE key = 'recording_child' AND title = ?")
    .run('諮商／治療錄音錄影同意書', '諮商／治療錄音錄影同意書（兒少）');
  setSetting('consent_merge_2026_seeded', '1');
}

// 機構核銷：每家合作單位的核銷頻率與該附哪些資料，
// 櫃檯每個月照「機構核銷」總表就知道這個月要跟誰請款、要準備什麼。
ensureColumns('partners', {
  billing_cycle: "TEXT NOT NULL DEFAULT ''",     // monthly 每月 / quarterly 每季 / per_case 逐案 / other 其他
  billing_months: "TEXT NOT NULL DEFAULT ''",    // 每季或不定期時的月份（如 1,4,7,10）
  billing_docs: "TEXT NOT NULL DEFAULT ''"       // 核銷需要的資料（每行一項）
});
ensureColumns('plan_topics', {
  report_code: "TEXT NOT NULL DEFAULT ''",
  code_prefix: "TEXT NOT NULL DEFAULT ''"
});

// 類別代碼一次性帶入：自費案 0、補助／合作單位案 30（皆為「指定案」的代碼，
// 派案由年報表自動 +1，成為 1 與 31）。只在第一次升級時填一次，之後所方怎麼改都不再覆蓋。
if (getSetting('report_code_seeded', '') !== '1') {
  db.prepare(`UPDATE service_plans SET report_code =
    CASE kind WHEN 'self' THEN '0' ELSE '30' END WHERE report_code = ''`).run();
  // 編碼標記沿用所方年報表的寫法（1140601_青壯1、1140601_國軍1）
  for (const mark of ['國軍', '青壯']) {
    db.prepare("UPDATE service_plans SET code_prefix = ? WHERE code_prefix = '' AND name LIKE ?")
      .run(mark, `%${mark}%`);
  }
  setSetting('report_code_seeded', '1');
}

// 方案專屬同意書（國軍、青壯）綁到對應的服務方案：沒走該方案的個案就不會看到這兩張。
// 靠方案的 code_prefix／名稱比對，因為方案 id 各站不同；找不到方案就略過，之後可在設定頁自行綁。
// 必須排在 service_plans 建表與 code_prefix 帶入之後。
if (getSetting('consent_plan_seeded', '') !== '1') {
  const findPlan = kw => db.prepare(
    "SELECT id FROM service_plans WHERE code_prefix = ? OR name LIKE ? ORDER BY id LIMIT 1").get(kw, '%' + kw + '%');
  const updPlanConsent = db.prepare("UPDATE consent_templates SET plan_ids = ? WHERE key = ? AND plan_ids = ''");
  let done = true;
  for (const [key, kw] of [['military', '國軍'], ['youth', '青壯']]) {
    const p = findPlan(kw);
    if (p) updPlanConsent.run(String(p.id), key);
    else done = false;
  }
  // 全新安裝時方案還沒建（由 seed 帶入），這次沒綁到就先不記旗標，下次啟動再試一次；
  // 綁好之後才記旗標，所方之後自行改回「不限方案」不會被覆蓋。
  if (done) setSetting('consent_plan_seeded', '1');
}

// 機構核銷方式：所方原本用一張表管的三家，第一次升級時帶進來（已存在的只補空欄位）
if (getSetting('partner_billing_seeded', '') !== '1') {
  const DEFAULTS = [
    { name: '家扶－心創服務', type: 'gov', cycle: 'quarterly', months: '1,4,7,10' },
    { name: '國軍方案', type: 'gov', cycle: 'monthly', months: '' },
    { name: '國軍醫院心理衡鑑', type: 'medical', cycle: 'monthly', months: '' }
  ];
  const find = db.prepare('SELECT id, billing_cycle FROM partners WHERE name = ?');
  const ins = db.prepare(`INSERT INTO partners (name, type, billing_cycle, billing_months)
    VALUES (?,?,?,?)`);
  const upd = db.prepare("UPDATE partners SET billing_cycle = ?, billing_months = ? WHERE id = ? AND billing_cycle = ''");
  for (const d of DEFAULTS) {
    const exist = find.get(d.name);
    if (exist) upd.run(d.cycle, d.months, exist.id);
    else ins.run(d.name, d.type, d.cycle, d.months);
  }
  setSetting('partner_billing_seeded', '1');
}

// 國軍心理健康照護方案的註冊與簽到網址（國防部系統）：只在沒填過時帶入一次
if (getSetting('military_urls_seeded', '') !== '1') {
  db.prepare(`UPDATE service_plans SET
      register_url = CASE WHEN register_url = '' THEN ? ELSE register_url END,
      signin_url = CASE WHEN signin_url = '' THEN ? ELSE signin_url END
    WHERE name LIKE '%國軍%'`)
    .run('https://gpwd-mhcp.mnd.gov.tw/registerpage?id=93&token=53c4ee67-a721-4071-9387-8efafb3941d6',
      'https://gpwd-mhcp.mnd.gov.tw/signpage?id=93&token=df59aef9-729c-4f3c-acba-1379a437d4cc');
  setSetting('military_urls_seeded', '1');
}

// 「線上預約申請」原本併在「預約排程」權限底下，拆成獨立模組後，
// 既有帳號只要有排程權限就一併補上，避免升級後頁面突然不見。
{
  const rows = db.prepare("SELECT id, permissions FROM users WHERE role <> 'admin'").all();
  const upd = db.prepare('UPDATE users SET permissions = ? WHERE id = ?');
  for (const u of rows) {
    let mods;
    try { mods = JSON.parse(u.permissions || '[]'); } catch { continue; }
    if (!Array.isArray(mods) || !mods.includes('schedule') || mods.includes('bookings')) continue;
    mods.splice(mods.indexOf('schedule') + 1, 0, 'bookings');
    upd.run(JSON.stringify(mods), u.id);
  }
}

{
  const EXT_SETTING_DEFAULTS = {
    // ---- LINE 官方帳號（Messaging API）----
    // 填入 Channel access token 後，預約成立、晤談提醒、心理師行程皆以 Flex Message 推播；
    // 未填則所有推播只產生文字與紀錄，不對外送出任何個資。
    line_channel_token: '',
    line_channel_secret: '',
    line_official_name: '',
    line_official_id: '',              // 官方帳號 ID（@ 開頭），用於加好友連結與對外說明
    line_add_friend_url: '',            // 加好友連結（印在預約完成頁）
    line_reminder_hours: '24',          // 晤談前幾小時推提醒
    line_counselor_daily_time: '20:00', // 每日推播心理師隔日行程的時間
    line_counselor_daily_enabled: '1',
    line_flex_color: '#0e7c7b',         // Flex 卡片主色
    // 卡片上的說明文字：所方會想改口氣、加自家規定，因此全部做成設定，
    // 留空即用系統預設。可用代入值：{center} 機構名稱、{phone} 電話、{hours} 取消期限時數、{name} 對方姓名。
    line_text_help_intro: '',
    line_text_help_note: '',
    line_text_bound: '',
    line_text_bound_note: '',
    line_text_request_intro: '',
    line_text_request_note: '',
    line_text_booked_note: '',
    line_text_remind_note: '',
    line_text_receipt_note: '',
    // ---- 線上預約表單 ----
    // 個案專區網址：留空時自動由線上預約表單網址推得（booking.html → portal.html），
    // 用於預約成立與晤談提醒的 LINE 卡片、以及預約完成頁的按鈕。
    // 線上預約表單的對外網址：LINE 卡片的預約按鈕、以及推算個案專區網址時都會用到
    booking_public_url: '',
    portal_public_url: '',
    booking_form_enabled: '1',
    // Google 表單同步：Apps Script 以此密鑰呼叫 /api/integrations/google-form，
    // 表單填完即寫入後台的「線上預約申請」。留空表示不開放同步。
    google_form_secret: '',
    google_form_url: '',
    booking_lead_days: '1',             // 最快可約幾天後
    // 前一天幾點之後就不再開放隔天的時段（HH:MM，留空表示不設這道關卡）。
    // 避免有人半夜預約隔天早上、櫃檯來不及看到，個案卻以為預約成立直接跑來。
    booking_cutoff_time: '21:00',
    // 另一道門檻：晤談開始前至少幾小時才收得到線上預約（0＝不設）。
    // 與上面的「前一天幾點截止」同時生效，兩者取較嚴格的那個。
    booking_cutoff_hours: '0',
    // 個案端「傳訊息給諮商所」：所內以 LINE 為主要對話管道，專區預設只讀，
    // 避免櫃檯要盯兩個地方而漏看。要開放個案在專區留言時把這裡改成 1。
    portal_messages_write: '0',
    booking_max_days: '45',             // 最遠可約幾天後
    booking_slot_step: '30',            // 表單上時段間隔（分鐘）
    booking_require_birth: '1',         // 是否必填生日（補助方案需驗年齡）
    booking_notice: '送出後為「預約申請」，櫃檯確認並回覆後才算完成預約。\n'
      + '如需取消或改期請提前來電；未於規定時間前告知者，本所得依公告收取部分費用。',
    booking_privacy: '本表單蒐集之個人資料僅用於預約安排、聯繫與依法應為之紀錄保存，'
      + '不作其他用途。您得隨時要求查詢、更正或刪除。',
    // ---- 諮商室指派 ----
    // 個案端與線上表單一律不顯示諮商室；成立預約時由系統挑一間當下沒被占用的空間。
    room_auto_assign: '1',
    room_hide_from_client: '1',
    // ---- 方案人次上限的預設值（各方案可自訂覆寫）----
    // 預設不限：只有真的有名額限制的補助方案（如青壯方案一週 6 人次）才在該方案自己設定，
    // 否則連自費的個別諮商都會被這個預設值擋住。
    plan_default_week_limit: '0',
    plan_default_month_limit: '0',
    plan_quota_enforce: '1',            // 1 超額直接擋下；0 只警示
    // ---- 收據 ----
    // 實習心理師督導覆核：所內目前沒有實習生，預設關閉整套覆核流程；
    // 日後收實習生時把這裡改成 1，紀錄覆核頁與相關欄位就會回來。
    intern_review_enabled: '0',
    // 所內暫不使用的模組（逗號分隔的頁面代碼）：導覽列不顯示、總覽也不出現相關區塊。
    // 需要時把代碼從這裡移除即可回復，資料與 API 都還在。
    hidden_modules: 'groups,hr,supervision,partners,overdue,risk,safety',
    receipt_footer: '本收據為心理諮商服務費用憑證，請妥善保存。',
    receipt_title_default: '心理諮商服務費收據',
    // 印花稅總繳戳記：與所內公文用印相同內容，印在收據右下角
    receipt_stamp_enabled: '1',
    receipt_stamp_note: '本執行費收據印花稅總繳',
    receipt_stamp_authority: '臺中市',
    receipt_stamp_payer: '',            // 負責總繳人姓名
    // 發票章（統一編號章）掃描圖：存 data URI，收據列印時蓋在用印欄旁邊。
    // 留空就只印文字，不會有破圖。
    receipt_seal_image: '',
    // 印花稅總繳章掃描圖：有上傳就用圖，沒有就印上面那組文字戳記
    receipt_stamp_image: ''
  };
  Object.assign(ALL_SETTING_DEFAULTS, EXT_SETTING_DEFAULTS);
  const has = db.prepare('SELECT 1 FROM settings WHERE key = ?');
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(EXT_SETTING_DEFAULTS)) if (!has.get(k)) ins.run(k, v);
}

// 方案別的實際內容（織心現行的 12 個方案、11 個諮商主題與心理師名單）
// 由 scripts/seed-knit.js 建立與更新，可重複執行；這裡不再灌任何示範方案，
// 免得正式站上出現兩套方案名稱。

module.exports = {
  withUniqueRetry, nextReceiptNo,
  db, SECRET, DATA_DIR, UPLOAD_DIR, getSetting, setSetting, listSetting, audit,
  ALL_SETTING_DEFAULTS, CONSENT_TEMPLATE_DEFAULTS,
  today, nowTime, nowStamp, addDays, ageYears, nextClientCode, UI_TEXT_KEYS
};
