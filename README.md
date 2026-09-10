# PDF 工具箱

自用的 iLovePDF 替代品。**所有處理都在瀏覽器裡完成，檔案不會上傳到任何伺服器。**

適合拿來處理存摺、財力證明、申貸文件這類不該經過第三方網站的東西。

👉 **https://kerong2002.github.io/pdf-toolbox/**

## 功能

17 個工具，分五類。

**組織**

| 工具 | 說明 |
|---|---|
| 頁面管理 | 縮圖預覽（可點開放大），刪頁、拖曳排序、單頁旋轉、反轉頁序 |
| 合併 PDF | 多份接成一份，可拖曳調整順序 |
| 分割 / 擷取 | 取指定頁（`1-3,5,8-`）、拆成單頁、每 N 頁一份 |
| 加頁碼 | 5 種格式、5 個位置，可設起始頁碼 |
| 多頁併一頁 | 2 / 4 / 6 / 9 頁排在同一張紙上，可加分隔線 |
| 交錯合併 | 兩份交替取頁，雙面掃描的正反面可合回一份（背面可反序） |

**轉換**

| 工具 | 說明 |
|---|---|
| PDF → 圖片 | 每頁一張 PNG / JPG，96–400 DPI，**支援有密碼的 PDF** |
| 圖片 → PDF | PNG / JPG 合成一份，可選 A4 或原圖尺寸 |
| PDF → 文字 | 抽出文字圖層成 .txt |

**編輯**

| 工具 | 說明 |
|---|---|
| 加浮水印 | **文字或圖片**，角度、透明度、大小、平鋪，**支援中文**，有即時效果預覽 |
| 中繼資料 | 編輯標題／作者／主旨／關鍵字，或一鍵清除全部痕跡 |
| 展平表單 | 把表單欄位壓平成頁面內容，定稿用 |

**安全**

| 工具 | 說明 |
|---|---|
| 加密 PDF | 設開檔密碼，256 / 128 / 40 位元，可禁止列印與複製 |
| 解密 PDF | 移除開檔密碼，**文字圖層完整保留** |

**優化**

| 工具 | 說明 |
|---|---|
| 壓縮 PDF | 重新光柵化，掃描檔可縮到 1/10 以下 |
| 移除空白頁 | 自動偵測並刪掉空白頁，判定標準三段可調 |
| 灰階 / 黑白 | 轉灰階或二值化，列印省墨、檔案更小 |

還有：

- **工具串接** —— 處理完的結果可以直接餵給下一個工具，不用重新選檔（借鏡 Stirling-PDF 的 stateful workspace）
- **每個工具有自己的網址**（`#/merge`），上一頁／下一頁可在工具間來回，也能收藏分享
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
- [qpdf-wasm](https://www.npmjs.com/package/@neslinesli93/qpdf-wasm) 0.3.0 — 加密／解密（1.3 MB，**只在用到加密工具時才載入**）

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

### 發佈前務必執行

```bash
./bump-version.sh
```

這會更新 `index.html` 裡資源網址的 `?v=` 版本戳。**跳過這步會讓部分使用者拿到壞掉的版本** ——
GitHub Pages 對每個檔案都送 `Cache-Control: max-age=600`，HTML 與 JS/CSS 各自獨立過期，
回訪者很可能拿到「新 HTML + 舊 JS」。加了版本戳之後，每份 HTML 只會拉到與自己配對的資源，
最差情況只是看到舊版，不會半新半舊而壞掉。

### 踩過的坑

1. **算繪一定要用 `intent: 'print'`**（`core.js` 的 `renderPage`）。pdf.js 在預設的 display intent 下會用 `requestAnimationFrame` 排程每個算繪區塊，而瀏覽器會把背景分頁的 rAF 節流到近乎停止 —— 使用者只要在轉檔途中切去別的分頁，進度條就永遠卡住。print intent 走 microtask，不受影響。

2. **每次都要複製 ArrayBuffer**（`core.js` 的 `copyBuf`）。pdf.js 會把 buffer 轉交給 worker 並使原本的失效，同一份檔案第二次處理就會拿到空資料。

3. **`[hidden] { display: none !important }` 不能省**（`app.css` 開頭）。HTML 的 `hidden` 屬性只靠瀏覽器預設樣式的 `display:none`，任何作者端的 `display: grid / flex` 都會蓋過它 —— 少了這行，切換工具時所有選項面板會同時出現。

4. **中文浮水印用點陣圖繞過字型問題**（`core.js` 的 `TextPainter`）。PDF 的 14 個標準字型只涵蓋 WinAnsi，畫不出中文；內嵌 CJK 字型要多背 5–15 MB。改成把文字用瀏覽器自己的字型畫到透明 canvas 上，當 PNG 嵌進 PDF。純西文仍走向量字型，檔案更小、放大列印也不糊。

5. **qpdf 這個 wasm build 不輸出錯誤訊息**（`tools.js` 的 `runDecrypt`）。它只回傳 exit code，`printErr` 收不到任何東西，所以分不出「密碼錯」和「檔案損毀」。解法是先用 pdf.js 開一次來驗密碼 —— 它的 `PasswordException` 能明確區分「需要密碼」和「密碼不對」。

### 已知限制

- **有密碼的 PDF 不能直接做結構性編輯**（合併、分割、加頁碼、浮水印）。先用「解密 PDF」移除密碼即可，文字圖層不會受損。
- **沒有 OCR。** 掃描檔抽不到文字，因為頁面本身就是圖片。
- **壓縮、灰階是破壞性的** —— 文字會變成圖片，不能再選取或搜尋。原檔請留著。
- **含中文的表單無法壓平。** pdf-lib 重建欄位外觀時會用標準字型，畫不出中文。工具會偵測並給出變通建議。
- **解密只能解你知道密碼的檔案。** 這不是破解工具。

## 和 Stirling-PDF 的關係

[Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF)（MIT，核心部分）有 50+ 工具，是這個專案最主要的參考對象。但它是 Java + Spring 後端，很多功能靠伺服器上的外部程式，沒辦法搬到純前端：

| Stirling 的功能 | 依賴 | 這裡的狀況 |
|---|---|---|
| PDF ↔ Word / Excel / PPT | LibreOffice | ❌ 純前端無解 |
| PDF/A 轉換、修復 | Ghostscript / qpdf | ❌ |
| OCR | OCRmyPDF + Tesseract | ⚠️ Tesseract.js 可行，中文語言包約 15 MB |
| 加密 / 解密 | PDFBox | ✅ 已實作（改用 qpdf-wasm） |
| 合併、分割、旋轉、浮水印、頁碼、壓縮、N-up、交錯、去空白、灰階、中繼資料、展平 | 純 PDF 結構操作 | ✅ 已實作 |

把後端加回來就等於放棄「檔案不離開你的電腦」，那是這個專案存在的理由，所以不做。

介面設計則參考 [iLovePDF](https://www.ilovepdf.com/) 的工具卡片格與縮圖操作、[Smallpdf](https://smallpdf.com/) 的單一工具工作區，以及 Stirling-PDF 的工具串接。

其他看過的：[OpenPDF](https://github.com/fatihalp/openpdf)（Laravel）、SnapOtter、BentoPDF —— 同樣都要 Docker / PHP。
