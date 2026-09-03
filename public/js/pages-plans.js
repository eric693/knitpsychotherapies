// 方案設定（方案 × 主題 × 心理師費率）、方案人次看板、心理師月收支

const PLAN_KIND = { self: '自費', subsidy: '補助方案', partner: '合作單位' };

function planDialog(p, onDone) {
  const isNew = !p;
  const d = p || {
    kind: 'self', appt_type: 'individual', fee_mode: 'fixed', fee: App.meta.default_fee || 2000,
    share_mode: 'percent', share_percent: 0.6, portal_visible: 1, require_review: 1, active: 1
  };
  UI.modal({
    title: isNew ? '新增方案' : `編輯方案：${d.name}`,
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('name', '方案名稱', { value: d.name || '', required: true, full: true })}
      ${UI.select('kind', '性質', Object.entries(PLAN_KIND), { value: d.kind })}
      ${UI.select('appt_type', '晤談類型', App.enumOptions('appt_type'), { value: d.appt_type })}
      ${UI.select('fee_mode', '收費方式', [['fixed', '固定金額'], ['choice', '預約時挑選金額']], { value: d.fee_mode })}
      ${UI.input('fee', '金額（預設）', { type: 'number', value: d.fee || 0 })}
      ${UI.input('fee_options', '可選金額（逗號分隔）', { value: d.fee_options || '', placeholder: '3000,3600,4500', full: true })}
      ${UI.input('session_minutes', '晤談時長（分鐘，0 沿用系統設定）', { type: 'number', value: d.session_minutes || 0 })}
      ${UI.select('default_mode', '預設形式', [['onsite', '到所晤談'], ['online', '線上視訊']], { value: d.default_mode || 'onsite' })}
      ${UI.input('subsidy_amount', '方案給付金額（其餘為個案自付）', { type: 'number', value: d.subsidy_amount || 0 })}
      ${UI.input('venue_fee', '場地費（所方全收，不列入抽成基數）', { type: 'number', value: d.venue_fee || 0 })}
      ${UI.inputList('subsidy_program', '核銷用方案名稱', App.meta.subsidy_programs || [], { value: d.subsidy_program || '', full: true })}
      ${UI.input('age_min', '年齡下限（0 不限）', { type: 'number', value: d.age_min || 0 })}
      ${UI.input('age_max', '年齡上限（0 不限）', { type: 'number', value: d.age_max || 0 })}
      ${UI.input('quota_per_year', '每人每年可用次數（0 不限）', { type: 'number', value: d.quota_per_year || 0 })}
      ${UI.input('counselor_week_limit', '每位心理師每週人次（0 不限）', { type: 'number', value: d.counselor_week_limit || 0 })}
      ${UI.input('counselor_month_limit', '每位心理師每月人次（0 不限）', { type: 'number', value: d.counselor_month_limit || 0 })}
      ${UI.select('share_mode', '心理師報酬方式', [['percent', '抽成比例'], ['fixed', '固定鐘點費']], { value: d.share_mode })}
      ${UI.input('share_percent', '抽成比例（可填 0.6 或 60）', { value: d.share_percent || 0 })}
      ${UI.input('share_fixed', '固定鐘點費', { type: 'number', value: d.share_fixed || 0 })}
      ${UI.textarea('intro', '線上預約表單上的說明', { value: d.intro || '' })}
      ${UI.textarea('note', '內部備註', { value: d.note || '' })}
      ${UI.checkbox('portal_visible', '開放線上預約表單顯示此方案', d.portal_visible)}
      ${UI.checkbox('require_review', '線上預約需櫃檯確認才成立', d.require_review)}
      ${UI.input('report_code', '年報表類別代碼', { value: d.report_code || '', placeholder: '如 0 指定／1 派案／3 機構' })}
      ${UI.input('code_prefix', '年報表編碼標記', { value: d.code_prefix || '', placeholder: '如 青壯、國軍；自費案留空' })}
      ${UI.input('sort', '排序', { type: 'number', value: d.sort || 0 })}
      ${isNew ? '' : UI.checkbox('active', '啟用中', d.active)}
    </div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
      年齡與次數限制用於補助方案的資格控管（如衛福部年輕族群方案 15-45 歲、每年 3 次）；
      每位心理師的人次上限可在下方「心理師費率」再個別調整。</div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) await POST('/service-plans', data); else await PUT(`/service-plans/${d.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

function topicDialog(planId, t, onDone) {
  const d = t || { fee: 0, sort: 0, active: 1 };
  UI.modal({
    title: t ? '編輯主題' : '新增主題',
    body: `<div class="form-grid">
      ${UI.input('name', '主題名稱', { value: d.name || '', required: true, full: true })}
      ${UI.input('fee', '金額（0 沿用方案）', { type: 'number', value: d.fee || 0 })}
      ${UI.input('sort', '排序', { type: 'number', value: d.sort || 0 })}
      ${UI.input('fee_options', '可選金額（逗號分隔，0 沿用方案）', { value: d.fee_options || '', full: true })}
      ${UI.input('report_code', '年報表類別代碼（留空沿用方案）', { value: d.report_code || '' })}
      ${UI.input('code_prefix', '年報表編碼標記（留空沿用方案）', { value: d.code_prefix || '' })}
      ${UI.textarea('note', '備註', { value: d.note || '' })}
      ${t ? UI.checkbox('active', '啟用中', d.active) : ''}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (t) await PUT(`/topics/${t.id}`, data); else await POST(`/service-plans/${planId}/topics`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

function rateDialog(plan, r, onDone) {
  const d = r || { share_mode: '', share_percent: 0, week_limit: '', month_limit: '', bookable: 1, active: 1 };
  UI.modal({
    title: r ? `編輯費率：${r.counselor_name}` : `新增心理師費率：${plan.name}`,
    wide: true,
    body: `<div class="form-grid">
      ${r ? '' : UI.select('counselor_id', '心理師', App.counselorOptions(), { value: d.counselor_id || '' })}
      ${r ? '' : UI.select('topic_id', '限定主題（可留空 = 全部主題）',
      [['', '全部主題']].concat((plan.topics || []).filter(t => t.active).map(t => [t.id, t.name])), { value: '' })}
      ${UI.input('fee', '金額（0 沿用方案／主題）', { type: 'number', value: d.fee || 0 })}
      ${UI.select('share_mode', '報酬方式', [['', '沿用方案'], ['percent', '抽成比例'], ['fixed', '固定鐘點費']], { value: d.share_mode })}
      ${UI.input('share_percent', '抽成比例（0.6 或 60）', { value: d.share_percent || 0 })}
      ${UI.input('share_fixed', '固定鐘點費', { type: 'number', value: d.share_fixed || 0 })}
      ${UI.input('week_limit', '每週人次（留空沿用方案，0 不限）', { type: 'number', value: d.week_limit === -1 ? '' : d.week_limit })}
      ${UI.input('month_limit', '每月人次（留空沿用方案，0 不限）', { type: 'number', value: d.month_limit === -1 ? '' : d.month_limit })}
      ${UI.checkbox('bookable', '開放此方案的線上預約', d.bookable)}
      ${r ? UI.checkbox('active', '啟用中', d.active) : ''}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (r) await PUT(`/rates/${r.id}`, data); else await POST(`/service-plans/${plan.id}/rates`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('plans', {
  title: '方案設定',
  sub: '方案 × 主題 × 心理師的收費、資格與人次上限，皆可自訂',
  help: [
    '一個「方案」＝一組收費規則：晤談時長、價格、資格限制、次數上限、心理師報酬怎麼算。排約選了方案，結束時間與費用就照它算。',
    '方案底下可再加「主題」（不同主題不同價）與「心理師費率」（同方案不同心理師抽成不同）。',
    '已經有預約在用的方案不要直接刪，改用「停用」，舊資料才不會對不上。',
  ],
  module: 'settings',
  async render(el) {
    const plans = await GET('/service-plans');
    const shareText = p => (p.share_mode === 'fixed'
      ? `固定 ${UI.fmtMoney(p.share_fixed)}`
      : `${Math.round((p.share_percent || 0) * 100)}%`);
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div>
        <button class="btn" id="add">新增方案</button></div>
      <div class="card" style="background:var(--primary-light);border:0">
        <h3 style="margin-bottom:6px">心理師報酬（抽成）怎麼設、怎麼算
          <button class="btn tiny secondary" id="helptoggle" style="float:right">展開說明</button></h3>
        <div id="planhelp" style="display:none;font-size:13.5px;line-height:2">
          <strong>一、在哪裡設</strong><br>
          按方案上的「編輯方案」，往下捲到報酬設定：<br>
          ・<strong>心理師報酬方式</strong>＝抽成比例（拆帳）或固定鐘點費（不論收多少，每場給固定金額）<br>
          ・<strong>抽成比例</strong>＝填 0.6 或 60 都可以，系統一律當成 60%<br>
          某位心理師談好不同條件時，用「新增心理師費率」單獨設定，不必動整個方案。<br><br>
          <strong>二、抽成基數是「應收金額 − 場地費」</strong><br>
          場地費算所方收入，不參與拆帳。以青壯世代方案為例：<br>
          總額 1,800（方案給付 1,600 ＋ 個案自付場地費 200），抽成 60% →
          心理師 (1800 − 200) × 60% = <strong>960</strong>，所方 1800 − 960 = <strong>840</strong>。<br>
          不希望場地費影響拆帳的話，把「場地費」留 0 即可。<br><br>
          <strong>三、三層優先順序（下面蓋上面）</strong><br>
          心理師費率 → 主題 → 方案預設。<br>
          某位心理師在某個主題有單獨費率就用他的；沒有就看主題；再沒有才用方案預設。<br><br>
          <strong>四、什麼時候定案</strong><br>
          報酬在<strong>晤談按下「完成」的當下就鎖定</strong>在那筆預約上。
          之後調整抽成只影響往後完成的晤談，不會回頭改動已結算的月份。<br><br>
          <strong>五、去哪裡看結果</strong><br>
          「心理師收支」頁看每月完成場次、應收、報酬與所方淨收（可列印對帳）；
          「報酬與扣繳」頁把報酬開成給付單，試算代扣所得稅與二代健保補充保費。
        </div>
      </div>
      ${plans.map(p => `<div class="card"${p.active ? '' : ' style="opacity:.6"'}>
        <h3>${UI.esc(p.name)}
          ${UI.tag(PLAN_KIND[p.kind] || p.kind, p.kind === 'subsidy' ? 'warn' : 'primary')}
          ${p.active ? '' : UI.tag('已停用', 'danger')}
          ${p.portal_visible ? UI.tag('線上可約', 'ok') : ''}</h3>
        <div style="font-size:13.5px;color:var(--muted);line-height:1.9;margin-bottom:8px">
          金額：${p.fee_mode === 'choice' ? `可選 ${p.fee_option_list.join(' / ')}（預設 ${p.fee}）` : UI.fmtMoney(p.fee)}
          ${p.subsidy_amount ? `　方案給付 ${UI.fmtMoney(p.subsidy_amount)}／個案付 ${UI.fmtMoney(Math.max(0, p.fee - p.subsidy_amount))}` : ''}
          ${p.venue_fee ? `　場地費 ${UI.fmtMoney(p.venue_fee)}（所方收入）` : ''}
          　時長：${p.session_minutes || App.meta.session_minutes} 分鐘
          　形式：${p.default_mode === 'online' ? '線上視訊' : '到所晤談'}
          　心理師報酬：${shareText(p)}<br>
          資格：${p.age_min || p.age_max ? `${p.age_min || 0}-${p.age_max || '不限'} 歲` : '不限年齡'}
          ${p.quota_per_year ? `　每人每年 ${p.quota_per_year} 次` : ''}
          ${p.counselor_week_limit ? `　每位心理師每週 ${p.counselor_week_limit} 人次` : ''}
          ${p.counselor_month_limit ? `　每月 ${p.counselor_month_limit} 人次` : ''}
          　本月已排 ${p.month_sessions} 人次
        </div>
        <div class="toolbar" style="margin-bottom:6px">
          <button class="btn tiny secondary" data-ep="${p.id}">編輯方案</button>
          <button class="btn tiny secondary" data-at="${p.id}">新增主題</button>
          <button class="btn tiny secondary" data-ar="${p.id}">新增心理師費率</button>
          <div class="spacer"></div>
          <button class="btn tiny danger" data-dp="${p.id}">刪除／停用</button>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div style="flex:1;min-width:260px">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">主題</div>
            ${p.topics.length ? p.topics.map(t => `<span class="tag" style="margin:2px">${UI.esc(t.name)}${t.fee ? `／${t.fee}` : ''}
              <a href="#" data-et="${t.id}" style="margin-left:4px">改</a>
              <a href="#" data-dt="${t.id}" style="margin-left:2px">刪</a></span>`).join('')
    : '<span style="color:var(--muted);font-size:13px">尚未設定主題</span>'}
          </div>
          <div style="flex:1;min-width:300px">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">心理師費率</div>
            ${p.rates.length ? UI.table(['心理師', '金額', '報酬', '週／月人次', ''], p.rates.map(r => `<tr>
                <td>${UI.esc(r.counselor_name)}${r.topic_id ? '（限主題）' : ''}</td>
                <td>${r.fee ? UI.fmtMoney(r.fee) : '沿用'}</td>
                <td>${r.share_mode === 'fixed' ? UI.fmtMoney(r.share_fixed)
      : r.share_mode === 'percent' ? Math.round(r.share_percent * 100) + '%' : '沿用'}</td>
                <td>${r.week_limit === -1 ? '沿用' : (r.week_limit || '不限')} / ${r.month_limit === -1 ? '沿用' : (r.month_limit || '不限')}</td>
                <td><button class="btn tiny secondary" data-er="${r.id}">改</button>
                  <button class="btn tiny danger" data-dr="${r.id}">刪</button></td></tr>`))
    : '<span style="color:var(--muted);font-size:13px">未設定，全所沿用方案預設</span>'}
          </div>
        </div>
      </div>`).join('')}`;

    const reload = () => App.go('plans');
    // 說明預設收合，需要時才展開，不佔掉整頁版面
    const help = el.querySelector('#planhelp'), ht = el.querySelector('#helptoggle');
    ht.onclick = () => {
      const open = help.style.display === 'none';
      help.style.display = open ? '' : 'none';
      ht.textContent = open ? '收合說明' : '展開說明';
    };
    el.querySelector('#add').onclick = () => planDialog(null, reload);
    const find = id => plans.find(p => p.id === Number(id));
    el.querySelectorAll('[data-ep]').forEach(b => { b.onclick = () => planDialog(find(b.dataset.ep), reload); });
    el.querySelectorAll('[data-at]').forEach(b => { b.onclick = () => topicDialog(Number(b.dataset.at), null, reload); });
    el.querySelectorAll('[data-ar]').forEach(b => { b.onclick = () => rateDialog(find(b.dataset.ar), null, reload); });
    el.querySelectorAll('[data-dp]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('確定要刪除此方案嗎？已有預約使用者會改為停用。')) return;
        const r = await DEL(`/service-plans/${b.dataset.dp}`);
        UI.toast(r.message || '已刪除');
        reload();
      };
    });
    el.querySelectorAll('[data-et]').forEach(a => {
      a.onclick = e => {
        e.preventDefault();
        const t = plans.flatMap(p => p.topics).find(x => x.id === Number(a.dataset.et));
        topicDialog(t.plan_id, t, reload);
      };
    });
    el.querySelectorAll('[data-dt]').forEach(a => {
      a.onclick = async e => {
        e.preventDefault();
        if (!await UI.confirm('確定要刪除此主題嗎？')) return;
        const r = await DEL(`/topics/${a.dataset.dt}`);
        UI.toast(r.message || '已刪除');
        reload();
      };
    });
    el.querySelectorAll('[data-er]').forEach(b => {
      b.onclick = () => {
        const r = plans.flatMap(p => p.rates).find(x => x.id === Number(b.dataset.er));
        rateDialog(find(r.plan_id), r, reload);
      };
    });
    el.querySelectorAll('[data-dr]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('確定要刪除此費率設定？該心理師將沿用方案預設。')) return;
        await DEL(`/rates/${b.dataset.dr}`);
        UI.toast('已刪除');
        reload();
      };
    });
  }
});

