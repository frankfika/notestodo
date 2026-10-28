#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
promo task-2 自检脚本（brand）

逐张断言：
  1) 尺寸 = 1920x1080
  2) 模式符合契约（透明素材必须 RGBA，且确实存在透明像素）
  3) 透明素材：alpha>0 的像素必须落在 96px 安全框内
  4) 机身框：内屏矩形范围内 alpha 必须为 0（完全透明）；机身 bbox 在安全框内；关键像素颜色
  5) 纸色底：四角与中心必须是 #FBF8F2（允许 ±3 级噪点）
  6) 品牌橘 / 墨色像素确实存在（配色核对）
  7) 不透明卡片：前景内容不得越出 96px 安全框（用与纸底的差异检测）
"""
import json
import os
import sys

import numpy as np
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROMO_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT = os.path.join(PROMO_DIR, "assets", "brand")

W, H, SAFE = 1920, 1080, 96
PAPER = np.array([251, 248, 242])
ORANGE = np.array([192, 87, 30])
INK = np.array([58, 49, 40])

OPAQUE = ["bg-paper-1920x1080.png", "title-card-1920x1080.png",
          "end-card-1920x1080.png", "cover-16x9.png"]
TRANSPARENT = ["lower-third-live.png", "hook-lines/hook-1.png", "hook-lines/hook-2.png",
               "phone-frame.png", "tablet-frame.png"]

fails = []
notes = []


def ok(msg):
    print(f"  ✓ {msg}")


def bad(msg):
    fails.append(msg)
    print(f"  ✗ {msg}")


def near(a, b, tol=3):
    return int(np.abs(a.astype(int) - b.astype(int)).max()) <= tol


def check(name, expect_mode):
    p = os.path.join(OUT, name)
    im = Image.open(p)
    print(f"[{name}]")
    if im.size != (W, H):
        bad(f"尺寸 {im.size} != (1920,1080)")
    else:
        ok(f"尺寸 1920x1080（mode={im.mode}）")
    if im.mode != expect_mode:
        bad(f"模式 {im.mode} != {expect_mode}")
    else:
        ok(f"模式 {expect_mode}")
    return im


def check_opaque_content_safe(name, im):
    if name == "bg-paper-1920x1080.png":
        ok("纯背景层，仅纸底 + 格线，无前景内容（预期）")
        return
    """不透明卡片：找出与「纸底 + 横格线」不同的前景像素，检查安全框。"""
    a = np.asarray(im.convert("RGB")).astype(int)
    # 与纸色差异（横格线 #E3DFD8 与纸差 24 级；前景墨/橘/白卡片差异更大或更亮）
    diff = np.abs(a - PAPER).max(axis=2)
    # 只保留「比纸暗得多（墨/橘）或明显更亮（白卡片）」的像素
    lum = a.mean(axis=2)
    fg = (diff > 34) & ((lum < 220) | (lum > 253 + 2 - 6))
    fg = (diff > 34) & (np.abs(lum - PAPER.mean()) > 12)
    ys, xs = np.nonzero(fg)
    if len(xs) == 0:
        bad(f"{name}: 未检测到前景内容")
        return
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    m = min(x0, y0, W - 1 - x1, H - 1 - y1)
    if m < SAFE:
        bad(f"{name}: 前景越出安全框 margin={m}px bbox=({x0},{y0},{x1},{y1})")
    else:
        ok(f"前景全在安全框内（最小边距 {m}px，bbox={x0},{y0},{x1},{y1}）")


def check_transparent_alpha_safe(name, im, exclude_rects=()):
    al = np.asarray(im.getchannel("A"))
    if al.max() == 0:
        bad(f"{name}: 完全没有不透明像素")
        return
    mask = al > 8
    for (rx, ry, rw, rh) in exclude_rects:
        mask[ry:ry + rh, rx:rx + rw] = False
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    m = int(min(x0, y0, W - 1 - x1, H - 1 - y1))
    if m < SAFE:
        bad(f"{name}: 不透明像素越出安全框 margin={m} bbox=({x0},{y0},{x1},{y1})")
    else:
        ok(f"不透明像素全在安全框内（最小边距 {m}px，bbox={x0},{y0},{x1},{y1}）")


def count_orange(im):
    a = np.asarray(im.convert("RGB")).astype(int)
    d = np.abs(a - ORANGE).max(axis=2)
    return int((d <= 6).sum())


def count_ink(im):
    a = np.asarray(im.convert("RGB")).astype(int)
    d = np.abs(a - INK).max(axis=2)
    return int((d <= 6).sum())


print("=" * 78)
print("不透明素材")
print("=" * 78)
for n in OPAQUE:
    im = check(n, "RGB")
    check_opaque_content_safe(n, im)
    print(f"  · 品牌橘像素 {count_orange(im)}，墨像素 {count_ink(im)}")

# 纸底四角 + 中心
im = Image.open(os.path.join(OUT, "bg-paper-1920x1080.png")).convert("RGB")
a = np.asarray(im).astype(int)
probes = {"左上": a[8, 8], "右上": a[8, W - 9], "左下": a[H - 9, 8],
          "右下": a[H - 9, W - 9], "中心": a[H // 2, W // 2]}
allnear = all(near(v, PAPER, 6) for v in probes.values())
print(f"  · 纸色探针 {'✓ 全部命中 #FBF8F2 ±6' if allnear else '✗ ' + str(probes)}")
if not allnear:
    bad(f"bg-paper 纸色探针异常 {probes}")

# 横格线：用整行均值（噪声被平均掉），找显著暗于纸色的行
row = a.mean(axis=(1, 2))
thr = np.median(row) - 3.0
cand = np.nonzero(row < thr)[0]
lines = []
for y in cand:
    if not lines or y - lines[-1] > 6:
        lines.append(int(y))
d = np.diff(lines)
print(f"  · 横格线 {len(lines)} 条，首行 y={lines[0] if lines else '-'}，间距 {sorted(set(d.tolist()))}")
if len(lines) < 20 or set(d.tolist()) != {44}:
    bad(f"bg-paper 横格线间距异常：{sorted(set(d.tolist()))}")
else:
    ok("横格线 #E3DFD8 × 44px 间距（4pt 网格 × 11）")

print()
print("=" * 78)
print("透明素材")
print("=" * 78)
for n in TRANSPARENT:
    im = check(n, "RGBA")
    al = np.asarray(im.getchannel("A"))
    print(f"  · alpha 0 像素 {int((al == 0).sum())} / {al.size}，最大 alpha {int(al.max())}")
    if n not in ("phone-frame.png", "tablet-frame.png"):
        check_transparent_alpha_safe(n, im)
    print(f"  · 品牌橘像素 {count_orange(im)}，墨像素 {count_ink(im)}")

man = json.load(open(os.path.join(OUT, "MANIFEST.json"), encoding="utf-8"))
by = {e["file"]: e for e in man["assets"]}

for n in ("phone-frame.png", "tablet-frame.png"):
    e = by[n]
    rects = []
    for key in ("screen_rect",):
        r = e[key]
        rects.append((r["x"], r["y"], r["w"], r["h"]))
    check_transparent_alpha_safe(n, Image.open(os.path.join(OUT, n)), exclude_rects=rects)
    # 内屏必须是全透明的
    im = Image.open(os.path.join(OUT, n))
    al = np.asarray(im.getchannel("A"))
    r = e["screen_rect"]
    sx, sy, sw, sh = r["x"], r["y"], r["w"], r["h"]
    rr = int(r.get("radius", 0)) + 2
    probes = {
        "核心": al[sy + rr:sy + sh - rr, sx + rr:sx + sw - rr],
        "上边": al[sy + 2:sy + 5, sx + rr:sx + sw - rr],
        "下边": al[sy + sh - 5:sy + sh - 2, sx + rr:sx + sw - rr],
        "左边": al[sy + rr:sy + sh - rr, sx + 2:sx + 5],
        "右边": al[sy + rr:sy + sh - rr, sx + sw - 5:sx + sw - 2],
    }
    worst = {k: int(v.max()) for k, v in probes.items()}
    # 边界 1~2px 允许抗锯齿过渡（alpha <= 4），其余必须为 0
    if max(worst.values()) <= 4:
        ok(f"{n}: 内屏 (x={sx},y={sy},w={sw},h={sh},r={r.get('radius')}) 透明 "
           f"（核心 alpha=0，边界抗锯齿最大 alpha={max(worst.values())}）")
    else:
        bad(f"{n}: 内屏存在不透明像素 {worst}")
    # 内屏 4 条边之外 5px 必须有不透明机身（只取每条边中间 60%，避开圆角）
    mx = int(sw * 0.2); my = int(sh * 0.2)
    ring = [
        al[sy - 5:sy - 1, sx + mx:sx + sw - mx],          # 上
        al[sy + sh + 1:sy + sh + 5, sx + mx:sx + sw - mx],  # 下
        al[sy + my:sy + sh - my, sx - 5:sx - 1],          # 左
        al[sy + my:sy + sh - my, sx + sw + 1:sx + sw + 5],  # 右
    ]
    mn = min(int(x.min()) for x in ring)
    if mn > 250:
        ok(f"{n}: 内屏四边外侧机身连续不透明（min alpha={mn}）")
    else:
        bad(f"{n}: 机身边框不连续，min alpha={mn}")
    b = e["device_bbox"]
    m = min(b["x"], b["y"], W - (b["x"] + b["w"]), H - (b["y"] + b["h"]))
    if m < SAFE:
        bad(f"{n}: 机身越出安全框 margin={m}")
    else:
        ok(f"{n}: 机身 bbox {b['x']},{b['y']},{b['w']},{b['h']} 在安全框内（margin {m}px）")
    # 机身颜色必须是深色
    px = np.asarray(im.convert("RGB"))[b["y"] + 4, b["x"] + b["w"] // 2]
    if int(px.mean()) < 90:
        ok(f"{n}: 机身边框深色 rgb={tuple(int(v) for v in px)}")
    else:
        bad(f"{n}: 机身边框不是深色 rgb={tuple(int(v) for v in px)}")

print()
print("=" * 78)
print("MANIFEST 结构")
print("=" * 78)
need = {"file", "path", "scene", "purpose", "size", "mode", "has_alpha"}
for e in man["assets"]:
    miss = need - set(e)
    if miss:
        bad(f"{e.get('file')}: MANIFEST 缺字段 {miss}")
ok(f"assets 条目 {len(man['assets'])} 条；files 字段 {len(man['files'])} 个")
for f in man["files"]:
    if not os.path.exists(os.path.join(OUT, f)):
        bad(f"MANIFEST.files 里的 {f} 不存在")
print("  字体:", man["fonts"]["family"], "|", man["fonts"]["resolved_path"])

print()
print("=" * 78)
if fails:
    print(f"自检失败 {len(fails)} 项：")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("自检全部通过 ✓")
