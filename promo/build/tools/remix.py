#!/usr/bin/env python3
"""
只重做音轨：复用已成片的视频流（-c:v copy，画面比特级不变），按画幅重新组混音再封装。

为什么单独做这一步：混音改动不需要重渲 2700 帧；而且 -c:v copy 能保证「改了音频之后
画面一字未动」，避免"重渲一遍导致画面也变了"这种不可控的差异。

用法:
  remix.py --layout 16x9                       # 旁白版
  remix.py --layout 9x16
  remix.py --layout 16x9 --no-vo               # 纯配乐版（输出 -novo）
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render as R  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", default="16x9", choices=["16x9", "9x16"])
    ap.add_argument("--no-vo", action="store_true")
    ap.add_argument("--video", default=None,
                    help="指定视频源。默认用已成片；指向 _tmp/video-<layout>.mp4 可救回"
                         "被 -shortest 剪掉的尾帧（中间产物保有全部帧）")
    args = ap.parse_args()

    layout = R.LAYOUTS[args.layout]
    suffix = "-novo" if args.no_vo else ""
    out = R.OUT / f"notestogo-promo-{args.layout}{suffix}.mp4"
    base = Path(args.video) if args.video else out
    if not base.exists():
        raise SystemExit(f"找不到视频源 {base}；请先跑 render.py --layout {args.layout}")

    meta = R.load_vo_meta()
    use = ([s for s in R.SHOTS if s.id in R.VERTICAL_IDS] if layout.name == "9x16" else R.SHOTS)
    tl = R.build_timeline(R.TARGET_9x16 if layout.name == "9x16" else R.TARGET_16x9,
                          {k: v["dur"] for k, v in meta.items()}, layout, meta, use)
    mix = R.build_mix(tl, with_vo=not args.no_vo,
                      out_path=R.TMP / f"mix-remix-{args.layout}{suffix}.wav")

    tmp_out = out.with_suffix(".remix.mp4")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(base), "-i", str(mix),
           "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
           "-movflags", "+faststart", "-shortest", str(tmp_out)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr.decode("utf-8", "replace")[-800:])
    tmp_out.replace(out)
    print(f"[remix] 画面 -c:v copy 未重编 → {out}")
    print(f"[remix] {R.probe_audio(out)}")
    if not args.no_vo:
        v1 = R.AUDIO / "vo" / f"{tl['shots'][0]['vo']}.wav"
        ncc, at = R.ncc_with(out, v1)
        print(f"[remix] 成片旁白自检 {v1.name} ncc={ncc:.4f} @ {at:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
