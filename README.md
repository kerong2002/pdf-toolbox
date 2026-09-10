# PDF 工具箱

自用的 iLovePDF 替代品。**所有處理都在瀏覽器裡完成，檔案不會上傳到任何伺服器。**

適合拿來處理存摺、財力證明、申貸文件這類不該經過第三方網站的東西。

👉 **https://kerong2002.github.io/pdf-toolbox/**

## 功能

| 工具 | 說明 |
|---|---|
| 合併 PDF | 多份接成一份，可拖曳調整順序 |
| 分割 / 擷取 | 取指定頁（`1-3,5,8-`）、拆成單頁、每 N 頁一份 |
| 頁面管理 | 縮圖預覽，刪頁、拖曳排序、單頁旋轉、反轉頁序 |
| 加頁碼 | 5 種格式、5 個位置，可設起始頁碼 |
| PDF → 圖片 | 每頁一張 PNG / JPG，96–400 DPI，**支援有密碼的 PDF** |
| 圖片 → PDF | PNG / JPG 合成一份，可選 A4 或原圖尺寸 |
| PDF → 文字 | 抽出文字圖層成 .txt |
| 加浮水印 | 文字、字級、角度、透明度、顏色、平鋪，**支援中文** |
| 壓縮 PDF | 重新光柵化，掃描檔可縮到 1/10 以下 |

還有：

- **工具串接** —— 處理完的結果可以直接餵給下一個工具，不用重新選檔（借鏡 Stirling-PDF 的 stateful workspace）
- 多檔輸出一鍵打包成 ZIP
- 淺色／深色主題，跟隨系統或手動切換
- 拖放上傳、拖曳排序

## 怎麼用

### 線上版

直接開 https://kerong2002.github.io/pdf-toolbox/ 。手機、平板都能用。

### 本機（可離線）

雙擊 **`start.cmd`**，瀏覽器會自動開 `http://localhost:8777`。用完關掉黑色視窗即可。需要 Python。

> **不要直接雙擊 `index.html`。** 瀏覽器的 `file://` 安全限制會擋掉 pdf.js 的 Web Worker，PDF → 圖片和壓縮會失敗。

## 技術細節

無建置流程，沒有 npm、沒有後端。三個套件都放在 `vendor/`，斷網也能跑。

- [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 — 組裝、修改 PDF 結構
- [pdf.js](https://github.com/mozilla/pdf.js) 3.11.174 — 光柵化（轉圖片、壓縮、縮圖、抽文字）
- [JSZip](https://github.com/Stuk/jszip) 3.10.1 — 多檔打包

```
index.html      版面
app.css         設計系統（CSS 變數 + 淺／深色）
js/core.js      共用工具、PDF 載入、文字繪製
js/tools.js     9 個工具的實作與註冊表
js/ui.js        畫面、狀態、事件
vendor/         第三方套件
```

要加新工具的話，在 `js/tools.js` 寫一個 `run(files, password)` 函式，再加進 `TOOLS` 陣列，
首頁的卡片和工作區會自動生出來。選項面板放在 `index.html` 裡 id 為 `opt-<工具 id>` 的區塊。

### 踩過的坑

1. **算繪一定要用 `intent: 'print'`**（`core.js` 的 `renderPage`）。pdf.js 在預設的 display intent 下會用 `requestAnimationFrame` 排程每個算繪區塊，而瀏覽器會把背景分頁的 rAF 節流到近乎停止 —— 使用者只要在轉檔途中切去別的分頁，進度條就永遠卡住。print intent 走 microtask，不受影響。

2. **每次都要複製 ArrayBuffer**（`core.js` 的 `copyBuf`）。pdf.js 會把 buffer 轉交給 worker 並使原本的失效，同一份檔案第二次處理就會拿到空資料。

3. **`[hidden] { display: none !important }` 不能省**（`app.css` 開頭）。HTML 的 `hidden` 屬性只靠瀏覽器預設樣式的 `display:none`，任何作者端的 `display: grid / flex` 都會蓋過它 —— 少了這行，切換工具時所有選項面板會同時出現。

4. **中文浮水印用點陣圖繞過字型問題**（`core.js` 的 `TextPainter`）。PDF 的 14 個標準字型只涵蓋 WinAnsi，畫不出中文；內嵌 CJK 字型要多背 5–15 MB。改成把文字用瀏覽器自己的字型畫到透明 canvas 上，當 PNG 嵌進 PDF。純西文仍走向量字型，檔案更小、放大列印也不糊。

### 已知限制

- **不能加密／解密 PDF。** pdf-lib 不支援寫入加密。讀取有密碼的 PDF 沒問題（填密碼即可）。
- **有密碼的 PDF 不能直接做結構性編輯**（合併、分割、加頁碼、浮水印）。變通做法：先用「PDF → 圖片」轉出來，再用「圖片 → PDF」組回去。
- **沒有 OCR。** 掃描檔抽不到文字，因為頁面本身就是圖片。
- **壓縮是破壞性的** —— 文字會變成圖片，不能再選取或搜尋。原檔請留著。

## 為什麼不用現成的

考慮過 [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF)（功能最全，50+ 種）、[OpenPDF](https://github.com/fatihalp/openpdf)、SnapOtter、BentoPDF，但它們都要 Docker / Java / PHP，而且檔案要經過一個伺服器行程。這份是純前端，零安裝、零依賴、隱私上不用信任任何人。

介面設計參考了 [iLovePDF](https://www.ilovepdf.com/) 的工具卡片格與縮圖操作、[Smallpdf](https://smallpdf.com/) 的單一工具工作區，以及 Stirling-PDF 的工具串接。
