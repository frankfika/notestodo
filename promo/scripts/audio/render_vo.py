#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NotesToGO · 拾贝 宣传片 —— 旁白批量渲染

用本机 macOS `say`（**不使用任何云端 TTS / 视频模型**）逐句合成旁白，
再用 ffmpeg 统一为 48 kHz / 单声道 PCM16，句首句尾各补 150 ms 静音。

文案来源：promo/STORYBOARD.md 第 3 节（逐字照抄，不改写、不加字、不含符号）。
清单来源：promo/scripts/audio/vo-lines.json

输出：
  promo/audio/vo/vo-NN.wav         48kHz mono
  promo/audio/vo/vo-NN.aiff        原始 say 输出（留档，便于复算）
  promo/audio/vo-manifest.json     duration_s 由 ffprobe 实测

用法：
  PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
  $PY promo/scripts/audio/render_vo.py [--only vo-03,vo-08]
"""
import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np
import wave

SR = 48000
PAD_S = 0.150          # 句首句尾各 150 ms
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LINES = os.path.join(ROOT, "scripts", "audio", "vo-lines.json")
VO_DIR = os.path.join(ROOT, "audio", "vo")
MANIFEST = os.path.join(ROOT, "audio", "vo-manifest.json")

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe_duration(path):
    o = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path])
    return float(o.stdout.strip())


def probe_stream(path):
    o = run([FFPROBE, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate,channels,codec_name",
             "-of", "default=nw=1", path])
    d = {}
    for line in o.stdout.strip().splitlines():
        k, v = line.split("=", 1)
        d[k] = v
    return d


def speech_bounds(path, thresh_db=-60.0):
    """返回 (首个有声样本秒, 末尾有声样本秒, 句首静音秒, 句尾静音秒)。

    给 Lead 做时间轴用：VO 起点 + speech_start_s 才是真正的人声起点。
    """
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    thr = 10 ** (thresh_db / 20.0)
    nz = np.nonzero(np.abs(a) > thr)[0]
    if len(nz) == 0:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    first = nz[0] / sr
    last = nz[-1] / sr
    return (round(first, 4), round(last, 4), round(first, 4),
            round(len(a) / sr - last, 4), round(len(a) / sr, 4))


def render_line(spec):
    vid = spec["id"]
    voice = spec["voice"]
    rate = spec["rate"]
    tmp_aiff = os.path.join(VO_DIR, f"{vid}.aiff")
    out_wav = os.path.join(VO_DIR, f"{vid}.wav")
    os.makedirs(VO_DIR, exist_ok=True)
    # 1) say -> aiff（本机 TTS）
    run(["say", "-v", voice, "-r", str(rate), "-o", tmp_aiff, spec["text"]])
    # 2) aiff -> 48k mono wav，句首句尾各 150ms 静音
    pad_ms = int(round(PAD_S * 1000))
    run([FFMPEG, "-v", "error", "-y", "-i", tmp_aiff,
         "-af", f"adelay={pad_ms}|{pad_ms},apad=pad_dur={PAD_S}",
         "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", out_wav])
    return out_wav


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    only = set(x.strip() for x in a.only.split(",") if x.strip())

    cfg = json.load(open(LINES, encoding="utf-8"))
    voice = cfg["voice"]
    rows = []
    for spec in cfg["lines"]:
        if only and spec["id"] not in only:
            existing = os.path.join(VO_DIR, f"{spec['id']}.wav")
            if os.path.exists(existing):
                sp0, sp1, lead, tail, _ = speech_bounds(existing)
                rows.append({"id": spec["id"], "path": f"vo/{spec['id']}.wav",
                             "duration_s": round(probe_duration(existing), 3),
                             "text": spec["text"], "voice": voice,
                             "rate": spec["rate"], "target_s": spec["target_s"],
                             "speech_start_s": sp0, "speech_end_s": sp1,
                             "lead_silence_s": lead, "tail_silence_s": tail})
            continue
        spec = dict(spec, voice=voice)
        wav = render_line(spec)
        d = probe_duration(wav)
        sp0, sp1, lead, tail, _ = speech_bounds(wav)
        rows.append({"id": spec["id"], "path": f"vo/{spec['id']}.wav",
                     "duration_s": round(d, 3), "text": spec["text"],
                     "voice": voice, "rate": spec["rate"],
                     "target_s": spec["target_s"],
                     "speech_start_s": sp0, "speech_end_s": sp1,
                     "lead_silence_s": lead, "tail_silence_s": tail})
        print(f"{spec['id']}  rate={spec['rate']:3d}  dur={d:6.3f}s  "
              f"target={spec['target_s']:5.1f}s", flush=True)

    # 按 id 排序，保证清单顺序稳定
    rows.sort(key=lambda r: r["id"])
    # 契约要求的四个字段 + 便于 Lead 排时间轴的额外字段（附加，不影响读取）
    manifest = [{"id": r["id"], "path": r["path"], "duration_s": r["duration_s"],
                 "text": r["text"],
                 "speech_start_s": r["speech_start_s"],
                 "speech_end_s": r["speech_end_s"]} for r in rows]
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # 附一份带元数据的工作表，便于 README / vo.md 引用
    meta_path = os.path.join(ROOT, "audio", "vo-render-meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"voice": voice, "sample_rate": SR, "pad_ms": pad_ms_of(),
                   "lines": rows}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\nmanifest -> {MANIFEST}  ({len(manifest)} entries)")


def pad_ms_of():
    return int(round(PAD_S * 1000))


if __name__ == "__main__":
    main()
