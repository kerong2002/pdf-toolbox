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
    card.appendChild(view);

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
    mk('⟳', '右轉 90°', () => { pg.rot = (pg.rot + 90) % 360; renderOrganize(); });
    mk(pg.deleted ? '↺' : '✕', pg.deleted ? '取消刪除' : '刪除這頁', () => { pg.deleted = !pg.deleted; renderOrganize(); });
    mk('→', '往後移', () => { [pages[idx + 1], pages[idx]] = [pages[idx], pages[idx + 1]]; renderOrganize(); }, idx === pages.length - 1);
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

/* ---------------- 選項面板的互動 ---------------- */

$$('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $$('button', group).forEach((b) => b.classList.toggle('on', b === btn));
    if (group.id === 'split-mode') $('#split-chunk-wrap').hidden = btn.dataset.val !== 'chunks';
    if (group.id === 'p2i-format') $('#p2i-qwrap').hidden = btn.dataset.val !== 'image/jpeg';
  });
});

$('#p2i-quality').addEventListener('input', (e) => {
  $('#p2i-qval').textContent = parseFloat(e.target.value).toFixed(2);
});
$('#wm-opacity').addEventListener('input', (e) => {
  $('#wm-oval').textContent = parseFloat(e.target.value).toFixed(2);
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
