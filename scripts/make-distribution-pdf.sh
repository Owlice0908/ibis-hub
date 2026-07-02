#!/bin/bash
# DISTRIBUTION.md → 綺麗な PDF (Chrome ヘッドレス経由)
set -e
cd "$(dirname "$0")/.."

# 1. Markdown → HTML body (marked CLI、ephemeral 実行)
BODY=$(npx --yes marked -i DISTRIBUTION.md 2>/dev/null)

# 2. HTML full (with inline CSS)
CSS=$(cat scripts/distribution.css)
cat > /tmp/distribution.html << HTML
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>Ibis Hub 利用ガイド</title>
<style>
${CSS}
</style>
</head>
<body>
${BODY}
</body>
</html>
HTML
echo "HTML 生成完了: /tmp/distribution.html ($(wc -c < /tmp/distribution.html) bytes)"

# 3. HTML → PDF (Chrome ヘッドレス、WSL 内 /tmp に出力)
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
if [ ! -x "$CHROME" ]; then
  CHROME="/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
fi

WSL_OUT="/tmp/Ibis-Hub-利用ガイド-v0.2.76.pdf"
rm -f "$WSL_OUT"

# Chrome には Windows パスで渡す (WSL パスだと file:// スキームが解釈できない)
HTML_WIN=$(wslpath -w /tmp/distribution.html)
PDF_WIN=$(wslpath -w /tmp)
"$CHROME" --headless=new --disable-gpu \
  --print-to-pdf="${PDF_WIN}\\Ibis-Hub-利用ガイド-v0.2.76.pdf" \
  --print-to-pdf-no-header \
  "file:///${HTML_WIN//\\/\/}" 2>&1 | \
  grep -vE "DevTools|GLES|Volume|Skipping|SwiftShader|GPU" || true

# 出来た PDF を Windows Downloads にもコピー
WIN_OUT="/mnt/c/Users/stept/Downloads/Ibis-Hub-利用ガイド-v0.2.76.pdf"
if [ -f "$WSL_OUT" ]; then
  cp "$WSL_OUT" "$WIN_OUT"
  echo ""
  echo "✅ PDF 生成完了:"
  echo "   Windows パス: C:\\Users\\stept\\Downloads\\Ibis-Hub-利用ガイド-v0.2.76.pdf"
  ls -la "$WIN_OUT"
else
  echo "❌ PDF 生成失敗" >&2
  exit 1
fi
