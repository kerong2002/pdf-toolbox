/* ============================================================
   core.js — 共用工具、PDF 載入、文字繪製
   ============================================================ */
'use strict';

const { PDFDocument, StandardFonts, degrees, rgb } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const A4 = { w: 595.28, h: 841.89 };

/* ---------------- DOM ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------------- 格式化 ---------------- */

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

const baseName = (name) => name.replace(/\.[^.]+$/, '');

/** 去掉檔名裡不能用的字元，保留中文。 */
function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || '輸出';
}

/* ---------------- 檔案 / Canvas ---------------- */

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

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('無法輸出圖片，頁面可能過大。請調低解析度再試。'))),
      type,
      quality
    );
  });
}

/** 建一張鋪好白底的 canvas（JPG 沒有透明通道，不鋪白底透明處會變黑）。 */
function makeCanvas(viewport, transparent) {
  const canvas = el('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!transparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return { canvas, ctx };
}

/** 用完立刻歸零，避免連續處理多頁時大張 canvas 把記憶體吃光。 */
const freeCanvas = (canvas) => { canvas.width = canvas.height = 0; };

/**
 * 把一頁畫到 canvas 上。
 *
 * 一定要用 intent:'print'。pdf.js 在 display intent 下會用 requestAnimationFrame
 * 排程每個算繪區塊，而瀏覽器對背景分頁的 rAF 節流到近乎停止 —— 使用者只要在轉檔
 * 途中切到別的分頁，整個流程就會卡住不動。print intent 走 microtask，不受影響。
 */
const renderPage = (page, viewport, ctx) =>
  page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

/* ---------------- 頁碼解析 ---------------- */

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

/** 看檔頭判斷是不是 PNG，比信任副檔名或 MIME 可靠。 */
function isPngBytes(buf) {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(1, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/* ---------------- PDF 載入 ---------------- */

async function openWithPdfJs(buf, password) {
  try {
    return await pdfjsLib.getDocument({ data: copyBuf(buf), password: password || undefined }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new Error(
        err.code === 2
          ? '密碼不對，請重新確認。'
          : '這份 PDF 有設開檔密碼。請在下方「PDF 開檔密碼」欄位填入後再試一次。'
      );
    }
    if (err && err.name === 'InvalidPDFException') throw new Error('這個檔案不是有效的 PDF。');
    throw err;
  }
}

async function openWithPdfLib(buf) {
  try {
    return await PDFDocument.load(copyBuf(buf), { ignoreEncryption: true });
  } catch (err) {
    const encrypted = /encrypt/i.test(err && err.message || '');
    throw new Error(
      `這份 PDF 沒辦法直接編輯${encrypted ? '（有加密保護）' : ''}。\n` +
        '變通做法：先用「PDF → 圖片」轉成圖片，再用「圖片 → PDF」組回來。'
    );
  }
}

/* ============================================================
   文字繪製
   ------------------------------------------------------------
   PDF 的 14 個標準字型只涵蓋 WinAnsi，畫不出中文。與其要求使用者
   下載 5–15 MB 的 CJK 字型檔，這裡改用瀏覽器自己的字型：把文字畫到
   一張透明 canvas 上，當成 PNG 嵌進 PDF。

   純西文仍走向量字型 —— 檔案小很多，放大列印也不會糊。
   ============================================================ */

const WINANSI = /^[\x20-\x7E\xA0-\xFF]*$/;
const CJK_STACK = '"Microsoft JhengHei","PingFang TC","Noto Sans TC","Hiragino Sans","Yu Gothic",sans-serif';

/** 把文字畫成透明背景的 PNG。scale 越大越清晰，代價是檔案變大。 */
async function textToPng(text, fontSize, cssColor, scale = 4) {
  const px = fontSize * scale;
  const font = `600 ${px}px ${CJK_STACK}`;

  const probe = el('canvas').getContext('2d');
  probe.font = font;
  const metrics = probe.measureText(text);
  const pad = Math.ceil(px * 0.12);
  const w = Math.ceil(metrics.width) + pad * 2;
  const h = Math.ceil(px * 1.35) + pad * 2;

  const canvas = el('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = cssColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const blob = await canvasToBlob(canvas, 'image/png');
  const bytes = await blob.arrayBuffer();
  freeCanvas(canvas);
  return { bytes, width: w / scale, height: h / scale };
}

/**
 * 幫一份 PDF 畫文字，自動選擇向量字型或點陣圖。
 * 同一份文件重複用同樣的文字時會沿用快取，不會重複嵌入。
 */
class TextPainter {
  constructor(doc) {
    this.doc = doc;
    this.font = null;
    this.images = new Map();
  }

  /** 這段文字能不能用內建向量字型畫？ */
  static isVector(text) {
    return WINANSI.test(text);
  }

  async _getFont() {
    if (!this.font) this.font = await this.doc.embedFont(StandardFonts.HelveticaBold);
    return this.font;
  }

  async _getImage(text, size, cssColor) {
    const key = `${text}|${size}|${cssColor}`;
    if (!this.images.has(key)) {
      const png = await textToPng(text, size, cssColor);
      const img = await this.doc.embedPng(png.bytes);
      this.images.set(key, { img, width: png.width, height: png.height });
    }
    return this.images.get(key);
  }

  /** 回傳這段文字畫出來的寬高（PDF 點）。 */
  async measure(text, size, cssColor) {
    if (TextPainter.isVector(text)) {
      const font = await this._getFont();
      return { width: font.widthOfTextAtSize(text, size), height: font.heightAtSize(size) };
    }
    const { width, height } = await this._getImage(text, size, cssColor);
    return { width, height };
  }

  /**
   * 以 (cx, cy) 為中心畫一段文字，可旋轉。
   * pdf-lib 的 rotate 是以繪製原點為軸心，所以要把中心點換算回左下角原點。
   */
  async drawCentered(page, text, { cx, cy, size, cssColor, color, opacity = 1, angle = 0 }) {
    const { width, height } = await this.measure(text, size, cssColor);
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const x = cx - (width / 2) * cos + (height / 2) * sin;
    const y = cy - (width / 2) * sin - (height / 2) * cos;

    if (TextPainter.isVector(text)) {
      const font = await this._getFont();
      page.drawText(text, { x, y, size, font, color, opacity, rotate: degrees(angle) });
    } else {
      const { img } = await this._getImage(text, size, cssColor);
      page.drawImage(img, { x, y, width, height, opacity, rotate: degrees(angle) });
    }
  }
}
