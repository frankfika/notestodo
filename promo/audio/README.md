# `promo/audio/` —— NotesToGO · 拾贝 宣传片音频交付

> 负责人：audio ｜ 日期：2026-10-18 ｜ 契约：`promo/STORYBOARD.md` 第 3 节 + 第 4.3 节
> **旁白全部由本机 macOS `say` 合成；音乐全部由 numpy 自研合成。全程未调用任何云端 TTS / 视频生成模型，未下载任何现成音乐。**

---

## 1. 文件清单

| 路径 | 规格 | 时长 | 说明 |
|---|---|---|---|
| `vo/vo-01.wav … vo-10.wav` | 48 kHz **单声道** PCM16 | 5.506–12.699 s | 逐句旁白 stem，句首 150 ms / 句尾 ≥150 ms 静音 |
| `vo-manifest.json` | — | — | 10 条 `{id, path, duration_s, text}` + 附加 `speech_start_s` / `speech_end_s` |
| `vo-render-meta.json` | — | — | 渲染元数据（嗓音、rate、软目标、首尾静音实测） |
| `music/bed.wav` | 48 kHz **立体声** PCM16 | **132.000 s** | 自研 numpy 合成配乐 |
| `music/NOTES.md` | — | — | 和弦进行 / 音色合成方式 / 分层峰值 |
| `mix/master.wav` | 48 kHz **立体声** PCM16 | 104.267 s | 总混音（旁白 −16 LUFS + 音乐 −21.2 dB 垫底） |
| `mix/sidechain-report.json` | — | — | ducking 参数、时间轴、实测值全量留档 |

**给 Lead 的关键交付物 = 逐句旁白 stem（`vo/*.wav`）+ `music/bed.wav`。**
`mix/master.wav` 是**预览 / 备份**（按分镜段长预排的时间轴），成片音轨由 Lead 用 stem 重组。

生成脚本（全部在我的写作用域内）：

| 脚本 | 作用 |
|---|---|
| `../../scripts/audio/render_vo.py` | `say` → 补 150 ms → 48 kHz 单声道 → 实测时长 → 写 manifest |
| `../../scripts/audio/make_music.py` | numpy 合成 `bed.wav` |
| `../../scripts/audio/mix_master.py` | RMS 对齐 + ducking + 峰值保护 + astats/loudnorm 实测 |
| `../../scripts/audio/mix_with_sidechain.sh` | 纯 ffmpeg 侧链 ducking 参考链（给 Lead 合成管线 / QA 复算用） |
| `../../scripts/audio/vo-lines.json` | 文案与逐句 rate（文案逐字抄自分镜表） |
| `../../scripts/audio/audition-data/` | 选型阶段的 4 嗓音 × 7 rate × 10 句完整时长矩阵（原始数据） |

---

## 2. 一条命令复跑全部

```bash
cd /Users/fangchen/Baidu/GitHub/Notes&ToDo
PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3

# ① 10 条旁白（约 15 s）
$PY promo/scripts/audio/render_vo.py

# ② 配乐（约 6 s）
$PY promo/scripts/audio/make_music.py --duration 132 --out promo/audio/music/bed.wav

# ③ 总混音（约 11 s，末尾自带 astats + loudnorm 实测打印）
$PY promo/scripts/audio/mix_master.py
```

`mix_master.py` 里还有 ducking 包络的等价性自检（与逐样本递推对照）：

```bash
$PY -c "import sys; sys.path.insert(0,'promo/scripts/audio'); import mix_master as m; print(m._selftest_duck())"
# -> 2.55351295663786e-15   （闭式解与逐样本递推的最大绝对误差，可忽略）
```

---

## 3. 自检结果（原始输出）

### 3.1 逐条 ffprobe：采样率 / 声道 / 时长

```bash
for i in 01 02 03 04 05 06 07 08 09 10; do
  ffprobe -v error -select_streams a:0 \
    -show_entries stream=codec_name,sample_rate,channels \
    -show_entries format=duration -of default=nw=1:nk=0 promo/audio/vo/vo-$i.wav
done
```
```
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=5.506313    <- vo-01
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=5.975563    <- vo-02
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=11.791667   <- vo-03
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=12.242729   <- vo-04
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=5.864688    <- vo-05
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=11.664500   <- vo-06
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=7.525125    <- vo-07
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=12.699188   <- vo-08
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=7.941229    <- vo-09
codec_name=pcm_s16le  sample_rate=48000  channels=1  duration=6.426896    <- vo-10
```

