// 個案專區（手機版）：預約、量表填寫、同意書簽署、費用查詢
// 行政聯繫一律走 LINE 官方帳號或電話，刻意不做站內訊息（見「我的資料」的綁定說明）。
// 刻意不提供任何晤談紀錄內容，避免個案端裝置外洩高敏感紀錄
const PAPI = p => '/portal' + p;

// 個案端的分數變化圖：同一量表多次施測畫成折線，讓個案自己看得到變化。
// 只呈現分數與切分點，不含任何晤談內容。
function trendCards(rows, scales) {
  const byScale = {};
  for (const r of rows) (byScale[r.scale] = byScale[r.scale] || []).push(r);
  return Object.entries(byScale)
    .map(([k, list]) => [k, list.slice().sort((a, b) => a.date.localeCompare(b.date))])
    .filter(([, list]) => list.length > 1)
    .map(([k, list]) => {
      const first = list[0].total, last = list[list.length - 1].total;
      const diff = last - first;
      return `<div class="card"><h3>${UI.esc(scales[k] ? scales[k].name : k)}　分數變化</h3>
        ${UI.trendChart(list, (scales[k] && scales[k].cuts) || [])}
        <div style="font-size:13px;color:var(--muted);margin-top:6px">
          第一次 ${first} 分 → 最近一次 ${last} 分（${diff === 0 ? '持平' : diff < 0 ? '下降 ' + Math.abs(diff) + ' 分' : '上升 ' + diff + ' 分'}）。
          虛線為判讀級距分界。分數起伏很正常，請於晤談時與心理師一起看。</div></div>`;
    }).join('');
}

