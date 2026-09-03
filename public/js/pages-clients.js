// 個案管理：清單、個案總覽（分頁）、晤談紀錄、處遇計畫、同意書

async function clientDialog(c, onDone) {
  const isNew = !c;
  const d = c || { status: 'intake', risk_level: 'low', gender: 'female', intake_date: UI.today(), counselor_id: App.me.id };
  UI.modal({
    title: isNew ? '新增個案' : '編輯個案資料',
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('name', '姓名', { value: d.name || '', required: true })}
      ${UI.input('id_no', '身分證統一編號／居留證號', { value: d.id_no || '', placeholder: '通報與補助核銷用' })}
      ${UI.select('gender', '性別', App.enumOptions('gender'), { value: d.gender })}
      ${UI.input('birth_date', '出生日期', { type: 'date', value: d.birth_date || '' })}
      ${UI.input('phone', '手機（個案端登入帳號）', { value: d.phone || '' })}
      ${UI.input('email', 'Email', { value: d.email || '' })}
      ${UI.input('occupation', '職業／就讀學校', { value: d.occupation || '' })}
      ${UI.input('education', '教育程度', { value: d.education || '' })}
      ${UI.inputList('source', '轉介來源', App.meta.source_options || [], { value: d.source || '' })}
      ${UI.input('referrer', '轉介單位／人', { value: d.referrer || '' })}
      ${UI.input('school', '就讀學校（兒少）', { value: d.school || '' })}
      ${UI.input('grade', '年級', { value: d.grade || '' })}
      ${UI.select('assign_type', '指定／派案（年報表類別代碼用）',
    [['', '未註記'], ['designated', '指定案'], ['assigned', '派案']], { value: d.assign_type || '' })}
      ${UI.select('partner_id', '合作單位（費用由單位支付時填）', [['', '無（自費）']].concat((App.meta.partners || []).map(p => [p.id, p.name])), { value: d.partner_id || '' })}
      ${UI.select('counselor_id', '主責心理師', [['', '未指定']].concat(App.counselorOptions()), { value: d.counselor_id || '' })}
      ${UI.select('status', '狀態', App.enumOptions('client_status'), { value: d.status })}
      ${UI.select('risk_level', '風險等級', App.enumOptions('risk_level'), { value: d.risk_level })}
      ${UI.input('intake_date', '初談日期', { type: 'date', value: d.intake_date || '' })}
      ${UI.input('address', '通訊地址', { value: d.address || '', full: true })}
      ${UI.textarea('main_issue', '主訴問題', { value: d.main_issue || '' })}
      ${UI.textarea('history', '過往就醫／諮商史、用藥', { value: d.history || '' })}
      <div class="form-row full"><label style="font-weight:600;color:var(--text)">未成年／受監護</label></div>
      ${UI.checkbox('is_minor', '本個案為未成年人或受監護宣告，需法定代理人同意', d.is_minor)}
      <div class="form-row full" id="minorHint" style="display:none;font-size:12.5px;color:var(--warn)"></div>
      ${UI.input('guardian_name', '法定代理人', { value: d.guardian_name || '' })}
      ${UI.input('guardian_relationship', '關係', { value: d.guardian_relationship || '' })}
      ${UI.input('guardian_phone', '聯絡電話', { value: d.guardian_phone || '' })}
      <div class="form-row full"><label style="font-weight:600;color:var(--text)">緊急聯絡人</label></div>
      ${UI.input('emergency_name', '姓名', { value: d.emergency_name || '' })}
      ${UI.input('emergency_relationship', '關係', { value: d.emergency_relationship || '' })}
      ${UI.input('emergency_phone', '電話', { value: d.emergency_phone || '' })}
      ${UI.textarea('note', '備註', { value: d.note || '' })}
    </div>`,
    // 依生日自動勾選未成年（民法成年年齡 18 歲），避免漏勾而跳過法定代理人同意書
    onOpen: el => {
      const bd = el.querySelector('[name=birth_date]');
      const minor = el.querySelector('[name=is_minor]');
      const hint = el.querySelector('#minorHint');
      const adultAge = Number((App.meta && App.meta.adult_age) || 18);
      const sync = () => {
        if (!bd.value) { hint.style.display = 'none'; return; }
        const age = UI.ageYears(bd.value);
        if (age === null) { hint.style.display = 'none'; return; }
        if (age < adultAge) {
          minor.checked = true;
          hint.textContent = `依出生日期計算為 ${age} 歲，未滿 ${adultAge} 歲，已自動勾選並需法定代理人同意書。`;
          hint.style.display = '';
        } else {
          hint.textContent = `依出生日期計算為 ${age} 歲。若為受監護宣告者請自行勾選上方選項。`;
          hint.style.display = '';
        }
      };
      bd.onchange = sync;
      sync();
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) {
        const r = await POST('/clients', data);
        UI.toast(`已建立，個案編號 ${r.code}`);
        if (r.warning) UI.toast(r.warning);
      } else {
        const r = await PUT(`/clients/${d.id}`, data);
        UI.toast(r && r.warning ? r.warning : '已儲存');
      }
      onDone && onDone();
    }
  });
}

// 重複個案：舊資料匯入常讓同一個人有兩個以上案號，排約時挑不到人、統計也會被拆開。
// 這裡列出疑似重複的群組與各自的資料量，讓櫃檯判斷要保留哪一個，另一個停用或永久刪除。
function duplicatesDialog(onDone) {
  UI.modal({
    title: '疑似重複的個案', wide: true, hideFooter: true,
    body: '<div id="dup-body"><div class="empty">檢查中...</div></div>',
    onOpen: async (body, close) => {
      const box = body.querySelector('#dup-body');
      let d;
      try { d = await GET('/clients/duplicates'); } catch (e) { box.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!d.groups.length) { box.innerHTML = '<div class="empty">沒有發現重複的個案</div>'; return; }
      box.innerHTML = `<div style="font-size:13px;color:var(--muted);line-height:1.8;margin-bottom:10px">
          共 ${d.total} 組。判斷方式：<strong>保留有預約與紀錄的那一筆</strong>，另一筆若完全沒有資料可永久刪除，
          有資料則建議停用（資料仍保留）。停用後就不會再出現在排約的個案清單裡。</div>
        ${d.groups.map(g => `<div class="card" style="margin-bottom:10px"><h3 style="font-size:15px">
          ${UI.esc(g.key)}　<span style="font-size:12.5px;font-weight:400;color:var(--muted)">${g.kind}／${g.clients.length} 筆</span></h3>
          ${UI.table(['編號', '姓名', '手機', '生日', '主責', '預約', '紀錄', '收費', '最近預約', ''],
    g.clients.map(c => `<tr>
            <td>${UI.esc(c.code)}</td>
            <td><a href="#client/${c.id}">${UI.esc(c.name)}</a></td>
            <td>${UI.esc(c.phone || '-')}</td>
            <td>${UI.esc(c.birth_date || '-')}</td>
            <td>${UI.esc(c.counselor_name || '-')}</td>
            <td>${c.appointments}</td><td>${c.notes}</td><td>${c.invoices}</td>
            <td>${UI.esc(c.last_appointment || '-')}</td>
            <td style="white-space:nowrap">
              <button class="btn tiny secondary" data-off="${c.id}">停用</button>
              ${!c.appointments && !c.notes && !c.invoices
    ? `<button class="btn tiny danger" data-purge="${c.id}">永久刪除</button>` : ''}</td></tr>`))}
        </div>`).join('')}`;
      box.querySelectorAll('[data-off]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('停用這筆個案？資料保留，但不再出現在排約清單。')) return;
          try { await DEL(`/clients/${b.dataset.off}`); UI.toast('已停用'); close(); onDone && onDone(); }
          catch (e) { UI.err(e); }
        };
      });
      box.querySelectorAll('[data-purge]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('這筆沒有任何預約與紀錄，確定永久刪除？')) return;
          try { await DEL(`/clients/${b.dataset.purge}/purge`); UI.toast('已刪除'); close(); onDone && onDone(); }
          catch (e) { UI.err(e); }
        };
      });
    }
  });
}

App.page('clients', {
  title: '個案管理',
  sub: '個案基本資料與服務狀態；晤談紀錄僅主責心理師、督導與管理者可讀',
  help: [
    '個案清單，可搜尋姓名／編號／電話，並依狀態、主責心理師篩選。點「編輯」改基本資料。',
    '點個案姓名進「個案總覽」，晤談紀錄、處遇計畫、量表、附件、同意書都在那裡。',
    '不再服務的個案請用「停用」保留紀錄；「永久刪除」僅管理者可用，且無法復原。',
  ],
  module: 'clients',
  async render(el) {
    // 個案上千筆時整包送到瀏覽器會明顯拖慢，改成一次一頁
    const PAGE_SIZE = 100;
    let page = 1;
    const draw = async () => {
      const q = el.querySelector('#q') ? el.querySelector('#q').value.trim() : '';
      const st = el.querySelector('#st') ? el.querySelector('#st').value : '';
      const cs = el.querySelector('#cs') ? el.querySelector('#cs').value : '';
      const r = await GET(`/clients?q=${encodeURIComponent(q)}&status=${st}&counselor_id=${cs}&page=${page}&limit=${PAGE_SIZE}`);
      const list = r.rows;
      const pages = Math.max(Math.ceil(r.total / PAGE_SIZE), 1);
      const rows = list.map(c => `<tr>
        <td>${UI.esc(c.code)}</td>
        <td><a href="#client/${c.id}"><strong>${UI.esc(c.name)}</strong></a>
          ${c.is_minor ? UI.tag('未成年') : ''}</td>
        <td>${c.age !== null ? c.age + ' 歲' : '-'}／${UI.esc(TW.gender[c.gender] || '')}</td>
        <td>${UI.esc(c.counselor_name || '未指定')}</td>
        <td>${stateTag('client_status', c.status)}</td>
        <td>${stateTag('risk_level', c.risk_level)}</td>
        <td>${c.last_session || '-'}</td>
        <td>${c.next_session || '-'}</td>
        <td>${UI.esc(c.phone || '')}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn tiny secondary" data-ed="${c.id}">編輯</button>
          <a class="btn tiny secondary" href="#client/${c.id}">詳情</a>
          ${App.me.role === 'admin' ? `<button class="btn tiny danger" data-del="${c.id}">刪除</button>` : ''}</td></tr>`);
      el.querySelector('#list').innerHTML = UI.table(
        ['編號', '姓名', '年齡／性別', '主責心理師', '狀態', '風險', '最近晤談', '下次預約', '聯絡電話', ''],
        rows, '沒有符合條件的個案')
        + (r.total > PAGE_SIZE ? `<div class="pager">
            <button class="btn tiny secondary" id="pprev"${page <= 1 ? ' disabled' : ''}>上一頁</button>
            <span>第 ${page} / ${pages} 頁，共 ${r.total} 位</span>
            <button class="btn tiny secondary" id="pnext"${page >= pages ? ' disabled' : ''}>下一頁</button>
          </div>` : `<div class="pager"><span>共 ${r.total} 位</span></div>`);
      const prev = el.querySelector('#pprev'), next = el.querySelector('#pnext');
      if (prev) prev.onclick = () => { page -= 1; draw(); };
      if (next) next.onclick = () => { page += 1; draw(); };
      // 基本資料就地編輯，不必先點進個案詳情頁
      el.querySelectorAll('[data-ed]').forEach(b => {
        b.onclick = async () => clientDialog(await GET(`/clients/${b.dataset.ed}`), draw);
      });
      // 兩種刪法：正式個案用「停用」保留歷史；展示或誤建的資料才永久刪除（僅管理者）
      el.querySelectorAll('[data-del]').forEach(b => {
        const c = list.find(x => x.id === Number(b.dataset.del));
        b.onclick = () => UI.modal({
          title: `刪除個案：${c.name}（${c.code}）`,
          hideFooter: true,
          body: `<div style="font-size:14px;line-height:1.9">請選擇處理方式：</div>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
              <button class="btn secondary" id="soft" type="button">停用（建議）</button>
              <div style="font-size:12.5px;color:var(--muted);margin-top:-6px">
                個案標記為結案並取消未來預約，晤談紀錄、收費與收據全部保留，日後查得到。</div>
              <button class="btn danger" id="hard" type="button">永久刪除</button>
              <div style="font-size:12.5px;color:var(--muted);margin-top:-6px">
                連同預約、晤談紀錄、收費、收據、量表與附件一併移除，<strong>無法復原</strong>。
                僅適合展示資料或重複、誤建的資料。</div>
            </div>`,
          onOpen: (body, close) => {
            body.querySelector('#soft').onclick = async () => {
              const r = await DEL(`/clients/${c.id}`);
              UI.toast(`已停用${r.cancelled_appointments ? `，取消 ${r.cancelled_appointments} 筆未來預約` : ''}`);
              close(); draw();
            };
            body.querySelector('#hard').onclick = async () => {
              close();
              if (!await UI.confirm(`確定永久刪除「${c.name}（${c.code}）」及其所有紀錄？此動作無法復原。`)) return;
              const r = await DEL(`/clients/${c.id}/purge`);
              const n = r.removed || {};
              UI.toast(`已刪除 ${r.name}（預約 ${n.appointments || 0}、紀錄 ${n.session_notes || 0}、收費 ${n.invoices || 0}）`);
              draw();
            };
          }
        });
      });
    };
    el.innerHTML = `<div class="toolbar">
        <input id="q" placeholder="搜尋姓名／編號／電話">
        <select id="st"><option value="">全部狀態</option>${App.enumOptions('client_status').map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>
        <select id="cs">${App.counselorOptions(true).map(o => `<option value="${o[0]}">${UI.esc(o[1])}</option>`).join('')}</select>
        <div class="spacer"></div>
        <button class="btn secondary" id="dup">找重複個案</button>
        <button class="btn" id="add">新增個案</button>
      </div><div id="list"></div>`;
    el.querySelector('#add').onclick = () => clientDialog(null, draw);
    el.querySelector('#dup').onclick = () => duplicatesDialog(draw);
    const redraw = () => { page = 1; draw(); };
    el.querySelector('#q').oninput = () => { clearTimeout(el._t); el._t = setTimeout(redraw, 300); };
    el.querySelector('#st').onchange = redraw;
    el.querySelector('#cs').onchange = redraw;
    await draw();
  }
});

// ---- 晤談紀錄表單 ----
async function noteDialog(seed, onDone) {
  const note = seed.id ? await GET(`/notes/${seed.id}`) : null;
  const n = note || { date: seed.date || UI.today(), risk_flag: 'none', duration_min: App.meta.session_minutes || 50 };
  const readonly = note && note.locked;
  // 實習心理師的紀錄要經指定督導覆核才定稿；送出覆核期間不可修改
  const pending = note && note.review_status === 'pending';
  const returned = note && note.review_status === 'returned';
  const canReview = note && pending && note.counselor_id !== App.me.id
    && (App.me.role === 'admin' || App.me.role === 'supervisor' || App.me.is_supervisor);
  const field = (name, label, value, ph) => readonly
    ? `<div class="form-row full"><label>${label}</label><div style="white-space:pre-wrap;font-size:14px;padding:8px;background:#f7f9fa;border-radius:8px;min-height:32px">${UI.esc(value || '—')}</div></div>`
    : UI.textarea(name, label, { value: value || '', placeholder: ph });
  UI.modal({
    title: readonly ? '晤談紀錄（已簽核，不可修改）'
      : pending ? '晤談紀錄（待督導覆核）' : (note ? '編輯晤談紀錄' : '撰寫晤談紀錄'),
    wide: true,
    hideFooter: readonly || pending,
    submitText: '儲存草稿',
    body: `<div class="form-grid">
      ${UI.input('date', '晤談日期', { type: 'date', value: n.date })}
      ${UI.input('session_no', '第幾次晤談', { type: 'number', value: n.session_no || '' })}
      ${UI.input('duration_min', '晤談時間（分鐘）', { type: 'number', value: n.duration_min })}
      ${UI.select('risk_flag', '風險標記', App.enumOptions('risk_flag'), { value: n.risk_flag })}
      ${field('subjective', 'S 主觀陳述（個案怎麼說）', n.subjective, '個案自述的困擾、事件與感受')}
      ${field('objective', 'O 客觀觀察（外觀、情緒、行為）', n.objective, '出席狀況、情緒表現、非語言訊息')}
      ${field('assessment', 'A 評估與個案概念化', n.assessment, '症狀變化、動力理解、風險評估結論')}
      ${field('plan', 'P 後續計畫', n.plan, '下次方向、需追蹤事項、轉介考量')}
      ${field('intervention', '使用技術／取向', n.intervention, '例：認知重建、空椅法、暴露練習')}
      ${field('homework', '家庭作業', n.homework, '')}
      ${field('risk_note', '風險評估說明（標記非「無」時必填）', n.risk_note, '意念頻率、有無計畫與方法、保護因子、安全計畫')}
    </div>
    ${returned ? `<div class="notice warn" style="margin-top:12px">
      督導於 ${UI.esc(note.reviewed_at)} 退回補正：<br>${UI.esc(note.review_comment)}
      <div style="font-size:12.5px;margin-top:6px">修改儲存後請再按一次「送督導覆核」。</div></div>` : ''}
    ${pending ? `<div class="notice" style="margin-top:12px">
      已於 ${UI.esc(note.submitted_at)} 送出督導覆核，覆核通過後才會定稿；此期間不可修改。
      如需修改請請督導退回補正。</div>
      ${canReview ? `<div style="margin-top:12px">
        <div class="form-row full"><label>覆核意見（退回時必填）</label><textarea id="rvc" style="min-height:70px"></textarea></div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="rv-ok" type="button">覆核通過並定稿</button>
          <button class="btn warn" id="rv-back" type="button">退回補正</button>
        </div></div>` : ''}` : ''}
    ${readonly ? `<div style="margin-top:12px;font-size:13px;color:var(--muted)">簽核時間：${UI.esc(note.signed_at)}　撰寫者：${UI.esc(note.counselor_name || '')}
      ${note.review_status === 'approved' ? `<br>督導覆核：${UI.esc(note.reviewed_at)}${note.review_comment ? '　意見：' + UI.esc(note.review_comment) : ''}` : ''}</div>` : `
    <div style="margin-top:12px;font-size:12.5px;color:var(--muted)">
      ${App.me.is_intern
    ? '儲存後仍可修改；按「送督導覆核」後由指定督導確認，覆核通過才定稿，定稿後不可再更動。'
    : '儲存後仍可修改；按「簽核定稿」後比照病歷不可再更動。'}</div>
    ${note ? `<div style="margin-top:10px"><button class="btn warn" id="sign" type="button">${App.me.is_intern ? '送督導覆核' : '簽核定稿'}</button></div>` : ''}`}`,
    onOpen: (el, close) => {
      const sign = el.querySelector('#sign');
      if (sign) sign.onclick = async () => {
        const msg = App.me.is_intern
          ? '送出後在督導覆核前不可修改，確定送出？'
          : '簽核後此紀錄將無法再修改，確定？';
        if (!await UI.confirm(msg)) return;
        try {
          await PUT(`/notes/${note.id}`, UI.formData(el));
          const r = await POST(`/notes/${note.id}/sign`, {});
          UI.toast(r.message || '已簽核定稿');
          close();
          onDone && onDone();
        } catch (e) { UI.err(e); }
      };
      // 督導覆核：通過即定稿，退回需填意見
      const doReview = async (action) => {
        const comment = (el.querySelector('#rvc') || {}).value || '';
        if (action === 'return' && !comment.trim()) { UI.toast('退回補正請填寫意見', true); return; }
        if (action === 'approve' && !await UI.confirm('覆核通過後紀錄即定稿，不可再修改，確定？')) return;
        try {
          await POST(`/notes/${note.id}/review`, { action, comment });
          UI.toast(action === 'approve' ? '已覆核通過並定稿' : '已退回補正');
          close();
          onDone && onDone();
        } catch (e) { UI.err(e); }
      };
      const ok = el.querySelector('#rv-ok'), back = el.querySelector('#rv-back');
      if (ok) ok.onclick = () => doReview('approve');
      if (back) back.onclick = () => doReview('return');
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      if (data.risk_flag !== 'none' && !data.risk_note) throw new Error('已標記風險，請填寫風險評估說明');
      if (note) await PUT(`/notes/${note.id}`, data);
      else await POST('/notes', { ...data, client_id: seed.client_id, appointment_id: seed.appointment_id || null });
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

// ---- 處遇計畫表單 ----
function planDialog(clientId, plan, onDone) {
  const p = plan || { start_date: UI.today(), status: 'active', goals: [] };
  const goalRow = g => `<div class="goal-row" style="display:grid;grid-template-columns:2fr 1.5fr 90px 32px;gap:6px;margin-bottom:6px">
    <input class="g-content" placeholder="目標內容" value="${UI.esc(g ? g.content : '')}">
    <input class="g-indicator" placeholder="評估指標" value="${UI.esc(g ? g.indicator : '')}">
    <input class="g-progress" type="number" min="0" max="100" placeholder="進度%" value="${g ? g.progress : 0}">
    <button class="btn tiny danger g-del" type="button">×</button></div>`;
  UI.modal({
    title: plan ? '編輯處遇計畫' : '新增處遇計畫',
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('start_date', '計畫起始日', { type: 'date', value: p.start_date })}
      ${UI.input('review_date', '預定檢視日', { type: 'date', value: p.review_date || '' })}
      ${UI.inputList('approach', '治療取向', App.meta.approach_options || [], { value: p.approach || '' })}
      ${UI.input('planned_sessions', '預計次數', { type: 'number', value: p.planned_sessions || '' })}
      ${plan ? UI.select('status', '狀態', App.enumOptions('plan_status'), { value: p.status }) : ''}
      ${UI.textarea('summary', '個案概念化摘要', { value: p.summary || '' })}
      <div class="form-row full"><label>處遇目標</label><div id="goals">${(p.goals || []).map(goalRow).join('') || goalRow(null)}</div>
        <button class="btn tiny secondary" id="add-goal" type="button" style="align-self:flex-start;margin-top:4px">新增一列</button></div>
    </div>`,
    onOpen: el => {
      const box = el.querySelector('#goals');
      const bind = () => box.querySelectorAll('.g-del').forEach(b => {
        b.onclick = () => { if (box.children.length > 1) b.closest('.goal-row').remove(); };
      });
      el.querySelector('#add-goal').onclick = () => { box.insertAdjacentHTML('beforeend', goalRow(null)); bind(); };
      bind();
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      data.goals = [...el.querySelectorAll('.goal-row')].map(r => ({
        content: r.querySelector('.g-content').value.trim(),
        indicator: r.querySelector('.g-indicator').value.trim(),
        progress: Number(r.querySelector('.g-progress').value) || 0
      })).filter(g => g.content);
      if (plan) await PUT(`/plans/${plan.id}`, data);
      else await POST('/plans', { ...data, client_id: clientId });
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

// ---- 同意書簽署 ----
async function consentDialog(clientId, key, isMinorDoc, onDone) {
  const { template, signed } = await GET(`/clients/${clientId}/consents/${key}`);
  UI.modal({
    title: template.title,
    wide: true,
    submitText: signed ? '重新簽署' : '確認簽署',
    body: `<div style="white-space:pre-wrap;font-size:14px;line-height:1.75;max-height:40vh;overflow:auto;
        padding:12px;background:#f7f9fa;border-radius:8px">${UI.esc(template.body)}</div>
      <div class="form-grid" style="margin-top:14px">
        ${template.allow_decline ? UI.select('agreed', '意願', [[1, '同意'], [0, '不同意']], { value: 1 }) : ''}
        ${UI.input('signer_name', '簽署人姓名', { required: true })}
        ${UI.select('signer_role', '簽署身分', App.enumOptions('signer_role'), { value: isMinorDoc ? 'guardian' : 'client' })}
      </div>
      <div class="form-row full" style="margin-top:10px"><label>簽名</label>
        <canvas id="sig" style="border:1px dashed var(--border);border-radius:8px;height:150px;background:#fff;touch-action:none"></canvas>
        <button class="btn tiny secondary" id="clr" type="button" style="align-self:flex-start;margin-top:6px">清除簽名</button></div>
      ${signed ? `<div style="margin-top:10px;font-size:13px;color:var(--muted)">
        已於 ${UI.esc(signed.signed_at)} 由 ${UI.esc(signed.signer_name)} 簽署（版本 ${signed.version}）</div>` : ''}`,
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
      await POST(`/clients/${clientId}/consents`, {
        key, agreed: d.agreed === undefined ? 1 : Number(d.agreed),
        signer_name: d.signer_name, signer_role: d.signer_role, signature: sig
      });
      UI.toast('已完成簽署');
      onDone && onDone();
    }
  });
}

// ---- 個案總覽 ----
App.page('client', {
  title: '個案總覽',
  sub: '',
  help: [
    '上方按鈕是這位個案的常用動作：編輯資料、新增預約、撰寫晤談紀錄、登錄危機事件。',
    '下方分頁依序是晤談紀錄、處遇計畫、量表、附件、危機事件與同意書。',
    '晤談紀錄僅主責心理師、督導與管理者可讀；實習生的紀錄要送督導覆核才定稿。',
  ],
  module: 'clients',
  async render(el, id) {
    if (!id) return App.go('clients');
    const c = await GET(`/clients/${id}`);
    document.querySelector('.page-title').textContent = `${c.name}（${c.code}）`;
    document.querySelector('.page-sub').innerHTML =
      `${TW.client_status[c.status]}　主責：${UI.esc(c.counselor_name || '未指定')}　風險：${TW.risk_level[c.risk_level]}`
      + (c.age_group ? `　分層：${{ child: '兒童', teen: '青少年', adult: '成人' }[c.age_group]}${
        c.age !== null && c.age !== undefined ? `（${c.age} 歲）` : ''}` : '') +
      (c.can_view_notes ? '' : '　（您無此個案的晤談紀錄存取權）');

    const head = document.createElement('div');
    head.innerHTML = `<div class="toolbar">
      <button class="btn small" id="edit">編輯資料</button>
      <button class="btn small secondary" id="book">新增預約</button>
      ${c.can_view_notes && App.can('notes') ? '<button class="btn small secondary" id="newnote">撰寫晤談紀錄</button>' : ''}
      ${App.can('risk') ? '<button class="btn small warn" id="risk">登錄危機事件</button>' : ''}
      <div class="spacer"></div>
      ${c.unpaid ? UI.tag('未收款 ' + UI.fmtMoney(c.unpaid), 'warn') : ''}
      ${c.pending_consents.length ? UI.tag('待簽同意書 ' + c.pending_consents.length, 'danger') : ''}
      <button class="btn small danger" id="deact">停用個案</button>
    </div>
    ${(c.plan_links || []).map(p => `<div class="notice" style="margin-bottom:10px">
      ${UI.esc(p.name)}需另於補助單位系統作業：
      ${p.signin_url ? `<a class="btn tiny" href="${UI.esc(p.signin_url)}" target="_blank" rel="noopener noreferrer">晤談簽到</a>` : ''}
      ${p.register_url ? `<a class="btn tiny secondary" href="${UI.esc(p.register_url)}" target="_blank" rel="noopener noreferrer">個案註冊</a>` : ''}
    </div>`).join('')}`;
    el.innerHTML = '';
    el.appendChild(head);
    head.querySelector('#edit').onclick = () => clientDialog(c, () => App.go('client/' + id));
    head.querySelector('#book').onclick = () => apptDialog({ client_id: c.id, counselor_id: c.counselor_id || App.me.id, date: UI.today(), start_time: '14:00', type: c.status === 'intake' ? 'intake' : 'individual', mode: 'onsite' }, () => App.go('client/' + id));
    if (head.querySelector('#newnote')) head.querySelector('#newnote').onclick = () => noteDialog({ client_id: c.id }, () => App.go('client/' + id));
    if (head.querySelector('#risk')) head.querySelector('#risk').onclick = () => riskDialog({ client_id: c.id }, () => App.go('client/' + id));
    head.querySelector('#deact').onclick = async () => {
      // 心理紀錄不做實體刪除：停用後轉為結案並自清單隱藏，歷史資料仍保留供查閱與稽核
      if (!await UI.confirm(`確定停用「${c.name}」？個案將轉為結案並自清單隱藏，未來的預約會一併取消，既有晤談紀錄仍會保留。`)) return;
      const r = await DEL(`/clients/${c.id}`);
      UI.toast(r.cancelled_appointments ? `已停用個案，並取消 ${r.cancelled_appointments} 筆未來預約` : '已停用個案');
      App.go('clients');
    };

    const tabsEl = document.createElement('div');
    el.appendChild(tabsEl);
    const tabs = [
      { key: 'profile', label: '基本資料' },
      { key: 'appointments', label: '晤談歷程' }
    ];
    if (c.can_view_notes && App.can('notes')) tabs.push({ key: 'notes', label: '晤談紀錄' });
    if (c.can_view_notes && App.can('plans')) tabs.push({ key: 'plans', label: '處遇計畫' });
    if (c.can_view_notes && App.can('notes')) tabs.push({ key: 'reports', label: '衡鑑報告' });
    if (App.can('assessments')) tabs.push({ key: 'assessments', label: '心理量表' });
    if (App.can('risk') && !App.hidden('risk')) tabs.push({ key: 'risk', label: '危機事件' });
    // 安全計畫保密層級同晤談紀錄，故一併以 can_view_notes 判斷
    if (App.can('risk') && c.can_view_notes && !App.hidden('safety')) tabs.push({ key: 'safety', label: '安全計畫' });
    if (c.can_view_notes && App.can('notes')) tabs.push({ key: 'aftercare', label: '轉介與追蹤' });
    if (App.can('consents')) tabs.push({ key: 'consents', label: '同意書' });
    if (App.can('billing')) tabs.push({ key: 'billing', label: '費用與方案' });
    tabs.push({ key: 'files', label: '附件' });
    tabs.push({ key: 'summary', label: '結案摘要' });

    UI.tabs(tabsEl, tabs, async (key, body) => {
      if (key === 'profile') {
        const g = (l, v) => `<div><div class="dg-label">${l}</div>${UI.esc(v || '-')}</div>`;
        body.innerHTML = `<div class="card"><h3>基本資料</h3><div class="detail-grid">
            ${g('個案編號', c.code)}${g('姓名', c.name)}${g('身分證統一編號', c.id_no)}${g('性別', TW.gender[c.gender])}
            ${g('出生日期', c.birth_date)}${g('年齡', c.age !== null ? c.age + ' 歲' : '')}
            ${g('手機', c.phone)}${g('Email', c.email)}${g('職業／就學', c.occupation)}${g('教育程度', c.education)}
            ${g('地址', c.address)}${g('轉介來源', c.source)}${g('轉介單位／人', c.referrer)}
            ${g('合作單位', c.partner_name)}${g('初談日期', c.intake_date)}
            ${g('結案日期', c.close_date)}${g('結案原因', c.close_reason)}
            ${c.groups.length ? g('參與團體', c.groups.map(x => x.name).join('、')) : ''}
          </div></div>
          <div class="card"><h3>臨床摘要</h3><div style="font-size:14px;line-height:1.8">
            <strong>主訴：</strong>${UI.nl2br(c.main_issue) || '—'}<br>
            <strong>過往史：</strong>${UI.nl2br(c.history) || '—'}<br>
            <strong>備註：</strong>${UI.nl2br(c.note) || '—'}</div></div>
          <div class="card"><h3>聯絡人</h3><div class="detail-grid">
            ${c.is_minor ? g('法定代理人', `${c.guardian_name}（${c.guardian_relationship}）${c.guardian_phone}`) : ''}
            ${g('緊急聯絡人', `${c.emergency_name}（${c.emergency_relationship}）${c.emergency_phone}`)}
          </div>
          <div style="margin-top:12px"><button class="btn small secondary" id="rst">重設個案端密碼</button></div></div>`;
        body.querySelector('#rst').onclick = async () => {
          if (!await UI.confirm('將個案端密碼重設為手機末 6 碼？')) return;
          try { const r = await POST(`/clients/${c.id}/reset-password`, {}); UI.toast('已重設為 ' + r.password); }
          catch (e) { UI.err(e); }
        };
      }

      if (key === 'appointments') {
        body.innerHTML = `<div class="card">${UI.table(['日期', '時間', '類型', '心理師', '狀態', '費用', '紀錄'],
          c.appointments.map(a => `<tr><td>${a.date}</td><td>${a.start_time}</td>
            <td>${UI.esc(TW.appt_type[a.type] || a.type)}</td><td>${UI.esc(a.counselor_name || '')}</td>
            <td>${stateTag('appt_status', a.status)}</td><td>${UI.fmtMoney(a.fee)}</td>
            <td>${a.cancel_reason ? UI.esc(a.cancel_reason) : ''}</td></tr>`), '尚無晤談紀錄')}</div>`;
      }

      if (key === 'notes') {
        const notes = await GET(`/clients/${c.id}/notes`);
        body.innerHTML = `<div class="card">
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
            每次調閱皆記入稽核軌跡。紀錄簽核後不可修改。</div>
          ${UI.table(['次數', '日期', '心理師', '風險', '狀態', ''], notes.map(n => `<tr>
            <td>第 ${n.session_no} 次</td><td>${n.date}</td><td>${UI.esc(n.counselor_name || '')}</td>
            <td>${stateTag('risk_flag', n.risk_flag)}</td>
            <td>${n.locked ? UI.tag(n.review_status === 'approved' ? '已覆核定稿' : '已簽核', 'ok')
    : n.review_status === 'pending' ? UI.tag('待督導覆核', 'warn')
      : n.review_status === 'returned' ? UI.tag('退回補正', 'danger') : UI.tag('草稿', 'warn')}</td>
            <td><button class="btn tiny secondary" data-n="${n.id}">${n.locked ? '檢視' : n.review_status === 'pending' ? '覆核／檢視' : '編輯'}</button></td></tr>`), '尚無晤談紀錄')}</div>`;
        body.querySelectorAll('[data-n]').forEach(b => {
          b.onclick = () => noteDialog({ id: Number(b.dataset.n), client_id: c.id }, () => tabsRefresh('notes'));
        });
      }

      if (key === 'safety') {
        await safetyPlanTab(c, body, () => tabsRefresh('safety'));
      }

      if (key === 'aftercare') {
        await aftercareTab(c, body, () => tabsRefresh('aftercare'));
      }

      if (key === 'plans') {
        const plans = await GET(`/clients/${c.id}/plans`);
        // 目標進度旁附上量表趨勢，檢視處遇成效時不必再切分頁
        const [ptrend, pscales] = App.can('assessments')
          ? await Promise.all([GET(`/clients/${c.id}/assessment-trend`).catch(() => ({})), GET('/scales').catch(() => ({}))])
          : [{}, {}];
        const trendCards = Object.entries(ptrend).filter(([, rows]) => rows.length > 1)
          .map(([scale, rows]) => `<div class="card"><h3>${scale} 分數變化　${UI.esc(SCALE_NAMES[scale] || '')}</h3>
            ${UI.trendChart(rows, (pscales[scale] && pscales[scale].cuts) || [])}</div>`).join('');
        body.innerHTML = `<div class="toolbar"><div class="spacer"></div><button class="btn small" id="np">新增計畫</button></div>
          ${plans.length ? plans.map(p => `<div class="card"><h3>${p.start_date} 起　${UI.esc(p.approach || '未填取向')}
              ${UI.tag(TW.plan_status[p.status] || p.status, p.status === 'active' ? 'primary' : '')}</h3>
            <div class="detail-grid" style="margin-bottom:10px">
              <div><div class="dg-label">心理師</div>${UI.esc(p.counselor_name || '')}</div>
              <div><div class="dg-label">預計次數</div>${p.planned_sessions || '-'}</div>
              <div><div class="dg-label">預定檢視日</div>${p.review_date || '-'}</div>
            </div>
            <div style="font-size:14px;margin-bottom:10px">${UI.nl2br(p.summary)}</div>
            ${p.goals.map(g => `<div style="margin-bottom:8px">
              <div style="font-size:14px">${UI.esc(g.content)}
                <span style="color:var(--muted);font-size:12.5px">${g.indicator ? '（指標：' + UI.esc(g.indicator) + '）' : ''}</span></div>
              <div style="background:#eef2f5;border-radius:6px;height:9px;margin-top:4px">
                <div style="width:${Math.min(100, g.progress)}%;background:var(--primary);height:9px;border-radius:6px"></div></div>
              <div style="font-size:12px;color:var(--muted)">進度 ${g.progress}%</div></div>`).join('')}
            <button class="btn tiny secondary" data-p="${p.id}" style="margin-top:8px">編輯</button></div>`).join('')
      : '<div class="empty">尚未建立處遇計畫</div>'}
          ${trendCards}`;
        body.querySelector('#np').onclick = () => planDialog(c.id, null, () => tabsRefresh('plans'));
        body.querySelectorAll('[data-p]').forEach(b => {
          b.onclick = () => planDialog(c.id, plans.find(p => p.id === Number(b.dataset.p)), () => tabsRefresh('plans'));
        });
      }

      if (key === 'reports') {
        await renderReportTab(c, body, () => tabsRefresh('reports'));
      }

      if (key === 'assessments') {
        const [trend, scaleDefs] = await Promise.all([
          GET(`/clients/${c.id}/assessment-trend`),
          GET('/scales').catch(() => ({}))
        ]);
        body.innerHTML = `<div class="toolbar"><div class="spacer"></div>
            <button class="btn small secondary" id="assign">指派量表</button>
            <button class="btn small" id="fill">代填量表</button></div>
          ${Object.keys(trend).length ? Object.entries(trend).map(([scale, rows]) => `<div class="card">
            <h3>${scale}　${UI.esc(SCALE_NAMES[scale] || '')}</h3>
            ${UI.trendChart(rows, (scaleDefs[scale] && scaleDefs[scale].cuts) || [])}
            ${rows.length > 1 ? `<div style="font-size:12.5px;color:var(--muted);margin:2px 0 10px">
              虛線為判讀切分點；紅點表示命中危險題。趨勢僅供療效參考，仍須併同臨床評估。</div>` : ''}
            ${UI.table(['日期', '總分', '判讀', '填寫者', ''], rows.slice().reverse().map(r => `<tr>
              <td>${r.date}</td><td><strong>${r.total}</strong></td>
              <td>${r.alert ? UI.tag(r.severity, 'danger') : UI.esc(r.severity)}</td>
              <td>${r.filled_by === 'client' ? '個案自填' : '所內登錄'}</td>
              <td><button class="btn tiny danger" data-da="${r.id}">刪除</button></td></tr>`))}
            ${rows.length > 1 ? `<div style="font-size:13px;color:var(--muted);margin-top:8px">
              首測 ${rows[0].total} 分 → 最近 ${rows[rows.length - 1].total} 分
              （${rows[rows.length - 1].total < rows[0].total ? '下降' : rows[rows.length - 1].total > rows[0].total ? '上升' : '持平'}
              ${Math.abs(rows[rows.length - 1].total - rows[0].total)} 分）</div>` : ''}
          </div>`).join('') : '<div class="empty">尚無量表紀錄</div>'}`;
        body.querySelector('#fill').onclick = () => scaleFillDialog(c.id, () => tabsRefresh('assessments'));
        body.querySelectorAll('[data-da]').forEach(b => {
          b.onclick = async () => {
            if (!await UI.confirm('刪除此筆量表結果？（誤填時使用，刪除後不可復原）')) return;
            await DEL(`/assessments/${b.dataset.da}`);
            UI.toast('已刪除');
            tabsRefresh('assessments');
          };
        });
        body.querySelector('#assign').onclick = () => UI.modal({
          title: '指派量表給個案填寫',
          body: `<div class="form-grid">
            ${UI.select('scale', '量表', Object.entries(SCALE_NAMES))}
            ${UI.input('due_date', '填寫期限', { type: 'date', value: UI.addDays(UI.today(), 7) })}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:10px">個案登入個案專區後會看到待填提醒。</div>`,
          onSubmit: async e => { await POST('/assessment-tasks', { ...UI.formData(e), client_id: c.id }); UI.toast('已指派'); }
        });
      }

      if (key === 'files') {
        const files = await GET(`/clients/${c.id}/attachments`);
        body.innerHTML = `<div class="toolbar"><div class="spacer"></div>
            <button class="btn small" id="up">上傳附件</button></div>
          <div class="card">${UI.table(['檔名', '類別', '大小', '開放個案端', '上傳者', '上傳時間', ''],
    files.map(f => `<tr>
              <td><a href="#" data-dl="${f.id}"><strong>${UI.esc(f.filename)}</strong></a>
                ${f.note ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(f.note) + '</span>' : ''}</td>
              <td>${UI.esc(f.kind)}</td>
              <td>${UI.fmtSize(f.size)}</td>
              <td>${f.visible_to_client ? UI.tag('已開放', 'ok') : '否'}</td>
              <td>${UI.esc(f.uploader_name || '')}</td>
              <td>${f.created_at.slice(0, 16)}</td>
              <td style="white-space:nowrap">
                ${UI.isPreviewable(f.mime) ? `<button class="btn tiny secondary" data-pv="${f.id}">預覽</button>` : ''}
                <button class="btn tiny secondary" data-ed="${f.id}">編輯</button>
                <button class="btn tiny danger" data-df="${f.id}">刪除</button></td></tr>`),
    '尚無附件')}
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              可存放轉介單、診斷證明、同意書掃描檔與衡鑑報告。單檔上限 20 MB，
              支援 PDF、圖片與 Office 檔。附件屬個案資料，下載行為會記入稽核軌跡。</div></div>`;

        body.querySelector('#up').onclick = () => UI.modal({
          title: '上傳附件',
          body: `<div class="form-grid">
              <div class="form-row full"><label>檔案 *</label>
                <input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.txt"></div>
              ${UI.select('kind', '類別', (App.meta.attachment_kinds || ['轉介單', '診斷證明', '其他']).map(k => [k, k]))}
              ${UI.input('note', '說明', { full: true })}
              ${UI.checkbox('visible_to_client', '開放個案端下載此檔案', false)}
            </div>`,
          onSubmit: async el2 => {
            const input = el2.querySelector('[name=file]');
            if (!input.files.length) throw new Error('請選擇檔案');
            const fd = new FormData();
            fd.append('file', input.files[0]);
            fd.append('kind', el2.querySelector('[name=kind]').value);
            fd.append('note', el2.querySelector('[name=note]').value);
            fd.append('visible_to_client', el2.querySelector('[name=visible_to_client]').checked ? '1' : '0');
            await POST(`/clients/${c.id}/attachments`, fd);
            UI.toast('已上傳');
            tabsRefresh('files');
          }
        });
        // 下載與預覽都經 API 驗權，故直接開連結而非組 uploads 路徑
        body.querySelectorAll('[data-dl]').forEach(b => {
          b.onclick = e2 => { e2.preventDefault(); window.location.href = `/api/attachments/${b.dataset.dl}/download`; };
        });
        body.querySelectorAll('[data-pv]').forEach(b => {
          b.onclick = () => window.open(`/api/attachments/${b.dataset.pv}/download?inline=1`, '_blank');
        });
        body.querySelectorAll('[data-ed]').forEach(b => {
          const f = files.find(x => x.id === Number(b.dataset.ed));
          b.onclick = () => UI.modal({
            title: '附件資訊',
            body: `<div class="form-grid">
                ${UI.select('kind', '類別', (App.meta.attachment_kinds || ['轉介單', '診斷證明', '其他']).map(k => [k, k]), { value: f.kind })}
                ${UI.input('note', '說明', { value: f.note, full: true })}
                ${UI.checkbox('visible_to_client', '開放個案端下載此檔案', f.visible_to_client)}</div>`,
            onSubmit: async el2 => {
              await PUT(`/attachments/${f.id}`, UI.formData(el2));
              UI.toast('已儲存');
              tabsRefresh('files');
            }
          });
        });
        body.querySelectorAll('[data-df]').forEach(b => {
          b.onclick = async () => {
            const f = files.find(x => x.id === Number(b.dataset.df));
            if (!await UI.confirm(`刪除附件「${f.filename}」？檔案將一併從主機移除，無法復原。`)) return;
            await DEL(`/attachments/${f.id}`);
            UI.toast('已刪除');
            tabsRefresh('files');
          };
        });
      }

      if (key === 'risk') {
        body.innerHTML = `<div class="card">${UI.table(['日期', '類型', '嚴重度', '通報', '狀態', ''],
          c.risk_events.map(r => `<tr><td>${r.date}</td><td>${UI.esc(r.type)}</td>
            <td>${UI.tag(TW.severity[r.severity] || r.severity, r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warn' : '')}</td>
            <td>${r.reported ? UI.tag('已通報 ' + UI.esc(r.report_channel), 'ok') : '—'}</td>
            <td>${UI.tag(TW.event_status[r.status], r.status === 'open' ? 'warn' : '')}</td>
            <td><button class="btn tiny secondary" data-r="${r.id}">檢視</button></td></tr>`), '無危機事件紀錄')}</div>`;
        body.querySelectorAll('[data-r]').forEach(b => {
          b.onclick = () => riskDialog(c.risk_events.find(r => r.id === Number(b.dataset.r)), () => App.go('client/' + id));
        });
      }

      if (key === 'consents') {
        const templates = await GET('/consent-templates');
        const fits = t => {
          const a = t.audience || '';
          if (!a || !c.age_group) return true;
          if (a === 'minor') return c.age_group === 'child' || c.age_group === 'teen';
          return a === c.age_group;
        };
        // 全部都畫出來，不適用這位個案的先隱藏；勾「顯示全部」就地顯示，不必重新載入整頁
        const list = templates.filter(t => !t.minor_only || c.is_minor);
        body.innerHTML = `<div class="card">${UI.table(['同意書', '版本', '狀態', '簽署人', '簽署時間', ''],
          list.map(t => {
            const s = c.consents.find(x => x.key === t.key && x.version === t.version);
            return `<tr data-fit="${fits(t) ? 1 : 0}"${fits(t) ? '' : ' style="display:none"'}>
              <td>${UI.esc(t.title)}${t.required ? ' *' : ''}</td><td>v${t.version}</td>
              <td>${s ? (s.agreed ? UI.tag('已同意', 'ok') : UI.tag('不同意', 'warn')) : UI.tag('未簽署', 'danger')}</td>
              <td>${s ? UI.esc(s.signer_name) + '（' + (TW.signer_role[s.signer_role] || '') + '）' : '-'}</td>
              <td>${s ? UI.esc(s.signed_at) : '-'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny" data-c="${t.key}" data-minor="${t.minor_only}">${s ? '重新簽署' : '簽署'}</button>
                ${s ? `<button class="btn tiny secondary" data-cp="${s.id}">列印</button>
                      <button class="btn tiny secondary" data-cw="${s.id}">Word</button>`
    : `<button class="btn tiny secondary" data-bp="${t.key}">列印空白</button>`}</td></tr>`;
          }))}
          <label style="display:block;margin-top:8px;font-size:13px">
            <input type="checkbox" id="allconsents"> 顯示全部同意書（預設只列出適用${
  { child: '兒童', teen: '青少年', adult: '成人' }[c.age_group] || '這位個案'}的）</label>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">標示 * 為必要同意書；範本內容修改後版本會遞增，需重新簽署。</div></div>`;
        const allBox = body.querySelector('#allconsents');
        if (allBox) {
          allBox.onchange = () => {
            body.querySelectorAll('tr[data-fit="0"]').forEach(tr => {
              tr.style.display = allBox.checked ? '' : 'none';
            });
          };
        }
        body.querySelectorAll('[data-c]').forEach(b => {
          b.onclick = () => consentDialog(c.id, b.dataset.c, b.dataset.minor === '1', () => App.go('client/' + id));
        });
        // 紙本流程：未簽的印空白兩聯給個案當場簽，已簽的可印出含簽名的存檔版或匯出 Word
        body.querySelectorAll('[data-bp]').forEach(b => {
          b.onclick = () => window.open(`/api/consent-templates/${b.dataset.bp}/print`, '_blank');
        });
        body.querySelectorAll('[data-cp]').forEach(b => {
          b.onclick = () => window.open(`/api/consents/${b.dataset.cp}/print`, '_blank');
        });
        body.querySelectorAll('[data-cw]').forEach(b => {
          b.onclick = () => { location.href = `/api/consents/${b.dataset.cw}/print?format=doc`; };
        });
      }

      if (key === 'billing') {
        body.innerHTML = `<div class="card"><h3>方案</h3>
            ${UI.table(['方案', '總次數', '已用', '剩餘', '金額', '到期', '狀態'], c.packages.map(p => `<tr>
              <td>${UI.esc(p.name)}</td><td>${p.sessions_total}</td><td>${p.sessions_used}</td>
              <td><strong>${p.sessions_total - p.sessions_used}</strong></td><td>${UI.fmtMoney(p.amount)}</td>
              <td>${p.expire_date || '-'}</td><td>${UI.tag(TW.pkg_status[p.status] || p.status, p.status === 'active' ? 'ok' : '')}</td></tr>`), '無方案')}
          </div>
          <div class="card"><h3>收費紀錄</h3>
            ${UI.table(['日期', '項目', '金額', '付款人別', '狀態', '收據號'], c.invoices.map(i => `<tr>
              <td>${i.date}</td><td>${UI.esc(i.item)}</td><td>${UI.fmtMoney(i.amount)}</td>
              <td>${UI.esc(i.payer)}</td><td>${stateTag('inv_status', i.status)}</td>
              <td>${UI.esc(i.receipt_no || '-')}</td></tr>`), '無收費紀錄')}</div>`;
      }

      if (key === 'summary') {
        const s = await GET(`/clients/${c.id}/summary`);
        body.innerHTML = `<div class="card"><h3>結案摘要（可列印）</h3>
          <div style="font-size:14px;line-height:1.9">
            <strong>${UI.esc(s.center_name)}　個案服務摘要</strong><br>
            個案編號：${UI.esc(s.client.code)}（依保密原則，對外文件以編號代替姓名）<br>
            服務期間：${s.first_date || s.client.intake_date || '-'} 至 ${s.last_date || '-'}，共完成 ${s.sessions} 次晤談<br>
            主訴：${UI.esc(s.client.main_issue) || '-'}<br>
            ${s.client.close_date ? `結案日：${s.client.close_date}（${UI.esc(s.client.close_reason)}）<br>` : ''}
          </div>
          ${s.plan ? `<div style="margin-top:12px"><strong>處遇計畫（${UI.esc(s.plan.approach)}）</strong>
            <div style="font-size:14px">${UI.nl2br(s.plan.summary)}</div>
            <ul style="margin:8px 0 0 20px;font-size:14px">${s.plan.goals.map(g =>
          `<li>${UI.esc(g.content)}　達成度 ${g.progress}%</li>`).join('')}</ul></div>` : ''}
          ${s.scales.length ? `<div style="margin-top:12px"><strong>量表變化</strong>
            ${UI.table(['量表', '首測', '末測', '判讀變化'], s.scales.map(x => `<tr><td>${x.scale}</td>
              <td>${x.first_total}（${UI.esc(x.first_severity)}）</td>
              <td>${x.last_total}（${UI.esc(x.last_severity)}）</td>
              <td>${x.last_total < x.first_total ? '改善' : x.last_total > x.first_total ? '惡化' : '持平'}</td></tr>`))}</div>` : ''}
          ${s.risk_events.length ? `<div style="margin-top:12px"><strong>危機事件</strong>
            ${UI.table(['日期', '類型', '嚴重度', '狀態'], s.risk_events.map(r => `<tr><td>${r.date}</td>
              <td>${UI.esc(r.type)}</td><td>${TW.severity[r.severity]}</td><td>${TW.event_status[r.status]}</td></tr>`))}</div>` : ''}
          <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button></div>`;
      }
    });
    // 分頁內操作完成後重載該分頁
    window.tabsRefresh = k => App.go('client/' + id);
  }
});

// 量表名稱對照（前端顯示用；題目由 /scales 取得）
const SCALE_NAMES = {
  PHQ9: 'PHQ-9 憂鬱症篩檢',
  GAD7: 'GAD-7 廣泛性焦慮',
  BSRS5: 'BSRS-5 心情溫度計',
  PSS10: 'PSS-10 知覺壓力',
  WHO5: 'WHO-5 幸福指標',
  ISI: 'ISI 失眠嚴重度'
};
