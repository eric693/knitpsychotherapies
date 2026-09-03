// 量表、危機事件、督導、收費、訊息、公告、報表、帳號與系統設定

let SCALES_CACHE = null;
async function loadScales() {
  if (!SCALES_CACHE) SCALES_CACHE = await GET('/scales');
  return SCALES_CACHE;
}

// 代填量表：逐題作答，送出後立即顯示分數與判讀
async function scaleFillDialog(clientId, onDone) {
  const scales = await loadScales();
  const clients = clientId ? null : await App.clientOptions(true);
  const render = key => {
    const s = scales[key];
    return `<div style="font-size:13.5px;color:var(--muted);margin-bottom:10px">${UI.esc(s.intro)}</div>
      ${s.items.map((q, i) => `<div class="check-item">
        <div class="ci-text">${i + 1}. ${UI.esc(q)}</div>
        <select class="ans" data-i="${i}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px">
          ${s.options.map(o => `<option value="${o[0]}">${UI.esc(o[1])}</option>`).join('')}
        </select></div>`).join('')}
      <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
        判讀切分點：${s.cuts.map(c => `${c[0]}-${c[1]} ${c[2]}`).join('　')}
        ${s.alertNote ? `<br><span style="color:var(--danger)">${UI.esc(s.alertNote)}</span>` : ''}</div>`;
  };
  UI.modal({
    title: '填寫量表',
    wide: true,
    submitText: '計分並儲存',
    body: `<div class="form-grid">
        ${clients ? UI.select('client_id', '個案', clients, { full: true }) : ''}
        ${UI.select('scale', '量表', Object.entries(scales).map(([k, v]) => [k, v.name]))}
        ${UI.input('date', '施測日期', { type: 'date', value: UI.today() })}
      </div>
      <div id="items" style="margin-top:14px"></div>`,
    onOpen: el => {
      const draw = () => { el.querySelector('#items').innerHTML = render(el.querySelector('[name=scale]').value); };
      el.querySelector('[name=scale]').onchange = draw;
      draw();
    },
    onSubmit: async el => {
      const d = UI.formData(el);
      const answers = [...el.querySelectorAll('.ans')].map(s => Number(s.value));
      const r = await POST('/assessments', {
        client_id: clientId || d.client_id, scale: d.scale, date: d.date, answers
      });
      UI.toast(`總分 ${r.total}（${r.severity}）`);
      if (r.alert) {
        UI.modal({
          title: '風險警示', hideFooter: true,
          body: `<div style="font-size:15px;line-height:1.8;color:var(--danger)">
            此份量表命中危險題，個案風險等級已自動調整為「高」。<br>
            請立即完成風險評估，必要時登錄危機事件並依規定通報。</div>`
        });
      }
      onDone && onDone();
    }
  });
}

App.page('assessments', {
  title: '心理量表',
  sub: '篩檢分數僅供臨床判讀參考，不等同診斷',
  help: [
    '按「填寫量表」由櫃檯或心理師代填；要請個案自己填，到個案總覽的量表頁「指派量表」產生連結。',
    '上方列的是已指派但還沒填的，可「取消」。',
    '分數僅供臨床判讀參考，不等同診斷；超過警戒值會標示風險提醒。',
  ],
  module: 'assessments',
  async render(el) {
    const [rows, tasks] = await Promise.all([GET('/assessments'), GET('/assessment-tasks?pending=1')]);
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div>
        <button class="btn" id="fill">填寫量表</button></div>
      ${tasks.length ? `<div class="card"><h3>待填任務（個案端）</h3>
        ${UI.table(['個案', '量表', '期限', '指派者', ''], tasks.map(t => `<tr>
          <td><a href="#client/${t.client_id}">${UI.esc(t.client_name)}（${t.client_code}）</a></td>
          <td>${UI.esc(SCALE_NAMES[t.scale] || t.scale)}</td>
          <td>${t.due_date || '-'}</td><td>${UI.esc(t.assigner_name || '')}</td>
          <td><button class="btn tiny danger" data-del="${t.id}">取消</button></td></tr>`))}</div>` : ''}
      <div class="card"><h3>最近測驗結果</h3>
        ${UI.table(['日期', '個案', '量表', '總分', '判讀', '填寫者'], rows.map(r => `<tr>
          <td>${r.date}</td><td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}</a></td>
          <td>${UI.esc(SCALE_NAMES[r.scale] || r.scale)}</td><td><strong>${r.total}</strong></td>
          <td>${r.alert ? UI.tag(r.severity, 'danger') : UI.esc(r.severity)}</td>
          <td>${r.filled_by === 'client' ? '個案自填' : '所內登錄'}</td></tr>`), '尚無測驗紀錄')}</div>`;
    el.querySelector('#fill').onclick = () => scaleFillDialog(null, () => App.go('assessments'));
    el.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => { await DEL(`/assessment-tasks/${b.dataset.del}`); App.go('assessments'); };
    });
  }
});

// ---- 危機事件 ----
// 責任通報時限：已通報顯示管道與日期，未通報則顯示剩餘時間，逾時以紅字標示
function reportCell(r) {
  if (r.reported) {
    return UI.tag(UI.esc(r.report_channel) + (r.report_at ? ' ' + r.report_at.slice(0, 10) : ''), 'ok');
  }
  if (r.report_state === 'overdue') {
    return UI.tag('逾時未通報 ' + fmtDuration(-r.minutes_left) + '前到期', 'danger');
  }
  if (r.report_state === 'due') {
    return UI.tag('應通報 剩 ' + fmtDuration(r.minutes_left), 'warn');
  }
  return UI.tag('未通報');
}
function fmtDuration(minutes) {
  const m = Math.max(0, minutes);
  if (m < 60) return m + ' 分';
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小時` : `${Math.floor(h / 24)} 天 ${h % 24} 小時`;
}

function riskDialog(ev, onDone) {
  const isNew = !ev.id;
  const e = ev || {};
  UI.modal({
    title: isNew ? '登錄危機事件' : '危機事件',
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('date', '事件日期', { type: 'date', value: e.date || UI.today() })}
      ${UI.inputList('type', '事件類型', App.meta.risk_types || [], { value: e.type || '' })}
      ${UI.select('severity', '嚴重度', App.enumOptions('severity'), { value: e.severity || 'medium' })}
      ${UI.select('handler_id', '處理者', App.counselorOptions(), { value: e.handler_id || App.me.id })}
      ${UI.textarea('description', '事件描述', { value: e.description || '' })}
      ${UI.textarea('actions', '已採取處置（安全計畫／聯繫緊急聯絡人／轉介急診）', { value: e.actions || '' })}
      ${UI.checkbox('reported', '已依法通報', e.reported)}
      ${UI.inputList('report_channel', '通報管道', App.meta.report_channels || [], { value: e.report_channel || '' })}
      ${UI.input('report_no', '通報案號', { value: e.report_no || '' })}
      ${UI.textarea('follow_up', '後續追蹤', { value: e.follow_up || '' })}
      ${!isNew ? UI.select('status', '狀態', App.enumOptions('event_status'), { value: e.status }) : ''}
    </div>
    ${e.report_due_at && !e.reported ? `<div class="notice ${e.report_state === 'overdue' ? 'danger' : 'warn'}" style="margin-top:10px">
      ${e.report_state === 'overdue'
        ? `此事件應完成通報之期限為 ${e.report_due_at}，已逾時 ${fmtDuration(-e.minutes_left)}，請儘速完成通報並補登案號。`
        : `此事件屬責任通報，應於 ${e.report_due_at} 前完成通報（尚餘 ${fmtDuration(e.minutes_left)}）。`}</div>` : ''}
    <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
      兒少保護、家暴或性侵害等情事應於知悉起 ${App.meta.report_deadline_hours || 24} 小時內通報主管機關。
      建檔時系統會依事件類型自動帶出通報期限，逾時未通報會在清單以紅字警示；本欄位僅供內部留存佐證。</div>`,
    onSubmit: async el => {
      const d = UI.formData(el);
      if (!d.type) throw new Error('請填寫事件類型');
      if (d.reported && !d.report_channel) throw new Error('已通報請填寫通報管道');
      if (isNew) await POST('/risk-events', { ...d, client_id: e.client_id });
      else await PUT(`/risk-events/${e.id}`, d);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('risk', {
  title: '危機事件與通報',
  sub: '自傷風險、兒少保護與家暴等應通報事件的處置與追蹤',
  help: [
    '按右下「登錄事件」記下自傷、兒少保護、家暴等事件；「通報表」可產生可列印的通報書。',
    '處理完按「結案」並填處置結果；已通報的事件不能刪除，只能編輯。',
    '法定通報有時限，逾期未通報的會標紅提醒。',
  ],
  module: 'risk',
  async render(el) {
    const draw = async () => {
      const st = el.querySelector('#st').value;
      const overdue = el.querySelector('[name=overdue]').checked ? '&overdue=1' : '';
      const rows = await GET('/risk-events?status=' + st + overdue);
      el.querySelector('#list').innerHTML = UI.table(
        ['日期', '個案', '類型', '嚴重度', '通報', '處理者', '狀態', ''],
        rows.map(r => `<tr>
          <td>${r.date}</td>
          <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
          <td>${UI.esc(r.type)}</td>
          <td>${UI.tag(TW.severity[r.severity], r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warn' : '')}</td>
          <td>${reportCell(r)}</td>
          <td>${UI.esc(r.handler_name || '')}</td>
          <td>${UI.tag(TW.event_status[r.status], r.status === 'open' ? 'warn' : '')}</td>
          <td style="white-space:nowrap"><button class="btn tiny secondary" data-e="${r.id}">編輯</button>
            <button class="btn tiny secondary" data-form="${r.id}">通報表</button>
            ${r.status === 'open' ? `<button class="btn tiny" data-close="${r.id}">結案</button>` : ''}
            ${r.reported ? '' : `<button class="btn tiny danger" data-rdel="${r.id}">刪除</button>`}</td></tr>`),
        '沒有符合條件的事件');
      el.querySelectorAll('[data-e]').forEach(b => {
        b.onclick = () => riskDialog(rows.find(r => r.id === Number(b.dataset.e)), draw);
      });
      // 誤建的事件可刪；已完成法定通報者不出現此按鈕，通報軌跡必須保留
      el.querySelectorAll('[data-rdel]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除此危機事件？已完成通報的事件無法刪除。')) return;
          try { await DEL(`/risk-events/${b.dataset.rdel}`); UI.toast('已刪除'); draw(); } catch (e) { UI.err(e); }
        };
      });
      // 通報表套印：把個案與事件欄位帶進表格，實際通報仍走主管機關管道
      el.querySelectorAll('[data-form]').forEach(b => {
        b.onclick = () => reportFormPrint(Number(b.dataset.form)).catch(e => UI.err(e));
      });
      el.querySelectorAll('[data-close]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '危機事件結案',
          body: `<div class="form-grid">
            ${UI.textarea('follow_up', '追蹤結果', { placeholder: '個案目前狀態、後續處遇安排' })}
            ${UI.select('risk_level', '結案後個案風險等級', App.enumOptions('risk_level'), { value: 'medium' })}</div>`,
          onSubmit: async e2 => { await POST(`/risk-events/${b.dataset.close}/close`, UI.formData(e2)); UI.toast('已結案'); draw(); }
        });
      });
    };
    el.innerHTML = `<div class="toolbar">
        <select id="st"><option value="open">追蹤中</option><option value="">全部</option><option value="closed">已結案</option></select>
        <label style="display:flex;gap:6px;align-items:center;font-size:14px;white-space:nowrap">
          <input type="checkbox" name="overdue" style="width:auto">只看逾時未通報</label>
        <div class="spacer"></div><button class="btn" id="add">登錄事件</button>
      </div><div id="list"></div>`;
    el.querySelector('#st').onchange = draw;
    el.querySelector('[name=overdue]').onchange = draw;
    el.querySelector('#add').onclick = async () => {
      const clients = await App.clientOptions(true);
      UI.modal({
        title: '選擇個案', body: `<div class="form-grid">${UI.select('client_id', '個案', clients, { full: true })}</div>`,
        submitText: '下一步',
        onSubmit: e2 => {
          const id = Number(UI.formData(e2).client_id);
          if (!id) throw new Error('請選擇個案');
          setTimeout(() => riskDialog({ client_id: id }, draw), 100);
        }
      });
    };
    await draw();
  }
});

// ---- 督導 ----
App.page('supervision', {
  title: '督導紀錄',
  sub: '個督／團督時數與內容，供繼續教育與實習時數佐證',
  help: [
    '登錄個督／團督的時數與內容，供繼續教育與實習時數佐證。',
    '按「新增紀錄」填督導日期、形式、時數與重點；「內容」可回看全文。',
  ],
  module: 'supervision',
  async render(el) {
    const [rows, hours] = await Promise.all([GET('/supervisions'), GET('/supervisions/hours')]);
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div><button class="btn" id="add">新增紀錄</button></div>
      <div class="card"><h3>${hours.year} 年度時數（目標 ${hours.required} 小時）</h3>
        ${UI.table(['心理師', '證照', '個督', '團督', '合計', '達成'], hours.rows.map(r => `<tr>
          <td>${UI.esc(r.name)}</td><td>${UI.esc(r.license_type || '')}</td>
          <td>${r.individual_hours}</td><td>${r.group_hours}</td><td><strong>${r.total_hours}</strong></td>
          <td>${UI.tag(Math.round(r.total_hours / hours.required * 100) + '%', r.total_hours >= hours.required ? 'ok' : 'warn')}</td></tr>`))}</div>
      <div class="card"><h3>督導紀錄</h3>
        ${UI.table(['日期', '受督者', '督導者', '型式', '時數', '個案', ''], rows.map(r => `<tr>
          <td>${r.date}</td><td>${UI.esc(r.counselor_name || '')}</td>
          <td>${UI.esc(r.supervisor_user_name || r.supervisor_name || '')}</td>
          <td>${UI.esc(TW.sup_type[r.type] || r.type)}</td><td>${r.hours}</td>
          <td>${UI.esc(r.client_code || '-')}</td>
          <td><button class="btn tiny secondary" data-v="${r.id}">內容</button>
            <button class="btn tiny danger" data-d="${r.id}">刪除</button></td></tr>`), '尚無督導紀錄')}</div>`;
    el.querySelector('#add').onclick = async () => {
      const clients = await App.clientOptions(true);
      UI.modal({
        title: '新增督導紀錄', wide: true,
        body: `<div class="form-grid">
          ${UI.select('counselor_id', '受督者', App.counselorOptions(), { value: App.me.id })}
          ${UI.select('supervisor_id', '所內督導', [['', '外聘督導']].concat(App.counselorOptions()))}
          ${UI.input('supervisor_name', '外聘督導姓名', { placeholder: '所內督導請留空' })}
          ${UI.input('date', '日期', { type: 'date', value: UI.today() })}
          ${UI.input('hours', '時數', { type: 'number', step: '0.5', value: 1 })}
          ${UI.select('type', '型式', App.enumOptions('sup_type'), { value: 'individual' })}
          ${UI.select('client_id', '討論個案（選填）', clients)}
          ${UI.textarea('content', '討論內容')}
          ${UI.textarea('suggestion', '督導建議')}</div>`,
        onSubmit: async e => { await POST('/supervisions', UI.formData(e)); UI.toast('已儲存'); App.go('supervision'); }
      });
    };
    el.querySelectorAll('[data-v]').forEach(b => {
      b.onclick = () => {
        const r = rows.find(x => x.id === Number(b.dataset.v));
        UI.modal({
          title: `督導紀錄 ${r.date}`, hideFooter: true,
          body: `<div style="font-size:14px;line-height:1.8">
            <strong>討論內容</strong><br>${UI.nl2br(r.content) || '—'}<br><br>
            <strong>督導建議</strong><br>${UI.nl2br(r.suggestion) || '—'}</div>`
        });
      };
    });
    el.querySelectorAll('[data-d]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除此督導紀錄？')) return;
        try { await DEL(`/supervisions/${b.dataset.d}`); App.go('supervision'); } catch (e) { UI.err(e); }
      };
    });
  }
});

