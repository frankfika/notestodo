#!/usr/bin/env python3
"""
生成「无旁白」变体：**复用已成片的视频流（-c:v copy，比特级相同）**，只把音轨换成纯配乐。
比重新渲染一遍视频更快，也保证两个版本的画面完全一致、不会出现"两个版本字幕位置不一样"。
"""
from __future__ import annotations
import argparse, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render as R  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=str(R.OUT / "notestogo-promo-16x9.mp4"))
    ap.add_argument("--out", default=str(R.OUT / "notestogo-promo-16x9-novo.mp4"))
    args = ap.parse_args()
    base = Path(args.base)
    if not base.exists():
        raise SystemExit(f"找不到底片 {base}")
    meta = R.load_vo_meta()
    tl = R.build_timeline(R.TARGET_16x9, {k: v["dur"] for k, v in meta.items()},
                          R.LAYOUTS["16x9"], meta)
    mix = R.build_mix(tl, with_vo=False, out_path=R.TMP / "mix-novo.wav")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(base), "-i", str(mix),
           "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
           "-movflags", "+faststart", "-shortest", args.out]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr.decode("utf-8", "replace")[-800:])
    print(f"[novo] 视频流直接复制，音轨换为纯配乐 → {args.out}")
    print(f"[novo] {R.probe_audio(Path(args.out))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
