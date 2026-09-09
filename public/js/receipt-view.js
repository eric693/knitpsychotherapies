// 收據版面與匯出。所方後台與個案憑連結開啟的公開頁共用同一份，
// 這樣「我們開立的」「列印出來的」「LINE 傳給個案的」三者一定是同一個版面 ——
// 個案拿去申請保險時，不會出現「你傳給我的跟收據長得不一樣」。

const Receipt = {
  money(v) { return 'NT$ ' + Number(v || 0).toLocaleString('zh-TW'); },

  // 印花稅總繳戳記：內容取自系統設定，與所內用印的戳章一致
  stampHtml(r) {
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
  },

  // 章的寬度可由系統設定調整（receipt_seal_size），預設 192px —— 原本 96px 蓋出來字看不清楚
  sealSize(r) {
    if (!r.receipt_seal_image) return 0;
    return Math.max(48, Math.min(400, Number(r.receipt_seal_size) || 192));
  },
  // 發票章（統一編號章）：後台上傳的掃描圖，沒上傳就不印，不會出現破圖。
  // 放大之後若還留在文字流裡會把「抬頭」那一列撐開一大塊空白，壓在字上又會蓋住統編與日期；
  // 因此改成絕對定位在資料區右側，並讓表格右邊留出等寬的空位，章不壓字也不撐版。
  sealHtml(r) {
    const size = Receipt.sealSize(r);
    if (!size) return '';
    return `<img src="${UI.esc(r.receipt_seal_image)}" alt="諮商所發票章"
      style="width:${size}px;height:auto;mix-blend-mode:multiply;
        position:absolute;right:0;top:50%;transform:translateY(-50%);pointer-events:none">`;
  },

  // 合併開立時逐次列出日期與金額。只有一筆就不畫這張表，維持原本的樣子。
  linesHtml(r) {
    const lines = r.lines || [];
    if (lines.length < 2) return '';
    return `<table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13px">
      <tr style="color:#6b7a85">
        <th style="text-align:left;padding:4px 0;border-bottom:1px solid #dfe5ea">服務日期</th>
        <th style="text-align:left;padding:4px 0;border-bottom:1px solid #dfe5ea">項目</th>
        <th style="text-align:left;padding:4px 0;border-bottom:1px solid #dfe5ea">心理師</th>
        <th style="text-align:right;padding:4px 0;border-bottom:1px solid #dfe5ea">金額</th></tr>
      ${lines.map(l => `<tr>
        <td style="padding:4px 0">${UI.esc(l.service_date || l.date || '')}</td>
        <td style="padding:4px 0">${UI.esc(l.item || '')}${l.plan_name ? `（${UI.esc(l.plan_name)}）` : ''}</td>
        <td style="padding:4px 0">${UI.esc(l.counselor_name || '－')}</td>
        <td style="padding:4px 0;text-align:right">${Receipt.money(l.amount)}</td></tr>`).join('')}
    </table>`;
  },

  html(r) {
    const multi = (r.lines || []).length > 1;
    const seal = Receipt.sealSize(r);
    return `<div id="printable" style="font-size:14px;line-height:2;max-width:640px;margin:0 auto;
        background:#fff;color:#22313a">
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
      <div style="position:relative${seal ? `;padding-right:${seal + 12}px` : ''}">
      <table style="width:100%;border-collapse:collapse;margin-top:10px">
        <tr><td style="width:110px;color:#6b7a85">收據編號</td><td><strong>${UI.esc(r.receipt_no)}</strong></td>
          <td style="width:80px;color:#6b7a85">日期</td><td>${UI.esc(r.date)}</td></tr>
        <tr><td style="color:#6b7a85">抬頭</td><td>${UI.esc(r.title || r.client_name)}</td>
          <td style="color:#6b7a85">統一編號</td>
          <td>${UI.esc(r.tax_id || '－')}</td></tr>
        <tr><td style="color:#6b7a85">個案編號</td><td>${UI.esc(r.client_code || '')}</td>
          <td style="color:#6b7a85">服務日期</td><td>${UI.esc(r.service_date || r.date)}</td></tr>
        <tr><td style="color:#6b7a85">服務項目</td><td colspan="3">${UI.esc(r.item)}
          ${r.plan_name ? '（' + UI.esc(r.plan_name) + '）' : ''}</td></tr>
        <tr><td style="color:#6b7a85">心理師</td><td>${UI.esc(r.counselor_name || '－')}</td>
          <td style="color:#6b7a85">付款方式</td><td>${UI.esc(r.method || '－')}</td></tr>
      </table>
      ${Receipt.sealHtml(r)}
      </div>
      ${Receipt.linesHtml(r)}
      <div style="border-top:1px solid #c9d2d9;border-bottom:1px solid #c9d2d9;margin-top:10px;padding:10px 0;
        font-size:20px;font-weight:700;text-align:right">${multi ? '合計　' : ''}${Receipt.money(r.amount)}</div>
      ${r.reissue_of ? `<div style="font-size:12.5px;color:#6b7a85">（本張係重開，原收據編號 ${UI.esc(r.reissue_of)}）</div>` : ''}
      ${r.note ? `<div style="font-size:13px;margin-top:6px">備註：${UI.nl2br(r.note)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:26px;font-size:13.5px">
        <div>${r.issuer_name ? '開立人：' + UI.esc(r.issuer_name) : ''}</div>
        <div style="display:flex;align-items:center;gap:12px">
          <span>負責心理師：${UI.esc(r.center_director || '')}　　（用印）</span>
          ${Receipt.stampHtml(r)}
        </div>
      </div>
      <div style="font-size:12px;color:#6b7a85;margin-top:16px">${UI.esc(r.receipt_footer || '')}</div>
    </div>`;
  },

  // ---- 匯出 ----
  // 把畫面上的收據原樣畫成點陣圖。做法是把節點包進 SVG 的 foreignObject 再畫到 canvas，
  // 不依賴任何外部套件（這台機器也連不出去裝）。印章是 data URI，畫布不會被污染。
  async toCanvas(node, scale = 2) {
    const width = 680;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
    const box = document.createElement('div');
    box.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    box.style.cssText = `width:${width}px;padding:24px;background:#fff;box-sizing:border-box;`
      + 'font-family:"PingFang TC","Microsoft JhengHei","Noto Sans TC",system-ui,sans-serif';
    box.appendChild(node.cloneNode(true));
    holder.appendChild(box);
    document.body.appendChild(holder);
    // 先量高度再序列化：foreignObject 不會自己撐開，高度算錯就會被截掉一截
    const height = Math.ceil(box.getBoundingClientRect().height);
    const xml = new XMLSerializer().serializeToString(box);
    holder.remove();

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<foreignObject x="0" y="0" width="${width}" height="${height}">${xml}</foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(img, 0, 0);
    return canvas;
  },

  async toPngBlob(node, scale = 2) {
    const canvas = await Receipt.toCanvas(node, scale);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  },

  // 直接產生 PDF：把上面那張圖包成單頁 PDF。
  // 走瀏覽器列印對話框也能存成 PDF，但個案在手機上多半找不到那個選項，
  // 所以這裡自己組一份最小的 PDF（單一 JPEG 影像），按一下就下載得到檔案。
  async toPdfBlob(node) {
    const canvas = await Receipt.toCanvas(node, 2);
    const jpeg = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const bin = atob(jpeg);
    const jpegBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) jpegBytes[i] = bin.charCodeAt(i);

    // A4 寬 595.28pt，等比縮放後置中；高度超過 A4 就以高度為準
    const A4 = { w: 595.28, h: 841.89 };
    let pw = A4.w - 40, ph = pw * canvas.height / canvas.width;
    if (ph > A4.h - 40) { ph = A4.h - 40; pw = ph * canvas.width / canvas.height; }
    const x = ((A4.w - pw) / 2).toFixed(2), y = (A4.h - 20 - ph).toFixed(2);

    const parts = [];
    const offsets = [0];
    let len = 0;
    const enc = new TextEncoder();
    const push = data => {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      parts.push(bytes);
      len += bytes.length;
    };
    const obj = (n, body, stream) => {
      offsets[n] = len;
      push(`${n} 0 obj\n${body}\n`);
      if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
      push('endobj\n');
    };
    const content = `q ${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} ${x} ${y} cm /Im0 Do Q`;
    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h} ]`
      + ' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    obj(4, `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height}`
      + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`, jpegBytes);
    obj(5, `<< /Length ${enc.encode(content).length} >>`, content);
    const xref = len;
    let table = `xref\n0 6\n0000000000 65535 f \n`;
    for (let n = 1; n <= 5; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(len);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return new Blob([out], { type: 'application/pdf' });
  },

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  // 三顆下載／列印按鈕的共同行為。node 為畫面上的 #printable 節點。
  bindExport(root, node, r, onPrinted) {
    const busy = async (btn, fn) => {
      const was = btn.textContent;
      btn.disabled = true;
      btn.textContent = '產生中…';
      try { await fn(); } catch (e) { UI.err(e); } finally { btn.disabled = false; btn.textContent = was; }
    };
    const pdf = root.querySelector('[data-rc="pdf"]');
    if (pdf) pdf.onclick = () => busy(pdf, async () => {
      Receipt.download(await Receipt.toPdfBlob(node), `收據-${r.receipt_no}.pdf`);
    });
    const png = root.querySelector('[data-rc="png"]');
    if (png) png.onclick = () => busy(png, async () => {
      Receipt.download(await Receipt.toPngBlob(node), `收據-${r.receipt_no}.png`);
    });
    const pr = root.querySelector('[data-rc="print"]');
    if (pr) pr.onclick = async () => { if (onPrinted) await onPrinted(); window.print(); };
  }
};
