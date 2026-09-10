/* ============================================================
   ui.js — 畫面、狀態、事件
   ============================================================ */
'use strict';

/* ---------------- 狀態 ---------------- */

let currentTool = null;
let files = [];            // { name, buf, size, type }
let organizeState = null;  // { pages: [{ orig, rot, deleted }], thumbs: [canvas] }
let results = [];          // { name, blob, url }

/* ---------------- 小工具 ---------------- */

/** 讀取 .segmented 目前選中的值 */
function getSegmented(sel) {
  const on = $(sel + ' button.on');
  return on ? on.dataset.val : null;
}

function toast(msg, kind = '') {
  const node = el('div', 'toast ' + kind, msg);
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 300);
  }, 3600);
}

/* ---------------- 佈景主題 ---------------- */

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

try {
  const saved = localStorage.getItem('pdf-toolbox-theme');
  if (saved === 'dark' || saved === 'light') applyTheme(saved);
} catch { /* 無痕視窗或封鎖儲存時忽略 */ }

$('#theme-toggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('pdf-toolbox-theme', next); } catch { /* 忽略 */ }
});

/* ---------------- 首頁 ---------------- */

function buildHome() {
  const root = $('#tool-grid');
  root.innerHTML = '';

  for (const cat of CATEGORIES) {
    const list = TOOLS.filter((t) => t.cat === cat);
    if (!list.length) continue;

    const section = el('section', 'cat');
    section.appendChild(el('h2', 'cat-title', cat));

    const grid = el('div', 'grid');
    for (const tool of list) {
      // 用 <a> 而不是 <button>：中鍵／Ctrl+點擊 就能另開分頁，
      // 一般點擊則交給 hashchange 路由處理。
      const card = el('a', 'card');
      card.href = '#/' + tool.id;
      const icon = el('div', 'card-icon t-' + tool.id, tool.icon);
      const body = el('div', 'card-body');
      body.appendChild(el('h3', null, tool.name));
      body.appendChild(el('p', null, tool.desc));
      card.append(icon, body);
      grid.appendChild(card);
    }
    section.appendChild(grid);
    root.appendChild(section);
  }
}

function showHome() {
  currentTool = null;
  $('#home').hidden = false;
  $('#workspace').hidden = true;
  document.title = 'PDF 工具箱';
  window.scrollTo({ top: 0 });
}

/* ============================================================
   路由
   ------------------------------------------------------------
   每個工具給一個 hash 網址（#/merge），這樣瀏覽器的上一頁／下一頁
   就能在工具之間來回，網址也能收藏和分享。用 hash 而不是 pathname
   是因為 GitHub Pages 是純靜態站，沒辦法把 /merge 這種路徑改寫回
   index.html。
   ============================================================ */

/** 串接時要帶到下一個工具的檔案，由路由處理器取用一次後清空。 */
let pendingCarry = null;

function navigate(id) {
  const target = id ? '#/' + id : '#/';
  if (location.hash === target) handleRoute();  // 同一個網址不會觸發 hashchange
  else location.hash = target;
}

