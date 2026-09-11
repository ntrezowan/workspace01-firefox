#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p dist
OUT="dist/workspace01-firefox-${VERSION}.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json background.js popup.html popup.css popup.js icons -x '*.DS_Store'
echo "built $OUT"