App.page('plan-board', {
  title: '方案人次',
  sub: '各心理師在限量方案的本週／本月已排人次，額滿者顯示下週餘額',
  help: [
    '有人次上限的方案（多為公費補助案），各心理師本週／本月已排幾人次一目了然，額滿的會顯示下週餘額。',
    '上限有調整時按「調整上限」；系統外已用掉的人次用「填已用人次」補登。',
  ],
  module: 'schedule',
  async render(el) {
    const date = (location.hash.split('/')[1]) || UI.today();
    const data = await GET(`/plan-board?date=${date}`);
    const byPlan = new Map();
    for (const r of data.rows) {
      if (!byPlan.has(r.plan_name)) byPlan.set(r.plan_name, []);
      byPlan.get(r.plan_name).push(r);
    }
    el.innerHTML = `<div class="toolbar">
        <input type="date" id="d" value="${date}">
        <div class="spacer"></div></div>
      ${[...byPlan.entries()].map(([name, rows]) => `<div class="card"><h3>${UI.esc(name)}
        ${App.can('settings') ? `<button class="btn tiny danger" data-delplan="${rows[0].plan_id}"
          style="float:right">刪除方案</button>` : ''}</h3>
        ${UI.table(['心理師', `本週（${rows[0].week_start} ~ ${rows[0].week_end}）`, '本月', '狀態', ''], rows.map((r, i) => `<tr>
          <td>${UI.esc(r.counselor_name)}</td>
          <td>${r.week_used}${r.week_limit ? ' / ' + r.week_limit : '（不限）'}
            ${r.override_week >= 0 ? '<span style="font-size:12px;color:var(--muted)">　個別設定</span>' : ''}</td>
          <td>${r.month_used}${r.month_limit ? ' / ' + r.month_limit : '（不限）'}
            ${r.override_month >= 0 ? '<span style="font-size:12px;color:var(--muted)">　個別設定</span>' : ''}</td>
          <td>${r.week_full
      ? UI.tag('本週額滿', 'danger') + (r.next_week ? `<span style="font-size:12px;color:var(--muted)">　下週 ${r.next_week.week_start} 起尚餘 ${r.next_week.remaining ?? '不限'} 人次</span>` : '')
      : r.month_full ? UI.tag('本月額滿', 'danger')
        : UI.tag(`尚可 ${r.week_remaining ?? '不限'} 人次`, 'ok')}</td>
          <td style="text-align:right;white-space:nowrap">${App.can('settings') || r.counselor_id === App.me.id
      ? `<button class="btn tiny secondary" data-lim="${UI.esc(name)}" data-i="${i}">調整上限</button>
         <button class="btn tiny secondary" data-use="${UI.esc(name)}" data-i="${i}">填已用人次</button>` : ''}</td></tr>`))}
      </div>`).join('') || '<div class="empty">目前沒有設定人次上限的方案</div>'}`;
    el.querySelector('#d').onchange = e => { location.hash = `plan-board/${e.target.value}`; };

    // 已用人次可以直接填實際數字：他所已接的案、系統外排的場次都算進去
    el.querySelectorAll('[data-use]').forEach(b => {
      b.onclick = () => {
        const r = byPlan.get(b.dataset.use)[Number(b.dataset.i)];
        UI.modal({
          title: `${r.counselor_name}　已用人次`,
          body: `<div class="form-grid">
              ${UI.input('week_used', `本週已用（${r.week_start} ~ ${r.week_end}）`, { type: 'number', min: 0, value: r.week_used })}
              ${UI.input('month_used', `本月已用（${r.month}）`, { type: 'number', min: 0, value: r.month_used })}
              ${UI.input('note', '調整說明', { value: '', full: true, placeholder: '例如：他所已接 2 位' })}
            </div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              系統內已排 本週 ${r.week_system_used}、本月 ${r.month_system_used} 人次；
              填入的數字與系統統計的差額會存成人工調整，之後系統內新增預約仍會照常累加。
              調整記入稽核軌跡。</div>`,
          onSubmit: async bodyEl => {
            await PUT('/plan-board/usage', Object.assign({
              plan_id: r.plan_id, counselor_id: r.counselor_id, date
            }, UI.formData(bodyEl)));
            UI.toast('已更新已用人次');
            App.go(`plan-board/${date}`);
          }
        });
      };
    });
    el.querySelectorAll('[data-delplan]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除整個方案？已有預約使用過的方案會改為停用以保留歷史紀錄。')) return;
        const r = await DEL(`/service-plans/${b.dataset.delplan}`);
        UI.toast(r.message || '已刪除');
        App.go(`plan-board/${date}`);
      };
    });
    // 人次上限就在這頁改：-1 沿用方案、0 不限、其他為個別上限
    el.querySelectorAll('[data-lim]').forEach(b => {
      b.onclick = () => {
        const r = byPlan.get(b.dataset.lim)[Number(b.dataset.i)];
        const field = (key, label, ov, planVal) =>
          UI.select(`${key}_mode`, `${label}上限`, [
            ['inherit', `沿用方案設定（${planVal > 0 ? planVal + ' 人次' : '不限'}）`],
            ['none', '不限'],
            ['custom', '個別上限']
          ], { value: ov < 0 ? 'inherit' : ov === 0 ? 'none' : 'custom' })
          + UI.input(`${key}_value`, `${label}人次`,
            { type: 'number', min: 1, value: ov > 0 ? ov : '', placeholder: '例如 6' });
        UI.modal({
          title: `${r.counselor_name}　${b.dataset.lim}`,
          body: `<div class="form-grid">
              ${field('week', '每週', r.override_week, r.plan_week_limit)}
              ${field('month', '每月', r.override_month, r.plan_month_limit)}
            </div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              只影響這位心理師在此方案的上限，其他心理師不受影響；調整會記入稽核軌跡。
              已排入的預約不會被回頭取消。
              ${App.can('settings') ? '' : '心理師僅能調整自己的上限。'}</div>`,
          onSubmit: async bodyEl => {
            const f = UI.formData(bodyEl);
            const pick = key => (f[key + '_mode'] === 'inherit' ? -1
              : f[key + '_mode'] === 'none' ? 0 : Math.max(1, Number(f[key + '_value']) || 1));
            await PUT('/plan-board/limit', {
              plan_id: r.plan_id, counselor_id: r.counselor_id,
              week_limit: pick('week'), month_limit: pick('month')
            });
            UI.toast('已更新人次上限');
            App.go(`plan-board/${date}`);
          }
        });
      };
    });
  }
});