async function handleRoute() {
  const id = (location.hash || '').replace(/^#\/?/, '');
  const tool = TOOL_BY_ID[id];

  if (!tool) { showHome(); return; }

  const carry = pendingCarry;
  pendingCarry = null;
  openTool(tool.id, !!carry);

  if (carry) {
    files = carry;
    renderFileList();
    if (currentTool.id === 'organize') await loadOrganize();
  }
}

window.addEventListener('hashchange', handleRoute);

$('#go-home').addEventListener('click', () => navigate(null));
$$('[data-home]').forEach((b) => b.addEventListener('click', () => navigate(null)));

/* ---------------- 開啟工具 ---------------- */

function openTool(id, keepFiles) {
  const tool = TOOL_BY_ID[id];
  if (!tool) return;
  currentTool = tool;

  $('#home').hidden = true;
  $('#workspace').hidden = false;

  document.title = tool.name + ' · PDF 工具箱';
  $('#crumb-name').textContent = tool.name;
  $('#ws-title').textContent = tool.name;
  $('#ws-desc').textContent = tool.desc;
  const icon = $('#ws-icon');
  icon.className = 'ws-icon t-' + tool.id;
  icon.textContent = tool.icon;

  const note = $('#ws-note');
  note.hidden = !tool.note;
  if (tool.note) note.textContent = '⚠️ ' + tool.note;

  // 只顯示這個工具的選項面板
  $$('.options').forEach((box) => (box.hidden = box.id !== 'opt-' + tool.id));
  $('#opt-password').hidden = !tool.password;

  $('#file-input').multiple = !!tool.multiple;
  $('#file-input').accept = tool.accept === 'image' ? 'image/png,image/jpeg' : 'application/pdf';
  $('#drop-sub').textContent =
    (tool.accept === 'image' ? '支援 PNG、JPG' : '支援 PDF') +
    (tool.multiple ? '，可一次選多個' : '，一次一個檔案');

  $('#run-btn').textContent = tool.id === 'organize' ? '匯出 PDF' : '開始處理';

  if (!keepFiles) {
    files = [];
    organizeState = null;
  }
  $('#organize-panel').hidden = tool.id !== 'organize';
  if (tool.id !== 'organize') $('#organize-thumbs').innerHTML = '';

  clearResults();
  hideError();
  clearProgress();
  renderFileList();
  window.scrollTo({ top: 0 });

  if (tool.id === 'organize' && files.length) loadOrganize();
  if (tool.id === 'watermark') { syncWatermarkKind(); scheduleWatermarkPreview(); }
}

/* ---------------- 檔案 ---------------- */

function acceptsFile(file) {
  if (currentTool.accept === 'image') return /^image\/(png|jpeg)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function addFiles(fileList) {
  const incoming = Array.from(fileList);
  if (!incoming.length) return;
  hideError();

  const rejected = incoming.filter((f) => !acceptsFile(f));
  const good = incoming.filter(acceptsFile);

  if (rejected.length) {
    toast(`略過 ${rejected.length} 個不支援的檔案：${rejected.map((f) => f.name).join('、')}`, 'err');
  }
  if (!good.length) return;

  if (!currentTool.multiple) files = [];

  for (const file of good) {
    try {
      const buf = await readAsArrayBuffer(file);
      files.push({ name: file.name, buf, size: file.size, type: file.type });
    } catch (err) {
      showError(err.message);
      return;
    }
    if (!currentTool.multiple) break;
  }

  renderFileList();
  clearResults();
  if (currentTool.id === 'organize') await loadOrganize();
  if (currentTool.id === 'metadata') await loadMetadata();
  if (currentTool.id === 'watermark') scheduleWatermarkPreview();
}

/** 把第一份檔案現有的中繼資料填進表單，讓使用者看得到原本的值。 */
async function loadMetadata() {
  const fields = { '#md-title': 'getTitle', '#md-author': 'getAuthor', '#md-subject': 'getSubject' };
  for (const sel of Object.keys(fields)) $(sel).value = '';
  $('#md-keywords').value = '';
  if (!files.length) return;

  try {
    const doc = await openWithPdfLib(files[0].buf);
    for (const [sel, getter] of Object.entries(fields)) $(sel).value = doc[getter]() || '';
    const kw = doc.getKeywords();
    $('#md-keywords').value = Array.isArray(kw) ? kw.join(', ') : kw || '';
  } catch {
    // 讀不到就讓欄位保持空白，使用者仍可直接填新值
  }
}

function renderFileList() {
  const ul = $('#filelist');
  ul.innerHTML = '';
  const reorderable = files.length > 1 && (currentTool.id === 'merge' || currentTool.id === 'img2pdf');

  files.forEach((item, idx) => {
    const li = el('li', 'filerow');
    li.draggable = reorderable;

    if (reorderable) {
      li.appendChild(el('span', 'handle', '⠿'));
      attachReorder(li, idx, files, renderFileList);
    }

    li.appendChild(el('span', 'idx', String(idx + 1)));
    li.appendChild(el('span', 'fname', item.name));
    li.appendChild(el('span', 'fmeta', fmtSize(item.size)));

    if (/\.pdf$/i.test(item.name)) {
      const eye = el('button', 'btn ghost', '預覽');
      eye.addEventListener('click', () => previewFile(item));
      li.appendChild(eye);
    }

    const del = el('button', 'btn ghost', '移除');
    del.addEventListener('click', () => {
      files.splice(idx, 1);
      renderFileList();
      if (currentTool.id === 'organize') { organizeState = null; $('#organize-thumbs').innerHTML = ''; }
    });
    li.appendChild(del);

    ul.appendChild(li);
  });
}

/** 讓一個元素能用 HTML5 拖放重新排序 arr。 */
function attachReorder(node, idx, arr, rerender) {
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drag-over');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove('drag-over');
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(from) || from === idx) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(idx, 0, moved);
    rerender();
  });
}

