/* ============================================================
   tools.js — 工具定義與實作
   每個 run() 透過 addResult() 產出檔案，回傳一句結果摘要。
   ============================================================ */
'use strict';

/* ---------------- 合併 ---------------- */

async function runMerge(files) {
  if (files.length < 2) throw new Error('請至少選 2 個 PDF 才需要合併。');

  const out = await PDFDocument.create();
  let pageCount = 0;

  for (let i = 0; i < files.length; i++) {
    setProgress(i, files.length, `正在合併「${files[i].name}」…`);
    const src = await openWithPdfLib(files[i].buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    pageCount += pages.length;
  }

  const bytes = await out.save();
  addResult(safeName($('#merge-name').value || '合併結果') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));
  return `${files.length} 份檔案合併成 1 份，共 ${pageCount} 頁。`;
}

/* ---------------- 分割 ---------------- */

async function runSplit(files) {
  const item = files[0];
  const mode = getSegmented('#split-mode');
  const src = await openWithPdfLib(item.buf);
  const total = src.getPageCount();
  const base = safeName(baseName(item.name));

  const build = async (indices, name) => {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    addResult(name, new Blob([bytes], { type: 'application/pdf' }));
  };

  const indices = parseRanges($('#split-ranges').value, total);

  if (mode === 'ranges') {
    setProgress(0, 1, `正在取出 ${indices.length} 頁…`);
    await build(indices, `${base}-擷取.pdf`);
    return `取出 ${indices.length} 頁（原檔共 ${total} 頁）。`;
  }

  if (mode === 'each') {
    for (let i = 0; i < indices.length; i++) {
      setProgress(i, indices.length, `正在輸出第 ${indices[i] + 1} 頁…`);
      await build([indices[i]], `${base}-p${indices[i] + 1}.pdf`);
    }
    return `拆成 ${indices.length} 份單頁 PDF。`;
  }

  const size = Math.max(1, parseInt($('#split-chunk').value, 10) || 1);
  const groups = [];
  for (let i = 0; i < indices.length; i += size) groups.push(indices.slice(i, i + size));

  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    setProgress(g, groups.length, `正在輸出第 ${g + 1} / ${groups.length} 份…`);
    const label = grp.length > 1 ? `p${grp[0] + 1}-${grp[grp.length - 1] + 1}` : `p${grp[0] + 1}`;
    await build(grp, `${base}-${label}.pdf`);
  }
  return `依每 ${size} 頁一份，拆成 ${groups.length} 份。`;
}

/* ---------------- 頁面管理 ---------------- */

async function runOrganize(files) {
  const item = files[0];
  if (!organizeState) throw new Error('縮圖還沒載入完成，請稍候再試。');

  const keep = organizeState.pages.filter((p) => !p.deleted);
  if (!keep.length) throw new Error('所有頁面都被刪掉了，至少要留一頁。');

  setProgress(0, 1, '正在匯出…');
  const src = await openWithPdfLib(item.buf);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, keep.map((p) => p.orig));

  copied.forEach((page, i) => {
    if (keep[i].rot) {
      // 疊加在原本的頁面旋轉之上
      page.setRotation(degrees((page.getRotation().angle + keep[i].rot) % 360));
    }
    out.addPage(page);
  });

  const bytes = await out.save();
  addResult(safeName($('#organize-name').value || '編輯結果') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));

  const removed = organizeState.pages.length - keep.length;
  return `匯出 ${keep.length} 頁${removed ? `，刪掉 ${removed} 頁` : ''}。`;
}

/* ---------------- PDF → 圖片 ---------------- */

async function runPdf2Img(files, password) {
  const type = getSegmented('#p2i-format');
  const dpi = parseInt($('#p2i-dpi').value, 10);
  const quality = type === 'image/jpeg' ? parseFloat($('#p2i-quality').value) : undefined;
  const ext = type === 'image/jpeg' ? '.jpg' : '.png';

  const docs = [];
  let totalPages = 0;
  for (const item of files) {
    const doc = await openWithPdfJs(item.buf, password);
    docs.push({ doc, name: item.name });
    totalPages += doc.numPages;
  }

  let done = 0;
  for (const { doc, name } of docs) {
    const base = safeName(baseName(name));
    for (let n = 1; n <= doc.numPages; n++) {
      setProgress(done, totalPages, `「${name}」第 ${n} / ${doc.numPages} 頁…`);
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: dpi / 72 });
      const { canvas, ctx } = makeCanvas(vp);
      await renderPage(page, vp, ctx);
      const blob = await canvasToBlob(canvas, type, quality);
      freeCanvas(canvas);
      addResult(`${base}${doc.numPages > 1 ? `-p${n}` : ''}${ext}`, blob);
      done++;
    }
    doc.destroy();
  }

  return `輸出 ${totalPages} 張圖片（${dpi} DPI）。`;
}

