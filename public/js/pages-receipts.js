// 收據：開立、補開、作廢重開與補印

// 印花稅總繳戳記：內容取自系統設定，與所內用印的戳章一致
function stampHtml(r) {
  if (String(r.receipt_stamp_enabled ?? '1') === '0') return '';
  // 有上傳實體印花章的掃描圖就直接蓋圖，沒有才用文字戳記
  if (r.receipt_stamp_image) {
    return `<img src="${UI.esc(r.receipt_stamp_image)}" alt="印花稅總繳章"
      style="width:150px;height:auto;mix-blend-mode:multiply">`;
  }
  return `<div style="display:inline-block;border:1.5px solid #1f3f8f;color:#1f3f8f;
      padding:6px 12px;font-size:12.5px;font-weight:600;line-height:1.7;text-align:center">
    <div>${UI.esc(r.center_name || '')}</div>
    <div>${UI.esc(r.receipt_stamp_note || '')}</div>
    <div>${UI.esc(r.receipt_stamp_authority || '')}</div>
    <div>負責總繳人：${UI.esc(r.receipt_stamp_payer || r.center_director || '')}</div>
  </div>`;
}

// 發票章（統一編號章）：後台上傳的掃描圖，沒上傳就不印，不會出現破圖
function sealHtml(r, size) {
  if (!r.receipt_seal_image) return '';
  return `<img src="${UI.esc(r.receipt_seal_image)}" alt="諮商所發票章"
    style="width:${size || 108}px;height:auto;mix-blend-mode:multiply">`;
}