const Portal = {
  me: null,
  tab: 'home',

  async boot() {
    try {
      Portal.me = await GET(PAPI('/me'));
      Portal.render();
      if (Portal.me.must_change_password) Portal.passwordDialog(true);
    } catch {
      Portal.renderLogin();
    }
  },
  onUnauthorized() { if (Portal.me) { Portal.me = null; Portal.renderLogin(); } },

  async renderLogin() {
    const t = await GET('/public/ui-texts').catch(() => ({}));
    document.getElementById('app').innerHTML = `
      <div class="login-wrap"><div class="login-card">
        <h1>${UI.esc(t.ui_portal_title || '織心個案專區')}</h1>
        <div class="sub">${UI.esc(t.ui_portal_login_sub || '預約與行政事項')}</div>
        <div class="form-row"><label>手機號碼</label><input id="lg-user" inputmode="numeric" autocomplete="username"></div>
        <div class="form-row"><label>密碼</label><input id="lg-pass" type="password" autocomplete="current-password"></div>
        <button class="btn" id="lg-btn">登入</button>
        <div class="login-err" id="lg-err"></div>
        ${t.ui_portal_login_hint ? `<div style="margin-top:10px;font-size:12.5px;color:var(--muted)">${UI.esc(t.ui_portal_login_hint)}</div>` : ''}
        ${t.ui_demo_portal ? `<div style="margin-top:14px;padding:12px;background:var(--primary-light);border-radius:8px;font-size:13px;line-height:1.8">
          ${UI.esc(t.ui_demo_portal).replace(/\n/g, '<br>')}</div>` : ''}
        ${t.ui_crisis_note ? `<div class="crisis" style="margin-top:14px">${UI.esc(t.ui_crisis_note)}</div>` : ''}
      </div></div>`;
    const doLogin = async () => {
      const err = document.getElementById('lg-err');
      err.textContent = '';
      try {
        await POST(PAPI('/login'), {
          phone: document.getElementById('lg-user').value.trim(),
          password: document.getElementById('lg-pass').value
        });
        location.reload();
      } catch (e) { err.textContent = e.message; }
    };
    document.getElementById('lg-btn').onclick = doLogin;
    document.getElementById('lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  },

  passwordDialog(force) {
    UI.modal({
      title: force ? '首次登入請更換密碼' : '修改密碼',
      body: `<div class="form-grid">
        ${UI.input('old_password', '目前密碼', { type: 'password', full: true })}
        ${UI.input('new_password', '新密碼（至少 6 碼）', { type: 'password', full: true })}</div>`,
      onSubmit: async el => { await PUT(PAPI('/password'), UI.formData(el)); UI.toast('密碼已更新'); }
    });
  },

  // LINE 綁定卡片：加好友與回報綁定碼都要本人在 LINE 操作，這裡把兩步做成按鈕，
  // 綁定碼也直接包在聊天室連結裡（開啟後訊息已填好，按送出即可），免得長輩打錯字。
  lineCard(d) {
    if (!d || !d.enabled) return '';
    const name = UI.esc(d.official_name || 'LINE 官方帳號');
    if (d.bound) {
      return `<div class="card"><h3>LINE 提醒 ${UI.tag('已綁定', 'ok')}</h3>
        <div style="font-size:14px;line-height:1.9">已與「${name}」連結，晤談前 ${d.reminder_hours} 小時會收到提醒，
          預約成立與異動也會通知您。</div>
        <button class="btn tiny secondary" id="line-unbind" style="margin-top:10px">解除綁定</button></div>`;
    }
    return `<div class="card"><h3>LINE 提醒 ${UI.tag('尚未綁定', 'warn')}</h3>
      <div style="font-size:14px;line-height:1.9">綁定後，晤談前 ${d.reminder_hours} 小時會用 LINE 提醒您，
        預約成立與異動也會通知，不必擔心記錯時間。</div>
      <div style="margin-top:12px;font-size:14px;line-height:2">
        <strong>步驟 1</strong>　加「${name}」為好友
        ${d.add_friend_url ? `<br><a class="btn small" style="margin:6px 0"
          href="${UI.esc(d.add_friend_url)}" target="_blank" rel="noopener">加入好友</a>` : ''}
        <br><strong>步驟 2</strong>　在聊天室傳送這組綁定碼
        <div style="font-size:26px;font-weight:700;letter-spacing:4px;margin:6px 0">${UI.esc(d.code || '')}</div>
        ${d.message_url ? `<a class="btn small" style="margin-bottom:6px"
          href="${UI.esc(d.message_url)}" target="_blank" rel="noopener">開啟聊天室並帶入綁定碼</a>` : ''}
        <button class="btn small secondary" id="line-copy" data-code="${UI.esc(d.code || '')}">複製綁定碼</button>
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px;line-height:1.8">
        綁定碼於 ${UI.esc(d.expires_at || '')} 前有效，逾期回到本頁會自動換一組新的。
        傳送後官方帳號會回覆「綁定完成」，此頁重新整理即顯示已綁定。</div></div>`;
  },

  navItems: [
    { key: 'home', label: '首頁' },
    { key: 'book', label: '預約' },
    { key: 'scales', label: '量表' },
    { key: 'billing', label: '費用' },
    { key: 'me', label: '我的' }
  ],

  render() {
    const m = Portal.me;
    document.getElementById('app').innerHTML = `
      <div class="fam-wrap">
        <div class="fam-head">
          <button class="logout-link" id="lo">登出</button>
          <h1>${UI.esc(m.center_name)}</h1>
          <div class="sub">${UI.esc(m.name)}　${m.counselor ? '主責心理師：' + UI.esc(m.counselor.name) : ''}</div>
        </div>
        <div class="fam-body" id="body"></div>
        <div class="fam-nav">${Portal.navItems.map(n => `<button data-t="${n.key}">${n.label}
          ${n.key === 'scales' && m.pending_tasks.length ? `<span class="nav-badge">${m.pending_tasks.length}</span>` : ''}
        </button>`).join('')}</div>
      </div>`;
    document.getElementById('lo').onclick = async () => { await POST(PAPI('/logout')); location.reload(); };
    document.querySelectorAll('[data-t]').forEach(b => { b.onclick = () => Portal.go(b.dataset.t); });
    Portal.go(Portal.tab);
  },

  async go(tab) {
    Portal.tab = tab;
    document.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    const el = document.getElementById('body');
    el.innerHTML = '<div class="empty">載入中...</div>';
    try { await Portal.pages[tab](el); }
    catch (e) { el.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; }
  },

  pages: {
    async home(el) {
      const m = Portal.me;
      const [appts, ann] = await Promise.all([GET(PAPI('/appointments')), GET(PAPI('/announcements'))]);
      const next = appts.filter(a => a.status === 'booked' && a.date >= UI.today())
        .sort((x, y) => (x.date + x.start_time).localeCompare(y.date + y.start_time))[0];
      el.innerHTML = `
        ${m.crisis_note ? `<div class="crisis">${UI.esc(m.crisis_note)}</div>` : ''}
        <div class="card"><h3>下次晤談</h3>
          ${next ? `<div style="font-size:16px;font-weight:700">${next.date}（${UI.weekdayName(next.date)}）${next.start_time}-${next.end_time}</div>
            <div style="font-size:14px;color:var(--muted);margin-top:4px">
              ${UI.esc(next.counselor_name || '')}　${UI.esc(TW.appt_type[next.type] || '')}　${UI.esc(TW.appt_mode[next.mode])}
              ${next.plan_name ? '　' + UI.esc(next.plan_name) : ''}</div>
            ${next.mode === 'online' && next.meeting_url ? `<a class="btn small" style="margin-top:10px"
              href="${UI.esc(next.meeting_url)}" target="_blank" rel="noopener noreferrer">進入視訊晤談</a>` : ''}`
      : '<div style="color:var(--muted);font-size:14px">目前沒有預約，可至「預約」頁面安排時段。</div>'}
        </div>
        ${m.pending_consents.length ? `<div class="card"><h3>待簽署同意書</h3>
          ${m.pending_consents.map(c => `<div style="margin-bottom:6px"><button class="btn small" data-cs="${c.key}">${UI.esc(c.title)}</button></div>`).join('')}
        </div>` : ''}
        ${m.pending_tasks.length ? `<div class="card"><h3>待填量表</h3>
          ${m.pending_tasks.map(t => `<div style="font-size:14px;margin-bottom:4px">${UI.esc(t.scale)}
            ${t.due_date ? `（期限 ${t.due_date}）` : ''}</div>`).join('')}
          <button class="btn small" id="tofill" style="margin-top:8px">前往填寫</button></div>` : ''}
        <div class="card"><h3>公告</h3>
          ${ann.length ? ann.map(a => `<div style="margin-bottom:10px">
            <strong>${UI.esc(a.title)}</strong><div style="font-size:12px;color:var(--muted)">${a.publish_date}</div>
            <div style="font-size:14px">${UI.nl2br(a.content)}</div></div>`).join('')
      : '<div style="color:var(--muted);font-size:14px">目前沒有公告</div>'}
        </div>
        ${m.portal_note ? `<div class="card" style="font-size:13px;color:var(--muted)">${UI.nl2br(m.portal_note)}</div>` : ''}`;
      const tf = el.querySelector('#tofill');
      if (tf) tf.onclick = () => Portal.go('scales');
      el.querySelectorAll('[data-cs]').forEach(b => { b.onclick = () => Portal.signConsent(b.dataset.cs); });
    },

    async book(el) {
      const [appts, pending] = await Promise.all([
        GET(PAPI('/appointments')), GET(PAPI('/booking-requests')).catch(() => [])
      ]);
      const upcoming = appts.filter(a => ['booked', 'arrived'].includes(a.status) && a.date >= UI.today());
      const past = appts.filter(a => !upcoming.includes(a)).slice(0, 15);
      // 家人的約用姓名標出來，一整頁時間混在一起會分不出是誰的
      const whose = a => (a.for_name ? `<span class="tag">${UI.esc(a.for_name)}</span> ` : '');
      el.innerHTML = `
        ${Portal.me.booking_enabled ? '<button class="btn" id="new" style="width:100%;margin-bottom:14px">預約新時段</button>' : ''}
        ${pending.length ? `<div class="card"><h3>待櫃檯確認的申請</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            這些方案需由櫃檯確認後才算完成預約，時段尚未保留給您。</div>
          ${pending.map(r => `<div style="border-bottom:1px dashed var(--border);padding:8px 0">
            <div style="font-size:15px;font-weight:600">${r.for_name ? `<span class="tag">${UI.esc(r.for_name)}</span> ` : ''}${r.date}（${UI.weekdayName(r.date)}）${r.start_time}</div>
            <div style="font-size:13px;color:var(--muted)">${UI.esc(r.plan_name || '')}　${UI.esc(r.counselor_name || '')}</div>
            <button class="btn tiny secondary" style="margin-top:6px" data-wd="${r.id}">撤回申請</button>
          </div>`).join('')}</div>` : ''}
        <div class="card"><h3>即將到來</h3>
          ${upcoming.length ? upcoming.map(a => `<div style="border-bottom:1px dashed var(--border);padding:8px 0">
            <div style="font-size:15px;font-weight:600">${whose(a)}${a.date}（${UI.weekdayName(a.date)}）${a.start_time}-${a.end_time}</div>
            <div style="font-size:13px;color:var(--muted)">${UI.esc(a.counselor_name || '')}　${UI.esc(TW.appt_type[a.type] || '')}　${stateTag('appt_status', a.status)}</div>
            ${a.mode === 'online' && a.meeting_url ? `<a class="btn tiny" style="margin-top:6px;margin-right:6px"
              href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">進入視訊</a>` : ''}
            ${a.cancel_requested_at ? `<div style="font-size:12.5px;color:var(--warn);margin-top:4px">
              已送出取消申請，我們會盡快與您聯繫</div>` : ''}
            ${a.status === 'booked' ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              ${Portal.me.reschedule_enabled && a.can_self_serve
    ? `<button class="btn tiny secondary" data-resch="${a.id}">改期</button>` : ''}
              ${!a.cancel_requested_at ? `<button class="btn tiny danger" data-cancel="${a.id}">${a.late ? '申請取消' : '取消預約'}</button>` : ''}
            </div>
            ${a.late ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">
              距晤談不足 ${Portal.me.cancel_hours} 小時，改期或取消請來電；線上僅能送出取消申請。</div>` : ''}` : ''}
          </div>`).join('') : '<div style="color:var(--muted);font-size:14px">目前沒有預約</div>'}
        </div>
        <div class="card"><h3>歷史紀錄</h3>
          ${UI.table(['日期', '時間', '對象', '狀態'], past.map(a => `<tr><td>${a.date}</td>
            <td>${a.start_time}</td><td>${UI.esc(a.for_name || '本人')}</td>
            <td>${stateTag('appt_status', a.status)}</td></tr>`), '尚無紀錄')}</div>`;
      const nb = el.querySelector('#new');
      if (nb) nb.onclick = () => Portal.bookDialog();
      el.querySelectorAll('[data-wd]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('撤回這筆預約申請？')) return;
          try {
            await POST(PAPI(`/booking-requests/${b.dataset.wd}/cancel`), {});
            UI.toast('已撤回申請');
            Portal.go('book');
          } catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-cancel]').forEach(b => {
        b.onclick = () => {
          const a = upcoming.find(x => x.id === Number(b.dataset.cancel));
          UI.modal({
            title: a.late ? '申請取消預約' : '取消預約',
            submitText: a.late ? '送出申請' : '確定取消',
            body: `<div style="font-size:14px;margin-bottom:10px">
                ${a.date}（${UI.weekdayName(a.date)}）${a.start_time}-${a.end_time}　${UI.esc(a.counselor_name || '')}</div>
              <div class="form-grid">${UI.textarea('reason', '取消事由（選填）', { rows: 3 })}</div>
              ${a.late ? `<div style="font-size:13px;color:var(--muted);margin-top:8px;line-height:1.7">
                距晤談時間已不足 ${Portal.me.cancel_hours} 小時，系統只會為您送出取消申請並通知櫃檯，
                預約在櫃檯處理前仍然有效；依所內規定，逾期取消可能收取原費用之
                ${Math.round((Portal.me.no_show_fee_rate || 0.5) * 100)}%。</div>`
    : `<div style="font-size:13px;color:var(--muted);margin-top:8px">
                取消後時段會釋出給其他個案，如需重新預約請至「預約新時段」。</div>`}`,
            onSubmit: async form => {
              const r = await POST(PAPI(`/appointments/${a.id}/cancel`), UI.formData(form));
              UI.toast(r.message || '已處理');
              Portal.go('book');
            }
          });
        };
      });
      // 改期：時段選擇與新預約共用同一份可預約時段，並限定原心理師
      el.querySelectorAll('[data-resch]').forEach(b => {
        b.onclick = () => Portal.rescheduleDialog(upcoming.find(x => x.id === Number(b.dataset.resch)));
      });
    },

    async scales(el) {
      const [scales, mine] = await Promise.all([GET(PAPI('/scales')), GET(PAPI('/assessments'))]);
      const tasks = Portal.me.pending_tasks;
      el.innerHTML = `
        <div class="card"><h3>待填量表</h3>
          ${tasks.length ? tasks.map(t => `<div style="margin-bottom:8px">
            <button class="btn small" data-fill="${t.scale}" data-task="${t.id}">${UI.esc(scales[t.scale] ? scales[t.scale].name : t.scale)}</button>
            ${t.due_date ? `<span style="font-size:12px;color:var(--muted)">期限 ${t.due_date}</span>` : ''}</div>`).join('')
      : '<div style="color:var(--muted);font-size:14px">目前沒有指派的量表</div>'}
        </div>
        ${trendCards(mine, scales)}
        <div class="card"><h3>我的填寫紀錄</h3>
          ${UI.table(['日期', '量表', '分數', '判讀'], mine.map(a => `<tr><td>${a.date}</td>
            <td>${UI.esc(scales[a.scale] ? scales[a.scale].name : a.scale)}</td><td><strong>${a.total}</strong></td>
            <td style="font-size:12.5px;color:var(--muted)">${UI.esc(a.severity || '')}</td></tr>`), '尚無紀錄')}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            量表分數為篩檢參考，實際狀況請於晤談時與心理師討論。</div></div>`;
      el.querySelectorAll('[data-fill]').forEach(b => {
        b.onclick = () => Portal.fillScale(scales[b.dataset.fill], b.dataset.fill, b.dataset.task);
      });
    },

    async billing(el) {
      const d = await GET(PAPI('/billing'));
      el.innerHTML = `
        <div class="card"><h3>應繳金額</h3>
          <div style="font-size:24px;font-weight:700;color:${d.unpaid ? 'var(--warn)' : 'var(--ok)'}">${UI.fmtMoney(d.unpaid)}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:4px">請於晤談時至櫃檯繳費。</div></div>
        ${d.packages.length ? `<div class="card"><h3>方案</h3>
          ${d.packages.map(p => `<div style="font-size:14px;margin-bottom:6px">${UI.esc(p.name)}
            剩餘 <strong>${p.remaining}</strong>/${p.sessions_total} 次
            ${p.expire_date ? `<span style="color:var(--muted)">（${p.expire_date} 到期）</span>` : ''}</div>`).join('')}</div>` : ''}
        <div class="card"><h3>費用明細</h3>
          ${UI.table(['日期', '項目', '金額', '狀態'], d.invoices.map(i => `<tr><td>${i.date}</td>
            <td>${UI.esc(i.item)}</td><td>${UI.fmtMoney(i.amount)}</td>
            <td>${stateTag('inv_status', i.status)}</td></tr>`), '尚無費用紀錄')}</div>`;
    },

    async me(el) {
      const [consents, files, line] = await Promise.all([
        GET(PAPI('/consents')), GET(PAPI('/attachments')), GET(PAPI('/line')).catch(() => null)
      ]);
      const m = Portal.me;
      el.innerHTML = `
        <div class="card"><h3>我的資料</h3>
          <div class="detail-grid">
            <div><div class="dg-label">姓名</div>${UI.esc(m.name)}</div>
            <div><div class="dg-label">個案編號</div>${UI.esc(m.code)}</div>
            <div><div class="dg-label">手機</div>${UI.esc(m.phone)}</div>
            <div><div class="dg-label">主責心理師</div>${m.counselor ? UI.esc(m.counselor.name) : '未指定'}</div>
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:10px">資料如需更正請聯絡諮商所。</div>
          <button class="btn small secondary" id="pw" style="margin-top:10px">修改密碼</button></div>
        <div class="card"><h3>同意書</h3>
          ${consents.map(c => `<div style="border-bottom:1px dashed var(--border);padding:8px 0">
            <div style="font-size:14px;font-weight:600">${UI.esc(c.title)}
              ${c.signed ? (c.signed.agreed ? UI.tag('已同意', 'ok') : UI.tag('不同意', 'warn')) : UI.tag('未簽署', 'danger')}</div>
            <div style="font-size:12px;color:var(--muted)">v${c.version}${c.signed ? '　' + UI.esc(c.signed.signed_at) : ''}</div>
            <button class="btn tiny ${c.signed ? 'secondary' : ''}" data-cs="${c.key}" style="margin-top:6px">
              ${c.signed ? '檢視／重新簽署' : '閱讀並簽署'}</button></div>`).join('')}
        </div>
        ${files.length ? `<div class="card"><h3>諮商所提供的檔案</h3>
          ${files.map(f => `<div style="display:flex;gap:8px;align-items:center;border-bottom:1px dashed var(--border);padding:8px 0">
            <div style="flex:1">
              <div style="font-size:14px;font-weight:600">${UI.esc(f.filename)}</div>
              <div style="font-size:12px;color:var(--muted)">${UI.esc(f.kind)}　${UI.fmtSize(f.size)}　${f.created_at.slice(0, 10)}</div>
            </div>
            <button class="btn tiny secondary" data-fd="${f.id}">下載</button></div>`).join('')}
        </div>` : ''}
        ${Portal.lineCard(line)}
        <div class="card"><h3>諮商所資訊</h3>
          <div style="font-size:14px;line-height:1.9">${UI.esc(m.center_name)}<br>
            ${UI.esc(m.center_phone || '')}<br>${UI.esc(m.center_address || '')}</div></div>`;
      el.querySelectorAll('[data-fd]').forEach(b => {
        b.onclick = () => { window.location.href = `/api/portal/attachments/${b.dataset.fd}/download`; };
      });
      el.querySelector('#pw').onclick = () => Portal.passwordDialog(false);
      const unbind = el.querySelector('#line-unbind');
      if (unbind) unbind.onclick = async () => {
        if (!await UI.confirm('解除後就不會再收到 LINE 提醒，確定解除？')) return;
        try { await DEL(PAPI('/line')); UI.toast('已解除綁定'); Portal.go('me'); } catch (e) { UI.err(e); }
      };
      const copy = el.querySelector('#line-copy');
      if (copy) copy.onclick = async () => {
        try { await navigator.clipboard.writeText(copy.dataset.code); UI.toast('已複製綁定碼'); }
        catch { UI.toast('請長按上方號碼手動複製', true); }
      };
      el.querySelectorAll('[data-cs]').forEach(b => { b.onclick = () => Portal.signConsent(b.dataset.cs); });
    }
  },

  // 改期：沿用線上預約的規則（開放時段、可約範圍、不換心理師），
  // 逾免收費期限者後端會擋下並請個案來電。
  async rescheduleDialog(a) {
    const m = UI.modal({
      title: '改期',
      hideFooter: true,
      body: `<div style="font-size:14px;margin-bottom:10px">
          ${a.for_name ? `${UI.esc(a.for_name)}的晤談<br>` : ''}原時間：${a.date}（${UI.weekdayName(a.date)}）${a.start_time}-${a.end_time}　${UI.esc(a.counselor_name || '')}</div>
        <div class="form-grid">${UI.input('date', '改到哪一天', { type: 'date', value: UI.addDays(UI.today(), 1), full: true })}</div>
        <div id="slots" style="margin-top:12px"></div>`
    });
    const draw = async () => {
      const box = m.body.querySelector('#slots');
      const date = m.body.querySelector('[name=date]').value;
      box.innerHTML = '查詢中...';
      try {
        // 家人的約要以「那位家人」查時段，否則會拿到自己的主責心理師而找不到原心理師
        const d = await GET(PAPI(`/slots?date=${date}${a.plan_id ? '&plan_id=' + a.plan_id : ''}`
          + `${a.for_name ? '&for_client_id=' + a.client_id : ''}`));
        const inp = m.body.querySelector('[name=date]');
        inp.min = d.min_date; inp.max = d.max_date;
        // 改期不換心理師，只列原心理師的時段
        const c = d.counselors.find(x => x.id === a.counselor_id);
        box.innerHTML = c && c.slots.length
          ? `<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">${UI.esc(c.name)}</div>`
            + c.slots.map(s => `<button class="btn small secondary slot-btn" type="button" data-s="${s.start_time}">${s.start_time}</button>`).join('')
          : `<div style="color:var(--muted);font-size:14px">此日無可改期的時段，請換一天或來電洽詢。
              <br>可預約範圍：${d.min_date} ~ ${d.max_date}</div>`;
        box.querySelectorAll('[data-s]').forEach(b => {
          b.onclick = async () => {
            if (!await UI.confirm(`把 ${a.date} ${a.start_time} 的晤談改到 ${date} ${b.dataset.s}？`)) return;
            try {
              await POST(PAPI(`/appointments/${a.id}/reschedule`), { date, start_time: b.dataset.s });
              UI.toast('已完成改期');
              m.close();
              Portal.go('book');
            } catch (e) { UI.err(e); }
          };
        });
      } catch (e) { box.innerHTML = `<div style="color:var(--danger);font-size:14px">${UI.esc(e.message)}</div>`; }
    };
    m.body.querySelector('[name=date]').onchange = draw;
    draw();
  },

  // 預約：先選服務方案再選時段。舊個案臨時要約伴侶諮商或親職諮詢時，
  // 時段長度與費用都要照該方案算，不能一律套用預設的個別晤談。
  async bookDialog() {
    const today = UI.today();
    const list = Portal.me.plans || [];
    const family = Portal.me.family || [];
    const money = n => (Number(n) > 0 ? `NT$ ${Number(n).toLocaleString()}` : '費用另計');
    const m = UI.modal({
      title: '預約時段',
      body: `<div class="form-grid">
          ${family.length ? UI.select('for_client_id', '預約對象',
    [['', '我自己']].concat(family.map(f => [f.id, `${f.name}${f.relationship ? `（${f.relationship}）` : ''}`])),
    { full: true, search: false }) : ''}
          ${list.length ? UI.select('plan_id', '服務方案',
    [['', '一般晤談（沿用原本的安排）']].concat(list.map(p => [p.id, `${p.name}　${p.session_minutes} 分鐘`])),
    { full: true, search: false }) : ''}
          ${UI.input('date', '日期', { type: 'date', value: UI.addDays(today, 1), full: true })}
        </div>
        <div id="plan-note" style="font-size:13px;color:var(--muted);margin-top:-4px"></div>
        <div id="fee-pick" style="margin-top:8px"></div>
        <div id="slots" style="margin-top:12px"></div>`,
      hideFooter: true
    });
    const planSel = m.body.querySelector('[name=plan_id]');
    const forSel = m.body.querySelector('[name=for_client_id]');
    const dateInp = m.body.querySelector('[name=date]');
    const curPlan = () => list.find(p => String(p.id) === String(planSel && planSel.value)) || null;
    // 換人就要重查：每個人的主責心理師、方案資格與已用次數都不一樣
    const forId = () => (forSel && forSel.value) || '';

    // 選了方案就先把時長、費用與說明講清楚，個案不必等送出才知道這一次要多久、多少錢
    const drawPlan = () => {
      const p = curPlan();
      m.body.querySelector('#plan-note').innerHTML = p
        ? `${p.session_minutes} 分鐘・${money(p.client_pay)}${p.default_mode === 'online' ? '・線上視訊' : ''}
           ${p.venue_fee ? `（另含場地費 NT$ ${p.venue_fee}）` : ''}
           ${p.intro ? `<br>${UI.esc(p.intro)}` : ''}` : '';
      // 可選金額的方案（如伴侶／家族）讓個案自己挑，後端只接受設定裡列出的金額
      const box = m.body.querySelector('#fee-pick');
      box.innerHTML = p && p.fee_mode === 'choice' && p.fee_options.length
        ? `<div class="form-grid">${UI.select('fee_choice', '費用方案',
    p.fee_options.map(v => [v, `NT$ ${Number(v).toLocaleString()}`]), { full: true, search: false })}</div>`
        : '';
    };

    const draw = async () => {
      const box = m.body.querySelector('#slots');
      const p = curPlan();
      const date = dateInp.value;
      box.innerHTML = '查詢中...';
      try {
        const d = await GET(PAPI(`/slots?date=${date}${p ? '&plan_id=' + p.id : ''}${forId() ? '&for_client_id=' + forId() : ''}`));
        dateInp.min = d.min_date; dateInp.max = d.max_date;
        if (d.plan_error) {
          box.innerHTML = `<div style="color:var(--danger);font-size:14px">${UI.esc(d.plan_error)}
            <br>如需協助請來電洽詢。</div>`;
          return;
        }
        if (d.plan_no_counselor) {
          box.innerHTML = '<div style="color:var(--muted);font-size:14px">此方案需由本所指定的心理師進行，請來電洽詢安排。</div>';
          return;
        }
        const any = d.counselors.some(c => c.slots.length);
        box.innerHTML = any ? d.counselors.map(c => `
          <div style="margin-bottom:10px"><div style="font-size:13.5px;font-weight:600">${UI.esc(c.name)}</div>
          ${c.slots.length ? c.slots.map(s => `<button class="btn small secondary slot-btn" type="button"
            data-c="${c.id}" data-s="${s.start_time}">${s.start_time}</button>`).join('')
    : `<span style="color:var(--muted);font-size:13px">${UI.esc(c.full || '無開放時段')}</span>`}
          </div>`).join('') : `<div style="color:var(--muted);font-size:14px">此日無可預約時段，請換一天或來電洽詢。
            <br>可預約範圍：${d.min_date} ~ ${d.max_date}</div>`;
        box.querySelectorAll('[data-s]').forEach(b => {
          b.onclick = async () => {
            const feeSel = m.body.querySelector('[name=fee_choice]');
            const detail = p ? `${p.name}（${p.session_minutes} 分鐘）` : '晤談';
            const target = family.find(f => String(f.id) === String(forId()));
            if (!await UI.confirm(`${target ? `替${target.name}預約` : '預約'} ${dateInp.value} ${b.dataset.s} 的${detail}？`)) return;
            try {
              const r = await POST(PAPI('/appointments'), {
                date: dateInp.value, start_time: b.dataset.s, counselor_id: Number(b.dataset.c),
                plan_id: p ? p.id : '', fee_choice: feeSel ? feeSel.value : '',
                for_client_id: forId()
              });
              // 需櫃檯確認的方案送出的是申請，不能講成「已預約」，否則個案會以為時段保留住了
              UI.toast(r.pending ? '已送出預約申請，待櫃檯確認' : '已送出預約');
              m.close();
              Portal.go('book');
            } catch (e) { UI.err(e); }
          };
        });
      } catch (e) { box.innerHTML = `<div style="color:var(--danger);font-size:14px">${UI.esc(e.message)}</div>`; }
    };
    if (planSel) planSel.onchange = () => { drawPlan(); draw(); };
    if (forSel) forSel.onchange = draw;
    dateInp.onchange = draw;
    drawPlan();
    draw();
  },

  fillScale(scale, key, taskId) {
    UI.modal({
      title: scale.name,
      wide: true,
      submitText: '送出',
      body: `<div style="font-size:13.5px;color:var(--muted);margin-bottom:10px">${UI.esc(scale.intro)}</div>
        ${scale.items.map((q, i) => `<div style="padding:8px 0;border-bottom:1px dashed var(--border)">
          <div style="font-size:14.5px;margin-bottom:6px">${i + 1}. ${UI.esc(q)}</div>
          <select class="ans" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:8px">
            ${scale.options.map(o => `<option value="${o[0]}">${UI.esc(o[1])}</option>`).join('')}</select></div>`).join('')}`,
      onSubmit: async el => {
        const answers = [...el.querySelectorAll('.ans')].map(s => Number(s.value));
        const r = await POST(PAPI('/assessments'), { scale: key, answers, task_id: taskId });
        Portal.me = await GET(PAPI('/me'));
        if (r.alert) {
          UI.modal({
            title: '請留意', hideFooter: true,
            body: `<div class="crisis" style="font-size:15px">${UI.esc(r.crisis_note)}<br><br>
              您的填答已送出，心理師會盡快與您聯繫。如果現在就覺得撐不住，請立即撥打上述專線或前往就近醫院急診。</div>`
          });
        } else {
          UI.toast('已送出，謝謝您的填寫');
        }
        Portal.render();
      }
    });
  },

  async signConsent(key) {
    const list = await GET(PAPI('/consents'));
    const c = list.find(x => x.key === key);
    if (!c) return UI.err(new Error('找不到此同意書'));
    UI.modal({
      title: c.title,
      wide: true,
      submitText: '確認簽署',
      body: `<div style="white-space:pre-wrap;font-size:14px;line-height:1.75;max-height:45vh;overflow:auto;
          padding:12px;background:#f7f9fa;border-radius:8px">${UI.esc(c.body)}</div>
        <div class="form-grid" style="margin-top:14px">
          ${c.allow_decline ? UI.select('agreed', '我的意願', [[1, '我同意'], [0, '我不同意']], { value: 1, full: true }) : ''}
          ${UI.input('signer_name', c.minor_only ? '法定代理人姓名' : '簽署人姓名', { full: true })}</div>
        <div class="form-row full" style="margin-top:10px"><label>簽名</label>
          <canvas id="sig" style="border:1px dashed var(--border);border-radius:8px;height:150px;background:#fff;touch-action:none"></canvas>
          <button class="btn tiny secondary" id="clr" type="button" style="align-self:flex-start;margin-top:6px">清除</button></div>`,
      onOpen: el => {
        const pad = UI.signaturePad(el.querySelector('#sig'));
        el.querySelector('#clr').onclick = () => pad.clear();
        el._pad = pad;
      },
      onSubmit: async el => {
        const d = UI.formData(el);
        if (!d.signer_name) throw new Error('請填寫簽署人姓名');
        const sig = el._pad.dataUrl();
        if (!sig) throw new Error('請完成簽名');
        await POST(PAPI('/consents'), {
          key, agreed: d.agreed === undefined ? 1 : Number(d.agreed),
          signer_name: d.signer_name, signature: sig
        });
        UI.toast('已完成簽署');
        Portal.me = await GET(PAPI('/me'));
        Portal.render();
      }
    });
  }
};

// api.js 的 401 導回登入
window.App = { onUnauthorized: () => Portal.onUnauthorized() };