/* ---------------- 圖片 → PDF ---------------- */

async function runImg2Pdf(files) {
  const sizeMode = $('#i2p-size').value;
  const margin = Math.max(0, parseInt($('#i2p-margin').value, 10) || 0);
  const out = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在加入「${item.name}」…`);

    const isJpg = /jpe?g$/i.test(item.type || '') || /\.jpe?g$/i.test(item.name);
    let img;
    try {
      img = isJpg ? await out.embedJpg(copyBuf(item.buf)) : await out.embedPng(copyBuf(item.buf));
    } catch {
      throw new Error(`「${item.name}」不是有效的 PNG / JPG，或使用了不支援的編碼（例如 CMYK JPEG）。`);
    }

    if (sizeMode === 'fit') {
      const page = out.addPage([img.width + margin * 2, img.height + margin * 2]);
      page.drawImage(img, { x: margin, y: margin, width: img.width, height: img.height });
    } else {
      const [pw, ph] = sizeMode === 'a4l' ? [A4.h, A4.w] : [A4.w, A4.h];
      const page = out.addPage([pw, ph]);
      const scale = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }

  const bytes = await out.save();
  addResult(safeName($('#i2p-name').value || '圖片轉PDF') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));
  return `${files.length} 張圖片組成 ${files.length} 頁 PDF。`;
}

/* ---------------- PDF → 文字 ---------------- */

async function runPdf2Txt(files, password) {
  const perPage = getSegmented('#t-mode') === 'page';
  let totalChars = 0;
  let emptyDocs = 0;

  for (let f = 0; f < files.length; f++) {
    const item = files[f];
    const doc = await openWithPdfJs(item.buf, password);
    const base = safeName(baseName(item.name));
    const all = [];

    for (let n = 1; n <= doc.numPages; n++) {
      setProgress(f + n / doc.numPages, files.length, `「${item.name}」第 ${n} / ${doc.numPages} 頁…`);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();

      const lines = [];
      let cur = '';
      let lastY = null;
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        const y = it.transform ? it.transform[5] : null;
        // pdf.js 有給 hasEOL 就用它；沒有的話靠 y 座標變化判斷換行
        const newLine = it.hasEOL !== undefined ? false : lastY !== null && y !== null && Math.abs(y - lastY) > 2;
        if (newLine && cur) { lines.push(cur); cur = ''; }
        cur += it.str;
        if (it.hasEOL) { lines.push(cur); cur = ''; }
        if (y !== null) lastY = y;
      }
      if (cur) lines.push(cur);

      const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim();
      totalChars += text.length;

      if (perPage) {
        // 加 BOM，Windows 記事本才不會把 UTF-8 當成 ANSI 顯示成亂碼
        addResult(`${base}-p${n}.txt`, new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }));
      } else {
        all.push(doc.numPages > 1 ? `───── 第 ${n} 頁 ─────\n${text}` : text);
      }
    }

    if (!perPage) {
      const joined = all.join('\n\n');
      if (!joined.replace(/─|第|頁|\s/g, '')) emptyDocs++;
      addResult(`${base}.txt`, new Blob(['﻿' + joined], { type: 'text/plain;charset=utf-8' }));
    }
    doc.destroy();
  }

  if (totalChars === 0) {
    throw new Error(
      '這份 PDF 抽不到任何文字。\n' +
        '通常代表它是掃描檔 —— 頁面其實是一張圖片，裡面沒有文字圖層。\n' +
        '要處理這種檔案需要 OCR（文字辨識），本工具箱沒有內建。'
    );
  }
  return `抽出 ${totalChars.toLocaleString('zh-TW')} 個字元${emptyDocs ? `（其中 ${emptyDocs} 份幾乎沒有文字，可能是掃描檔）` : ''}。`;
}

/* ---------------- 浮水印 ---------------- */

/** 從畫面讀出目前的浮水印設定。預覽與實際輸出共用，確保所見即所得。 */
function readWatermarkOptions() {
  return {
    kind: getSegmented('#wm-kind'),          // 'text' | 'image'
    text: $('#wm-text').value.trim(),
    size: Math.max(6, parseInt($('#wm-size').value, 10) || 48),
    scale: Math.max(5, parseInt($('#wm-imgscale').value, 10) || 40) / 100,
    opacity: parseFloat($('#wm-opacity').value),
    angle: parseFloat($('#wm-angle').value) || 0,
    cssColor: $('#wm-color').value,
    tile: getSegmented('#wm-tile') === 'yes',
  };
}

/**
 * 把浮水印畫到 doc 的每一頁（或只畫指定頁）。
 * 回傳實際處理的頁數。
 */
async function stampWatermark(doc, opt, imageBytes) {
  const painter = new TextPainter(doc);
  const color = hexToRgb(opt.cssColor);
  let embedded = null;
  let natural = null;

  if (opt.kind === 'image') {
    if (!imageBytes) throw new Error('請先選擇要當浮水印的圖片。');
    try {
      embedded = isPngBytes(imageBytes)
        ? await doc.embedPng(copyBuf(imageBytes))
        : await doc.embedJpg(copyBuf(imageBytes));
    } catch {
      throw new Error('浮水印圖片讀取失敗，請改用一般的 PNG 或 JPG。');
    }
    natural = { width: embedded.width, height: embedded.height };
  } else if (!opt.text) {
    throw new Error('請輸入浮水印文字。');
  }

  let count = 0;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();

    // 圖片依頁面寬度等比縮放，文字則直接用字級
    let mark;
    if (embedded) {
      const w = width * opt.scale;
      mark = { width: w, height: w * (natural.height / natural.width) };
    } else {
      mark = await painter.measure(opt.text, opt.size, opt.cssColor);
    }

    const place = async (cx, cy) => {
      if (embedded) {
        const rad = (opt.angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        page.drawImage(embedded, {
          x: cx - (mark.width / 2) * cos + (mark.height / 2) * sin,
          y: cy - (mark.width / 2) * sin - (mark.height / 2) * cos,
          width: mark.width,
          height: mark.height,
          opacity: opt.opacity,
          rotate: degrees(opt.angle),
        });
      } else {
        await painter.drawCentered(page, opt.text, {
          cx, cy, size: opt.size, cssColor: opt.cssColor, color, opacity: opt.opacity, angle: opt.angle,
        });
      }
    };

    if (opt.tile) {
      const stepX = Math.max(mark.width * 1.4, 70);
      const stepY = Math.max(mark.height * (embedded ? 1.6 : 4), 70);
      for (let y = stepY / 2; y < height + stepY; y += stepY) {
        for (let x = stepX / 2; x < width + stepX; x += stepX) await place(x, y);
      }
    } else {
      await place(width / 2, height / 2);
    }
    count++;
  }
  return count;
}

async function runWatermark(files) {
  const opt = readWatermarkOptions();
  const imageBytes = watermarkImage ? watermarkImage.buf : null;
  let pageTotal = 0;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在處理「${item.name}」…`);
    const doc = await openWithPdfLib(item.buf);
    pageTotal += await stampWatermark(doc, opt, imageBytes);
    const bytes = await doc.save();
    addResult(`${safeName(baseName(item.name))}-浮水印.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  const how =
    opt.kind === 'image'
      ? `圖片（${watermarkImage.name}）`
      : TextPainter.isVector(opt.text)
        ? '文字（向量字型）'
        : '文字（中文，點陣圖）';
  return `${files.length} 份檔案、共 ${pageTotal} 頁加上浮水印，使用${how}。`;
}

/* ---------------- 加頁碼 ---------------- */

const PAGENUM_FORMATS = {
  'n': (n) => `${n}`,
  'n/total': (n, t) => `${n} / ${t}`,
  '-n-': (n) => `- ${n} -`,
  '第n頁': (n) => `第 ${n} 頁`,
  '第n頁共total頁': (n, t) => `第 ${n} 頁，共 ${t} 頁`,
};

async function runPageNum(files) {
  const fmt = PAGENUM_FORMATS[$('#pn-format').value] || PAGENUM_FORMATS['n'];
  const pos = $('#pn-pos').value;
  const start = parseInt($('#pn-start').value, 10) || 0;
  const size = Math.max(5, parseInt($('#pn-size').value, 10) || 11);
  const margin = Math.max(4, parseInt($('#pn-margin').value, 10) || 28);
  const cssColor = '#333333';
  const color = rgb(0.2, 0.2, 0.2);

  let pageTotal = 0;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在處理「${item.name}」…`);

    const doc = await openWithPdfLib(item.buf);
    const painter = new TextPainter(doc);
    const pages = doc.getPages();

    for (let p = 0; p < pages.length; p++) {
      const page = pages[p];
      const { width, height } = page.getSize();
      const label = fmt(start + p, pages.length + start - 1);

      const cx = pos.endsWith('l') ? margin + 30 : pos.endsWith('r') ? width - margin - 30 : width / 2;
      const cy = pos.startsWith('t') ? height - margin : margin;

      await painter.drawCentered(page, label, { cx, cy, size, cssColor, color, opacity: 1, angle: 0 });
      pageTotal++;
    }

    const bytes = await doc.save();
    addResult(`${safeName(baseName(item.name))}-頁碼.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  return `${files.length} 份檔案、共 ${pageTotal} 頁加上頁碼。`;
}

/* ============================================================
   加密 / 解密（qpdf-wasm）
   ------------------------------------------------------------
   pdf-lib 只能讀加密的 PDF，不能寫。qpdf 編譯成 WASM 後可以完整
   處理加密，而且是內容保留的轉換 —— 文字圖層不會被破壞，這點是
   「轉圖再組回來」那種替代做法辦不到的。

   qpdf.wasm 有 1.3 MB，所以只在真的用到這兩個工具時才載入。
   ============================================================ */

let qpdfFactory = null;

async function loadQpdf() {
  if (qpdfFactory) return qpdfFactory;

  setProgress(0, 1, '正在載入加密模組（約 1.4 MB，只需下載一次）…');
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/qpdf.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('載入加密模組失敗，請確認網路連線後重試。'));
    document.head.appendChild(script);
  });

  // Emscripten 這個 build 會把工廠函式掛成全域 Module
  if (typeof window.Module !== 'function') throw new Error('加密模組載入異常，請重新整理頁面再試。');
  qpdfFactory = window.Module;
  return qpdfFactory;
}

/**
 * 跑一次 qpdf CLI。
 * 每次都開一個新的 Emscripten 實例：callMain 在多數 build 只能安全呼叫一次，
 * 而 wasm 編譯結果已被瀏覽器快取，重建的成本不高。
 */
async function runQpdf(inputBytes, args, outName = 'out.pdf') {
  const factory = await loadQpdf();
  const stderr = [];

  const mod = await factory({
    locateFile: () => 'vendor/qpdf.wasm',
    noInitialRun: true,
    print: () => {},
    printErr: (line) => stderr.push(line),
  });

  mod.FS.writeFile('/in.pdf', new Uint8Array(inputBytes));

  let status = 0;
  try {
    status = mod.callMain(args) || 0;
  } catch (err) {
    // Emscripten 以丟出 ExitStatus 的方式回報 exit()
    if (err && typeof err.status === 'number') status = err.status;
    else throw err;
  }

  // qpdf 用 exit code 3 表示「有警告但已成功產出」
  if (status !== 0 && status !== 3) {
    // 這個 wasm build 不會把訊息送到 Emscripten 的 printErr，所以多半拿不到細節
    const detail = stderr.join('\n').trim();
    throw new Error(detail || `這份 PDF 無法處理（qpdf 代碼 ${status}）。檔案可能已損毀，或使用了不支援的加密方式。`);
  }

  let out;
  try {
    out = mod.FS.readFile('/' + outName);
  } catch {
    throw new Error(stderr.join('\n').trim() || 'qpdf 沒有產生輸出檔。');
  }
  // 複製一份再回傳，避免引用到即將被釋放的 wasm 記憶體
  return new Uint8Array(out).slice();
}

async function runEncrypt(files) {
  const userPw = $('#enc-user').value;
  const ownerPw = $('#enc-owner').value || userPw;
  const bits = $('#enc-bits').value;
  const allowPrint = getSegmented('#enc-print') === 'yes';
  const allowCopy = getSegmented('#enc-copy') === 'yes';

  if (!userPw) throw new Error('請輸入開檔密碼。這是別人開啟這份 PDF 時要輸入的密碼。');

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在加密「${item.name}」…`);

    const args = ['/in.pdf', '--encrypt', userPw, ownerPw, bits];
    if (!allowPrint) args.push('--print=none');
    if (!allowCopy) args.push('--extract=n');
    args.push('--', '/out.pdf');

    const bytes = await runQpdf(item.buf, args);
    addResult(`${safeName(baseName(item.name))}-已加密.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  const limits = [];
  if (!allowPrint) limits.push('禁止列印');
  if (!allowCopy) limits.push('禁止複製文字');
  return `${files.length} 份檔案已用 ${bits} 位元加密${limits.length ? `，${limits.join('、')}` : ''}。`;
}

/** 這份 PDF 有沒有設開檔密碼？ */
async function isEncrypted(buf) {
  try {
    const probe = await openWithPdfJs(buf, '');
    probe.destroy();
    return false;
  } catch {
    return true;
  }
}

async function runDecrypt(files) {
  const password = $('#dec-password').value;
  if (!password) throw new Error('請輸入這份 PDF 目前的開檔密碼。');

  let done = 0;
  let alreadyOpen = 0;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在解密「${item.name}」…`);

    if (!(await isEncrypted(item.buf))) {
      alreadyOpen++;
      continue;
    }

    // 先用 pdf.js 驗密碼：qpdf 這個 wasm build 不輸出錯誤訊息，只給 exit code，
    // 分不出「密碼錯」和「檔案壞掉」。pdf.js 的例外精確得多。
    try {
      const probe = await openWithPdfJs(item.buf, password);
      probe.destroy();
    } catch (err) {
      throw new Error(`「${item.name}」：${err.message}`);
    }

    const bytes = await runQpdf(item.buf, [`--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf']);
    addResult(`${safeName(baseName(item.name))}-已解密.pdf`, new Blob([bytes], { type: 'application/pdf' }));
    done++;
  }

  if (!done && alreadyOpen) {
    throw new Error(
      alreadyOpen === 1
        ? '這份 PDF 本來就沒有設開檔密碼，不需要解密。'
        : `這 ${alreadyOpen} 份 PDF 都沒有設開檔密碼，不需要解密。`
    );
  }
  return `${done} 份檔案已移除密碼，文字圖層完整保留${alreadyOpen ? `（另有 ${alreadyOpen} 份本來就沒加密，已略過）` : ''}。`;
}

/* ---------------- 交錯合併 ---------------- */

async function runAlternate(files) {
  if (files.length < 2) throw new Error('交錯合併至少需要 2 份 PDF。');
  const reverse = getSegmented('#alt-reverse') === 'yes';

  const sources = [];
  for (let i = 0; i < files.length; i++) {
    setProgress(i, files.length, `正在讀取「${files[i].name}」…`);
    const doc = await openWithPdfLib(files[i].buf);
    const order = doc.getPageIndices();
    // 反序只套用在第二份之後：雙面掃描時背面通常是倒著掃的
    sources.push({ doc, order: reverse && i > 0 ? order.slice().reverse() : order });
  }

  const out = await PDFDocument.create();
  const longest = Math.max(...sources.map((s) => s.order.length));
  let added = 0;

  for (let round = 0; round < longest; round++) {
    for (const src of sources) {
      if (round >= src.order.length) continue;
      const [page] = await out.copyPages(src.doc, [src.order[round]]);
      out.addPage(page);
      added++;
    }
  }

  const bytes = await out.save();
  addResult(safeName($('#alt-name').value || '交錯合併') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));

  const counts = sources.map((s) => s.order.length).join(' + ');
  return `交錯合併 ${files.length} 份（${counts} 頁）成 ${added} 頁。`;
}

/* ---------------- N-up 併頁 ---------------- */

/** [欄, 列]。欄數 ≥ 列數，配合預設的 A4 橫向：直式頁面左右並排最省空間。 */
const NUP_LAYOUT = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3] };

async function runNup(files) {
  const per = parseInt($('#nup-per').value, 10);
  const [cols, rows] = NUP_LAYOUT[per];
  const [pw, ph] = $('#nup-size').value === 'a4p' ? [A4.w, A4.h] : [A4.h, A4.w];
  const gap = Math.max(0, parseInt($('#nup-gap').value, 10) || 0);
  const margin = Math.max(0, parseInt($('#nup-margin').value, 10) || 0);
  const border = getSegmented('#nup-border') === 'yes';

  const cellW = (pw - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (ph - margin * 2 - gap * (rows - 1)) / rows;
  if (cellW <= 0 || cellH <= 0) throw new Error('邊界或間距太大，格子容不下內容。請調小一點。');

  let sheets = 0;

  for (let f = 0; f < files.length; f++) {
    const item = files[f];
    setProgress(f, files.length, `正在處理「${item.name}」…`);

    const src = await openWithPdfLib(item.buf);
    const out = await PDFDocument.create();
    const embedded = await out.embedPages(src.getPages());

    for (let i = 0; i < embedded.length; i += per) {
      const sheet = out.addPage([pw, ph]);
      sheets++;

      for (let k = 0; k < per && i + k < embedded.length; k++) {
        const ep = embedded[i + k];
        const col = k % cols;
        const row = Math.floor(k / cols);
        const cellX = margin + col * (cellW + gap);
        // PDF 的原點在左下角，但閱讀順序由上往下，所以 row 要反過來算
        const cellY = ph - margin - (row + 1) * cellH - row * gap;

        const scale = Math.min(cellW / ep.width, cellH / ep.height);
        const w = ep.width * scale;
        const h = ep.height * scale;

        sheet.drawPage(ep, {
          x: cellX + (cellW - w) / 2,
          y: cellY + (cellH - h) / 2,
          xScale: scale,
          yScale: scale,
        });

        if (border) {
          sheet.drawRectangle({
            x: cellX, y: cellY, width: cellW, height: cellH,
            borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.5,
          });
        }
      }
    }

    const bytes = await out.save();
    addResult(`${safeName(baseName(item.name))}-${per}合1.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  return `每張紙 ${per} 頁（${cols}×${rows}），共輸出 ${sheets} 張。`;
}

/* ---------------- 移除空白頁 ---------------- */

/** 把一頁畫成小圖，算「接近白色」的像素比例。 */
async function whiteRatio(page) {
  const full = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(1, 200 / Math.max(full.width, full.height)) });
  const { canvas, ctx } = makeCanvas(vp);
  await renderPage(page, vp, ctx);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  freeCanvas(canvas);

  let white = 0;
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++;
  }
  return white / total;
}