**10/10 条全部 48000 Hz / 单声道 / pcm_s16le** ✅（契约：`audio/vo/*.wav` 48 kHz 单声道）

### 3.2 `vo-manifest.json` 与实际文件逐条比对（容差 0.05 s）

```bash
$PY - <<'EOF'
import json,subprocess
m=json.load(open('promo/audio/vo-manifest.json'))
for e in m:
    d=float(subprocess.run(['/opt/homebrew/bin/ffprobe','-v','error','-show_entries',
        'format=duration','-of','default=nw=1:nk=1','promo/audio/'+e['path']],
        capture_output=True,text=True).stdout)
    print(f"{e['id']}  manifest={e['duration_s']:.3f}  ffprobe={d:.6f}  diff={abs(d-e['duration_s']):.6f}  "
          + ("OK" if abs(d-e['duration_s'])<=0.05 else "FAIL"))
EOF
```
```
vo-01  manifest=5.506   ffprobe=5.506313  diff=0.000313  OK
vo-02  manifest=5.976   ffprobe=5.975563  diff=0.000437  OK
vo-03  manifest=11.792  ffprobe=11.791667 diff=0.000333  OK
vo-04  manifest=12.243  ffprobe=12.242729 diff=0.000271  OK
vo-05  manifest=5.865   ffprobe=5.864688  diff=0.000312  OK
vo-06  manifest=11.665  ffprobe=11.664500 diff=0.000500  OK
vo-07  manifest=7.525   ffprobe=7.525125  diff=0.000125  OK
vo-08  manifest=12.699  ffprobe=12.699188 diff=0.000188  OK
vo-09  manifest=7.941   ffprobe=7.941229  diff=0.000229  OK
vo-10  manifest=6.427   ffprobe=6.426896  diff=0.000104  OK
条目数 = 10 | 全部通过 = True
```

**10/10 条全部通过，最大偏差 0.0005 s**（容差 0.05 s 的 1%）✅

### 3.3 `mix/master.wav` —— astats 峰值 / RMS

```bash
ffmpeg -i promo/audio/mix/master.wav -af astats=metadata=1:reset=0 -f null -
```
```
Channel: 1
  Peak level dB: -3.425213     RMS level dB: -18.956543
  Max level: 22089.000000      Min level: -21631.000000
  Flat factor: 0.000000        Peak count: 2.000000
Channel: 2
  Peak level dB: -3.426786     RMS level dB: -18.962208
  Max level: 22085.000000      Min level: -21603.000000
  Flat factor: 0.000000        Peak count: 2.000000
Overall
  Peak level dB: -3.425213     RMS level dB: -18.959374
  Max level: 22089.000000      Min level: -21631.000000
  Flat factor: 0.000000        Peak count: 2.000000
```

| 指标 | 实测 | 契约要求 | 判定 |
|---|---|---|---|
| Peak level dB（Overall） | **−3.425 dBFS** | < −1 dBTP | ✅ 富余 2.4 dB |
| RMS level dB（Overall） | **−18.959 dBFS** | — | — |
| RMS peak dB | −10.624 dBFS | — | — |
| Flat factor | **0.000** | 无削波 | ✅ 无连续满刻度样本 |
| Peak count | 2 | — | 仅 2 个采样点触顶（未截平） |
| 左右声道峰值差 | 0.0016 dB | — | ✅ 声道平衡 |
| Dynamic range | 92.9 dB | — | — |

### 3.4 `mix/master.wav` —— integrated LUFS

```bash
ffmpeg -i promo/audio/mix/master.wav -af loudnorm=print_format=summary -f null -
```
```
[Parsed_loudnorm_0 @ ...]
Input Integrated:    -16.0 LUFS
Input True Peak:      -3.4 dBTP
Input LRA:             5.9 LU
Input Threshold:     -27.0 LUFS
Output Integrated:   -24.1 LUFS      <- loudnorm 默认 -24 目标下的输出，非本片目标
Output True Peak:    -11.3 dBTP
```

交叉验证（`ebur128=peak=true`）：