/* ---------------- 投放區 ---------------- */

const dropzone = $('#dropzone');
const fileInput = $('#file-input');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); })
);
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// 擋掉拖到視窗其他地方時瀏覽器直接開檔的預設行為
['dragover', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => { if (e.target !== dropzone) e.preventDefault(); })
);

/* ---------------- 進度 / 錯誤 ---------------- */

function setProgress(done, total, msg) {
  $('#progress').hidden = false;
  $('#bar-fill').style.width = total ? `${Math.min(100, Math.round((done / total) * 100))}%` : '0%';
  $('#progress-msg').textContent = msg || '';
}

function clearProgress() {
  $('#progress').hidden = true;
  $('#bar-fill').style.width = '0%';
  $('#progress-msg').textContent = '';
}

function showError(msg) {
  const box = $('#error');
  box.hidden = false;
  box.textContent = msg;
}

const hideError = () => { $('#error').hidden = true; };

/* ---------------- 結果 ---------------- */

function addResult(name, blob) {
  results.push({ name, blob, url: URL.createObjectURL(blob) });
}

function renderResults() {
  const ul = $('#results-list');
  ul.innerHTML = '';
  $('#results').hidden = results.length === 0;
  $('#dl-all').hidden = results.length < 2;

  for (const res of results) {
    const li = el('li', 'resrow');
    li.appendChild(el('span', 'rname', res.name));
    li.appendChild(el('span', 'rsize', fmtSize(res.blob.size)));

    const a = el('a', 'dl', '下載');
    a.href = res.url;
    a.download = res.name;
    li.appendChild(a);

    ul.appendChild(li);
  }
  renderChain();
}

function clearResults() {
  results.forEach((r) => URL.revokeObjectURL(r.url));
  results = [];
  $('#results').hidden = true;
  $('#results-list').innerHTML = '';
  $('#chain').hidden = true;
}

$('#clear-results').addEventListener('click', clearResults);

/**
 * 串接：把這次的產出直接餵給下一個工具，不用重新選檔。
 * 這是 Stirling-PDF 那套 stateful workspace 的簡化版。
 */
function renderChain() {
  const box = $('#chain');
  const buttons = $('#chain-buttons');
  buttons.innerHTML = '';

  const allPdf = results.length > 0 && results.every((r) => r.name.endsWith('.pdf'));
  const allImg = results.length > 0 && results.every((r) => /\.(png|jpe?g)$/i.test(r.name));
  if (!allPdf && !allImg) { box.hidden = true; return; }

  const kind = allPdf ? 'pdf' : 'image';
  const targets = TOOLS.filter(
    (t) => t.accept === kind && t.id !== currentTool.id && (t.multiple || results.length === 1) && !(t.min > results.length)
  );
  if (!targets.length) { box.hidden = true; return; }

  for (const tool of targets) {
    const btn = el('button', 'btn ghost', tool.name);
    btn.addEventListener('click', () => chainInto(tool.id));
    buttons.appendChild(btn);
  }
  box.hidden = false;
}

