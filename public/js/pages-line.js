// 線上預約申請的審核，以及 LINE 官方帳號設定與推播

// LINE 卡片上可由所方改寫的說明文字（對應 settings 的 line_text_*）
const TEXT_FIELDS = [
  ['line_text_help_intro', '預約說明卡：開頭一句'],
  ['line_text_help_note', '預約說明卡：灰底注意事項', 3],
  ['line_text_bound', '綁定完成卡：開頭一句（{name} 為對方姓名）'],
  ['line_text_bound_note', '綁定完成卡：灰底注意事項', 2],
  ['line_text_request_intro', '收到預約申請：開頭一句'],
  ['line_text_request_note', '收到預約申請：灰底注意事項', 2],
  ['line_text_booked_note', '預約已成立：灰底注意事項', 2],
  ['line_text_remind_note', '晤談提醒：灰底注意事項', 2],
  ['line_text_receipt_note', '收據已開立：灰底注意事項', 2]
];

const BOOKING_STATUS = { new: '待處理', confirmed: '已成立', rejected: '未成立', cancelled: '已取消' };

// Google 表單的問題會增刪，同步時整份回應都留了一份；
// 這裡原樣攤開來，櫃檯不必回 Google 後台就看得到個案填的每一個字。
function formAnswers(b) {
  if (!b.form_answers) return '';
  let obj;
  try { obj = JSON.parse(b.form_answers); } catch (e) { return ''; }
  const rows = Object.entries(obj)
    .filter(([, v]) => String(v == null ? '' : v).trim())
    .map(([k, v]) => `<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="flex:0 0 40%;color:var(--muted)">${UI.esc(k)}</div>
        <div style="flex:1">${UI.nl2br(String(Array.isArray(v) ? v.join('、') : v))}</div>
      </div>`).join('');
  if (!rows) return '';
  return `<details style="margin-top:10px;font-size:13px">
      <summary style="cursor:pointer;color:var(--primary)">個案在預約表單填的完整內容（${Object.keys(obj).length} 題）</summary>
      <div style="margin-top:6px">${rows}</div>
    </details>`;
}

