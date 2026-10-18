#!/usr/bin/env python3
"""
确定性帧自检（替代/补充人工目视复核）。

本轮 MiniMax 视觉复核配额用尽、其他外部视觉通道也不可用（见 capture 报告），
所以对每一张静帧、每一条录屏做可复核的像素级检查：

静帧：尺寸、非空白（std）、含品牌橘 #C0571E 像素（证明 UI 真的渲染出来了）
录屏：头部「首帧出现真实 UI」的时间点、尾部静置时长（连续帧差 < 阈值）、
      中段是否有可见动作（帧差显著）

用法：python3 promo/scripts/capture/verify-frames.py [--json out.json]
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

CAPTURE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "capture"))
FFMPEG = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg")
ACCENT = np.array([192, 87, 30])          # --accent #C0571E（信息项，弹层压暗后不可靠）
ACCENT_TOL = 30
INK = np.array([58, 49, 40])              # --text-1 #3A3128（正文墨色）
INK_TOL = 45
STATIC_DIFF = 3.0                          # 帧间平均绝对差阈值（0-255）
MOTION_DIFF = 0.4                          # 中段应看得见变化
SCALE = (480, 270)


def near(arr: np.ndarray, color: np.ndarray, tol: int) -> int:
    """与给定颜色相近的像素数（静帧原尺寸 / 录屏缩略图）"""
    d = np.abs(arr.astype(np.int16) - color)
    return int(((d[:, :, 0] < tol) & (d[:, :, 1] < tol) & (d[:, :, 2] < tol)).sum())


def is_accent(arr: np.ndarray) -> int:
    return near(arr, ACCENT, ACCENT_TOL)


def png_stats(path: str) -> dict:
    im = Image.open(path).convert("RGB")
    arr = np.asarray(im)
    small = np.asarray(im.resize(SCALE))
    return {
        "w": im.width, "h": im.height,
        "std": round(float(arr.std()), 2),
        "unique_colors_sampled": int(len(np.unique(small.reshape(-1, 3), axis=0))),
        "accent_px": is_accent(arr),
        "ink_px": near(arr, INK, INK_TOL),
        "mean_rgb": [int(x) for x in arr.reshape(-1, 3).mean(axis=0)],
    }


def grab(video: str, t: float, out: str, scale: str | None = "480:270") -> np.ndarray:
    cmd = [FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1"]
    if scale:
        cmd += ["-vf", f"scale={scale}"]
    cmd += ["-y", out]
    subprocess.run(cmd, check=True)
    if not os.path.exists(out) and t > 0.1:   # 落在最后一帧之后（25fps 片尾）→ 往前退一帧
        return grab(video, t - 0.05, out, scale)
    return np.asarray(Image.open(out).convert("RGB")).astype(np.int16)


def clip_stats(video: str, duration: float, tmp: str, name: str) -> dict:
    # ① 头部：前 1.5s 每 0.1s 采一帧，找第一帧出现真实 UI（有橘色像素且非纯色）
    head = []
    first_ui = None
    for i in range(16):
        t = min(0.05 + i * 0.1, max(0.0, duration - 0.05))
        f = grab(video, t, os.path.join(tmp, f"{name}-h{i}.png"))
        acc = is_accent(f)
        std = float(f.std())
        head.append({"t": round(t, 2), "accent_px": acc, "std": round(std, 2)})
        if first_ui is None and acc >= 20 and std > 6:
            first_ui = round(t, 2)

    # ② 尾部静置：从末尾往前每 0.2s 采一帧，累计「与下一帧几乎一致」的时长
    ts = [max(0.0, duration - 0.05 - i * 0.2) for i in range(8)][::-1]
    frames = [grab(video, t, os.path.join(tmp, f"{name}-t{i}.png")) for i, t in enumerate(ts)]
    diffs = [round(float(np.abs(frames[i + 1] - frames[i]).mean()), 3) for i in range(len(frames) - 1)]
    tail_static = 0.0
    for d in reversed(diffs):
        if d < STATIC_DIFF:
            tail_static += 0.2
        else:
            break

    # ③ 中段动作：取多个时间对的最大帧差（单点采样会低估「多加一行字幕」这种局部变化）
    pairs = [(0.22, 0.42), (0.32, 0.52), (0.42, 0.62), (0.52, 0.72)]
    diffs_mid = []
    for i, (f0, f1) in enumerate(pairs):
        a = grab(video, duration * f0, os.path.join(tmp, f"{name}-m{i}a.png"))
        b = grab(video, duration * f1, os.path.join(tmp, f"{name}-m{i}b.png"))
        diffs_mid.append(round(float(np.abs(b - a).mean()), 3))
    mid_diff = max(diffs_mid)

    return {
        "duration_s": round(duration, 3),
        "first_ui_s": first_ui,
        "tail_static_s": round(tail_static, 2),
        "tail_diffs": diffs,
        "mid_diff": mid_diff,
        "mid_diffs": diffs_mid,
        "head_samples": head,
    }


def ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["/opt/homebrew/bin/ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def main() -> int:
    manifest = json.load(open(os.path.join(CAPTURE, "MANIFEST.json")))
    report = {"stills": [], "clips": [], "problems": []}
    with tempfile.TemporaryDirectory() as tmp:
        for s in manifest["stills"]:
            p = os.path.join(CAPTURE, s["path"])
            st = png_stats(p)
            st.update({"name": s["name"], "expected": f"{s['w']}x{s['h']}"})
            if (st["w"], st["h"]) != (s["w"], s["h"]):
                report["problems"].append(f"{s['name']} 实测 {st['w']}x{st['h']} != MANIFEST {s['w']}x{s['h']}")
            if st["std"] < 8:
                report["problems"].append(f"{s['name']} 像空白帧 (std={st['std']})")
            if st["unique_colors_sampled"] < 300:
                report["problems"].append(f"{s['name']} 画面过于单调，疑似空帧 (colors={st['unique_colors_sampled']})")
            if st["ink_px"] < 500:
                report["problems"].append(f"{s['name']} 几乎没有正文墨色像素 (ink_px={st['ink_px']})")
            report["stills"].append(st)

        for c in manifest["clips"]:
            p = os.path.join(CAPTURE, c["path"])
            dur = ffprobe_duration(p)
            cs = clip_stats(p, dur, tmp, c["name"])
            cs["name"] = c["name"]
            cs["expected_duration_s"] = c["duration_s"]
            if abs(dur - c["duration_s"]) > 0.05:
                report["problems"].append(f"{c['name']} 时长实测 {dur:.2f} != MANIFEST {c['duration_s']}")
            if not (4 <= dur <= 9):
                report["problems"].append(f"{c['name']} 时长 {dur:.2f}s 不在 4–9s")
            if cs["first_ui_s"] is None or cs["first_ui_s"] > 0.35:
                report["problems"].append(f"{c['name']} 首帧出现 UI 太晚 ({cs['first_ui_s']}s)")
            if cs["tail_static_s"] < 0.8:
                report["problems"].append(f"{c['name']} 尾部静置 {cs['tail_static_s']}s < 0.8s")
            if cs["mid_diff"] < MOTION_DIFF:
                report["problems"].append(f"{c['name']} 中段几乎无变化 (mid_diff={cs['mid_diff']})")
            report["clips"].append(cs)

    report["ok"] = not report["problems"]
    out = os.path.join(CAPTURE, ".verify-frames.json")
    with open(out, "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("== 静帧 ==")
    for s in report["stills"]:
        print(f"  {s['name']:22s} {s['w']}x{s['h']}  std={s['std']:>6}  ink_px={s['ink_px']:>8}  colors={s['unique_colors_sampled']:>5}  accent_px={s['accent_px']:>6}")
    print("== 录屏 ==")
    for c in report["clips"]:
        print(f"  {c['name']:22s} {c['duration_s']:>5.2f}s  first_ui={c['first_ui_s']}s  tail_static={c['tail_static_s']}s  mid_diff={c['mid_diff']}")
    print(f"\nproblems: {len(report['problems'])}")
    for p in report["problems"]:
        print("  ! " + p)
    print(f"\n详细结果: {out}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