// ---- 收費 ----
// 收費單表單：一般自費只需填項目與金額；走政府補助方案或需開立發票時再展開下方欄位。
// 補助額填入後自付差額自動算出，核銷金額與實收金額才不會對不起來。
function invoiceDialog(inv, clients, onDone) {
  const isNew = !inv;
  const i = inv || { date: UI.today(), payer: '自費' };
  const locked = !isNew && i.status === 'paid';
  UI.modal({
    title: isNew ? '新增收費單' : '編輯收費單',
    wide: true,
    body: `<div class="form-grid">
        ${isNew ? UI.select('client_id', '個案', clients, { full: true })
    : `<div class="form-row full"><label>個案</label><div style="padding-top:6px">${UI.esc(i.client_name)}（${UI.esc(i.client_code)}）</div></div>`}
        ${UI.input('date', '日期', { type: 'date', value: i.date })}
        ${UI.input('item', '項目', { value: i.item || '' })}
        ${UI.input('amount', '金額', { type: 'number', value: i.amount || '' })}
        ${UI.select('payer', '付款人別', App.listOptions('payer_types', ['自費']), { value: i.payer })}
        ${locked ? UI.select('method', '付款方式（收錯可在此更正）',
    App.listOptions('pay_methods', ['現金']), { value: i.method || '現金' }) : ''}
      </div>
      ${locked ? '<div class="notice" style="margin-top:10px">此筆已收款，金額不可修改；付款方式、發票與核銷欄位仍可更正補登。</div>' : ''}
      <div class="card" style="margin-top:14px"><h3>政府補助方案（無則留空）</h3>
        <div class="form-grid">
          ${UI.inputList('subsidy_program', '方案名稱', App.meta.subsidy_programs || [], { value: i.subsidy_program || '' })}
          ${UI.input('subsidy_no', '方案序號／個案代碼', { value: i.subsidy_no || '' })}
          ${UI.input('subsidy_amount', '方案補助金額', { type: 'number', value: i.subsidy_amount || '' })}
          <div class="form-row"><label>個案自付差額</label>
            <div id="selfPay" style="padding-top:6px;font-weight:600">${UI.fmtMoney(i.self_pay || 0)}</div></div>
        </div></div>
      <div class="card"><h3>電子發票（僅開立收據者留空）</h3>
        <div class="form-grid">
          ${UI.input('invoice_no', '發票號碼', { value: i.invoice_no || '', placeholder: '例：AB12345678' })}
          ${UI.input('invoice_date', '發票日期', { type: 'date', value: i.invoice_date || '' })}
          ${UI.input('buyer_tax_id', '買受人統一編號', { value: i.buyer_tax_id || '', placeholder: '開立三聯式時填' })}
          ${UI.input('buyer_title', '發票抬頭', { value: i.buyer_title || '' })}
          ${UI.input('carrier', '載具號碼', { value: i.carrier || '', placeholder: '手機條碼／自然人憑證' })}
          ${UI.input('love_code', '捐贈碼', { value: i.love_code || '' })}
        </div></div>
      <div class="form-grid">${UI.textarea('note', '備註', { value: i.note || '' })}</div>`,
    onOpen: el => {
      const amt = el.querySelector('[name=amount]');
      const sub = el.querySelector('[name=subsidy_amount]');
      const out = el.querySelector('#selfPay');
      const sync = () => {
        const a = Number(amt.value) || 0;
        const b = Math.min(Number(sub.value) || 0, a);
        out.textContent = UI.fmtMoney(a - b);
        out.style.color = (Number(sub.value) || 0) > a ? 'var(--danger)' : '';
      };
      amt.oninput = sync; sub.oninput = sync;
      if (locked) amt.readOnly = true;
      sync();
    },
    onSubmit: async el => {
      const d = UI.formData(el);
      if (!d.item) throw new Error('請填寫項目');
      if (Number(d.subsidy_amount || 0) > Number(d.amount || 0)) throw new Error('補助金額不可大於總金額');
      if (d.buyer_tax_id && !/^\d{8}$/.test(d.buyer_tax_id)) throw new Error('買受人統一編號應為 8 碼數字');
      if (isNew) await POST('/invoices', d); else await PUT(`/invoices/${i.id}`, d);
      UI.toast(isNew ? '已新增' : '已儲存');
      onDone && onDone();
    }
  });
}

// 退費紀錄：可依期間查詢，並在誤開時撤銷（撤銷會把原收費單狀態回復為已收款）
function refundListModal(onChange) {
  const from = UI.thisMonth() + '-01';
  const to = UI.today();
  UI.modal({
    title: '退費紀錄',
    wide: true,
    hideFooter: true,
    body: `<div class="toolbar">
        <label style="font-size:13px">期間</label>
        <input type="date" id="rf-from" value="${from}"><span>~</span><input type="date" id="rf-to" value="${to}">
      </div><div id="rf-list"><div class="empty">載入中...</div></div>`,
    onOpen: body => {
      const box = body.querySelector('#rf-list');
      const load = async () => {
        const f = body.querySelector('#rf-from').value, t = body.querySelector('#rf-to').value;
        box.innerHTML = '<div class="empty">載入中...</div>';
        try {
          const d = await GET(`/refunds?from=${f}&to=${t}`);
          box.innerHTML = `<div class="stat-grid"><div class="stat">
              <div class="num danger">${UI.fmtMoney(d.total)}</div><div class="label">期間退費合計</div></div></div>
            ${UI.table(['退費日期', '個案', '原收費單', '金額', '方式', '原因', '經手人', ''], d.rows.map(r => `<tr>
              <td>${r.date}</td>
              <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
              <td>${UI.esc(r.invoice_item || '（已刪除）')}${r.receipt_no ? '<br><span style="font-size:12px;color:var(--muted)">收據 ' + UI.esc(r.receipt_no) + '</span>' : ''}</td>
              <td>${UI.fmtMoney(r.amount)}</td>
              <td>${UI.esc(r.method || '')}</td>
              <td>${UI.esc(r.reason || '')}${r.note ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.note) + '</span>' : ''}</td>
              <td>${UI.esc(r.created_by_name || '')}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(r.created_at.slice(5, 16))}</span></td>
              <td><button class="btn tiny danger" data-rv="${r.id}">撤銷</button></td></tr>`), '此期間沒有退費紀錄')}`;
          box.querySelectorAll('[data-rv]').forEach(b => {
            b.onclick = async () => {
              if (!await UI.confirm('撤銷這筆退費？原收費單會回復為已收款狀態。')) return;
              try { await DEL(`/refunds/${b.dataset.rv}`); UI.toast('已撤銷'); load(); onChange && onChange(); }
              catch (e) { UI.err(e); }
            };
          });
        } catch (e) { box.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; }
      };
      body.querySelector('#rf-from').onchange = load;
      body.querySelector('#rf-to').onchange = load;
      load();
    }
  });
}