async function bookingDialog(id, onDone) {
  const b = await GET(`/bookings/${id}`);
  const slotBtns = (b.slots || []).map(s =>
    `<button class="btn tiny secondary" type="button" data-slot="${s.start_time}" style="margin:2px">${s.start_time}</button>`).join('');
  const errs = (b.check.errors || []).map(e => `<div style="color:var(--danger)">✕ ${UI.esc(e)}</div>`).join('');
  const warns = (b.check.warnings || []).map(w => `<div style="color:#b8860b">！${UI.esc(w)}</div>`).join('');
  UI.modal({
    title: `預約申請：${b.name}`,
    wide: true,
    submitText: '成立預約',
    body: `<div class="notice${b.client_id ? '' : ' warn'}" style="margin-bottom:12px">
        <strong>這頁怎麼用</strong>（由上往下）：
        <br>① 先看上半部個案填的資料（方案、主題、想約的時間）。
        <br>② ${b.client_id
    ? `此人已建檔（${UI.esc(b.client_code || '')}），可直接往下排時間。`
    : '<strong>此人尚未建檔</strong>，請先按下方的「由申請資料建檔」；沒建檔按「成立預約」只會出現「請先建立或指定個案」。'}
        <br>③ 選心理師與日期後，「該心理師當日可預約時段」會列出可用時間，點一下就會自動填進開始時間；結束時間依方案時長自動算。
        <br>④ 費用留空就沿用方案定價。「給個案的回覆」會一併通知個案。
        <br>⑤ 談成按右下「成立預約」；約不成按「未能成立（通知個案）」。
      </div>
      <div class="detail-grid">
        <div><div class="dg-label">聯絡電話</div>${UI.esc(b.phone)}</div>
        <div><div class="dg-label">Email</div>${UI.esc(b.email || '-')}</div>
        <div><div class="dg-label">生日／年齡</div>${UI.esc(b.birth_date || '-')}${b.age !== null ? `（${b.age} 歲）` : ''}</div>
        <div><div class="dg-label">身分</div>${b.client_id ? `舊個案 ${UI.esc(b.client_code || '')}` : '初次預約'}</div>
        <div><div class="dg-label">方案</div>${UI.esc(b.plan_name || '-')}</div>
        <div><div class="dg-label">主題</div>${UI.esc(b.topic_display || b.topic_name || '-')}
          ${b.topic_other ? `<span style="font-size:12px;color:var(--muted)">（自填：${UI.esc(b.topic_other)}）</span>` : ''}</div>
        <div><div class="dg-label">指定心理師</div>${UI.esc(b.counselor_name || '由諮商所安排')}</div>
        <div><div class="dg-label">形式</div>${b.mode === 'online' ? '線上視訊' : '到所'}</div>
        <div><div class="dg-label">費用</div>${UI.fmtMoney(b.fee_choice)}</div>
        <div><div class="dg-label">送出時間</div>${UI.esc(b.created_at)}</div>
        ${b.category ? `<div><div class="dg-label">預約類別</div>${UI.esc(b.category)}</div>` : ''}
        ${b.education ? `<div><div class="dg-label">教育程度</div>${UI.esc(b.education)}</div>` : ''}
        ${b.guardian_phone ? `<div><div class="dg-label">家長電話</div>${UI.esc(b.guardian_phone)}${b.guardian_name ? `（${UI.esc(b.guardian_name)}）` : ''}</div>` : ''}
      </div>
      ${b.main_issue ? `<div style="margin-top:10px;font-size:13.5px"><strong>主訴：</strong>${UI.nl2br(b.main_issue)}</div>` : ''}
      ${b.expectation ? `<div style="font-size:13.5px"><strong>期待：</strong>${UI.nl2br(b.expectation)}</div>` : ''}
      ${b.alt_note ? `<div style="font-size:13.5px"><strong>其他可配合時段：</strong>${UI.nl2br(b.alt_note)}</div>` : ''}
      ${b.reply_note ? `<div style="font-size:13.5px;color:#b8860b"><strong>同步時的提醒：</strong>${UI.nl2br(b.reply_note)}</div>` : ''}
      ${formAnswers(b)}
      ${errs || warns ? `<div style="margin-top:10px;padding:10px;background:var(--primary-light);border-radius:8px;font-size:13px">${errs}${warns}</div>` : ''}
      <div class="form-grid" style="margin-top:12px">
        ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: b.counselor_id || '' })}
        ${UI.input('date', '日期', { type: 'date', value: b.date || UI.today() })}
        ${UI.input('start_time', '開始時間', { type: 'time', value: b.start_time || '14:00' })}
        ${UI.input('fee', '費用（留空沿用方案）', { type: 'number', value: b.fee_choice || '' })}
        ${UI.textarea('reply_note', '給個案的回覆／內部備註', { value: '' })}
        <div class="form-row full"><label>該心理師當日可預約時段</label>
          <div id="slots" style="font-size:13px;color:var(--muted)">${slotBtns || '該日無開放時段'}</div></div>
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
        諮商室由系統自動指派，個案端不會看到空間配置。
        ${b.client_id ? '' : '此人尚未建檔，成立預約前請先按左下「由申請資料建檔」。'}</div>
      <div class="toolbar" style="margin-top:10px">
        ${b.client_id ? '' : '<button class="btn secondary" id="mkclient" type="button">由申請資料建檔</button>'}
        <div class="spacer"></div>
        <button class="btn danger" id="reject" type="button">未能成立（通知個案）</button>
      </div>`,
    onOpen: (el, close) => {
      el.querySelectorAll('[data-slot]').forEach(x => {
        x.onclick = () => { el.querySelector('[name=start_time]').value = x.dataset.slot; };
      });
      const refresh = async () => {
        const cid = el.querySelector('[name=counselor_id]').value;
        const date = el.querySelector('[name=date]').value;
        const box = el.querySelector('#slots');
        if (!cid || !date) return;
        const slots = await GET(`/slots?counselor_id=${cid}&date=${date}`).catch(() => []);
        box.innerHTML = slots.length
          ? slots.map(s => `<button class="btn tiny secondary" type="button" data-slot="${s.start_time}" style="margin:2px">${s.start_time}</button>`).join('')
          : '該日無開放時段';
        box.querySelectorAll('[data-slot]').forEach(x => {
          x.onclick = () => { el.querySelector('[name=start_time]').value = x.dataset.slot; };
        });
      };
      el.querySelector('[name=counselor_id]').onchange = refresh;
      el.querySelector('[name=date]').onchange = refresh;
      const mk = el.querySelector('#mkclient');
      if (mk) {
        mk.onclick = async () => {
          const r = await POST(`/bookings/${id}/create-client`);
          UI.toast(r.matched ? '已對應到既有個案' : `已建檔（${r.code}）`);
          close();
          bookingDialog(id, onDone);
        };
      }
      el.querySelector('#reject').onclick = async () => {
        const note = el.querySelector('[name=reply_note]').value;
        if (!await UI.confirm('確定要回覆此申請未能成立嗎？')) return;
        const r = await POST(`/bookings/${id}/reject`, { reply_note: note });
        UI.toast(r.notify ? `已回覆（${r.notify.message}）` : '已回覆');
        close();
        onDone && onDone();
      };
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      const send = () => POST(`/bookings/${id}/confirm`, data);
      try {
        const r = await send();
        UI.toast(`已成立預約${r.notify ? '（' + r.notify.message + '）' : ''}`);
      } catch (e) {
        if (!/已使用|已排滿|限 /.test(e.message)) throw e;
        if (!await UI.confirm(`${e.message}\n\n仍要成立嗎？（會記錄於稽核軌跡）`)) return false;
        data.override = true;
        const r = await send();
        UI.toast(`已成立預約${r.notify ? '（' + r.notify.message + '）' : ''}`);
      }
      onDone && onDone();
    }
  });
}

