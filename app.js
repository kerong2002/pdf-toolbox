/* PDF 工具箱 — 全部在瀏覽器內執行，檔案不會離開這台電腦。
   pdf-lib  : 組裝 / 修改 PDF 結構（合併、分割、旋轉、浮水印、圖片轉 PDF）
   pdf.js   : 光柵化（PDF 轉圖片、壓縮、縮圖）
   JSZip    : 多檔打包下載
*/
'use strict';

const { PDFDocument, StandardFonts, degrees, rgb } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const A4 = { w: 595.28, h: 841.89 };

/* ================= 小工具 ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

/** 去掉檔名裡不能用的字元，保留中文。 */
function safeName(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || '輸出';
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error(`讀不到檔案「${file.name}」`));
    fr.readAsArrayBuffer(file);
  });
}

/** pdf.js 會把 ArrayBuffer 轉交給 worker 並使其失效，所以每次都要給一份複本。 */
const copyBuf = (buf) => buf.slice(0);

/**
 * 把一頁畫到 canvas 上。
 *
 * 一定要用 intent:'print'。pdf.js 在 display intent 下會用 requestAnimationFrame
 * 排程每個算繪區塊，而瀏覽器對背景分頁的 rAF 節流到近乎停止 —— 使用者只要在轉檔
 * 途中切到別的分頁，整個流程就會卡住不動。print intent 走 microtask，不受影響。
 */
function renderPage(page, viewport, ctx) {
  return page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
}

/** 建一張鋪好白底的 canvas（JPG 沒有透明通道，不鋪白底透明處會變黑）。 */
function makeCanvas(viewport) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('無法把畫面輸出成圖片（頁面可能太大）'))),
      type,
      quality
    );
  });
}

/** 解析 "1-3,5,8-" 成 0-based 頁碼陣列。留空代表全部。 */
function parseRanges(spec, total) {
  const out = [];
  if (!spec || !spec.trim()) {
    for (let i = 0; i < total; i++) out.push(i);
    return out;
  }
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*-\s*(\d+)?$/);
    if (m) {
      const from = m[1] ? parseInt(m[1], 10) : 1;
      const to = m[2] ? parseInt(m[2], 10) : total;
      if (from < 1 || to > total || from > to) {
        throw new Error(`頁碼範圍「${part}」不合法，這份檔案只有 ${total} 頁。`);
      }
      for (let i = from; i <= to; i++) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > total) throw new Error(`頁碼「${part}」超出範圍，這份檔案只有 ${total} 頁。`);
      out.push(n - 1);
    } else {
      throw new Error(`看不懂的頁碼寫法：「${part}」。正確格式像 1-3,5,8-`);
    }
  }
  if (!out.length) throw new Error('沒有選到任何頁面。');
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(1, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/* ================= PDF 載入 ================= */

async function openWithPdfJs(buf, password) {
  try {
    return await pdfjsLib.getDocument({ data: copyBuf(buf), password: password || undefined }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new Error(
        err.code === 2
          ? '密碼不對，請重新確認。'
          : '這份 PDF 有設開檔密碼，請在「PDF 密碼」欄位填入後再試。'
      );
    }
    throw err;
  }
}

async function openWithPdfLib(buf) {
  try {
    return await PDFDocument.load(copyBuf(buf), { ignoreEncryption: true });
  } catch (err) {
    throw new Error(
      '這份 PDF 沒辦法直接編輯' +
        (/encrypt/i.test(err.message || '') ? '（有加密保護）' : '') +
        '。\n可以先用「PDF → 圖片」把它轉成圖片，再用「圖片 → PDF」組回來。'
    );
  }
}

/* ================= 狀態 ================= */

/** 每個工具各自的待處理檔案：{ file, buf, name, size } */
const picked = {
  merge: [], split: [], organize: [], pdf2img: [], img2pdf: [], watermark: [], compress: [],
};

/** 頁面管理工具的編輯狀態 */
let organizeState = null; // { buf, pages: [{ orig, rot, deleted }] }

/** 產出結果：{ name, blob, url } */
let results = [];

/* ================= UI：分頁切換 ================= */

$$('.navbtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.navbtn').forEach((b) => b.classList.toggle('active', b === btn));
    const tool = btn.dataset.tool;
    $$('.tool').forEach((sec) => sec.classList.toggle('active', sec.id === 'tool-' + tool));
    hideError();
  });
});