App.page('income', {
  title: '心理師收支',
  sub: '依方案別結算每位心理師每月的服務量、收入、報酬與所方淨收',
  help: [
    '依方案別結算每位心理師每月的服務量、收入、報酬與所方淨收。',
    '按「明細／列印」看該心理師逐筆晤談的組成，可列印給對方核對。',
    '只計已完成的晤談。',
  ],
  module: 'reports',
  async render(el) {
    const month = (location.hash.split('/')[1]) || UI.thisMonth();
    const d = await GET(`/plan-income?month=${month}`);
    const t = d.total;
    el.innerHTML = `<div class="toolbar">
        <input type="month" id="m" value="${month}">
        <div class="spacer"></div></div>
      <div class="card"><h3>${month} 全所合計</h3>
        ${UI.table(['項目', '金額／數量', '說明'], [
    `<tr><td>完成場次</td><td style="text-align:right"><strong>${t.sessions}</strong></td>
       <td style="color:var(--muted)">未到 ${t.no_shows} 場</td></tr>`,
    `<tr><td>服務總額</td><td style="text-align:right"><strong>${UI.fmtMoney(t.gross)}</strong></td>
       <td style="color:var(--muted)">本月已完成晤談的應收合計</td></tr>`,
    `<tr><td>方案給付</td><td style="text-align:right">${UI.fmtMoney(t.subsidy)}</td>
       <td style="color:var(--muted)">補助方案由公部門支付的部分</td></tr>`,
    `<tr><td>個案自付</td><td style="text-align:right">${UI.fmtMoney(t.self_pay)}</td>
       <td style="color:var(--muted)">其中場地費 ${UI.fmtMoney(t.venue)}</td></tr>`,
    `<tr><td>心理師報酬</td><td style="text-align:right"><strong>${UI.fmtMoney(t.share)}</strong></td>
       <td style="color:var(--muted)">以「服務總額 − 場地費」為基數計算</td></tr>`,
    `<tr><td>所方淨收</td><td style="text-align:right"><strong>${UI.fmtMoney(t.center)}</strong></td>
       <td style="color:var(--muted)">服務總額 − 心理師報酬</td></tr>`,
    `<tr><td>實收</td><td style="text-align:right">${UI.fmtMoney(t.collected)}</td>
       <td style="color:var(--muted)">已收款金額</td></tr>`,
    `<tr><td>未收</td><td style="text-align:right;color:var(--danger)">${UI.fmtMoney(t.uncollected)}</td>
       <td style="color:var(--muted)">尚未收款，可於收費管理催收</td></tr>`
  ])}
        ${UI.barChart(d.rows.map(r => ({ label: r.counselor_name, value: r.share, note: `${r.sessions} 場` })),
      { horizontal: true, format: v => UI.fmtMoney(v), title: '心理師報酬' })}
      </div>
      ${d.rows.map(r => `<div class="card"><h3>${UI.esc(r.counselor_name)}
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            ${r.sessions} 場｜應收 ${UI.fmtMoney(r.gross)}｜報酬 ${UI.fmtMoney(r.share)}｜所方 ${UI.fmtMoney(r.center)}</span>
          ${r.payout_status === 'paid' ? UI.tag('報酬已付', 'ok') : r.payout_status === 'pending' ? UI.tag('報酬待付', 'warn') : ''}</h3>
        ${UI.table(['方案', '場次', '服務總額', '方案給付', '個案自付', '場地費', '心理師報酬', '所方淨收'],
      r.plans.map(p => `<tr>
          <td>${UI.esc(p.plan_name)}</td><td>${p.sessions}</td><td>${UI.fmtMoney(p.gross)}</td>
          <td>${UI.fmtMoney(p.subsidy)}</td><td>${UI.fmtMoney(p.self_pay)}</td>
          <td>${UI.fmtMoney(p.venue)}</td>
          <td>${UI.fmtMoney(p.share)}</td><td>${UI.fmtMoney(p.center)}</td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
          心理師報酬以「服務總額 − 場地費」為基數計算（場地費全額為所方收入），
          比例或鐘點費在「系統 → 方案設定」設定；金額於晤談按下「完成」時鎖定，事後改設定不會回頭變動此表。</div>
        <div class="toolbar" style="margin-top:8px"><div class="spacer"></div>
          <button class="btn tiny secondary" data-detail="${r.counselor_id}">明細／列印</button></div>
      </div>`).join('') || '<div class="empty">本月尚無已完成的晤談</div>'}`;

    el.querySelector('#m').onchange = e => { location.hash = `income/${e.target.value}`; };
    el.querySelectorAll('[data-detail]').forEach(b => {
      b.onclick = async () => {
        const dd = await GET(`/plan-income/${b.dataset.detail}/detail?month=${month}`);
        UI.modal({
          title: `${dd.counselor.name}　${month} 明細`, wide: true, hideFooter: true,
          body: `<div id="printable">
            <div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:8px">
              ${UI.esc(dd.center_name)}　心理師服務明細</div>
            <div style="font-size:14px;margin-bottom:8px">心理師：${UI.esc(dd.counselor.name)}　結算月份：${month}</div>
            ${UI.table(['日期', '時間', '個案', '方案／主題', '狀態', '個案自付', '方案給付', '報酬', '收款'], dd.rows.map(r => `<tr>
              <td>${r.date}</td><td>${r.start_time}</td>
              <td>${UI.esc(r.client_code || '')} ${UI.esc(r.client_name || '')}</td>
              <td>${UI.esc(r.plan_name || '-')}${r.topic_name ? '／' + UI.esc(r.topic_name) : ''}</td>
              <td>${TW.appt_status[r.status]}</td>
              <td>${UI.fmtMoney(r.fee)}</td><td>${UI.fmtMoney(r.subsidy_amount || 0)}</td>
              <td>${UI.fmtMoney(r.counselor_share)}</td>
              <td>${r.invoice_status ? TW.inv_status[r.invoice_status] : '-'}</td></tr>`))}
            <div style="margin-top:10px;font-size:15px;text-align:right">
              服務總額合計 ${UI.fmtMoney(dd.total_gross)}　心理師報酬合計 <strong>${UI.fmtMoney(dd.total_share)}</strong></div>
          </div>
          <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
        });
      };
    });
  }
});

