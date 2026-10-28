# `promo/audio/music/bed.wav` —— 配乐合成说明

> 负责人：audio ｜ 日期：2026-10-18 ｜ **100% 自研 numpy 合成，无任何外部采样/循环/下载音乐，零版权风险**
> 生成脚本：`promo/scripts/audio/make_music.py`（单文件、仅依赖 numpy）

---

## 0. 成品实测（ffprobe / astats）

```bash
ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels,duration \
  -of default=nw=1 promo/audio/music/bed.wav
```
```
codec_name=pcm_s16le
sample_rate=48000
channels=2
duration=132.000000
```

```bash
ffmpeg -hide_banner -nostats -i promo/audio/music/bed.wav \
  -af astats=metadata=1:reset=0 -f null - 2>&1 | grep -E "Overall|Peak level dB|RMS level dB"
```
```
Overall
  Peak level dB: -3.500006      <- 留 3.5 dB 余量，给混音阶段
  RMS level dB:  -14.481893
```

| 指标 | 实测值 |
|---|---|
| 采样率 / 声道 | 48000 Hz / 2（立体声） |
| 时长 | **132.000 s**（契约要求 ≥ 100 s） |
| 位深 / 编码 | 16-bit PCM（`pcm_s16le`） |
| 峰值 | **−3.500 dBFS**（无削波，余量 3.5 dB） |
| RMS | −14.482 dBFS |
| 钟琴点缀命中数 | 81 个（首次 13.182 s，末次 117.727 s） |

---

## 1. 和弦进行

**Cmaj7 – Am7 – Fmaj7 – G6**（C 大调，暖色、无导音刺感；G6 用 E 代替 F，避免 F–G 的半音摩擦）

| 和弦 | 低音 | pad 音区 | 顶音 |
|---|---|---|---|
| Cmaj7 | C2 (MIDI 36) | C3 E3 G3 B3 | C5 |
| Am7 | A1 (MIDI 33) | A2 C3 E3 G3 | A4 |
| Fmaj7 | F1 (MIDI 29) | F2 A2 C3 E3 | F4 |
| G6 | G1 (MIDI 31) | G2 B2 D3 E3 | G4 |

- 速度 **66 BPM**，4/4 → 一小节 **3.6364 s**，
- 一个循环 = 4 小节 = **14.545 s**，全曲 132 s 共 **9 个完整循环**。
- 和声定义在 `chord_voicings()`，改 `prog` 即可换进行。

---

## 2. 三层音色怎么合成的

### 层 1 · PAD（柔和和弦垫）—— `make_pad()`

- **加法合成**：每个和弦音用 **8 个分音**，幅度 `1 / n^1.6`；**偶数分音再乘 0.55**（削弱方波感 → 更"木"、更暖）。
- **三副本失谐**：同一和弦音做 3 份 `detune = 0 / +6.5 / −6.5 cent`，制造缓慢相位流动（chorus 感），
  左右声道再给 4.5% 的轻微差异 → 自然的立体声宽度。
- **缓慢漂移**：每个分音的瞬时频率带 `±0.07%` 的极慢正弦抖动
  （`f(t) = f0·(1 + A·sin(ωt+φ))`，`A=0.0007`，ω 随分音号 0.037→0.17 Hz 递增）。
  相位用**解析积分**求：`∫f dt = f0·(t + (A/ω)(cos φ − cos(ωt+φ)))`，
  这样不用逐样本 `cumsum`，全曲 132 s 的 pad 只需约 2 s 算完。
- **低音层**：根音单独一层 = 正弦 + 0.22×二次谐波，稳定而暖，不与 pad 抢中频。
- **和弦切换**：相邻和弦 **0.9 s 交叉淡化**，用 `min(fade_in, fade_out)^1.4` 包络（比线性更"软"）。
- 实测（未标定时）：peak −0.35 dBFS、RMS −11.54 dBFS → 标定到峰值 **0.520（−5.68 dBFS）**。

### 层 2 · BELL（钟琴 / 电钢单音点缀）—— `make_bell()`

- **非谐分音**（类钟体模态，来自管钟/钟琴的物理模态比）：
  `[1.0, 2.76, 5.40, 8.93, 13.34]`，幅度 `[1.00, 0.42, 0.20, 0.085, 0.035]`，
  每个分音各自的指数衰减速率 `[3.4, 2.1, 1.3, 0.8, 0.5]`（高次分音衰减更快）。
- 每个音 **3.2 s** 衰减尾巴，**6 ms 起音**坡道防 click。
- **立体声摆位**：每个音带固定 pan（−0.55…+0.58），用等功率定律
  （`sqrt(0.5(1±pan))`）分配到左右。
- **稀疏排布**：由 `build_hits()` 用**确定性**方案排（不用随机数决定音乐内容）：
  每个和弦按 4 拍落 2–4 个音，音高从该和弦的五声化音池里取（避免任何刺耳音程）。
  投入度曲线：**< 12 s 完全不出现** → 12–20 s 只留一半 → 20 s 后全量 → 尾段 12 s 再次变疏。