/* ================= UI：檔案挑選 / 拖放 ================= */

function renderFileList(tool) {
  const ul = $(`[data-list="${tool}"]`);
  ul.innerHTML = '';
  const items = picked[tool];
  const reorderable = tool === 'merge' || tool === 'img2pdf';

  items.forEach((item, idx) => {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = `${idx + 1}. ${item.name}`;
    li.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent = fmtSize(item.size);
    li.appendChild(meta);

    if (reorderable) {
      const up = document.createElement('button');
      up.className = 'mini';
      up.textContent = '↑';
      up.title = '往前移';
      up.disabled = idx === 0;
      up.addEventListener('click', () => {
        [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
        renderFileList(tool);
      });
      li.appendChild(up);

      const down = document.createElement('button');
      down.className = 'mini';
      down.textContent = '↓';
      down.title = '往後移';
      down.disabled = idx === items.length - 1;
      down.addEventListener('click', () => {
        [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
        renderFileList(tool);
      });
      li.appendChild(down);
    }

    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '✕';
    del.title = '移除';
    del.addEventListener('click', () => {
      items.splice(idx, 1);
      renderFileList(tool);
      if (tool === 'organize') resetOrganize();
    });
    li.appendChild(del);

    ul.appendChild(li);
  });
}

async function addFiles(tool, fileList) {
  const single = tool === 'split' || tool === 'organize';
  const files = Array.from(fileList);
  if (!files.length) return;

  hideError();
  if (single) picked[tool] = [];

  for (const file of files) {
    try {
      const buf = await readAsArrayBuffer(file);
      picked[tool].push({ file, buf, name: file.name, size: file.size });
    } catch (err) {
      showError(err.message);
      return;
    }
    if (single) break;
  }

  renderFileList(tool);
  if (tool === 'organize') await loadOrganize();
}

$$('.drop').forEach((zone) => {
  const tool = zone.dataset.drop;
  const input = $('input[type="file"]', zone);

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addFiles(tool, input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('over');
    })
  );
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(tool, e.dataTransfer.files);
  });
});

/* ================= UI：進度 / 錯誤 / 結果 ================= */