async function runDeblank(files, password) {
  const threshold = parseFloat($('#db-level').value);
  let removedTotal = 0;
  let keptTotal = 0;

  for (let f = 0; f < files.length; f++) {
    const item = files[f];
    const jsDoc = await openWithPdfJs(item.buf, password);
    const keep = [];
    const dropped = [];

    for (let n = 1; n <= jsDoc.numPages; n++) {
      setProgress(f + n / jsDoc.numPages, files.length, `「${item.name}」檢查第 ${n} / ${jsDoc.numPages} 頁…`);
      const ratio = await whiteRatio(await jsDoc.getPage(n));
      if (ratio >= threshold) dropped.push(n); else keep.push(n - 1);
    }
    jsDoc.destroy();

    if (!keep.length) throw new Error(`「${item.name}」整份都被判定為空白頁，沒有東西可以保留。請把判定標準調寬鬆一點。`);

    if (!dropped.length) {
      keptTotal += keep.length;
      continue; // 沒有空白頁就不產出檔案
    }

    const src = await openWithPdfLib(item.buf);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, keep);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    addResult(`${safeName(baseName(item.name))}-去空白.pdf`, new Blob([bytes], { type: 'application/pdf' }));

    removedTotal += dropped.length;
    keptTotal += keep.length;
  }

  if (!removedTotal) return `檢查完畢，${keptTotal} 頁裡沒有找到空白頁，所以沒有產生新檔案。`;
  return `移除 ${removedTotal} 頁空白頁，保留 ${keptTotal} 頁。`;
}