App.page('bookings', {
  title: '線上預約申請',
  sub: '個案從預約表單或 LINE 送出的申請，確認後才寫進排程',
  help: [
    '個案從線上表單或 LINE 送出的申請都落在這裡，<strong>先在這裡確認過才會進排程</strong>。',
    '按「處理」打開申請明細：初次預約的人要先「由申請資料建檔」，再選心理師與時段按「成立預約」；約不成按「未能成立（通知個案）」回覆。',
    '狀態「待處理」就是還沒處理完的；上方可用關鍵字、狀態、方案、心理師與送出日期篩選。',
  ],
  module: 'bookings',
  async render(el) {
    const st = App._bookFilter = Object.assign({ q: '', status: '', plan_id: '', counselor_id: '', from: '', to: '' }, App._bookFilter);
    const qs = new URLSearchParams(Object.entries(st).filter(([, v]) => v)).toString();
    const rows = await GET('/bookings' + (qs ? '?' + qs : ''));
    const pending = rows.filter(r => r.status === 'new');
    const filtering = Object.values(st).some(v => v);
    el.innerHTML = `<div class="toolbar">
        <input id="bq" placeholder="搜尋姓名／電話／Email／主訴" value="${UI.esc(st.q)}" style="min-width:220px">
        <select id="bst">
          <option value="">全部狀態</option>
          ${Object.entries(BOOKING_STATUS).map(([k, v]) =>
    `<option value="${k}"${st.status === k ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
        <select id="bpl">
          <option value="">全部方案</option>
          <option value="none"${st.plan_id === 'none' ? ' selected' : ''}>未指定方案</option>
          ${(App.meta.plans || []).map(p =>
    `<option value="${p.id}"${String(st.plan_id) === String(p.id) ? ' selected' : ''}>${UI.esc(p.name)}</option>`).join('')}
        </select>
        <select id="bcs">
          <option value="">全部心理師</option>
          <option value="none"${st.counselor_id === 'none' ? ' selected' : ''}>由諮商所安排</option>
          ${App.counselorOptions().map(([id, name]) =>
    `<option value="${id}"${String(st.counselor_id) === String(id) ? ' selected' : ''}>${UI.esc(name)}</option>`).join('')}
        </select>
        <input type="date" id="bfrom" value="${UI.esc(st.from)}" title="送出日期起">
        <input type="date" id="bto" value="${UI.esc(st.to)}" title="送出日期迄">
        ${filtering ? '<button class="btn tiny secondary" id="bclr">清除篩選</button>' : ''}
        <div class="spacer"></div>
        <span style="font-size:13px;color:var(--muted)">符合 ${rows.length} 筆</span>
      </div>
      <div class="card"><h3>待處理
        <span style="font-size:13px;font-weight:400;color:var(--muted)">${pending.length} 筆</span></h3>
      <div class="toolbar" style="margin:0 0 8px">
        <label style="font-size:13px"><input type="checkbox" id="bulk-all"> 全選</label>
        <button class="btn tiny secondary" id="bulk-client">批次建檔</button>
        <button class="btn tiny secondary" id="bulk-reject">批次退回</button>
        <button class="btn tiny danger" id="bulk-del">批次刪除</button>
        <span id="bulk-count" style="font-size:12.5px;color:var(--muted)"></span>
      </div>
      ${UI.table(['', '送出時間', '姓名／電話', '身分', '方案／主題', '希望時段', '心理師', '額度', ''],
      pending.map(r => `<tr>
        <td><input type="checkbox" class="bulk-pick" value="${r.id}"></td>
        <td>${UI.esc(r.created_at.slice(5, 16))}</td>
        <td>${UI.esc(r.name)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(r.phone)}</span></td>
        <td>${r.client_id ? UI.tag('舊個案', 'primary') + '<br>' + UI.esc(r.client_code || '') : UI.tag('初次', 'warn')}
          ${r.age !== null ? `<br><span style="font-size:12px;color:var(--muted)">${r.age} 歲</span>` : ''}</td>
        <td>${UI.esc(r.plan_name || '-')}${r.topic_name ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.topic_name) + '</span>' : ''}</td>
        <td>${r.date ? `${r.date}<br>${r.start_time}` : UI.esc(r.alt_note || '未指定')}</td>
        <td>${UI.esc(r.counselor_name || '由諮商所安排')}</td>
        <td>${r.usage ? `${r.usage.used}/${r.usage.quota}${r.usage.over ? ' ' + UI.tag('已用完', 'danger') : ''}` : '-'}</td>
        <td style="white-space:nowrap"><button class="btn tiny" data-b="${r.id}">處理</button>
          <button class="btn tiny secondary" data-be="${r.id}">編輯</button>
          <button class="btn tiny danger" data-bd="${r.id}">刪除</button></td></tr>`), '目前沒有待處理的申請')}</div>

      <div class="card"><h3>歷史申請</h3>
      ${UI.table(['送出時間', '姓名', '方案', '時段', '狀態', '處理', ''], rows.filter(r => r.status !== 'new').slice(0, 100)
      .map(r => `<tr>
        <td>${UI.esc(r.created_at.slice(0, 16))}</td><td>${UI.esc(r.name)}</td>
        <td>${UI.esc(r.plan_name || '-')}</td>
        <td>${r.date ? r.date + ' ' + r.start_time : '-'}</td>
        <td>${UI.tag(BOOKING_STATUS[r.status] || r.status, r.status === 'confirmed' ? 'ok' : '')}</td>
        <td>${UI.esc((r.handled_at || '').slice(0, 16))}${r.reply_note ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.reply_note) + '</span>' : ''}</td>
        <td style="white-space:nowrap">${r.status === 'confirmed' ? ''
    : `<button class="btn tiny danger" data-bd="${r.id}">刪除</button>`}</td>
        </tr>`), '尚無紀錄')}</div>`;
    // 篩選一律送回後端處理，資料上千筆時前端才不必整批載入
    const apply = () => {
      App._bookFilter = {
        q: el.querySelector('#bq').value.trim(),
        status: el.querySelector('#bst').value,
        plan_id: el.querySelector('#bpl').value,
        counselor_id: el.querySelector('#bcs').value,
        from: el.querySelector('#bfrom').value,
        to: el.querySelector('#bto').value
      };
      App.go('bookings');
    };
    el.querySelector('#bq').onkeydown = e => { if (e.key === 'Enter') apply(); };
    ['#bst', '#bpl', '#bcs', '#bfrom', '#bto'].forEach(sel => { el.querySelector(sel).onchange = apply; });
    if (el.querySelector('#bclr')) el.querySelector('#bclr').onclick = () => { App._bookFilter = null; App.go('bookings'); };
    // 批次處理：舊表單一次匯入上百筆時，一筆一筆開太慢
    const picks = () => Array.from(el.querySelectorAll('.bulk-pick:checked')).map(c => Number(c.value));
    const showCount = () => {
      el.querySelector('#bulk-count').textContent = picks().length ? `已勾選 ${picks().length} 筆` : '';
    };
    el.querySelectorAll('.bulk-pick').forEach(c => { c.onchange = showCount; });
    const allBox = el.querySelector('#bulk-all');
    if (allBox) {
      allBox.onchange = () => {
        el.querySelectorAll('.bulk-pick').forEach(c => { c.checked = allBox.checked; });
        showCount();
      };
    }
    const bulk = async (action, label, extra) => {
      const ids = picks();
      if (!ids.length) { UI.toast('請先勾選要處理的申請', true); return; }
      if (!await UI.confirm(`確定要${label} ${ids.length} 筆申請？`)) return;
      try {
        const r = await POST('/bookings/bulk', { ids, action, ...(extra || {}) });
        UI.toast(`已${label} ${r.done} 筆${r.skipped.length ? `，${r.skipped.length} 筆略過` : ''}`);
        if (r.skipped.length) {
          UI.modal({
            title: `略過的 ${r.skipped.length} 筆`, hideFooter: true,
            body: UI.table(['姓名', '原因'], r.skipped.map(x =>
              `<tr><td>${UI.esc(x.name || '')}</td><td>${UI.esc(x.why)}</td></tr>`))
          });
        }
        App.go('bookings');
      } catch (e) { UI.err(e); }
    };
    if (el.querySelector('#bulk-client')) {
      el.querySelector('#bulk-client').onclick = () => bulk('create-client', '建檔');
      el.querySelector('#bulk-del').onclick = () => bulk('delete', '刪除');
      el.querySelector('#bulk-reject').onclick = () => UI.modal({
        title: '批次退回',
        body: `<div class="form-grid">${UI.textarea('reply_note', '退回原因（會記在每一筆申請上）', { rows: 3 })}</div>`,
        onSubmit: async e2 => { await bulk('reject', '退回', UI.formData(e2)); }
      });
    }

    el.querySelectorAll('[data-b]').forEach(b => {
      b.onclick = () => bookingDialog(b.dataset.b, () => App.go('bookings'));
    });
    // 申請內容打錯可以先改再成立；重複送出或亂填的可以直接刪掉
    el.querySelectorAll('[data-be]').forEach(b => {
      const r = rows.find(x => x.id === Number(b.dataset.be));
      b.onclick = () => UI.modal({
        title: `編輯申請：${r.name}`, wide: true,
        body: `<div class="form-grid">
            ${UI.input('name', '姓名', { value: r.name })}
            ${UI.input('phone', '聯絡電話', { value: r.phone || '' })}
            ${UI.input('email', 'Email', { value: r.email || '' })}
            ${UI.input('birth_date', '出生日期', { type: 'date', value: r.birth_date || '' })}
            ${UI.select('plan_id', '方案', [['', '未指定']].concat((App.meta.plans || []).map(p => [p.id, p.name])), { value: r.plan_id || '' })}
            ${UI.select('counselor_id', '指定心理師', [['', '由諮商所安排']].concat(App.counselorOptions()), { value: r.counselor_id || '' })}
            ${UI.input('date', '希望日期', { type: 'date', value: r.date || '' })}
            ${UI.input('start_time', '希望時間', { type: 'time', value: r.start_time || '' })}
            ${UI.input('alt_note', '其他可配合時段', { value: r.alt_note || '', full: true })}
            ${UI.textarea('main_issue', '主訴', { value: r.main_issue || '', rows: 3 })}
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            修改只影響這筆申請，成立預約時以這裡的內容為準；修改會記入稽核軌跡。</div>`,
        onSubmit: async e => { await PUT(`/bookings/${r.id}`, UI.formData(e)); UI.toast('已更新'); App.go('bookings'); }
      });
    });
    el.querySelectorAll('[data-bd]').forEach(b => {
      const r = rows.find(x => x.id === Number(b.dataset.bd));
      b.onclick = async () => {
        if (!await UI.confirm(`刪除 ${r.name} 的預約申請？此動作無法復原（已成立的申請不會出現此按鈕）。`)) return;
        await DEL(`/bookings/${r.id}`);
        UI.toast('已刪除');
        App.go('bookings');
      };
    });
  }
});

App.page('line', {
  title: 'LINE 官方帳號',
  sub: '串接設定、綁定管理與推播；所有通知都以 Flex Message 送出',
  help: [
    '先在 LINE Developers 取得 Channel access token 與 secret 填進來，按「儲存憑證」再「驗證連線」。',
    '接著按「寫回 LINE 並測試」設定 Webhook，個案才能用 LINE 綁定與收通知。',
    '下方可管理個案／心理師的綁定，以及調整提醒時間與推播開關；未設定憑證時所有通知只會產生文字紀錄，不會對外送出任何個資。',
  ],
  module: 'settings',
  async render(el) {
    UI.tabs(el, [
      { key: 'setup', label: '串接設定' },
      { key: 'bind', label: '綁定管理' },
      { key: 'push', label: '推播與紀錄' }
    ], (key, body) => LINEPAGE[key](body));
  }
});

const LINEPAGE = {
  // ---- 串接設定：貼上權杖 → 驗證連線 → 設定 Webhook ----
  async setup(el) {
    const s = await GET('/line/settings');
    el.innerHTML = `
      <div class="card"><h3>1. 頻道憑證
        ${s.enabled ? UI.tag('已啟用', 'ok') : UI.tag('尚未啟用', 'danger')}</h3>
        <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:10px">
          到 <a href="https://developers.line.biz/console/" target="_blank" rel="noopener">LINE Developers Console</a>
          → 選擇您的 Messaging API 頻道 →
          「Basic settings」複製 <strong>Channel secret</strong>、
          「Messaging API」發行並複製 <strong>Channel access token（long-lived）</strong>，貼到下方。<br>
          已存的權杖只顯示末四碼；不修改就留著原樣即可，要清空請把欄位刪成空白。
        </div>
        <div class="form-grid" id="cred">
          ${UI.input('line_channel_token', 'Channel access token', { value: s.line_channel_token, full: true })}
          ${UI.input('line_channel_secret', 'Channel secret', { value: s.line_channel_secret, full: true })}
          ${UI.input('line_official_name', '官方帳號名稱', { value: s.line_official_name })}
          ${UI.input('line_official_id', '官方帳號 ID（@ 開頭）', { value: s.line_official_id || '' })}
          ${UI.input('line_add_friend_url', '加好友連結', { value: s.line_add_friend_url, full: true })}
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn" id="save-cred">儲存憑證</button>
          <button class="btn secondary" id="verify">驗證連線</button>
          <div class="spacer"></div>
          <span id="verify-out" style="font-size:13px;color:var(--muted)"></span>
        </div>
      </div>

      <div class="card"><h3>2. Webhook</h3>
        <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:8px">
          Webhook 是 LINE 把個案訊息送回系統的通道，綁定碼與自動回覆都靠它。
          按下方按鈕會直接幫您寫回 LINE 後台並測試一次；
          也可以自己到 LINE Developers 的「Messaging API → Webhook URL」貼上這個網址並開啟 Use webhook。
        </div>
        <div class="form-grid">
          ${UI.input('webhook_url', 'Webhook 網址', { value: s.webhook_url, full: true })}
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn" id="hook">寫回 LINE 並測試</button>
          <div class="spacer"></div>
          <span id="hook-out" style="font-size:13px;color:var(--muted)"></span>
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          另請在 LINE Developers 的「Messaging API」把<strong>自動回覆訊息</strong>與<strong>歡迎訊息</strong>關閉，
          改由本系統回覆綁定與預約說明，個案才不會收到兩則訊息。
        </div>
      </div>

      <div class="card"><h3>3. 通知時間與樣式</h3>
        <div class="form-grid" id="opts">
          ${UI.input('line_reminder_hours', '晤談提醒提前時數（0 = 不推提醒）', { type: 'number', value: s.line_reminder_hours })}
          ${UI.select('line_counselor_daily_enabled', '每日推播心理師隔日行程',
    [['1', '啟用'], ['0', '關閉']], { value: s.line_counselor_daily_enabled })}
          ${UI.input('line_counselor_daily_time', '每日推播時間', { type: 'time', value: s.line_counselor_daily_time })}
          ${UI.input('line_flex_color', 'Flex 卡片主色', { value: s.line_flex_color })}
          ${UI.input('booking_public_url', '線上預約表單網址（放在 LINE 卡片按鈕）', { value: s.booking_public_url, full: true })}
        </div>
        <div class="toolbar" style="margin-top:10px"><div class="spacer"></div>
          <button class="btn" id="save-opts">儲存</button></div>
      </div>

      <div class="card"><h3>4. 訊息文案</h3>
        <div style="font-size:13px;color:var(--muted);line-height:1.9;margin-bottom:10px">
          個案在 LINE 上收到的說明文字，改這裡即刻生效，不必重啟。
          留空就用系統預設（灰字提示即為預設內容）。<br>
          可用代入值：<code>{center}</code> 機構名稱、<code>{phone}</code> 電話、
          <code>{hours}</code> 取消期限時數、<code>{name}</code> 對方姓名。
          某一行的代入值是空的（例如沒填電話），那一行會整行略過。
        </div>
        <div class="form-grid" id="texts">
          ${TEXT_FIELDS.map(([k, label, rows]) =>
    UI.textarea(k, label, { value: s[k] || '', full: true, rows: rows || 2,
      placeholder: (s.text_defaults || {})[k] || '' })).join('')}
        </div>
        <div class="toolbar" style="margin-top:10px"><div class="spacer"></div>
          <button class="btn" id="save-texts">儲存文案</button></div>
      </div>`;

    const save = async (scope) => {
      const box = el.querySelector(scope);
      await PUT('/line/settings', UI.formData(box));
      UI.toast('已儲存');
      App.go('line');
    };
    el.querySelector('#save-cred').onclick = () => save('#cred');
    el.querySelector('#save-opts').onclick = () => save('#opts');
    el.querySelector('#save-texts').onclick = () => save('#texts');
    el.querySelector('#verify').onclick = async () => {
      const out = el.querySelector('#verify-out');
      out.textContent = '連線中…';
      try {
        const r = await POST('/line/verify');
        out.innerHTML = `<span style="color:var(--ok,#2e7d32)">✓ 已連線：${UI.esc(r.display_name || '')} ${UI.esc(r.basic_id || '')}</span>`;
      } catch (e) { out.innerHTML = `<span style="color:var(--danger)">✕ ${UI.esc(e.message)}</span>`; }
    };
    el.querySelector('#hook').onclick = async () => {
      const out = el.querySelector('#hook-out');
      out.textContent = '設定中…';
      try {
        const r = await POST('/line/webhook-endpoint', { url: el.querySelector('[name=webhook_url]').value.trim() });
        out.innerHTML = r.reachable
          ? '<span style="color:var(--ok,#2e7d32)">✓ 已設定並測試通過</span>'
          : `<span style="color:#b8860b">已設定，但 ${UI.esc(r.detail)}</span>`;
      } catch (e) { out.innerHTML = `<span style="color:var(--danger)">✕ ${UI.esc(e.message)}</span>`; }
    };
  },

  // ---- 綁定管理 ----
  async bind(el, state) {
    const st = LINEPAGE._bindState = Object.assign({ q: '', filter: '' }, LINEPAGE._bindState, state);
    const reload = () => LINEPAGE.bind(el);
    const d = await GET(`/line/bindings?q=${encodeURIComponent(st.q)}&filter=${st.filter}`);
    const codeDialog = r => UI.modal({
      title: 'LINE 綁定碼', hideFooter: true,
      body: `<div style="text-align:center;font-size:32px;font-weight:700;letter-spacing:6px;margin:12px 0">${r.code}</div>
        <div style="font-size:13.5px;line-height:1.9">
          1. 請對方加入諮商所的 LINE 官方帳號${r.add_friend_url
    ? `（<a href="${UI.esc(r.add_friend_url)}" target="_blank" rel="noopener">加好友連結</a>）` : ''}<br>
          2. 在聊天室輸入這 6 碼<br>
          3. 收到「綁定完成」卡片即完成，之後的提醒都會送到 LINE<br>
          有效期限：${r.expires_at}</div>`
    });
    // 已綁定者除了解除，也要能重發綁定碼（換手機、換 LINE 帳號時最常用）
    const actions = (kind, r) => (r.bound
      ? `<button class="btn tiny" data-re${kind}="${r.id}">重新綁定</button>
         <button class="btn tiny danger" data-un${kind}="${r.id}">解除綁定</button>`
      : `<button class="btn tiny" data-new${kind}="${r.id}">產生綁定碼</button>`);
    const boundCell = r => (r.bound
      ? UI.tag('已綁定', 'ok') + (r.bound_at
        ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(r.bound_at.slice(0, 16))}</div>` : '')
      : UI.tag('未綁定', ''));

    el.innerHTML = `
      <div class="card"><h3>員工／心理師</h3>
        ${UI.table(['姓名', '身分', 'LINE', ''], d.staff.map(u => `<tr>
          <td>${UI.esc(u.name)}</td><td>${UI.esc(u.title || TW.role[u.role] || '')}</td>
          <td>${boundCell(u)}</td>
          <td style="text-align:right;white-space:nowrap">${actions('s', u)}</td></tr>`))}</div>

      <div class="card"><h3>個案
          <span style="font-size:13px;font-weight:400;color:var(--muted)">共 ${d.client_total} 位，未綁定者排在前面</span></h3>
        <div class="toolbar" style="margin-bottom:10px">
          <input id="bq" placeholder="搜尋姓名／編號／電話" value="${UI.esc(st.q)}" style="max-width:240px">
          <select id="bf" style="max-width:140px">
            <option value="">全部</option>
            <option value="unbound"${st.filter === 'unbound' ? ' selected' : ''}>只看未綁定</option>
            <option value="bound"${st.filter === 'bound' ? ' selected' : ''}>只看已綁定</option>
          </select>
          <button class="btn tiny" id="bqgo">查詢</button>
          ${st.q || st.filter ? '<button class="btn tiny secondary" id="bqclr">清除</button>' : ''}
        </div>
        ${UI.table(['編號', '姓名', '電話', 'LINE', ''], d.clients.map(c => `<tr>
          <td>${UI.esc(c.code)}</td><td>${UI.esc(c.name)}</td><td>${UI.esc(c.phone || '')}</td>
          <td>${boundCell(c)}</td>
          <td style="text-align:right;white-space:nowrap">${actions('c', c)}</td></tr>`), '沒有符合的個案')}
        ${d.client_total > d.clients.length
    ? '<div style="font-size:12px;color:var(--muted);margin-top:8px">僅顯示前 200 位，請用搜尋縮小範圍。</div>' : ''}</div>

      <div class="card"><h3>尚未使用的綁定碼</h3>
        ${UI.table(['綁定碼', '對象', '有效至', '產生時間', ''], d.pending.map(p => `<tr>
          <td><strong>${UI.esc(p.code)}</strong></td>
          <td>${UI.esc(p.client_name || p.user_name || '')}</td>
          <td>${UI.esc(p.expires_at)}</td><td>${UI.esc(p.created_at.slice(0, 16))}</td>
          <td style="text-align:right"><button class="btn tiny danger" data-void="${p.id}">作廢</button></td>
          </tr>`), '沒有待使用的綁定碼')}</div>`;

    const search = () => LINEPAGE.bind(el, {
      q: el.querySelector('#bq').value.trim(),
      filter: el.querySelector('#bf').value
    });
    el.querySelector('#bqgo').onclick = search;
    el.querySelector('#bq').onkeydown = e => { if (e.key === 'Enter') search(); };
    el.querySelector('#bf').onchange = search;
    if (el.querySelector('#bqclr')) el.querySelector('#bqclr').onclick = () => LINEPAGE.bind(el, { q: '', filter: '' });

    const issue = async (body, again) => {
      if (again && !await UI.confirm('重新產生綁定碼？對方輸入新碼後，這位的 LINE 會改綁到輸入的帳號。')) return;
      codeDialog(await POST('/line/bind-code', body));
      reload();
    };
    el.querySelectorAll('[data-news]').forEach(b => {
      b.onclick = () => issue({ user_id: Number(b.dataset.news) });
    });
    el.querySelectorAll('[data-newc]').forEach(b => {
      b.onclick = () => issue({ client_id: Number(b.dataset.newc) });
    });
    el.querySelectorAll('[data-res]').forEach(b => {
      b.onclick = () => issue({ user_id: Number(b.dataset.res) }, true);
    });
    el.querySelectorAll('[data-rec]').forEach(b => {
      b.onclick = () => issue({ client_id: Number(b.dataset.rec) }, true);
    });
    el.querySelectorAll('[data-uns]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('解除此員工的 LINE 綁定？解除後不再收到推播，可隨時再發綁定碼重綁。')) return;
        await DEL(`/line/binding?user_id=${b.dataset.uns}`);
        UI.toast('已解除綁定');
        reload();
      };
    });
    el.querySelectorAll('[data-unc]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('解除此個案的 LINE 綁定？解除後不再收到提醒與收據，可隨時再發綁定碼重綁。')) return;
        await DEL(`/line/binding?client_id=${b.dataset.unc}`);
        UI.toast('已解除綁定');
        reload();
      };
    });
    el.querySelectorAll('[data-void]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('作廢這組綁定碼？作廢後對方輸入此碼將無效。')) return;
        await DEL(`/line/bind-code/${b.dataset.void}`);
        UI.toast('已作廢');
        reload();
      };
    });
  },

  // ---- 推播與紀錄 ----
  async push(el) {
    const s = await GET('/line/status');
    el.innerHTML = `
      <div class="card"><h3>手動推播</h3>
        <div style="font-size:14px;line-height:2">
          已綁定個案 <strong>${s.clients_bound}</strong> / ${s.clients_total}　已綁定員工 <strong>${s.staff_bound}</strong><br>
          晤談提醒：晤談前 ${s.reminder_hours} 小時　心理師行程：${s.daily_enabled ? `每日 ${s.daily_time} 推播隔日行程` : '未啟用'}
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn secondary" id="test"${s.me_bound ? '' : ' disabled'}>推播測試（我的明日行程）</button>
          <div class="spacer"></div>
          <button class="btn secondary" id="remind">推播明日晤談提醒</button>
          <button class="btn" id="sched">推播心理師明日行程</button>
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          尚未完成串接時，系統不會對外送出任何個資，只把訊息記錄為「待人工發送」。
        </div>
      </div>

      <div class="card"><h3>未送出的通知
          <span style="font-size:13px;font-weight:400;color:var(--muted)">送失敗或待人工發送的都列在這裡</span></h3>
        <div id="failed"><div class="empty">載入中...</div></div></div>

      <div class="card"><h3>近期推播紀錄</h3>
        ${UI.table(['時間', '類型', '對象', '內容', '結果'], (s.recent || []).map(n => `<tr>
          <td>${UI.esc(n.created_at.slice(5, 16))}</td><td>${UI.esc(n.kind)}</td>
          <td>${UI.esc(n.client_name || n.target || '-')}</td>
          <td><div title="${UI.esc(n.content || '')}" class="ellipsis" style="max-width:280px;">${UI.esc(n.content || '')}</div></td>
          <td>${n.status === 'sent' ? UI.tag('已送出', 'ok')
    : n.status === 'manual' ? UI.tag('待人工', 'warn') : UI.tag('失敗', 'danger')}
            ${n.error ? `<br><span style="font-size:12px;color:var(--muted)">${UI.esc(n.error)}</span>` : ''}</td>
        </tr>`), '尚無推播紀錄')}</div>`;

    // 未送出的通知：可逐筆重送，或標記成已用電話等方式處理
    const drawFailed = async () => {
      const box = el.querySelector('#failed');
      const d = await GET('/notifications/failed');
      box.innerHTML = `${UI.table(['時間', '類型', '對象', '內容', '狀態', ''], d.rows.map(n => `<tr>
          <td>${UI.esc(n.created_at.slice(5, 16))}</td><td>${UI.esc(n.kind)}</td>
          <td>${UI.esc(n.client_name || n.target || '-')}</td>
          <td><div class="ellipsis" style="max-width:260px" title="${UI.esc(n.content || '')}">${UI.esc(n.content || '')}</div></td>
          <td>${n.status === 'manual' ? UI.tag('待人工發送', 'warn') : UI.tag('送出失敗', 'danger')}
            ${n.error ? `<br><span style="font-size:12px;color:var(--muted)">${UI.esc(n.error)}</span>` : ''}
            ${n.retry_count ? `<br><span style="font-size:12px;color:var(--muted)">已重試 ${n.retry_count} 次</span>` : ''}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny" data-rt="${n.id}"${d.line_enabled && n.target ? '' : ' disabled'}>重送</button>
            <button class="btn tiny secondary" data-rv="${n.id}">已人工處理</button></td></tr>`),
    '沒有未送出的通知')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
          失敗的推播每天會自動重送，每筆最多 3 次；${d.line_enabled ? '' : '目前尚未串接 LINE，只能標記為已人工處理。'}</div>`;
      box.querySelectorAll('[data-rt]').forEach(b2 => {
        b2.onclick = async () => {
          try { await POST(`/notifications/${b2.dataset.rt}/retry`, {}); UI.toast('已重送'); drawFailed(); }
          catch (e) { UI.err(e); }
        };
      });
      box.querySelectorAll('[data-rv]').forEach(b2 => {
        b2.onclick = async () => {
          await POST(`/notifications/${b2.dataset.rv}/resolve`, {});
          UI.toast('已標記處理'); drawFailed();
        };
      });
    };
    drawFailed();

    el.querySelector('#test').onclick = async () => { const o = await POST('/line/test'); UI.toast(o.message); };
    el.querySelector('#remind').onclick = async () => {
      if (!await UI.confirm('推播明日所有已預約個案的晤談提醒？')) return;
      const r = await POST('/line/remind-batch', {});
      UI.toast(`${r.date}：共 ${r.count} 筆，成功 ${r.sent} 筆`);
      App.go('line');
    };
    el.querySelector('#sched').onclick = async () => {
      const r = await POST('/line/counselor-schedule', {});
      UI.toast(`已推播 ${r.results.length} 位心理師`);
      App.go('line');
    };
  }
};

