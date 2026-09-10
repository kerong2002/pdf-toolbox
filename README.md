# PDF 工具箱

自用的 iLovePDF 替代品。**所有處理都在瀏覽器裡完成，檔案不會上傳到任何伺服器。**

適合拿來處理存摺、財力證明、申貸文件這類不該經過第三方網站的東西。

## 功能

| 工具 | 說明 |
|---|---|
| 合併 PDF | 多份接成一份，順序可調 |
| 分割 / 擷取頁面 | 取指定頁（`1-3,5,8-`）、拆成單頁、每 N 頁一份 |
| 頁面管理 | 縮圖預覽，刪頁、搬動順序、單頁旋轉 |
| PDF → 圖片 | 每頁一張 PNG / JPG，96–400 DPI，**支援有密碼的 PDF** |
| 圖片 → PDF | PNG / JPG 合成一份，可選 A4 或跟著原圖尺寸 |
| 加浮水印 | 文字、字級、角度、透明度、顏色（**僅限英數字**） |
| 壓縮 PDF | 重新光柵化成 JPG，掃描檔可縮到 1/10 以下 |

多個輸出可以一鍵打包成 ZIP 下載。

## 怎麼用

### 方法 1：本機（推薦，可離線）

雙擊 **`start.cmd`**，瀏覽器會自動開 `http://localhost:8777`。用完關掉黑色視窗即可。

> 需要 Python（`python -m http.server`）。這台已經有了。
>
> **不要直接雙擊 `index.html`。** 瀏覽器的 `file://` 安全限制會擋掉 pdf.js 的 Web Worker，PDF → 圖片和壓縮會失敗。一定要透過 `start.cmd` 起的本機伺服器開。

### 方法 2：GitHub Pages（手機、平板也能用）

```bash
cd C:\Users\krameri120\Desktop\pdf-toolbox
git remote add origin https://github.com/<你的帳號>/pdf-toolbox.git
git push -u origin main
```

推上去之後，到 repo 的 **Settings → Pages → Source** 選 `Deploy from a branch`，branch 選 `main` / `(root)`，存檔。等一兩分鐘就會有網址：

```
https://<你的帳號>.github.io/pdf-toolbox/
```

即使 repo 設成 public 也沒有隱私問題 —— 上面只有程式碼，你的檔案永遠留在自己的裝置上，GitHub 只負責把 HTML/JS 送給你。

## 技術細節

無建置流程，沒有 npm、沒有後端。三個套件都放在 `vendor/`，斷網也能跑。

- [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 — 組裝、修改 PDF 結構
- [pdf.js](https://github.com/mozilla/pdf.js) 3.11.174 — 光柵化（轉圖片、壓縮、縮圖）
- [JSZip](https://github.com/Stuk/jszip) 3.10.1 — 多檔打包

### 兩個踩過的坑

1. **算繪一定要用 `intent: 'print'`**（見 `app.js` 的 `renderPage`）。pdf.js 在預設的 display intent 下會用 `requestAnimationFrame` 排程每個算繪區塊，而瀏覽器會把背景分頁的 rAF 節流到近乎停止 —— 使用者只要在轉檔途中切去別的分頁，進度條就永遠卡住。print intent 走 microtask，不受影響。

2. **每次都要複製 ArrayBuffer**（見 `copyBuf`）。pdf.js 會把 buffer 轉交給 worker 並使原本的失效，同一份檔案第二次處理就會拿到空資料。

### 已知限制

- **浮水印只支援英數字。** PDF 標準字型（Helvetica）不含中文字符，要中文得內嵌一個 CJK 字型檔（約 5–15 MB）。目前的做法是事前擋下並給明確訊息。
- **不能加密／解密 PDF。** pdf-lib 不支援寫入加密。讀取有密碼的 PDF 沒問題（填密碼即可）。
- **有密碼的 PDF 不能直接做結構性編輯**（合併、分割、旋轉、浮水印）。變通做法：先用「PDF → 圖片」轉出來，再用「圖片 → PDF」組回去。
- **壓縮是破壞性的** —— 文字會變成圖片，不能再選取或搜尋。原檔請留著。

## 為什麼不用現成的

考慮過 [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF)（功能最全，~50 種）、[OpenPDF](https://github.com/fatihalp/openpdf)、SnapOtter、BentoPDF，但它們都要 Docker / Java / PHP，而且檔案要經過一個伺服器行程。這份是純前端，零安裝、零依賴、隱私上不用信任任何人。