// 心理師年報表（督考用）：一位心理師一整年，紀錄摘要與收費、收據並排在同一列。
App.page('annual', {
  title: '心理師年報表',
  sub: '一位心理師一整年的晤談紀錄摘要、收費拆帳與收據號並排，供督考逐筆核對',
  help: [
    '選年度與心理師，就看得到整年逐月的明細；每一列同時有治療摘要、費用、所方／心理師拆帳與收據號。',
    '「未附收據」「未寫紀錄」會標紅，督考前可先把這些補齊。',
    '「匯出 Excel」會產生 12 個月分頁＋各方案分頁＋年度彙總，格式比照所方原本那本年報表。',
    '治療摘要屬紀錄內容，僅管理者、督導與該心理師本人看得到。',
  ],
  module: 'reports',
  async render(el) {
    const [year, picked] = (location.hash.split('/').slice(1));
    const y = year || String(new Date().getFullYear());
    const list = await GET(`/annual-report?year=${y}`);
    const cid = Number(picked) || (list.counselors[0] && list.counselors[0].id) || 0;

    el.innerHTML = `<div class="toolbar">
        <label>年度</label><input id="y" type="number" value="${y}" style="width:100px">
        <label>心理師</label>
        <select id="c">${list.counselors.map(c =>
    `<option value="${c.id}"${c.id === cid ? ' selected' : ''}>${UI.esc(c.name)}（${c.sessions} 人次）</option>`).join('')}</select>
        <div class="spacer"></div>
        <button class="btn secondary" id="xls">匯出 Excel</button>
        <button class="btn secondary" id="print">列印／PDF</button>
      </div><div id="body"></div>`;

    const go = () => {
      location.hash = `annual/${el.querySelector('#y').value}/${el.querySelector('#c').value}`;
    };
    el.querySelector('#y').onchange = go;
    el.querySelector('#c').onchange = go;
    el.querySelector('#xls').onclick = () => window.open(
      `/api/annual-report/${el.querySelector('#c').value}/export?year=${el.querySelector('#y').value}&format=xls`, '_blank');
    el.querySelector('#print').onclick = () => window.open(
      `/api/annual-report/${el.querySelector('#c').value}/export?year=${el.querySelector('#y').value}&format=pdf`, '_blank');

    const box = el.querySelector('#body');
    if (!cid) { box.innerHTML = '<div class="empty">此年度尚無已完成的晤談</div>'; return; }
    const d = await GET(`/annual-report/${cid}?year=${y}`);
    const noteLabel = { missing: '未寫', draft: '未定稿', signed: '已定稿' };
    const row = r => `<tr>
      <td>${r.date}</td><td>${UI.esc(r.case_code)}</td>
      <td>${UI.esc(r.client_code || r.client_name)}</td>
      <td style="font-size:12px;max-width:320px">${UI.esc(r.summary)}</td>
      <td style="text-align:right">${UI.fmtMoney(r.fee)}</td>
      <td>${UI.esc(r.category)}</td>
      <td style="text-align:right">${UI.fmtMoney(r.center)}</td>
      <td style="text-align:right">${UI.fmtMoney(r.share)}</td>
      <td>${r.receipt_no ? UI.esc(r.receipt_no) : '<span style="color:var(--danger)">未附</span>'}</td>
      <td>${TW.inv_status[r.invoice_status] || (r.invoice_status === 'none' ? '未開單' : r.invoice_status)}</td>
      <td>${r.note_status === 'missing' ? '<span style="color:var(--danger)">未寫</span>' : noteLabel[r.note_status]}</td></tr>`;
    const heads = ['日期', '編碼', '個案', '治療摘要／報告', '費用', '類別', '所方', '心理師報酬', '收據號', '收款', '紀錄'];
    const sumLine = (label, t) => `<tr><td>${label}</td><td>${t.sessions}</td>
      <td style="text-align:right">${UI.fmtMoney(t.fee)}</td>
      <td style="text-align:right">${UI.fmtMoney(t.center)}</td>
      <td style="text-align:right">${UI.fmtMoney(t.share)}</td>
      <td>${t.no_receipt}</td><td>${t.no_note}</td></tr>`;

    box.innerHTML = `<div class="stat-grid">
        <div class="stat"><div class="num">${d.total.sessions}</div><div class="label">全年人次</div></div>
        <div class="stat"><div class="num">${UI.fmtMoney(d.total.fee)}</div><div class="label">費用合計</div></div>
        <div class="stat"><div class="num">${UI.fmtMoney(d.total.share)}</div><div class="label">心理師報酬</div></div>
        <div class="stat"><div class="num">${UI.fmtMoney(d.total.center)}</div><div class="label">所方</div></div>
        <div class="stat"><div class="num ${d.total.no_receipt ? 'warn' : ''}">${d.total.no_receipt}</div><div class="label">未附收據</div></div>
        <div class="stat"><div class="num ${d.total.no_note ? 'warn' : ''}">${d.total.no_note}</div><div class="label">未寫紀錄</div></div>
      </div>
      ${d.can_see_summary ? '' : '<div class="notice warn">治療摘要屬晤談紀錄內容，僅管理者、督導與該心理師本人可檢視。</div>'}
      <div class="card"><h3>年度彙總</h3>
        ${UI.table(['項目', '人次', '費用合計', '所方', '心理師報酬', '未附收據', '未寫紀錄'],
    d.months.map(m => sumLine(m.label, m.total))
      .concat([sumLine('<strong>自費</strong>', d.self_total), sumLine('<strong>機構</strong>', d.org_total),
        sumLine('<strong>全年</strong>', d.total)])
      .concat(d.plans.map(p => sumLine('方案：' + UI.esc(p.plan_name), p))))}</div>
      ${d.months.filter(m => m.rows.length).map(m => `<div class="card">
        <h3>${m.label}
          <span style="font-size:13px;font-weight:400;color:var(--muted)">
            ${m.total.sessions} 人次｜費用 ${UI.fmtMoney(m.total.fee)}｜所方 ${UI.fmtMoney(m.total.center)}｜報酬 ${UI.fmtMoney(m.total.share)}</span></h3>
        ${UI.table(heads, m.rows.map(row))}
        <div style="font-size:12.5px;color:var(--muted)">
          自費案 ${m.self.sessions} 人次／${UI.fmtMoney(m.self.fee)}　機構案 ${m.org.sessions} 人次／${UI.fmtMoney(m.org.fee)}</div>
      </div>`).join('') || '<div class="empty">此年度尚無已完成的晤談</div>'}`;
  }
});