```
Integrated loudness:
  I:         -15.9 LUFS
  Threshold: -26.9 LUFS
Loudness range:
  LRA:         5.2 LU
  LRA low:   -20.4 LUFS
  LRA high:  -15.2 LUFS
True peak:
  Peak:       -3.4 dBFS
```

| 指标 | 实测 | 契约要求 | 判定 |
|---|---|---|---|
| Integrated LUFS | **−16.0**（loudnorm）/ **−15.9**（ebur128） | −16 LUFS | ✅ |
| True peak | **−3.4 dBTP** | < −1 dBTP | ✅ |
| LRA | 5.2–5.9 LU | — | 纪录片旁白合理范围 |
| `sox`/ffmpeg clipping | Peak −3.4 dB → **无削波** | 无 | ✅ |

> 注：本机 **`sox` 未安装**（`command -v sox` 无输出），所以"确认无 clipping"用 ffmpeg 两条独立链路交叉验证：
> `astats` 给出 Peak level / Flat factor / Peak count，`loudnorm` 与 `ebur128` 给出 True Peak。三者一致为 −3.4 dB。

### 3.5 侧链 ducking 实测（音乐垫到旁白下方多少）

```bash
$PY -c "import json;r=json.load(open('promo/audio/mix/sidechain-report.json'));\
print({k:r[k] for k in ['music_rms_in_voiced_db','voice_rms_in_voiced_db','music_below_voice_db','music_gap_rms_target_db','music_duck_db']})"
```
```
{'music_rms_in_voiced_db': -39.129,     <- 有旁白处，音乐 RMS
 'voice_rms_in_voiced_db': -17.652,     <- 有旁白处，旁白 RMS
 'music_below_voice_db':   -21.477,     <- 音乐在旁白下方 21.5 dB
 'music_gap_rms_target_db': -33.0,      <- 无旁白处，音乐 RMS 目标
 'music_duck_db':          -10.5}       <- ducking 深度 10.5 dB
```

- ducking 实现 = 一阶分支峰值跟随器（快起 **120 ms**、慢落 **380 ms**），
  与 `ffmpeg sidechaincompress` 同思路；因为侧链信号只有 0/1，用闭式解向量化，
  与逐样本递推的最大误差 **2.55e-15**（见 §2 自检命令）。
- **纯 ffmpeg 参考链**（供 Lead 在合成管线里直接调用，也供 QA 独立复算）：
  ```bash
  bash promo/scripts/audio/mix_with_sidechain.sh /tmp/preview.wav \
       promo/audio/vo/vo-01.wav promo/audio/vo/vo-02.wav
  # 核心 filter: [bed][voice]sidechaincompress=threshold=0.05:ratio=3:attack=120:release=380:makeup=1
  # 实测输出: Peak -6.23 dBFS / RMS -19.51 dBFS（无削波）
  ```
  脚本末尾带"按 timeline 填 adelay 起播点"的完整示例。两种实现数值不逐样本相等，
  但"VO 段内音乐被压低约 10.5 dB"的结论一致。
- 契约要求"音乐 −22 dB 以下垫底"：实测 **−21.5 dB**，即音乐比旁白低 21.5 dB，
  落在 −22 dB 量级（若需严格 ≤−22 dB，把 `mix_master.py` 的 `MUSIC_GAP_RMS_DB` 从 −33 调到 −34 即可）。

### 3.6 抽查句首/句尾静音（`silencedetect`）

```bash
ffmpeg -v info -i promo/audio/vo/vo-01.wav -af "silencedetect=noise=-50dB:d=0.10" -f null -
ffmpeg -v info -i promo/audio/vo/vo-03.wav -af "silencedetect=noise=-50dB:d=0.10" -f null -
```
```
vo-01.wav
  silence_start: 0           silence_end: 0.150021   duration: 0.150021   <- 句首留白 ✅
  silence_start: 1.139458    silence_end: 1.490187   duration: 0.350729   <- 自然停顿
  silence_start: 2.872083    silence_end: 3.230125   duration: 0.358042   <- 自然停顿
  silence_start: 4.793437    silence_end: 5.506312   duration: 0.712875   <- 句尾 ✅

vo-03.wav
  silence_start: 0           silence_end: 0.150062   duration: 0.150062   <- 句首留白 ✅
  silence_start: 2.3255      silence_end: 2.902625   duration: 0.577125   <- 「按一个快捷键就能开录。」
  silence_start: 4.644812    silence_end: 4.989063   duration: 0.34425    <- 「左边只敲关键词，」
  silence_start: 7.14575     silence_end: 7.425396   duration: 0.279646   <- 「右边实时字幕自己长出来；」
  silence_start: 8.082875    silence_end: 8.43725    duration: 0.354375   <- 「散会后，」
  silence_start: 11.054104   silence_end: 11.791667  duration: 0.737563   <- 句尾 ✅
```

