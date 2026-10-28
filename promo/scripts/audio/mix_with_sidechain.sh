#!/usr/bin/env bash
# NotesToGO · 拾贝 —— ffmpeg 原生侧链 ducking 参考链（给 Lead 的合成管线用）
#
# 作用：用 **纯 ffmpeg** 复现 promo/scripts/audio/mix_master.py 里的 ducking 行为，
#       供 Lead 在 build/render.py 里直接调用，也供 QA 独立复算"音乐在旁白下方多少 dB"。
#
# 与 numpy 版的关系：
#   numpy 版 = 一阶分支峰值跟随器（attack 120ms / release 380ms，闭式解向量化）
#   本脚本   = ffmpeg sidechaincompress，同样的快起慢落思路，用 threshold/ratio 近似同一深度
#   两者数值不必逐样本相等，但"VO 段内音乐被压低约 10.5 dB"这一结论应一致。
#
# 用法：
#   bash promo/scripts/audio/mix_with_sidechain.sh <out.wav> <vo1.wav> [vo2.wav ...]
#   例（按 build/timeline.json 的起播点摆放 stem 后）：
#   bash promo/scripts/audio/mix_with_sidechain.sh /tmp/preview.wav \
#        promo/audio/vo/vo-01.wav promo/audio/vo/vo-02.wav ...
#
# 注意：本脚本只搭"旁白总线 + bed + ducking"的骨架，
#       **具体每个 stem 的 adelay 起播点由 build/timeline.json 决定**，见文件末尾示例。

set -euo pipefail

FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OUT="${1:?用法: mix_with_sidechain.sh <out.wav> <vo1.wav> [vo2.wav ...]}"
shift
BED="${BED:-$ROOT/audio/music/bed.wav}"

[ -f "$BED" ] || { echo "找不到 bed: $BED" >&2; exit 1; }
[ "$#" -ge 1 ] || { echo "至少给一个 VO stem" >&2; exit 1; }
for f in "$@"; do [ -f "$f" ] || { echo "找不到 stem: $f" >&2; exit 1; }; done

# ---- 1) 把所有 VO stem 混成一条"旁白总线"（单声道 -> 立体声）
#         这里假设调用方已经按时间轴把 stem 摆好（各自文件里已含正确的 adelay）。
#         若 stem 是原始逐句文件，请改用文件末尾的"带 adelay 的完整示例"。
ARGS=()
for f in "$@"; do ARGS+=(-i "$f"); done
N=$#

VOICE_FILTER=""
for i in $(seq 0 $((N - 1))); do
  VOICE_FILTER="${VOICE_FILTER}[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[v${i}];"
done
VOICE_FILTER="${VOICE_FILTER}$(for i in $(seq 0 $((N - 1))); do printf '[v%d]' "$i"; done)"
VOICE_FILTER="${VOICE_FILTER}amix=inputs=${N}:duration=longest:normalize=0,"
VOICE_FILTER="${VOICE_FILTER}aformat=channel_layouts=stereo[voice]"

# ---- 2) bed 侧链压缩：快起 120ms / 慢落 380ms，深度约 10.5 dB
#         threshold 0.05 ≈ -26 dBFS（旁白总线 RMS 约 -20 dBFS 时的起控点）
#         ratio 3 + makeup 1 得到约 -10.5 dB 的稳态压缩量
#         level_sc 用旁白自身做侧链键
DUCK_FILTER="[${N}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[bed];\
[bed][voice]sidechaincompress=threshold=0.05:ratio=3:attack=120:release=380:\
makeup=1:level_sc=1:mode=downward[bedduck]"

# ---- 3) 旁白 + 被压低的 bed 相加，再留 1 dB 峰值余量
MIX_FILTER="[voice][bedduck]amix=inputs=2:duration=longest:normalize=0,\
volume=-1dB,alimiter=limit=0.891:level=disabled[out]"

"$FFMPEG" -hide_banner -y "${ARGS[@]}" -i "$BED" \
  -filter_complex "${VOICE_FILTER};${DUCK_FILTER};${MIX_FILTER}" \
  -map "[out]" -ar 48000 -ac 2 -c:a pcm_s16le "$OUT"

echo "写出: $OUT"

# ---------------------------------------------------------------------------
# 带 adelay 的完整示例（Lead 按 build/timeline.json 填起播秒数即可）
#
# ffmpeg -y \
#   -i promo/audio/vo/vo-01.wav -i promo/audio/vo/vo-02.wav \
#   -i promo/audio/music/bed.wav \
#   -filter_complex "\
#     [0:a]adelay=900|900,volume=1.0[v0];\
#     [1:a]adelay=8600|8600,volume=1.0[v1];\
#     [v0][v1]amix=inputs=2:duration=longest:normalize=0,aformat=channel_layouts=stereo[voice];\
#     [2:a]aformat=channel_layouts=stereo,volume=-21.5dB[bed];\
#     [bed][voice]sidechaincompress=threshold=0.05:ratio=3:attack=120:release=380:makeup=1[bedduck];\
#     [voice][bedduck]amix=inputs=2:duration=longest:normalize=0,volume=-1dB,\
#       alimiter=limit=0.891:level=disabled[out]" \
#   -map "[out]" -ar 48000 -ac 2 -c:a pcm_s16le promo/audio/mix/preview-from-stems.wav
#
# 起播秒数取自 promo/audio/vo-manifest.json 的 duration_s 与 build/timeline.json；
# 提醒：vo-08 需 12.699s、vo-09 需 7.941s，SH-08/SH-09 原段长装不下，见 audio/README.md §7。
# ---------------------------------------------------------------------------