function receiptHtml(r) {
  const money = v => 'NT$ ' + Number(v || 0).toLocaleString('zh-TW');
  return `<div id="printable" style="font-size:14px;line-height:2;max-width:640px;margin:0 auto">
    <div style="text-align:center">
      <div style="font-size:19px;font-weight:700">${UI.esc(r.center_name || '')}</div>
      <div style="font-size:12.5px;color:#6b7a85">
        ${UI.esc(r.center_address || '')}${r.center_phone ? '　電話 ' + UI.esc(r.center_phone) : ''}
        ${r.center_license_no ? '<br>開業執照字號：' + UI.esc(r.center_license_no) : ''}
        ${r.center_tax_id ? '　統一編號：' + UI.esc(r.center_tax_id) : ''}</div>
      <div style="font-size:17px;font-weight:700;margin:10px 0 4px;letter-spacing:4px">
        ${UI.esc(r.receipt_title || '心理諮商服務費收據')}</div>
      ${r.status === 'void' ? '<div style="color:#d9534f;font-weight:700">（本張已作廢）</div>' : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:10px">
      <tr><td style="width:110px;color:#6b7a85">收據編號</td><td><strong>${UI.esc(r.receipt_no)}</strong></td>
        <td style="width:80px;color:#6b7a85">日期</td><td>${UI.esc(r.date)}</td></tr>
      <tr><td style="color:#6b7a85">抬頭</td><td>${UI.esc(r.title || r.client_name)}</td>
        <td style="color:#6b7a85">統一編號</td>
        <td><div style="display:flex;align-items:center;gap:10px">
          <span>${UI.esc(r.tax_id || '－')}</span>${sealHtml(r, 96)}</div></td></tr>
      <tr><td style="color:#6b7a85">個案編號</td><td>${UI.esc(r.client_code || '')}</td>
        <td style="color:#6b7a85">服務日期</td><td>${UI.esc(r.service_date || r.date)}</td></tr>
      <tr><td style="color:#6b7a85">服務項目</td><td colspan="3">${UI.esc(r.item)}
        ${r.plan_name ? '（' + UI.esc(r.plan_name) + '）' : ''}</td></tr>
      <tr><td style="color:#6b7a85">心理師</td><td>${UI.esc(r.counselor_name || '－')}</td>
        <td style="color:#6b7a85">付款方式</td><td>${UI.esc(r.method || '－')}</td></tr>
    </table>
    <div style="border-top:1px solid #c9d2d9;border-bottom:1px solid #c9d2d9;margin-top:10px;padding:10px 0;
      font-size:20px;font-weight:700;text-align:right">${money(r.amount)}</div>
    ${r.reissue_of ? `<div style="font-size:12.5px;color:#6b7a85">（本張係重開，原收據編號 ${UI.esc(r.reissue_of)}）</div>` : ''}
    ${r.note ? `<div style="font-size:13px;margin-top:6px">備註：${UI.nl2br(r.note)}</div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:26px;font-size:13.5px">
      <div>開立人：${UI.esc(r.issuer_name || '')}</div>
      <div style="display:flex;align-items:center;gap:12px">
        <span>負責心理師：${UI.esc(r.center_director || '')}　　（用印）</span>
        ${stampHtml(r)}
      </div>
    </div>
    <div style="font-size:12px;color:#6b7a85;margin-top:16px">${UI.esc(r.receipt_footer || '')}</div>
  </div>`;
}

async function showReceipt(id) {
  const r = await GET(`/receipts/${id}`);
  UI.modal({
    title: `收據 ${r.receipt_no}`, wide: true, hideFooter: true,
    body: `${receiptHtml(r)}
      <div class="toolbar" style="margin-top:14px"><div class="spacer"></div>
        ${r.status === 'valid' ? '<button class="btn secondary" id="line">LINE 傳給個案</button>' : ''}
        <button class="btn" id="pr">列印${r.print_count ? `（已印 ${r.print_count} 次）` : ''}</button></div>`,
    onOpen: body => {
      body.querySelector('#pr').onclick = async () => {
        await POST(`/receipts/${id}/printed`).catch(() => {});
        window.print();
      };
      const lb = body.querySelector('#line');
      if (lb) lb.onclick = async () => { const o = await POST(`/receipts/${id}/line`); UI.toast(o.message); };
    }
  });
}

function issueDialog(inv, onDone) {
  UI.modal({
    title: inv ? `開立收據：${inv.client_name}` : '手動開立收據',
    wide: true,
    body: `<div class="form-grid">
      ${inv ? '' : '<div class="form-row full" id="cli-row"></div>'}
      ${UI.input('date', '收據日期', { type: 'date', value: UI.today() })}
      ${UI.input('amount', '金額', { type: 'number', value: inv ? inv.amount : 0 })}
      ${UI.input('title', '抬頭（可改為公司或家長姓名）', { value: inv ? inv.client_name : '', full: true })}
      ${UI.input('tax_id', '統一編號（報帳用，可留空）', { value: '' })}
      ${UI.inputList('method', '付款方式', App.meta.pay_methods || [], { value: inv ? inv.method : '現金' })}
      ${UI.input('item', '服務項目', { value: inv ? inv.item : '心理諮商服務費', full: true })}
      ${UI.input('service_date', '服務（晤談）日期', { type: 'date', value: inv ? (inv.service_date || inv.date) : UI.today() })}
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
      if (inv) data.invoice_id = inv.id;
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
    '下半部是已開立的收據：可「檢視／列印」、「LINE 傳給個案」、金額打錯用「編輯」或「重開」，整張不要了按「作廢」。',
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
        ${UI.table(['收款日', '個案', '項目', '方案', '金額', ''], pending.map(i => `<tr>
          <td>${(i.paid_at || i.date).slice(0, 10)}</td>
          <td>${UI.esc(i.client_name)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(i.client_code)}</span></td>
          <td>${UI.esc(i.item)}</td><td>${UI.esc(i.plan_name || '-')}</td>
          <td>${UI.fmtMoney(i.amount)}</td>
          <td><button class="btn tiny" data-issue="${i.id}">開立收據</button></td></tr>`), '沒有待開立的收費單')}</div>

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