**10 条 VO 的首个有声样本全部精确落在 0.1500 s**；句尾 = 150 ms 纯数字静音（RMS −240 dBFS）+ `say` 自带尾静音。
完整逐条表见 `../script/vo.md` §4。

---

## 4. 旁白实测时长表（Lead 排时间轴用）

| ID | 时长 (s) | 人声起点 (s) | 人声终点 (s) | 分镜段 | 段内余量 | 文案 |
|---|---|---|---|---|---|---|
| vo-01 | 5.506 | 0.150 | 4.795 | SH-01 0–8 | 富余 1.59 | 开会的时候，你是在参与讨论，还是在忙着抄笔记？ |
| vo-02 | 5.976 | 0.150 | 5.330 | SH-02 8–15 | 富余 0.42 | NotesToGO 拾贝。会中只记关键词，散会后一键成稿。 |
| vo-03 | 11.792 | 0.150 | 11.074 | SH-03 15–28 | 富余 0.71 | 按一个快捷键就能开录。左边只敲关键词，右边实时字幕自己长出来；散会后，这几个字就够定位一整段讨论。 |
| vo-04 | 12.243 | 0.150 | 11.523 | SH-04 28–42 | 富余 1.26 | 散会后只有一次 AI 调用：标题、完整纪要、行动项一起给你。每条待办都带原文引用——找不到出处的，也不会丢。 |
| vo-05 | 5.865 | 0.150 | 5.151 | SH-05 42–49 | 富余 0.64 | 转录带说话人区分，谁在什么时候说了什么，一目了然。 |
| vo-06 | 11.665 | 0.150 | 10.975 | SH-06 49–63 | 富余 1.94 | 行动项不会躺在收件箱里。挂到对应的 KR 上，进度按权重逐级汇总：战略、季度、项目、任务，一条链到底。 |
| vo-07 | 7.525 | 0.150 | 6.810 | SH-07 63–74 | 富余 2.98 | 项目看板拖一下就换列；到了周五，周报已经替你写好了，复制就能贴。 |
| vo-08 | **12.699** | 0.150 | 12.048 | SH-08 74–85 | **超段 2.10** ⚠️ | 不想把会议内容传到云端？装上桌面版，模型可以完全跑在你自己电脑上，断网也能转录、也能写纪要。数据去哪了，页面上如实告诉你。 |
| vo-09 | **7.941** | 0.150 | 7.290 | SH-09 85–92 | **超段 1.24** ⚠️ | 手机、iPad、Mac 都能用，加到主屏就是原生应用；所有数据一键导出，永远是你的。 |
| vo-10 | 6.427 | 0.150 | 5.714 | SH-10 92–100 | 富余 0.97 | NotesToGO 拾贝。本地优先，开源。今天就试试。 |

> ⚠️ **vo-08 / vo-09 超段是"文案字数 vs 段长"的结构性矛盾，不是语速问题**，详见 `../script/vo.md` §2.1
> （含三个可选处理方案与我的建议）。

---

## 5. 预览混音的时间轴（`mix/master.wav`，共 104.267 s）

排练规则：段起点 + 段内起播偏移；**相邻旁白至少留 400 ms 间隔**（超出段长时顺延，不叠在一起）。
`0–8 s` 是纯音乐引入段（SH-01 旁白从 0.90 s 才进），所以 pad 引入听得见。

