#!/usr/bin/env bash
# 更新 index.html 裡的 ?v= 版本戳。
#
# 為什麼需要：GitHub Pages 對每個檔案都送 Cache-Control: max-age=600，
# HTML 與 JS/CSS 會各自獨立過期。沒有版本戳的話，部署後 10 分鐘內回訪的
# 使用者可能拿到「新 HTML + 舊 JS」的組合而讓功能壞掉。
#
# 用法：在 Git Bash 裡於專案根目錄執行 ./bump-version.sh，然後照常 commit。

set -euo pipefail
cd "$(dirname "$0")"

# 同一天多次發佈時往後接 a、b、c…
today=$(date +%Y%m%d)
current=$(grep -o 'v=[0-9]\{8\}[a-z]' index.html | head -1 | cut -c3-)

if [ "${current:0:8}" = "$today" ]; then
  next_letter=$(printf "\\$(printf '%03o' $(( $(printf '%d' "'${current:8:1}") + 1 )))")
  version="${today}${next_letter}"
else
  version="${today}a"
fi

sed -i "s/v=[0-9]\{8\}[a-z]/v=$version/g" index.html

echo "版本戳更新為 $version："
grep -o '\(app\.css\|js/[a-z]*\.js\)?v=[0-9]*[a-z]' index.html