function setProgress(done, total, msg) {
  const box = $('#status');
  box.hidden = false;
  $('#bar-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  $('#status-msg').textContent = msg || '';
}

function clearProgress() {
  $('#status').hidden = true;
  $('#bar-fill').style.width = '0%';
}

function showError(msg) {
  const box = $('#error');
  box.hidden = false;
  box.textContent = '❌ ' + msg;
}

function hideError() {
  $('#error').hidden = true;
}

function addResult(name, blob) {
  results.push({ name, blob, url: URL.createObjectURL(blob) });
}

function renderResults() {
  const box = $('#results');
  const ul = $('#results-list');
  ul.innerHTML = '';
  box.hidden = results.length === 0;
  $('#dl-all').hidden = results.length < 2;

  results.forEach((res) => {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = res.name;
    li.appendChild(name);

    const size = document.createElement('span');
    size.className = 'rsize';
    size.textContent = fmtSize(res.blob.size);
    li.appendChild(size);

    const a = document.createElement('a');
    a.className = 'dl';
    a.href = res.url;
    a.download = res.name;
    a.textContent = '下載';
    li.appendChild(a);

    ul.appendChild(li);
  });
}

function clearResults() {
  results.forEach((r) => URL.revokeObjectURL(r.url));
  results = [];
  renderResults();
}

$('#clear-results').addEventListener('click', clearResults);

$('#dl-all').addEventListener('click', async () => {
  if (results.length < 2) return;
  const zip = new JSZip();
  const used = new Map();
  for (const res of results) {
    // 同名檔案自動加序號，避免在 zip 內互相覆蓋
    let entry = res.name;
    if (used.has(entry)) {
      const n = used.get(entry) + 1;
      used.set(entry, n);
      entry = `${baseName(res.name)} (${n})${res.name.slice(baseName(res.name).length)}`;
    } else {
      used.set(entry, 0);
    }
    zip.file(entry, res.blob);
  }
  setProgress(0, 1, '正在打包 ZIP…');
  const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
    setProgress(meta.percent, 100, `正在打包 ZIP… ${Math.round(meta.percent)}%`);
  });
  clearProgress();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pdf-工具箱-輸出.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

/* ================= 各工具的實作 ================= */

async function runMerge() {
  const items = picked.merge;
  if (items.length < 2) throw new Error('請至少選 2 個 PDF 才需要合併。');

  const out = await PDFDocument.create();
  let pageCount = 0;

  for (let i = 0; i < items.length; i++) {
    setProgress(i, items.length, `正在合併「${items[i].name}」…`);
    const src = await openWithPdfLib(items[i].buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    pageCount += pages.length;
  }

  const bytes = await out.save();
  addResult(safeName($('#merge-name').value || '合併結果') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));
  return `合併完成：${items.length} 份檔案、共 ${pageCount} 頁。`;
}

async function runSplit() {
  const item = picked.split[0];
  if (!item) throw new Error('請先選一份 PDF。');

  const mode = $('input[name="split-mode"]:checked').value;
  const src = await openWithPdfLib(item.buf);
  const total = src.getPageCount();
  const base = safeName(baseName(item.name));

  /** 把一組頁碼做成一份新 PDF */
  const build = async (indices, name) => {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    addResult(name, new Blob([bytes], { type: 'application/pdf' }));
  };

  if (mode === 'ranges') {
    const indices = parseRanges($('#split-ranges').value, total);
    setProgress(0, 1, `正在取出 ${indices.length} 頁…`);
    await build(indices, `${base}-擷取.pdf`);
    return `已取出 ${indices.length} 頁（原檔共 ${total} 頁）。`;
  }

  if (mode === 'each') {
    const indices = parseRanges($('#split-ranges').value, total);
    for (let i = 0; i < indices.length; i++) {
      setProgress(i, indices.length, `正在輸出第 ${indices[i] + 1} 頁…`);
      await build([indices[i]], `${base}-p${indices[i] + 1}.pdf`);
    }
    return `已拆成 ${indices.length} 份單頁 PDF。`;
  }

  // chunks
  const size = Math.max(1, parseInt($('#split-chunk').value, 10) || 1);
  const indices = parseRanges($('#split-ranges').value, total);
  const groups = [];
  for (let i = 0; i < indices.length; i += size) groups.push(indices.slice(i, i + size));

  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    setProgress(g, groups.length, `正在輸出第 ${g + 1} / ${groups.length} 份…`);
    const label = grp.length > 1 ? `p${grp[0] + 1}-${grp[grp.length - 1] + 1}` : `p${grp[0] + 1}`;
    await build(grp, `${base}-${label}.pdf`);
  }
  return `已依每 ${size} 頁一份，拆成 ${groups.length} 份。`;
}

async function runPdf2Img() {
  const items = picked.pdf2img;
  if (!items.length) throw new Error('請先選至少一份 PDF。');

  const type = $('#p2i-format').value;
  const dpi = parseInt($('#p2i-dpi').value, 10);
  const quality = type === 'image/jpeg' ? parseFloat($('#p2i-quality').value) : undefined;
  const ext = type === 'image/jpeg' ? '.jpg' : '.png';
  const password = $('#p2i-password').value;

  let totalPages = 0;
  let done = 0;

  const docs = [];
  for (const item of items) {
    const doc = await openWithPdfJs(item.buf, password);
    docs.push({ doc, name: item.name });
    totalPages += doc.numPages;
  }

  for (const { doc, name } of docs) {
    const base = safeName(baseName(name));
    for (let n = 1; n <= doc.numPages; n++) {
      setProgress(done, totalPages, `正在轉換「${name}」第 ${n} / ${doc.numPages} 頁…`);
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: dpi / 72 });
      const { canvas, ctx } = makeCanvas(vp);
      await renderPage(page, vp, ctx);

      const blob = await canvasToBlob(canvas, type, quality);
      const suffix = doc.numPages > 1 ? `-p${n}` : '';
      addResult(`${base}${suffix}${ext}`, blob);
      done++;
      // 釋放大張 canvas，避免連續多頁時記憶體爆掉
      canvas.width = canvas.height = 0;
    }
    doc.destroy();
  }

  return `轉換完成：${totalPages} 張圖片（${dpi} DPI）。`;
}

