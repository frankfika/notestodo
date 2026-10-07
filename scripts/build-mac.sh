#!/usr/bin/env bash
# 拾贝 mac 客户端一键构建
#
# 绕过两个已知问题：
#   1. pnpm 的 ERR_PNPM_IGNORED_BUILDS（esbuild 构建脚本审批）会拦住 tauri 的
#      beforeBuildCommand → 先手动 vite build，再让 tauri 跳过该命令
#   2. tauri 官方 bundle_dmg.sh 依赖 GUI AppleScript，CI/无头环境会挂 →
#      .app 打包成功后用 hdiutil 手动补 DMG
#
# 用法：bash scripts/build-mac.sh          # .app + .dmg
#       bash scripts/build-mac.sh --app-only
set -euo pipefail
cd "$(dirname "$0")/../web"

APP_ONLY=false
[[ "${1:-}" == "--app-only" ]] && APP_ONLY=true

echo "── 1/3 vite build"
PATH="$PWD/node_modules/.bin:$PATH" vite build

echo "── 2/3 tauri bundle (.app)"
PATH="$PWD/node_modules/.bin:$PATH" tauri build --config '{"build":{"beforeBuildCommand":""}}'

APP="src-tauri/target/release/bundle/macos/拾贝.app"
[[ -d "$APP" ]] || { echo "✕ .app 未生成"; exit 1; }
echo "✓ $(du -sh "$APP" | cut -f1)  $APP"

if $APP_ONLY; then exit 0; fi

echo "── 3/3 DMG (hdiutil)"
DMG="src-tauri/target/release/bundle/dmg/拾贝_0.1.0_aarch64.dmg"
STAGE="src-tauri/target/release/bundle/dmgstage"
rm -f "$DMG"; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -sf /Applications "$STAGE/Applications"
hdiutil create -volname "拾贝 Shibei" -srcfolder "$STAGE" -ov -format UDZO "$DMG" 2>/dev/null | tail -1
rm -rf "$STAGE"
[[ -f "$DMG" ]] && echo "✓ $(du -sh "$DMG" | cut -f1)  $DMG"
echo "完成。"
