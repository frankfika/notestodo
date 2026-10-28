#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
promo task-2 复核预览（brand）—— 产物在 promo/assets/brand/_review/，不参与成片。

1) crop-*.png            关键字标放大裁切，用于逐字核对
2) frame-overlay-test.png 把测试图案按 MANIFEST 的 screen_rect 叠进机身框，
                          端到端验证 ffmpeg 合成接口（坐标是否精确、圆角是否被机身盖住）
3) hook-pair.png         两句钩子大字叠在纸底上的实际观感
4) lower-third-on-bg.png 要点条叠在纸底上的实际观感
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "assets", "brand"))
REV = os.path.join(OUT, "_review")
os.makedirs(REV, exist_ok=True)

man = json.load(open(os.path.join(OUT, "MANIFEST.json"), encoding="utf-8"))
by = {e["file"]: e for e in man["assets"]}
FONT = man["fonts"]["resolved_path"]


def op(name):
    return Image.open(os.path.join(OUT, name))


def save(im, name):
    p = os.path.join(REV, name)
    im.save(p, optimize=True)
    print("  ->", os.path.relpath(p, os.path.dirname(OUT)))


print("裁切关键字标：")
save(op("title-card-1920x1080.png").crop((400, 330, 1520, 740)), "crop-title-wordmark.png")
save(op("cover-16x9.png").crop((100, 210, 760, 640)), "crop-cover-wordmark.png")

print("机身框叠加测试：")
test = Image.new("RGB", (1920, 1080), (251, 248, 242))


def pattern(w, h, label):
    """测试图案：四角标记 + 对角线 + 文字，用于检验内屏矩形是否精确。"""
    p = Image.new("RGB", (w, h), (214, 228, 240))
    d = ImageDraw.Draw(p)
    d.rectangle([0, 0, w - 1, h - 1], outline=(20, 20, 20), width=2)
    for i in range(0, w + h, 24):
        d.line([(i, 0), (0, i)], fill=(120, 160, 200), width=1)
    m = 14
    for (cx, cy) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        d.ellipse([cx - m, cy - m, cx + m, cy + m], outline=(200, 30, 30), width=3)
    f = ImageFont.truetype(FONT, 26)
    for txt in (f"{w}x{h}", "CORNER OK"):
        bb = f.getbbox(txt)
        d.text(((w - (bb[2] - bb[0])) / 2, h / 2 - 40), txt, font=f, fill=(20, 20, 20))
        break
    return p


for name in ("phone-frame.png", "tablet-frame.png"):
    e = by[name]
    r = e["screen_rect"]
    test.paste(pattern(r["w"], r["h"], name), (r["x"], r["y"]))
test2 = test.copy()
for name in ("phone-frame.png", "tablet-frame.png"):
    test2.paste(op(name), (0, 0), op(name))
save(test2, "frame-overlay-test-center.png")

# 端到端验证并排配方（整幅平移，保留投影）
recipe = man["frames_side_by_side"]
side = Image.new("RGB", (1920, 1080), (251, 248, 242))
for key, name in (("phone", "phone-frame.png"), ("tablet", "tablet-frame.png")):
    e = by[name]
    s_ = e["screen_rect"]
    step = recipe[key]
    ox, oy = step["png_overlay_at"]
    sx, sy, sw, sh = step["screen_rect_then"]
    assert [sx, sy, sw, sh] == [s_["x"] + ox, s_["y"] + oy, s_["w"], s_["h"]], f"{name} 并排坐标不自洽"
    side.paste(pattern(sw, sh, name), (sx, sy))
    side.paste(op(name), (ox, oy), op(name))
save(side, "frame-overlay-test.png")

print("钩子大字 / 要点条 / 纸底：")
bg = op("bg-paper-1920x1080.png").convert("RGBA")
h1 = Image.alpha_composite(bg, op("hook-lines/hook-1.png"))
h2 = Image.alpha_composite(bg, op("hook-lines/hook-2.png"))
pair = Image.new("RGB", (1920, 1080), (251, 248, 242))
pair.paste(h1.convert("RGB").resize((1920, 540), Image.LANCZOS), (0, 0))
pair.paste(h2.convert("RGB").resize((1920, 540), Image.LANCZOS), (0, 540))
save(pair, "hook-pair.png")
save(Image.alpha_composite(bg, op("lower-third-live.png")).convert("RGB"), "lower-third-on-bg.png")
save(op("end-card-1920x1080.png"), "end-card-preview.png")
save(op("bg-paper-1920x1080.png").crop((0, 0, 640, 400)), "crop-paper-texture.png")
print("完成")
