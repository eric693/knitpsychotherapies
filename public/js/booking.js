// 線上預約表單（公開頁，免登入）。
// 欄位順序比照所內原本的 Google 表單：諮商方案 → 諮商主題 → 預約之心理師 → 時段 → 基本資料，
// 三個選項欄位都做成下拉式選單。
//
// 個案全程看不到諮商室配置；時段已排除被占用、請假與帶團體的時間，
// 並依方案的每位心理師人次上限過濾（額滿的整週不出時段，改提示下週）。

const BK = {
  cfg: null,
  sel: { plan: null, topic: null, counselor: null, date: '', time: '', fee: 0 },

  async boot() {
    try {
      BK.cfg = await fetch('/api/public/booking-config').then(r => r.json());
    } catch {
      document.getElementById('app').innerHTML = '<div class="bk-card">目前無法載入預約表單，請稍後再試或直接來電預約。</div>';
      return;
    }
    // 從 LINE 進來時網址會帶 userId，用於把預約結果直接推播回 LINE
    // 從 LINE 官方帳號的專屬連結進來時帶 bk=token，送出時由後端換回 LINE 身分
    const qs = new URLSearchParams(location.search);
    BK.bookingToken = qs.get('bk') || '';
    BK.lineUserId = qs.get('line_user_id') || '';
    if (!BK.cfg.enabled) {
      document.getElementById('app').innerHTML = `<div class="bk-card">
        <h2>線上預約暫停開放</h2>
        <div class="bk-note">請直接來電預約：${UI.esc(BK.cfg.center_phone || '')}</div></div>`;
      return;
    }
    BK.render();
  },

  // 選單上直接寫「您要付多少」：補助方案顯示自付的場地費，不顯示方案總額，
  // 免得民眾以為要自己掏 1800
  planLabel(p) {
    const fee = p.fee_mode === 'choice'
      ? p.fee_options.map(f => f + '元').join('／')
      : `${p.client_pay}元`;
    const bits = [p.session_minutes ? `${p.session_minutes}分鐘` : '', `自付${fee}`].filter(Boolean).join('，');
    return `${p.name}（${bits}）`;
  },

  render() {
    const c = BK.cfg;
    document.getElementById('app').innerHTML = `
      <div class="bk-head">
        <h1>${UI.esc(c.center_name)}</h1>
        <div class="sub">線上預約表單${c.center_phone ? `　電話 <a href="tel:${UI.esc(c.center_phone)}">${UI.esc(c.center_phone)}</a>` : ''}
          ${c.center_address ? `<br>${UI.esc(c.center_address)}` : ''}</div>
      </div>

      <div class="bk-card">
        <h2><span class="step">1</span>諮商方案</h2>
        <div class="bk-field">
          <select id="plan">
            <option value="">請選擇方案</option>
            ${c.plans.map(p => `<option value="${p.id}">${UI.esc(BK.planLabel(p))}</option>`).join('')}
          </select>
          <div class="hint" id="plan-hint"></div>
        </div>
        <div class="bk-field" id="fee-choice" style="display:none">
          <label>方案金額</label>
          <select id="fee"></select>
          <div class="hint">依談話時間與參與人數選擇，實際以晤談時與心理師討論為準。</div>
        </div>
      </div>

      <div class="bk-card" id="topic-card" style="display:none">
        <h2><span class="step">2</span>諮商主題</h2>
        <div class="bk-field">
          <select id="topic"><option value="">請選擇主題</option></select>
        </div>
        <div class="bk-field" id="topic-other-row" style="display:none">
          <label>請簡述您想談的主題</label>
          <input id="topic_other" placeholder="例：睡眠困擾">
        </div>
      </div>

      <div class="bk-card" id="counselor-card" style="display:none">
        <h2><span class="step">3</span>預約之心理師</h2>
        <div class="bk-field">
          <select id="counselor"><option value="">請選擇心理師</option></select>
          <div class="hint" id="counselor-hint">若沒有特別指定，可選「由諮商所安排合適之心理師」。</div>
        </div>
      </div>

      <div class="bk-card" id="slot-card" style="display:none">
        <h2><span class="step">4</span>選擇時段</h2>
        <div id="slots">請先選擇心理師</div>
        <div class="bk-field" style="margin-top:10px">
          <label>欲安排之諮商時間 *</label>
          <textarea id="alt_note" rows="2"
            placeholder="請給至少三個方便的時段，例：星期一09:00-11:00、星期二14:00-16:00、星期五13:00-17:00"></textarea>
          <div class="hint">上方選了時段仍建議填寫備選時段，若該時段剛好被約走，我們可以直接安排替代時間。</div>
        </div>
      </div>

      <div class="bk-card" id="info-card" style="display:none">
        <h2><span class="step">5</span>基本資料</h2>
        <div class="bk-field"><label>姓名 *</label><input id="name" autocomplete="name"></div>
        <div class="bk-field"><label>手機 *</label><input id="phone" inputmode="numeric" placeholder="09xxxxxxxx" autocomplete="tel">
          <div class="hint">預約結果與提醒會以電話或 LINE 通知您。</div></div>
        <div class="bk-field"><label>出生日期 ${BK.cfg.require_birth ? '*' : ''}</label><input id="birth_date" type="date">
          <div class="hint">用於核對方案資格（如補助方案的年齡限制）。</div></div>
        <div class="bk-field"><label>生理性別 *</label>
          <select id="gender"><option value="">請選擇</option><option value="female">女</option>
            <option value="male">男</option><option value="other">其他</option></select></div>
        <div class="bk-field"><label>信箱 *</label><input id="email" type="email" autocomplete="email"></div>
        <div class="bk-field"><label>地址 *</label><input id="address" autocomplete="street-address"></div>
        <div class="bk-field"><label>身分證字號 *</label><input id="id_no" placeholder="A123456789">
          <div class="hint">補助方案核銷與依法通報時需要；本所依個資法保管，不作其他用途。</div></div>
        <div class="bk-field"><label>緊急聯絡人 *</label><input id="emergency_name"></div>
        <div class="bk-field"><label>緊急聯絡人電話 *</label><input id="emergency_phone" inputmode="numeric"></div>
        <div class="bk-field"><label>與緊急聯絡人的關係 *</label><input id="emergency_relationship" placeholder="例：配偶、父母"></div>
        <div class="bk-field" id="partner-row" style="display:none"><label>同行者姓名與關係</label>
          <input id="partner_name" placeholder="例：王小明（配偶）"></div>
        <div class="bk-field"><label>想談的困擾（選填）</label>
          <textarea id="main_issue" rows="3" placeholder="簡單描述即可，晤談時再詳談"></textarea></div>
        <div class="bk-field"><label>對諮商的期待（選填）</label>
          <textarea id="expectation" rows="2"></textarea></div>
        <div class="bk-field">
          <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:13.5px">
            <input type="checkbox" id="consent" style="width:auto;margin-top:3px">
            <span>我已閱讀並同意個人資料蒐集告知事項</span></label>
          <div class="hint">${UI.esc(c.privacy || '')}</div>
        </div>
        <div class="bk-note">${UI.esc(c.notice || '')}</div>
        <div class="bk-err" id="err"></div>
        <button class="btn bk-submit" id="submit">送出預約申請</button>
      </div>

      <div class="bk-card">
        <div class="bk-note">${UI.esc(c.crisis_note || '')}</div>
      </div>`;

    document.getElementById('plan').onchange = e => BK.pickPlan(Number(e.target.value));
    document.getElementById('submit').onclick = BK.submit;
  },

  pickPlan(id) {
    const p = BK.cfg.plans.find(x => x.id === id);
    BK.sel = { plan: p || null, topic: null, counselor: null, date: '', time: '', fee: p ? p.fee : 0 };
    const show = (elId, on) => { document.getElementById(elId).style.display = on ? '' : 'none'; };
    if (!p) {
      ['topic-card', 'counselor-card', 'slot-card', 'info-card'].forEach(x => show(x, false));
      document.getElementById('plan-hint').textContent = '';
      return;
    }

    document.getElementById('plan-hint').innerHTML = [
      p.intro ? UI.esc(p.intro) : '',
      p.subsidy_amount ? `此方案由補助支付 NT$${p.subsidy_amount}，<strong>您只需支付 NT$${p.client_pay}`
        + `${p.venue_fee ? '（場地費）' : ''}</strong>。` : '',
      p.quota_per_year ? `每人每年以 ${p.quota_per_year} 次為限。` : '',
      p.age_min || p.age_max ? `適用年齡：${p.age_min || 0}-${p.age_max || '不限'} 歲。` : '',
      p.default_mode === 'online' ? '此方案為線上通訊諮商。' : ''
    ].filter(Boolean).join('<br>');

    // 可選金額的方案（婚姻伴侶／家庭諮商）
    const feeBox = document.getElementById('fee-choice');
    if (p.fee_mode === 'choice' && p.fee_options.length) {
      feeBox.style.display = '';
      document.getElementById('fee').innerHTML = p.fee_options
        .map(f => `<option value="${f}"${f === p.fee ? ' selected' : ''}>NT$ ${f}</option>`).join('');
      document.getElementById('fee').onchange = e => { BK.sel.fee = Number(e.target.value); };
    } else {
      feeBox.style.display = 'none';
    }

    // 主題
    show('topic-card', true);
    const topicSel = document.getElementById('topic');
    topicSel.innerHTML = '<option value="">請選擇主題</option>'
      + p.topics.map(t => `<option value="${t.id}" data-name="${UI.esc(t.name)}">${UI.esc(t.name)}</option>`).join('');
    topicSel.onchange = e => {
      BK.sel.topic = Number(e.target.value) || null;
      const name = e.target.selectedOptions[0] ? e.target.selectedOptions[0].dataset.name : '';
      document.getElementById('topic-other-row').style.display = name === '其他' ? '' : 'none';
    };
    document.getElementById('topic-other-row').style.display = 'none';

    // 心理師（含「由諮商所安排」）
    show('counselor-card', true);
    const cs = document.getElementById('counselor');
    cs.innerHTML = '<option value="">請選擇心理師</option>'
      + p.counselors.map(u => `<option value="${u.id}">${UI.esc(u.name)}${u.title ? ' ' + UI.esc(u.title) : ''}／${UI.esc(u.license_type || '諮商心理師')}${u.online_only ? '（僅接受線上通訊諮商）' : ''}</option>`).join('')
      + '<option value="any">由諮商所安排合適之心理師</option>';
    cs.onchange = () => BK.pickCounselor(cs.value);

    show('slot-card', false);
    show('info-card', false);
    document.getElementById('topic-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  pickCounselor(value) {
    const box = document.getElementById('slots');
    document.getElementById('slot-card').style.display = '';
    document.getElementById('info-card').style.display = '';
    document.getElementById('partner-row').style.display =
      ['couple', 'family'].includes(BK.sel.plan.appt_type) ? '' : 'none';

    if (!value) { BK.sel.counselor = null; box.textContent = '請先選擇心理師'; return; }
    if (value === 'any') {
      // 不指定心理師：不列時段，改請個案填可配合的時段，由櫃檯排定後回覆
      BK.sel.counselor = null;
      BK.sel.date = '';
      BK.sel.time = '';
      box.innerHTML = '<span class="bk-note">由諮商所安排心理師時無法先選時段，請於下方填寫您可配合的時段，我們會盡快與您聯繫。</span>';
      document.getElementById('info-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    BK.sel.counselor = Number(value);
    BK.loadSlots();
  },

  async loadSlots() {
    const box = document.getElementById('slots');
    box.innerHTML = '載入中…';
    const q = new URLSearchParams({ counselor_id: BK.sel.counselor, plan_id: BK.sel.plan.id, days: 21 });
    const data = await fetch('/api/public/booking-slots?' + q).then(r => r.json()).catch(() => null);
    if (!data || !data.days) { box.innerHTML = '<span class="bk-note">目前無法取得時段，請來電預約。</span>'; return; }
    const days = data.days.filter(d => d.slots.length || d.full);
    if (!days.length) {
      box.innerHTML = '<span class="bk-note">近期沒有開放的時段，請填寫下方「其他可配合時段」，我們會再與您聯繫。</span>';
      return;
    }
    box.innerHTML = days.map(d => `<div class="day-block">
      <div class="d-label">${d.date}（${['日', '一', '二', '三', '四', '五', '六'][new Date(d.date + 'T00:00:00').getDay()]}）</div>
      ${d.slots.length
    ? `<div class="chip-row">${d.slots.map(s => `<button class="chip" data-d="${d.date}" data-t="${s.start_time}">${s.start_time}</button>`).join('')}</div>`
    : `<div class="full">${UI.esc(d.full ? d.full.reason : '無開放時段')}${d.full && d.full.next_week
      ? `，下週（${d.full.next_week.week_start} 起）尚可預約` : ''}</div>`}
    </div>`).join('');
    box.querySelectorAll('[data-t]').forEach(b => {
      b.onclick = () => {
        BK.sel.date = b.dataset.d;
        BK.sel.time = b.dataset.t;
        box.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b));
        document.getElementById('info-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
  },

  async submit() {
    const err = document.getElementById('err');
    const btn = document.getElementById('submit');
    const val = id => {
      const e = document.getElementById(id);
      return e ? (e.value || '').trim() : '';
    };
    err.textContent = '';
    if (!BK.sel.plan) { err.textContent = '請選擇諮商方案'; return; }
    const required = [['name', '姓名'], ['phone', '手機'], ['email', '信箱'], ['gender', '生理性別'],
      ['birth_date', '出生年月日'], ['address', '地址'], ['id_no', '身分證字號'],
      ['emergency_name', '緊急聯絡人'], ['emergency_phone', '緊急聯絡人電話'],
      ['emergency_relationship', '與緊急聯絡人的關係']];
    for (const [id, label] of required) {
      if (!(document.getElementById(id).value || '').trim()) { err.textContent = `請填寫${label}`; return; }
    }
    // 沒挑到具體時段時，一定要留可配合的時間，櫃檯才排得下去
    if (!BK.sel.date && !(document.getElementById('alt_note').value || '').trim()) {
      err.textContent = '請填寫欲安排之諮商時間（至少三個方便的時段）';
      return;
    }
    btn.disabled = true;
    try {
      const body = {
        name: val('name'), phone: val('phone'), email: val('email'),
        gender: val('gender'), birth_date: val('birth_date'),
        address: val('address'), id_no: val('id_no'),
        emergency_name: val('emergency_name'), emergency_phone: val('emergency_phone'),
        emergency_relationship: val('emergency_relationship'),
        plan_id: BK.sel.plan.id, topic_id: BK.sel.topic, topic_other: val('topic_other'),
        counselor_id: BK.sel.counselor, date: BK.sel.date, start_time: BK.sel.time,
        alt_note: val('alt_note'), fee_choice: BK.sel.fee,
        partner_name: val('partner_name'), main_issue: val('main_issue'),
        expectation: val('expectation'),
        consent: document.getElementById('consent').checked,
        booking_token: BK.bookingToken,
        line_user_id: BK.lineUserId, source: (BK.bookingToken || BK.lineUserId) ? 'line' : 'web'
      };
      const r = await fetch('/api/public/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(async res => {
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || '送出失敗，請稍後再試');
        return d;
      });
      BK.done(r);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
    }
  },

  // 預約完成後的 LINE 區塊。這是對方最願意加好友的時候 ——
  // 加好友只是加好友，系統還不知道他是誰，所以要連綁定一起完成：
  // 「開啟聊天室並帶入綁定碼」按下去訊息已經填好，直接送出就綁定成功。
  lineBox(r) {
    const c = BK.cfg;
    if (r.line_bound) {
      return `<div class="bk-note" style="margin-top:14px;text-align:left">
        ✓ 已與您的 LINE 連結，預約結果與晤談提醒都會傳到這裡。</div>`;
    }
    const b = r.line_bind;
    if (!b || !b.code) {
      return r.line_add_friend_url ? `<a class="btn" style="margin-top:14px;display:inline-block"
        href="${UI.esc(r.line_add_friend_url)}" target="_blank" rel="noopener">加入 LINE 接收提醒</a>` : '';
    }
    return `<div class="bk-card" style="margin-top:16px;text-align:left;border:1px solid var(--primary)">
      <h2 style="font-size:16px;margin:0 0 6px">接收預約結果與晤談提醒</h2>
      <div class="bk-note" style="margin-bottom:10px">
        加入官方帳號並完成連結後，預約結果、晤談提醒與收據都會傳到您的 LINE。
      </div>
      <ol style="font-size:14px;line-height:2;padding-left:20px;margin:0 0 10px">
        <li>按「加入好友」${c.line_official_name ? `（${UI.esc(c.line_official_name)}）` : ''}</li>
        <li>回到這頁按「開啟聊天室並送出連結碼」，訊息已經填好，直接送出即可</li>
      </ol>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${r.line_add_friend_url ? `<a class="btn" href="${UI.esc(r.line_add_friend_url)}"
          target="_blank" rel="noopener">① 加入好友</a>` : ''}
        ${b.message_url ? `<a class="btn secondary" href="${UI.esc(b.message_url)}"
          target="_blank" rel="noopener">② 開啟聊天室並送出連結碼</a>` : ''}
      </div>
      <div style="margin-top:12px;font-size:14px">
        連結碼：<strong id="bind-code" style="font-size:22px;letter-spacing:3px">${UI.esc(b.code)}</strong>
        <button class="btn secondary" type="button" id="copy-code"
          style="margin-left:8px;padding:4px 10px;font-size:13px">複製</button>
      </div>
      <div class="bk-note" style="margin-top:8px">
        手機若沒有自動帶入，加好友後把上面這 6 個數字傳給官方帳號也可以。
        連結碼 ${UI.esc(b.expires_at)} 前有效；沒完成也不影響預約，我們仍會以電話與您聯繫。
      </div>
    </div>`;
  },

  done(r) {
    const c = BK.cfg;
    document.getElementById('app').innerHTML = `<div class="bk-card done-box">
      <div class="ok">✓</div>
      <h2 style="justify-content:center">已收到您的預約申請</h2>
      <div class="bk-note" style="text-align:left;margin-top:10px">
        ${UI.esc(r.message)}
        ${BK.sel.date ? `\n\n希望時段：${BK.sel.date} ${BK.sel.time}` : ''}
        ${BK.sel.plan ? `\n方案：${BK.sel.plan.name}\n您需支付：NT$ ${r.self_pay}` : ''}
        ${r.center_phone ? `\n\n如需修改或有疑問，請來電 ${r.center_phone}。` : ''}
      </div>
      ${BK.lineBox(r)}
      ${r.portal_url ? `<div style="margin-top:14px">
        <a class="btn secondary" style="display:inline-block"
          href="${UI.esc(r.portal_url)}" target="_blank" rel="noopener">前往個案專區</a>
        <div class="bk-note" style="margin-top:8px">
          個案專區可查看自己的預約、線上填量表與同意書，並綁定 LINE 接收提醒。
          帳號為本次填寫的手機號碼，預設密碼是手機號碼後 6 碼。</div></div>` : ''}
      <div class="bk-note" style="margin-top:16px">${UI.esc(c.crisis_note || '')}</div>
    </div>`;
    const copy = document.getElementById('copy-code');
    if (copy) copy.onclick = async () => {
      const code = document.getElementById('bind-code').textContent.trim();
      try { await navigator.clipboard.writeText(code); copy.textContent = '已複製'; }
      catch { copy.textContent = '請長按上方號碼複製'; }
    };
  }
};

BK.boot();
