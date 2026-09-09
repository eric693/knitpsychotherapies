// 收據：開立、補開、作廢重開與補印

async function showReceipt(id) {
  const r = await GET(`/receipts/${id}`);
  UI.modal({
    title: `收據 ${r.receipt_no}`, wide: true, hideFooter: true,
    body: `${Receipt.html(r)}
      <div class="toolbar" style="margin-top:14px;flex-wrap:wrap"><div class="spacer"></div>
        ${r.status === 'valid' ? '<button class="btn secondary" id="line">LINE 傳給個案</button>' : ''}
        <button class="btn secondary" data-rc="png">下載圖片</button>
        <button class="btn secondary" data-rc="pdf">下載 PDF</button>
        <button class="btn" data-rc="print">列印${r.print_count ? `（已印 ${r.print_count} 次）` : ''}</button></div>
      ${r.share_url ? `<div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        個案專用連結（LINE 卡片上的按鈕就是開這一條，作廢或重開後即失效）：<br>
        <span style="word-break:break-all">${UI.esc(r.share_url)}</span></div>` : ''}`,
    onOpen: body => {
      const node = body.querySelector('#printable');
      Receipt.bindExport(body, node, r, () => POST(`/receipts/${id}/printed`).catch(() => {}));
      const lb = body.querySelector('#line');
      // 傳給個案的是「收據本身的圖」，不是摘要卡片 —— 要申請保險的個案需要的是憑證本身。
      // 圖在瀏覽器這邊產生後上傳，伺服器再給 LINE 一條公開網址。
      if (lb) lb.onclick = async () => {
        lb.disabled = true;
        const was = lb.textContent;
        lb.textContent = '產生收據圖…';
        try {
          const fd = new FormData();
          fd.append('image', await Receipt.toPngBlob(node), `${r.receipt_no}.png`);
          lb.textContent = '傳送中…';
          const o = await POST(`/receipts/${id}/line`, fd);
          UI.toast(o.message || '已傳送');
        } catch (e) { UI.err(e); } finally { lb.disabled = false; lb.textContent = was; }
      };
    }
  });
}

// invs：要開在同一張收據上的收費單（一筆是原本的行為，多筆就是合併開立）
function issueDialog(invs, onDone) {
  const list = Array.isArray(invs) ? invs : (invs ? [invs] : []);
  const inv = list[0] || null;
  const merged = list.length > 1;
  const total = list.reduce((a, v) => a + v.amount, 0);
  const dates = list.map(v => v.service_date || v.date).filter(Boolean).sort();
  const span = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0]
    : `${dates[0]} ~ ${dates[dates.length - 1]}`) : UI.today();
  UI.modal({
    title: merged ? `合併開立收據：${inv.client_name}（${list.length} 筆）`
      : (inv ? `開立收據：${inv.client_name}` : '手動開立收據'),
    wide: true,
    body: `${merged ? `<div class="notice" style="margin-bottom:10px">
        合併 ${list.length} 筆收費單開成一張收據，合計 ${UI.fmtMoney(total)}；
        收據上會逐筆列出每次的服務日期與金額（申請保險時對方要看得到明細）。
        金額由系統加總，不可手改。<br>
        ${list.map(v => `${UI.esc(v.service_date || v.date)}　${UI.esc(v.item)}　${UI.fmtMoney(v.amount)}`).join('<br>')}
      </div>` : ''}
    <div class="form-grid">
      ${inv ? '' : '<div class="form-row full" id="cli-row"></div>'}
      ${UI.input('date', '收據日期', { type: 'date', value: UI.today() })}
      ${merged ? `<div class="form-row"><label>金額（${list.length} 筆合計）</label>
        <input value="${UI.fmtMoney(total)}" disabled></div>`
    : UI.input('amount', '金額', { type: 'number', value: inv ? inv.amount : 0 })}
      ${UI.input('title', '抬頭（可改為公司或家長姓名）', { value: inv ? inv.client_name : '', full: true })}
      ${UI.input('tax_id', '統一編號（報帳用，可留空）', { value: '' })}
      ${UI.inputList('method', '付款方式', App.meta.pay_methods || [], { value: inv ? inv.method : '現金' })}
      ${UI.input('item', '服務項目', {
    value: merged ? `心理諮商服務費（${list.length} 次）` : (inv ? inv.item : '心理諮商服務費'), full: true })}
      ${merged ? `<div class="form-row"><label>服務（晤談）日期</label><input value="${UI.esc(span)}" disabled></div>`
    : UI.input('service_date', '服務（晤談）日期', { type: 'date', value: inv ? (inv.service_date || inv.date) : UI.today() })}
      ${UI.textarea('note', '備註', { value: '' })}
    </div>`,
    onOpen: async body => {
      const row = body.querySelector('#cli-row');
      if (row) {
        const opts = await App.clientOptions(true);
        row.innerHTML = `<label>個案</label><select name="client_id">${opts
          .map(o => `<option value="${o[0]}">${UI.esc(o[1])}</option>`).join('')}</select>`;
      }
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      if (list.length) data.invoice_ids = list.map(v => v.id);
      if (merged) { delete data.amount; delete data.service_date; }
      const r = await POST('/receipts', data);
      UI.toast(`已開立收據 ${r.receipt_no}`);
      onDone && onDone();
      showReceipt(r.id);
    }
  });
}

