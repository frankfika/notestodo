#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
成片帧「非目视」取证工具 —— 在**没有视觉模型**的情况下，把第 5 节里原本靠人眼看的项目
换成可测量、可复算的判定。

背景：`mcp__MiniMax__understand_image` 额度耗尽，且本会话模型不接受图片输入
（实测 `read_image` 报 "model does not declare image input"）。因此：
  · 禁止出现**报错 toast / 错误态**  → 用 App 自己的 `--danger` 颜色签名做像素检测
  · 禁止出现**鼠标焦点框 / 过期青蓝** → 用饱和蓝色像素签名做像素检测
  · 字幕**位置 / 安全框 / 遮挡**      → 量字幕实心笔画的 bbox，算四周留白
  · 文字内容本身                      → 交给 verify_captions（像素同一性）+ check_spec caps（对照契约）
  · 空状态 / 0 计数 / 加载中          → OCR 词表扫描（**只能当"发现了"的正向证据**，
    OCR 漏认很常见：实测 SH-08 字幕断言直接 MISS，绝不能拿 OCR 的"没找到"当 PASS）

用法
----
  $PY promo/qa/check_frames.py promo/build/_tmp/preview/*.png --layout 16x9
  $PY promo/qa/check_frames.py promo/qa/frames/notestogo-promo-16x9/*.png --layout 16x9 --ocr
  $PY promo/qa/check_frames.py promo/build/_tmp/preview/SH-08.png --ocr --forbidden
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

QA = Path(__file__).resolve().parent
BUILD = QA.parent / "build"
sys.path.insert(0, str(BUILD))

# ── 阈值 ────────────────────────────────────────────────────────────────────
# App 设计令牌（web/src/styles/main.css）转 sRGB；detector 用欧氏距离而非精确相等，
# 以容忍 H.264 编码噪声与抗锯齿。
DANGER_RGB = (183, 73, 63)      # --danger  oklch(55% 0.145 28) → 报错/危险态
WARNING_RGB = (173, 114, 39)    # --warning oklch(60% 0.115 68) → 警示
STALE_BLUE_RGB = (36, 114, 122)  # README:87「青蓝」oklch(51% 0.075 205) → 已过期，不该出现
ACCENT_RGB = (192, 87, 30)      # --accent #C0571E
PAPER_RGB = (251, 248, 242)     # --bg #FBF8F2
INK_RGB = (58, 49, 40)          # --text-1 #3A3128（字幕墨色）

DANGER_TOL = 22                 # 欧氏距离阈值（实测 36 会在暖色真实 UI 上大量误报）
BLUE_MIN_SAT = 55               # 蓝色签名：B 显著高于 R
BLOB_MAX_FRAC = 0.35            # toast/浮层是**紧凑**的：bbox 超过画面 35% 的一律不算 toast
# 实测：真实 UI 截屏里散落的抗锯齿像素会让 0.02% 级别的阈值**每帧都触发**（假报警）。
# 真实 toast 量级 ≈ 400×60px = 24000px ≈ 画面 1.16%，故把报告门槛提到 0.5% 并要求紧凑。
TOAST_PCT_FLAG = 0.5
# 散落的抗锯齿像素会让 bbox 巨大但内部密度极低（实测 ~0.007）；真正的色块区域密度高。
# 故「某个颜色成片出现」的判据 = 占比够大 **且** bbox 内密度够高。
DENSITY_MIN = 0.25

FORBIDDEN_TOKENS = [
    "暂无", "没有要处理", "还没有", "没有匹配", "空空如也", "无数据",
    "加载中", "整理中", "处理中", "等待模型", "上传中", "同步中",
    "失败", "错误", "出错了", "连接失败", "超时", "无法",
    "开始录音前", "点击开始", "首次使用", "欢迎使用",
]


def dilate(n: int) -> str:
    return f"{n}px"


def dist_mask(arr: np.ndarray, rgb: tuple[int, int, int], tol: float) -> np.ndarray:
    d = np.sqrt(((arr.astype(np.int16) - np.array(rgb, dtype=np.int16)) ** 2).sum(axis=2))
    return d <= tol


def bbox_of(mask: np.ndarray) -> dict | None:
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return None
    return {"x": int(xs.min()), "y": int(ys.min()), "x2": int(xs.max()), "y2": int(ys.max()),
            "w": int(xs.max() - xs.min() + 1), "h": int(ys.max() - ys.min() + 1),
            "px": int(len(ys))}


def analyze(path: Path, layout, args) -> dict:
    im = Image.open(path).convert("RGB")
    W, H = im.size
    arr = np.asarray(im)
    n = W * H
    out: dict = {"file": str(path), "w": W, "h": H, "layout": layout.name}

    # ── 1) 颜色签名 ──
    sig = {}
    for name, rgb, tol in (("danger", DANGER_RGB, DANGER_TOL),
                           ("warning", WARNING_RGB, DANGER_TOL),
                           ("stale_blue", STALE_BLUE_RGB, DANGER_TOL)):
        m = dist_mask(arr, rgb, tol)
        bb = bbox_of(m)
        pct = 100.0 * m.sum() / max(1, n)
        density = round(bb["px"] / (bb["w"] * bb["h"]), 4) if bb else 0.0
        compact = bool(bb and bb["w"] <= W * BLOB_MAX_FRAC and bb["h"] <= H * BLOB_MAX_FRAC)
        region = bool(bb and density >= DENSITY_MIN)
        sig[name] = {"pct": round(float(pct), 4), "bbox": bb, "compact_blob": compact,
                     "density": density, "is_region": region,
                     # 紧凑 + 面积够大 + 内部致密，才可能是 toast/浮层/大色块
                     "toast_suspect": bool(compact and region and pct > TOAST_PCT_FLAG)}
    # 广义饱和蓝（Chromium 焦点框 / 蓝色高亮）
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    blue = (b - r > BLUE_MIN_SAT) & (b - g > 20) & (b > 90)
    bbb = bbox_of(blue)
    blue_pct = 100.0 * blue.sum() / max(1, n)
    blue_compact = bool(bbb and bbb["w"] <= W * BLOB_MAX_FRAC and bbb["h"] <= H * BLOB_MAX_FRAC)
    # 注意：细长焦点框（约 200×3px ≈ 0.03%）**低于本检测器可靠门槛**，检出不了 ≠ 没有。
    blue_density = round(bbb["px"] / (bbb["w"] * bbb["h"]), 4) if bbb else 0.0
    sig["saturated_blue"] = {"pct": round(float(blue_pct), 4), "bbox": bbb,
                             "compact_blob": blue_compact, "density": blue_density,
                             "is_region": bool(bbb and blue_density >= DENSITY_MIN),
                             "toast_suspect": bool(blue_compact and blue_density >= DENSITY_MIN
                                                   and blue_pct > TOAST_PCT_FLAG),
                             "note": "细焦点框低于可靠检出阈值，只能作正向证据"}
    sig["accent"] = {"pct": round(float(100.0 * dist_mask(arr, ACCENT_RGB, 40).sum() / n), 4)}
    sig["paper"] = {"pct": round(float(100.0 * dist_mask(arr, PAPER_RGB, 6).sum() / n), 2)}
    out["signals"] = sig

    # ── 2) 字幕带 bbox 与安全框 ──
    cap_h_guess = int(layout.cap_size * 1.75)
    y0 = H - layout.cap_bottom - cap_h_guess - 10
    y1 = min(H, H - layout.cap_bottom + 10)
    y0 = max(0, y0)
    band = arr[y0:y1]
    lum = band.mean(axis=2)
    ink = lum < 150                                   # 墨色实心笔画
    bb = bbox_of(ink)
    if bb:
        bb["x"] = int(bb["x"]); bb["y"] = int(bb["y"]) + y0
        bb["y2"] = int(bb["y2"]) + y0
        margins = {"left": bb["x"], "right": W - bb["x2"] - 1,
                   "top": bb["y"], "bottom": H - bb["y2"] - 1}
        bb["margins"] = margins
        bb["margins_pct"] = {"left": round(100 * margins["left"] / W, 2),
                             "right": round(100 * margins["right"] / W, 2),
                             "bottom": round(100 * margins["bottom"] / H, 2)}
        # 与 render.py 的落位公式对账：x=(W-w)//2, y=H-cap_bottom-h
        out["safe_frame"] = {
            "bottom_min_px": margins["bottom"], "left_min_px": margins["left"],
            "right_min_px": margins["right"],
            "vs_contract_96px": "OK" if min(margins["left"], margins["right"]) >= 96 and
                                      margins["bottom"] >= 96 else "BELOW_96",
            "vs_action_safe_5pct": "OK" if min(margins["left"], margins["right"]) >= 0.05 * W and
                                          margins["bottom"] >= 0.05 * H else "BELOW_5PCT",
        }
    out["caption_band"] = {"band_y": [y0, y1], "ink_bbox": bb}

    # ── 3) 溢出检测：画面最外 4px 是否被笔画切到（字幕/文字被裁） ──
    edge = {"left": int((arr[:, :2].mean(axis=2) < 150).sum()),
            "right": int((arr[:, -2:].mean(axis=2) < 150).sum()),
            "top": int((arr[:2, :].mean(axis=2) < 150).sum()),
            "bottom": int((arr[-2:, :].mean(axis=2) < 150).sum())}
    out["edge_ink_px"] = edge
    return out


def ocr_tokens(path: Path, band: tuple[float, float] | None = None) -> list[str]:
    cmd = [sys.executable, str(BUILD / "tools" / "ocr.py"), str(path),
           "--min-conf", "35"]
    if band:
        cmd += ["--band", f"{band[0]},{band[1]}"]
    p = subprocess.run(cmd, capture_output=True, text=True)
    toks = []
    for line in p.stdout.splitlines():
        m = re.search(r"conf=\s*[\d.]+\s+(.+)$", line)
        if m:
            toks.append(m.group(1).strip())
    return toks


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--layout", default="16x9", choices=["16x9", "9x16"])
    ap.add_argument("--json-out", default=str(QA / "results" / "_frames_forensics.json"))
    ap.add_argument("--ocr", action="store_true", help="附加 OCR 词表扫描（仅正向证据）")
    ap.add_argument("--band", default="0.80,1.0", help="OCR 字幕带区间，默认 0.80,1.0")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--strict", action="store_true",
                    help="把危险色/饱和蓝占比超阈值判为 FAIL（默认只报告）")
    args = ap.parse_args()

    from video import LAYOUTS  # noqa: E402
    layout = LAYOUTS[args.layout]

    files: list[Path] = []
    for pat in args.images:
        g = sorted(glob.glob(pat))
        files.extend(Path(x) for x in (g or [pat]))

    rows, fails = [], []
    for f in files:
        r = analyze(f, layout, args)
        if args.ocr:
            band = tuple(float(x) for x in args.band.split(","))
            toks = ocr_tokens(f, band)
            joined = re.sub(r"\s+", "", "".join(toks))
            hits = [t for t in FORBIDDEN_TOKENS if t in joined]
            r["ocr_tokens"] = toks
            r["ocr_forbidden_hits"] = hits
        rows.append(r)
        if r["signals"]["danger"]["toast_suspect"]:
            fails.append((f.name, "danger-toast-suspect", r["signals"]["danger"]))
        if r["signals"]["saturated_blue"]["toast_suspect"]:
            fails.append((f.name, "blue-focus-ring-suspect", r["signals"]["saturated_blue"]))
        sb = r["signals"]["stale_blue"]
        if sb["pct"] > TOAST_PCT_FLAG and sb["is_region"]:
            fails.append((f.name, "STALE_BLUE(README:87 青蓝)成片出现", sb))
        if args.ocr and r.get("ocr_forbidden_hits"):
            fails.append((f.name, "ocr_forbidden(正向命中)", r["ocr_forbidden_hits"]))

    Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json_out).write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    if not args.quiet:
        print(f"{'文件':34s} {'尺寸':>10s} {'危险红%':>8s} {'饱和蓝%':>8s} {'橘%':>7s} {'纸%':>7s} "
              f"{'字幕底边距':>10s} {'字幕左边距':>10s}")
        for r in rows:
            bb = r["caption_band"]["ink_bbox"]
            mg = bb["margins"] if bb else {}
            print(f"{Path(r['file']).name:34s} {str((r['w'], r['h'])):>10s} "
                  f"{r['signals']['danger']['pct']:8.4f} {r['signals']['saturated_blue']['pct']:8.4f} "
                  f"{r['signals']['accent']['pct']:7.3f} {r['signals']['paper']['pct']:7.2f} "
                  f"{str(mg.get('bottom', '-')):>10s} {str(mg.get('left', '-')):>10s}")
        print()
        print(f"帧数 {len(rows)}；可疑项 {len(fails)} 条 → "
              f"{'FAIL' if (args.strict and fails) else ('WARN' if fails else 'PASS')}")
        for name, kind, val in fails[:40]:
            print(f"  ⚠️  {name}  {kind}: {json.dumps(val, ensure_ascii=False)[:160]}")
        print()
        print("说明：危险红/饱和蓝只做**正向**证据（检出即需处理）；未检出**不等于**画面干净")
        print("      ——空状态/0 计数/加载中/浮层这类没有固定颜色签名，必须靠人眼或 OCR 正向命中。")
        print(f"JSON: {args.json_out}")
    return 1 if (args.strict and fails) else 0


if __name__ == "__main__":
    sys.exit(main())