async function runImg2Pdf() {
  const items = picked.img2pdf;
  if (!items.length) throw new Error('請先選至少一張圖片。');

  const sizeMode = $('#i2p-size').value;
  const margin = Math.max(0, parseInt($('#i2p-margin').value, 10) || 0);
  const out = await PDFDocument.create();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    setProgress(i, items.length, `正在加入「${item.name}」…`);

    const isJpg = /jpe?g$/i.test(item.file.type) || /\.jpe?g$/i.test(item.name);
    let img;
    try {
      img = isJpg ? await out.embedJpg(copyBuf(item.buf)) : await out.embedPng(copyBuf(item.buf));
    } catch (err) {
      throw new Error(`「${item.name}」不是有效的 PNG / JPG 圖片，或格式不支援。`);
    }

    if (sizeMode === 'fit') {
      const page = out.addPage([img.width + margin * 2, img.height + margin * 2]);
      page.drawImage(img, { x: margin, y: margin, width: img.width, height: img.height });
    } else {
      const [pw, ph] = sizeMode === 'a4l' ? [A4.h, A4.w] : [A4.w, A4.h];
      const page = out.addPage([pw, ph]);
      const boxW = pw - margin * 2;
      const boxH = ph - margin * 2;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }

  const bytes = await out.save();
  addResult(safeName($('#i2p-name').value || '圖片轉PDF') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));
  return `完成：${items.length} 張圖片組成 ${items.length} 頁 PDF。`;
}

