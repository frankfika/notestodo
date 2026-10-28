#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NotesToGO 宣传片 · 验收工具（QA 独立复核）
=========================================

对 promo/STORYBOARD.md 第 5 节 7 条验收标准做**可自动化**部分的实测。
不猜测、不"看起来没问题"：所有结论均来自 ffprobe / ffmpeg 实测输出，并原样存档。

用法
----
  # 1) 单个视频全量检查（规格 + faststart + 响度/峰值 + 抽帧 + 品牌色）
  python3 promo/qa/check_spec.py check promo/build/out/notestogo-promo-16x9.mp4

  # 2) 三个交付物一起查
  python3 promo/qa/check_spec.py check promo/build/out/*.mp4

  # 3) 每 5 秒抽帧 + 10 个分镜各抽一帧（中点位）
  python3 promo/qa/check_spec.py check --every 5 --shots promo/build/out/notestogo-promo-16x9.mp4

  # 4) 音画同步（字幕起点 vs VO 在成片中的实测起点）
  python3 promo/qa/check_spec.py sync --video promo/build/out/notestogo-promo-16x9.mp4 \
        --srt promo/script/subtitles-zh.srt

  # 5) 自检（合成一段 6s 测试视频，跑通整条流水线；成片未渲染时用这个证明工具可用）
  python3 promo/qa/check_spec.py selftest

  # 6) 检查渲染脚本里的、无法从成片反查的参数（-crf 18 / +faststart / -r 30）
  python3 promo/qa/check_spec.py renderflags promo/build/render.sh

判定
----
  PASS / FAIL / WARN / SKIP。存在 FAIL 时退出码 = 1。
  每条检查都有 `evidence`（原始命令 + 原始输出片段），落盘到 promo/qa/results/<name>.json。

阈值来源：STORYBOARD.md 第 1、5 节。凡属**推导**而非契约明写的阈值，标注 `derived()`。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Optional

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

QA_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(os.path.dirname(QA_DIR))
FRAMES_DIR = os.path.join(QA_DIR, "frames")
RESULTS_DIR = os.path.join(QA_DIR, "results")

PASS, FAIL, WARN, SKIP, INFO = "PASS", "FAIL", "WARN", "SKIP", "INFO"


# ────────────────────────────────────────────────────────────────────────────
# 契约真值（promo/STORYBOARD.md 第 1 节 + 第 2 节）
# ────────────────────────────────────────────────────────────────────────────

# 品牌色：STORYBOARD §2 给出 #C0571E / #FBF8F2。
# 实测校验：web/src/styles/main.css:20 `--accent: oklch(58% 0.15 45)` == #C0571E（精确）。
#           web/src/styles/main.css:10 `--bg: oklch(97.9% 0.009 85)` == #FBF8F1（与契约差 1/255）。
BRAND_ACCENT = (0xC0, 0x57, 0x1E)
BRAND_PAPER = (0xFB, 0xF8, 0xF2)

# 分镜表（STORYBOARD §3）：SH id → (start_s, end_s)，用于 --shots 定点抽帧
SHOTS: list[tuple[str, float, float]] = [
    ("SH-01", 0.0, 8.0),
    ("SH-02", 8.0, 15.0),
    ("SH-03", 15.0, 28.0),
    ("SH-04", 28.0, 42.0),
    ("SH-05", 42.0, 49.0),
    ("SH-06", 49.0, 63.0),
    ("SH-07", 63.0, 74.0),
    ("SH-08", 74.0, 85.0),
    ("SH-09", 85.0, 92.0),
    ("SH-10", 92.0, 100.0),
]


@dataclass
class Spec:
    key: str
    label: str
    width: int
    height: int
    fps: float
    pix_fmt: str
    vcodec: str
    vprofile: Optional[str]
    audio_required: bool
    acodec: str
    sample_rate: int
    channels: int
    dur_min: float
    dur_max: float
    dur_target: float


SPECS: dict[str, Spec] = {
    "16x9": Spec("16x9", "主片 16:9", 1920, 1080, 30.0, "yuv420p", "h264", "High",
                 True, "aac", 48000, 2, 87.0, 93.0, 90.0),
    "9x16": Spec("9x16", "竖版 9:16", 1080, 1920, 30.0, "yuv420p", "h264", "High",
                 True, "aac", 48000, 2, 57.0, 63.0, 60.0),
    # 无旁白版：仍有配乐音轨，故 has_audio 期望 True，但缺失只记 WARN（不阻塞交付）
    "novo": Spec("novo", "无旁白版", 1920, 1080, 30.0, "yuv420p", "h264", "High",
                 True, "aac", 48000, 2, 87.0, 93.0, 90.0),
}

# 第 6 条：字幕与 VO 偏差上限（s）
SYNC_TOLERANCE_S = 0.300
# 第 6 条：真峰值上限（dBTP），要求 < -1.0
TRUE_PEAK_LIMIT_DBTP = -1.0
# 第 1 节：目标响度 -16 LUFS。契约未写明容差 → 推导阈值 ±2 LU。
LOUDNESS_TARGET_LUFS = -16.0
LOUDNESS_TOLERANCE_LU = 2.0  # derived()


def derived(why: str) -> str:
    return f"derived(): {why}"


# ────────────────────────────────────────────────────────────────────────────
# 基础设施
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class Check:
    id: str
    title: str
    status: str
    detail: str = ""
    expected: str = ""
    actual: str = ""
    command: str = ""
    evidence: str = ""

    def line(self) -> str:
        icon = {PASS: "✅", FAIL: "❌", WARN: "⚠️ ", SKIP: "⏭️ ", INFO: "ℹ️ "}[self.status]
        s = f"{icon} [{self.status}] {self.id} {self.title}"
        if self.actual:
            s += f"\n      实测 : {self.actual}"
        if self.expected:
            s += f"\n      期望 : {self.expected}"
        if self.detail:
            s += f"\n      说明 : {self.detail}"
        return s


@dataclass
class Report:
    target: str
    spec_key: str
    checks: list[Check] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def add(self, c: Check) -> Check:
        self.checks.append(c)
        return c

    @property
    def worst(self) -> str:
        if any(c.status == FAIL for c in self.checks):
            return FAIL
        if any(c.status == WARN for c in self.checks):
            return WARN
        return PASS

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "spec": self.spec_key,
            "worst": self.worst,
            "meta": self.meta,
            "checks": [asdict(c) for c in self.checks],
        }


def run(cmd: list[str], timeout: int = 600) -> tuple[int, str]:
    """执行命令，返回 (rc, 合并输出)。失败不抛异常，交给调用方判定。"""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or "") + (p.stderr or "")
        return p.returncode, out
    except FileNotFoundError as e:
        return 127, f"command not found: {e}"
    except subprocess.TimeoutExpired:
        return 124, f"timeout after {timeout}s: {' '.join(cmd)}"


def shq(parts: Iterable[str]) -> str:
    return " ".join(parts)


# ────────────────────────────────────────────────────────────────────────────
# 1) ffprobe 规格
# ────────────────────────────────────────────────────────────────────────────

def ffprobe_json(path: str) -> dict[str, Any]:
    rc, out = run([FFPROBE, "-v", "error", "-print_format", "json",
                   "-show_format", "-show_streams", path])
    if rc != 0:
        raise RuntimeError(f"ffprobe 失败 rc={rc}: {out[:800]}")
    return json.loads(out)


def parse_fps(s: str) -> float:
    if not s:
        return 0.0
    if "/" in s:
        a, b = s.split("/", 1)
        try:
            b_f = float(b)
            return float(a) / b_f if b_f else 0.0
        except ValueError:
            return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def check_container(rep: Report, path: str, probe: dict[str, Any], spec: Spec) -> None:
    streams = probe.get("streams", [])
    fmt = probe.get("format", {})
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(fmt.get("duration") or (v or {}).get("duration") or 0.0)
    rep.meta["duration_s"] = round(duration, 4)
    rep.meta["size_bytes"] = int(fmt.get("size") or 0)
    rep.meta["n_audio_streams"] = sum(1 for s in streams if s.get("codec_type") == "audio")
    rep.meta["n_video_streams"] = sum(1 for s in streams if s.get("codec_type") == "video")

    cmd = f'{FFPROBE} -v error -print_format json -show_format -show_streams "{path}"'

    # ── 分辨率 ──
    if v is None:
        rep.add(Check("S1.1", "视频流存在", FAIL, detail="ffprobe 未发现 video stream",
                      command=cmd, evidence=json.dumps(fmt)[:400]))
    else:
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        st = PASS if (w, h) == (spec.width, spec.height) else FAIL
        rep.add(Check("S1.1", "分辨率", st, command=cmd,
                      expected=f"{spec.width}x{spec.height}",
                      actual=f"{w}x{h}",
                      evidence=json.dumps({k: v.get(k) for k in
                                           ("codec_name", "profile", "width", "height",
                                            "pix_fmt", "r_frame_rate", "avg_frame_rate",
                                            "nb_frames", "bit_rate")}, ensure_ascii=False)))

        # ── 帧率 ──
        r_fps = parse_fps(v.get("r_frame_rate", ""))
        avg_fps = parse_fps(v.get("avg_frame_rate", ""))
        ok = abs(r_fps - spec.fps) <= 0.05 and (avg_fps == 0 or abs(avg_fps - spec.fps) <= 0.05)
        rep.add(Check("S1.2", "帧率", PASS if ok else FAIL, command=cmd,
                      expected=f"{spec.fps} fps (r_frame_rate=avg_frame_rate)",
                      actual=f"r_frame_rate={v.get('r_frame_rate')} ({r_fps:.3f}) "
                             f"avg_frame_rate={v.get('avg_frame_rate')} ({avg_fps:.3f})",
                      detail="" if ok else "帧率不符或 r/avg 不一致（VFR）"))

        # ── 像素格式 ──
        pf = v.get("pix_fmt", "")
        rep.add(Check("S1.3", "像素格式", PASS if pf == spec.pix_fmt else FAIL, command=cmd,
                      expected=spec.pix_fmt, actual=pf))

        # ── 编码 ──
        vc = v.get("codec_name", "")
        prof = v.get("profile", "")
        ok = vc == spec.vcodec and (not spec.vprofile or prof == spec.vprofile)
        rep.add(Check("S1.4", "视频编码 / profile", PASS if ok else FAIL, command=cmd,
                      expected=f"{spec.vcodec} / profile={spec.vprofile}",
                      actual=f"{vc} / profile={prof}",
                      detail=derived("CRF 无法从成片反查，请用 `check_spec.py renderflags` 核对渲染脚本")))

    # ── has_audio / 音频参数 ──
    if a is None:
        st = FAIL if spec.audio_required else WARN
        rep.add(Check("S1.5", "has_audio", st, command=cmd,
                      expected="存在 audio stream", actual="无 audio stream",
                      evidence=json.dumps(fmt, ensure_ascii=False)[:400]))
    else:
        rep.add(Check("S1.5", "has_audio", PASS, command=cmd,
                      expected="存在 audio stream", actual="存在 (1 条)"))
        sr = int(a.get("sample_rate") or 0)
        ch = int(a.get("channels") or 0)
        ac = a.get("codec_name", "")
        ok = sr == spec.sample_rate and ch == spec.channels and ac == spec.acodec
        rep.add(Check("S1.6", "音频编码 / 采样率 / 声道", PASS if ok else FAIL, command=cmd,
                      expected=f"{spec.acodec} {spec.sample_rate}Hz {spec.channels}ch",
                      actual=f"{ac} {sr}Hz {ch}ch",
                      evidence=json.dumps({k: a.get(k) for k in
                                           ("codec_name", "profile", "sample_rate", "channels",
                                            "channel_layout", "bit_rate")}, ensure_ascii=False)))

    # ── 时长 ──
    if duration <= 0:
        rep.add(Check("S1.7", "时长", FAIL, command=cmd,
                      expected=f"{spec.dur_min}–{spec.dur_max}s",
                      actual=f"无法解析 ({duration})"))
    else:
        ok = spec.dur_min <= duration <= spec.dur_max
        rep.add(Check("S1.7", "时长", PASS if ok else FAIL, command=cmd,
                      expected=f"{spec.dur_target}s ± 3s → [{spec.dur_min}, {spec.dur_max}]s",
                      actual=f"{duration:.3f}s",
                      detail=f"与目标偏差 {duration - spec.dur_target:+.3f}s"))


# ────────────────────────────────────────────────────────────────────────────
# 2) faststart：直接解析 MP4 box 顺序（不依赖 ffmpeg 自述）
# ────────────────────────────────────────────────────────────────────────────

def top_level_boxes(path: str) -> list[tuple[str, int, int]]:
    """返回 [(type, offset, size)]，只解析顶层 box。size==0 表示到文件结尾。"""
    boxes: list[tuple[str, int, int]] = []
    fsize = os.path.getsize(path)
    with open(path, "rb") as f:
        off = 0
        while off + 8 <= fsize:
            f.seek(off)
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            size = struct.unpack(">I", hdr[:4])[0]
            btype = hdr[4:8].decode("latin-1", "replace")
            body = 8
            if size == 1:  # 64-bit largesize
                ext = f.read(8)
                if len(ext) < 8:
                    break
                size = struct.unpack(">Q", ext)[0]
                body = 16
            elif size == 0:
                size = fsize - off
            if size < body:
                break
            if all(32 <= ord(c) < 127 for c in btype):
                boxes.append((btype, off, size))
            off += size
    return boxes


def check_faststart(rep: Report, path: str) -> None:
    boxes = top_level_boxes(path)
    types = [b[0] for b in boxes]
    moov = next((b for b in boxes if b[0] == "moov"), None)
    mdat = next((b for b in boxes if b[0] == "mdat"), None)
    ev = json.dumps([{"type": t, "offset": o, "size": s} for t, o, s in boxes],
                    ensure_ascii=False)
    cmd = f'python3 -c "…top_level_boxes(\'{path}\')…"   # 纯 Python 解析 mp4 顶层 box'
    if moov is None:
        rep.add(Check("S2.1", "faststart (moov 在文件头)", FAIL, command=cmd,
                      expected="moov 存在且位于 mdat 之前", actual="未找到 moov box", evidence=ev))
        return
    i_moov, i_mdat = types.index("moov"), (types.index("mdat") if mdat else 10**9)
    ok = i_moov < i_mdat
    rep.add(Check("S2.1", "faststart (moov 在文件头)", PASS if ok else FAIL, command=cmd,
                  expected="moov 偏移 < mdat 偏移",
                  actual=f"moov @ {moov[1]} bytes (idx {i_moov}), "
                         f"mdat @ {mdat[1] if mdat else 'n/a'} bytes (idx {i_mdat})",
                  detail=f"moov 占文件 {100.0 * moov[2] / max(1, os.path.getsize(path)):.1f}%；"
                         f"顶层 box 顺序 = {' → '.join(types)}",
                  evidence=ev))


# ────────────────────────────────────────────────────────────────────────────
# 3) 音频：astats 峰值 + loudnorm 响度 + ebur128 真峰值
# ────────────────────────────────────────────────────────────────────────────

def parse_astats_overall(text: str) -> dict[str, str]:
    """解析 astats 的 Overall 段。

    注意：astats 的日志行带 `[Parsed_astats_0 @ 0x...] ` 前缀（实测 ffmpeg 8.0.1），
    因此不能按行首锚定，必须允许 `] ` 前缀。
    """
    out: dict[str, str] = {}
    idx = text.rfind("Overall")
    seg = text[idx:] if idx >= 0 else text
    keys = ("DC offset", "Min level", "Max level", "Peak level dB", "RMS level dB",
            "RMS peak dB", "RMS through dB", "Crest factor", "Flat factor",
            "Peak count", "Abs Peak count", "Noise floor dB", "Noise floor count",
            "Entropy", "Bit depth", "Dynamic range", "Zero crossings",
            "Number of samples", "Number of NaNs", "Number of Infs")
    for key in keys:
        m = re.search(rf"(?:^|\]\s){re.escape(key)}:\s*([^\n]+)$", seg, re.M)
        if m:
            out[key] = m.group(1).strip()
    return out


def check_audio_levels(rep: Report, path: str, spec: Spec, have_audio: bool) -> None:
    if not have_audio:
        rep.add(Check("S6.1", "峰值 / 响度", SKIP, detail="无音轨，跳过"))
        return

    # ── astats ──
    af = "astats=metadata=1:reset=0"
    cmd_astats = f'{FFMPEG} -hide_banner -nostats -i "{path}" -map 0:a:0 -af {af} -f null -'
    rc, out = run([FFMPEG, "-hide_banner", "-nostats", "-i", path,
                   "-map", "0:a:0", "-af", af, "-f", "null", "-"])
    overall = parse_astats_overall(out)
    rep.meta["astats_overall"] = overall

    # ── loudnorm ──
    cmd_ln = (f'{FFMPEG} -hide_banner -nostats -i "{path}" -map 0:a:0 '
              f'-af loudnorm=print_format=json -f null -')
    rc2, out2 = run([FFMPEG, "-hide_banner", "-nostats", "-i", path,
                     "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"])
    ln: dict[str, Any] = {}
    m = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", out2, re.S)
    if m:
        try:
            ln = json.loads(m[-1])
        except json.JSONDecodeError:
            ln = {}
    rep.meta["loudnorm"] = ln

    # ── ebur128（独立第二来源：整合响度 + true peak）──
    cmd_eb = (f'{FFMPEG} -hide_banner -nostats -i "{path}" -map 0:a:0 '
              f'-af ebur128=peak=true -f null -')
    rc3, out3 = run([FFMPEG, "-hide_banner", "-nostats", "-i", path,
                     "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"])
    eb_I = None
    eb_tp = None
    mi = re.findall(r"I:\s*(-?\d+\.\d+)\s*LUFS", out3)
    if mi:
        eb_I = float(mi[-1])
    mtp = re.findall(r"Peak:\s*(-?\d+\.\d+)\s*dBFS", out3)
    if mtp:
        eb_tp = float(mtp[-1])
    rep.meta["ebur128"] = {"integrated_lufs": eb_I, "true_peak_dbfs": eb_tp}

    # 峰值判定（第 6 条：< -1 dBTP）
    tp_candidates = []
    if ln.get("input_tp") not in (None, "", "-inf"):
        try:
            tp_candidates.append(("loudnorm.input_tp", float(ln["input_tp"])))
        except ValueError:
            pass
    if eb_tp is not None:
        tp_candidates.append(("ebur128.Peak", eb_tp))
    if tp_candidates:
        worst_name, worst_tp = max(tp_candidates, key=lambda kv: kv[1])
        ok = worst_tp < TRUE_PEAK_LIMIT_DBTP
        rep.add(Check("S6.1", f"真峰值 true peak < {TRUE_PEAK_LIMIT_DBTP} dBTP",
                      PASS if ok else FAIL,
                      expected=f"< {TRUE_PEAK_LIMIT_DBTP} dBTP",
                      actual=f"{worst_tp:.2f} dBTP (来源 {worst_name})；"
                             + "，".join(f"{n}={v:.2f}" for n, v in tp_candidates),
                      command=f"{cmd_ln}\n{cmd_eb}",
                      evidence=json.dumps(ln, ensure_ascii=False)[:600] + "\n---\n"
                               + "\n".join(l for l in out3.splitlines() if "Peak" in l or "I:" in l)[-600:]))
    else:
        rep.add(Check("S6.1", "真峰值", WARN, detail="loudnorm/ebur128 均未给出数值",
                      command=cmd_ln, evidence=out2[-500:]))

    # 采样峰值（astats，供交叉参考；会漏掉 inter-sample 过载）
    pk = overall.get("Peak level dB")
    rep.add(Check("S6.2", "采样峰值 (astats)", INFO if pk else WARN,
                  expected="参考值（真峰值见 S6.1）",
                  actual=f"Peak level dB = {pk}" if pk else "未解析到",
                  command=cmd_astats,
                  evidence="\n".join(f"{k}: {v}" for k, v in overall.items())))

    # 削波计数（astats 8.0 无 "Number of clips" 字段；用 Peak count + Flat factor 表达）
    clip = overall.get("Peak count")
    flat = overall.get("Flat factor")
    rep.add(Check("S6.3", "削波指示 (astats Peak count / Flat factor)",
                  INFO if clip is not None else WARN,
                  expected="Peak count 反映触顶采样数；Flat factor 显著 >0 提示削波",
                  actual=(f"Peak count = {clip}, Abs Peak count = {overall.get('Abs Peak count')}, "
                          f"Flat factor = {flat}") if clip is not None else "未解析到",
                  command=cmd_astats,
                  evidence="\n".join(f"{k}: {v}" for k, v in overall.items())))

    # 响度（第 1 节目标 -16 LUFS；容差 derived）
    i_lufs = None
    if ln.get("input_i") not in (None, "", "-inf"):
        try:
            i_lufs = float(ln["input_i"])
        except ValueError:
            i_lufs = None
    if i_lufs is None:
        i_lufs = eb_I
    if i_lufs is None:
        rep.add(Check("S1.8", "整合响度", WARN, detail="无法测得 integrated loudness",
                      command=cmd_ln + "\n" + cmd_eb))
    else:
        delta = i_lufs - LOUDNESS_TARGET_LUFS
        st = PASS if abs(delta) <= LOUDNESS_TOLERANCE_LU else (WARN if abs(delta) <= 3.0 else FAIL)
        rep.add(Check("S1.8", "整合响度 (integrated loudness)", st,
                      expected=f"{LOUDNESS_TARGET_LUFS} LUFS ± {LOUDNESS_TOLERANCE_LU} LU",
                      actual=f"{i_lufs:.2f} LUFS（偏差 {delta:+.2f} LU）；"
                             f"ebur128={eb_I if eb_I is None else round(eb_I, 2)} LUFS",
                      detail=derived("STORYBOARD §1 只写目标 -16 LUFS，未给容差；此处取 ±2 LU，"
                                     "超过 ±3 LU 记 FAIL"),
                      command=f"{cmd_ln}\n{cmd_eb}",
                      evidence=json.dumps(ln, ensure_ascii=False)[:600]))


# ────────────────────────────────────────────────────────────────────────────
# 4) 抽帧
# ────────────────────────────────────────────────────────────────────────────

def safe_stem(path: str) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[^A-Za-z0-9._-]+", "_", stem)


def extract_frame(path: str, t: float, out_png: str) -> bool:
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
           "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-q:v", "2", "-y", out_png]
    rc, out = run(cmd, timeout=120)
    if rc != 0 or not os.path.exists(out_png) or os.path.getsize(out_png) < 1024:
        # 回退：精确 seek（慢但可靠）
        cmd2 = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
                "-i", path, "-vf", f"select='gte(t,{t:.3f})'", "-frames:v", "1",
                "-vsync", "0", "-q:v", "2", "-y", out_png]
        rc2, out2 = run(cmd2, timeout=300)
        if rc2 != 0 or not os.path.exists(out_png) or os.path.getsize(out_png) < 1024:
            return False
    return True


def do_frames(rep: Report, path: str, duration: float, every: float,
              shots: bool, extra: list[float], outdir_root: str) -> list[dict[str, Any]]:
    stem = safe_stem(path)
    outdir = os.path.join(outdir_root, stem)
    os.makedirs(outdir, exist_ok=True)

    times: list[tuple[float, str]] = []
    if every and every > 0:
        n = int(math.floor(duration / every))
        for i in range(n + 1):
            t = i * every
            if t < duration - 0.05:
                times.append((t, f"every{every:g}s"))
    if shots:
        for sid, s, e in SHOTS:
            mid = (s + e) / 2.0
            if mid < duration - 0.05:
                times.append((mid, sid))
    for t in extra:
        if 0 <= t < duration:
            times.append((t, "extra"))

    times.sort(key=lambda x: x[0])
    index: list[dict[str, Any]] = []
    fails = 0
    for i, (t, tag) in enumerate(times):
        name = f"{i:03d}_t{t:07.2f}s_{tag}.png"
        dst = os.path.join(outdir, name)
        ok = extract_frame(path, t, dst)
        index.append({"i": i, "t_s": round(t, 3), "tag": tag, "file": os.path.relpath(dst, PROJECT_DIR),
                      "ok": bool(ok)})
        if not ok:
            fails += 1

    with open(os.path.join(outdir, "INDEX.json"), "w", encoding="utf-8") as f:
        json.dump({"video": path, "duration_s": duration, "frames": index}, f,
                  ensure_ascii=False, indent=2)
    with open(os.path.join(outdir, "INDEX.md"), "w", encoding="utf-8") as f:
        f.write(f"# 抽帧索引 · {os.path.basename(path)}\n\n"
                f"时长 {duration:.3f}s，共 {len(index)} 帧。\n\n"
                "| # | 时间(s) | 标签 | 文件 |\n|---|---|---|---|\n")
        for e in index:
            f.write(f"| {e['i']} | {e['t_s']:.2f} | {e['tag']} | `{os.path.basename(e['file'])}` |\n")

    rep.add(Check("S3.0", f"抽帧到 promo/qa/frames/{stem}/",
                  PASS if fails == 0 else WARN,
                  expected=f"全部帧写入成功（每 {every:g}s 一帧"
                           + ("，+ 10 个分镜中点位" if shots else "") + "）",
                  actual=f"{len(index) - fails}/{len(index)} 帧成功；目录 {os.path.relpath(outdir, PROJECT_DIR)}",
                  command=f'{FFMPEG} -ss <t> -i "{path}" -frames:v 1 -q:v 2 <out>.png  # 逐帧',
                  evidence=json.dumps(index[:6], ensure_ascii=False, indent=1)))
    return index


# ────────────────────────────────────────────────────────────────────────────
# 5) 品牌色抽查（Pillow；第 5 条）
# ────────────────────────────────────────────────────────────────────────────

def nearest_dist(rgb: tuple[int, int, int], ref: tuple[int, int, int]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(rgb, ref)))


def check_brand(rep: Report, frames: list[dict[str, Any]], strict: bool) -> None:
    try:
        from PIL import Image
    except Exception as e:
        rep.add(Check("S5.1", "品牌色抽查", SKIP, detail=f"Pillow 不可用: {e}"))
        return
    if np is None:
        rep.add(Check("S5.1", "品牌色抽查", SKIP, detail="numpy 不可用"))
        return
    if not frames:
        rep.add(Check("S5.1", "品牌色抽查", SKIP, detail="无抽帧"))
        return

    rows = []
    accent_hits = 0
    paper_hits = 0
    for e in frames:
        p = os.path.join(PROJECT_DIR, e["file"])
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert("RGB")
        im.thumbnail((480, 480))
        arr = np.asarray(im, dtype=np.int16)
        # 橘色：与 #C0571E 的欧氏距离（抗缩放/编码噪声）
        d_acc = np.sqrt(((arr - np.array(BRAND_ACCENT, dtype=np.int16)) ** 2).sum(axis=2))
        d_pap = np.sqrt(((arr - np.array(BRAND_PAPER, dtype=np.int16)) ** 2).sum(axis=2))
        acc_pct = float((d_acc <= 40).mean() * 100)
        pap_pct = float((d_pap <= 6).mean() * 100)
        acc_hit = acc_pct >= 0.01
        pap_hit = pap_pct >= 1.0
        accent_hits += acc_hit
        paper_hits += pap_hit
        rows.append({"file": os.path.basename(e["file"]), "t_s": e["t_s"], "tag": e["tag"],
                     "accent_%": round(acc_pct, 4), "paper_%": round(pap_pct, 2)})

    n = max(1, len(rows))
    rep.add(Check("S5.1", "品牌橘 #C0571E 出现率", INFO if not strict else
                  (PASS if accent_hits / n >= 0.5 else FAIL),
                  expected="品牌橘在画面中有可测占比（≥0.01% 像素）",
                  actual=f"{accent_hits}/{n} 帧检出（{100.0 * accent_hits / n:.0f}%）",
                  detail=derived("契约未给数值门槛；默认只做 INFO 记录，--strict-brand 时要求 ≥50% 帧检出"),
                  evidence=json.dumps(rows, ensure_ascii=False, indent=1)[:1500]))
    rep.add(Check("S5.2", "纸色底 #FBF8F2 出现率", INFO,
                  expected="纸色为画面主色之一（≥1% 像素）",
                  actual=f"{paper_hits}/{n} 帧检出（{100.0 * paper_hits / n:.0f}%）",
                  detail="屏幕录制分镜（SH-03…08）为真实 UI，纸色占比可能偏低，需人工结合分镜判断",
                  evidence=json.dumps(rows, ensure_ascii=False, indent=1)[:1500]))
    rep.meta["brand_frames"] = rows


# ────────────────────────────────────────────────────────────────────────────
# 6) sync：字幕起点 vs 成片中 VO 的实测起点
# ────────────────────────────────────────────────────────────────────────────

SRT_TIME = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def parse_srt(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    blocks = re.split(r"\n\s*\n", raw.replace("\r\n", "\n").strip())
    out = []
    for b in blocks:
        lines = [l for l in b.split("\n") if l.strip() != ""]
        if not lines:
            continue
        ts_i = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if ts_i is None:
            continue
        a, _, bb = lines[ts_i].partition("-->")
        ma, mb = SRT_TIME.search(a), SRT_TIME.search(bb)
        if not (ma and mb):
            continue

        def to_s(m: re.Match[str]) -> float:
            h, mi, s, ms = (int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4))
            frac = int(ms) / (10 ** len(ms))
            return h * 3600 + mi * 60 + s + frac
        text = " ".join(lines[ts_i + 1:]).strip()
        idx = lines[0].strip() if ts_i > 0 else str(len(out) + 1)
        out.append({"index": idx, "start_s": to_s(ma), "end_s": to_s(mb), "text": text})
    out.sort(key=lambda d: d["start_s"])
    return out


def decode_pcm_mono16k(path: str, stream: Optional[str] = None) -> "np.ndarray":
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path]
    if stream:
        cmd += ["-map", stream]
    cmd += ["-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"解码失败 {path}: {p.stderr.decode('utf-8', 'replace')[:400]}")
    return np.frombuffer(p.stdout, dtype="<f4").astype(np.float64)


def _sliding_sum_sq(x: "np.ndarray", w: int) -> "np.ndarray":
    c = np.concatenate(([0.0], np.cumsum(x * x)))
    return c[w:] - c[:-w]


def locate_vo(mix: "np.ndarray", vo: "np.ndarray") -> dict[str, Any]:
    """用归一化互相关在混音中定位 VO 片段。返回 lag / 置信度 / VO 内部语音起点。"""
    n, m = len(mix), len(vo)
    if m < 160 or n <= m:
        return {"ok": False, "why": f"长度不足 mix={n} vo={m}"}
    size = 1 << int(math.ceil(math.log2(n + m)))
    X = np.fft.rfft(mix, size)
    Y = np.fft.rfft(vo, size)
    cc = np.fft.irfft(X * np.conj(Y), size)[:n - m + 1]
    energy = _sliding_sum_sq(mix, m)
    denom = np.sqrt(np.maximum(energy, 1e-12) * float(np.sum(vo * vo)) + 1e-12)
    ncc = cc / denom
    k = int(np.argmax(ncc))
    # VO 文件自身语音起点（跳过 150ms 静音头，取首个超过峰值 3% 的 20ms 窗）
    peak = float(np.max(np.abs(vo))) or 1.0
    thr = 0.03 * peak
    win = 320  # 20ms @16k
    onset = 0
    ab = np.abs(vo)
    for i in range(0, max(1, m - win), 80):
        if float(ab[i:i + win].mean()) > thr * 0.5:
            onset = i
            break
    return {"ok": True, "lag_s": k / 16000.0, "ncc": float(ncc[k]),
            "vo_onset_in_file_s": onset / 16000.0,
            "vo_speech_start_in_video_s": (k + onset) / 16000.0,
            "search_range_s": (n - m) / 16000.0}


def silencedetect_onsets(path: str, noise_db: float = -30.0, min_dur: float = 0.25) -> list[float]:
    af = f"silencedetect=noise={noise_db}dB:d={min_dur}"
    rc, out = run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0",
                   "-af", af, "-f", "null", "-"], timeout=900)
    onsets = [0.0]
    for m in re.finditer(r"silence_end:\s*([\d.]+)", out):
        onsets.append(float(m.group(1)))
    return onsets


def cmd_sync(args: argparse.Namespace) -> int:
    if np is None:
        print("sync 模式需要 numpy", file=sys.stderr)
        return 2
    video = args.video[0]
    rep = Report(target=video, spec_key="sync")
    rep.meta["srt"] = args.srt
    rep.meta["vo_dir"] = args.vo_dir

    srt = parse_srt(args.srt) if args.srt and os.path.exists(args.srt) else []
    if args.srt and not srt:
        rep.add(Check("S6.4", "解析字幕文件", FAIL, expected=f"可解析 {args.srt}",
                      actual="0 条字幕", command=f"cat {args.srt}"))
    else:
        rep.add(Check("S6.4", "解析字幕文件", PASS if srt else SKIP,
                      expected="≥1 条字幕", actual=f"{len(srt)} 条",
                      command=f'python3 -c "parse_srt(\'{args.srt}\')"',
                      evidence=json.dumps(srt[:3], ensure_ascii=False, indent=1)))

    # 若给了时间轴，**只取该时间轴里出现过的 VO**（按时间轴顺序）。
    # 否则竖版（6 分镜）会把被排除的 vo-02/05/07/09 也拿去配 6 条字幕，
    # 按序号硬配 ⇒ 全部错位、假报大偏差（实测假报 25995ms）。
    tl_shots = None
    if args.timeline and os.path.exists(args.timeline):
        try:
            tl_shots = json.load(open(args.timeline, encoding="utf-8"))["shots"]
        except Exception:
            tl_shots = None

    if tl_shots:
        want_ids = [sh["vo"] for sh in tl_shots]
        vo_files = [os.path.join(args.vo_dir, f"{v}.wav") for v in want_ids
                    if os.path.exists(os.path.join(args.vo_dir, f"{v}.wav"))]
        rep.meta["vo_filtered_by_timeline"] = want_ids
    else:
        vo_files = sorted(
            (os.path.join(args.vo_dir, f) for f in os.listdir(args.vo_dir)
             if re.fullmatch(r"vo-\d+\.wav", f)),
            key=lambda p: int(re.search(r"(\d+)", os.path.basename(p)).group(1))) \
            if args.vo_dir and os.path.isdir(args.vo_dir) else []
    rep.meta["vo_files"] = [os.path.relpath(p, PROJECT_DIR) for p in vo_files]

    mix = decode_pcm_mono16k(video)
    rep.meta["video_audio_samples_16k"] = int(len(mix))
    results = []
    for vp in vo_files:
        vid = os.path.splitext(os.path.basename(vp))[0]
        vo = decode_pcm_mono16k(vp)
        r = locate_vo(mix, vo)
        r["vo_id"] = vid
        results.append(r)
    rep.meta["vo_locations"] = results

    if not vo_files:
        rep.add(Check("S6.5", "定位 VO", SKIP, detail=f"未找到 vo-*.wav（--vo-dir {args.vo_dir}）"))

    # 配对：按顺序把字幕与 VO 一一对应
    pairs = []
    for i, r in enumerate(results):
        if not r.get("ok"):
            continue
        cap = srt[i] if i < len(srt) else None
        declared = None
        if args.timeline and os.path.exists(args.timeline):
            try:
                tl = json.load(open(args.timeline, encoding="utf-8"))
                declared = find_declared_vo_start(tl, r["vo_id"])
            except Exception:
                declared = None
        pairs.append({
            "vo_id": r["vo_id"],
            "measured_vo_start_s": round(r["vo_speech_start_in_video_s"], 3),
            "ncc": round(r["ncc"], 3),
            "srt_start_s": round(cap["start_s"], 3) if cap else None,
            "srt_text": cap["text"] if cap else None,
            "declared_vo_start_s": round(declared, 3) if declared is not None else None,
            "delta_srt_vs_measured_s": round(cap["start_s"] - r["vo_speech_start_in_video_s"], 3)
            if cap else None,
            "delta_declared_vs_measured_s": round(declared - r["vo_speech_start_in_video_s"], 3)
            if declared is not None else None,
        })
    rep.meta["pairs"] = pairs

    if pairs:
        deltas = [abs(p["delta_srt_vs_measured_s"]) for p in pairs
                  if p["delta_srt_vs_measured_s"] is not None]
        low_conf = [p["vo_id"] for p in pairs if p["ncc"] < 0.15]
        if deltas:
            worst = max(deltas)
            st = PASS if worst < SYNC_TOLERANCE_S else FAIL
            nominal = args.nominal_lead_ms / 1000.0
            # 与标称口径的偏离（Lead 定稿：cap_in = 分镜起点 + VO_LEAD + speech_start - 0.08）
            nominal_dev = [abs(p["delta_srt_vs_measured_s"] - nominal) for p in pairs
                           if p["delta_srt_vs_measured_s"] is not None]
            worst_nom = max(nominal_dev) if nominal_dev else None
            rep.add(Check("S6.5", "字幕起点 vs 成片中 VO 起点（互相关实测）", st,
                          expected=f"每条 |偏差| < {SYNC_TOLERANCE_S * 1000:.0f} ms"
                                   f"（标称 {nominal * 1000:+.0f} ms = 字幕领先人声）",
                          actual=f"最大 |偏差| {worst * 1000:.0f} ms（{len(deltas)} 条）；"
                                 f"与标称口径最大偏离 "
                                 f"{'' if worst_nom is None else f'{worst_nom * 1000:.0f} ms'}",
                          detail=(f"低置信度（ncc<0.15）: {', '.join(low_conf)}" if low_conf
                                  else "全部条目互相关置信度 ≥0.15"),
                          command=f'{FFMPEG} … -f f32le -  # 解码混音与各 VO，归一化互相关定位',
                          evidence=json.dumps(pairs, ensure_ascii=False, indent=1)))
        else:
            rep.add(Check("S6.5", "字幕与 VO 同步", WARN, detail="无字幕条目可配对",
                          evidence=json.dumps(pairs, ensure_ascii=False, indent=1)))
    else:
        onsets = silencedetect_onsets(video, args.noise_db)
        rep.add(Check("S6.5", "字幕与 VO 同步", SKIP,
                      detail="未取得可配对的 VO 定位结果；已改用 silencedetect 输出语音起点作为参考",
                      command=f'{FFMPEG} -i "{video}" -af silencedetect=noise={args.noise_db}dB:d=0.25 -f null -',
                      evidence=json.dumps([round(o, 3) for o in onsets], ensure_ascii=False)))

    return emit(rep, args)


def find_declared_vo_start(tl: Any, vo_id: str) -> Optional[float]:
    """尽最大努力从 timeline.json 里找 vo-NN 的声明起点，兼容几种常见结构。"""
    num = vo_id.split("-")[-1]
    seen: set[int] = set()

    def walk(node: Any) -> Optional[float]:
        if isinstance(node, dict):
            if id(node) in seen:
                return None
            seen.add(id(node))
            blob = json.dumps({k: v for k, v in node.items()
                               if not isinstance(v, (dict, list))}, ensure_ascii=False)
            if re.search(rf'vo[-_]?0*{num}\b', blob) or re.search(rf'"vo_id"\s*:\s*"{vo_id}"', blob):
                for key in ("vo_start", "vo_start_s", "start", "start_s", "t", "at"):
                    v = node.get(key)
                    if isinstance(v, (int, float)):
                        return float(v)
            for v in node.values():
                r = walk(v)
                if r is not None:
                    return r
        elif isinstance(node, list):
            for v in node:
                r = walk(v)
                if r is not None:
                    return r
        return None

    return walk(tl)


# ────────────────────────────────────────────────────────────────────────────
# 7) 渲染脚本参数（CRF / faststart / fps 只能从脚本反查）
# ────────────────────────────────────────────────────────────────────────────

def cmd_renderflags(args: argparse.Namespace) -> int:
    rep = Report(target=args.script, spec_key="renderflags")
    if not os.path.exists(args.script):
        rep.add(Check("S0.1", "渲染脚本存在", FAIL, expected=args.script, actual="文件不存在"))
        return emit(rep, args)
    txt = open(args.script, encoding="utf-8", errors="replace").read()
    checks = [
        ("S0.1", "CRF 18", r"-crf\s+18\b", "STORYBOARD §1: CRF 18"),
        ("S0.2", "+faststart", r"\+faststart", "STORYBOARD §1: +faststart"),
        ("S0.3", "H.264 High profile", r"-profile:v\s+high|-profile\s+high", "STORYBOARD §1: H.264 High"),
        ("S0.4", "yuv420p", r"yuv420p", "STORYBOARD §1"),
        ("S0.5", "AAC 192k", r"(-c:a\s+aac|-acodec\s+aac|aac)", "STORYBOARD §1: AAC 192kbps"),
        ("S0.6", "48kHz 音频", r"(-ar\s+48000|48000)", "STORYBOARD §1: 48kHz"),
    ]
    for cid, title, pat, note in checks:
        m = re.search(pat, txt)
        rep.add(Check(cid, f"渲染脚本声明 {title}", PASS if m else FAIL,
                      expected=note, actual=(m.group(0) if m else "未在脚本中找到"),
                      command=f'{sys.executable} promo/qa/check_spec.py renderflags "{args.script}"'
                              f'   # 内部匹配正则: {pat}'))
    return emit(rep, args)


def cmd_caps(args: argparse.Namespace) -> int:
    """字幕文案 vs 契约（STORYBOARD §3 CAP）逐条比对。

    为什么必须有这一步：
    `promo/build/tools/verify_captions.py` 证明的是「成片像素 == timeline.json 的 cap 字符串」，
    两边用的是**同一个来源**。所以它能抓住"渲染/编码把字画坏了"，但**抓不住**
    "timeline 里的文案本身写错 / 与契约不符"——那种情况下两边一致地错，照样 100% 通过。
    本子命令补上这一环：把 timeline 的 cap 与 STORYBOARD §3 的 CAP 对齐比较。
    """
    rep = Report(target=args.timeline, spec_key="caps")

    def strip_markup(t: str) -> str:
        return re.sub(r"\*\*(.+?)\*\*", r"\1", t)

    def norm(t: str) -> str:
        return re.sub(r"[\s\u3000]+", "", strip_markup(t))

    if not os.path.exists(args.timeline):
        rep.add(Check("S7.1", "timeline 存在", FAIL, expected=args.timeline, actual="不存在"))
        return emit(rep, args)
    tl = json.load(open(args.timeline, encoding="utf-8"))

    md = open(args.storyboard, encoding="utf-8").read() if os.path.exists(args.storyboard) else ""
    contract: dict[str, str] = {}
    for m in re.finditer(r"^###\s*(SH-\d+)(.*?)(?=^###\s|\Z)", md, re.S | re.M):
        cm = re.search(r"\*\*CAP\*\*[：:]\s*(.+)", m.group(2))
        if cm:
            contract[m.group(1)] = cm.group(1).strip()
    rep.meta["contract_caps"] = contract

    if not contract:
        rep.add(Check("S7.1", "解析契约 CAP", FAIL,
                      expected=f"{args.storyboard} §3 中每段有 **CAP**：行",
                      actual="解析到 0 条",
                      command=f'grep -n "CAP" "{args.storyboard}"'))
        return emit(rep, args)

    rows = []
    for sh in tl.get("shots", []):
        sid = sh.get("id", "?")
        cap = sh.get("cap", "")
        want = contract.get(sid)
        rows.append({"id": sid, "timeline_cap": strip_markup(cap),
                     "contract_cap": strip_markup(want) if want else None,
                     "match": want is not None and norm(cap) == norm(want)})
    rep.meta["cap_rows"] = rows

    only_tl = [r["id"] for r in rows if r["contract_cap"] is None]
    ids_in_tl = {r["id"] for r in rows}
    missing_in_tl = [k for k in contract if k not in ids_in_tl]

    rep.add(Check("S7.1", "timeline 字幕 ⊆ 契约分镜",
                  PASS if not only_tl else FAIL,
                  expected="timeline 里每个分镜都能在契约 §3 找到同名 CAP",
                  actual=(f"契约外分镜: {only_tl}" if only_tl else
                          f"{len(rows)} 个分镜全部有契约对应"),
                  command=f'python3 promo/qa/check_spec.py caps --timeline "{args.timeline}"'))
    if args.layout == "16x9":
        rep.add(Check("S7.2", "分镜覆盖（主片应覆盖契约全部 10 个分镜）",
                      PASS if not missing_in_tl else FAIL,
                      expected=f"契约 §3 的 {len(contract)} 个分镜全部出现在时间轴",
                      actual=(f"缺失: {missing_in_tl}" if missing_in_tl else
                              f"全部 {len(rows)}/{len(contract)} 覆盖"),
                      detail="竖版为 6 分镜子集（render.py VERTICAL_IDS），--layout 9x16 时不判 FAIL"))

    mismatch = [r for r in rows if not r["match"]]
    rep.add(Check("S7.3", "字幕文案与契约逐字一致", PASS if not mismatch else FAIL,
                  expected="normalize（去 ** 加粗标记与空白）后完全一致",
                  actual=((f"{len(rows) - len(mismatch)}/{len(rows)} 一致；不一致 "
                           f"{len(mismatch)} 条: {[r['id'] for r in mismatch]}") if mismatch else
                          f"{len(rows)}/{len(rows)} 全部一致"),
                  detail="契约 §3 自称「全队唯一契约…文案以此为准」，文案漂移须由 Lead 收敛到其中一侧",
                  command=f'python3 promo/qa/check_spec.py caps --timeline "{args.timeline}"',
                  evidence=json.dumps(mismatch, ensure_ascii=False, indent=1)))
    return emit(rep, args)


# ────────────────────────────────────────────────────────────────────────────
# 输出
# ────────────────────────────────────────────────────────────────────────────

def emit(rep: Report, args: argparse.Namespace) -> int:
    payload = rep.to_dict()
    if not getattr(args, "no_save", False):
        os.makedirs(args.results_dir, exist_ok=True)
        out = os.path.join(args.results_dir, safe_stem(rep.target) + ".json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    if not getattr(args, "quiet", False):
        print("=" * 78)
        print(f"QA 检查 · {rep.target}")
        print(f"  规格档: {rep.spec_key}   总结论: {rep.worst}")
        print("=" * 78)
        for c in rep.checks:
            print(c.line())
            if c.command and getattr(args, "verbose", False):
                print(f"      命令 : {c.command}")
        n_fail = sum(1 for c in rep.checks if c.status == FAIL)
        n_warn = sum(1 for c in rep.checks if c.status == WARN)
        n_pass = sum(1 for c in rep.checks if c.status == PASS)
        print("-" * 78)
        print(f"PASS {n_pass} · WARN {n_warn} · FAIL {n_fail} → {rep.worst}")
        if not getattr(args, "no_save", False):
            print(f"JSON: {os.path.join(args.results_dir, safe_stem(rep.target) + '.json')}")
    return 1 if rep.worst == FAIL else 0


def detect_spec(path: str, forced: Optional[str]) -> Spec:
    if forced and forced != "auto":
        return SPECS[forced]
    b = os.path.basename(path).lower()
    if "9x16" in b or "vertical" in b:
        return SPECS["9x16"]
    if "novo" in b or "no-vo" in b or "novoice" in b:
        return SPECS["novo"]
    return SPECS["16x9"]


def check_one(path: str, args: argparse.Namespace) -> Report:
    spec = detect_spec(path, args.expect)
    rep = Report(target=path, spec_key=spec.key)
    if not os.path.exists(path):
        rep.add(Check("S0.0", "文件存在", FAIL, expected=path, actual="不存在"))
        return rep
    rep.meta["size_bytes"] = os.path.getsize(path)
    probe = ffprobe_json(path)
    check_container(rep, path, probe, spec)
    check_faststart(rep, path)
    have_audio = rep.meta.get("n_audio_streams", 0) > 0
    check_audio_levels(rep, path, spec, have_audio)

    if not args.skip_frames:
        duration = rep.meta.get("duration_s", 0.0)
        extra = [float(x) for x in (args.at or "").split(",") if x.strip()]
        frames = do_frames(rep, path, duration, args.every, args.shots, extra, args.frames_dir)
        check_brand(rep, frames, args.strict_brand)
    return rep


def cmd_check(args: argparse.Namespace) -> int:
    rc = 0
    reps = []
    for p in args.video:
        rep = check_one(p, args)
        reps.append(rep.to_dict())
        rc |= emit(rep, args)
    if not getattr(args, "no_save", False) and len(reps) > 1:
        os.makedirs(args.results_dir, exist_ok=True)
        with open(os.path.join(args.results_dir, "_summary.json"), "w", encoding="utf-8") as f:
            json.dump(reps, f, ensure_ascii=False, indent=2)
    return rc


# ────────────────────────────────────────────────────────────────────────────
# selftest：用 lavfi 合成一段已知规格的视频，验证工具流水线本身可用
# ────────────────────────────────────────────────────────────────────────────

def cmd_selftest(args: argparse.Namespace) -> int:
    tmp = tempfile.mkdtemp(prefix="qa-selftest-")
    good = os.path.join(tmp, "notestogo-promo-16x9.mp4")
    print(f"[selftest] 生成已知规格样片（期望全 PASS）: {good}")
    # 90s 视频会让 selftest 变慢；用 88s 保证落在 [87,93] 内且能跑完抽帧逻辑。
    # 音频过 loudnorm 打到契约目标 -16 LUFS / TP -1.5 内，保证样片本身合规。
    rc, out = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=88",
                   "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=88",
                   "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                   "-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
                   "-movflags", "+faststart", "-shortest", good], timeout=900)
    if rc != 0:
        print(f"[selftest] 合成失败 rc={rc}\n{out[-1500:]}")
        return 2

    # 复用真实的 check 子命令解析，避免自测走的代码路径与实战不同。
    # 关键：把样片的抽帧与 JSON 落到 _selftest 子目录，避免污染真实成片的验收产物。
    cargs = build_parser().parse_args(
        ["check", good, "--expect", "16x9", "--every", "30",
         "--results-dir", os.path.join(args.results_dir, "_selftest"),
         "--frames-dir", os.path.join(args.frames_dir, "_selftest")])
    cargs.quiet = args.quiet
    cargs.verbose = args.verbose
    print("[selftest] 跑 check …")
    rc1 = cmd_check(cargs)

    print("\n[selftest] 制造一个已知缺陷：moov 后置（-c copy，不加 +faststart）")
    bad = os.path.join(tmp, "notestogo-promo-16x9-nofaststart.mp4")
    rc_bad, out_bad = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                           "-i", good, "-c", "copy", bad], timeout=300)
    if rc_bad != 0:
        print(f"[selftest] 生成缺陷样本失败 rc={rc_bad}\n{out_bad[-500:]}")
        return 2
    boxes = top_level_boxes(bad)
    order = " → ".join(t for t, _, _ in boxes)
    print(f"[selftest] 无 faststart 版顶层 box 顺序: {order}")
    detected = order.index("moov") > order.index("mdat")
    print(f"[selftest] 工具能否检出 moov 后置: {'是 ✅' if detected else '否 ❌（工具失效）'}")

    print("\n[selftest] 互相关同步自测：把 vo 放到已知偏移处")
    ok_sync = _selftest_sync(tmp)
    verdict = (rc1 == 0) and detected and ok_sync
    print(f"\n[selftest] 结论: {'全部自测通过 ✅' if verdict else '自测存在失败 ❌'}")
    print(f"[selftest] 中间产物: {tmp}")
    if args.keep:
        print("[selftest] --keep 指定，保留临时目录")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if verdict else 1


def _selftest_sync(tmp: str) -> bool:
    if np is None:
        print("[selftest] numpy 缺失，跳过同步自测")
        return True
    vo = os.path.join(tmp, "vo-01.wav")
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "sine=frequency=700:sample_rate=48000:duration=2",
         "-af", "adelay=200|200", "-ac", "1", vo], timeout=120)
    mix = os.path.join(tmp, "mix.wav")
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=8",
         "-i", vo, "-filter_complex",
         "[1:a]adelay=3000:all=1[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[o]",
         "-map", "[o]", "-ac", "1", mix], timeout=120)
    m = decode_pcm_mono16k(mix)
    v = decode_pcm_mono16k(vo)
    r = locate_vo(m, v)
    if not r.get("ok"):
        print(f"[selftest] 定位失败: {r}")
        return False
    # 期望：VO 文件起点 ≈ 3.0s；VO 内部语音起点 ≈ 0.2s
    lag_ok = abs(r["lag_s"] - 3.0) < 0.05
    onset_ok = abs(r["vo_onset_in_file_s"] - 0.2) < 0.05
    print(f"[selftest] 互相关 lag={r['lag_s']:.3f}s（期望 3.000±0.05）"
          f" → {'✅' if lag_ok else '❌'}；ncc={r['ncc']:.3f}")
    print(f"[selftest] VO 内部语音起点={r['vo_onset_in_file_s']:.3f}s（期望 0.200±0.05）"
          f" → {'✅' if onset_ok else '❌'}；合成语音起点={r['vo_speech_start_in_video_s']:.3f}s")
    return lag_ok and onset_ok


# ────────────────────────────────────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="check_spec.py",
        description="NotesToGO 宣传片验收工具（STORYBOARD.md 第 5 节 7 条）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python3 promo/qa/check_spec.py check promo/build/out/*.mp4 --every 5 --shots\n"
               "  python3 promo/qa/check_spec.py sync --video promo/build/out/notestogo-promo-16x9.mp4 \\\n"
               "        --srt promo/script/subtitles-zh.srt\n"
               "  python3 promo/qa/check_spec.py renderflags promo/build/render.sh\n"
               "  python3 promo/qa/check_spec.py selftest\n")
    sub = ap.add_subparsers(dest="cmd")

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--results-dir", default=RESULTS_DIR,
                       help=f"JSON 结果输出目录（默认 {os.path.relpath(RESULTS_DIR, PROJECT_DIR)}）")
        p.add_argument("--quiet", action="store_true", help="不打印到 stdout")
        p.add_argument("--verbose", "-v", action="store_true", help="打印每条的原始命令")
        p.add_argument("--no-save", action="store_true", help="不写 JSON")

    pc = sub.add_parser("check", help="规格 / faststart / 音频 / 抽帧 / 品牌色")
    pc.add_argument("video", nargs="+", help="待检 mp4（可多个）")
    pc.add_argument("--expect", default="auto", choices=["auto", *SPECS.keys()],
                    help="规格档；auto 按文件名判断（含 9x16 → 竖版，含 novo → 无旁白版）")
    pc.add_argument("--every", type=float, default=5.0, help="每 N 秒抽一帧（默认 5，0 关闭）")
    pc.add_argument("--shots", action="store_true", help="额外在 10 个分镜中点位各抽一帧")
    pc.add_argument("--at", default="", help="额外时间点，逗号分隔（秒），如 12.5,30")
    pc.add_argument("--frames-dir", default=FRAMES_DIR,
                    help=f"抽帧输出根目录（默认 {os.path.relpath(FRAMES_DIR, PROJECT_DIR)}）")
    pc.add_argument("--skip-frames", action="store_true", help="跳过抽帧")
    pc.add_argument("--strict-brand", action="store_true",
                    help="把品牌橘检出率 <50%% 记 FAIL（默认只记 INFO）")
    common(pc)

    ps = sub.add_parser("sync", help="字幕起点 vs 成片中 VO 实测起点（第 6 条）")
    ps.add_argument("--video", nargs=1, required=True)
    ps.add_argument("--srt", default=os.path.join(PROJECT_DIR, "promo/script/subtitles-zh.srt"))
    ps.add_argument("--vo-dir", default=os.path.join(PROJECT_DIR, "promo/audio/vo"))
    ps.add_argument("--timeline", default=os.path.join(PROJECT_DIR, "promo/build/timeline.json"))
    ps.add_argument("--noise-db", type=float, default=-30.0, help="silencedetect 阈值（备用路径）")
    ps.add_argument("--nominal-lead-ms", type=float, default=-80.0,
                    help="标称「字幕领先人声」毫秒数（Lead 定稿 -80ms；仅用于报告偏离，不参与 PASS/FAIL）")
    common(ps)

    pr = sub.add_parser("renderflags", help="检查渲染脚本里无法从成片反查的参数")
    pr.add_argument("script", nargs="?", default=os.path.join(PROJECT_DIR, "promo/build/render.sh"))
    common(pr)

    pt = sub.add_parser("selftest", help="合成样片验证工具自身可用")
    pt.add_argument("--keep", action="store_true", help="保留临时样片")
    common(pt)

    pcaps = sub.add_parser("caps", help="字幕文案 vs 契约 §3 CAP（补 verify_captions 抓不到的一环）")
    pcaps.add_argument("--timeline", default=os.path.join(PROJECT_DIR, "promo/build/timeline.json"))
    pcaps.add_argument("--storyboard", default=os.path.join(PROJECT_DIR, "promo/STORYBOARD.md"))
    pcaps.add_argument("--layout", default="16x9", choices=["16x9", "9x16"],
                       help="16x9 → 要求覆盖契约全部 10 个分镜；9x16 为 6 分镜子集")
    common(pcaps)

    common(ap)  # 允许 check_spec.py --help / 无参数时也有这些开关

    return ap


def main(argv: Optional[list[str]] = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if args.cmd is None:
        ap.print_help()
        return 0
    for attr, default in (("results_dir", RESULTS_DIR), ("frames_dir", FRAMES_DIR),
                          ("quiet", False), ("verbose", False), ("no_save", False)):
        if not hasattr(args, attr):
            setattr(args, attr, default)
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "sync":
        return cmd_sync(args)
    if args.cmd == "renderflags":
        return cmd_renderflags(args)
    if args.cmd == "caps":
        return cmd_caps(args)
    if args.cmd == "selftest":
        return cmd_selftest(args)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