// ---- Google 表單同步 ----
// 所內原本的 Google 預約表單填完後，由表單的 Apps Script 把回應推到後台，
// 直接變成「線上預約申請」，櫃檯不必再手動謄一次。
App.page('gform', {
  title: 'Google 表單同步',
  sub: '原本的 Google 預約表單填完後，自動寫入後台的線上預約申請',
  help: [
    '讓原本的 Google 預約表單填完後自動寫進後台的「線上預約申請」，櫃檯不用再謄一次。',
    '步驟：按「複製程式碼」→ 貼到該 Google 表單的 Apps Script → 存檔並授權。密鑰留空表示不開放同步。',
    '方案／主題／心理師以選項文字自動對應，對不到時仍會收單並標示「需人工指定」，資料不會掉。',
  ],
  module: 'settings',
  async render(el) {
    const d = await GET('/integrations/google-form');
    el.innerHTML = `
      <div class="card"><h3>狀態
        ${d.enabled ? UI.tag('已啟用', 'ok') : UI.tag('尚未設定密鑰', 'warn')}
        <span style="font-size:13px;font-weight:400;color:var(--muted)">已同步 ${d.total} 筆</span></h3>
        <div class="form-grid">
          ${UI.input('endpoint', '接收網址（貼在 Apps Script 內，不必手動改）', { value: d.endpoint, full: true })}
          ${UI.input('secret', '共用密鑰', { value: d.secret, full: true })}
          ${UI.input('form_url', 'Google 表單網址（備查）', { value: d.form_url, full: true })}
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn secondary" id="regen">重新產生密鑰</button>
          <div class="spacer"></div>
          <button class="btn" id="save">儲存</button>
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          密鑰等同一把鑰匙：換了之後要把下方程式碼重新貼回 Apps Script，同步才會繼續。
        </div>
      </div>

      <div class="card"><h3>設定步驟</h3>
        <ol style="font-size:13.5px;line-height:2;padding-left:20px;margin:0 0 10px">
          <li>打開 Google 表單 → 右上「⋮」→ <strong>指令碼編輯器</strong></li>
          <li>把下方程式碼整段貼上並儲存</li>
          <li>左側「觸發條件 → 新增觸發條件」：函式選 <code>onFormSubmit</code>、
              事件來源「來自表單」、類型「表單提交時」，儲存並授權</li>
          <li>要把先前已收到的回應一起帶進來，就在編輯器選 <code>backfill</code> 執行一次
              （重複執行不會產生重複資料）</li>
        </ol>
        <textarea id="script" readonly rows="18"
          style="width:100%;font-family:ui-monospace,monospace;font-size:12px;min-height:340px">${UI.esc(d.script)}</textarea>
        <div class="toolbar" style="margin-top:8px"><div class="spacer"></div>
          <button class="btn secondary" id="copy">複製程式碼</button></div>
      </div>

      <div class="card"><h3>最近同步進來的預約</h3>
        ${UI.table(['時間', '姓名', '方案', '心理師', '狀態', '備註'], d.recent.map(r => `<tr>
          <td>${UI.esc(r.created_at.slice(5, 16))}</td>
          <td>${UI.esc(r.name)}</td>
          <td>${UI.esc(r.plan_name || UI.tag('需人工指定', 'warn'))}</td>
          <td>${UI.esc(r.counselor_name || '由諮商所安排')}</td>
          <td>${UI.tag(BOOKING_STATUS[r.status] || r.status, r.status === 'confirmed' ? 'ok' : '')}</td>
          <td style="font-size:12.5px;color:var(--muted)">${UI.esc(r.reply_note || '')}</td>
        </tr>`), '尚未收到 Google 表單的回應')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          同步進來的申請一律進「線上預約申請」頁，方案／主題／心理師以名稱自動對應，
          對不到的會標示「需人工指定」，資料不會遺失。
        </div>
      </div>`;

    el.querySelector('#save').onclick = async () => {
      await PUT('/integrations/google-form', {
        secret: el.querySelector('[name=secret]').value.trim(),
        form_url: el.querySelector('[name=form_url]').value.trim()
      });
      UI.toast('已儲存');
      App.go('gform');
    };
    el.querySelector('#regen').onclick = async () => {
      if (!await UI.confirm('重新產生密鑰後，舊的 Apps Script 會同步失敗，需重貼一次程式碼。確定嗎？')) return;
      await PUT('/integrations/google-form', { regenerate: true });
      UI.toast('已產生新密鑰');
      App.go('gform');
    };
    el.querySelector('#copy').onclick = async () => {
      const ta = el.querySelector('#script');
      ta.select();
      try {
        await navigator.clipboard.writeText(ta.value);
        UI.toast('已複製，貼到 Apps Script 即可');
      } catch { UI.toast('請按 Ctrl/Cmd + C 複製', true); }
    };
  }
});
