#!/usr/bin/env bash
# openNotion mac 客户端一键更新：
#   拉代码 → 装依赖 → 构建 → 安装到 /Applications → 重启应用
#
# 用法：bash scripts/update-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_DST="/Applications/openNotion.app"
APP_SRC="$ROOT/web/src-tauri/target/release/bundle/macos/openNotion.app"

echo "── 1/5 git pull"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✕ 已跟踪文件有未提交改动，请先提交或 stash："
  git status --short | grep -v '^??' | head -10
  exit 1
fi
# 未跟踪文件不阻塞 pull（--ff-only 遇到真正冲突会自行报错）
git pull --ff-only

echo "── 2/5 pnpm install"
cd web
pnpm install

echo "── 3/5 构建 (.app)"
bash "$ROOT/scripts/build-mac.sh" --app-only

echo "── 4/5 安装到 $APP_DST"
pkill -f "$APP_DST/Contents/MacOS/" 2>/dev/null || true
sleep 1
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true
echo "✓ $(du -sh "$APP_DST" | cut -f1)  $APP_DST"

echo "── 5/5 启动"
open "$APP_DST"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo "?")
echo "完成：openNotion $VERSION 已更新并启动。"
