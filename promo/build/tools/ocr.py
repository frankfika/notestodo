#!/usr/bin/env python3
"""
NotesToGO 宣传片 · 本地 OCR 工具（tesseract chi_sim+eng，离线，无任何云端调用）

用途：逐字核对成片里的字幕/卡片文案、验证文字是否落在安全框内、是否被裁切。
产出 TSV 式的「x y w h conf 文字」，坐标已转为**左上原点、像素**。

用法：
  ocr.py <图片...>                      # 全画面识别
  ocr.py --band 0.80,1.0 <图片...>      # 只识别纵向 80%~100% 的横条（字幕带）
  ocr.py --expect "开会时你在讨论" <图片>  # 断言某段文字出现（子串、忽略空白），返回码 0/1
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import subprocess
import sys
from pathlib import Path

LANGS = "chi_sim+eng"


def prep(img: Path, scale: float = 2.0, band: tuple[float, float] | None = None):
    """放大 + 可选裁横条：1920x1080 上 40px 的中文字号对 tesseract 偏小，
    2 倍 LANCZOS 放大后中文识别率显著提升（坐标按 scale 折算回原图）。"""
    from PIL import Image
    im = Image.open(img).convert("RGB")
    W, H = im.size
    yoff = 0
    if band:
        y0, y1 = band
        box = (0, int(H * y0), W, int(H * y1))
        im = im.crop(box)
        yoff = box[1]
    if scale != 1.0:
        im = im.resize((int(im.size[0] * scale), int(im.size[1] * scale)), Image.LANCZOS)
    tmpdir = Path(__file__).resolve().parents[1] / "_tmp"   # /tmp 是符号链接，leptonica 会打不开
    tmpdir.mkdir(parents=True, exist_ok=True)
    out = tmpdir / "ocr-prep.png"
    im.save(out)
    return out, scale, yoff


def run_tesseract(img: Path, scale: float = 1.0, yoff: int = 0) -> list[dict]:
    cmd = ["tesseract", str(img), "stdout", "-l", LANGS, "--psm", "3", "tsv"]
    r = subprocess.run(cmd, capture_output=True)          # bytes：tesseract 的 stderr 不保证 UTF-8
    err = (r.stderr or b"").decode("utf-8", "replace")
    if r.returncode != 0:
        raise RuntimeError(f"tesseract 失败 rc={r.returncode}: {err.strip()[:400]}")
    out = (r.stdout or b"").decode("utf-8", "replace")
    rows = []
    for row in csv.DictReader(io.StringIO(out), delimiter="\t"):
        try:
            txt = (row.get("text") or "").strip()
            conf = float(row.get("conf") or -1)
        except (TypeError, ValueError):
            continue
        if not txt or conf < 0:
            continue
        rows.append({"x": int(int(row["left"]) / scale), "y": int(int(row["top"]) / scale) + yoff,
                     "w": int(int(row["width"]) / scale), "h": int(int(row["height"]) / scale),
                     "conf": conf, "text": txt})
    # 合并成行：同一行内按 x 排序拼接
    rows.sort(key=lambda r: (r["y"] // 12, r["x"]))
    lines: list[dict] = []
    for r in rows:
        if lines and abs(r["y"] - lines[-1]["y"]) <= max(10, r["h"] * 0.6):
            g = lines[-1]
            g["text"] += r["text"]
            g["x2"] = max(g["x2"], r["x"] + r["w"])
            g["y2"] = max(g["y2"], r["y"] + r["h"])
            g["conf"] = min(g["conf"], r["conf"])
        else:
            lines.append({"x": r["x"], "y": r["y"], "x2": r["x"] + r["w"],
                          "y2": r["y"] + r["h"], "conf": r["conf"], "text": r["text"]})
    for g in lines:
        g["w"] = g["x2"] - g["x"]
        g["h"] = g["y2"] - g["y"]
    return lines


def crop_band(img: Path, y0: float, y1: float, out: Path) -> Path:
    from PIL import Image
    im = Image.open(img)
    W, H = im.size
    im.crop((0, int(H * y0), W, int(H * y1))).save(out)
    return out


def norm(s: str) -> str:
    return re.sub(r"[\s，。、·：；！？,.:;!?\-—－()（）\"'“”「」【】]", "", s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--band", default=None, help="只识别纵向区间，如 0.80,1.0（字幕带）")
    ap.add_argument("--expect", action="append", default=[], help="断言出现的文字（可多次）")
    ap.add_argument("--min-conf", type=float, default=30.0)
    ap.add_argument("--scale", type=float, default=2.0, help="识别前放大倍数（默认 2x）")
    args = ap.parse_args()

    tmp = Path("/tmp/shibei-ocr-band.png")
    ok = True
    for p in args.images:
        path = Path(p)
        band = tuple(float(x) for x in args.band.split(",")) if args.band else None
        target, scale, yoff = prep(path, scale=args.scale, band=band)
        lines = run_tesseract(target, scale=scale, yoff=yoff)
        print(f"### {path}  ({len(lines)} 行)")
        for g in lines:
            if g["conf"] < args.min_conf:
                continue
            print(f"  y={g['y']:5d} x={g['x']:5d} w={g['w']:5d} h={g['h']:3d} "
                  f"conf={g['conf']:5.1f}  {g['text']}")
        if args.expect:
            allt = norm("".join(g["text"] for g in lines))
            for e in args.expect:
                hit = norm(e) in allt
                print(f"  [{'OK ' if hit else 'MISS'}] 期望文字: {e}")
                ok = ok and hit
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