App.page('receipts', {
  title: '收據',
  sub: '晤談結束後個案要收據就開一張；事後要補開、補印或重開都在這裡',
  help: [
    '上半部是已收款但還沒開收據的收費單，個案要收據就按「開立收據」。',
    '同一位個案要把好幾次併成一張（報稅或申請保險常這樣要求）：勾選那幾筆再按「合併開立」。收據上會逐筆列出每次的服務日期與金額，總額為加總，金額由系統算不可手改。',
    '檢視收據時可「下載 PDF」「下載圖片」或「列印」；「LINE 傳給個案」送出的是收據本身的圖，個案存下來就能拿去申請保險，卡片上另附一條可開啟完整收據的連結。',
    '下半部是已開立的收據：金額打錯用「編輯」或「重開」，整張不要了按「作廢」。作廢或重開後，先前給個案的連結與圖片會立刻失效。',
    '作廢的收據會留存不刪除，重開會產生新號碼。',
  ],
  module: 'billing',
  async render(el) {
    const [data, pending] = await Promise.all([GET('/receipts'), GET('/receipts/pending')]);
    el.innerHTML = `<div class="toolbar">
        <input id="q" placeholder="收據編號／個案／抬頭" value="">
        <input type="date" id="from"><input type="date" id="to">
        <button class="btn secondary" id="search">查詢</button>
        <div class="spacer"></div>
        <button class="btn" id="add">手動開立</button></div>

      <div class="card"><h3>待開立（已收款但尚未開收據）
          <span style="font-size:13px;font-weight:400;color:var(--muted)">個案回頭要收據時，直接從這裡補開</span></h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
          同一位個案要把好幾次併成一張收據（報稅、申請保險常這樣要求）：
          勾選那幾筆再按「合併開立」，收據上會逐筆列出日期與金額，總額為加總。</div>
        ${UI.table(['', '收款日', '個案', '項目', '方案', '金額', ''], pending.map(i => `<tr>
          <td><input type="checkbox" class="pk-inv" data-c="${i.client_id}" value="${i.id}" style="width:auto"></td>
          <td>${(i.paid_at || i.date).slice(0, 10)}</td>
          <td>${UI.esc(i.client_name)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(i.client_code)}</span></td>
          <td>${UI.esc(i.item)}</td><td>${UI.esc(i.plan_name || '-')}</td>
          <td>${UI.fmtMoney(i.amount)}</td>
          <td><button class="btn tiny" data-issue="${i.id}">開立收據</button></td></tr>`), '沒有待開立的收費單')}
        <div class="toolbar" style="margin-top:10px">
          <span id="pk-info" style="font-size:13px;color:var(--muted)">尚未勾選</span>
          <div class="spacer"></div>
          <button class="btn secondary" id="merge" disabled>合併開立</button></div></div>

      <div class="card"><h3>已開立收據
          <span style="font-size:13px;font-weight:400;color:var(--muted)">有效合計 ${UI.fmtMoney(data.total_amount)}</span></h3>
        ${UI.table(['收據編號', '日期', '個案', '抬頭', '項目', '金額', '狀態', ''], data.rows.map(r => `<tr>
          <td><strong>${UI.esc(r.receipt_no)}</strong>${r.reissue_of ? `<br><span style="font-size:12px;color:var(--muted)">重開自 ${UI.esc(r.reissue_of)}</span>` : ''}</td>
          <td>${r.date}</td>
          <td>${UI.esc(r.client_name)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(r.client_code)}</span></td>
          <td>${UI.esc(r.title)}${r.tax_id ? `<br><span style="font-size:12px;color:var(--muted)">統編 ${UI.esc(r.tax_id)}</span>` : ''}</td>
          <td>${UI.esc(r.item)}</td>
          <td>${UI.fmtMoney(r.amount)}</td>
          <td>${r.status === 'valid' ? UI.tag('有效', 'ok') : UI.tag('已作廢', 'danger')}
            ${r.print_count ? `<br><span style="font-size:12px;color:var(--muted)">已印 ${r.print_count} 次</span>` : ''}</td>
          <td style="white-space:nowrap"><button class="btn tiny secondary" data-v="${r.id}">檢視／列印</button>
            ${r.status === 'valid' ? `<button class="btn tiny secondary" data-ed="${r.id}">編輯</button>
              <button class="btn tiny secondary" data-re="${r.id}">重開</button>
              <button class="btn tiny danger" data-void="${r.id}">作廢</button>`
    : `<button class="btn tiny secondary" data-unvoid="${r.id}">↺ 撤銷作廢</button>`}</td></tr>`), '尚無收據')}</div>`;

    const reload = () => App.go('receipts');
    el.querySelector('#add').onclick = () => issueDialog(null, reload);
    // 作廢按錯時可撤銷；若已經重開過新號，會請你先處理那一張
    el.querySelectorAll('[data-unvoid]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('撤銷作廢，讓這張收據恢復為有效？')) return;
        try { await POST(`/receipts/${b.dataset.unvoid}/unvoid`, {}); UI.toast('已撤銷作廢'); reload(); } catch (e) { UI.err(e); }
      };
    });
    // 抬頭、統編、項目與備註可直接修正；編號、金額與日期屬憑證要素，要改就得作廢重開
    el.querySelectorAll('[data-ed]').forEach(b => {
      const r = data.rows.find(x => x.id === Number(b.dataset.ed));
      b.onclick = () => UI.modal({
        title: `編輯收據 ${r.receipt_no}`,
        body: `<div class="form-grid">
            ${UI.input('title', '抬頭', { value: r.title, full: true })}
            ${UI.input('tax_id', '統一編號（8 碼，可留空）', { value: r.tax_id || '' })}
            ${UI.input('item', '項目', { value: r.item })}
            ${UI.textarea('note', '備註', { value: r.note || '' })}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            金額 ${UI.fmtMoney(r.amount)}、日期 ${r.date} 與收據編號屬憑證要素，不可修改；
            這些要更正請用「重開」另立新號。修改內容會記入稽核軌跡。</div>`,
        onSubmit: async e => { await PUT(`/receipts/${r.id}`, UI.formData(e)); UI.toast('已更新'); reload(); }
      });
    });
    el.querySelector('#search').onclick = async () => {
      const q = new URLSearchParams({
        q: el.querySelector('#q').value.trim(),
        from: el.querySelector('#from').value,
        to: el.querySelector('#to').value
      });
      const d = await GET('/receipts?' + q.toString());
      UI.modal({
        title: '查詢結果', wide: true, hideFooter: true,
        body: UI.table(['收據編號', '日期', '個案', '金額', '狀態', ''], d.rows.map(r => `<tr>
          <td>${UI.esc(r.receipt_no)}</td><td>${r.date}</td><td>${UI.esc(r.client_name)}</td>
          <td>${UI.fmtMoney(r.amount)}</td>
          <td>${r.status === 'valid' ? '有效' : '已作廢'}</td>
          <td><button class="btn tiny" data-v2="${r.id}">檢視</button></td></tr>`), '查無資料'),
        onOpen: body => body.querySelectorAll('[data-v2]').forEach(b => { b.onclick = () => showReceipt(b.dataset.v2); })
      });
    };
    el.querySelectorAll('[data-issue]').forEach(b => {
      b.onclick = () => issueDialog(pending.find(i => i.id === Number(b.dataset.issue)), reload);
    });
    // 合併只在同一位個案之內成立：憑證的抬頭與個案編號只有一個，混不得。
    // 勾到第二位個案時直接講清楚，不要等按下去才被退。
    const boxes = [...el.querySelectorAll('.pk-inv')];
    const mergeBtn = el.querySelector('#merge');
    const info = el.querySelector('#pk-info');
    const sync = () => {
      const on = boxes.filter(b => b.checked);
      const rows = on.map(b => pending.find(i => i.id === Number(b.value)));
      const clients = new Set(on.map(b => b.dataset.c));
      const sum = rows.reduce((a, v) => a + v.amount, 0);
      if (!on.length) { info.textContent = '尚未勾選'; mergeBtn.disabled = true; return; }
      if (clients.size > 1) {
        info.innerHTML = '<span style="color:var(--danger)">勾選的不是同一位個案，無法合併</span>';
        mergeBtn.disabled = true;
        return;
      }
      info.textContent = `已勾選 ${on.length} 筆　${rows[0].client_name}　合計 ${UI.fmtMoney(sum)}`;
      mergeBtn.disabled = on.length < 2;
    };
    boxes.forEach(b => { b.onchange = sync; });
    mergeBtn.onclick = () => issueDialog(
      boxes.filter(b => b.checked).map(b => pending.find(i => i.id === Number(b.value))), reload);
    el.querySelectorAll('[data-v]').forEach(b => { b.onclick = () => showReceipt(b.dataset.v); });
    el.querySelectorAll('[data-void]').forEach(b => {
      b.onclick = () => UI.modal({
        title: '作廢收據',
        body: `<div class="form-grid">${UI.input('reason', '作廢原因', { full: true, required: true })}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            憑證不可塗改，作廢後號碼不再使用；若個案仍需收據，請改用「重開」。</div>`,
        onSubmit: async e => { await POST(`/receipts/${b.dataset.void}/void`, UI.formData(e)); UI.toast('已作廢'); reload(); }
      });
    });
    el.querySelectorAll('[data-re]').forEach(b => {
      b.onclick = () => UI.modal({
        title: '重開收據',
        body: `<div class="form-grid">
          ${UI.input('reason', '重開原因', { full: true, value: '抬頭或內容更正' })}
          ${UI.input('title', '新抬頭（留空沿用原本）', { full: true })}
          ${UI.input('tax_id', '統一編號（留空沿用原本）')}
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          原收據將作廢並與新收據互相勾稽，兩張都查得到。</div>`,
        onSubmit: async e => {
          const d = UI.formData(e);
          if (!d.title) delete d.title;
          if (!d.tax_id) delete d.tax_id;
          const r = await POST(`/receipts/${b.dataset.re}/reissue`, d);
          UI.toast(`已重開為 ${r.receipt_no}`);
          reload();
        }
      });
    });
  }
});