App.page('billing', {
  title: '收費管理',
  sub: '晤談完成後自動產生收費單；未到依設定比例計費',
  help: [
    '晤談狀態改成「已完成」時會自動產生收費單，未到則依系統設定的比例計費，通常不必手動新增。',
    '收到錢按「收款」並選付款方式；金額錯了在收款前用「編輯」改，開錯整張用「作廢」。',
    '已收款的可開「收據」或辦「退費」；退費紀錄在右上「退費紀錄」查。',
  ],
  module: 'billing',
  async render(el) {
    const draw = async () => {
      const st = el.querySelector('#st').value;
      const from = el.querySelector('#from').value, to = el.querySelector('#to').value;
      const d = await GET(`/invoices?status=${st}&from=${from}&to=${to}`);
      el.querySelector('#list').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num warn">${UI.fmtMoney(d.total_unpaid)}</div><div class="label">未收款</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.total_paid)}</div><div class="label">已收款</div></div>
          <div class="stat"><div class="num ${d.total_refunded ? 'danger' : ''}">${UI.fmtMoney(d.total_refunded)}</div><div class="label">已退費</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.total_net)}</div><div class="label">實收（收款−退費）</div></div>
        </div>
        ${d.by_method && d.by_method.length ? `<div class="card"><h3>收款方式分項
          <span style="font-size:13px;font-weight:400;color:var(--muted)">（此區間已收款者）</span></h3>
          ${UI.table(['付款方式', '筆數', '收款金額', '其中已退', '淨額'], d.by_method.map(m => `<tr>
            <td>${UI.esc(m.method)}</td><td>${m.n}</td><td>${UI.fmtMoney(m.amt)}</td>
            <td>${m.refunded ? UI.fmtMoney(m.refunded) : '-'}</td>
            <td><strong>${UI.fmtMoney(m.amt - m.refunded)}</strong></td></tr>`))}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            收款當下選錯現金／轉帳時，按該筆的「編輯」即可更正，不必作廢重開。</div></div>` : ''}
        ${UI.table(['日期', '個案', '項目', '金額', '補助／自付', '付款人別', '狀態', '收據號／發票', ''],
          d.rows.map(i => `<tr>
          <td>${i.date}</td><td><a href="#client/${i.client_id}">${UI.esc(i.client_name)}</a></td>
          <td>${UI.esc(i.item)}${i.subsidy_program ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(i.subsidy_program) + (i.subsidy_no ? '／' + UI.esc(i.subsidy_no) : '') + '</span>' : ''}</td>
          <td>${UI.fmtMoney(i.amount)}${i.refunded ? `<br><span style="font-size:12px;color:var(--danger)">已退 ${UI.fmtMoney(i.refunded)}</span>` : ''}</td>
          <td>${i.subsidy_amount ? `補助 ${UI.fmtMoney(i.subsidy_amount)}<br>自付 ${UI.fmtMoney(i.self_pay)}` : '-'}</td>
          <td>${UI.esc(i.payer)}</td>
          <td>${stateTag('inv_status', i.status)}</td>
          <td>${UI.esc(i.receipt_no || '-')}${i.invoice_no ? '<br><span style="font-size:12px;color:var(--muted)">發票 ' + UI.esc(i.invoice_no) + '</span>' : ''}</td>
          <td style="white-space:nowrap">
            ${i.status !== 'void' ? `<button class="btn tiny secondary" data-edit="${i.id}">編輯</button>` : ''}
            ${i.status === 'unpaid' ? `<button class="btn tiny" data-pay="${i.id}">收款</button>
            <button class="btn tiny danger" data-void="${i.id}">作廢</button>`
            : (i.status === 'paid' || i.status === 'refunded') ? `<button class="btn tiny secondary" data-r="${i.id}">收據</button>
            <button class="btn tiny danger" data-refund="${i.id}">退費</button>` : ''}</td></tr>`),
          '沒有符合條件的收費單')}`;
      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = () => invoiceDialog(d.rows.find(x => x.id === Number(b.dataset.edit)), null, draw);
      });
      el.querySelectorAll('[data-r]').forEach(b => {
        b.onclick = async () => {
          const r = await GET(`/invoices/${b.dataset.r}/receipt`);
          UI.modal({
            title: '收據', hideFooter: true,
            body: `<div style="font-size:14px;line-height:2">
                <div style="text-align:center;font-size:18px;font-weight:700;margin-bottom:8px">
                  ${UI.esc(r.center_name)}　收　據</div>
                <div>收據號碼：${UI.esc(r.receipt_no || '-')}</div>
                <div>個案編號：${UI.esc(r.client_code)}　　姓名：${UI.esc(r.client_name)}</div>
                <div>服務項目：${UI.esc(r.item)}</div>
                <div>金額：<strong style="font-size:17px">${UI.fmtMoney(r.amount)}</strong>
                  （付款方式：${UI.esc(r.method || '-')}）</div>
                ${r.subsidy_amount ? `<div>其中方案補助：${UI.fmtMoney(r.subsidy_amount)}　個案自付：${UI.fmtMoney(r.self_pay)}</div>
                <div>補助方案：${UI.esc(r.subsidy_program)}${r.subsidy_no ? '（' + UI.esc(r.subsidy_no) + '）' : ''}</div>` : ''}
                <div>付款人別：${UI.esc(r.payer)}</div>
                <div>收款日期：${UI.esc(r.paid_at || r.date)}</div>
                ${r.invoice_no ? `<div>發票號碼：${UI.esc(r.invoice_no)}${r.invoice_date ? '（' + UI.esc(r.invoice_date) + '）' : ''}
                  ${r.buyer_tax_id ? '　買受人統編：' + UI.esc(r.buyer_tax_id) : ''}</div>` : ''}
                ${r.buyer_title ? `<div>發票抬頭：${UI.esc(r.buyer_title)}</div>` : ''}
                <div style="margin-top:14px;font-size:12.5px;color:var(--muted)">
                  ${UI.esc(r.center_address || '')}　${UI.esc(r.center_phone || '')}
                  ${r.center_tax_id ? '<br>統一編號：' + UI.esc(r.center_tax_id) : ''}
                  ${r.center_license_no ? '<br>開業執照字號：' + UI.esc(r.center_license_no) : ''}
                  ${r.center_director ? '　負責心理師：' + UI.esc(r.center_director) : ''}</div>
                <div style="display:flex;align-items:center;gap:12px;margin-top:22px">
                  <span>收款人：＿＿＿＿＿＿　　（諮商所用印）</span>
                  ${sealHtml(r, 96)}
                  ${stampHtml(r)}</div>
              </div>
              <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
          });
        };
      });
      el.querySelectorAll('[data-pay]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '收款',
          body: `<div class="form-grid">${UI.select('method', '付款方式', App.listOptions('pay_methods', ['現金']), { full: true })}</div>`,
          onSubmit: async e => { await POST(`/invoices/${b.dataset.pay}/pay`, UI.formData(e)); UI.toast('已收款'); draw(); }
        });
      });
      // 退費：不改動原收費單金額，另開退費單勾稽；金額上限為「原收款 − 已退」
      el.querySelectorAll('[data-refund]').forEach(b => {
        b.onclick = async () => {
          const info = await GET(`/invoices/${b.dataset.refund}/refundable`);
          if (info.refundable <= 0) { UI.toast('此筆已全額退費', true); return; }
          UI.modal({
            title: '辦理退費',
            body: `<div class="notice" style="margin-bottom:12px;font-size:13.5px">
                原收費單：${UI.esc(info.invoice.item)}　${UI.fmtMoney(info.invoice.amount)}
                ${info.invoice.receipt_no ? '（收據 ' + UI.esc(info.invoice.receipt_no) + '）' : ''}<br>
                已退 ${UI.fmtMoney(info.refunded)}，本次可退上限 <strong>${UI.fmtMoney(info.refundable)}</strong>
                ${info.package ? `<br>方案「${UI.esc(info.package.name)}」已用 ${info.package.sessions_used}/${info.package.sessions_total} 次，
                  依剩餘堂數試算退費 ${UI.fmtMoney(info.suggest)}` : ''}
              </div>
              <div class="form-grid">
                ${UI.input('date', '退費日期', { type: 'date', value: UI.today() })}
                ${UI.input('amount', '退費金額', { type: 'number', value: info.suggest, min: 1, max: info.refundable, required: true })}
                ${UI.select('method', '退費方式', App.listOptions('pay_methods', ['現金']), { value: info.invoice.method || '' })}
                ${UI.inputList('reason', '退費原因', App.meta.refund_reasons || ['其他'], { full: true })}
                ${info.package ? UI.checkbox('close_package', '同時把此方案標記為已退費（停止扣次）', true) : ''}
                ${UI.textarea('note', '備註', { rows: 2 })}
              </div>
              <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
                退費單會與原收費單勾稽；全額退還時原收費單狀態改為「已退費」，報表以「收款−退費」計算實收。</div>`,
            onSubmit: async e => {
              await POST(`/invoices/${b.dataset.refund}/refund`, UI.formData(e));
              UI.toast('已開立退費單');
              draw();
            }
          });
        };
      });
      el.querySelectorAll('[data-void]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '作廢收費單',
          body: `<div class="form-grid">${UI.input('reason', '作廢原因', { full: true })}</div>`,
          onSubmit: async e => { await POST(`/invoices/${b.dataset.void}/void`, UI.formData(e)); UI.toast('已作廢'); draw(); }
        });
      });
    };
    el.innerHTML = `<div class="toolbar">
        <select id="st"><option value="unpaid">未收款</option><option value="">全部</option>
          <option value="paid">已收款</option><option value="refunded">已退費</option><option value="void">已作廢</option></select>
        <input id="from" type="date"><span>~</span><input id="to" type="date">
        <div class="spacer"></div>
        <button class="btn secondary" id="refunds">退費紀錄</button>
        <button class="btn" id="add">新增收費單</button>
      </div><div id="list"></div>`;
    ['#st', '#from', '#to'].forEach(s => { el.querySelector(s).onchange = draw; });
    el.querySelector('#add').onclick = async () => {
      const clients = await App.clientOptions(true);
      invoiceDialog(null, clients, draw);
    };
    el.querySelector('#refunds').onclick = () => refundListModal(draw);
    await draw();
  }
});

