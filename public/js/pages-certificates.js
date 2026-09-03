// 證明書：在職證明書、離職證明書、治療證明。
// 開立時先套版帶出當事人資料，接著每一列的欄位名稱與內容都能直接改字、增列或刪列，
// 聲明段落、機構抬頭與核章欄位也一樣可改；存檔後可列印、匯出 PDF 或 Word 再修。

const CERT_KINDS = [
  ['employment', '在職證明書'],
  ['resignation', '離職證明書'],
  ['treatment', '治療證明'],
  ['profile', '基本資料表'],
  ['plan_detail', '方案服務明細（附表）'],
  ['referral', '方案轉介單'],
  ['referral_clinic', '轉介單（一式三聯）'],
  ['profile_minor', '未成年個案基本資料表'],
  ['early_intervention', '早療補助療育紀錄'],
  ['ei_official', '早療補助官方表單（表一～表三）'],
  ['disadv_official', '弱勢療育補助記錄卡（表件二）']
];

function certRowsEditor(id, label, rows, hint) {
  return `<div class="form-row full"><label>${UI.esc(label)}</label>
    <div id="${id}"></div>
    <button class="btn tiny secondary" type="button" data-add="${id}" style="margin-top:6px">＋ 加一列</button>
    ${hint ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${UI.esc(hint)}</div>` : ''}</div>`;
}

function certRowHtml(r) {
  return `<div class="cert-row" style="display:flex;gap:6px;margin-bottom:6px">
    <input class="lb" value="${UI.esc(r.label || '')}" placeholder="欄位名稱" style="flex:0 0 150px">
    <input class="vl" value="${UI.esc(r.value || '')}" placeholder="內容" style="flex:1">
    <button class="btn tiny danger" type="button" data-rm>移除</button></div>`;
}

function collectCertRows(el, id) {
  return Array.from(el.querySelectorAll(`#${id} .cert-row`)).map(r => ({
    label: r.querySelector('.lb').value.trim(),
    value: r.querySelector('.vl').value
  })).filter(r => r.label || r.value);
}

function certDialog(seed, onDone) {
  const isNew = !seed.id;
  const d = seed.data || {};
  UI.modal({
    title: isNew ? `開立${CERT_KINDS.find(k => k[0] === seed.kind)[1]}` : `編輯證明書 ${seed.cert_no}`,
    wide: true,
    body: `<div class="form-grid">
        ${UI.input('subject_name', '當事人姓名', { value: seed.subject_name || '', required: true })}
        ${UI.input('issue_date', '開立日期', { type: 'date', value: seed.issue_date || UI.today() })}
        ${UI.input('purpose', '用途（治療證明會代入聲明文字）', { value: seed.purpose || '', full: true })}
        ${UI.input('title', '標題', { value: d.title || '' })}
        ${UI.input('subtitle', '標題上方單位名（可留空）', { value: d.subtitle || '' })}
      </div>
      <div class="form-grid" style="margin-top:6px">
        ${certRowsEditor('c-rows', '證明內容（欄位名稱與內容都可改）', d.rows || [])}
        ${UI.input('statement_label', '聲明區塊標題（可留空）', { value: d.statement_label || '' })}
        ${UI.textarea('statement', '聲明文字', { value: d.statement || '', rows: 3, full: true })}
        ${certRowsEditor('c-org', '機構抬頭', d.org || [], '預設帶系統設定裡的所別資訊，可逐張改寫')}
        ${certRowsEditor('c-sign', '簽名／核章欄位', d.signatures || [])}
        ${UI.input('grid_label', '空白表格標題（留空則不印表格）', { value: (d.grid && d.grid.label) || '' })}
        ${UI.input('grid_headers', '空白表格欄位（逗號分隔）',
    { value: d.grid ? d.grid.headers.join('、') : '' })}
        ${UI.input('grid_rows', '表格總列數（含已帶入的資料列）', { type: 'number', value: (d.grid && d.grid.rows) || 0 })}
        ${d.grid && d.grid.data && d.grid.data.length ? `<div class="form-row full">
          <label>已帶入的表格內容（每列以逗號分隔，可直接改字）</label>
          <div id="c-grid">${d.grid.data.map(r => `<div class="cert-row" style="margin-bottom:6px">
            <input class="vl" value="${UI.esc(r.join('，'))}" style="width:100%"></div>`).join('')}</div>
        </div>` : ''}
        ${UI.input('copies', '聯別（逗號分隔，留空印一份）',
    { value: (d.copies || []).join('，'), full: true, placeholder: '第一聯 本所存根聯,第二聯 醫療端留存聯' })}
        ${UI.input('footer_date', '文末日期', { value: d.footer_date || '', full: true })}
        <div class="form-row full" style="margin-top:6px">
          <label style="font-size:13px"><input type="checkbox" id="astpl"> 同時把這份版面存成此類表單的預設內容
            （之後開立同類表單都從這裡開始；姓名、日期、療程等仍會自動帶入）</label>
          ${seed.has_saved_template ? `<button class="btn tiny secondary" type="button" id="rsttpl"
            style="align-self:flex-start;margin-top:6px">回復系統預設</button>` : ''}
        </div>
      </div>`,
    onOpen: el => {
      const fill = (id, rows) => {
        el.querySelector('#' + id).innerHTML = (rows.length ? rows : [{ label: '', value: '' }])
          .map(certRowHtml).join('');
      };
      fill('c-rows', d.rows || []);
      fill('c-org', d.org || []);
      fill('c-sign', d.signatures || []);
      const tplBox = el.querySelector('#astpl');
      if (tplBox) tplBox.onchange = () => { el._saveTemplate = tplBox.checked; };
      const rst = el.querySelector('#rsttpl');
      if (rst) {
        rst.onclick = async () => {
          if (!await UI.confirm('回復此類表單的系統預設內容？已開立的表單不受影響。')) return;
          await DEL(`/certificates/template/${seed.kind}`);
          UI.toast('已回復系統預設，請重新開立以套用');
        };
      }
      el.addEventListener('click', e => {
        const add = e.target.closest('[data-add]');
        if (add) {
          el.querySelector('#' + add.dataset.add).insertAdjacentHTML('beforeend', certRowHtml({}));
          return;
        }
        if (e.target.closest('[data-rm]')) e.target.closest('.cert-row').remove();
      });
    },
    onSubmit: async el => {
      const f = UI.formData(el);
      if (!f.subject_name.trim()) throw new Error('請填寫當事人姓名');
      const body = {
        kind: seed.kind,
        subject_id: seed.subject_id || 0,
        subject_name: f.subject_name,
        issue_date: f.issue_date,
        purpose: f.purpose,
        data: {
          title: f.title, subtitle: f.subtitle,
          rows: collectCertRows(el, 'c-rows'),
          statement_label: f.statement_label, statement: f.statement,
          org: collectCertRows(el, 'c-org'),
          signatures: collectCertRows(el, 'c-sign'),
          grid: f.grid_headers.trim() ? {
            label: f.grid_label,
            headers: f.grid_headers.split(/[,，、]/).map(x => x.trim()).filter(Boolean),
            rows: Number(f.grid_rows) || 12,
            data: Array.from(el.querySelectorAll('#c-grid .vl')).map(i => i.value.split('，'))
          } : null,
          copies: f.copies.split(/[,，]/).map(x => x.trim()).filter(Boolean),
          footer_date: f.footer_date
        }
      };
      if (el._saveTemplate) {
        await POST(`/certificates/template/${seed.kind}`, {
          data: body.data, subject_id: seed.subject_id || 0, purpose: f.purpose || ''
        });
        UI.toast('已存成這類表單的預設內容');
      }
      const r = isNew ? await POST('/certificates', body) : await PUT(`/certificates/${seed.id}`, body);
      UI.toast('已儲存');
      onDone && onDone();
      if (isNew && r.id) window.open(`/api/certificates/${r.id}/print`, '_blank');
    }
  });
}