- 实测（未标定）：peak −6.41 dBFS、RMS −22.73 dBFS → 标定到峰值 **0.180（−14.89 dBFS）**。

### 层 3 · AIR（噪声铺底 + 缓慢滤波扫动）—— `make_air()`

- 用固定种子 `default_rng(20261018)` 生成白噪声（**可复现**），先过一次 3200 Hz 一阶低通"粉化"，去掉沙砾感。
- **缓慢 lowpass 扫动**：截止频率在 **320 Hz ↔ 2400 Hz** 之间以 **0.021 Hz**（≈48 s 一个来回）正弦摆动，
  控制信号再做 0.35 s 平滑 → 这就是"呼吸感"的来源；左右声道截止频率差 6% → 宽度。
- 一阶 IIR 用**分块 FFT 卷积**实现（`one_pole_lp`），O(n log n)；`smooth()` 用**前缀和**滑动平均（O(n)）。
  > 踩过的坑：最初 `smooth()` 用了 `np.convolve`，控制信号 480 万点 × 窗长上万 = O(n·m) ≈ 10¹¹ 次运算，
  > 132 s 的曲子要跑十几分钟；改成前缀和后整首 **5.6 s** 跑完。这是"没查现成做法就自己写"的典型代价。
- 实测（未标定）：峰值异常（`/rms` 归一化导致）→ 标定到峰值 **0.030（−30.46 dBFS）**，即 −46 dB 量级的极轻底噪。

---

## 3. 结构（时间轴）

| 区段 | 内容 | 实测 RMS |
|---|---|---|
| **0–2.5 s** | 全局淡入（余弦升） | 0–4 s: −17.97 dBFS |
| **0–12 s 引入** | **只有 pad + air**，钟琴完全不出现 | 4–8 s: −14.53 dBFS |
| 12–20 s | 钟琴开始稀疏加入（只留一半命中） | 8–12 s: −14.00 dBFS |
| 20 s–120 s 稳态 | pad + 全量钟琴 + air，缓慢滤波扫动 | 12–30 s: −14.15 / 30–70 s: −14.25 / 70–110 s: −14.27 dBFS |
| 120–124 s | 钟琴停，pad 收薄 | 110–124 s: −14.22 dBFS |
| **124–132 s 收尾** | 余弦淡出 8 s（**满足"最后 6 s 收尾"**） | 126–130 s: −18.98 / 130–132 s: −35.95 dBFS |

最后 6 s 每 0.25 s 峰值（dBFS），单调下降无回弹：

```
-7.3 -7.3 -6.5 -6.3 -7.6 -10.0 -13.8 -15.2 -14.1 -13.0 -13.9 -14.8 -15.8 -18.0
-20.1 -20.2 -20.7 -23.4 -26.8 -33.2 -36.8 -45.3 -53.4 -63.5
```

**峰值余量**：整体标定到 **−3.5 dBFS**，再经 `tanh` 软限幅（`drive=1.05`，仅在极端叠加时起作用）
与 20 ms 轻微立体声加宽（对侧 10%）。全程无硬限幅、无削波。

---

## 4. 复跑命令

```bash
PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
cd /Users/fangchen/Baidu/GitHub/Notes&ToDo
$PY promo/scripts/audio/make_music.py --duration 132 --out promo/audio/music/bed.wav
# 输出: {"out": "...bed.wav", "duration_s": 132.0, "sr": 48000, "channels": 2,
#        "peak_dbfs": -3.5, "rms_dbfs": -14.481, "bell_hits": 81}
# 实测耗时 5.6 s
```

确定性：全曲只有 `make_air()` 里的噪声用随机数，且**固定种子**；其余全部为确定性合成。
同一条命令重复执行，输出逐样本一致。

---

## 5. 与"不重复造轮子"原则的说明

本层确实**自研**，理由是契约硬性要求「音乐只能用 numpy 自己合成（规避版权）」，并且明确**禁止下载现成音乐**：

- 查过的现成方案：`musicgen` / `AudioCraft`、`stable-audio-tools` 等 —— 属**生成模型**，契约禁止；
  `fluidsynth` + SoundFont、`sox` 合成、`csound` —— 需要外部音源库/SoundFont（有版权或需下载），契约禁止；
  免版权音乐库（YouTube Audio Library / Free Music Archive）—— 需要**下载现成音乐**，契约禁止。
- 本机实际情况：`sox` **未安装**，bundled Python 里只有 numpy 2.3.5 + Pillow（**没有 scipy / soundfile**）。
- 所以走"numpy 加法合成 + 物理模态建模"这条唯一可行路径；上面所有 DSP 都是标准公开算法
  （加法合成、Karplus 之外的模态合成、一阶 IIR、O(n) 滑动平均、等功率声像、余弦淡入淡出）。