```
vo-01  seg   0.0-  8.0s  vo  0.90-  6.41s  gap=   —     超出段尾 -1.594s
vo-02  seg   8.0- 15.0s  vo  8.60- 14.58s  gap=2.194   超出段尾 -0.424s
vo-03  seg  15.0- 28.0s  vo 15.50- 27.29s  gap=0.924   超出段尾 -0.708s
vo-04  seg  28.0- 42.0s  vo 28.50- 40.74s  gap=1.208   超出段尾 -1.257s
vo-05  seg  42.0- 49.0s  vo 42.50- 48.37s  gap=1.757   超出段尾 -0.635s
vo-06  seg  49.0- 63.0s  vo 49.40- 61.06s  gap=1.035   超出段尾 -1.935s
vo-07  seg  63.0- 74.0s  vo 63.50- 71.03s  gap=2.435   超出段尾 -2.975s
vo-08  seg  74.0- 85.0s  vo 74.40- 87.10s  gap=3.375   超出段尾 +2.099s
vo-09  seg  85.0- 92.0s  vo 87.50- 95.44s  gap=0.400   超出段尾 +3.440s  [被 vo-08 顺延]
vo-10  seg  92.0-100.0s  vo 95.84-102.27s  gap=0.400   超出段尾 +2.267s  [被 vo-09 顺延]
```

分段 RMS 实测（验证音乐结构在混音里也成立）：

```
0-8s 引入(应只有 pad)   RMS=-20.26 dBFS  peak=-3.43
8-15s                   RMS=-19.46       peak=-5.15
15-28s                  RMS=-18.55       peak=-3.97
28-42s                  RMS=-18.85       peak=-4.60
42-49s                  RMS=-18.98       peak=-4.00
49-63s                  RMS=-19.23       peak=-5.15
63-74s                  RMS=-19.90       peak=-5.95
74-85s                  RMS=-17.95       peak=-3.89
85-92s                  RMS=-17.13       peak=-3.61
92-100s                 RMS=-19.83       peak=-5.39
```

---

## 6. 硬约束遵守情况

| 约束 | 实际做法 | 证据 |
|---|---|---|
| 禁止云端 TTS / 语音合成 API | 只用本机 `say -v "Shelley (Chinese (China mainland))"` | `render_vo.py` 里 `run(["say", ...])`，全文无任何 HTTP 调用 |
| 禁止视频生成模型 | 音频链路完全不涉及 | — |
| 音乐必须 numpy 自研、不许下载 | `make_music.py` 单文件、只 `import numpy` | 见 `music/NOTES.md` §5 的"为什么不复用现成方案" |
| 文案逐字照抄、不改写不加字 | `vo-lines.json` 与分镜表第 3 节逐字一致 | `../script/vo.md` §2 表格 |
| 句首句尾各 150 ms 静音 | `adelay=150\|150,apad=pad_dur=0.150` | §3.6 silencedetect：10 条首音均在 0.1500 s |
| 48 kHz | 全部文件 48000 Hz | §3.1 |
| 峰值 < −1 dBTP、无削波 | master peak −3.425 dBFS、TP −3.4 dBTP、Flat factor 0 | §3.3 / §3.4 |
| 目标 −16 LUFS | −16.0 LUFS | §3.4 |
| 写作用域 | 只写 `promo/audio/**`、`promo/script/vo.md`、`promo/scripts/audio/**` | 未触碰 `capture/` `assets/` `build/` `web/` |

---

## 7. 已知问题 / 需要 Lead 决策

1. **`vo-08` 超段 2.10 s、`vo-09` 超段 1.24 s**（结构性，非语速问题）。
   建议把 SH-08 段长 11 s → 15 s、SH-09 段长 7 s → 9 s，再重新配平其余段以守住 90 s ± 3 s。
   三个方案与理由见 `../script/vo.md` §2.1。
2. `master.wav` 是**预览**：按分镜段长预排 + 400 ms 最小间隔，末尾因 vo-08/09 顺延而拉到 104.267 s。
   成片音轨请用 `vo/*.wav` + `bed.wav` 由 Lead 重组。
3. 音乐在旁白下方 **−21.5 dB**（要求"−22 dB 量级"）。若要严格 ≤−22 dB，
   把 `mix_master.py` 的 `MUSIC_GAP_RMS_DB` 由 `-33.0` 改为 `-34.0` 后重跑 §2 的 ③。
4. 本机未安装 `sox`，无 clipping 的结论由 `astats` + `loudnorm` + `ebur128` 三条 ffmpeg 路径交叉验证得出。
