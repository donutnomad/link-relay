#!/bin/sh
# 生成 dist/link-relay-chrome.zip 与 dist/link-relay-firefox.zip，以及可直接加载的 dist/firefox 目录
set -e
cd "$(dirname "$0")"
FILES="background.js content.js main-bridge.js main-protocol.js options.html options.js icons"
rm -rf dist && mkdir -p dist/chrome dist/firefox
for t in chrome firefox; do
  cp -R $FILES dist/$t/
done
cp manifest.json dist/chrome/manifest.json
cp manifest.firefox.json dist/firefox/manifest.json
for t in chrome firefox; do (cd dist/$t && zip -qr ../link-relay-$t.zip .); done
ls dist