App.page('certificates', {
  title: '證明書',
  sub: '在職證明、離職證明、治療證明與基本資料表：套版帶出資料後，每一句話都能自行改寫，再列印或匯出 Word／PDF',
  help: [
    '選類別與當事人後按「開立」，系統先帶出預設內容；欄位名稱、內容、聲明文字、機構抬頭都可以直接改，也能自行增減列。',
    '「方案服務明細（附表）」會把該個案在補助方案下已完成的晤談逐次列出（次數、日期、服務人員、面對面或通訊），民眾簽名與同意書檔名留白現場填。',
    '「轉介單（一式三聯）」用於轉介身心科／診所：一次印出本所存根聯、醫療端留存聯與醫療端回覆聯，回覆欄留給醫師勾選與簽名。',
    '「方案轉介單」會帶入機構代碼、個案基本資料與最近一次 BSRS-5 的分數，轉介原因與建議轉介機構的預設文字在系統設定改。',
    '每一種表單的文字都能長期改：在開立畫面把欄位名稱與固定文字改好，勾「存成此類表單的預設內容」，之後開立同類表單就以它為底。',
    '「未成年個案基本資料表」多了就讀學校、年級、主要照顧者、醫院評估與療育課程，背面是上課日期／時間／家長簽名／收費的空白表。',
    '學齡前走「早療補助官方表單」（社會局表一申請表＋表二交通補助蓋章卡＋表三療育補助收據浮貼卡，一次印三頁），學齡走「弱勢療育補助記錄卡」（表件二）；兩者都會把該月療程與收據號碼帶進去，注意事項文字在系統設定改。',
    '「早療補助療育紀錄」會列出該童指定月份已完成的療程（日期、療育項目、單位、人員、自費金額與收據號碼），供家長辦理早療補助時併附收據送件。',
    '「基本資料表」會帶入個案已建檔的資料，沒填的欄位印成待填的圈選或底線，背面另附可自訂欄位與列數的空白簽到表。',
    '在職／離職證明的資料取自帳號（性別、生日、到職與離職日在「帳號權限」編輯帳號時填）；治療證明的來談日期與次數由已完成的晤談自動算出。',
    '開立後可「列印／PDF」或「匯出 Word」，Word 檔可再自行排版。',
    '已交出去的證明書請用「作廢」保留紀錄，不要直接刪除。',
  ],
  visible: () => App.can('hr') || App.can('clients'),
  async render(el) {
    const draw = async () => {
      const kind = el.querySelector('#k').value;
      const q = el.querySelector('#q').value.trim();
      const d = await GET(`/certificates?kind=${kind}&q=${encodeURIComponent(q)}`);
      el.querySelector('#list').innerHTML = `<div class="card">${UI.table(
        ['編號', '類別', '當事人', '開立日期', '用途', '開立人', '狀態', ''],
        d.rows.map(r => `<tr>
          <td>${UI.esc(r.cert_no)}</td><td>${UI.esc(r.kind_label)}</td>
          <td>${UI.esc(r.subject_name)}</td><td>${r.issue_date}</td>
          <td>${UI.esc(r.purpose || '-')}</td><td>${UI.esc(r.issuer_name || '-')}</td>
          <td>${r.status === 'void' ? UI.tag('已作廢', 'danger') : UI.tag('有效', 'ok')}
            ${r.print_count ? `<span style="font-size:12px;color:var(--muted)">列印 ${r.print_count} 次</span>` : ''}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny secondary" data-print="${r.id}">列印／PDF</button>
            <button class="btn tiny secondary" data-doc="${r.id}">匯出 Word</button>
            ${r.status === 'void' ? `<button class="btn tiny danger" data-del="${r.id}">刪除</button>`
    : `<button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
               <button class="btn tiny danger" data-void="${r.id}">作廢</button>`}</td></tr>`),
        '尚未開立任何證明書')}</div>`;

      el.querySelectorAll('[data-print]').forEach(b => {
        b.onclick = () => window.open(`/api/certificates/${b.dataset.print}/print`, '_blank');
      });
      el.querySelectorAll('[data-doc]').forEach(b => {
        b.onclick = () => { location.href = `/api/certificates/${b.dataset.doc}/print?format=doc`; };
      });
      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = async () => certDialog(await GET(`/certificates/${b.dataset.edit}`), draw);
      });
      el.querySelectorAll('[data-void]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '作廢證明書',
          body: UI.textarea('reason', '作廢原因', { rows: 2 }),
          onSubmit: async e2 => {
            await POST(`/certificates/${b.dataset.void}/void`, UI.formData(e2));
            UI.toast('已作廢'); draw();
          }
        });
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除這張已作廢的證明書？')) return;
          await DEL(`/certificates/${b.dataset.del}`);
          draw();
        };
      });
    };

    el.innerHTML = `<div class="toolbar">
        <select id="k"><option value="">全部類別</option>
          ${CERT_KINDS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <input id="q" placeholder="搜尋編號、姓名或用途" style="width:220px">
        <div class="spacer"></div>
        <button class="btn" id="add">開立證明書</button>
      </div><div id="list"></div>`;
    el.querySelector('#k').onchange = draw;
    el.querySelector('#q').oninput = () => { clearTimeout(el._t); el._t = setTimeout(draw, 250); };

    el.querySelector('#add').onclick = () => UI.modal({
      title: '開立證明書',
      submitText: '帶出內容',
      body: `<div class="form-grid">
          ${UI.select('kind', '類別', CERT_KINDS, { value: 'employment' })}
          <div class="form-row full" id="pick"></div>
          ${UI.input('purpose', '用途（治療證明的「提供＿＿使用」）', { value: '', full: true })}
          ${UI.input('month', '月份（早療補助療育紀錄；留空為全部）', { type: 'month', value: '' })}
        </div>`,
      onOpen: async e2 => {
        const users = await GET('/certificates/staff-options').catch(() => []);
        const clients = await GET('/clients').catch(() => ({ rows: [] }));
        const list = Array.isArray(clients) ? clients : (clients.rows || []);
        const kind = e2.querySelector('[name=kind]');
        const pick = e2.querySelector('#pick');
        const render = () => {
          pick.innerHTML = kind.value !== 'employment' && kind.value !== 'resignation'
            ? UI.select('subject_id', '個案', [['', '不指定（自行填寫）']]
              .concat(list.map(c => [c.id, `${c.code || ''} ${c.name}`.trim()])), { full: true })
            : UI.select('subject_id', '員工', [['', '不指定（自行填寫）']]
              .concat(users.map(u => [u.id, u.name])), { full: true });
        };
        kind.onchange = render;
        render();
      },
      onSubmit: async e2 => {
        const f = UI.formData(e2);
        const tpl = await GET(`/certificates/template?kind=${f.kind}&subject_id=${f.subject_id || 0}`
          + `&purpose=${encodeURIComponent(f.purpose || '')}&month=${f.month || ''}`);
        certDialog({ ...tpl, issue_date: UI.today() }, draw);
      }
    });

    await draw();
  }
});
