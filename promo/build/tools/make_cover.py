#!/usr/bin/env python3
"""
把真实产品截图装进 brand 封面的预留槽位（promo/assets/brand/cover-16x9.png）。

槽位坐标来自 assets/brand/MANIFEST.json 的 screenshot_well（x=912 y=244 w=880 h=495 r=24），
不自己猜数字——brand↔build 的接口真值只有一处。

用法: make_cover.py [--still capture/stills/today.png] [--out build/out/cover-16x9.png]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
BRAND = ROOT / "promo" / "assets" / "brand"


def well_from_manifest() -> dict:
    m = json.loads((BRAND / "MANIFEST.json").read_text(encoding="utf-8"))
    for a in m["assets"]:
        if a.get("file") == "cover-16x9.png":
            return a["screenshot_well"]
    raise SystemExit("MANIFEST 里找不到 cover-16x9.png 的 screenshot_well")


def cover_fit(im: Image.Image, w: int, h: int) -> Image.Image:
    k = max(w / im.size[0], h / im.size[1])
    rs = im.resize((max(1, round(im.size[0] * k)), max(1, round(im.size[1] * k))), Image.LANCZOS)
    return rs.crop(((rs.size[0] - w) // 2, (rs.size[1] - h) // 2,
                    (rs.size[0] - w) // 2 + w, (rs.size[1] - h) // 2 + h))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--still", default=str(ROOT / "promo" / "capture" / "stills" / "today.png"))
    ap.add_argument("--out", default=str(ROOT / "promo" / "build" / "out" / "cover-16x9.png"))
    ap.add_argument("--plain", default=str(ROOT / "promo" / "build" / "out" / "cover-16x9-plain.png"),
                    help="同时导出一张不装截图的纯排版封面")
    args = ap.parse_args()

    base_path = BRAND / "cover-16x9.png"
    base = Image.open(base_path).convert("RGB")
    base.save(args.plain)
    print(f"[cover] 纯排版封面 → {args.plain}  {base.size}")

    well = well_from_manifest()
    x, y, w, h, r = well["x"], well["y"], well["w"], well["h"], well.get("radius", 0)
    still = Image.open(args.still).convert("RGB")
    shot = cover_fit(still, w, h)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    base.paste(shot, (x, y), mask)
    base.save(args.out)
    print(f"[cover] 装入真实截图 {Path(args.still).name} {still.size} → 槽位 "
          f"({x},{y},{w},{h},r{r}) → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
