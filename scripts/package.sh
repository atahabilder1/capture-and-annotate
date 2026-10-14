#!/usr/bin/env bash
# Builds the zip to upload to the Chrome Web Store: dist/capture-and-annotate-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
out="dist/capture-and-annotate-${version}.zip"
rm -f "$out"
zip -qr "$out" manifest.json icons src -x '*.DS_Store'
echo "Built $out ($(du -h "$out" | cut -f1))"