async function chainInto(id) {
  const carried = [];
  for (const res of results) {
    carried.push({ name: res.name, buf: await res.blob.arrayBuffer(), size: res.blob.size, type: res.blob.type });
  }
  organizeState = null;
  pendingCarry = carried;   // 交給路由處理器在切換後放進 files
  navigate(id);
  toast(`帶入 ${carried.length} 個檔案到「${TOOL_BY_ID[id].name}」`, 'ok');
}

/* ---------------- 全部下載 ---------------- */

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
      const ext = res.name.slice(baseName(res.name).length);
      entry = `${baseName(res.name)} (${n})${ext}`;
    } else {
      used.set(entry, 0);
    }
    zip.file(entry, res.blob);
  }

  setProgress(0, 1, '正在打包 ZIP…');
  const blob = await zip.generateAsync({ type: 'blob' }, (meta) =>
    setProgress(meta.percent, 100, `正在打包 ZIP… ${Math.round(meta.percent)}%`)
  );
  clearProgress();

  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pdf-工具箱-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
});

/* ============================================================
   放大預覽
   ------------------------------------------------------------
   縮圖只有 190px，看不清楚內容。點縮圖（或檔案列的「預覽」）就開一個
   大圖檢視，可翻頁、可旋轉。pdf.js 文件在關閉時才銷毀，翻頁不用重開。
   ============================================================ */

let preview = null;  // { doc, entries: [{ page, rot }], idx, onRotate }

async function openPreview({ buf, password, entries, idx = 0, title, onRotate }) {
  closePreview();

  const box = $('#lightbox');
  box.hidden = false;
  $('#lb-title').textContent = title || '預覽';
  $('#lb-rotate').hidden = !onRotate;
  $('#lb-stage').innerHTML = '<div class="lb-msg">載入中…</div>';

  let doc;
  try {
    doc = await openWithPdfJs(buf, password);
  } catch (err) {
    $('#lb-stage').innerHTML = '';
    $('#lb-stage').appendChild(el('div', 'lb-msg', err.message));
    return;
  }

  preview = { doc, entries, idx, onRotate };
  await drawPreview();
}

async function drawPreview() {
  if (!preview) return;
  const { doc, entries, idx } = preview;
  const entry = entries[idx];

  $('#lb-count').textContent = `${idx + 1} / ${entries.length}`;
  $('#lb-prev').disabled = idx === 0;
  $('#lb-next').disabled = idx === entries.length - 1;

  const page = await doc.getPage(entry.page);
  // 疊上使用者在頁面管理裡設定的旋轉，讓預覽和實際輸出一致
  const base = page.getViewport({ scale: 1, rotation: (page.rotate + (entry.rot || 0)) % 360 });
  const stage = $('#lb-stage');
  const avail = Math.max(320, stage.clientWidth - 36);
  const scale = Math.min(2.5, Math.max(1, avail / base.width) * (window.devicePixelRatio > 1 ? 1.5 : 1));
  const vp = page.getViewport({ scale, rotation: (page.rotate + (entry.rot || 0)) % 360 });

  const { canvas, ctx } = makeCanvas(vp);
  await renderPage(page, vp, ctx);

  // 用 CSS 寬度控制顯示尺寸，canvas 本身維持高解析度才不會糊
  canvas.style.width = Math.min(base.width * (avail / base.width), base.width * 1.6) + 'px';

  if (!preview) { freeCanvas(canvas); return; }  // 繪製途中被關掉了
  stage.innerHTML = '';
  stage.appendChild(canvas);
}

function closePreview() {
  if (preview) {
    preview.doc.destroy();
    preview = null;
  }
  $('#lightbox').hidden = true;
  $('#lb-stage').innerHTML = '';
}

function stepPreview(delta) {
  if (!preview) return;
  const next = preview.idx + delta;
  if (next < 0 || next >= preview.entries.length) return;
  preview.idx = next;
  drawPreview();
}

