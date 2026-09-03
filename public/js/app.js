// App 骨架：登入、側欄導覽、頁面路由、總覽
const App = {
  me: null,
  pages: {},
  meta: {},

  page(key, def) { App.pages[key] = def; },

  async boot() {
    try {
      App.me = await GET('/me');
      App.meta = await GET('/meta').catch(() => ({}));
      App.renderLayout();
      App.go(location.hash.slice(1) || 'dashboard');
    } catch {
      App.renderLogin();
    }
    window.addEventListener('hashchange', () => App.go(location.hash.slice(1) || 'dashboard'));
  },

  onUnauthorized() { if (App.me) { App.me = null; App.renderLogin(); } },

  can(module) { return App.me && (App.me.role === 'admin' || App.me.modules.includes(module)); },
  // 所內暫不使用的模組（系統設定 hidden_modules）：導覽與總覽區塊都不出現
  hidden(key) { return ((App.meta && App.meta.hidden_modules) || []).includes(key); },
  isCounselor() { return App.me && ['counselor', 'supervisor', 'admin'].includes(App.me.role); },
  // 心理師自己的 LINE 綁定：只加好友而沒綁定的話，官方帳號會把他當成一般民眾回覆預約說明，
  // 也收不到自己的隔日行程推播。這張卡片讓本人兩步完成綁定。
  myLineCard(d) {
    if (!d || !d.enabled) return '';
    const name = UI.esc(d.official_name || 'LINE 官方帳號');
    if (d.bound) {
      return `<div class="card"><h3>我的 LINE 通知 ${UI.tag('已綁定', 'ok')}</h3>
        <div style="font-size:14px;line-height:1.9">已與「${name}」連結${d.daily_enabled
        ? `，每天 ${UI.esc(d.daily_time)} 會收到隔日行程` : ''}。</div>
        <button class="btn tiny secondary" id="myline-unbind" style="margin-top:10px">解除綁定</button></div>`;
    }
    return `<div class="card"><h3>我的 LINE 通知 ${UI.tag('尚未綁定', 'warn')}</h3>
      <div style="font-size:14px;line-height:1.9">只加好友還不夠——官方帳號要知道這個 LINE 是你，
        才會把<strong>你的隔日行程</strong>推給你；沒綁定的話系統只會把你當一般民眾回覆預約說明。</div>
      <div style="margin-top:12px;font-size:14px;line-height:2">
        <strong>步驟 1</strong>　加「${name}」為好友
        ${d.add_friend_url ? `<br><a class="btn small" style="margin:6px 0"
          href="${UI.esc(d.add_friend_url)}" target="_blank" rel="noopener">加入好友</a>` : ''}
        <br><strong>步驟 2</strong>　在聊天室傳送這組綁定碼
        <div style="font-size:26px;font-weight:700;letter-spacing:4px;margin:6px 0">${UI.esc(d.code || '')}</div>
        ${d.message_url ? `<a class="btn small" style="margin-bottom:6px"
          href="${UI.esc(d.message_url)}" target="_blank" rel="noopener">開啟聊天室並帶入綁定碼</a>` : ''}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        綁定碼於 ${UI.esc(d.expires_at || '')} 前有效；傳送後會收到「綁定完成」卡片，重新整理本頁即顯示已綁定。</div></div>`;
  },

  listOptions(key, fallback = []) {
    const list = (App.meta && App.meta[key] && App.meta[key].length) ? App.meta[key] : fallback;
    return list.map(v => [v, v]);
  },
  counselorOptions(withAll) {
    const opts = (App.meta.counselors || []).map(c => [c.id, c.name]);
    return withAll ? [['', '全部心理師']].concat(opts) : opts;
  },
  roomOptions() { return [['', '未指定']].concat((App.meta.rooms || []).map(r => [r.id, r.name])); },
  enumOptions(kind) { return Object.entries(TW[kind]).map(([k, v]) => [k, v]); },

  async clientOptions(includeClosed) {
    // 只取 id／編號／姓名的輕量端點；載整包個案資料只為了填一個下拉太浪費
    const list = await GET('/clients/options' + (includeClosed ? '' : '?status=active'));
    return [['', '請選擇個案']].concat(list.map(c => [c.id, `${c.name}（${c.code}）`]));
  },

  noticeBox(text) {
    if (!text) return '';
    const lines = String(text).split('\n').map(UI.esc);
    const first = lines.shift();
    return `<div style="margin-top:14px;padding:12px;background:var(--primary-light);border-radius:8px;font-size:13px;line-height:1.8">
      <strong>${first}</strong>${lines.length ? '<br>' + lines.join('<br>') : ''}</div>`;
  },

  async renderLogin() {
    const t = await GET('/public/ui-texts').catch(() => ({}));
    document.getElementById('app').innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <h1>${UI.esc(t.ui_staff_login_title || '織心心理治療所')}</h1>
          <div class="sub">${UI.esc(t.ui_staff_login_sub || '諮商所管理系統')}</div>
          <div class="form-row"><label>帳號</label><input id="lg-user" autocomplete="username"></div>
          <div class="form-row"><label>密碼</label><input id="lg-pass" type="password" autocomplete="current-password"></div>
          <button class="btn" id="lg-btn">登入</button>
          <div class="login-err" id="lg-err"></div>
          ${App.noticeBox(t.ui_demo_staff)}
          <div style="margin-top:12px;font-size:13px;text-align:center"><a href="/portal.html">個案專區入口</a></div>
        </div>
      </div>`;
    const doLogin = async () => {
      const err = document.getElementById('lg-err');
      err.textContent = '';
      try {
        await POST('/login', {
          username: document.getElementById('lg-user').value.trim(),
          password: document.getElementById('lg-pass').value
        });
        location.reload();
      } catch (e) { err.textContent = e.message; }
    };
    document.getElementById('lg-btn').onclick = doLogin;
    document.getElementById('lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  },

  navGroups: [
    { label: '每日作業', keys: ['dashboard', 'my', 'calendar', 'schedule', 'room-board', 'bookings', 'waitlist', 'today', 'reminders', 'notes-pending', 'notes-review', 'messages'] },
    { label: '個案服務', keys: ['intake', 'intake-forms', 'clients', 'groups', 'assessments', 'risk', 'safety', 'follow-ups', 'consents'] },
    { label: '專業與營運', keys: ['supervision', 'hr', 'payouts', 'billing', 'receipts', 'certificates', 'overdue', 'packages', 'partners', 'plan-board', 'income', 'annual', 'announcements', 'reports'] },
    { label: '系統', keys: ['users', 'plans', 'line', 'gform', 'settings', 'imports', 'retention', 'audit'] }
  ],

  renderLayout() {
    const navHtml = App.navGroups.map(g => {
      // module 為單一模組字串；visible() 供跨多模組判斷的頁面（如資料匯入）自行決定是否顯示
      const items = g.keys.filter(k => {
        const p = App.pages[k];
        if (!p) return false;
        if (App.hidden(k) || (p.module && App.hidden(p.module))) return false;
        if (p.visible && !p.visible()) return false;
        return !p.module || App.can(p.module);
      });
      if (!items.length) return '';
      return `<div class="nav-group">${g.label}</div>` +
        items.map(k => `<a href="#${k}" data-nav="${k}">${UI.esc(App.pages[k].title)}
          <span class="nav-badge" data-badge="${k}" hidden></span></a>`).join('');
    }).join('');
    document.getElementById('app').innerHTML = `
      <div class="topbar">
        <button class="menu-btn" id="menu-btn">選單</button>
        <strong>${UI.esc(App.me.center_name)}</strong>
      </div>
      <div class="backdrop" id="backdrop"></div>
      <div class="layout">
        <aside class="sidebar" id="sidebar">
          <div class="brand">${UI.esc(App.me.center_name)}<small>織心心理治療所管理系統</small></div>
          <nav class="nav" id="nav">${navHtml}</nav>
          <div class="user-box">
            <div class="name">${UI.esc(App.me.name)}</div>
            <div>${UI.esc(App.me.title || TW.role[App.me.role] || '')}</div>
            <button id="pw-btn" type="button">修改密碼</button>
            <button id="logout-btn" type="button">登出</button>
          </div>
        </aside>
        <main class="main" id="page"></main>
      </div>`;
    document.getElementById('logout-btn').onclick = async () => { await POST('/logout'); location.reload(); };
    document.getElementById('pw-btn').onclick = App.changePasswordDialog;
    const sidebar = document.getElementById('sidebar'), backdrop = document.getElementById('backdrop');
    document.getElementById('menu-btn').onclick = () => { sidebar.classList.add('open'); backdrop.classList.add('show'); };
    backdrop.onclick = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
    document.getElementById('nav').addEventListener('click', () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); });
    App.refreshBadges();
    clearInterval(App._badgeTimer);
    App._badgeTimer = setInterval(App.refreshBadges, 60000);
  },

  // 導覽列紅點：有待處理的線上預約申請或未讀個案訊息時亮起。
  // 數字直接來自資料庫的待處理筆數，所以只有真的處理完（或被取消）才會消失，
  // 點過、看過都不會讓紅點消掉。
  async refreshBadges() {
    let d;
    try { d = await GET('/nav-badges'); } catch (e) { return; }
    document.querySelectorAll('[data-badge]').forEach(sp => {
      const n = d[sp.dataset.badge] || 0;
      sp.textContent = n > 99 ? '99+' : n;
      sp.hidden = !n;
    });
  },

  changePasswordDialog() {
    UI.modal({
      title: '修改密碼',
      body: `<div class="form-grid">
        ${UI.input('old_password', '舊密碼', { type: 'password', full: true })}
        ${UI.input('new_password', '新密碼（至少 6 碼）', { type: 'password', full: true })}
      </div>`,
      onSubmit: async el => { await PUT('/me/password', UI.formData(el)); UI.toast('密碼已更新'); }
    });
  },

  // 為每張清單補上就地搜尋：頁面自己已有搜尋框（或表格太短）就不重複加。
  autoSearch(body, def) {
    if (!body) return;
    // 清單頁常在切換月份或篩選後重畫表格，重畫會把搜尋列一起洗掉；
    // 因此掛一個觀察器，表格重畫後再補回來（已經有搜尋列的卡片不會重複加）。
    if (!body._searchWatch) {
      body._searchWatch = true;
      let t = null;
      new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => App.autoSearch(body, def), 150);
      }).observe(body, { childList: true, subtree: true });
    }
    // 頁面自己已經有搜尋框（多半是打 API 的伺服器端搜尋）就不再疊一個
    const own = Array.from(body.querySelectorAll('input')).some(i =>
      /搜尋/.test(i.placeholder || '') && !i.classList.contains('fb-q'));
    if (own) return;
    const min = def.searchMin || 5;
    // 排班、週排程、諮商室這類「格子要點的」表不加搜尋列（會擋住操作也沒有意義）
    const GRID = '.shift-table, .week-table, .rb-table, .cal-table';
    const cards = Array.from(body.querySelectorAll('.card'))
      .filter(c => c.querySelectorAll('table.list tbody tr').length >= min
        && !c.querySelector('.fb-q') && !c.querySelector(GRID));
    for (const card of cards) UI.filterBar(card, { search: def.searchHint || '搜尋這張表' });
    // 卡片外的獨立表格（有些頁面直接放表）
    if (!body.querySelector('.card table.list')
      && body.querySelectorAll('table.list tbody tr').length >= min
      && !body.querySelector('.fb-q') && !body.querySelector(GRID)) {
      UI.filterBar(body, { search: def.searchHint || '搜尋這張表' });
    }
  },

  async go(key) {
    // 個案詳情以 hash 帶 id：#client/12
    const [k, arg] = key.split('/');
    const def = App.pages[k];
    if (!def || (def.module && !App.can(def.module))) return App.go('dashboard');
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === k));
    if (location.hash.slice(1) !== key) history.replaceState(null, '', '#' + key);
    const el = document.getElementById('page');
    // 每頁的「怎麼用」說明：def.help 給幾行操作步驟，收合狀態記在 localStorage
    const helpOpen = localStorage.getItem('mc-help-' + k) !== '0';
    const help = (def.help || []).length ? `<details class="page-help"${helpOpen ? ' open' : ''} id="page-help">
        <summary>這頁怎麼用</summary>
        <ul>${def.help.map(h => `<li>${h}</li>`).join('')}</ul></details>` : '';
    el.innerHTML = `<div class="page-title">${UI.esc(def.title)}</div>
      <div class="page-sub">${UI.esc(def.sub || '')}</div>
      ${help}
      <div id="page-body"><div class="empty">載入中...</div></div>`;
    const helpEl = document.getElementById('page-help');
    if (helpEl) helpEl.ontoggle = () => localStorage.setItem('mc-help-' + k, helpEl.open ? '1' : '0');
    const body = document.getElementById('page-body');
    try {
      await def.render(body, arg);
      // 每個模組都要能搜尋：頁面沒有自備搜尋框時，就地補上一個能過濾各張表的搜尋列。
      // 資料已經在畫面上，過濾不必再打 API；def.noSearch 可讓不適合的頁面關掉。
      if (!def.noSearch) App.autoSearch(body, def);
    } catch (e) { body.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; }
  }
};

// ---- 總覽 ----
App.page('dashboard', {
  title: '總覽',
  sub: '今日排程與待辦提醒',
  help: [
    '今天的排程與待辦提醒；紅色的是需要優先處理的（逾期未寫紀錄、申請取消、高風險個案等）。',
    '點任一列可直接跳到該筆資料。左側選單只會出現你有權限的模組。',
  ],
  async render(el) {
    const d = await GET('/dashboard');
    const scopeNote = d.scope === 'mine' ? '（僅顯示您負責的個案）' : '';
    const apptRows = d.today_appointments.map(a => `<tr>
      <td>${a.start_time}-${a.end_time}</td>
      <td><a href="#client/${a.client_id}">${UI.esc(a.client_name)}</a> ${a.risk_level === 'high' ? UI.tag('高風險', 'danger') : ''}</td>
      <td>${UI.esc(a.counselor_name || '')}</td>
      <td>${UI.esc(TW.appt_type[a.type] || a.type)}${a.mode === 'online' ? '／視訊' : ''}</td>
      <td>${UI.esc(a.room_name || '-')}</td>
      <td>${stateTag('appt_status', a.status)}</td></tr>`);
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat clickable" onclick="location.hash='clients'"><div class="num">${d.active_clients}</div><div class="label">服務中個案${scopeNote}</div></div>
        <div class="stat"><div class="num">${d.today_appointments.length}</div><div class="label">今日晤談</div></div>
        <div class="stat clickable" onclick="location.hash='clients'"><div class="num ${d.high_risk ? 'danger' : ''}">${d.high_risk}</div><div class="label">高風險個案</div></div>
        ${App.hidden('risk') ? '' : `<div class="stat clickable" onclick="location.hash='risk'"><div class="num ${d.open_risk_events ? 'danger' : ''}">${d.open_risk_events}</div><div class="label">追蹤中危機事件</div></div>`}
        <div class="stat clickable" onclick="location.hash='notes-pending'"><div class="num ${d.pending_notes ? 'warn' : ''}">${d.pending_notes}</div><div class="label">待補晤談紀錄</div></div>
        <div class="stat"><div class="num">${d.week_sessions}</div><div class="label">近七日完成晤談</div></div>
        <div class="stat"><div class="num">${d.month_sessions}</div><div class="label">本月完成晤談</div></div>
        <div class="stat"><div class="num ${d.no_show_month ? 'warn' : ''}">${d.no_show_month}</div><div class="label">本月未到</div></div>
        <div class="stat clickable" onclick="location.hash='billing'"><div class="num ${d.unpaid.c ? 'warn' : ''}">${d.unpaid.c}</div><div class="label">未收款（${UI.fmtMoney(d.unpaid.amt)}）</div></div>
        <div class="stat clickable" onclick="location.hash='messages'"><div class="num ${d.unread_messages ? 'warn' : ''}">${d.unread_messages}</div><div class="label">未讀個案訊息</div></div>
        <div class="stat clickable" onclick="location.hash='assessments'"><div class="num">${d.pending_tasks}</div><div class="label">待填量表</div></div>
        <div class="stat clickable" onclick="location.hash='intake'"><div class="num ${d.pending_intakes ? 'warn' : ''}">${d.pending_intakes}</div><div class="label">待處理來電</div></div>
        <div class="stat clickable" onclick="location.hash='reminders'"><div class="num ${d.tomorrow_unreminded ? 'warn' : ''}">${d.tomorrow_unreminded}/${d.tomorrow_count}</div><div class="label">明日待提醒</div></div>
        ${App.hidden('partners') ? '' : `<div class="stat clickable" onclick="location.hash='partners'"><div class="num ${d.unsettled ? 'warn' : ''}">${d.unsettled}</div><div class="label">未結請款單</div></div>`}
        ${App.hidden('groups') ? '' : `<div class="stat clickable" onclick="location.hash='groups'"><div class="num">${d.running_groups}</div><div class="label">進行中團體</div></div>`}
        <div class="stat clickable" onclick="location.hash='waitlist'"><div class="num ${d.open_slots ? 'warn' : ''}">${d.open_slots}</div><div class="label">可遞補時段（候補 ${d.waitlist_count} 人）</div></div>
        ${App.hidden('safety') ? '' : `<div class="stat clickable" onclick="location.hash='safety'"><div class="num ${d.safety.missing ? 'danger' : ''}">${d.safety.missing}</div><div class="label">高風險未建安全計畫</div></div>
        <div class="stat clickable" onclick="location.hash='safety'"><div class="num ${d.safety.due ? 'warn' : ''}">${d.safety.due}</div><div class="label">安全計畫逾檢視日</div></div>`}
        ${d.notes_pending_review ? `<div class="stat clickable" onclick="location.hash='notes-review'">
          <div class="num warn">${d.notes_pending_review}</div><div class="label">實習生紀錄待覆核</div></div>` : ''}
      </div>
      <div class="grid-2">
        <div class="card"><h3>近 6 個月完成晤談</h3>
          ${UI.barChart((d.charts.months || []).map(m => ({
    label: m.ym.slice(2), value: m.sessions, note: `未到 ${m.no_show} 次`
  })), { title: '近 6 個月完成晤談數' })}
          <div style="font-size:12.5px;color:var(--muted);margin-top:6px">滑鼠移到長條上可看該月未到次數。</div>
        </div>
        <div class="card"><h3>近 6 個月實收金額</h3>
          ${UI.barChart((d.charts.months || []).map(m => ({ label: m.ym.slice(2), value: m.income })),
    { title: '近 6 個月實收金額', format: v => UI.fmtMoney(v).replace('NT$ ', '') })}
          <div style="font-size:12.5px;color:var(--muted);margin-top:6px">實收＝已收款金額扣除當月退費。</div>
        </div>
        <div class="card"><h3>近 6 個月新收個案</h3>
          ${UI.barChart((d.charts.months || []).map(m => ({ label: m.ym.slice(2), value: m.new_clients })),
    { title: '近 6 個月新收個案' })}
        </div>
        <div class="card"><h3>本月各心理師完成晤談</h3>
          ${UI.barChart((d.charts.by_counselor || []).map(c => ({ label: c.name, value: c.n })),
    { horizontal: true, title: '本月各心理師完成晤談', empty: '本月尚無完成的晤談' })}
        </div>
      </div>
      ${d.cancel_requests.length ? `<div class="card"><h3>個案端取消申請（逾期取消，待櫃檯處理）</h3>
        ${UI.table(['晤談時間', '個案', '心理師', '申請時間', '事由', ''], d.cancel_requests.map(r => `<tr>
          <td>${r.date} ${r.start_time}</td>
          <td>${UI.esc(r.client_name)}（${r.client_code}）</td>
          <td>${UI.esc(r.counselor_name || '')}</td>
          <td>${UI.esc(r.cancel_requested_at)}</td>
          <td>${UI.esc(r.cancel_request_reason || '')}</td>
          <td><a class="btn tiny secondary" href="#today">前往處理</a></td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          個案於免收費期限後提出的取消申請只會登記，不會自行取消預約；請至今日看板或預約排程決定要取消或依比例計費。</div>
      </div>` : ''}
      <div class="card"><h3>今日晤談</h3>
        ${UI.table(['時間', '個案', '心理師', '類型', '諮商室', '狀態'], apptRows, '今日沒有排定的晤談')}
      </div>
      ${d.alert_assessments.length ? `<div class="card"><h3>近 30 天量表警示</h3>
        ${UI.table(['日期', '個案', '量表', '分數', '判讀'], d.alert_assessments.map(a => `<tr>
          <td>${a.date}</td><td>${UI.esc(a.client_name)}（${a.client_code}）</td><td>${a.scale}</td>
          <td>${a.total}</td><td>${UI.tag(a.severity, 'danger')}</td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">量表命中危險題（如 PHQ-9 第 9 題）即列於此，請確認已完成風險評估。</div>
      </div>` : ''}
      ${d.due_plans.length ? `<div class="card"><h3>處遇計畫待檢視</h3>
        ${UI.table(['預定檢視日', '個案'], d.due_plans.map(p => `<tr><td>${p.review_date}</td>
          <td><a href="#client/${p.client_id || ''}">${UI.esc(p.client_name)}（${p.client_code}）</a></td></tr>`))}
      </div>` : ''}
      ${(d.license_alerts.length || d.partner_expiring.length) ? `<div class="card"><h3>證照與契約到期</h3>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
          ${d.license_alerts.map(u => UI.tag(`${u.name} 的執業執照 ${u.license_expiry} 到期（剩 ${u.days_left} 天），請確認繼續教育積分`,
            u.days_left < 60 ? 'danger' : 'warn')).join('')}
          ${d.partner_expiring.map(p => UI.tag(`${p.name} 契約 ${p.contract_end} 到期`, 'warn')).join('')}
        </div></div>` : ''}
      ${d.security ? `<div class="card"><h3>上線安全檢查</h3>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
          ${d.security.default_admin_password ? UI.tag('管理者仍使用預設密碼 mindcare123，請立即至左下「修改密碼」更換', 'danger') : ''}
          ${d.security.demo_hint_staff ? UI.tag('員工登入頁仍顯示測試帳號提示，正式使用請至系統設定清空', 'warn') : ''}
          ${d.security.demo_hint_portal ? UI.tag('個案端登入頁仍顯示測試帳號提示，請至系統設定清空', 'warn') : ''}
          ${!d.security.default_admin_password && !d.security.demo_hint_staff && !d.security.demo_hint_portal
            ? UI.tag('未發現預設密碼或測試提示，檢查通過', 'ok') : ''}
        </div></div>` : ''}`;
  }
});

// ---- 我的工作台（心理師個人視角）----
// 總覽看的是全所，這頁看的是「我」：我的服務量、待補紀錄、督導時數、繼續教育與執照倒數。
App.page('my', {
  title: '我的工作台',
  sub: '個人服務量、待辦與專業資格進度',
  help: [
    '你個人的服務量、待辦與專業資格進度（繼續教育積分、督導時數）。',
    '進度條顯示距離執照更新所需時數還差多少；待辦指的是你自己要補的紀錄與報告。',
  ],
  visible: () => App.isCounselor(),
  async render(el) {
    const [d, myLine] = await Promise.all([GET('/my-dashboard'), GET('/my/line').catch(() => null)]);
    const bar = (now, need, label) => {
      const pct = need > 0 ? Math.min(100, Math.round(now / need * 100)) : 100;
      const done = now >= need;
      return `<div style="margin-bottom:10px">
        <div style="font-size:13.5px;display:flex;justify-content:space-between">
          <span>${UI.esc(label)}</span>
          <span style="color:${done ? 'var(--ok,#2f8f5b)' : 'var(--muted)'}">${now} / ${need}${done ? '　已達標' : `　尚差 ${Math.round((need - now) * 10) / 10}`}</span></div>
        <div style="background:#eef2f5;border-radius:6px;height:9px;margin-top:4px">
          <div style="width:${pct}%;background:${done ? '#2f8f5b' : 'var(--primary)'};height:9px;border-radius:6px"></div></div>
      </div>`;
    };
    const overdueNotes = d.pending_notes.filter(n => n.days_ago > d.note_lock_days).length;
    const lic = d.me.license_days_left;

    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat clickable" onclick="location.hash='clients'"><div class="num">${d.my_clients}</div><div class="label">我的服務中個案</div></div>
        <div class="stat"><div class="num ${d.my_high_risk ? 'danger' : ''}">${d.my_high_risk}</div><div class="label">其中高風險</div></div>
        <div class="stat"><div class="num">${d.today_appointments.length}</div><div class="label">今日晤談</div></div>
        <div class="stat clickable" onclick="location.hash='schedule'"><div class="num">${d.week_appointments}</div><div class="label">未來七日預約</div></div>
        <div class="stat"><div class="num">${d.month_sessions}</div><div class="label">本月完成晤談</div></div>
        <div class="stat"><div class="num">${d.year_sessions}</div><div class="label">今年累計晤談</div></div>
        <div class="stat"><div class="num ${d.month_no_show ? 'warn' : ''}">${d.month_no_show}</div><div class="label">本月未到</div></div>
        <div class="stat clickable" onclick="location.hash='notes-pending'"><div class="num ${overdueNotes ? 'danger' : d.pending_notes.length ? 'warn' : ''}">${d.pending_notes.length}</div>
          <div class="label">待補紀錄${overdueNotes ? `（逾期 ${overdueNotes}）` : ''}</div></div>
        <div class="stat clickable" onclick="location.hash='notes-pending'"><div class="num ${d.pending_reports ? 'warn' : ''}">${d.pending_reports}</div><div class="label">待完成衡鑑報告</div></div>
        <div class="stat clickable" onclick="location.hash='messages'"><div class="num ${d.unread_messages ? 'warn' : ''}">${d.unread_messages}</div><div class="label">我的個案未讀訊息</div></div>
        <div class="stat"><div class="num">${UI.fmtMoney(d.month_revenue)}</div><div class="label">本月開立費用（我的個案）</div></div>
      </div>

      ${App.myLineCard(myLine)}
      ${d.open_risk_events.length && !App.hidden('risk') ? `<div class="card"><h3>追蹤中的危機事件</h3>
        ${UI.table(['日期', '個案', '類型', '嚴重度', '通報'], d.open_risk_events.map(e => `<tr>
          <td>${e.date}</td>
          <td><a href="#client/${e.client_id}">${UI.esc(e.client_name)}（${e.client_code}）</a></td>
          <td>${UI.esc(e.type)}</td>
          <td>${UI.tag(TW.severity[e.severity] || e.severity, e.severity === 'high' ? 'danger' : e.severity === 'medium' ? 'warn' : '')}</td>
          <td>${e.report_state === 'done' ? UI.tag('已通報', 'ok')
    : e.report_state === 'overdue' ? UI.tag(`逾時未通報（應於 ${e.report_due_at.slice(5, 16)} 前）`, 'danger')
      : e.report_state === 'due' ? UI.tag(`應於 ${e.report_due_at.slice(5, 16)} 前通報（剩 ${Math.floor(e.minutes_left / 60)} 小時）`, 'warn')
        : '-'}</td></tr>`))}</div>` : ''}

      <div class="card"><h3>今日晤談</h3>
        ${UI.table(['時間', '個案', '類型', '諮商室', '狀態'], d.today_appointments.map(a => `<tr>
          <td>${a.start_time}-${a.end_time}</td>
          <td><a href="#client/${a.client_id}">${UI.esc(a.client_name)}</a>
            ${a.risk_level === 'high' ? UI.tag('高風險', 'danger') : ''}</td>
          <td>${UI.esc(TW.appt_type[a.type] || a.type)}${a.mode === 'online' ? '／視訊' : ''}</td>
          <td>${UI.esc(a.room_name || '-')}</td>
          <td>${stateTag('appt_status', a.status)}
            ${a.mode === 'online' && a.meeting_url ? `<a class="btn tiny" href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">視訊</a>` : ''}</td>
        </tr>`), '今日沒有排定的晤談')}</div>

      <div class="card"><h3>本週排程</h3>
        ${UI.table(['日期', '時間', '個案', '類型', '地點／連結'], d.week_schedule.map(a => `<tr>
          <td>${a.date.slice(5)}（${UI.weekdayName(a.date)}）</td>
          <td>${a.start_time}-${a.end_time}</td>
          <td><a href="#client/${a.client_id}">${UI.esc(a.client_name)}</a>
            ${a.risk_level === 'high' ? UI.tag('高風險', 'danger') : ''}</td>
          <td>${UI.esc(TW.appt_type[a.type] || a.type)}</td>
          <td>${a.mode === 'online'
    ? (a.meeting_url ? `<a href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">視訊連結</a>` : '視訊（尚未設定連結）')
    : UI.esc(a.room_name || '-')}</td></tr>`), '未來七日沒有預約')}</div>

      ${d.pending_tasks.length ? `<div class="card"><h3>個案待填量表</h3>
        ${UI.table(['個案', '量表', '期限'], d.pending_tasks.map(t => `<tr>
          <td><a href="#client/${t.client_id}">${UI.esc(t.client_name)}</a></td>
          <td>${UI.esc(t.scale)}</td>
          <td>${t.due_date ? (t.due_date < UI.today() ? `<span style="color:var(--danger)">${t.due_date}（已逾期）</span>` : t.due_date) : '-'}</td>
        </tr>`))}</div>` : ''}

      ${d.pending_notes.length ? `<div class="card"><h3>我的待補晤談紀錄</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">所內規定應於 ${d.note_lock_days} 日內完成，逾期以紅字標示。</div>
        ${UI.table(['晤談日期', '距今', '個案', '類型'], d.pending_notes.map(n => `<tr>
          <td>${n.date}</td>
          <td>${n.days_ago > d.note_lock_days ? `<span style="color:var(--danger);font-weight:700">${n.days_ago} 天</span>` : n.days_ago + ' 天'}</td>
          <td><a href="#client/${n.client_id}">${UI.esc(n.client_name)}（${n.client_code}）</a></td>
          <td>${UI.esc(TW.appt_type[n.type] || n.type)}</td></tr>`))}</div>` : ''}

      ${d.due_plans.length ? `<div class="card"><h3>處遇計畫待檢視</h3>
        ${UI.table(['預定檢視日', '個案'], d.due_plans.map(p => `<tr><td>${p.review_date}</td>
          <td><a href="#client/${p.client_id}">${UI.esc(p.client_name)}（${p.client_code}）</a></td></tr>`))}</div>` : ''}

      ${d.notes_returned.length ? `<div class="card"><h3>督導退回待補正的紀錄</h3>
        ${UI.table(['晤談日期', '個案', '督導意見', ''], d.notes_returned.map(n => `<tr>
          <td>${n.date}</td>
          <td><a href="#client/${n.client_id}">${UI.esc(n.client_name)}（${n.client_code}）</a></td>
          <td style="white-space:pre-wrap;font-size:13px">${UI.esc(n.review_comment)}</td>
          <td><a class="btn tiny secondary" href="#notes-review">前往修改</a></td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">修改儲存後請再送一次督導覆核。</div></div>` : ''}

      ${d.notes_to_review ? `<div class="card"><h3>待我覆核的實習生紀錄</h3>
        <div style="font-size:14px">目前有 <strong>${d.notes_to_review}</strong> 筆等待覆核。
          <a class="btn tiny" href="#notes-review" style="margin-left:8px">前往覆核</a></div></div>` : ''}

      ${d.safety_alerts.length && !App.hidden('safety') ? `<div class="card"><h3>安全計畫待處理</h3>
        ${UI.table(['個案', '風險', '狀況', ''], d.safety_alerts.map(a => `<tr>
          <td><a href="#client/${a.client_id}">${UI.esc(a.client_name)}（${a.client_code}）</a></td>
          <td>${stateTag('risk_level', a.risk_level)}</td>
          <td>${a.state === 'missing' ? UI.tag('尚未建立安全計畫', 'danger')
    : UI.tag('逾預定檢視日 ' + (a.review_date || ''), 'warn')}</td>
          <td><a class="btn tiny secondary" href="#client/${a.client_id}">開啟個案</a></td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          安全計畫請於個案頁的「安全計畫」分頁與個案一起訂定，並列印一份給個案帶走。</div></div>` : ''}

      ${App.hidden('supervision') && App.hidden('hr') ? '' : `<div class="card"><h3>專業資格進度</h3>
        <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
          ${UI.esc(d.me.license_type || '未填執照類別')}
          ${d.me.license_no ? '　證書字號 ' + UI.esc(d.me.license_no) : ''}
          ${d.me.license_expiry ? `　執照更新日 ${UI.esc(d.me.license_expiry)}` : '　（尚未填寫執照更新日，積分區間以近一週期概算）'}
        </div>
        ${lic !== null ? `<div style="margin-bottom:12px">${UI.tag(
    lic < 0 ? `執照已於 ${d.me.license_expiry} 到期` : `距執照更新尚有 ${lic} 天`,
    lic < 0 ? 'danger' : lic < 180 ? 'warn' : 'ok')}</div>` : ''}
        ${bar(d.supervision.hours, d.supervision.required, `${d.supervision.year} 年度督導時數（個督 ${d.supervision.individual} 小時）`)}
        ${bar(d.ce.credits, d.ce.required, `繼續教育總積分（${d.ce.cycle_start} ~ ${d.ce.cycle_end}）`)}
        ${bar(d.ce.special_credits, d.ce.required_special, '專業品質＋倫理＋法規 合計')}
        ${bar(d.ce.ethics_credits, d.ce.required_ethics, '其中專業倫理')}
        ${App.hidden('hr') ? '' : `<div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          積分明細與請假登錄請至「請假與繼續教育」頁。</div>`}
      </div>`}

      ${d.upcoming_time_off.length && !App.hidden('hr') ? `<div class="card"><h3>我的請假</h3>
        ${UI.table(['期間', '時段', '事由'], d.upcoming_time_off.map(o => `<tr>
          <td>${o.start_date}${o.end_date !== o.start_date ? ' ~ ' + o.end_date : ''}</td>
          <td>${o.all_day ? '全天' : `${o.start_time}-${o.end_time}`}</td>
          <td>${UI.esc(o.reason || '')}</td></tr>`))}</div>` : ''}

      ${d.my_payouts.length ? `<div class="card"><h3>我的報酬單</h3>
        ${UI.table(['月份', '項目', '次數', '給付總額', '實付', '狀態'], d.my_payouts.map(p => `<tr>
          <td>${p.month}</td><td>${UI.esc(p.item)}</td><td>${p.sessions}</td>
          <td>${UI.fmtMoney(p.gross)}</td><td>${UI.fmtMoney(p.net)}</td>
          <td>${p.status === 'paid' ? UI.tag('已付', 'ok') : UI.tag('待付', 'warn')}</td></tr>`))}</div>` : ''}`;

    const unbind = el.querySelector('#myline-unbind');
    if (unbind) unbind.onclick = async () => {
      if (!await UI.confirm('解除後就不會再收到 LINE 行程推播，確定解除？')) return;
      try { await DEL('/my/line'); UI.toast('已解除綁定'); App.go('my'); } catch (e) { UI.err(e); }
    };
  }
});