// 逾期未收款與催繳：與晤談提醒共用發送機制（未設定 webhook 時只產生文字供人工發送）
App.page('overdue', {
  title: '逾期催繳',
  sub: '未收款超過設定天數的收費單，可整批產生或發送催繳訊息',
  help: [
    '列出超過設定天數還沒收到錢的收費單。',
    '有 LINE／簡訊通道時按「發送催繳」由系統送出，沒有就「複製訊息」自行傳，再按「記錄已催繳」留痕。',
    '個案當場付款可直接在這裡「收款」。',
  ],
  module: 'billing',
  async render(el) {
    const draw = async () => {
      const days = el.querySelector('#days').value || '';
      const payer = el.querySelector('#payer').value;
      const cid = el.querySelector('#fc2').value;
      const qs = [days ? 'days=' + days : '', payer ? 'payer=' + encodeURIComponent(payer) : '', cid ? 'counselor_id=' + cid : '']
        .filter(Boolean).join('&');
      const d = await GET('/invoices/overdue' + (qs ? '?' + qs : ''));
      const auto = App.meta.notify_enabled;
      // 付款人別選單只需建一次，避免每次重畫都重設使用者的選擇
      const payerSel = el.querySelector('#payer');
      if (payerSel.options.length <= 1) {
        payerSel.innerHTML = '<option value="">全部付款人別</option>' +
          (d.payers || []).map(p => `<option value="${UI.esc(p)}">${UI.esc(p)}</option>`).join('');
      }
      el.querySelector('#list').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num ${d.rows.length ? 'warn' : ''}">${d.rows.length}</div><div class="label">逾期筆數（超過 ${d.days} 天）</div></div>
          <div class="stat"><div class="num ${d.total_amount ? 'warn' : ''}">${UI.fmtMoney(d.total_amount)}</div><div class="label">逾期金額合計</div></div>
          <div class="stat"><div class="num">${d.all_unpaid.c}</div><div class="label">全部未收款（${UI.fmtMoney(d.all_unpaid.amt)}）</div></div>
        </div>
        <div class="card"><h3>帳齡分析</h3>
          ${UI.table(['帳齡', '筆數', '金額', '占比'], d.aging.map(b => `<tr>
            <td>${UI.esc(b.label)}</td><td>${b.count}</td><td>${UI.fmtMoney(b.amount)}</td>
            <td><div style="background:#eef2f5;border-radius:6px;height:9px;min-width:80px">
              <div style="width:${d.total_amount ? Math.round(b.amount / d.total_amount * 100) : 0}%;height:9px;border-radius:6px;background:${b.key === 'over_90' ? 'var(--danger)' : b.key === '61_90' ? '#e08b2f' : 'var(--primary)'}"></div>
            </div></td></tr>`))}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            超過 90 天者建議改以電話聯繫並評估是否暫停後續預約；金額確定無法收回時請作廢並註明原因，帳務才對得起來。</div>
        </div>
        <div class="notice ${auto ? 'ok' : ''}" style="margin-bottom:14px">
          ${auto ? '已設定發送通道，按「發送催繳」由系統送出，結果記入發送紀錄。'
    : '尚未設定發送通道（系統設定 → 提醒發送通道），目前僅產生訊息供人工發送或電話聯繫。'}
          催繳內容可於系統設定的「催繳訊息範本」調整。</div>
        <div class="card">
          ${d.rows.length ? d.rows.map(r => `<div style="border-bottom:1px dashed var(--border);padding:10px 0">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <a href="#client/${r.client_id}"><strong>${UI.esc(r.client_name)}</strong></a>
              <span style="color:var(--muted);font-size:13px">${UI.esc(r.client_code)}　${UI.esc(r.client_phone || '未留電話')}
                ${r.counselor_name ? '　主責：' + UI.esc(r.counselor_name) : ''}</span>
              ${UI.tag('逾期 ' + r.days_overdue + ' 天', r.days_overdue >= 30 ? 'danger' : 'warn')}
              <span>${r.date}　${UI.esc(r.item)}　<strong>${UI.fmtMoney(r.amount)}</strong></span>
              ${r.last_dunned_at ? UI.tag(`已催繳 ${r.dunned_times} 次，最近 ${UI.esc(r.last_dunned_at.slice(5, 16))}`) : ''}
              <span class="spacer" style="flex:1"></span>
              <button class="btn tiny secondary" data-copy="${r.id}">複製訊息</button>
              <button class="btn tiny" data-dun="${r.id}">${auto ? '發送催繳' : '記錄已催繳'}</button>
              <button class="btn tiny secondary" data-pay="${r.id}">收款</button>
            </div>
            <div style="font-size:13px;background:#f7f9fa;border-radius:8px;padding:8px;margin-top:6px" id="dm-${r.id}">${UI.esc(r.message)}</div>
          </div>`).join('') : '<div class="empty">沒有逾期未收款的收費單</div>'}
        </div>
        ${d.rows.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn secondary small" id="copyall">複製全部訊息</button>
          ${auto ? '<button class="btn small" id="sendall">整批發送催繳</button>' : ''}
        </div>` : ''}`;

      const copy = txt => navigator.clipboard.writeText(txt).then(() => UI.toast('已複製')).catch(() => UI.toast('請手動選取複製', true));
      el.querySelectorAll('[data-copy]').forEach(b => {
        b.onclick = () => copy(el.querySelector('#dm-' + b.dataset.copy).textContent);
      });
      const ca = el.querySelector('#copyall');
      if (ca) ca.onclick = () => copy(d.rows.map(r => r.message).join('\n\n'));
      el.querySelectorAll('[data-dun]').forEach(b => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await POST(`/invoices/${b.dataset.dun}/dun`, { message: el.querySelector('#dm-' + b.dataset.dun).textContent });
            UI.toast(r.message || '已記錄', r.status === 'failed');
          } catch (e) { UI.err(e); }
          draw();
        };
      });
      el.querySelectorAll('[data-pay]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '收款',
          body: `<div class="form-grid">${UI.select('method', '付款方式', App.listOptions('pay_methods', ['現金']), { full: true })}</div>`,
          onSubmit: async e => { await POST(`/invoices/${b.dataset.pay}/pay`, UI.formData(e)); UI.toast('已收款'); draw(); }
        });
      });
      const sa = el.querySelector('#sendall');
      if (sa) {
        sa.onclick = async () => {
          // 已催繳過的仍會再送一次，因此明白告知筆數再執行
          if (!await UI.confirm(`將對 ${d.rows.length} 筆逾期收費單各發送一則催繳訊息，確定？`)) return;
          sa.disabled = true;
          let ok = 0, fail = 0;
          for (const r of d.rows) {
            try {
              const res = await POST(`/invoices/${r.id}/dun`, { message: r.message });
              res.status === 'failed' ? fail++ : ok++;
            } catch { fail++; }
          }
          UI.toast(`發送完成：成功 ${ok} 則、失敗 ${fail} 則`, fail > 0);
          draw();
        };
      }
    };
    el.innerHTML = `<div class="toolbar"><label>逾期天數門檻</label>
        <input id="days" type="number" min="1" style="width:90px" placeholder="依系統設定">
        <select id="payer"><option value="">全部付款人別</option></select>
        <select id="fc2">${App.counselorOptions(true).map(o => `<option value="${o[0]}">${UI.esc(o[1])}</option>`).join('')}</select>
        <button class="btn small secondary" id="go">查詢</button>
        <div class="spacer"></div>
        <button class="btn small secondary" id="log2">催繳紀錄</button></div>
      <div id="list"><div class="empty">載入中...</div></div>`;
    el.querySelector('#go').onclick = draw;
    ['#payer', '#fc2'].forEach(s => { el.querySelector(s).onchange = draw; });
    el.querySelector('#log2').onclick = async () => {
      const rows = await GET('/dunning-log');
      UI.modal({
        title: '催繳發送紀錄', wide: true, hideFooter: true,
        body: UI.table(['時間', '個案', '通道', '對象', '狀態', '內容'], rows.map(n => `<tr>
          <td>${UI.esc(n.created_at.slice(5, 16))}</td>
          <td>${UI.esc(n.client_name || '-')}${n.client_code ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(n.client_code) + '</span>' : ''}</td>
          <td>${n.channel === 'webhook' ? '系統發送' : '人工'}</td>
          <td>${UI.esc(n.target || '-')}</td>
          <td>${n.status === 'sent' ? UI.tag('已送出', 'ok') : n.status === 'failed' ? UI.tag('失敗', 'danger') : UI.tag('人工發送')}
            ${n.error ? '<br><span style="font-size:12px;color:var(--danger)">' + UI.esc(n.error) + '</span>' : ''}</td>
          <td><div title="${UI.esc(n.content || '')}" class="ellipsis" style="max-width:280px;font-size:12.5px;color:var(--muted);">${UI.esc(n.content || '')}</div></td>
        </tr>`), '尚無催繳紀錄')
      });
    };
    el.querySelector('#days').addEventListener('keydown', e => { if (e.key === 'Enter') draw(); });
    await draw();
  }
});

App.page('packages', {
  title: '方案管理',
  sub: '預付堂數方案；完成晤談時自動扣次',
  help: [
    '預付堂數方案（例如先買 10 次）。按「新增方案」設定堂數與金額後，晤談完成時自動扣一次。',
    '這裡管的是堂數包；收費規則與時長請到「方案設定」。',
  ],
  module: 'billing',
  async render(el) {
    const rows = await GET('/packages');
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div><button class="btn" id="add">新增方案</button></div>
      <div class="card">${UI.table(['個案', '方案', '總次數', '已用', '剩餘', '金額', '起訖', '狀態', ''],
        rows.map(p => `<tr><td><a href="#client/${p.client_id}">${UI.esc(p.client_name)}（${p.client_code}）</a></td>
          <td>${UI.esc(p.name)}</td><td>${p.sessions_total}</td><td>${p.sessions_used}</td>
          <td><strong>${p.remaining}</strong></td><td>${UI.fmtMoney(p.amount)}</td>
          <td>${p.start_date} ~ ${p.expire_date || '不限'}</td>
          <td>${UI.tag(TW.pkg_status[p.status] || p.status, p.status === 'active' ? 'ok' : '')}</td>
          <td style="white-space:nowrap"><button class="btn tiny secondary" data-pe="${p.id}">編輯</button>
            <button class="btn tiny danger" data-pd="${p.id}">刪除</button></td></tr>`), '尚無方案')}</div>`;
    // 方案名稱、次數與效期可改；已被扣抵過的方案不可刪除
    el.querySelectorAll('[data-pe]').forEach(b => {
      const p = rows.find(x => x.id === Number(b.dataset.pe));
      b.onclick = () => UI.modal({
        title: '編輯方案：' + p.name,
        body: `<div class="form-grid">
          ${UI.input('name', '方案名稱', { value: p.name })}
          ${UI.input('sessions_total', '總次數', { type: 'number', value: p.sessions_total })}
          ${UI.input('expire_date', '到期日', { type: 'date', value: p.expire_date || '' })}
          ${UI.select('status', '狀態', [['active', '使用中'], ['done', '已用完'], ['expired', '已過期']], { value: p.status })}
          ${UI.textarea('note', '備註', { value: p.note || '' })}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            已用次數由系統依晤談自動累計，不在此修改；金額請於收費單調整。</div>`,
        onSubmit: async e => { await PUT(`/packages/${p.id}`, UI.formData(e)); UI.toast('已儲存'); App.go('packages'); }
      });
    });
    el.querySelectorAll('[data-pd]').forEach(b => {
      const p = rows.find(x => x.id === Number(b.dataset.pd));
      b.onclick = async () => {
        if (!await UI.confirm(`刪除「${p.name}」？已被晤談扣抵過的方案無法刪除。`)) return;
        try { await DEL(`/packages/${p.id}`); UI.toast('已刪除'); App.go('packages'); } catch (e) { UI.err(e); }
      };
    });
    el.querySelector('#add').onclick = async () => {
      const clients = await App.clientOptions(true);
      UI.modal({
        title: '新增方案',
        body: `<div class="form-grid">
          ${UI.select('client_id', '個案', clients, { full: true })}
          ${UI.input('name', '方案名稱', { value: '個別諮商 10 次方案' })}
          ${UI.input('sessions_total', '總次數', { type: 'number', value: 10 })}
          ${UI.input('amount', '方案金額', { type: 'number', value: 18000 })}
          ${UI.input('start_date', '起始日', { type: 'date', value: UI.today() })}
          ${UI.input('expire_date', '到期日', { type: 'date', value: UI.addDays(UI.today(), 180) })}
          ${UI.select('payer', '付款人別', App.listOptions('payer_types', ['自費']))}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:10px">建立方案會同時產生一筆待收款收費單。</div>`,
        onSubmit: async e => { await POST('/packages', UI.formData(e)); UI.toast('已建立'); App.go('packages'); }
      });
    };
  }
});

// ---- 個案訊息 ----
App.page('messages', {
  title: '個案訊息',
  sub: '行政聯繫用（改期、繳費等）；晤談內容請勿於此討論',
  help: [
    '與個案的行政聯繫（改期、繳費、提醒），點「開啟」進對話後送出訊息。',
    '<strong>晤談內容請勿在此討論</strong>，訊息內容會留在系統紀錄裡。',
  ],
  module: 'messages',
  async render(el) {
    const list = await GET('/messages');
    el.innerHTML = `<div class="card"><h3>對話</h3>
      ${UI.table(['個案', '最後訊息', '時間', ''], list.map(m => `<tr>
        <td>${UI.esc(m.client_name)}（${m.client_code}）${m.unread ? UI.tag(m.unread + ' 未讀', 'danger') : ''}</td>
        <td>${UI.esc((m.last_content || '').slice(0, 30))}</td><td>${UI.esc(m.last_at || '')}</td>
        <td><button class="btn tiny" data-m="${m.client_id}">開啟</button></td></tr>`), '尚無訊息')}</div>`;
    el.querySelectorAll('[data-m]').forEach(b => {
      b.onclick = async () => {
        const cid = Number(b.dataset.m);
        const msgs = await GET('/messages?client_id=' + cid);
        const m = UI.modal({
          title: '訊息', wide: true, hideFooter: true,
          body: `<div class="chat-list" id="cl">${msgs.map(x => `
              <div class="chat-msg ${x.sender === 'staff' ? 'me' : 'them'}">${UI.nl2br(x.content)}</div>
              <div class="chat-meta ${x.sender === 'staff' ? 'me' : 'them'}">${UI.esc(x.staff_name || '個案')}　${UI.esc(x.created_at)}</div>`).join('')}</div>
            <div class="chat-bar"><textarea id="msg" placeholder="輸入訊息"></textarea>
              <button class="btn" id="send" type="button">送出</button></div>`
        });
        m.body.querySelector('#send').onclick = async () => {
          const content = m.body.querySelector('#msg').value.trim();
          if (!content) return;
          try { await POST('/messages', { client_id: cid, content }); m.close(); App.go('messages'); }
          catch (e) { UI.err(e); }
        };
      };
    });
  }
});