$('#lb-close').addEventListener('click', closePreview);
$('#lb-prev').addEventListener('click', () => stepPreview(-1));
$('#lb-next').addEventListener('click', () => stepPreview(1));
$$('[data-lb-close]').forEach((n) => n.addEventListener('click', closePreview));

$('#lb-rotate').addEventListener('click', () => {
  if (!preview || !preview.onRotate) return;
  const entry = preview.entries[preview.idx];
  entry.rot = ((entry.rot || 0) + 90) % 360;
  preview.onRotate(entry);
  drawPreview();
});

window.addEventListener('keydown', (e) => {
  if ($('#lightbox').hidden) return;
  if (e.key === 'Escape') closePreview();
  else if (e.key === 'ArrowLeft') stepPreview(-1);
  else if (e.key === 'ArrowRight') stepPreview(1);
});

/** 從檔案列預覽一整份 PDF。 */
async function previewFile(item) {
  const password = currentTool && currentTool.password ? $('#pdf-password').value : '';
  let count = 0;
  try {
    const probe = await openWithPdfJs(item.buf, password);
    count = probe.numPages;
    probe.destroy();
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  await openPreview({
    buf: item.buf,
    password,
    entries: Array.from({ length: count }, (_, i) => ({ page: i + 1, rot: 0 })),
    title: item.name,
  });
}

/* ---------------- 頁面管理：縮圖 ---------------- */

async function loadOrganize() {
  const item = files[0];
  const box = $('#organize-thumbs');
  box.innerHTML = '';
  organizeState = null;
  if (!item) { $('#org-count').textContent = ''; return; }

  hideError();
  let doc;
  try {
    doc = await openWithPdfJs(item.buf, $('#pdf-password').value);
  } catch (err) {
    showError(err.message);
    clearProgress();
    return;
  }

  const thumbs = [];
  for (let n = 1; n <= doc.numPages; n++) {
    setProgress(n - 1, doc.numPages, `正在產生縮圖 ${n} / ${doc.numPages}…`);
    const page = await doc.getPage(n);
    const full = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 190 / Math.max(full.width, full.height) });
    const { canvas, ctx } = makeCanvas(vp);
    await renderPage(page, vp, ctx);
    thumbs.push(canvas);
  }
  doc.destroy();
  clearProgress();

  organizeState = {
    pages: thumbs.map((_, i) => ({ orig: i, rot: 0, deleted: false })),
    thumbs,
  };
  $('#organize-name').value = safeName(baseName(item.name)) + '-編輯';
  renderOrganize();
}