/* ---------------- 灰階 / 黑白 ---------------- */

async function runGrayscale(files, password) {
  const mode = $('#gs-mode').value;
  const dpi = parseInt($('#gs-dpi').value, 10);
  const threshold = parseInt($('#gs-thresh').value, 10);

  let before = 0;
  let after = 0;
  let pageTotal = 0;

  for (let f = 0; f < files.length; f++) {
    const item = files[f];
    const jsDoc = await openWithPdfJs(item.buf, password);
    const out = await PDFDocument.create();

    for (let n = 1; n <= jsDoc.numPages; n++) {
      setProgress(f + n / jsDoc.numPages, files.length, `「${item.name}」第 ${n} / ${jsDoc.numPages} 頁…`);
      const page = await jsDoc.getPage(n);
      const ptVp = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: dpi / 72 });

      const { canvas, ctx } = makeCanvas(vp);
      await renderPage(page, vp, ctx);

      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        // Rec. 601 亮度權重，比單純平均更接近人眼感受
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = mode === 'bw' ? (lum >= threshold ? 255 : 0) : lum;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);

      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
      freeCanvas(canvas);

      const embedded = await out.embedJpg(await blob.arrayBuffer());
      const newPage = out.addPage([ptVp.width, ptVp.height]);
      newPage.drawImage(embedded, { x: 0, y: 0, width: ptVp.width, height: ptVp.height });
      pageTotal++;
    }
    jsDoc.destroy();

    const bytes = await out.save();
    before += item.size;
    after += bytes.length;
    addResult(`${safeName(baseName(item.name))}-${mode === 'bw' ? '黑白' : '灰階'}.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  return `${pageTotal} 頁轉為${mode === 'bw' ? '純黑白' : '灰階'}，${fmtSize(before)} → ${fmtSize(after)}。`;
}

/* ---------------- 中繼資料 ---------------- */

async function runMetadata(files) {
  const wipe = getSegmented('#md-wipe') === 'yes';
  const title = $('#md-title').value;
  const author = $('#md-author').value;
  const subject = $('#md-subject').value;
  const keywords = $('#md-keywords').value;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在處理「${item.name}」…`);
    const doc = await openWithPdfLib(item.buf);

    if (wipe) {
      doc.setTitle('');
      doc.setAuthor('');
      doc.setSubject('');
      doc.setKeywords([]);
      doc.setProducer('');
      doc.setCreator('');
    } else {
      // 空字串代表「不更動」，避免不小心把原本的值清掉
      if (title) doc.setTitle(title);
      if (author) doc.setAuthor(author);
      if (subject) doc.setSubject(subject);
      if (keywords) doc.setKeywords(keywords.split(',').map((k) => k.trim()).filter(Boolean));
    }

    const bytes = await doc.save();
    addResult(`${safeName(baseName(item.name))}-中繼資料.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  return wipe ? `${files.length} 份檔案的中繼資料已清空。` : `${files.length} 份檔案的中繼資料已更新。`;
}

/* ---------------- 展平表單 ---------------- */

async function runFlatten(files) {
  let flattened = 0;
  let noForm = 0;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在處理「${item.name}」…`);
    const doc = await openWithPdfLib(item.buf);

    const form = doc.getForm();
    const fieldCount = form.getFields().length;
    if (fieldCount === 0) {
      noForm++;
    } else {
      try {
        form.flatten();
        flattened += fieldCount;
      } catch (err) {
        // 壓平會重新產生欄位外觀，若欄位值含中文就會撞到標準字型的 WinAnsi 限制
        const cjk = /WinAnsi cannot encode/i.test(err.message || '');
        throw new Error(
          `「${item.name}」的表單無法壓平：${err.message}\n` +
            (cjk
              ? '欄位裡有中文，而 PDF 標準字型畫不出中文字符。\n' +
                '變通做法：用「PDF → 圖片」轉成圖片再用「圖片 → PDF」組回來，一樣能達到定稿不可編輯的效果。'
              : '這份表單可能用了本工具不支援的欄位型別。')
        );
      }
    }

    const bytes = await doc.save();
    addResult(`${safeName(baseName(item.name))}-已壓平.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  if (!flattened) return `這 ${files.length} 份檔案裡沒有可填寫的表單欄位，內容原樣輸出。`;
  return `壓平 ${flattened} 個表單欄位${noForm ? `（另有 ${noForm} 份沒有表單）` : ''}。`;
}

/* ---------------- 壓縮 ---------------- */

async function runCompress(files, password) {
  const [dpiStr, qStr] = $('#cmp-level').value.split(':');
  const dpi = parseInt(dpiStr, 10);
  const quality = parseFloat(qStr);

  let before = 0;
  let after = 0;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    const doc = await openWithPdfJs(item.buf, password);
    const out = await PDFDocument.create();

    for (let n = 1; n <= doc.numPages; n++) {
      setProgress(i + n / doc.numPages, files.length, `「${item.name}」第 ${n} / ${doc.numPages} 頁…`);
      const page = await doc.getPage(n);
      const ptVp = page.getViewport({ scale: 1 });          // 原始頁面尺寸（pt）
      const rasterVp = page.getViewport({ scale: dpi / 72 });

      const { canvas, ctx } = makeCanvas(rasterVp);
      await renderPage(page, rasterVp, ctx);
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      freeCanvas(canvas);

      const img = await out.embedJpg(await blob.arrayBuffer());
      const newPage = out.addPage([ptVp.width, ptVp.height]);
      newPage.drawImage(img, { x: 0, y: 0, width: ptVp.width, height: ptVp.height });
    }
    doc.destroy();

    const bytes = await out.save();
    before += item.size;
    after += bytes.length;
    addResult(`${safeName(baseName(item.name))}-壓縮.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  return pct > 0
    ? `${fmtSize(before)} → ${fmtSize(after)}，減少 ${pct}%。`
    : `處理完成，但檔案沒有變小（${fmtSize(before)} → ${fmtSize(after)}）。這份 PDF 本來就很精簡，建議沿用原檔。`;
}