// ---- 公告 ----
App.page('announcements', {
  title: '公告',
  help: [
    '所內公告，全所員工登入後在總覽看得到。',
    '按「新增公告」發布，設定有效期限後過期會自動收起。',
  ],
  module: 'announcements',
  async render(el) {
    const rows = await GET('/announcements');
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div><button class="btn" id="add">新增公告</button></div>
      <div class="card">${UI.table(['日期', '標題', '對象', '發布者', ''], rows.map(a => `<tr>
        <td>${a.publish_date}</td><td>${a.pinned ? '📌 ' : ''}${UI.esc(a.title)}</td>
        <td>${({ all: '全部', staff: '所內', client: '個案' })[a.audience]}</td>
        <td>${UI.esc(a.author || '')}</td>
        <td style="white-space:nowrap"><button class="btn tiny secondary" data-e="${a.id}">編輯</button>
          <button class="btn tiny danger" data-d="${a.id}">刪除</button></td></tr>`), '尚無公告')}</div>`;
    // 新增與編輯共用同一張表單；有帶 a 就是編輯
    const dialog = a => UI.modal({
      title: a ? '編輯公告' : '新增公告',
      body: `<div class="form-grid">
        ${UI.input('title', '標題', { value: a ? a.title : '', full: true })}
        ${UI.select('audience', '對象', [['all', '全部'], ['staff', '所內人員'], ['client', '個案']], { value: a ? a.audience : 'all' })}
        ${UI.input('publish_date', '發布日', { type: 'date', value: a ? a.publish_date : UI.today() })}
        ${UI.checkbox('pinned', '置頂', a ? !!a.pinned : false)}
        ${UI.textarea('content', '內容', { value: a ? a.content : '' })}</div>`,
      onSubmit: async e => {
        const data = UI.formData(e);
        if (a) await PUT(`/announcements/${a.id}`, data); else await POST('/announcements', data);
        UI.toast('已儲存');
        App.go('announcements');
      }
    });
    el.querySelector('#add').onclick = () => dialog(null);
    el.querySelectorAll('[data-e]').forEach(b => {
      b.onclick = () => dialog(rows.find(a => a.id === Number(b.dataset.e)));
    });
    el.querySelectorAll('[data-d]').forEach(b => {
      b.onclick = async () => { if (await UI.confirm('刪除此公告？')) { await DEL(`/announcements/${b.dataset.d}`); App.go('announcements'); } };
    });
  }
});

// ---- 報表 ----
// 比率顯示：分母為 0 時後端回 null，畫面顯示「—」而不是 0%，避免誤判
function pctText(v) { return v === null || v === undefined ? '—' : v + '%'; }

App.page('reports', {
  title: '統計報表',
  sub: '月報：服務量、個案來源、收入與危機事件',
  help: [
    '月報：服務量、個案來源、收入與危機事件統計，可切換月份。',
    '數字取自已完成的晤談與已開立的收費單，因此當月未結的部分不會計入。',
  ],
  module: 'reports',
  async render(el) {
    const month = (el.querySelector('#m') && el.querySelector('#m').value) || UI.thisMonth();
    const d = await GET('/reports?month=' + month);
    const exps = await GET('/exports');
    el.innerHTML = `<div class="toolbar"><label>月份</label><input id="m" type="month" value="${d.month}">
        <div class="spacer"></div><button class="btn secondary small" onclick="window.print()">列印</button></div>
      <div class="card"><h3>報表匯出</h3>
        ${UI.table(['報表', '範圍', '匯出格式'], exps.map(x => `<tr>
          <td>${UI.esc(x.name)}</td><td>${x.range ? '選定月份' : '全部'}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny secondary" data-x="${x.key}" data-f="xls">Excel</button>
            <button class="btn tiny secondary" data-x="${x.key}" data-f="pdf">PDF</button>
            <button class="btn tiny secondary" data-x="${x.key}" data-f="csv">CSV</button></td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          期間類報表以上方選定月份為範圍。PDF 會開啟列印畫面，選擇「另存為 PDF」即可；
          Excel 為 .xls 檔，Excel／LibreOffice 可直接開啟。匯出動作會記入稽核軌跡。</div></div>
      <div class="stat-grid">
        <div class="stat"><div class="num">${d.clients.active_clients}</div><div class="label">服務中個案</div></div>
        <div class="stat"><div class="num">${d.clients.new_clients}</div><div class="label">本月新案</div></div>
        <div class="stat"><div class="num">${d.clients.closed_clients}</div><div class="label">本月結案</div></div>
        <div class="stat"><div class="num">${UI.fmtMoney(d.income.paid)}</div><div class="label">本月已收</div></div>
        <div class="stat"><div class="num warn">${UI.fmtMoney(d.income.unpaid)}</div><div class="label">本月未收</div></div>
      </div>
      <div class="card"><h3>經營品質指標</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
          分母為 0 時顯示「—」。時段利用率＝當月實際完成晤談時數 ÷ 排班開放時數，
          是評估排班是否過鬆或過滿的直接依據。</div>
        <div class="stat-grid">
          <div class="stat"><div class="num ${d.kpi.no_show_rate > 10 ? 'warn' : ''}">${pctText(d.kpi.no_show_rate)}</div>
            <div class="label">爽約率（未到 ÷ 全部排定）</div></div>
          <div class="stat"><div class="num">${pctText(d.kpi.cancel_rate)}</div><div class="label">取消率</div></div>
          <div class="stat"><div class="num">${pctText(d.kpi.intake_conversion.rate)}</div>
            <div class="label">初談轉銜率（${d.kpi.intake_conversion.converted}/${d.kpi.intake_conversion.intakes}）</div></div>
          <div class="stat"><div class="num ${d.kpi.dropout.rate > 20 ? 'warn' : ''}">${pctText(d.kpi.dropout.rate)}</div>
            <div class="label">脫落率（逾 60 天未再晤談且無後續預約）</div></div>
          <div class="stat"><div class="num">${d.kpi.avg_sessions === null ? '—' : d.kpi.avg_sessions}</div>
            <div class="label">平均晤談次數／人（當月）</div></div>
        </div>
        ${UI.barChart(d.kpi.utilization.map(u => ({
    label: u.name, value: u.rate === null ? 0 : u.rate, note: `${u.used_hours} / ${u.capacity_hours} 小時`
  })), { horizontal: true, format: v => v + '%', title: '心理師時段利用率', empty: '尚未設定排班，無法計算利用率' })}
      </div>
      <div class="card"><h3>心理師服務量</h3>
        ${UI.table(['心理師', '完成', '未到', '取消', '服務人數'], d.by_counselor.map(r => `<tr>
          <td>${UI.esc(r.name)}</td><td><strong>${r.done}</strong></td><td>${r.no_show}</td>
          <td>${r.cancelled}</td><td>${r.clients}</td></tr>`))}</div>
      <div class="card"><h3>晤談類型</h3>
        ${UI.table(['類型', '次數'], d.by_type.map(r => `<tr><td>${UI.esc(TW.appt_type[r.type] || r.type)}</td><td>${r.n}</td></tr>`))}</div>
      <div class="card"><h3>服務形式</h3>
        ${UI.table(['形式', '次數', '占比'], d.by_mode.map(r => {
    const tot = d.by_mode.reduce((a, x) => a + x.n, 0) || 1;
    return `<tr><td>${UI.esc(TW.appt_mode[r.mode] || r.mode)}</td><td>${r.n}</td>
      <td>${Math.round(r.n / tot * 100)}%</td></tr>`;
  }), '本月無完成晤談')}</div>
      <div class="card"><h3>心理衡鑑與初談問卷</h3>
        ${UI.table(['項目', '數量'], [
    `<tr><td>完成心理衡鑑晤談</td><td>${d.assessment_reports.tested}</td></tr>`,
    `<tr><td>已產出衡鑑報告</td><td>${d.assessment_reports.reports}${d.assessment_reports.tested > d.assessment_reports.reports
      ? `<span style="color:var(--danger)">（尚缺 ${d.assessment_reports.tested - d.assessment_reports.reports} 份）</span>` : ''}</td></tr>`,
    `<tr><td>其中已簽核定稿</td><td>${d.assessment_reports.signed}</td></tr>`,
    `<tr><td>發出初談問卷</td><td>${d.intake_forms.sent}</td></tr>`,
    `<tr><td>個案完成填寫</td><td>${d.intake_forms.submitted}</td></tr>`,
    `<tr><td>問卷命中自殺意念題</td><td>${d.intake_forms.alerted ? `<span style="color:var(--danger);font-weight:700">${d.intake_forms.alerted}</span>` : 0}</td></tr>`
  ])}</div>
      <div class="card"><h3>新案來源</h3>
        ${UI.table(['來源', '人數'], d.by_source.map(r => `<tr><td>${UI.esc(r.source)}</td><td>${r.n}</td></tr>`))}</div>
      <div class="card"><h3>收入來源別</h3>
        ${UI.table(['付款人別', '筆數', '金額'], d.income_by_payer.map(r => `<tr><td>${UI.esc(r.payer)}</td><td>${r.n}</td><td>${UI.fmtMoney(r.amt)}</td></tr>`))}</div>
      <div class="card"><h3>收款方式</h3>
        ${UI.table(['付款方式', '筆數', '金額'], (d.income_by_method || []).map(r =>
    `<tr><td>${UI.esc(r.method)}</td><td>${r.n}</td><td>${UI.fmtMoney(r.amt)}</td></tr>`), '本月尚無收款')}</div>
      <div class="card"><h3>危機事件</h3>
        ${UI.table(['類型', '件數', '其中已通報'], d.risk.map(r => `<tr><td>${UI.esc(r.type)}</td><td>${r.n}</td><td>${r.reported}</td></tr>`), '本月無危機事件')}</div>
      <div class="card"><h3>量表施測</h3>
        ${UI.table(['量表', '份數', '平均分'], d.scales.map(r => `<tr><td>${UI.esc(SCALE_NAMES[r.scale] || r.scale)}</td><td>${r.n}</td><td>${r.avg_total}</td></tr>`), '本月無施測')}</div>
      <div class="card"><h3>合作單位服務量</h3>
        ${UI.table(['單位', '個案數', '晤談次數', '金額'], d.by_partner.map(r => `<tr><td>${UI.esc(r.name)}</td>
          <td>${r.clients}</td><td>${r.sessions}</td><td>${UI.fmtMoney(r.amount)}</td></tr>`), '本月無合作單位服務')}
        ${d.settlements.length ? `<div style="margin-top:10px">${UI.table(['請款單', '次數', '金額', '狀態'],
          d.settlements.map(s => `<tr><td>${UI.esc(s.partner_name)} ${s.month}</td><td>${s.sessions}</td>
            <td>${UI.fmtMoney(s.amount)}</td><td>${TW.settle_status[s.status] || s.status}</td></tr>`))}</div>` : ''}</div>
      <div class="card"><h3>團體諮商</h3>
        ${UI.table(['團體', '本月場次', '成員數'], d.groups.map(r => `<tr><td>${UI.esc(r.name)}</td>
          <td>${r.sessions}</td><td>${r.members}</td></tr>`), '本月無團體場次')}</div>`;
    el.querySelector('#m').onchange = () => App.pages.reports.render(el);
    el.querySelectorAll('[data-x]').forEach(b => {
      b.onclick = () => {
        const m = el.querySelector('#m').value;
        const from = m + '-01';
        const to = UI.addDays(UI.addDays(from, 31).slice(0, 8) + '01', -1);
        const url = `/api/exports/${b.dataset.x}?from=${from}&to=${to}&format=${b.dataset.f}`;
        // PDF 走列印畫面，另開分頁；檔案類直接下載
        if (b.dataset.f === 'pdf') window.open(url, '_blank'); else location.href = url;
      };
    });
  }
});

// ---- 帳號 ----
App.page('users', {
  title: '帳號權限',
  sub: '行政人員預設不含晤談紀錄與危機事件模組',
  help: [
    '按「新增帳號」建立員工帳號，勾選這個人能看到哪些模組；未勾的模組連選單都不會出現。',
    '行政人員預設不含晤談紀錄與危機事件（保密考量），可視需要調整。',
    '離職請用「停用」而不是刪除，才留得住稽核軌跡。',
  ],
  module: 'users',
  async render(el) {
    const users = await GET('/users');
    const modules = App.meta.modules || [];
    const form = u => `<div class="form-grid">
        ${UI.input('username', '帳號（登入用）', { value: u ? u.username : '', required: true })}
        ${UI.input('password', u ? '重設密碼（留空不改）' : '密碼', { type: 'text', placeholder: u ? '留空表示不變更' : '至少 6 碼' })}
        ${UI.input('name', '姓名', { value: u ? u.name : '' })}
        ${UI.select('role', '角色', App.enumOptions('role'), { value: u ? u.role : 'counselor' })}
        ${UI.input('title', '職稱', { value: u ? u.title : '' })}
        ${UI.inputList('license_type', '證照類別', App.meta.license_types || ['諮商心理師', '臨床心理師'], { value: u ? u.license_type : '' })}
        ${UI.input('license_no', '證書字號', { value: u ? u.license_no : '' })}
        ${UI.input('license_expiry', '執業執照更新日', { type: 'date', value: u ? u.license_expiry : '' })}
        ${UI.input('specialty', '專長', { value: u ? u.specialty : '', full: true })}
        ${UI.input('meeting_room_url', '固定視訊會議室連結', {
    value: u ? (u.meeting_room_url || '') : '', full: true,
    placeholder: 'https://meet.google.com/xxx-xxxx-xxx（排視訊晤談時自動帶入）'
  })}
        ${UI.input('phone', '電話', { value: u ? u.phone : '' })}
        ${UI.input('email', 'Email', { value: u ? u.email : '' })}
        <div class="form-row full" style="margin-top:4px"><label>人事資料（在職／離職證明書用）</label></div>
        ${UI.select('gender', '性別', [['', '未填'], ['male', '男'], ['female', '女']], { value: u ? (u.gender || '') : '' })}
        ${UI.input('birth_date', '出生日期', { type: 'date', value: u ? (u.birth_date || '') : '' })}
        ${UI.input('hire_date', '到職日期', { type: 'date', value: u ? (u.hire_date || '') : '' })}
        ${UI.input('resign_date', '離職日期', { type: 'date', value: u ? (u.resign_date || '') : '' })}
        ${UI.input('work_place', '服務地點（留空用機構地址）', { value: u ? (u.work_place || '') : '', full: true })}
        <div class="form-row full" style="margin-top:4px"><label>領款人資料（列印勞務報酬單、申報扣繳憑單用）</label></div>
        ${UI.input('id_no', '身分證字號', { value: u ? (u.id_no || '') : '' })}
        ${UI.input('passport_no', '居留證／護照號碼', { value: u ? (u.passport_no || '') : '' })}
        ${UI.select('residency', '身分別', [['local', '本國籍'], ['local_abroad', '本國籍但未在台居住'],
    ['foreign_183', '外國籍在台滿 183 天'], ['foreign_lt183', '外國籍在台未滿 183 天']],
  { value: u ? (u.residency || 'local') : 'local' })}
        ${UI.input('household_address', '戶籍地址', { value: u ? (u.household_address || '') : '', full: true })}
        ${UI.input('mailing_address', '通訊地址（同戶籍可留空）', { value: u ? (u.mailing_address || '') : '', full: true })}
        ${UI.input('bank_name', '匯款銀行', { value: u ? (u.bank_name || '') : '' })}
        ${UI.input('bank_account', '帳號', { value: u ? (u.bank_account || '') : '' })}
        ${UI.input('bank_holder', '戶名（同姓名可留空）', { value: u ? (u.bank_holder || '') : '' })}
        ${UI.checkbox('portal_bookable', '出現在線上預約表單的心理師清單', u ? u.portal_bookable !== 0 : true)}
        ${UI.checkbox('online_only', '僅接受線上通訊諮商', u ? !!u.online_only : false)}
        ${App.meta.intern_review ? UI.checkbox('is_intern', '實習心理師（晤談紀錄須經指定督導覆核後才定稿）', u ? u.is_intern : false) : ''}
        ${App.meta.intern_review ? UI.select('supervisor_id', '指定督導', [['', '未指定']].concat(users
    .filter(x => x.active && ['supervisor', 'admin', 'counselor'].includes(x.role) && (!u || x.id !== u.id))
    .map(x => [x.id, `${x.name}（${TW.role[x.role] || x.role}）`])), { value: u ? (u.supervisor_id || '') : '', full: true }) : ''}
        <div class="form-row full"><label>模組權限（管理者不受此限）</label>
          <div class="toolbar" style="margin:0 0 8px">
            <button class="btn tiny secondary" type="button" id="permall">全選</button>
            <button class="btn tiny secondary" type="button" id="permnone">全部取消</button>
            <button class="btn tiny secondary" type="button" id="permrole">套用角色預設</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:4px 14px">
            ${modules.map(m => `<label style="font-size:13.5px;display:flex;gap:8px;align-items:center;
              padding:6px 8px;border:1px solid var(--border);border-radius:6px;cursor:pointer">
              <input type="checkbox" class="perm" value="${m.key}"${u && u.permissions.includes(m.key) ? ' checked' : ''}
                style="width:auto;flex:none;margin:0">
              <span style="flex:1">${UI.esc(m.label)}</span></label>`).join('')}</div></div>
        ${u ? UI.checkbox('active', '帳號啟用中', u.active) : ''}
      </div>`;
    // 權限勾選的快捷鍵：全選／全部取消／套用該角色預設
    const permSetup = el2 => {
      const boxes = [...el2.querySelectorAll('.perm')];
      const setAll = v => boxes.forEach(c => { c.checked = v; });
      el2.querySelector('#permall').onclick = () => setAll(true);
      el2.querySelector('#permnone').onclick = () => setAll(false);
      el2.querySelector('#permrole').onclick = () => {
        const role = el2.querySelector('[name=role]').value;
        const def = (App.meta.role_default_modules || {})[role] || [];
        boxes.forEach(c => { c.checked = def.includes(c.value); });
        UI.toast(`已套用${TW.role[role] || role}預設權限`);
      };
    };
    const submit = u => async el2 => {
      const d = UI.formData(el2);
      d.permissions = [...el2.querySelectorAll('.perm:checked')].map(c => c.value);
      if (!d.password) delete d.password;
      const r = u ? await PUT(`/users/${u.id}`, d) : await POST('/users', d);
      // 停用心理師時，未結的預約與主責個案需人工改派，這裡明確提示
      if (r && r.warnings && r.warnings.length) {
        UI.modal({
          title: '已儲存，但有待處理事項', hideFooter: true,
          body: `<div class="notice warn">${r.warnings.map(w => UI.esc(w)).join('<br>')}</div>`
        });
      } else {
        UI.toast('已儲存');
      }
      App.go('users');
    };
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div><button class="btn" id="add">新增帳號</button></div>
      <div class="card">${UI.table(['帳號', '姓名', '角色', '證照', '督導', '權限數', '狀態', ''], users.map(u => `<tr>
        <td>${UI.esc(u.username)}</td>
        <td>${UI.esc(u.name)}${u.is_intern ? ' ' + UI.tag('實習', 'warn') : ''}</td>
        <td>${UI.esc(TW.role[u.role] || u.role)}</td>
        <td>${UI.esc(u.license_type || '')}${u.license_no ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(u.license_no) + '</span>' : ''}</td>
        <td>${UI.esc(u.supervisor_name || '')}</td>
        <td>${u.role === 'admin' ? '全部' : u.permissions.length}</td>
        <td>${u.active ? UI.tag('啟用', 'ok') : UI.tag('停用')}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn tiny secondary" data-u="${u.id}">編輯</button>
          <button class="btn tiny secondary" data-pw="${u.id}">重設密碼</button>
          <button class="btn tiny danger" data-du="${u.id}">刪除</button></td></tr>`))}</div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        密碼在資料庫只保存加密後的雜湊值，任何人都查不回原本的密碼；忘記密碼時請用「重設密碼」產生新的並交給本人。</div>`;
    el.querySelector('#add').onclick = () => UI.modal({
      title: '新增帳號', wide: true, body: form(null), onOpen: permSetup, onSubmit: submit(null)
    });
    el.querySelectorAll('[data-u]').forEach(b => {
      const u = users.find(x => x.id === Number(b.dataset.u));
      b.onclick = () => UI.modal({
        title: '編輯帳號：' + u.username, wide: true, body: form(u), onOpen: permSetup, onSubmit: submit(u)
      });
    });
    el.querySelectorAll('[data-du]').forEach(b => {
      const u = users.find(x => x.id === Number(b.dataset.du));
      b.onclick = async () => {
        if (!await UI.confirm(`刪除帳號「${u.name}（${u.username}）」？
若已有預約、主責個案或晤談紀錄，會改為停用以保留歷史資料。`)) return;
        const r = await DEL(`/users/${u.id}`);
        UI.toast(r.deactivated ? `已停用（仍有 ${r.links.join('、')}）` : '已刪除');
        App.go('users');
      };
    });
    el.querySelectorAll('[data-pw]').forEach(b => {
      const u = users.find(x => x.id === Number(b.dataset.pw));
      b.onclick = () => UI.modal({
        title: `重設密碼：${u.name}（${u.username}）`,
        submitText: '重設並顯示',
        body: `${UI.input('password', '新密碼（留空則自動產生 8 碼）', { type: 'text', placeholder: '至少 6 碼' })}
          <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
            重設後舊密碼立即失效，新密碼只會顯示這一次，請當場交給本人並請他登入後自行更換。</div>`,
        onSubmit: async el2 => {
          const r = await POST(`/users/${u.id}/reset-password`, UI.formData(el2));
          UI.modal({
            title: '密碼已重設', hideFooter: true,
            body: `<div style="font-size:14px;line-height:2">帳號：<strong>${UI.esc(r.username)}</strong></div>
              <div style="text-align:center;font-size:28px;font-weight:700;letter-spacing:4px;margin:10px 0">
                ${UI.esc(r.password)}</div>
              <div style="font-size:12.5px;color:var(--muted)">
                關閉此視窗後就查不到這組密碼了，忘記只能再重設一次。</div>`
          });
        }
      });
    });
  }
});

// ---- 系統設定 ----
App.page('settings', {
  title: '系統設定',
  sub: '所別資訊、收費預設值、選項清單與同意書範本',
  help: [
    '所別資訊、收費預設值（如未到計費比例、紀錄補記天數）、各種下拉選項清單與同意書範本都在這裡。',
    '改動會立即影響全所，每個欄位下方都有說明。',
  ],
  module: 'settings',
  async render(el) {
    const s = await GET('/settings');
    const groups = [
      ['所別資訊', [['center_name', '諮商所名稱'], ['center_phone', '電話'], ['center_address', '地址'],
        ['center_email', 'Email'], ['center_license_no', '開業執照字號'], ['center_director', '負責心理師'],
        ['center_tax_id', '機構統一編號']]],
      ['晤談與收費', [['session_minutes', '單次晤談分鐘'], ['default_fee', '一般晤談費用'], ['intake_fee', '初談費用'],
        ['cancel_hours', '免費取消門檻（小時）'],
        ['no_show_fee_fixed', '未到固定收費（元，0 表示改用下方比例）'],
        ['no_show_fee_rate', '未到收費比例（0-1，僅在固定收費為 0 時採用）'],
        ['case_code_prefix', '個案編號前綴'], ['receipt_prefix', '收據號前綴'], ['note_lock_days', '紀錄應完成天數']]],
      ['個案端', [['portal_public_url', '個案專區網址（留空自動由預約表單網址推得）'],
        ['portal_messages_write', '開放個案在專區留言（1/0；0＝只讀，聯繫走 LINE）'],
        ['portal_booking_enabled', '開放線上預約（1/0）'], ['portal_reschedule_enabled', '開放線上改期（1/0）'],
        ['portal_book_lead_days', '最早可約幾天後'], ['portal_book_max_days', '最晚可約幾天內']]],
      ['專業管理', [['supervision_required_hours', '年度督導時數目標'], ['audit_retention_days', '稽核軌跡保留天數'],
        ['record_retention_years', '心理紀錄保存年限'], ['ce_cycle_years', '繼續教育週期（年）'],
        ['ce_required_credits', '週期應完成積分'], ['ce_required_special', '特定類別積分下限'],
        ['ce_required_ethics', '專業倫理積分下限'], ['license_alert_days', '執照到期提前提醒天數'],
        ['adult_age', '成年年齡（未滿者需法代同意）']]],
      ['責任通報', [['mandatory_report_types', '應通報之事件類型（逗號分隔）'],
        ['report_deadline_hours', '通報時限（小時）']]],
      ['報酬與扣繳', [['withholding_rate', '執行業務所得扣繳率（0-1）'], ['withholding_min', '所得稅起扣金額'],
        ['nhi_supplement_rate', '二代健保補充保費費率（0-1）'], ['nhi_supplement_min', '補充保費起扣金額'],
        ['payout_split_max', '拆單每筆上限（低於起扣門檻）'], ['payout_split_interval_days', '拆單每筆間隔天數'],
        ['payout_slip_service', '勞務報酬單的勞務內容'], ['payout_slip_handler', '勞務報酬單經手人（留空用操作者）']]],
      ['證明書', [['cert_prefix', '證明書編號前綴'], ['center_director_license', '負責心理師證書字號（如 心理字1923號）'],
        ['cert_employment_title', '在職證明書 標題'], ['cert_employment_statement', '在職證明書 聲明文字'],
        ['cert_resignation_title', '離職證明書 標題'], ['cert_resignation_statement', '離職證明書 聲明文字'],
        ['cert_treatment_title', '治療證明 標題'], ['cert_profile_title', '基本資料表 標題'],
        ['cert_profile_statement', '基本資料表 說明文字'],
        ['cert_treatment_statement', '治療證明 聲明文字（{purpose} 會代入用途）']]],
      ['提醒發送通道', [['notify_webhook_url', 'Webhook 網址（留空則僅人工發送）'],
        ['notify_webhook_token', 'Webhook 驗證權杖']]],
      ['提醒訊息', [['reminder_template', '晤談提醒範本（{client}{counselor}{date}{weekday}{time}{center}{cancel_hours}{phone}{meeting}）'],
        ['dunning_template', '催繳訊息範本（{client}{date}{item}{amount}{days}{phone}{center}）'],
        ['waitlist_template', '候補遞補通知範本（{name}{date}{weekday}{time}{counselor}{center}{phone}）']]],
      ['收據印花稅總繳戳記', [['receipt_stamp_enabled', '收據是否印出戳記（1/0）'],
        ['receipt_stamp_note', '戳記中間文字'], ['receipt_stamp_authority', '總繳所在地（如 臺中市）'],
        ['receipt_stamp_payer', '負責總繳人姓名（留空則用負責心理師）']]],
      ['線上預約表單（對外）', [['booking_form_enabled', '開放對外預約表單（1/0）'],
        ['booking_public_url', '預約表單對外網址（LINE 卡片的預約按鈕會用到）'],
        ['booking_lead_days', '最早可約幾天後'], ['booking_max_days', '最晚可約幾天內'],
        ['booking_cutoff_time', '前一天幾點後關閉隔天時段（HH:MM，留空不設）'],
        ['booking_cutoff_hours', '晤談前至少幾小時才收線上預約（0 不設，與上一項同時生效）'],
        ['booking_slot_step', '時段間隔（分鐘）'], ['booking_require_birth', '是否必填生日（1/0，補助方案需驗年齡）'],
        ['booking_notice', '表單注意事項'], ['booking_privacy', '個資告知文字']]],
      ['諮商室指派', [['room_auto_assign', '成立預約時自動指派空房（1/0）'],
        ['room_hide_from_client', '個案端與表單不顯示諮商室（1/0）']]],
      ['其他開關', [['intern_review_enabled', '啟用實習生紀錄督導覆核（1/0）'],
        ['receipt_title_default', '收據預設抬頭'],
        ['hidden_modules', '停用的模組（逗號分隔的頁面代碼，移除即恢復）']]],
      ['方案人次上限', [['plan_default_week_limit', '每位心理師每週人次的預設值（0 不限；方案可各自覆寫）'],
        ['plan_default_month_limit', '每位心理師每月人次的預設值（0 不限）'],
        ['plan_quota_enforce', '超過額度時直接擋下（1）或只提醒（0）']]],
      ['候補遞補', [['waitlist_match_days', '視為「近期候補」的天數（僅影響標示）']]],
      ['排班表', [['shift_start', '排班表起始時間'], ['shift_end', '排班表結束時間'],
        ['shift_step', '每格分鐘數'],
        ['shift_quick_fills', '快填按鈕（每行一組：名稱|星期 0=日,逗號分隔|時段 09:00-12:00,逗號分隔）']]],
      ['轉介與結案追蹤', [['follow_up_days', '結案後自動建立追蹤點（天數，逗號分隔；留空不建立）'],
        ['follow_up_channels', '追蹤方式選項'], ['referral_targets', '轉介對象選項']]],
      ['安全計畫與紀錄覆核', [['safety_plan_review_days', '安全計畫預定檢視間隔（天）'],
        ['safety_plan_resources', '安全計畫危機資源（印在給個案的版本）'],
        ['note_review_days', '實習生紀錄逾幾天未覆核示警']]],
      ['收費逾期與初談問卷', [['overdue_days', '逾期催繳天數門檻'], ['intake_form_days', '初談問卷連結有效天數']]],
      ['選項清單（以逗號分隔）', [['counseling_types', '晤談類型'], ['approach_options', '治療取向'],
        ['source_options', '轉介來源'], ['close_reasons', '結案原因'], ['risk_types', '危機事件類型'],
        ['report_channels', '通報管道'], ['pay_methods', '付款方式'], ['payer_types', '付款人別'],
        ['partner_types', '合作單位類別'], ['time_off_reasons', '請假事由'], ['subsidy_programs', '政府補助方案'],
        ['ce_categories', '繼續教育類別'], ['group_topics', '團體主題']]],
      ['前台文字（清空即隱藏）', [['ui_staff_login_title', '員工登入頁 標題'], ['ui_staff_login_sub', '員工登入頁 副標'],
        ['ui_demo_staff', '員工登入頁 提示框'], ['ui_portal_title', '個案端 標題'], ['ui_portal_login_sub', '個案端 副標'],
        ['ui_portal_login_hint', '個案端 登入說明'], ['ui_demo_portal', '個案端 提示框'],
        ['ui_portal_note', '個案端 說明區塊'], ['ui_crisis_note', '危機求助提示']]]
    ];
    // 這些設定不會在本頁顯示結果，而是被其他畫面拿去算東西，
    // 因此逐欄註明「會出現在哪裡」，櫃檯改之前看得懂影響範圍。
    const FIELD_HELP = {
      session_minutes: '排約時自動算結束時間、線上預約的時段長度；方案有自己的時長時以方案為準。',
      default_fee: '排約時沒選方案、也沒手動填金額時帶入的費用。',
      intake_fee: '來電登記「建檔並排初談」時，那筆初談的預設費用。',
      cancel_hours: '個案端可自行取消的分界：不足此時數只能送出取消申請等櫃檯處理；也會印在個案端提示與 LINE 的預約成立／晤談提醒卡片上。',
      no_show_fee_fixed: '按「未到」時自動開出的收費單金額（收費單備註寫「未到行政規費 X 元」），也是個案端逾期取消的提示金額。填 0 才改用下方比例。',
      no_show_fee_rate: '未到收原費用的幾成；只有在上方固定收費為 0 時才生效。',
      case_code_prefix: '新建個案的編號開頭，例如 G2026002。',
      receipt_prefix: '收據流水號開頭，例如 GM20260800001。',
      receipt_stamp_enabled: '填 1 會在收據右下角印出「印花稅總繳」戳記，填 0 則不印。',
      receipt_stamp_payer: '向稅捐機關登記的印花稅總繳負責人，留空時自動用負責心理師。',
      note_lock_days: '晤談完成後幾天內要寫紀錄；逾期會在「待補紀錄與報告」與總覽以紅字警示。留空視為 7 天。'
    };
    const GROUP_HELP = {
      '晤談與收費': '以下都是<strong>預設值</strong>：排約當下仍可逐筆修改，選了方案時以方案的金額與時長為準。'
        + '改設定只影響之後產生的資料，已開立的收費單與已排的預約不會被回頭改動。'
    };
    const fieldHelp = k => (FIELD_HELP[k]
      ? `<div style="grid-column:1/-1;margin:-6px 0 8px;font-size:12px;color:var(--muted);line-height:1.7">↳ ${FIELD_HELP[k]}</div>`
      : '');
    el.innerHTML = groups.map(([label, fields]) => `<div class="card"><h3>${label}</h3>
      ${GROUP_HELP[label] ? `<div class="notice" style="margin-bottom:12px;font-size:13px">${GROUP_HELP[label]}</div>` : ''}
      <div class="form-grid">${fields.map(([k, l]) =>
        (String(s[k] || '').length > 40 || k === 'reminder_template' || k === 'shift_quick_fills' || k === 'safety_plan_resources' || k.startsWith('ui_demo') || k === 'ui_portal_note' || k === 'ui_crisis_note' || k.endsWith('_options') || k.endsWith('_types') || k.endsWith('_methods') || k.endsWith('_reasons') || k.endsWith('_channels'))
          ? UI.textarea(k, l, { value: s[k] || '' })
          : UI.input(k, l, { value: s[k] || '' }) + fieldHelp(k)).join('')}</div></div>`).join('') +
      `<div class="card"><h3>收據用印</h3>
         <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:12px">
           把實體印章蓋在白紙上拍照或掃描後上傳，開立收據與列印時就會自動蓋在收據上。
           系統會縮圖並<strong>去掉紙張底色</strong>（只留下印泥的線條，背景透明），所以拍照時紙張泛黃、燈光偏色都沒關係。
           沒有上傳的章就不印，收據不會出現空白框。</div>
         <div style="margin-bottom:14px">
           <div style="font-weight:600;font-size:14px;margin-bottom:4px">發票章（統一編號章）</div>
           <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:8px">蓋在收據的「統一編號」欄位上。</div>
           <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
             <div id="seal-preview" style="min-width:130px;min-height:70px;border:1px dashed var(--border);
               border-radius:8px;display:flex;align-items:center;justify-content:center;padding:6px;
               font-size:12.5px;color:var(--muted);background:#fff"></div>
             <div>
               <input type="file" id="seal-file" accept="image/*" style="font-size:13px">
               <button class="btn tiny danger" id="seal-clear" style="margin-left:8px">移除</button>
               <div id="seal-hint" style="font-size:12.5px;color:var(--muted);margin-top:6px"></div>
             </div>
           </div>
         </div>
         <div style="margin-bottom:14px">
           <div style="font-weight:600;font-size:14px;margin-bottom:4px">印花稅總繳章</div>
           <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:8px">蓋在收據右下角。<strong>沒有上傳時</strong>會改印上面「收據印花稅總繳戳記」那組欄位組出來的文字方框。</div>
           <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
             <div id="stamp-preview" style="min-width:130px;min-height:70px;border:1px dashed var(--border);
               border-radius:8px;display:flex;align-items:center;justify-content:center;padding:6px;
               font-size:12.5px;color:var(--muted);background:#fff"></div>
             <div>
               <input type="file" id="stamp-file" accept="image/*" style="font-size:13px">
               <button class="btn tiny danger" id="stamp-clear" style="margin-left:8px">移除</button>
               <div id="stamp-hint" style="font-size:12.5px;color:var(--muted);margin-top:6px"></div>
             </div>
           </div>
         </div>
       </div>
       <div class="card"><h3>諮商室</h3><div id="rooms"></div></div>
       <div class="card"><h3>安裝成手機／電腦 App</h3>
         <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:10px">
           本系統可安裝成 App，開啟後沒有網址列，跟一般 App 一樣從主畫面進入，資料仍即時連線（非離線版）。<br>
           <strong>Android／Chrome、Edge</strong>：按下方按鈕，或用瀏覽器選單的「安裝應用程式」。<br>
           <strong>iPhone／iPad</strong>：用 Safari 開啟後按「分享」→「加入主畫面」。<br>
           <strong>個案端</strong>請個案用手機開 <code>/portal.html</code> 後以同樣方式加入主畫面。</div>
         <button class="btn secondary small" id="installapp">安裝到這台裝置</button>
         <span id="install-hint" style="font-size:12.5px;color:var(--muted);margin-left:8px"></span></div>
       <div class="card"><h3>同意書範本</h3><div id="consents"></div></div>
       ${App.me.role === 'admin' ? `<div class="card"><h3>資料備份</h3>
         <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
           系統每日自動備份資料庫並把個案附件同步到異地目錄。換機、要立刻帶走資料，
           或剛上傳完重要附件時，可在此手動執行一次，不必等排程。</div>
         <button class="btn secondary small" id="backup">立即備份並同步附件</button>
         <div id="backup-result" style="font-size:13px;margin-top:10px"></div></div>` : ''}
       <div style="margin:16px 0 40px"><button class="btn" id="save">儲存設定</button></div>`;
    const inst = el.querySelector('#installapp');
    if (inst) {
      const hint = el.querySelector('#install-hint');
      const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      if (standalone) { inst.disabled = true; hint.textContent = '已經是以 App 方式開啟'; }
      inst.onclick = async () => {
        if (window.MCInstall && await window.MCInstall.prompt()) return;
        hint.textContent = '這個瀏覽器沒有提供安裝按鈕，請用瀏覽器選單的「安裝應用程式」或「加入主畫面」。';
      };
    }
    const bk = el.querySelector('#backup');
    if (bk) bk.onclick = async () => {
      const out = el.querySelector('#backup-result');
      bk.disabled = true;
      out.textContent = '執行中...';
      try {
        const r = await POST('/maintenance/backup', {});
        out.innerHTML = `最新備份：<strong>${UI.esc(r.latest_backup || '-')}</strong>（保留 ${r.backup_count} 份）<br>
          異地目錄：${UI.esc(r.mirror || '未設定')}　附件 ${r.uploads_total} 個，已同步 ${r.uploads_mirrored} 個`;
      } catch (e) { out.innerHTML = `<span style="color:var(--danger)">${UI.esc(e.message)}</span>`; }
      bk.disabled = false;
    };
    // 印章上傳：縮到 320px 寬、去掉紙張底色後存成透明 PNG 放進系統設定。
    // 存圖片而不是檔案路徑，備份資料庫就等於連章一起備份，換機不會掉。
    {
      // 有些手機拍的檔案（例如 LINE 存下來的 HEIC 改名成 .jpg）用 <img> 解不開，
      // 因此先試 createImageBitmap（瀏覽器解碼器較寬鬆），再退回 <img>。
      const loadBitmap = async f => {
        if (window.createImageBitmap) {
          try { return await createImageBitmap(f); } catch (e) { /* 換下一招 */ }
        }
        const url = URL.createObjectURL(f);
        try {
          return await new Promise((ok, bad) => {
            const im = new Image();
            im.onload = () => ok(im);
            im.onerror = () => bad(new Error('decode'));
            im.src = url;
          });
        } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
      };
      // 去底色：印泥（深色）留下，紙張（淺色）變透明，中間亮度做漸層才不會鋸齒。
      // 以整張圖較亮的那一端當紙張基準，泛黃、逆光、白平衡不準都能吃。
      const dropBackground = im => {
        const w = Math.min(320, im.width), h = Math.round(im.height * w / im.width);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(im, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h), px = d.data;
        const lum = i => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        // 取亮度的第 85 百分位當紙張亮度，第 10 百分位當印泥亮度
        const hist = new Array(256).fill(0);
        for (let i = 0; i < px.length; i += 4) hist[Math.round(lum(i))]++;
        const total = px.length / 4;
        const pct = p => { let n = 0; for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= total * p) return v; } return 255; };
        const paper = Math.max(pct(0.85), 60), ink = Math.min(pct(0.10), paper - 20);
        const hi = paper * 0.92, lo = ink + (paper - ink) * 0.35;   // hi 以上全透明，lo 以下全不透明
        for (let i = 0; i < px.length; i += 4) {
          const L = lum(i);
          let a = L >= hi ? 0 : L <= lo ? 255 : Math.round(255 * (hi - L) / (hi - lo));
          px[i + 3] = a;
          if (a) {   // 把印泥壓深一點，去底後才不會看起來灰灰的
            const k = 0.75;
            px[i] = Math.round(px[i] * k); px[i + 1] = Math.round(px[i + 1] * k); px[i + 2] = Math.round(px[i + 2] * k);
          }
        }
        ctx.putImageData(d, 0, 0);
        return cv.toDataURL('image/png');
      };
      // 兩顆章共用同一套上傳流程，只有設定鍵不同
      const bindSeal = (id, key, confirmMsg) => {
        const box = el.querySelector(`#${id}-preview`);
        const hint = el.querySelector(`#${id}-hint`);
        const draw = v => {
          box.innerHTML = v
            ? `<img src="${UI.esc(v)}" alt="印章" style="max-width:180px;max-height:110px">`
            : '尚未上傳';
        };
        draw(s[key] || '');
        const save = async v => {
          await PUT('/settings', { [key]: v });
          s[key] = v;
          draw(v);
          UI.toast(v ? '已更新' : '已移除');
        };
        el.querySelector(`#${id}-file`).onchange = async ev => {
          const f = ev.target.files[0];
          if (!f) return;
          hint.textContent = '處理中...';
          try {
            const im = await loadBitmap(f).catch(() => {
              throw new Error('這個圖檔瀏覽器解不開，請改存成 JPG 或 PNG 再上傳。');
            });
            await save(dropBackground(im));
            hint.textContent = '已去除紙張底色';
          } catch (e) {
            hint.innerHTML = `<span style="color:var(--danger)">${UI.esc(e.message)}</span>`;
          }
          ev.target.value = '';
        };
        el.querySelector(`#${id}-clear`).onclick = async () => {
          if (!s[key]) return UI.toast('目前沒有這顆章');
          if (!await UI.confirm(confirmMsg)) return;
          await save('');
        };
      };
      bindSeal('seal', 'receipt_seal_image', '移除發票章？之後收據就不會蓋這顆章。');
      bindSeal('stamp', 'receipt_stamp_image', '移除印花稅總繳章？之後會改印文字戳記。');
    }

    el.querySelector('#save').onclick = async () => {
      const data = {};
      el.querySelectorAll('.card input[name], .card textarea[name]').forEach(i => {
        if (i.type !== 'file') data[i.name] = i.value;
      });
      await PUT('/settings', data);
      UI.toast('已儲存，重新整理後生效');
    };

    const rooms = await GET('/rooms');
    const rb = el.querySelector('#rooms');
    const roomForm = r => `<div class="form-grid">
        ${UI.input('name', '名稱', { value: r ? r.name : '' })}
        ${UI.input('capacity', '容納人數', { type: 'number', value: r ? r.capacity : 1 })}
        ${UI.input('note', '備註', { value: r ? r.note : '', full: true })}
        ${r ? UI.checkbox('active', '啟用中（停用後不再被自動指派）', r.active) : ''}</div>`;
    rb.innerHTML = UI.table(['名稱', '容納人數', '備註', '狀態', ''], rooms.map(r => `<tr>
        <td>${UI.esc(r.name)}</td><td>${r.capacity}</td><td>${UI.esc(r.note)}</td>
        <td>${r.active ? UI.tag('啟用', 'ok') : UI.tag('停用')}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn tiny secondary" data-er="${r.id}">編輯</button>
          <button class="btn tiny danger" data-dr="${r.id}">刪除</button></td></tr>`)) +
      '<button class="btn small" id="ar" style="margin-top:10px">新增諮商室</button>';
    rb.querySelector('#ar').onclick = () => UI.modal({
      title: '新增諮商室', body: roomForm(null),
      onSubmit: async e => { await POST('/rooms', UI.formData(e)); UI.toast('已新增'); App.go('settings'); }
    });
    rb.querySelectorAll('[data-er]').forEach(b => {
      const r = rooms.find(x => x.id === Number(b.dataset.er));
      b.onclick = () => UI.modal({
        title: '編輯諮商室：' + r.name, body: roomForm(r),
        onSubmit: async e => { await PUT(`/rooms/${r.id}`, UI.formData(e)); UI.toast('已儲存'); App.go('settings'); }
      });
    });
    rb.querySelectorAll('[data-dr]').forEach(b => {
      const r = rooms.find(x => x.id === Number(b.dataset.dr));
      b.onclick = async () => {
        if (!await UI.confirm(`刪除諮商室「${r.name}」？曾被排過的空間會改為停用以保留歷史紀錄。`)) return;
        const res = await DEL(`/rooms/${r.id}`);
        UI.toast(res.deactivated ? `已停用（仍有 ${res.used} 筆歷史排程）` : '已刪除');
        App.go('settings');
      };
    });

    const templates = await GET('/consent-templates');
    const cb = el.querySelector('#consents');
    cb.innerHTML = UI.table(['同意書', '版本', '必要', '可不同意', '限未成年', ''], templates.map(t => `<tr>
      <td>${UI.esc(t.title)}</td><td>v${t.version}</td><td>${t.required ? '是' : '否'}</td>
      <td>${t.allow_decline ? '是' : '否'}</td><td>${t.minor_only ? '是' : '否'}</td>
      <td style="white-space:nowrap"><button class="btn tiny secondary" data-t="${t.id}">編輯</button>
        <button class="btn tiny secondary" data-tp="${t.key}">列印空白（兩聯）</button>
        <button class="btn tiny secondary" data-tw="${t.key}">匯出 Word</button>
        <button class="btn tiny danger" data-td="${t.id}">刪除</button></td></tr>`)) +
      '<div style="font-size:12.5px;color:var(--muted);margin-top:8px">修改內容會使版本遞增，已簽署者需重新簽署；舊版簽署紀錄保留全文快照。</div>';
    cb.querySelectorAll('[data-tp]').forEach(b => {
      b.onclick = () => window.open(`/api/consent-templates/${b.dataset.tp}/print`, '_blank');
    });
    cb.querySelectorAll('[data-tw]').forEach(b => {
      b.onclick = () => { location.href = `/api/consent-templates/${b.dataset.tw}/print?format=doc`; };
    });
    cb.querySelectorAll('[data-td]').forEach(b => {
      const t = templates.find(x => x.id === Number(b.dataset.td));
      b.onclick = async () => {
        if (!await UI.confirm(`刪除同意書範本「${t.title}」？已有人簽署過的範本無法刪除。`)) return;
        try { await DEL(`/consent-templates/${t.id}`); UI.toast('已刪除'); App.go('settings'); } catch (e) { UI.err(e); }
      };
    });
    cb.querySelectorAll('[data-t]').forEach(b => {
      const t = templates.find(x => x.id === Number(b.dataset.t));
      b.onclick = () => UI.modal({
        title: '編輯同意書範本', wide: true,
        body: `<div class="form-grid">${UI.input('title', '標題', { value: t.title, full: true })}
          ${UI.textarea('body', '內容', { value: t.body, rows: 16 })}
          ${UI.checkbox('required', '必要同意書', t.required)}
          ${UI.checkbox('allow_decline', '允許選擇不同意', t.allow_decline)}
          ${UI.checkbox('minor_only', '僅未成年個案需簽', t.minor_only)}</div>`,
        onSubmit: async e => { await PUT(`/consent-templates/${t.id}`, UI.formData(e)); UI.toast('已儲存'); App.go('settings'); }
      });
    });
  }
});

App.page('consents', {
  title: '同意書總覽',
  sub: '追蹤各個案的必要同意書簽署狀況',
  help: [
    '一覽各個案的必要同意書簽署狀況，缺哪張一目了然。',
    '實際簽署在個案總覽的同意書頁，可現場電子簽名。',
  ],
  module: 'consents',
  async render(el) {
    const [clients, templates] = await Promise.all([GET('/clients?status=active'), GET('/consent-templates')]);
    const details = await Promise.all(clients.map(c => GET(`/clients/${c.id}`)));
    const required = templates.filter(t => t.required);
    el.innerHTML = `<div class="card">${UI.table(
      ['個案'].concat(required.map(t => t.title.slice(0, 8))),
      details.map(c => `<tr><td><a href="#client/${c.id}">${UI.esc(c.name)}（${c.code}）</a></td>
        ${required.map(t => {
      if (t.minor_only && !c.is_minor) return '<td>—</td>';
      const s = c.consents.find(x => x.key === t.key && x.version === t.version);
      return `<td>${s ? UI.tag('已簽', 'ok') : UI.tag('未簽', 'danger')}</td>`;
    }).join('')}</tr>`), '沒有服務中的個案')}</div>`;
  }
});

// ---- 稽核軌跡 ----
App.page('audit', {
  title: '稽核軌跡',
  sub: '誰在何時調閱或異動了哪些紀錄（僅管理者可看）',
  help: [
    '誰在何時調閱或異動了哪些紀錄，僅管理者可看，用於個資稽核與爭議釐清。',
    '可依人員、動作與日期篩選。紀錄不可刪改。',
  ],
  module: 'settings',
  async render(el) {
    if (App.me.role !== 'admin') { el.innerHTML = '<div class="empty">僅管理者可檢視</div>'; return; }
    const draw = async () => {
      const rows = await GET(`/audit-logs?q=${encodeURIComponent(el.querySelector('#q').value.trim())}`);
      el.querySelector('#list').innerHTML = UI.table(['時間', '操作者', '動作', '對象', '細節'], rows.map(r => `<tr>
        <td>${UI.esc(r.created_at)}</td><td>${UI.esc(r.actor_name)}（${r.actor_type === 'client' ? '個案' : '員工'}）</td>
        <td>${UI.esc(r.action)}</td><td>${UI.esc(r.target)}</td>
        <td style="font-size:12px;color:var(--muted)">${UI.esc(r.detail)}</td></tr>`));
    };
    el.innerHTML = `<div class="toolbar"><input id="q" placeholder="搜尋動作／操作者／對象"><div class="spacer"></div></div><div id="list"></div>`;
    el.querySelector('#q').oninput = () => { clearTimeout(el._t); el._t = setTimeout(draw, 300); };
    await draw();
  }
});
