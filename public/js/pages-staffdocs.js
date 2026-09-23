// 所方 ↔ 心理師：文件下載，以及當月報酬的月結確認（手寫簽名）。
//
// 這兩件事原本都靠人工來回 —— 表單用 LINE 傳、薪資一個一個問。
// 放在同一組頁面，心理師登入後一個地方就找得到「我要的檔案」與「我這個月領多少」。

// ---- 手寫簽名板 ----
// 手機用手指、電腦用滑鼠都要能簽。存出來是 PNG data URI，直接貼進報酬單列印。
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#16324a';
  let drawing = false, dirty = false;
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = e => { drawing = true; dirty = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = e => {
    if (!drawing) return;
    e.preventDefault();               // 手指在簽名板上滑動時不要跟著捲整頁
    const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
  };
  const end = () => { drawing = false; };
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  document.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: true });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
  return {
    get dirty() { return dirty; },
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
    toPng() { return canvas.toDataURL('image/png'); }
  };
}

// ---- 文件 ----
function docDialog(d, cats, onDone) {
  const isNew = !d;
  UI.modal({
    title: isNew ? '新增文件' : `編輯文件：${d.title}`,
    body: `<div class="form-grid">
        ${UI.input('title', '文件名稱', { value: d ? d.title : '', required: true, full: true })}
        ${UI.inputList('category', '分類', cats, { value: d ? d.category : '' })}
        ${UI.input('version', '版本／版次', { value: d ? d.version : '', placeholder: '如 v2 或 114 年版' })}
        ${UI.input('sort', '排序', { type: 'number', value: d ? d.sort : 0 })}
        ${UI.textarea('note', '說明（什麼時候用、要注意什麼）', { value: d ? d.note : '' })}
        <div class="form-row full"><label>檔案${isNew ? '' : '（不選就沿用原檔）'}</label>
          <input type="file" id="f"></div>
        ${UI.input('url', '或改放外部連結', { value: d ? d.url : '', full: true,
    placeholder: 'https://…（衛生局表單等；填了就不必上傳檔案）' })}
        ${isNew ? '' : UI.checkbox('active', '啟用中（取消勾選後心理師就看不到）', d.active)}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        換新版請直接在這裡換檔並改版本號，心理師下載到的永遠是現行版本；
        要保留舊版就另開一筆，把舊的取消啟用。</div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      const file = el.querySelector('#f').files[0];
      const fd = new FormData();
      for (const [k, v] of Object.entries(data)) fd.append(k, v);
      if (file) fd.append('file', file);
      if (isNew) await POST('/staff-documents', fd);
      else await PUT(`/staff-documents/${d.id}`, fd);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('documents', {
  title: '文件與表單',
  sub: '所方提供的機構紀錄格式、空白表單與作業規範，隨時下載最新版',
  help: [
    '所方在這裡放最新版的機構紀錄格式、空白表單、作業規範與合約範本，心理師自行下載。',
    '每一筆都標了版本與更新時間，手上那份是不是最新的一眼看得出來。',
    '有行政或設定權限的人可「新增文件」；換新版直接在該筆換檔並改版本號，不要另外用 LINE 傳。',
    '舊版要留存就另開一筆並把舊的取消啟用 —— 停用後心理師的清單就不會再出現它。',
  ],
  async render(el) {
    const d = await GET('/staff-documents');
    const groups = [...new Set(d.rows.map(r => r.category || '未分類'))];
    const size = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
    el.innerHTML = `${d.can_manage ? `<div class="toolbar"><div class="spacer"></div>
        <button class="btn" id="add">新增文件</button></div>` : ''}
      ${d.rows.length ? groups.map(g => `<div class="card"><h3>${UI.esc(g)}</h3>
        ${UI.table(['文件', '版本', '更新時間', ''], d.rows.filter(r => (r.category || '未分類') === g).map(r => `<tr>
          <td><strong>${UI.esc(r.title)}</strong>${r.active ? '' : ' ' + UI.tag('已停用', 'warn')}
            ${r.note ? `<br><span style="font-size:12.5px;color:var(--muted)">${UI.nl2br(r.note)}</span>` : ''}
            ${r.orig_name ? `<br><span style="font-size:12px;color:var(--muted)">${UI.esc(r.orig_name)}　${size(r.size)}</span>` : ''}
            ${r.url ? `<br><span style="font-size:12px;color:var(--muted)">外部連結</span>` : ''}</td>
          <td>${UI.esc(r.version || '－')}</td>
          <td style="font-size:12.5px">${UI.esc((r.updated_at || '').slice(0, 16))}
            ${r.uploader_name ? `<br><span style="color:var(--muted)">${UI.esc(r.uploader_name)}</span>` : ''}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny" data-dl="${r.id}">下載</button>
            ${d.can_manage ? `<button class="btn tiny secondary" data-ed="${r.id}">編輯</button>
              <button class="btn tiny danger" data-del="${r.id}">刪除</button>` : ''}</td></tr>`))}
      </div>`).join('') : '<div class="card"><div class="empty">目前沒有文件</div></div>'}`;
    const reload = () => App.go('documents');
    if (d.can_manage) {
      el.querySelector('#add').onclick = () => docDialog(null, d.categories, reload);
      el.querySelectorAll('[data-ed]').forEach(b => {
        b.onclick = () => docDialog(d.rows.find(r => r.id === Number(b.dataset.ed)), d.categories, reload);
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          const r = d.rows.find(x => x.id === Number(b.dataset.del));
          if (!await UI.confirm(`刪除「${r.title}」？檔案會一併移除，無法復原。`)) return;
          try { await DEL(`/staff-documents/${r.id}`); UI.toast('已刪除'); reload(); } catch (e) { UI.err(e); }
        };
      });
    }
    el.querySelectorAll('[data-dl]').forEach(b => {
      b.onclick = () => { window.location.href = `/api/staff-documents/${b.dataset.dl}/download`; };
    });
  }
});

// ---- 我的月結確認 ----
App.page('my-payout', {
  title: '我的報酬確認',
  sub: '每月的鐘點與扣繳明細，核對無誤後線上簽名，所方才會撥款',
  help: [
    '所方結算完會把當月明細送過來，這裡列出每一筆的日期、項目、金額與代扣，最下方是實付合計。',
    '核對無誤請在簽名欄手寫簽名再按「確認無誤」；<strong>確認後所方才會撥款</strong>，簽名會直接印在勞務報酬單上，不必再簽紙本。',
    '金額有問題請按「有疑義」並寫清楚哪裡不對，行政查完會重新送一份給你確認。',
    '下方「本月服務收支」與「服務明細」是系統依你這個月的晤談與方案拆帳算出來的，'
      + '可以跟上方報酬單的金額互相對照；有落差就按「有疑義」。',
    '機構案要等對方撥款，所方才會把那幾場的報酬併入付款。明細的「撥款」欄看得出每一場的錢到了沒有，'
      + '未撥款的場次會另外標出金額，不是漏算。',
    '上方可切換月份，看得到過去已確認的紀錄。',
  ],
  async render(el, arg) {
    const q = /^\d{4}-\d{2}$/.test(arg || '') ? `?month=${arg}` : '';
    const d = await GET('/my/payout-months' + q);
    // 服務收支是系統即時算的，報酬單是行政開的，兩者分開取：對不上時心理師才看得出來要問什麼。
    // 取不到時要講出來，不能安靜地少兩張卡 —— 那會讓人以為功能沒做，實際上是這支 API 出錯了
    // （例如剛改版、前端已更新但服務還沒重啟的那幾秒）。
    let inc = null, incErr = '';
    try { inc = await GET('/my/income?month=' + d.month); } catch (e) { incErr = e.message; }
    const money = v => UI.fmtMoney(v);
    const state = { sent: UI.tag('待你確認', 'warn'), confirmed: UI.tag('已確認', 'ok'),
      disputed: UI.tag('已回報疑義', 'danger') }[d.confirm_status] || UI.tag('尚未送出', 'warn');
    el.innerHTML = `<div class="toolbar">
        <label style="font-size:13px">月份</label>
        <select id="m">${(d.months.length ? d.months : [d.month])
    .map(m => `<option value="${m}"${m === d.month ? ' selected' : ''}>${m}</option>`).join('')}</select>
        <div class="spacer"></div>${state}</div>

      <div class="card"><h3>${d.month} 報酬明細</h3>
        ${UI.table(['日期', '項目', '人次', '給付總額', '代扣所得稅', '二代健保', '實付'],
    d.rows.map(r => `<tr><td>${UI.esc(r.pay_date || '－')}</td>
          <td>${UI.esc(r.item || '')}${r.extra_amount
    ? `<br><span style="font-size:12px;color:var(--muted)">＋${UI.esc(r.extra_item || '獎金')}</span>` : ''}</td>
          <td>${r.sessions || '－'}</td>
          <td>${money(r.gross)}${r.extra_amount
    // 獎金與鐘點分列，心理師看得出這筆錢的組成；代扣是以合計去算的
    ? `<br><span style="font-size:12px;color:var(--muted)">鐘點 ${money(r.base_amount)}
        ／${UI.esc(r.extra_item || '獎金')} ${money(r.extra_amount)}</span>` : ''}</td>
          <td>${money(r.withholding)}</td>
          <td>${money(r.nhi_supplement)}</td><td><strong>${money(r.net)}</strong></td></tr>`), '這個月沒有報酬單')}
        ${d.count ? `<div style="text-align:right;margin-top:10px;font-size:15px">
          給付總額 ${money(d.gross)}　代扣 ${money(d.withholding + d.nhi_supplement)}　
          <strong style="font-size:18px">實付合計 ${money(d.net)}</strong></div>` : ''}
      </div>

      ${incErr ? `<div class="card"><h3>${d.month} 本月服務收支</h3>
        <div class="notice">這一區暫時載入不出來：${UI.esc(incErr)}<br>
          請先重新整理頁面；若剛好遇到系統改版，等一下再進來就會正常。
          上方的報酬明細不受影響。</div></div>` : ''}
      ${inc ? `<div class="card"><h3>${d.month} 本月服務收支
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            系統依你的晤談與方案拆帳即時計算，用來對照上方報酬單</span></h3>
        ${UI.table(['方案', '完成', '未到', '服務總額', '方案給付', '個案自付', '場地費', '我的報酬'],
    inc.plans.map(p => `<tr><td>${UI.esc(p.plan_name)}</td>
          <td>${p.sessions}</td><td>${p.no_shows || '－'}</td>
          <td>${money(p.gross)}</td><td>${money(p.subsidy)}</td><td>${money(p.self_pay)}</td>
          <td>${money(p.venue)}</td><td><strong>${money(p.share)}</strong></td></tr>`),
    '這個月沒有已完成的晤談')}
        ${inc.total.sessions || inc.total.no_shows ? `<div style="text-align:right;margin-top:10px;font-size:15px">
          完成 ${inc.total.sessions} 場${inc.total.no_shows ? `（未到 ${inc.total.no_shows} 場）` : ''}　
          服務總額 ${money(inc.total.gross)}　
          <strong style="font-size:18px">我的報酬合計 ${money(inc.total.share)}</strong></div>
        ${inc.total.unsettled_share ? `<div class="notice" style="margin-top:10px">
          其中 <strong>${inc.total.unsettled_sessions} 場尚未撥款</strong>，
          對應報酬 <strong>${money(inc.total.unsettled_share)}</strong>（機構案等對方入帳、自費案等收款）。
          這部分通常不列入本月付款，會在錢進來的月份併入結算 ——
          已可付的部分為 ${money(inc.total.settled_share)}。</div>` : ''}
        ${d.count ? `<div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          上方報酬單給付總額 ${money(d.gross)}　系統試算我的報酬 ${money(inc.total.share)}
          ${d.gross !== inc.total.share
    ? `　<span style="color:var(--warn)">差額 ${money(Math.abs(d.gross - inc.total.share))}</span>
             —— 若所方是先扣掉未撥款的場次，或另有加減項，兩個數字本來就會不同；看不出原因請按「有疑義」。`
    : '　兩者一致。'}</div>` : ''}` : ''}
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
          報酬以「服務總額 − 場地費」為基數，依方案設定的比例或鐘點費計算，
          並在晤談按下「完成」當下鎖定；事後改方案設定不會回頭變動已結算的月份。</div>
      </div>

      <div class="card"><h3>${d.month} 服務明細
          <span style="font-size:13px;font-weight:400;color:var(--muted)">逐筆核對哪幾場、每場多少</span></h3>
        <div style="overflow-x:auto">
        ${UI.table(['日期', '時間', '個案', '方案／主題', '狀態', '個案自付', '方案給付', '我的報酬', '撥款'],
    inc.rows.map(r => {
      const label = r.funding_channel === 'partner'
        ? (r.funding_status === 'none' ? '未開請款單' : (TW.settle_status[r.funding_status] || r.funding_status))
        : (r.funding_status === 'none' ? '未開收費單' : (TW.inv_status[r.funding_status] || r.funding_status));
      return `<tr><td>${r.date}</td><td>${(r.start_time || '').slice(0, 5)}</td>
          <td>${UI.esc(r.client_code || '')} ${UI.esc(r.client_name || '')}</td>
          <td>${UI.esc(r.plan_name || '－')}${r.topic_name ? '／' + UI.esc(r.topic_name) : ''}
            ${r.partner_name ? `<br><span style="font-size:12px;color:var(--muted)">${UI.esc(r.partner_name)}</span>` : ''}</td>
          <td>${TW.appt_status[r.status] || r.status}</td>
          <td>${money(r.self_pay)}</td><td>${money(r.subsidy)}</td>
          <td><strong>${money(r.share)}</strong></td>
          <td>${r.settled ? UI.tag(label, 'ok') : UI.tag(label, 'warn')}</td></tr>`;
    }), '這個月沒有已完成的晤談')}
        </div>
      </div>` : ''}

      ${d.handled_note ? `<div class="notice" style="margin-bottom:12px">
        行政已處理你先前回報的疑義：${UI.esc(d.handled_note)}<br>請重新核對後確認。</div>` : ''}

      ${d.confirm_status === 'confirmed' ? `<div class="card"><h3>已確認</h3>
        <div style="font-size:14px">確認時間：${UI.esc(d.confirmed_at)}</div>
        ${d.sign_image ? `<img src="${UI.esc(d.sign_image)}" alt="我的簽名"
          style="height:70px;margin-top:8px;background:#fff;border:1px solid var(--border);border-radius:8px">` : ''}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          這個簽名會印在該月的勞務報酬單上。如需更正請洽行政重新送出。</div></div>`
    : d.confirm_status === 'disputed' ? `<div class="card"><h3>已回報疑義</h3>
        <div style="font-size:14px;white-space:pre-wrap">${UI.esc(d.reply_note)}</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">行政處理後會再送一份給你確認。</div></div>`
    : d.confirm_status === 'sent' ? `<div class="card"><h3>確認無誤</h3>
        <div style="font-size:13.5px;color:var(--muted);margin-bottom:8px">
          請在下方框內簽名（手機可直接用手指），簽完按「確認無誤」。確認後所方才會撥款。</div>
        <canvas id="sig" style="width:100%;height:170px;background:#fff;border:1px dashed var(--border);
          border-radius:10px;touch-action:none"></canvas>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn secondary small" id="clr">清除重簽</button>
          <div class="spacer"></div>
          <button class="btn secondary" id="dispute">有疑義</button>
          <button class="btn" id="ok">確認無誤</button></div></div>`
    : `<div class="card"><div class="empty">這個月的結算還沒送出，行政結算完會通知你確認。</div></div>`}`;

    el.querySelector('#m').onchange = e => App.go('my-payout/' + e.target.value);
    const sigEl = el.querySelector('#sig');
    if (sigEl) {
      const pad = signaturePad(sigEl);
      el.querySelector('#clr').onclick = () => pad.clear();
      el.querySelector('#ok').onclick = async () => {
        if (!pad.dirty) return UI.toast('請先在框內簽名', true);
        if (!await UI.confirm(`確認 ${d.month} 的報酬明細無誤，實付合計 ${money(d.net)}？`)) return;
        try {
          await POST(`/my/payout-months/${d.month}/confirm`, { sign_image: pad.toPng() });
          UI.toast('已確認，感謝');
          App.go('my-payout/' + d.month);
        } catch (e) { UI.err(e); }
      };
      el.querySelector('#dispute').onclick = () => UI.modal({
        title: '回報疑義',
        submitText: '送出',
        body: `<div class="form-grid">${UI.textarea('note', '哪裡不對？（例：9/12 那筆應為 2000）',
    { rows: 4, full: true })}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            送出後這個月會標記為有疑義，行政查完會重新送一份給你確認。</div>`,
        onSubmit: async form => {
          const f = UI.formData(form);
          if (!f.note || !f.note.trim()) throw new Error('請說明哪裡有疑義');
          await POST(`/my/payout-months/${d.month}/dispute`, { note: f.note });
          UI.toast('已送出');
          App.go('my-payout/' + d.month);
        }
      });
    }
  }
});
