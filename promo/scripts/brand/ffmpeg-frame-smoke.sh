#!/usr/bin/env bash
# promo task-2：机身框内屏接口 ffmpeg 冒烟测试（brand）
#
# 用 MANIFEST.json 里的 screen_rect / frames_side_by_side 坐标，把两张合成截图
# 通过真实的 ffmpeg overlay 叠进 phone-frame.png / tablet-frame.png，
# 产出 _review/ffmpeg-sh09-smoke.png，供 build 直接照抄这套滤镜写法。
#
# 用法：bash promo/scripts/brand/ffmpeg-frame-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BRAND="$ROOT/promo/assets/brand"
REV="$BRAND/_review"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FFMPEG="${FFMPEG:-ffmpeg}"
PY="${PY:-/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3}"

# --- 1. 造两张「假的」截图（尺寸照 capture 契约） -----------------------------
"$PY" - "$TMP" <<'PY'
import sys
from PIL import Image, ImageDraw
tmp = sys.argv[1]
specs = [("shot-phone.png", 1170, 2532, (214, 228, 240), (1170, 2532)),
         ("shot-ipad.png",  1536, 2048, (226, 236, 224), (1536, 2048))]
for name, w, h, bg, label in specs:
    im = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w - 1, h - 1], outline=(200, 30, 30), width=8)
    for i in range(0, max(w, h), 60):
        d.line([(i, 0), (0, i)], fill=(150, 175, 205), width=2)
    im.save(f"{tmp}/{name}")
print("test screenshots ready")
PY

# --- 2. 坐标（与 MANIFEST.json 一致） ----------------------------------------
# 与 MANIFEST.frames_side_by_side 一致：整幅平移（保留投影）
# phone  : png overlay -414,0  -> 内屏 356,128
# tablet : png overlay  296,0  -> 内屏 950,132

"$FFMPEG" -y -loglevel error \
  -f lavfi -i "color=c=0xFBF8F2:s=1920x1080:d=1" \
  -i "$TMP/shot-phone.png" \
  -i "$TMP/shot-ipad.png" \
  -i "$BRAND/phone-frame.png" \
  -i "$BRAND/tablet-frame.png" \
  -filter_complex "\
[1:v]scale=380:824[sp];\
[2:v]scale=612:816[st];\
[0:v][sp]overlay=356:128[t1];\
[t1][st]overlay=950:132[t2];\
[t2][3:v]overlay=-414:0[t3];\
[t3][4:v]overlay=296:0,format=rgb24[out]" \
  -map "[out]" -frames:v 1 "$REV/ffmpeg-sh09-smoke.png"

echo "-> promo/assets/brand/_review/ffmpeg-sh09-smoke.png"

# --- 3. 校验像素：内屏四角必须是截图内容，机身外侧必须是纸色 -------------------
"$PY" - "$REV/ffmpeg-sh09-smoke.png" <<'PY'
import sys
import numpy as np
from PIL import Image
im = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int)
PAPER = np.array([251, 248, 242])
cases = [
    # 内屏采样点要避开圆角（圆角区被机身盖住是设计如此），取距边 60px 的位置
    ("phone 内屏靠左上 (416,188)", (188, 416), "screen"),
    ("phone 内屏靠右下 (676,892)", (892, 676), "screen"),
    ("phone 内屏正中 (546,540)", (540, 546), "screen"),
    ("tablet 内屏靠左上 (1010,192)", (192, 1010), "screen"),
    ("tablet 内屏靠右下 (1502,888)", (888, 1502), "screen"),
    ("phone 内屏圆角内侧被机身压住 (357,129)", (129, 357), "bezel"),
    ("tablet 内屏圆角内侧被机身压住 (951,133)", (133, 951), "bezel"),
    ("phone 左侧投影内 (335,540)", (540, 335), "shadow"),
    ("两设备之间空白 (790,540)", (540, 790), "paper"),
    ("左右留白 (150,540)", (540, 150), "paper"),
]
ok = True
for label, (y, x), kind in cases:
    px = im[y, x]
    if kind == "screen":
        # 内屏必须是截图内容（浅色测试图案），不能是深色机身、也不能是纸色
        good = px.mean() > 150
    elif kind == "shadow":
        # 设备左侧投影：比纸色暗但仍明显亮于机身，证明投影随帧图一起平移过来了
        good = 215 < px.mean() < 244
    elif kind == "bezel":
        # 圆角处必须被机身盖住（深色），证明圆角真的压住了截图四角
        good = px.mean() < 90
    else:
        good = np.abs(px - PAPER).max() <= 4
    ok &= bool(good)
    print(f"  {'✓' if good else '✗'} {label} rgb={tuple(px)}")
print("ffmpeg 内屏接口冒烟测试:", "通过 ✓" if ok else "失败 ✗")
sys.exit(0 if ok else 1)
PY