/* ============================================================
   工具註冊表
   ============================================================ */

const TOOLS = [
  // 順序就是首頁的顯示順序：最常用的放最前面
  {
    id: 'organize', name: '頁面管理', icon: '▦', cat: '組織',
    desc: '縮圖預覽，刪頁、拖曳排序、單頁旋轉',
    accept: 'pdf', multiple: false, password: true, run: runOrganize,
  },
  {
    id: 'merge', name: '合併 PDF', icon: '⊞', cat: '組織',
    desc: '把多份 PDF 接成一份，順序可拖曳調整',
    accept: 'pdf', multiple: true, min: 2, run: runMerge,
  },
  {
    id: 'split', name: '分割 / 擷取', icon: '⿻', cat: '組織',
    desc: '取出指定頁面，或拆成多份',
    accept: 'pdf', multiple: false, run: runSplit,
  },
  {
    id: 'pagenum', name: '加頁碼', icon: '#', cat: '組織',
    desc: '在每頁加上頁碼，位置格式可選',
    accept: 'pdf', multiple: true, run: runPageNum,
  },
  {
    id: 'nup', name: '多頁併一頁', icon: '▤', cat: '組織',
    desc: '2 / 4 / 6 / 9 頁排在同一張紙上，省紙',
    accept: 'pdf', multiple: true, run: runNup,
  },
  {
    id: 'alternate', name: '交錯合併', icon: '⇅', cat: '組織',
    desc: '兩份交替取頁，雙面掃描的正反面可合回一份',
    accept: 'pdf', multiple: true, min: 2, run: runAlternate,
  },
  {
    id: 'pdf2img', name: 'PDF → 圖片', icon: '🖼', cat: '轉換',
    desc: '每頁輸出 PNG 或 JPG，最高 400 DPI',
    accept: 'pdf', multiple: true, password: true, run: runPdf2Img,
  },
  {
    id: 'img2pdf', name: '圖片 → PDF', icon: '📄', cat: '轉換',
    desc: 'PNG / JPG 合成一份 PDF',
    accept: 'image', multiple: true, run: runImg2Pdf,
  },
  {
    id: 'pdf2txt', name: 'PDF → 文字', icon: 'T', cat: '轉換',
    desc: '抽出文字內容成 .txt',
    accept: 'pdf', multiple: true, password: true, run: runPdf2Txt,
    note: '只能抽出「真的有文字圖層」的 PDF。掃描檔需要 OCR，本工具箱沒有內建。',
  },
  {
    id: 'watermark', name: '加浮水印', icon: '💧', cat: '編輯',
    desc: '疊上文字浮水印，支援中文',
    accept: 'pdf', multiple: true, run: runWatermark,
  },
  {
    id: 'encrypt', name: '加密 PDF', icon: '🔒', cat: '安全',
    desc: '設定開檔密碼，可限制列印與複製',
    accept: 'pdf', multiple: true, run: runEncrypt,
    note: '首次使用會下載約 1.4 MB 的加密模組（qpdf），之後就不用再下載。',
  },
  {
    id: 'decrypt', name: '解密 PDF', icon: '🔓', cat: '安全',
    desc: '移除開檔密碼，文字圖層完整保留',
    accept: 'pdf', multiple: true, run: runDecrypt,
    note: '只能解開你知道密碼的 PDF。這不是破解工具。',
  },
  {
    id: 'metadata', name: '中繼資料', icon: 'ⓘ', cat: '編輯',
    desc: '編輯標題、作者，或一鍵清除全部痕跡',
    accept: 'pdf', multiple: true, run: runMetadata,
  },
  {
    id: 'flatten', name: '展平表單', icon: '⊟', cat: '編輯',
    desc: '把表單欄位壓平成頁面內容，定稿用',
    accept: 'pdf', multiple: true, run: runFlatten,
  },
  {
    id: 'compress', name: '壓縮 PDF', icon: '⇩', cat: '優化',
    desc: '重新光柵化，掃描檔可縮到 1/10 以下',
    accept: 'pdf', multiple: true, password: true, run: runCompress,
    note: '這是破壞性壓縮：處理後文字會變成圖片，無法再選取或搜尋。原檔請留著。',
  },
  {
    id: 'deblank', name: '移除空白頁', icon: '␀', cat: '優化',
    desc: '自動找出並刪掉空白頁，掃描檔常用',
    accept: 'pdf', multiple: true, password: true, run: runDeblank,
  },
  {
    id: 'grayscale', name: '灰階 / 黑白', icon: '◐', cat: '優化',
    desc: '轉成灰階或純黑白，列印省墨、檔案更小',
    accept: 'pdf', multiple: true, password: true, run: runGrayscale,
    note: '和壓縮一樣是重新光柵化：處理後文字會變成圖片，無法再選取或搜尋。',
  },
];

const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const CATEGORIES = ['組織', '轉換', '編輯', '安全', '優化'];