function renderOrganize() {
  const box = $('#organize-thumbs');
  box.innerHTML = '';
  if (!organizeState) return;

  const pages = organizeState.pages;
  const kept = pages.filter((p) => !p.deleted).length;
  $('#org-count').textContent = `共 ${pages.length} 頁，保留 ${kept} 頁`;

  pages.forEach((pg, idx) => {
    const card = el('div', 'thumb' + (pg.deleted ? ' deleted' : ''));
    card.draggable = true;
    attachReorder(card, idx, pages, renderOrganize);

    // 依旋轉角度重畫縮圖，讓畫面反映實際輸出方向
    const src = organizeState.thumbs[pg.orig];
    const view = el('canvas', 'tcanvas');
    const turned = pg.rot % 180 !== 0;
    view.width = turned ? src.height : src.width;
    view.height = turned ? src.width : src.height;
    const ctx = view.getContext('2d');
    ctx.translate(view.width / 2, view.height / 2);
    ctx.rotate((pg.rot * Math.PI) / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    view.title = '點擊放大';
    view.addEventListener('click', () => openOrganizePreview(idx));
    card.appendChild(view);

    card.appendChild(el('div', 'tzoom', '🔍'));
    card.appendChild(el('div', 'tnum', `第 ${pg.orig + 1} 頁${pg.rot ? ` · ${pg.rot}°` : ''}`));

    const bar = el('div', 'tbar');
    const mk = (label, title, fn, disabled) => {
      const b = el('button', null, label);
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    mk('←', '往前移', () => { [pages[idx - 1], pages[idx]] = [pages[idx], pages[idx - 1]]; renderOrganize(); }, idx === 0);
    mk('🔍', '放大預覽', () => openOrganizePreview(idx));
    mk('⟳', '右轉 90°', () => { pg.rot = (pg.rot + 90) % 360; renderOrganize(); });
    mk(pg.deleted ? '↺' : '✕', pg.deleted ? '取消刪除' : '刪除這頁', () => { pg.deleted = !pg.deleted; renderOrganize(); });
    mk('→', '往後移', () => { [pages[idx + 1], pages[idx]] = [pages[idx], pages[idx + 1]]; renderOrganize(); }, idx === pages.length - 1);
    card.appendChild(bar);

    box.appendChild(card);
  });
}

/** 從頁面管理的縮圖開啟預覽，順序與旋轉都跟著目前的編輯狀態。 */
function openOrganizePreview(idx) {
  if (!organizeState || !files.length) return;
  const entries = organizeState.pages.map((pg) => ({ page: pg.orig + 1, rot: pg.rot, ref: pg }));
  openPreview({
    buf: files[0].buf,
    password: $('#pdf-password').value,
    entries,
    idx,
    title: files[0].name,
    onRotate: (entry) => {
      entry.ref.rot = entry.rot;
      renderOrganize();
    },
  });
}

$('#org-reset').addEventListener('click', () => {
  if (!organizeState) return;
  organizeState.pages = organizeState.pages
    .map((p) => ({ orig: p.orig, rot: 0, deleted: false }))
    .sort((a, b) => a.orig - b.orig);
  renderOrganize();
});

$('#org-reverse').addEventListener('click', () => {
  if (!organizeState) return;
  organizeState.pages.reverse();
  renderOrganize();
});

$('#org-rotate-all').addEventListener('click', () => {
  if (!organizeState) return;
  organizeState.pages.forEach((p) => (p.rot = (p.rot + 90) % 360));
  renderOrganize();
});

// 密碼改了就重新載入縮圖
$('#pdf-password').addEventListener('change', () => {
  if (currentTool && currentTool.id === 'organize' && files.length) loadOrganize();
});

/* ============================================================
   浮水印：圖片來源與即時預覽
   ------------------------------------------------------------
   預覽走的是實際輸出用的同一段程式（stampWatermark）—— 取第一頁做成
   單頁 PDF、蓋上浮水印、再用 pdf.js 畫出來。稍微慢一點，但保證所見即
   所得，不會有預覽和成品不一致的問題。
   ============================================================ */

let watermarkImage = null;      // { name, buf }
let wmPreviewToken = 0;
let wmPreviewTimer = null;

$('#wm-imgpick').addEventListener('click', (e) => {
  if (e.target.id === 'wm-imgclear') return;
  $('#wm-imgfile').click();
});

$('#wm-imgfile').addEventListener('change', async () => {
  const file = $('#wm-imgfile').files[0];
  $('#wm-imgfile').value = '';
  if (!file) return;
  try {
    watermarkImage = { name: file.name, buf: await readAsArrayBuffer(file) };
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  $('#wm-imgname').textContent = `${watermarkImage.name}（${fmtSize(watermarkImage.buf.byteLength)}）`;
  $('#wm-imgclear').hidden = false;
  scheduleWatermarkPreview();
});

$('#wm-imgclear').addEventListener('click', (e) => {
  e.stopPropagation();
  watermarkImage = null;
  $('#wm-imgname').textContent = '點擊選擇 PNG / JPG（建議用去背的 PNG）';
  $('#wm-imgclear').hidden = true;
  scheduleWatermarkPreview();
});

function syncWatermarkKind() {
  const image = getSegmented('#wm-kind') === 'image';
  $$('.wm-text-only').forEach((n) => (n.hidden = image));
  $$('.wm-image-only').forEach((n) => (n.hidden = !image));
}

function scheduleWatermarkPreview() {
  clearTimeout(wmPreviewTimer);
  wmPreviewTimer = setTimeout(updateWatermarkPreview, 320);
}

async function updateWatermarkPreview() {
  if (!currentTool || currentTool.id !== 'watermark') return;

  const box = $('#wm-preview');
  const note = $('#wm-prevnote');
  const token = ++wmPreviewToken;

  const fail = (msg) => {
    if (token !== wmPreviewToken) return;
    box.innerHTML = '';
    box.appendChild(el('div', 'wm-prev-empty', msg));
    note.textContent = '';
  };

  if (!files.length) return fail('選好 PDF 後，這裡會顯示套用浮水印後的第一頁');
  note.textContent = '（產生中…）';

  try {
    const src = await openWithPdfLib(files[0].buf);
    const one = await PDFDocument.create();
    const [page] = await one.copyPages(src, [0]);
    one.addPage(page);
    await stampWatermark(one, readWatermarkOptions(), watermarkImage && watermarkImage.buf);
    const bytes = await one.save();

    const doc = await pdfjsLib.getDocument({ data: bytes.slice().buffer }).promise;
    const pg = await doc.getPage(1);
    const base = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: Math.min(2, 620 / base.width) });
    const { canvas, ctx } = makeCanvas(vp);
    await renderPage(pg, vp, ctx);
    doc.destroy();

    if (token !== wmPreviewToken) { freeCanvas(canvas); return; }  // 已有更新的預覽在跑
    box.innerHTML = '';
    box.appendChild(canvas);
    note.textContent = `（${files[0].name} 第 1 頁）`;
  } catch (err) {
    fail(err.message || '預覽失敗');
  }
}

// 任何一個浮水印選項變動都重畫預覽
['#wm-text', '#wm-size', '#wm-color', '#wm-opacity', '#wm-angle', '#wm-imgscale'].forEach((sel) => {
  $(sel).addEventListener('input', scheduleWatermarkPreview);
});

/* ---------------- 選項面板的互動 ---------------- */

$$('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $$('button', group).forEach((b) => b.classList.toggle('on', b === btn));
    if (group.id === 'split-mode') $('#split-chunk-wrap').hidden = btn.dataset.val !== 'chunks';
    if (group.id === 'p2i-format') $('#p2i-qwrap').hidden = btn.dataset.val !== 'image/jpeg';
    if (group.id === 'wm-kind') syncWatermarkKind();
    if (group.id.startsWith('wm-')) scheduleWatermarkPreview();
  });
});