async function runWatermark() {
  const items = picked.watermark;
  if (!items.length) throw new Error('請先選至少一份 PDF。');

  const text = $('#wm-text').value.trim();
  if (!text) throw new Error('請輸入浮水印文字。');
  // 標準字型只涵蓋 WinAnsi，中文等字元會讓 pdf-lib 直接丟錯，先擋下來給清楚訊息
  if (!/^[\x20-\x7E\xA0-\xFF]*$/.test(text)) {
    throw new Error('浮水印文字含有中文或其他非西文字元，內建字型無法呈現。\n請改用英文、數字與符號，例如 FOR BANK USE ONLY。');
  }

  const size = Math.max(6, parseInt($('#wm-size').value, 10) || 42);
  const opacity = parseFloat($('#wm-opacity').value);
  const angle = parseFloat($('#wm-angle').value) || 0;
  const color = hexToRgb($('#wm-color').value);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  let pageTotal = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    setProgress(i, items.length, `正在處理「${item.name}」…`);

    const doc = await openWithPdfLib(item.buf);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const tw = font.widthOfTextAtSize(text, size);
    const th = font.heightAtSize(size);

    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      // 旋轉是以 (x,y) 為軸心，回推讓文字的視覺中心落在頁面正中央
      page.drawText(text, {
        x: width / 2 - (tw / 2) * cos + (th / 2) * sin,
        y: height / 2 - (tw / 2) * sin - (th / 2) * cos,
        size,
        font,
        color,
        opacity,
        rotate: degrees(angle),
      });
      pageTotal++;
    }

    const bytes = await doc.save();
    addResult(`${safeName(baseName(item.name))}-浮水印.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  return `完成：${items.length} 份檔案、共 ${pageTotal} 頁加上浮水印。`;
}

async function runCompress() {
  const items = picked.compress;
  if (!items.length) throw new Error('請先選至少一份 PDF。');

  const [dpiStr, qStr] = $('#cmp-level').value.split(':');
  const dpi = parseInt(dpiStr, 10);
  const quality = parseFloat(qStr);
  const password = $('#cmp-password').value;

  let before = 0;
  let after = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const doc = await openWithPdfJs(item.buf, password);
    const out = await PDFDocument.create();

    for (let n = 1; n <= doc.numPages; n++) {
      setProgress(i + n / doc.numPages, items.length, `正在壓縮「${item.name}」第 ${n} / ${doc.numPages} 頁…`);
      const page = await doc.getPage(n);
      const ptVp = page.getViewport({ scale: 1 });      // 原始頁面尺寸（pt）
      const rasterVp = page.getViewport({ scale: dpi / 72 });

      const { canvas, ctx } = makeCanvas(rasterVp);
      await renderPage(page, rasterVp, ctx);

      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      const img = await out.embedJpg(await blob.arrayBuffer());
      const newPage = out.addPage([ptVp.width, ptVp.height]);
      newPage.drawImage(img, { x: 0, y: 0, width: ptVp.width, height: ptVp.height });
      canvas.width = canvas.height = 0;
    }
    doc.destroy();

    const bytes = await out.save();
    before += item.size;
    after += bytes.length;
    addResult(`${safeName(baseName(item.name))}-壓縮.pdf`, new Blob([bytes], { type: 'application/pdf' }));
  }

  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  return pct > 0
    ? `壓縮完成：${fmtSize(before)} → ${fmtSize(after)}，小了 ${pct}%。`
    : `處理完成，但檔案沒有變小（${fmtSize(before)} → ${fmtSize(after)}）。這份 PDF 本來就很精簡，建議直接用原檔。`;
}

/* ================= 頁面管理 ================= */

function resetOrganize() {
  organizeState = null;
  $('#organize-thumbs').innerHTML = '';
  $('#organize-actions').hidden = true;
}

async function loadOrganize() {
  const item = picked.organize[0];
  if (!item) return resetOrganize();

  hideError();
  const thumbsBox = $('#organize-thumbs');
  thumbsBox.innerHTML = '';

  let doc;
  try {
    doc = await openWithPdfJs(item.buf, '');
  } catch (err) {
    showError(err.message);
    return resetOrganize();
  }

  organizeState = {
    pages: Array.from({ length: doc.numPages }, (_, i) => ({ orig: i, rot: 0, deleted: false })),
    thumbs: [],
  };

  for (let n = 1; n <= doc.numPages; n++) {
    setProgress(n - 1, doc.numPages, `正在產生縮圖 ${n} / ${doc.numPages}…`);
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const scale = 150 / Math.max(vp.width, vp.height); // 縮圖最長邊 150px
    const tvp = page.getViewport({ scale });
    const { canvas, ctx } = makeCanvas(tvp);
    await renderPage(page, tvp, ctx);
    organizeState.thumbs.push(canvas);
  }
  doc.destroy();
  clearProgress();

  $('#organize-actions').hidden = false;
  $('#organize-name').value = safeName(baseName(item.name)) + '-編輯';
  renderOrganize();
}

function renderOrganize() {
  const box = $('#organize-thumbs');
  box.innerHTML = '';
  if (!organizeState) return;

  organizeState.pages.forEach((pg, idx) => {
    const card = document.createElement('div');
    card.className = 'thumb' + (pg.deleted ? ' deleted' : '');

    const canvas = organizeState.thumbs[pg.orig];
    const view = document.createElement('canvas');
    // 依旋轉角度把縮圖重畫一次，讓畫面反映實際輸出方向
    const turned = pg.rot % 180 !== 0;
    view.width = turned ? canvas.height : canvas.width;
    view.height = turned ? canvas.width : canvas.height;
    const ctx = view.getContext('2d');
    ctx.translate(view.width / 2, view.height / 2);
    ctx.rotate((pg.rot * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    card.appendChild(view);

    const num = document.createElement('div');
    num.className = 'tnum';
    num.textContent = `第 ${pg.orig + 1} 頁${pg.rot ? ` · ${pg.rot}°` : ''}`;
    card.appendChild(num);

    const bar = document.createElement('div');
    bar.className = 'tbar';

    const mk = (label, title, fn, disabled) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };

    const pages = organizeState.pages;
    mk('←', '往前移', () => {
      [pages[idx - 1], pages[idx]] = [pages[idx], pages[idx - 1]];
      renderOrganize();
    }, idx === 0);
    mk('⟳', '右轉 90°', () => {
      pg.rot = (pg.rot + 90) % 360;
      renderOrganize();
    });
    mk(pg.deleted ? '↺' : '✕', pg.deleted ? '取消刪除' : '刪除這頁', () => {
      pg.deleted = !pg.deleted;
      renderOrganize();
    });
    mk('→', '往後移', () => {
      [pages[idx + 1], pages[idx]] = [pages[idx], pages[idx + 1]];
      renderOrganize();
    }, idx === pages.length - 1);

    card.appendChild(bar);
    box.appendChild(card);
  });
}

$('#org-reset').addEventListener('click', () => {
  if (!organizeState) return;
  organizeState.pages = organizeState.pages
    .map((p) => ({ orig: p.orig, rot: 0, deleted: false }))
    .sort((a, b) => a.orig - b.orig);
  renderOrganize();
});

$('#org-rotate-all').addEventListener('click', () => {
  if (!organizeState) return;
  organizeState.pages.forEach((p) => (p.rot = (p.rot + 90) % 360));
  renderOrganize();
});

async function runOrganize() {
  const item = picked.organize[0];
  if (!item || !organizeState) throw new Error('請先選一份 PDF。');

  const keep = organizeState.pages.filter((p) => !p.deleted);
  if (!keep.length) throw new Error('所有頁面都被刪掉了，至少要留一頁。');

  setProgress(0, 1, '正在匯出…');
  const src = await openWithPdfLib(item.buf);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, keep.map((p) => p.orig));

  copied.forEach((page, i) => {
    if (keep[i].rot) {
      // 疊加在原有的頁面旋轉之上
      page.setRotation(degrees((page.getRotation().angle + keep[i].rot) % 360));
    }
    out.addPage(page);
  });

  const bytes = await out.save();
  addResult(safeName($('#organize-name').value || '編輯結果') + '.pdf', new Blob([bytes], { type: 'application/pdf' }));

  const removed = organizeState.pages.length - keep.length;
  return `匯出完成：${keep.length} 頁${removed ? `（刪掉 ${removed} 頁）` : ''}。`;
}

/* ================= 執行入口 ================= */

const RUNNERS = {
  merge: runMerge,
  split: runSplit,
  organize: runOrganize,
  pdf2img: runPdf2Img,
  img2pdf: runImg2Pdf,
  watermark: runWatermark,
  compress: runCompress,
};

$$('.run').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tool = btn.dataset.run;
    hideError();
    clearResults();
    $$('.run').forEach((b) => (b.disabled = true));
    const label = btn.textContent;
    btn.textContent = '處理中…';

    try {
      const msg = await RUNNERS[tool]();
      setProgress(1, 1, '✅ ' + msg);
      renderResults();
    } catch (err) {
      console.error(err);
      clearProgress();
      showError(err && err.message ? err.message : String(err));
      renderResults();
    } finally {
      $$('.run').forEach((b) => (b.disabled = false));
      btn.textContent = label;
    }
  });
});

/* ================= 小型互動 ================= */

$('#p2i-format').addEventListener('change', (e) => {
  $('#p2i-qwrap').hidden = e.target.value !== 'image/jpeg';
});

$('#p2i-quality').addEventListener('input', (e) => {
  $('#p2i-qval').textContent = parseFloat(e.target.value).toFixed(2);
});

$('#wm-opacity').addEventListener('input', (e) => {
  $('#wm-oval').textContent = parseFloat(e.target.value).toFixed(2);
});
