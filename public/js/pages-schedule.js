// 預約排程：週檢視、今日看板、預約表單、待補紀錄

// defaults：新增預約時的預帶值（例如行事曆點某一天）
async function apptDialog(appt, onDone, defaults) {
  const clients = await App.clientOptions(true);
  const isNew = !appt;
  const a = appt || {
    date: UI.today(), start_time: '14:00', type: 'individual', mode: 'onsite', counselor_id: App.me.id,
    ...(defaults || {})
  };
  let packages = [];
  if (a.client_id) packages = await GET(`/clients/${a.client_id}/active-packages`).catch(() => []);
  UI.modal({
    title: isNew ? '新增預約' : '修改預約',
    wide: true,
    body: `<div class="form-grid">
      ${UI.picker('client_id', '個案', clients, { value: a.client_id || '' })}
      ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: a.counselor_id })}
      ${UI.input('date', '日期', { type: 'date', value: a.date })}
      ${UI.input('start_time', '開始時間', { type: 'time', value: a.start_time })}
      ${UI.select('plan_id', '方案', [['', '不指定方案']].concat((App.meta.plans || []).map(p => [p.id, p.name])), { value: a.plan_id || '' })}
      ${UI.select('topic_id', '主題', [['', '不指定主題']], { value: a.topic_id || '' })}
      ${UI.select('type', '晤談類型', App.enumOptions('appt_type'), { value: a.type })}
      ${UI.select('mode', '形式', App.enumOptions('appt_mode'), { value: a.mode })}
      ${UI.select('room_id', '諮商室',
    [['', '自動指派'], ['none', '不到所（線上視訊）']].concat((App.meta.rooms || []).map(r => [r.id, r.name])),
    { value: a.mode === 'online' ? 'none' : (a.room_id || '') })}
      ${UI.input('fee', '個案應付金額', { type: 'number', value: a.fee !== undefined ? a.fee : (App.meta.default_fee || 2000) })}
      <div class="form-row full" id="quota-hint" style="display:none"></div>
      ${UI.select('package_id', '扣抵方案', [['', '不扣抵（單次收費）']].concat(packages.map(p => [p.id, `${p.name}（剩 ${p.remaining} 次）`])), { value: a.package_id || '' })}
      <div class="form-row full" id="mu-row" style="${a.mode === 'online' ? '' : 'display:none'}">
        <label>視訊連結</label>
        <input name="meeting_url" value="${UI.esc(a.meeting_url || '')}" placeholder="https://meet.google.com/xxx-xxxx-xxx">
        <div style="font-size:12.5px;color:var(--muted);margin-top:4px">
          貼上會議室連結即可；晤談提醒會自動附上，個案於專區也看得到。</div>
      </div>
      ${UI.textarea('note', '備註', { value: a.note || '' })}
      <div class="form-row full"><label>可預約時段參考</label><div id="slot-hint" style="font-size:13px;color:var(--muted)">選擇心理師與日期後顯示</div></div>
    </div>`,
    onOpen: el => {
      const refresh = async () => {
        const cid = el.querySelector('[name=counselor_id]').value;
        const date = el.querySelector('[name=date]').value;
        const hint = el.querySelector('#slot-hint');
        if (!cid || !date) return;
        hint.textContent = '查詢中...';
        try {
          const slots = await GET(`/slots?counselor_id=${cid}&date=${date}`);
          hint.innerHTML = slots.length
            ? slots.map(s => `<button class="btn tiny secondary" type="button" data-slot="${s.start_time}" style="margin:2px">${s.start_time}</button>`).join('')
            : '該日無開放時段（仍可直接指定時間）';
          hint.querySelectorAll('[data-slot]').forEach(b => {
            b.onclick = () => { el.querySelector('[name=start_time]').value = b.dataset.slot; };
          });
        } catch { hint.textContent = ''; }
      };
      // 方案 → 主題連動；同時即時試算金額並檢查額度（個案年度次數、心理師週人次）
      const planSel = el.querySelector('[name=plan_id]');
      const topicSel = el.querySelector('[name=topic_id]');
      const hintBox = el.querySelector('#quota-hint');
      const fillTopics = keep => {
        const plan = (App.meta.plans || []).find(p => String(p.id) === String(planSel.value));
        const topics = plan ? plan.topics : [];
        topicSel.innerHTML = ['<option value="">不指定主題</option>']
          .concat(topics.map(t => `<option value="${t.id}"${String(t.id) === String(keep) ? ' selected' : ''}>${UI.esc(t.name)}</option>`)).join('');
        if (plan && plan.appt_type) el.querySelector('[name=type]').value = plan.appt_type;
      };
      const quote = async () => {
        const q = new URLSearchParams({
          plan_id: planSel.value, topic_id: topicSel.value,
          counselor_id: el.querySelector('[name=counselor_id]').value,
          client_id: el.querySelector('[name=client_id]').value,
          date: el.querySelector('[name=date]').value,
          ...(a.id ? { appointment_id: a.id } : {})
        });
        if (!planSel.value) { hintBox.style.display = 'none'; return; }
        try {
          const r = await GET('/plan-quote?' + q.toString());
          el.querySelector('[name=fee]').value = r.fee;
          const parts = [];
          if (r.subsidy_amount) {
            parts.push(`個案只付 <strong>${UI.fmtMoney(r.client_pay)}</strong>`
              + `（方案總額 ${UI.fmtMoney(r.total)}，其中方案給付 ${UI.fmtMoney(r.subsidy_amount)}）`);
          }
          if (r.usage) parts.push(`此個案 ${r.usage.year} 年已用 <strong>${r.usage.used}/${r.usage.quota}</strong> 次`);
          if (r.load && r.load.week_limit) parts.push(`該心理師本週此方案 <strong>${r.load.week_used}/${r.load.week_limit}</strong> 人次`);
          const errs = (r.errors || []).map(e => `<div style="color:var(--danger)">✕ ${UI.esc(e)}</div>`).join('');
          const warns = (r.warnings || []).map(w => `<div style="color:var(--warn,#b8860b)">！${UI.esc(w)}</div>`).join('');
          const next = r.next_week
            ? `<div style="margin-top:4px">改約下週（${r.next_week.week_start} 起）尚餘 ${r.next_week.remaining ?? '不限'} 人次
                 <button class="btn tiny secondary" type="button" id="jump-next">改到下週</button></div>`
            : '';
          hintBox.style.display = '';
          hintBox.innerHTML = `<div style="font-size:13px;line-height:1.8;background:var(--primary-light);padding:10px;border-radius:8px">
            ${parts.join('　')}${errs}${warns}${next}</div>`;
          const jump = hintBox.querySelector('#jump-next');
          if (jump) jump.onclick = () => {
            const d = el.querySelector('[name=date]');
            d.value = UI.addDays(d.value, 7);
            refresh(); quote();
          };
        } catch { hintBox.style.display = 'none'; }
      };
      planSel.onchange = () => { fillTopics(); quote(); };
      topicSel.onchange = quote;
      el.querySelector('[name=client_id]').addEventListener('change', quote);
      fillTopics(a.topic_id);
      quote();
      el.querySelector('[name=counselor_id]').onchange = () => { refresh(); quote(); };
      el.querySelector('[name=date]').onchange = () => { refresh(); quote(); };
      el.querySelector('[name=client_id]').onchange = async e => {
        const sel = el.querySelector('[name=package_id]');
        const list = e.target.value ? await GET(`/clients/${e.target.value}/active-packages`).catch(() => []) : [];
        sel.innerHTML = ['<option value="">不扣抵（單次收費）</option>']
          .concat(list.map(p => `<option value="${p.id}">${UI.esc(p.name)}（剩 ${p.remaining} 次）</option>`)).join('');
      };
      // 視訊不在所內進行：諮商室固定為「不到所」並鎖住，避免實體個案的空間被排到視訊上；
      // 改回到所時放開，並回到「自動指派」由系統挑一間空的。
      const roomSel = el.querySelector('[name=room_id]');
      const syncRoom = mode => {
        if (mode === 'online') { roomSel.value = 'none'; roomSel.disabled = true; }
        else { if (roomSel.value === 'none') roomSel.value = ''; roomSel.disabled = false; }
      };
      syncRoom(el.querySelector('[name=mode]').value);
      el.querySelector('[name=mode]').onchange = e => {
        el.querySelector('#mu-row').style.display = e.target.value === 'online' ? '' : 'none';
        syncRoom(e.target.value);
      };
      el.querySelector('[name=type]').onchange = e => {
        el.querySelector('[name=fee]').value = e.target.value === 'intake' ? (App.meta.intake_fee || 2500) : (App.meta.default_fee || 2000);
      };
      refresh();
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      // 選「不到所」＝不佔任何空間；欄位被鎖住時 formData 收不到，這裡依形式補回來
      if (data.mode === 'online' || data.room_id === 'none') { data.mode = data.mode || 'online'; data.room_id = ''; }
      const save = () => (isNew ? POST('/appointments', data) : PUT(`/appointments/${a.id}`, data));
      try {
        await save();
      } catch (e) {
        // 方案額度或人次上限擋下時，讓有權限的人確認後仍可排入（會寫進稽核軌跡）
        if (!/已使用|已排滿|限 /.test(e.message)) throw e;
        if (!await UI.confirm(`${e.message}\n\n仍要排入嗎？（此決定會記錄於稽核軌跡）`)) return false;
        data.override = true;
        await save();
      }
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

async function apptStatusDialog(a, onDone) {
  const acts = [
    ['arrived', '報到', 'secondary'],
    ['done', '完成晤談', ''],
    ['no_show', '未到', 'warn'],
    ['cancelled', '取消', 'danger']
  ].filter(x => x[0] !== a.status);
  const m = UI.modal({
    title: `${a.client_name}　${a.date} ${a.start_time}`,
    hideFooter: true,
    body: `<div style="font-size:14px;margin-bottom:12px">
        目前狀態：${stateTag('appt_status', a.status)}　${UI.esc(TW.appt_type[a.type] || '')}　${UI.esc(a.counselor_name || '')}
      </div>
      ${a.cancel_requested_at ? `<div class="notice warn" style="margin-bottom:12px">
        個案於 ${UI.esc(a.cancel_requested_at)} 提出取消申請（距晤談已不足免收費時數）<br>
        事由：${UI.esc(a.cancel_request_reason || '未填寫')}<br>
        <span style="font-size:12.5px">按「取消」不收費；若依所內規定收取費用，請改按「未到」，
        系統會依未到比例開立收費單。</span></div>` : ''}
      <div class="form-row full"><label>取消／未到原因（選填）</label><input id="rsn"${a.cancel_requested_at
    ? ` value="${UI.esc(a.cancel_request_reason || '個案申請取消')}"` : ''}></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        ${acts.map(x => `<button class="btn ${x[2]}" data-st="${x[0]}" type="button">${x[1]}</button>`).join('')}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:12px">
        標記「完成晤談」會依方案扣次或產生收費單；「未到」依系統設定比例計費。
        若把已完成的晤談改回其他狀態，系統會自動退回方案次數並移除尚未收款的收費單。</div>`
  });
  m.body.querySelectorAll('[data-st]').forEach(b => {
    b.onclick = async () => {
      try {
        const r = await POST(`/appointments/${a.id}/status`, { status: b.dataset.st, cancel_reason: m.body.querySelector('#rsn').value.trim() });
        m.close();
        // 已收款的收費單不會自動刪除，需提醒人工處理退費
        if (r.warnings && r.warnings.length) {
          UI.modal({
            title: '狀態已更新，但有需要處理的項目', hideFooter: true,
            body: `<div class="notice warn">${r.warnings.map(w => UI.esc(w)).join('<br>')}</div>
              <div style="font-size:13px;color:var(--muted);margin-top:10px">
                需退還已收款項時，請至「收費與方案」找到該筆收費單按「退費」開立退費單。</div>`
          });
        } else {
          UI.toast('已更新');
        }
        // 取消／未到會空出時段：若候補名單有適合人選，當下就問要不要通知遞補
        if (r.opening && r.opening.candidates && r.opening.candidates.length) {
          const slot = { ...r.opening, counselor_name: a.counselor_name };
          UI.confirm(`此時段釋出後，候補名單有 ${r.opening.candidates.length} 位適合人選，要現在通知遞補嗎？`)
            .then(yes => { if (yes) waitlistCandidateModal(slot); });
        }
        onDone && onDone();
      } catch (e) { UI.err(e); }
    };
  });
}

App.page('schedule', {
  title: '預約排程',
  sub: '週檢視：同一心理師或諮商室時段衝突會即時擋下；下方可設定每週可預約時段與請假',
  help: [
    '<strong>週檢視</strong>：點任一張預約卡可看明細，並做「狀態異動／修改／刪除」。卡片顏色＝預約狀態，對照表在表格上方。',
    '右上「新增預約」排新的一筆；同一心理師或同一諮商室撞時段會直接擋下。',
    '下方「排班設定」用格子刷出每週可預約時段，不在格線上的時間（如 13:15-14:05）用「自訂時段」加，請假也在同一區登錄。',
    '上方下拉可只看某一位心理師。',
  ],
  module: 'schedule',
  async render(el, arg) {
    let start = arg || localStorage.getItem('mc-week') || UI.today();
    // 對齊到週一
    const d = new Date(start + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    localStorage.setItem('mc-week', start);
    const data = await GET(`/schedule/week?start=${start}`);
    const days = Array.from({ length: 7 }, (_, i) => UI.addDays(start, i));
    const filterC = localStorage.getItem('mc-week-counselor') || '';

    const cell = date => {
      const match = cid => !filterC || String(cid) === filterC;
      const offs = (data.time_off || []).filter(o => date >= o.start_date && date <= o.end_date && match(o.counselor_id));
      const groups = (data.group_sessions || []).filter(g => g.date === date && match(g.counselor_id));
      const list = data.appointments
        .filter(a => a.date === date && match(a.counselor_id))
        .sort((x, y) => x.start_time.localeCompare(y.start_time));
      const offHtml = offs.map(o => `<div class="appt-chip off">請假：${UI.esc(o.counselor_name)}
        <span style="font-size:11.5px">${o.all_day ? '全天' : o.start_time + '-' + o.end_time}
        ${o.reason ? '／' + UI.esc(o.reason) : ''}</span></div>`).join('');
      const groupHtml = groups.map(g => `<div class="appt-chip group" data-gs="${g.group_id}">
        <strong>${g.start_time}</strong> ${UI.esc(g.group_name)}<br>
        <span style="font-size:11.5px">團體 ${g.member_count} 人／${UI.esc(g.counselor_name || '')}
        ${g.room_name ? '／' + UI.esc(g.room_name) : ''}</span></div>`).join('');
      // 個案與心理師分行並各自加標籤，避免兩個名字擠在一起看不出誰是誰
      const apptHtml = list.map(a => `<div class="appt-chip ${a.status}" data-appt="${a.id}">
        <strong>${a.start_time}</strong>
        <span class="who who-client">個案</span> ${UI.esc(a.client_name)}
        ${a.risk_level === 'high' ? '⚠' : ''}${a.confirmed_at ? '　✅已確認' : ''}${a.cancel_requested_at ? '　🕓申請取消' : ''}<br>
        <span style="font-size:11.5px"><span class="who who-staff">心理師</span> ${UI.esc(a.counselor_name)}
        ${a.mode === 'online' ? '／視訊' : a.room_name ? '／' + UI.esc(a.room_name) : ''}</span></div>`).join('');
      const all = offHtml + groupHtml + apptHtml;
      return all || '<div style="color:var(--muted);font-size:12.5px">—</div>';
    };

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn secondary small" id="prev">上一週</button>
        <button class="btn secondary small" id="this">本週</button>
        <button class="btn secondary small" id="next">下一週</button>
        <strong style="margin-left:6px">${start} ~ ${UI.addDays(start, 6)}</strong>
        <select id="fc">${App.counselorOptions(true).map(o =>
      `<option value="${o[0]}"${String(o[0]) === filterC ? ' selected' : ''}>${UI.esc(o[1])}</option>`).join('')}</select>
        <div class="spacer"></div>
        <button class="btn" id="add">新增預約</button>
      </div>
      <div class="chip-legend">
        顏色＝預約狀態：
        <span class="appt-chip booked">已預約</span>
        <span class="appt-chip arrived">已報到</span>
        <span class="appt-chip done">已完成</span>
        <span class="appt-chip no_show">未到</span>
        <span class="appt-chip cancelled">已取消</span>
        <span class="appt-chip group">團體</span>
        <span class="appt-chip off">請假</span>
      </div>
      <div class="table-wrap"><table class="list week-table"><thead><tr>
        ${days.map(dt => `<th>${dt.slice(5)}（${UI.weekdayName(dt)}）${dt === UI.today() ? ' ●' : ''}</th>`).join('')}
      </tr></thead><tbody><tr>${days.map(dt => `<td style="vertical-align:top;min-width:150px">${cell(dt)}</td>`).join('')}</tr></tbody></table></div>
      <h3 style="margin:18px 0 8px">排班設定</h3>
      <div id="shift-panel"><div class="empty">載入中...</div></div>`;

    el.querySelector('#prev').onclick = () => App.go('schedule/' + UI.addDays(start, -7));
    el.querySelector('#next').onclick = () => App.go('schedule/' + UI.addDays(start, 7));
    el.querySelector('#this').onclick = () => App.go('schedule/' + UI.today());
    el.querySelector('#fc').onchange = e => { localStorage.setItem('mc-week-counselor', e.target.value); App.go('schedule/' + start); };
    el.querySelector('#add').onclick = () => apptDialog(null, () => App.go('schedule/' + start));
    el.querySelectorAll('[data-gs]').forEach(c => { c.onclick = () => { location.hash = 'group/' + c.dataset.gs; }; });
    el.querySelectorAll('[data-appt]').forEach(c => {
      c.onclick = () => {
        const a = data.appointments.find(x => x.id === Number(c.dataset.appt));
        UI.modal({
          title: '預約明細', hideFooter: true,
          body: `<div class="detail-grid">
            <div><div class="dg-label">個案</div><a href="#client/${a.client_id}">${UI.esc(a.client_name)}（${a.client_code}）</a></div>
            <div><div class="dg-label">時間</div>${a.date} ${a.start_time}-${a.end_time}</div>
            <div><div class="dg-label">心理師</div>${UI.esc(a.counselor_name || '')}</div>
            <div><div class="dg-label">類型</div>${UI.esc(TW.appt_type[a.type] || a.type)}／${UI.esc(TW.appt_mode[a.mode])}</div>
            <div><div class="dg-label">諮商室</div>${UI.esc(a.room_name || '-')}</div>
            <div><div class="dg-label">狀態</div>${stateTag('appt_status', a.status)}</div>
            <div><div class="dg-label">費用</div>${UI.fmtMoney(a.fee)}</div>
            <div><div class="dg-label">來源</div>${UI.esc(TW.source_kind[a.source] || a.source)}</div>
            <div><div class="dg-label">個案確認</div>${a.confirmed_at
    ? UI.tag('已於 LINE 確認前往', 'ok') + `<div style="font-size:12px;color:var(--muted)">${UI.esc(a.confirmed_at.slice(0, 16))}</div>`
    : '<span style="color:var(--muted)">尚未回覆</span>'}</div>
          </div>
          ${a.mode === 'online' && a.meeting_url ? `<div style="margin-top:10px;font-size:14px">
            視訊連結：<a href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">${UI.esc(a.meeting_url)}</a></div>` : ''}
          ${a.note ? `<div style="margin-top:10px;font-size:14px">備註：${UI.nl2br(a.note)}</div>` : ''}
          ${a.plan_register_url || a.plan_signin_url ? `<div class="notice" style="margin-top:10px">
            ${UI.esc(a.plan_name || '本方案')}需另於補助單位系統作業：
            ${a.plan_signin_url ? `<a class="btn tiny" href="${UI.esc(a.plan_signin_url)}" target="_blank" rel="noopener noreferrer">晤談簽到</a>` : ''}
            ${a.plan_register_url ? `<a class="btn tiny secondary" href="${UI.esc(a.plan_register_url)}" target="_blank" rel="noopener noreferrer">個案註冊</a>` : ''}
          </div>` : ''}
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
            ${a.mode === 'online' && a.meeting_url
    ? `<a class="btn" href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">進入視訊</a>` : ''}
            <button class="btn" id="st">狀態異動</button>
            <button class="btn secondary" id="ed">修改</button>
            <button class="btn danger" id="del">刪除</button>
          </div>`,
          onOpen: (body, close) => {
            body.querySelector('#st').onclick = () => { close(); apptStatusDialog(a, () => App.go('schedule/' + start)); };
            body.querySelector('#ed').onclick = () => { close(); apptDialog(a, () => App.go('schedule/' + start)); };
            body.querySelector('#del').onclick = async () => {
              if (!await UI.confirm('確定刪除此預約？')) return;
              try {
                const r = await DEL(`/appointments/${a.id}`);
                close();
                App.go('schedule/' + start);
                if (r && r.opening && r.opening.candidates && r.opening.candidates.length) {
                  const slot = { ...r.opening, counselor_name: a.counselor_name };
                  if (await UI.confirm(`此時段釋出後，候補名單有 ${r.opening.candidates.length} 位適合人選，要現在通知遞補嗎？`)) {
                    waitlistCandidateModal(slot);
                  }
                }
              } catch (e) { UI.err(e); }
            };
          }
        });
      };
    });

    // 排班設定（原「我的排班」獨立頁）併入同一頁，可預約時段與請假只有這一處入口
    renderShiftPanel(el.querySelector('#shift-panel'), null, () => App.go('schedule/' + start));
  }
});

App.page('today', {
  title: '今日看板',
  sub: '報到、完成與未到一鍵處理',
  help: [
    '今天的每一筆晤談依序列出，個案來了按「狀態」改成<strong>已報到</strong>，談完改<strong>已完成</strong>，沒來改<strong>未到</strong>。',
    '改成「已完成」才會產生收費單、扣方案堂數，也才會出現在「待補紀錄」；「未到」依系統設定的比例計費。',
    '上方是今天各諮商室的使用狀況，管理者可在此編輯空間。',
  ],
  module: 'schedule',
  async render(el) {
    const date = UI.today();
    const [list, usage] = await Promise.all([
      GET(`/appointments?date=${date}`),
      GET(`/rooms/usage?date=${date}`).catch(() => null)
    ]);
    // 全所只有 2-3 間，今天哪間空著要一眼看得到（個案端不顯示這份資料）
    const roomCard = usage && usage.rooms.length ? `<div class="card"><h3>今日空間使用
        <span style="font-size:13px;font-weight:400;color:var(--muted)">${usage.rooms.length} 間</span>
        ${App.can('settings') ? '<button class="btn tiny secondary" id="editrooms" style="float:right">管理空間</button>' : ''}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          ${usage.rooms.map(r => `<div style="border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-weight:700">${UI.esc(r.name)}
              <span style="font-size:12px;font-weight:400;color:var(--muted)">
                ${r.capacity > 1 ? `可容納 ${r.capacity} 人　` : ''}今日 ${r.bookings.length} 場</span>
              ${App.can('settings') ? `<button class="btn tiny secondary" data-room="${r.id}" style="float:right">編輯</button>` : ''}</div>
            ${r.bookings.length ? r.bookings.map(b => `<div style="font-size:13px;margin-top:6px">
                <strong>${b.start_time}-${b.end_time}</strong>
                ${b.kind === 'group' ? UI.tag('團體', 'warn') : '<span class="who who-client">個案</span>'} ${UI.esc(b.title)}
                <div style="font-size:12px;color:var(--muted)">
                  <span class="who who-staff">心理師</span> ${UI.esc(b.counselor_name || '')}</div></div>`).join('')
    : '<div style="font-size:13px;color:var(--muted);margin-top:6px">今日整天空著</div>'}
          </div>`).join('')}
        </div>
        ${usage.unassigned.length ? `<div class="notice warn" style="margin-top:10px">
          尚未指定空間的到所晤談：${usage.unassigned.map(u =>
    `${u.start_time} ${UI.esc(u.title)}`).join('、')}　請在預約中指定諮商室。</div>` : ''}
      </div>` : '';
    el.innerHTML = `<div class="toolbar"><strong>${date}（${UI.weekdayName(date)}）</strong>
        <div class="spacer"></div><button class="btn" id="add">新增預約</button></div>
      ${roomCard}
      <div class="kid-grid">${list.length ? list.map(a => `
        <div class="kid-card ${a.status === 'done' ? 'in' : a.status === 'no_show' ? 'leave' : 'out'}">
          <div class="kid-head">
            <div class="kid-avatar">${UI.esc(a.client_name.slice(0, 1))}</div>
            <div><div class="kid-name">${UI.esc(a.client_name)}
              ${a.risk_level === 'high' ? UI.tag('高風險', 'danger') : ''}</div>
              <div class="kid-meta">${a.start_time}-${a.end_time}　${UI.esc(TW.appt_type[a.type] || '')}</div></div>
          </div>
          <div class="kid-status"><span class="who who-staff">心理師</span> ${UI.esc(a.counselor_name || '')}${a.room_name ? '／' + UI.esc(a.room_name) : ''}<br>
            ${stateTag('appt_status', a.status)} ${a.has_note ? UI.tag('已寫紀錄', 'ok') : ''}
            ${a.confirmed_at ? UI.tag('個案已於 LINE 確認', 'ok') : ''}
            ${a.cancel_requested_at ? UI.tag('個案申請取消', 'warn') : ''}</div>
          <div class="kid-actions">
            <button class="btn tiny" data-st="${a.id}">狀態</button>
            <a class="btn tiny secondary" href="#client/${a.client_id}">個案</a>
            ${a.mode === 'online' && a.meeting_url
    ? `<a class="btn tiny" href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">視訊</a>` : ''}
          </div>
        </div>`).join('') : '<div class="empty">今日沒有排定的晤談</div>'}</div>`;
    el.querySelector('#add').onclick = () => apptDialog(null, () => App.go('today'));
    // 空間就地編輯：名稱、容納人數、備註與啟用狀態，改完立刻反映在這張卡片
    if (el.querySelector('#editrooms')) el.querySelector('#editrooms').onclick = () => { location.hash = 'settings'; };
    el.querySelectorAll('[data-room]').forEach(b => {
      const r = usage.rooms.find(x => x.id === Number(b.dataset.room));
      b.onclick = () => UI.modal({
        title: '編輯空間：' + r.name,
        body: `<div class="form-grid">
            ${UI.input('name', '名稱', { value: r.name })}
            ${UI.input('capacity', '容納人數', { type: 'number', value: r.capacity })}
            ${UI.input('note', '備註', { value: r.note || '', full: true })}
            ${UI.checkbox('active', '啟用中（停用後不再被自動指派）', true)}</div>`,
        onSubmit: async e => { await PUT(`/rooms/${r.id}`, UI.formData(e)); UI.toast('已儲存'); App.go('today'); }
      });
    });
    el.querySelectorAll('[data-st]').forEach(b => {
      b.onclick = () => apptStatusDialog(list.find(x => x.id === Number(b.dataset.st)), () => App.go('today'));
    });
  }
});

App.page('notes-pending', {
  title: '待補紀錄與報告',
  sub: '已完成但尚未撰寫的晤談紀錄，以及未完成的衡鑑報告',
  help: [
    '已完成但還沒寫紀錄的晤談會留在這裡，按「撰寫紀錄」直接開紀錄表單。',
    '超過系統設定天數未補的會標紅，代表已逾所內規定的補記期限。',
    '下半部是尚未完成的衡鑑報告，可「撰寫報告」或「繼續編輯」草稿。',
  ],
  module: 'notes',
  async render(el) {
    const [d, rp] = await Promise.all([GET('/notes/pending'), GET('/reports/pending').catch(() => null)]);
    el.innerHTML = `<div class="card">
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
        所內規定應於晤談後 ${d.lock_days} 日內完成紀錄，逾期以紅色標示。</div>
      ${UI.table(['晤談日期', '距今', '個案', '心理師', '類型', ''], d.rows.map(r => `<tr>
        <td>${r.date}</td>
        <td>${r.days_ago > d.lock_days ? `<span style="color:var(--danger);font-weight:700">${r.days_ago} 天</span>` : r.days_ago + ' 天'}</td>
        <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
        <td>${UI.esc(r.counselor_name || '')}</td>
        <td>${UI.esc(TW.appt_type[r.type] || r.type)}</td>
        <td><button class="btn tiny" data-note="${r.id}" data-client="${r.client_id}" data-date="${r.date}">撰寫紀錄</button></td>
      </tr>`), '沒有待補的晤談紀錄')}</div>
      ${rp && (rp.missing.length || rp.drafts.length) ? `<div class="card"><h3>待完成的心理衡鑑報告</h3>
        <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
          已完成心理衡鑑但尚未產出報告，或報告仍為草稿未簽核。衡鑑報告常是轉介單位在等的文件，請儘速完成。</div>
        ${UI.table(['施測日期', '距今', '個案', '心理師', '狀態', ''], [
    ...rp.missing.map(r => `<tr>
            <td>${r.date}</td>
            <td>${r.days_ago > rp.lock_days ? `<span style="color:var(--danger);font-weight:700">${r.days_ago} 天</span>` : r.days_ago + ' 天'}</td>
            <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
            <td>${UI.esc(r.counselor_name || '')}</td>
            <td>${UI.tag('尚未撰寫', 'warn')}</td>
            <td><button class="btn tiny" data-nr="${r.client_id}" data-date="${r.date}">撰寫報告</button></td></tr>`),
    ...rp.drafts.map(r => `<tr>
            <td>${r.test_date}</td>
            <td>${r.days_ago > rp.lock_days ? `<span style="color:var(--danger);font-weight:700">${r.days_ago} 天</span>` : r.days_ago + ' 天'}</td>
            <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
            <td>${UI.esc(r.counselor_name || '')}</td>
            <td>${UI.tag('草稿未簽核', 'warn')}</td>
            <td><button class="btn tiny secondary" data-er="${r.id}" data-client="${r.client_id}">繼續編輯</button></td></tr>`)
  ])}</div>` : ''}`;
    el.querySelectorAll('[data-note]').forEach(b => {
      b.onclick = () => noteDialog({
        client_id: Number(b.dataset.client), appointment_id: Number(b.dataset.note), date: b.dataset.date
      }, () => App.go('notes-pending'));
    });
    el.querySelectorAll('[data-nr]').forEach(b => {
      b.onclick = () => reportDialog({ client_id: Number(b.dataset.nr), test_date: b.dataset.date }, () => App.go('notes-pending'));
    });
    el.querySelectorAll('[data-er]').forEach(b => {
      b.onclick = () => reportDialog({ id: Number(b.dataset.er), client_id: Number(b.dataset.client) }, () => App.go('notes-pending'));
    });
  }
});
