#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NotesToGO · 拾贝 宣传片 —— 配乐合成（100% 自研 numpy 合成，无外部采样、无版权风险）

输出：promo/audio/music/bed.wav
  48 kHz / 立体声 / PCM16 / >= 100 s

设计（"暖色极简科技感"）：
  * 和声：Cmaj7 – Am7 – Fmaj7 – G6 ，每 4 小节一循环，66 BPM（4/4），3.636…s / 小节
  * 层 1 PAD       ：柔和和弦垫，加法合成（8 个分音，奇偶交替衰减）+ 双失谐 saw-ish 边缘
  * 层 2 BELL      ：钟琴/电钢单音点缀，非谐分音 + 指数衰减 + 立体声随机摆位（稀疏）
  * 层 3 AIR       ：极轻粉噪声铺底，做缓慢 lowpass 扫动（"呼吸"）
  * 结构：0–12s 引入（只有 pad + air，pad 缓慢淡入）
          12s–(T-12)s 稳态（钟琴点缀密度提升）
          T-12s–T-8s 尾段（pad 层收薄，钟琴停）
          最后 8s 全局余弦淡出（>= 契约要求的 6s）
  * 峰值留足余量：目标真峰值 ≈ -3.5 dBFS，绝不削波，留混音余量

用法：
  /Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 \
      promo/scripts/audio/make_music.py [--duration 132] [--out promo/audio/music/bed.wav]
