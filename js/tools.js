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

async function runWatermark(files) {
  const text = $('#wm-text').value.trim();
  if (!text) throw new Error('請輸入浮水印文字。');

  const size = Math.max(6, parseInt($('#wm-size').value, 10) || 48);
  const opacity = parseFloat($('#wm-opacity').value);
  const angle = parseFloat($('#wm-angle').value) || 0;
  const cssColor = $('#wm-color').value;
  const color = hexToRgb(cssColor);
  const tile = getSegmented('#wm-tile') === 'yes';

  let pageTotal = 0;

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    setProgress(i, files.length, `正在處理「${item.name}」…`);

    const doc = await openWithPdfLib(item.buf);
    const painter = new TextPainter(doc);

    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      if (tile) {
        const { width: tw, height: th } = await painter.measure(text, size, cssColor);
        const stepX = Math.max(tw * 1.5, 80);
        const stepY = Math.max(th * 4, 80);
        for (let y = stepY / 2; y < height + stepY; y += stepY) {
          for (let x = stepX / 2; x < width + stepX; x += stepX) {
            await painter.drawCentered(page, text, { cx: x, cy: y, size, cssColor, color, opacity, angle });
          }
        }
      } else {
        await painter.drawCentered(page, text, {
          cx: width / 2, cy: height / 2, size, cssColor, color, opacity, angle,
        });
      }
      pageTotal++;
    }

    const bytes = await doc.save();
    addResult(`${safeName(baseName(item.name))}-浮水印.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  const mode = TextPainter.isVector(text) ? '向量字型' : '點陣圖（中文字型）';
  return `${files.length} 份檔案、共 ${pageTotal} 頁加上浮水印，使用${mode}。`;
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
    id: 'organize', name: '頁面管理', icon: '▦', cat: '組織',
    desc: '縮圖預覽，刪頁、拖曳排序、單頁旋轉',
    accept: 'pdf', multiple: false, password: true, run: runOrganize,
  },
  {
    id: 'pagenum', name: '加頁碼', icon: '#', cat: '組織',
    desc: '在每頁加上頁碼，位置格式可選',
    accept: 'pdf', multiple: true, run: runPageNum,
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
    id: 'compress', name: '壓縮 PDF', icon: '⇩', cat: '優化',
    desc: '重新光柵化，掃描檔可縮到 1/10 以下',
    accept: 'pdf', multiple: true, password: true, run: runCompress,
    note: '這是破壞性壓縮：處理後文字會變成圖片，無法再選取或搜尋。原檔請留著。',
  },
];

const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const CATEGORIES = ['組織', '轉換', '編輯', '優化'];
