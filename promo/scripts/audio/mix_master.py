#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NotesToGO · 拾贝 宣传片 —— 总混音（预览 / 备份用）

输入：promo/audio/vo/vo-NN.wav（48k 单声道）+ promo/audio/music/bed.wav（48k 立体声）
输出：promo/audio/mix/master.wav（48k 立体声 PCM16）

要点
  * 旁白为主体：逐句 RMS 对齐后，按侧链式 ducking 包络把音乐压到旁白下方 -22dB 量级
    （包络在 numpy 里按样本算，与 ffmpeg sidechaincompress 同思路：快起慢落）
  * 有旁白处 vs 无旁白处的音乐电平都写进 sidechain-report.json，可复算
  * 目标整体 -16 LUFS，真峰值 < -1 dBTP（先用 tanh 软限幅保底，再按 loudnorm 实测微调）

用法：
  PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
  $PY promo/scripts/audio/mix_master.py
"""
import json
import math
import os
import subprocess
import wave

import numpy as np

SR = 48000
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUDIO = os.path.join(ROOT, "audio")
VO_DIR = os.path.join(AUDIO, "vo")
MANIFEST = os.path.join(AUDIO, "vo-manifest.json")
BED = os.path.join(AUDIO, "music", "bed.wav")
OUT_DIR = os.path.join(AUDIO, "mix")
OUT = os.path.join(OUT_DIR, "master.wav")

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"

TARGET_LUFS = -16.0
PEAK_CEIL = 0.892           # -1.0 dBFS

# 分镜表分段（SH-01…SH-10）：段起点、段长、旁白在段内的起点。
# 严格照 promo/STORYBOARD.md 第 3 节，保证 0–8s 是"只有 pad"的音乐引入段。
SEGMENTS = [
    # id      seg_start  seg_len  vo_offset
    ("vo-01", 0.0, 8.0, 0.9),
    ("vo-02", 8.0, 7.0, 0.6),
    ("vo-03", 15.0, 13.0, 0.5),
    ("vo-04", 28.0, 14.0, 0.5),
    ("vo-05", 42.0, 7.0, 0.5),
    ("vo-06", 49.0, 14.0, 0.4),
    ("vo-07", 63.0, 11.0, 0.5),
    ("vo-08", 74.0, 11.0, 0.4),
    ("vo-09", 85.0, 7.0, 0.3),
    ("vo-10", 92.0, 8.0, 0.6),
]
TAIL_S = 2.0


def read_wav_mono(path):
    with wave.open(path, "rb") as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        a = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, sr


def read_wav_stereo(path):
    with wave.open(path, "rb") as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        a = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32768.0
    if ch == 1:
        a = np.stack([a, a], axis=1)
    else:
        a = a.reshape(-1, ch)[:, :2]
    return a, sr


def db(x):
    return 20.0 * math.log10(max(float(x), 1e-12))


def write_wav_stereo(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    i = np.round(np.clip(data, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(i.tobytes())


def ffmpeg_loudnorm(path):
    """ffmpeg loudnorm 实测 integrated LUFS / LRA / true peak。"""
    p = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", path,
         "-af", "loudnorm=print_format=summary", "-f", "null", "-"],
        capture_output=True, text=True)
    out = p.stderr
    vals = {}
    for line in out.splitlines():
        line = line.strip()
        for key, tag in (("Input Integrated", "input_i"), ("Input True Peak", "input_tp"),
                         ("Input LRA", "input_lra"), ("Input Threshold", "input_thresh"),
                         ("Output Integrated", "output_i"), ("Output True Peak", "output_tp")):
            if line.startswith(key + ":"):
                try:
                    vals[tag] = float(line.split(":")[1].strip().split()[0])
                except ValueError:
                    pass
    return vals


def ffmpeg_astats(path):
    """抓 astats 的 Peak / RMS / Max / Min / Flat factor / 削波计数。

    ffmpeg 8.x 的输出行带 `[Parsed_astats_0 @ 0x...] ` 前缀，且分
    Channel: 1 / Channel: 2 / Overall 三段，因此按"当前段"归类解析。
    """
    p = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", path,
         "-af", "astats=metadata=1:reset=0", "-f", "null", "-"],
        capture_output=True, text=True)
    res = {"channels": {}, "overall": {}}
    cur = None
    KEYS = {"Peak level dB": "peak_level_db", "RMS level dB": "rms_level_db",
            "Max level": "max_level", "Min level": "min_level",
            "Flat factor": "flat_factor", "Peak count": "peak_count",
            "Number of clips": "clips", "RMS peak dB": "rms_peak_db",
            "RMS trough dB": "rms_trough_db", "Dynamic range": "dynamic_range"}
    for raw in p.stderr.splitlines():
        line = raw
        if "] " in line:
            line = line.split("] ", 1)[1]
        line = line.strip()
        if line.startswith("Channel:"):
            cur = line.split(":", 1)[1].strip()
            res["channels"][cur] = {}
            continue
        if line == "Overall":
            cur = "overall"
            continue
        for k, tag in KEYS.items():
            if line.startswith(k + ":"):
                try:
                    v = float(line.split(":", 1)[1].strip())
                except ValueError:
                    continue
                tgt = res["overall"] if cur in (None, "overall") else res["channels"][cur]
                tgt[tag] = v
    return res


def build_duck_env(n, voiced, attack=0.120, release=0.380):
    """侧链式 ducking 包络（0..1，快起慢落），等价于 ffmpeg sidechaincompress 的思路。

    逐样本递推（真正的一阶分支峰值跟随器）：
        r = y[i-1]*a_rel + (1-a_rel)*x[i]      # 慢：向右充电
        a = ya[i-1]*a_att + (1-a_att)*x[i]     # 快：向上抽吸
        y[i] = max(r, a);  ya[i] = y[i]

    侧链 x 只有 0/1 两种取值，因此按"连续 1 段 / 连续 0 段"分段即可得到闭式解，
    避免 480 万次 python 循环。段长最长 ~13s（约 62 万样本），段内部全向量化。
    a_att = exp(-1/(attack*SR))，a_rel = exp(-1/(release*SR))
    """
    x = np.zeros(n)
    x[voiced] = 1.0
    a_att = math.exp(-1.0 / (attack * SR))
    a_rel = math.exp(-1.0 / (release * SR))

    y = np.empty(n)
    idx = np.nonzero(x)[0]
    if len(idx) == 0:
        return np.zeros(n)
    splits = np.nonzero(np.diff(idx) > 1)[0]
    starts = np.concatenate([[idx[0]], idx[splits + 1]])
    ends = np.concatenate([idx[splits], [idx[-1]]])       # 闭区间

    def silence_bounds(st, en, si):
        lo = en + 1
        hi = starts[si + 1] if si + 1 < len(starts) else n
        return lo, hi

    # 段前面的寂静（第一次 1 之前），y 与 ya 均从 0 起
    lo, hi = 0, starts[0]
    if hi > lo:
        y[lo:hi] = 0.0

    y_prev, ya_prev = 0.0, 0.0
    for si, (st, en) in enumerate(zip(starts, ends)):
        m = en - st + 1
        k = np.arange(m)
        # x = 1 段：
        #   r[k] = a_rel^(k+1)*y_prev + (1-a_rel^(k+1))
        #   a[k] = a_att^(k+1)*ya_prev + (1-a_att^(k+1))
        #   y[k] = max(r[k], a[k])
        pr = a_rel ** (k + 1)
        pa = a_att ** (k + 1)
        r = pr * y_prev + (1.0 - pr)
        aa = pa * ya_prev + (1.0 - pa)
        yy = np.maximum(r, aa)
        y[st:en + 1] = yy
        y_prev = float(yy[-1])
        # 段末的 ya 状态（注意 ya 只在段内被 y 顶起来，段末 = y 段末）
        ya_prev = y_prev

        # x = 0 段：r[k] = a_rel^k * y_prev ; a[k] = a_att^k * ya_prev
        #            y[k] = max(r[k], a[k])   —— 当 a_att < a_rel 时 a 衰减更快
        lo, hi = silence_bounds(st, en, si)
        if hi > lo:
            kk = np.arange(1, hi - en)
            pr2 = a_rel ** kk
            pa2 = a_att ** kk
            yy2 = np.maximum(pr2 * y_prev, pa2 * ya_prev)
            y[en + 1:hi] = yy2
            y_prev = float(yy2[-1])
            ya_prev = y_prev
    return y


def _selftest_duck(verbose=False):
    """与逐样本递推对照，确认闭式解等价（必须 < 1e-9）。"""
    import random
    random.seed(7)
    n = 20000
    voiced = np.zeros(n, dtype=bool)
    for _ in range(12):
        s = random.randrange(0, n - 1500)
        voiced[s:s + random.randrange(200, 1200)] = True
    a_att = math.exp(-1.0 / (0.120 * SR))
    a_rel = math.exp(-1.0 / (0.380 * SR))
    y_ref = np.zeros(n)
    ya = 0.0
    for i in range(1, n):
        xv = 1.0 if voiced[i] else 0.0
        r = y_ref[i - 1] * a_rel + (1 - a_rel) * xv
        a = ya * a_att + (1 - a_att) * xv
        y_ref[i] = max(r, a)
        ya = y_ref[i]
    got = build_duck_env(n, voiced)
    err = float(np.max(np.abs(y_ref - got)))
    if verbose:
        print("duck selftest max abs err =", err)
    return err


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    man = json.load(open(MANIFEST, encoding="utf-8"))

    # ---------------- 1) 旁白 stems：逐句 RMS 对齐
    stems, levels = {}, []
    for row in man:
        a, sr = read_wav_mono(os.path.join(AUDIO, row["path"]))
        assert sr == SR, f"{row['id']} 采样率不是 48k"
        # 用有声部分（-45dBFS 以上）算 RMS，避免首尾静音拉低读数
        thr = 10 ** (-45 / 20.0)
        active = np.abs(a) > thr
        r = np.sqrt(np.mean(np.square(a[active]))) if active.any() else np.sqrt(np.mean(np.square(a)))
        stems[row["id"]] = (a, r)
        levels.append({"id": row["id"], "active_rms_db": round(db(r), 3),
                       "dur_s": row["duration_s"]})

    # 目标：所有旁白 active RMS 拉到 -20 dBFS（留 4dB 给整体 loudnorm）
    TARGET_VO_RMS_DB = -20.0
    norm_stems = {}
    for row in man:
        a, r = stems[row["id"]]
        g = 10 ** ((TARGET_VO_RMS_DB - db(r)) / 20.0)
        norm_stems[row["id"]] = a * g
    # 轻度软限幅，防止个体峰值越界
    for k in norm_stems:
        x = norm_stems[k]
        norm_stems[k] = np.tanh(x * 1.15) / np.tanh(1.15)

    # ---------------- 2) 时间轴排布（严格按分镜段；VO 超长时只记录不裁切）
    durs = {r["id"]: r["duration_s"] for r in man}
    MIN_GAP = 0.40          # 相邻 VO 之间至少留 400ms，避免两条旁白叠在一起
    placed = []
    prev_end = None
    for (vid, seg_start, seg_len, vo_off) in SEGMENTS:
        start = seg_start + vo_off
        forced_by = None
        if prev_end is not None and start < prev_end + MIN_GAP:
            forced_by = "prev_vo_end+gap"
            start = prev_end + MIN_GAP
        end = start + durs[vid]
        placed.append({
            "id": vid, "seg_start_s": seg_start, "seg_len_s": seg_len,
            "start_s": round(start, 4), "end_s": round(end, 4),
            "dur_s": durs[vid],
            "vo_end_vs_seg_end_s": round(end - (seg_start + seg_len), 3),
            "pushed_by": forced_by,
            "gap_from_prev_s": None if prev_end is None else round(start - prev_end, 4),
        })
        prev_end = end
    total = round(max(p["end_s"] for p in placed) + TAIL_S, 3)

    n = int(math.ceil(total * SR))
    voice = np.zeros(n)
    for p in placed:
        i0 = int(round(p["start_s"] * SR))
        a = norm_stems[p["id"]]
        i1 = min(n, i0 + len(a))
        voice[i0:i1] += a[: i1 - i0]

    # ---------------- 3) 音乐 + ducking
    bed, sr_b = read_wav_stereo(BED)
    assert sr_b == SR, "bed.wav 采样率不是 48k"
    if len(bed) < n:
        bed = np.vstack([bed, np.zeros((n - len(bed), 2))])
    bed = bed[:n]

    # 无旁白处音乐 0dB 参考；有旁白处压低 10.5dB（≈ 旁白下方 -22dB 量级）
    DUCK_DB = 10.5
    voiced = np.abs(voice) > 10 ** (-55 / 20.0)
    env = build_duck_env(n, voiced)
    duck_gain = 10 ** (-DUCK_DB / 20.0) * env + (1.0 - env)
    bed_g = bed * duck_gain[:, None]

    # 音乐整体电平：让"无旁白处"的 bed RMS 落在 -30 dBFS 附近
    gap = ~voiced
    bed_rms_gap = np.sqrt(np.mean(np.square(bed_g[gap]))) if gap.any() else np.sqrt(np.mean(np.square(bed_g)))
    MUSIC_GAP_RMS_DB = -33.0
    bed_g *= 10 ** ((MUSIC_GAP_RMS_DB - db(bed_rms_gap)) / 20.0)

    # 音乐的相对电平差（有旁白处）
    bed_rms_vo = np.sqrt(np.mean(np.square(bed_g[voiced]))) if voiced.any() else 1e-12
    vo_rms = np.sqrt(np.mean(np.square(voice[voiced]))) if voiced.any() else 1e-12

    # ---------------- 4) 汇总 + 软限幅 + 峰值保护
    mix = voice[:, None] + bed_g
    mix = np.tanh(mix * 1.02) / np.tanh(1.02)
    pk = float(np.max(np.abs(mix)))
    if pk > PEAK_CEIL:
        mix *= PEAK_CEIL / pk
    write_wav_stereo(OUT, mix)

    # ---------------- 5) 实测：astats + loudnorm，并按 loudnorm 结果做最终增益微调
    astat_before = ffmpeg_astats(OUT)
    ln_before = ffmpeg_loudnorm(OUT)
    gain_db = 0.0
    if "input_i" in ln_before:
        gain_db = TARGET_LUFS - ln_before["input_i"]
        # 增益后峰值不得超过上限
        peak_after = float(np.max(np.abs(mix))) * (10 ** (gain_db / 20.0))
        if peak_after > PEAK_CEIL:
            gain_db = db(PEAK_CEIL / float(np.max(np.abs(mix))))
        mix *= 10 ** (gain_db / 20.0)
        write_wav_stereo(OUT, mix)

    astat = ffmpeg_astats(OUT)
    ln = ffmpeg_loudnorm(OUT)

    report = {
        "output": os.path.relpath(OUT, ROOT),
        "sample_rate": SR, "channels": 2,
        "duration_s": round(len(mix) / SR, 3),
        "voice_target_active_rms_db": TARGET_VO_RMS_DB,
        "vo_active_rms_before_norm_db": levels,
        "music_gap_rms_target_db": MUSIC_GAP_RMS_DB,
        "music_duck_db": DUCK_DB,
        "music_rms_in_voiced_db": round(db(bed_rms_vo), 3),
        "voice_rms_in_voiced_db": round(db(vo_rms), 3),
        "music_below_voice_db": round(db(bed_rms_vo) - db(vo_rms), 3),
        "applied_gain_db": round(gain_db, 3),
        "astats": astat, "astats_before_gain": astat_before,
        "loudnorm": ln, "loudnorm_before_gain": ln_before,
        "timeline": placed, "total_s": total,
    }
    with open(os.path.join(OUT_DIR, "sidechain-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(json.dumps({k: report[k] for k in
                      ["duration_s", "music_below_voice_db", "applied_gain_db",
                       "astats", "loudnorm"]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
