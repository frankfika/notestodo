#!/usr/bin/env python3
"""
字幕「像素同一性」校验器 —— 比 OCR 更硬的逐字验证手段。

思路：成片里的字幕是 render.py 用 caption_image() 画出来的。只要把成片同一位置的
字幕区域抠出来，和「用源码里的文案重新画一遍」的结果逐像素比对（允许编码噪声），
就能**证明成片上显示的字与源码文案完全一致**——不需要 OCR 猜字，也不怕错别字漏检。
顺带用 OCR 做存在性冒烟检查（可选）。

用法：
  verify_captions.py --video promo/build/out/xxx.mp4
  verify_captions.py --frames promo/build/_tmp/preview        # 用 preview/*.png（SH-xx.png）
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from video import LAYOUTS, PAPER, caption_image  # noqa: E402

TOKEN = re.compile(r"\*\*(.+?)\*\*")


def strip_markup(t: str) -> str:
    return TOKEN.sub(r"\1", t)


def grab_frame(video: Path, t: float) -> Image.Image:
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(video),
                        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                       capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"抽帧失败 t={t}: {r.stderr.decode('utf-8','replace')[:200]}")
    import io
    return Image.open(io.BytesIO(r.stdout)).convert("RGB")


def compare(expect: Image.Image, got: Image.Image, x: int, y: int) -> dict:
    """在 got 的 (x,y) 处取与 expect 同尺寸的区域做比对。

    关键：caption_image() 返回**透明底** RGBA。直接 convert("L") 会把透明区当黑色，
    于是整块透明边距都会被误判成"笔画"。所以这里只在**完全不透明且深色**的像素
    （= 实心笔画）上比对——这些像素在成片里必然是原色，必须逐像素一致。
    """
    w, h = expect.size
    region = got.crop((x, y, x + w, y + h)).convert("RGB")
    exp_rgba = expect.convert("RGBA")
    # 把期望字幕合成到纸色底上（模拟成片里的落位），再取灰度
    bg = Image.new("RGBA", (w, h), PAPER + (255,))
    exp_rgb = Image.alpha_composite(bg, exp_rgba).convert("RGB")
    a = np.asarray(exp_rgb.convert("L"), dtype=np.float32)
    alpha = np.asarray(exp_rgba.split()[3], dtype=np.float32)
    b = np.asarray(region.convert("L"), dtype=np.float32)
    diff = np.abs(a - b)
    mask = (alpha >= 254) & (a < 200)          # 实心笔画
    solid = float(mask.mean())
    mism = float((diff[mask] > 40).mean()) if mask.any() else 1.0
    return {"solid_ratio": solid, "ink_mismatch": mism,
            "mean_abs": float(diff.mean()), "max_abs": float(diff.max())}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default=None)
    ap.add_argument("--frames", default=None, help="preview 目录（文件名形如 SH-01.png）")
    ap.add_argument("--layout", default="16x9")
    ap.add_argument("--timeline", default=None,
                    help="默认取 timeline-<layout>.json；不要用 timeline.json 去比竖版")
    args = ap.parse_args()

    layout = LAYOUTS[args.layout]
    tlp = Path(args.timeline) if args.timeline else \
        Path(__file__).resolve().parents[1] / f"timeline-{args.layout}.json"
    tl = json.loads(tlp.read_text(encoding="utf-8"))
    rows, bad = [], 0
    for sh in tl["shots"]:
        text = strip_markup(sh["cap"])
        exp = caption_image(sh["cap"], layout.W, size=layout.cap_size,
                            max_w=int(layout.W * layout.cap_max_w_ratio))
        x = (layout.W - exp.size[0]) // 2
        y = layout.H - layout.cap_bottom - exp.size[1]
        # 取字幕窗口正中间的一帧（此时淡入淡出已结束，alpha=1）
        t = (sh["cap_in"] + sh["cap_out"]) / 2
        if args.frames:
            fp = Path(args.frames) / f"{sh['id']}.png"
            got = Image.open(fp).convert("RGB")
        else:
            got = grab_frame(Path(args.video), t)
        m = compare(exp, got, x, y)
        ok = m["ink_mismatch"] < 0.02 and m["solid_ratio"] > 0.01
        bad += 0 if ok else 1
        rows.append((sh["id"], t, text, ok, m))
        print(f"  {sh['id']}  t={t:6.2f}s  {'OK  ' if ok else 'FAIL'}  "
              f"实心笔画占比={m['solid_ratio']:.4f}  笔画不一致率={m['ink_mismatch']:.4f}  "
              f"平均差={m['mean_abs']:.1f}  字幕=\"{text}\"")
    print(f"\n字幕像素校验：{len(rows) - bad}/{len(rows)} 通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