$('#p2i-quality').addEventListener('input', (e) => {
  $('#p2i-qval').textContent = parseFloat(e.target.value).toFixed(2);
});
$('#gs-mode').addEventListener('change', (e) => {
  $('#gs-thresh-wrap').hidden = e.target.value !== 'bw';
});
$('#gs-thresh').addEventListener('input', (e) => {
  $('#gs-tval').textContent = e.target.value;
});
$('#wm-opacity').addEventListener('input', (e) => {
  $('#wm-oval').textContent = parseFloat(e.target.value).toFixed(2);
});
$('#wm-imgscale').addEventListener('input', (e) => {
  $('#wm-sval').textContent = e.target.value + '%';
});

/* ---------------- 執行 ---------------- */

$('#run-btn').addEventListener('click', async () => {
  if (!currentTool) return;
  hideError();
  clearResults();

  if (!files.length) {
    showError('請先選擇檔案。');
    return;
  }
  if (currentTool.min && files.length < currentTool.min) {
    showError(`「${currentTool.name}」至少需要 ${currentTool.min} 個檔案。`);
    return;
  }

  const btn = $('#run-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '處理中…';

  try {
    const password = currentTool.password ? $('#pdf-password').value : '';
    const msg = await currentTool.run(files, password);
    setProgress(1, 1, msg);
    renderResults();
    toast(msg, 'ok');
  } catch (err) {
    console.error(err);
    clearProgress();
    showError(err && err.message ? err.message : String(err));
    renderResults();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ---------------- 啟動 ---------------- */

buildHome();
handleRoute();   // 支援直接開 .../#/watermark 這種網址