"""
import argparse
import json
import math
import os
import struct
import wave

import numpy as np

SR = 48000

# ---------------------------------------------------------------- 基础工具

def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def one_pole_lp(x, cutoff_hz, block=1 << 16):
    """一阶低通 y[i] = a*x[i] + (1-a)*y[i-1]。

    cutoff_hz 可为标量或逐样本数组（调用方需保证足够平滑）。
    实现：把信号切成大块，块内取常数系数 a，用 **FFT 卷积**求
    y = a * (x * h) （h[k] = (1-a)^k 为冲激响应），块间传递初值。
    O(n log n)，比逐样本 python 递推快 3 个数量级。
    """
    c = np.asarray(cutoff_hz, dtype=np.float64)
    if c.ndim == 0:
        a = np.full(len(x), 1.0 - math.exp(-2.0 * math.pi * float(c) / SR))
    else:
        a = 1.0 - np.exp(-2.0 * np.pi * np.clip(c, 20.0, SR * 0.45) / SR)

    n = len(x)
    y = np.empty(n, dtype=np.float64)
    prev = 0.0
    for s in range(0, n, block):
        e = min(s + block, n)
        ab = float(np.mean(a[s:e]))
        ab = min(max(ab, 1e-9), 1.0)
        seg = x[s:e]
        m = e - s
        # 指数冲激响应；超过 -60dB 的尾部截断（内存/速度）
        tail = min(m, int(math.ceil(math.log(1e-3) / math.log(max(1.0 - ab, 1e-12)))))
        tail = max(1, tail)
        h = (1.0 - ab) ** np.arange(tail)
        nfft = 1 << int(math.ceil(math.log2(m + tail - 1)))
        conv = np.fft.irfft(np.fft.rfft(seg, nfft) * np.fft.rfft(h, nfft))[:m]
        out = ab * conv
        # 加上上一块末尾状态衰减过来的贡献
        decay = (1.0 - ab) ** np.arange(1, m + 1)
        out += prev * decay
        y[s:e] = out
        prev = out[-1]
    return y


def smooth(x, sec):
    """滑动平均平滑（用于控制信号）。O(n) 前缀和实现。

    注意：绝不能用 np.convolve —— 控制信号长度 480 万、窗长上万，
    直接卷积是 O(n*m) ≈ 10^11 次运算（实测要跑十几分钟），
    前缀和版本同样是"算法教科书里的标准做法"，但快 5 个数量级。
    """
    m = max(1, int(sec * SR))
    if m == 1:
        return x.copy()
    n = len(x)
    c = np.concatenate([[0.0], np.cumsum(x, dtype=np.float64)])
    # 对称窗（居中）：窗口 [i-m//2, i-m//2+m)
    half = m // 2
    lo = np.clip(np.arange(n) - half, 0, n)
    hi = np.clip(np.arange(n) - half + m, 0, n)
    return (c[hi] - c[lo]) / np.maximum(hi - lo, 1)


def db(x):
    return 20.0 * np.log10(max(x, 1e-12))


# ---------------------------------------------------------------- 和声表

def chord_voicings():
    """Cmaj7 – Am7 – Fmaj7 – G6（温暖、无导音刺感）。

    每项 = (根音 midi, [和弦音 midi...])，音区控制在 C3–C5，低音单列。
    """
    return [
        # Cmaj7 : C E G B
        (36, [48, 52, 55, 59], 60),   # bass C2, pad C3 E3 G3 B3, top C4
        # Am7   : A C E G
        (33, [45, 48, 52, 55], 57),   # bass A1, pad A2 C3 E3 G3, top A3
        # Fmaj7 : F A C E
        (29, [41, 45, 48, 52], 53),   # bass F1, pad F2 A2 C3 E3, top F3
        # G6    : G B D E
        (31, [43, 47, 50, 52], 55),   # bass G1, pad G2 B2 D3 E3, top G3
    ]


# ---------------------------------------------------------------- 各层合成

def make_pad(n, bar_len, prog, env_gain, detune_cents=(0.0, 6.5, -6.5)):
    """柔和 pad：每个和弦音用 8 个分音加法合成（1/n^1.6，偶数分音弱 → 更暖），
    三个 detune 副本制造缓慢相位流动（chorus 感），和弦之间 0.9s 交叉淡化。

    性能关键：
      * 分音相位用**解析积分**代替逐样本 cumsum：
            f(t) = f0*(1 + A*sin(w t + p))
            ∫f dt = f0*(t + (A/w)*(cos(p) - cos(w t + p)))
      * 每个 (音高, 分音, detune) 的 sin/cos 查表缓存，全曲只算一次。
    """
    out = np.zeros((n, 2), dtype=np.float64)
    bars = int(math.ceil(n / bar_len)) + 1
    xfade = 0.9
    A = 0.0007                     # 漂移深度
    seg_max = int((bar_len + xfade) * SR) + int(SR) + 4
    t_full = np.arange(seg_max, dtype=np.float64) / SR
    sine_cache, lfo_cache = {}, {}

    def get_lfo(f_lfo, phase):
        """按最大段长计算并缓存，调用方自己切片 —— key 与段长无关。"""
        key = (round(f_lfo, 9), round(phase, 9))
        v = lfo_cache.get(key)
        if v is None:
            v = (np.sin(2 * np.pi * f_lfo * t_full + phase),
                 np.cos(2 * np.pi * f_lfo * t_full + phase))
            lfo_cache[key] = v
        return v

    for b in range(bars):
        root, notes, top = prog[b % len(prog)]
        i0 = int(b * bar_len * SR)
        if i0 >= n:
            break
        i1 = min(n, int((b * bar_len + bar_len + xfade) * SR))
        seg_n = i1 - i0
        t = t_full[:seg_n]
        a = np.clip(t / xfade, 0.0, 1.0)
        rel = np.clip((bar_len + xfade - t) / xfade, 0.0, 1.0)
        env = (np.minimum(a, rel) ** 1.4)[:, None]     # (seg_n,1) 便于广播

        voices = [root + 12] + list(notes) + [top + 12]
        accL = np.zeros(seg_n)
        accR = np.zeros(seg_n)
        for m in voices:
            base = midi_to_hz(m)
            w = 1.0 / (1.0 + 0.55 * max(0, m - 48))
            for k, cents in enumerate(detune_cents):
                f0 = base * (2.0 ** (cents / 1200.0))
                kL = 0.5 * w
                kR = 0.5 * w * (1.0 - 0.045 * k)
                for harm in range(1, 9):
                    amp = 1.0 / (harm ** 1.6)
                    if harm % 2 == 0:
                        amp *= 0.55
                    f_lfo = 0.037 + 0.019 * harm + 0.013 * k
                    ph0 = harm * 1.7
                    key = (round(f0 * harm, 6), f_lfo, ph0, round(cents, 4))
                    tab = sine_cache.get(key)
                    if tab is None:
                        lfo_s, lfo_c = get_lfo(f_lfo, ph0)
                        c_lfo = lfo_c[:seg_n]
                        # 解析相位积分：∫f dt = f0*(t + (A/w)*(cos(p) - cos(wt+p)))
                        phase = (2 * np.pi * f0 * harm *
                                 (t + (A / (2 * np.pi * f_lfo)) * (c_lfo[0] - c_lfo)))
                        car = np.sin(phase + k * 0.9 + harm * 0.31)
                        tab = amp * car
                        sine_cache[key] = tab
                    else:
                        tab = tab[:seg_n]
                    if tab.shape[0] != seg_n:      # 末段可能的长度错位
                        accL += np.resize(tab, seg_n) * kL
                        accR += np.resize(tab, seg_n) * kR
                        continue
                    accL += tab * kL
                    accR += tab * kR

        # 低音：正弦 + 一点二次谐波，稳定而暖
        f_b = midi_to_hz(root)
        bass = (np.sin(2 * np.pi * f_b * t) + 0.22 * np.sin(4 * np.pi * f_b * t)) \
            * (1.25 * env[:, 0])
        out[i0:i1, 0] += accL * env[:, 0] + bass
        out[i0:i1, 1] += accR * env[:, 0] + bass

    # 标定：单音最大幅度 ≈ sum(amp) * sum(kL) * 0.5*(1+1-0.045*2)… 用固定缩放
    return out * (env_gain / 6.0)


def make_bell(m_notes, n, bar_len, hits, env_gain):
    """钟琴/电钢点缀：非谐分音（1, 2.76, 5.40, 8.93 —— 类钟体模态）+ 指数衰减。
    每个音有独立的立体声摆位。"""
    out = np.zeros((n, 2), dtype=np.float64)
    partials = [(1.0, 1.00, 3.4), (2.76, 0.42, 2.1), (5.40, 0.20, 1.3),
                (8.93, 0.085, 0.8), (13.34, 0.035, 0.5)]
    for (t_on, midi, vel, pan) in hits:
        i0 = int(t_on * SR)
        if i0 >= n:
            continue
        dur = 3.2
        seg_n = min(n - i0, int(dur * SR))
        t = np.arange(seg_n) / SR
        f0 = midi_to_hz(midi)
        acc = np.zeros(seg_n)
        for ratio, amp, decay in partials:
            f = f0 * ratio
            if f > SR * 0.45:
                continue
            acc += amp * np.exp(-t / (dur / decay)) * np.sin(2 * np.pi * f * t)
        # 起音 6ms 抗 click
        atk = np.clip(t / 0.006, 0.0, 1.0)
        seg = acc * atk * vel
        gl = math.sqrt(0.5 * (1.0 + pan))
        gr = math.sqrt(0.5 * (1.0 - pan))
        out[i0:i0 + seg_n, 0] += gl * seg
        out[i0:i0 + seg_n, 1] += gr * seg
    return out * env_gain


def make_air(n, env_gain):
    """极轻噪声铺底 + 缓慢 lowpass 扫动（0.021 Hz，约 48s 一个来回）。"""
    rng = np.random.default_rng(20261018)
    noise = rng.standard_normal((n, 2))
    # 轻度粉化：一阶低通两次，让高频不那么"沙"
    noise = one_pole_lp(noise[:, 0], 3200.0)[:, None] * np.array([1.0, 0.0]) + \
            one_pole_lp(noise[:, 1], 3200.0)[:, None] * np.array([0.0, 1.0])
    t = np.arange(n) / SR
    # cutoff 在 320Hz–2400Hz 之间缓慢摆动
    lfo = 0.5 * (1.0 + np.sin(2 * np.pi * 0.021 * t - math.pi / 2))
    cutoff = 320.0 + (2400.0 - 320.0) * lfo
    cutoff = smooth(cutoff, 0.35)
    air = np.empty_like(noise)
    air[:, 0] = one_pole_lp(noise[:, 0], cutoff)
    air[:, 1] = one_pole_lp(noise[:, 1], cutoff * 0.94)
    # 站立的稳定底噪：非常轻，只在 -46dB 量级
    rms = math.sqrt(float(np.mean(air ** 2))) or 1.0
    return air / rms * env_gain


# ---------------------------------------------------------------- 编曲

def build_hits(total, bar_len):
    """稀疏钟琴点缀。确定性排布（不用随机数决定"音乐内容"）。

    引子（0–12s）不出现；稳态每个 4 小节循环里落 2–5 个音；最后 12s 停。
    """
    prog = chord_voicings()
    hits = []
    # 每个和弦上可用的钟琴音（高八度，五声音阶化避免任何刺耳）
    pool = [
        [60, 64, 67, 71, 74, 79],   # Cmaj7
        [57, 60, 64, 67, 72, 76],   # Am7
        [57, 60, 65, 69, 72, 77],   # Fmaj7
        [55, 59, 62, 67, 71, 74],   # G6
    ]
    # 每个循环位置（小节 0..3）的点缀方案：[(拍位置 in bar, pool index, vel, pan)]
    pattern = [
        [(1.5, 4, 0.30, -0.45), (3.0, 2, 0.18, 0.50)],
        [(1.0, 0, 0.26, -0.30), (2.5, 3, 0.22, 0.42), (3.5, 5, 0.14, -0.55)],
        [(1.5, 1, 0.24, 0.35), (2.5, 4, 0.20, -0.40), (3.5, 0, 0.15, 0.58)],
        [(0.5, 3, 0.30, -0.50), (1.5, 1, 0.26, 0.28), (2.5, 2, 0.22, -0.34),
         (3.5, 5, 0.19, 0.52)],
    ]
    beats_per_bar = 4.0
    bar_dur = bar_len
    bar = 0
    while bar * bar_dur < total - 12.0:
        t_bar = bar * bar_dur
        ci = bar % 4
        for (beat, pi, vel, pan) in pattern[ci]:
            t_on = t_bar + beat / beats_per_bar * bar_dur
            if t_on < 12.0 or t_on > total - 12.0:
                continue
            # 稳态的投入度：12–20s 稀疏（只留一半），20s 后全量
            if t_on < 20.0 and (pi % 2 == 1):
                continue
            # 越靠尾段越疏
            fade_zone = max(0.0, (t_on - (total - 30.0)) / 18.0)
            if fade_zone > 0 and (pi % 2 == 0) and vel < 0.27:
                continue
            hits.append((t_on, pool[ci][pi], vel, pan))
        bar += 1
    hits.sort(key=lambda h: h[0])
    return hits


def make_envelope(n, total, bar_len):
    """全曲包络：0–2s 淡入；最后 8s 余弦淡出（满足"最后 6s 收尾"）。
    另外在 8–12s 之间把 pad 单独凸出（引子），12s 后回落到稳态。"""
    t = np.arange(n) / SR
    env = np.ones(n)
    rise = np.clip(t / 2.5, 0.0, 1.0)
    env *= rise
    # 引子：pad 满、钟琴无 —— 由 build_hits 的 12s 门限保证；此处不再额外抬升
    tail = 8.0
    k = np.clip((total - t) / tail, 0.0, 1.0)
    env *= 0.5 * (1.0 - np.cos(np.pi * k))
    return env


# ---------------------------------------------------------------- 主流程

def synthesize(total=132.0):
    bpm = 66.0
    beat = 60.0 / bpm
    bar_len = 4 * beat                    # 3.6363…s
    n = int(round(total * SR))
    prog = chord_voicings()

    pad = make_pad(n, bar_len, prog, env_gain=1.0)
    hits = build_hits(total, bar_len)
    bell = make_bell(None, n, bar_len, hits, env_gain=1.0)
    air = make_air(n, env_gain=1.0)

    # ---- 分层增益（合成后统一标定，保证 headroom）
    pad_peak = float(np.max(np.abs(pad))) or 1.0
    bell_peak = float(np.max(np.abs(bell))) or 1.0
    air_peak = float(np.max(np.abs(air))) or 1.0
    LAYER_PEAK = {"pad": 0.520, "bell": 0.180, "air": 0.030}
    pad = pad / pad_peak * LAYER_PEAK["pad"]
    bell = bell / bell_peak * LAYER_PEAK["bell"]
    air = air / air_peak * LAYER_PEAK["air"]

    mix = pad + bell + air
    env = make_envelope(n, total, bar_len)
    mix *= env[:, None]

    # ---- 温和软限幅（tanh，仅在极端叠加时起作用，不做砖墙限幅）
    drive = 1.05
    mix = np.tanh(mix * drive) / np.tanh(drive)

    # ---- 立体声轻度加宽 + 一点点短延时（20ms，只在对侧，很轻）
    d = int(0.020 * SR)
    wide = mix.copy()
    wide[d:, 0] += 0.10 * mix[:-d, 1]
    wide[d:, 1] += 0.10 * mix[:-d, 0]
    mix = wide

    # ---- 峰值标定到 -3.5 dBFS
    target_peak = 10 ** (-3.5 / 20.0)
    pk = float(np.max(np.abs(mix)))
    mix = mix / pk * target_peak
    return mix, {"bars": len(hits), "peak_dbfs": db(float(np.max(np.abs(mix))))}


def write_wav(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    x = np.clip(data, -1.0, 1.0)
    i = np.round(x * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(i.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=float, default=132.0)
    ap.add_argument("--out", default="promo/audio/music/bed.wav")
    a = ap.parse_args()
    data, info = synthesize(a.duration)
    write_wav(a.out, data)
    peak = float(np.max(np.abs(data)))
    rms = float(np.sqrt(np.mean(data ** 2)))
    print(json.dumps({
        "out": a.out, "duration_s": round(len(data) / SR, 3),
        "sr": SR, "channels": 2,
        "peak_dbfs": round(db(peak), 3),
        "rms_dbfs": round(db(rms), 3),
        "bell_hits": info["bars"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
