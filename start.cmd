@echo off
chcp 65001 >nul
title PDF 工具箱
cd /d "%~dp0"
echo.
echo   PDF 工具箱正在啟動...
echo   瀏覽器會自動開啟 http://localhost:8777
echo   用完關掉這個黑色視窗就會停止。
echo.
start "" http://localhost:8777
python -m http.server 8777
