#!/usr/bin/env python3
"""
NotesToGO 宣传片 · 渲染驱动（Lead 维护）

用法：
    PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
    $PY promo/build/render.py --dry-run                 # 只算时间轴，写 timeline.json
    $PY promo/build/render.py --preview                 # 每个分镜抽 1 帧，供目视复核
    $PY promo/build/render.py --layout 16x9             # 正式渲染主片
    $PY promo/build/render.py --layout 9x16             # 竖版

产出：promo/build/out/notestogo-promo-<layout>[-novo].mp4 + 字幕 srt
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from video import (  # noqa: E402
    ACCENT, AUDIO, BRAND, BUILD, CAPTURE, FPS, INK, INK2, LAYOUTS, LINE, OUT, PAPER,
    PAPER_RAISE, PROMO, TMP, VO_LEAD, VO_MIN_TAIL, VO_TAIL, CardSource,
    DeviceShowcaseSource,
    FrameSource, HookSource, Layout, PaperSource, SeqClipSource, UiClipSource,
    UiStillSource,
    bottom_scrim, caption_image, font, trim_alpha, watermark_image,
)

# ── 分镜表（第 3 节；文案与 CAP 来自 promo/STORYBOARD.md）─────────────────────
@dataclass
class Shot:
    id: str
    kind: str                 # hook | card | ui-still | ui-clip
    src: object               # str 或 list[str]
    vo: str
    cap: str
    min_dur: float
    xfade: float = 0.50
    en: str = ""
    brand: str = ""           # 品牌卡片文件名
    zoom: tuple = (1.0, 1.045)
    center: tuple = (0.5, 0.5)
    drift: tuple = (0.0, 0.0)
    note: str = ""


SHOTS: list[Shot] = [
    Shot("SH-01", "hook", ["hook-1", "hook-2"], "vo-01",
         "开会时，你在讨论，还是在**抄笔记**？", 7.0, 0.60,
         en="In a meeting, are you in the discussion — or just taking notes?",
         note="纸底大字逐句浮现 → 小窗推入 today"),
    Shot("SH-02", "card", "title-card-1920x1080.png", "vo-02",
         "**NotesToGO** 拾贝 · 会中只记关键词，散会后一键成稿", 5.5, 0.50,
         en="NotesToGO — jot keywords in the meeting, get the write-up after it.",
         brand="title-card-1920x1080.png", zoom=(1.0, 0.028),
         note="品牌亮相"),
    Shot("SH-03", "ui-clip", ["record-start-clean", "live-caption-clean"], "vo-03",
         "**⌘⇧R** 一键开录 · 会中只记关键词，回车即存", 10.0, 0.50,
         en="One shortcut to record · jot keywords, hit enter to save",
         zoom=(1.0, 1.02), note="record-start → live-caption（快捷键真值 ⌘⇧R）"),
    Shot("SH-04", "ui-clip", "polish", "vo-04",
         "一次调用 = 标题 + 纪要 + 待办 · 每条带**原文引用**", 11.0, 0.50,
         en="One pass = title + notes + action items, each with its source quote",
         zoom=(1.0, 1.02), note="重新整理 → 笔记 Tab → 全部确认"),
    Shot("SH-05", "ui-clip", "transcript-speakers", "vo-05",
         "转录带**说话人区分** · 谁在什么时候说了什么", 6.5, 0.35,
         en="Speaker-labelled transcript — who said what, and when",
         zoom=(1.0, 1.02), note="转录 Tab 滚动"),
    Shot("SH-06", "ui-clip", ["okr-views", "okr-attach"], "vo-06",
         "**嵌套 OKR** · 战略 → 季度 → 项目 → 任务", 10.0, 0.50,
         en="Nested OKRs · strategy → quarter → project → task",
         zoom=(1.0, 1.02), note="三视图切换 + 挂到 KR"),
    Shot("SH-07", "ui-clip", ["board-drag", "report"], "vo-07",
         "看板拖拽换列 · **自动周报**一键复制", 8.0, 0.35,
         en="Drag cards across the board · auto weekly report, one click to copy",
         zoom=(1.0, 1.02), note="看板 → 周报"),
    Shot("SH-08", "ui-clip", "settings-ai", "vo-08",
         "**桌面版**内置模型 · 断网可用 · 数据去向如实自检", 10.0, 0.50,
         en="Built-in models on desktop · works offline · honest data-flow check",
         zoom=(1.0, 1.02), note="AI 运行在哪里 + 数据去向（不得暗示网页版可离线推理）"),
    Shot("SH-09", "devices", ["mobile-today", "ipad-portrait"], "vo-09",
         "PWA 可安装（iPhone / iPad / Mac）· 一键导出 **.zip**", 6.5, 0.50,
         en="Installable PWA on iPhone / iPad / Mac · one-click .zip export",
         note="机身框 + 真实移动端截图"),
    Shot("SH-10", "card", "end-card-1920x1080.png", "vo-10",
         "**github.com/frankfika/notestodo** · 本地优先 · 开源", 7.0, 0.50,
         en="github.com/frankfika/notestodo · local-first · open source",
         brand="end-card-1920x1080.png", zoom=(1.0, 0.022),
         note="收尾"),
]

TARGET_16x9 = 90.0
TARGET_9x16 = 60.0

# 竖版不是把 16:9 压缩，而是重新剪一个更短的**分镜子集**：钩子 → 开录/字幕 → 一次成稿
# → 嵌套 OKR → 本地优先 → 收尾（每格都保留完整旁白，绝不截断 VO）
VERTICAL_IDS = ["SH-01", "SH-03", "SH-04", "SH-06", "SH-08", "SH-10"]


# ── 素材解析 ──────────────────────────────────────────────────────────────────
def _env_dir(var: str, default: Path) -> Path:
    """PROMO_STILLS_DIR / PROMO_CLIPS_DIR / PROMO_BRAND_DIR：供 Lead 在真实素材
    到位前用 fixture 调试管线（不影响正式渲染的默认路径）。"""
    v = os.environ.get(var)
    return Path(v) if v else default


def find_still(name: str) -> Path | None:
    p = _env_dir("PROMO_STILLS_DIR", CAPTURE / "stills") / f"{name}.png"
    return p if p.exists() else None


def find_clip(name: str) -> Path | None:
    p = _env_dir("PROMO_CLIPS_DIR", CAPTURE / "clips") / f"{name}.webm"
    return p if p.exists() else None


def find_brand(name: str) -> Path | None:
    p = _env_dir("PROMO_BRAND_DIR", BRAND) / name
    return p if p.exists() else None


def load_vo_meta() -> dict[str, dict]:
    """{id: {dur, speech_start}}；speech_start 是 wav 内人声真正起播的秒数。"""
    p = AUDIO / "vo-manifest.json"
    if not p.exists():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    rows = data if isinstance(data, list) else data.get("items", [])
    out = {}
    for r in rows:
        try:
            out[str(r["id"])] = {"dur": float(r["duration_s"]),
                                 "speech_start": float(r.get("speech_start_s", 0.15))}
        except Exception:
            continue
    return out


def load_vo_durations() -> dict[str, float]:
    return {k: v["dur"] for k, v in load_vo_meta().items()}


# ── 时间轴 ────────────────────────────────────────────────────────────────────
def build_timeline(target: float, vo_dur: dict[str, float], layout: Layout,
                   vo_meta: dict[str, dict] | None = None,
                   shots: list[Shot] | None = None) -> dict:
    """d_i = max(min_dur, VO_LEAD + vo + VO_TAIL)，再整体缩放到目标时长。

    时长下限**必须装得下这条旁白**——否则 VO 会越到下一个分镜，画音错位。
    """
    use = shots if shots is not None else SHOTS
    xf_all = [s.xfade for s in use]
    raw, floor = [], []
    for s in use:
        v = vo_dur.get(s.vo, s.min_dur * 0.7)
        base = max(s.min_dur, VO_LEAD + v + VO_TAIL)
        raw.append(base)
        floor.append(max(s.min_dur * (0.62 if layout.name == "9x16" else 0.92),
                         VO_LEAD + v + VO_MIN_TAIL))
    xf = xf_all[:-1]
    sum_xf = sum(xf)

    def total(ds):
        return sum(ds) - sum_xf

    k = (target + sum_xf) / max(1e-6, sum(raw))
    ds = [max(f, r * k) for r, f in zip(raw, floor)]
    # 若被下限顶住，剩余部分按比例再压
    for _ in range(6):
        gap = total(ds) - target
        if abs(gap) < 0.05:
            break
        free = [i for i in range(len(ds)) if ds[i] > floor[i] + 1e-6]
        if not free:
            break
        pool = sum(ds[i] - floor[i] for i in free)
        for i in free:
            ds[i] = max(floor[i], ds[i] - gap * (ds[i] - floor[i]) / max(1e-6, pool))
    starts, t = [], 0.0
    for i, d in enumerate(ds):
        starts.append(t)
        t += d - (xf[i] if i < len(xf) else 0.0)
    shots = []
    for i, s in enumerate(use):
        shots.append({
            "id": s.id, "kind": s.kind, "src": s.src, "vo": s.vo, "note": s.note,
            "start": round(starts[i], 3), "dur": round(ds[i], 3),
            "xfade_next": round(xf[i], 3) if i < len(xf) else 0.0,
            "cap": s.cap, "en": s.en,
            "vo_dur": round(vo_dur.get(s.vo, 0.0), 3),
            # 字幕与**真实人声起点**对齐（wav 自带前导静音，Lead 之后再起播）
            "cap_in": round(starts[i] + VO_LEAD
                            + (vo_meta or {}).get(s.vo, {}).get("speech_start", 0.15) - 0.08, 3),
            "cap_out": round(starts[i] + ds[i] - 0.35, 3),
        })
    return {
        "layout": layout.name, "size": [layout.W, layout.H], "fps": FPS,
        "target_s": target, "total_s": round(total(ds), 3),
        "vo_lead": VO_LEAD, "shots": shots,
    }


# ── 帧源构造 ──────────────────────────────────────────────────────────────────
def make_source(shot: dict, layout: Layout) -> FrameSource:
    kind, src = shot["kind"], shot["src"]
    spec = next(s for s in SHOTS if s.id == shot["id"])
    if kind == "hook":
        lines = [BRAND / "hook-lines" / f"{n}.png" for n in (src if isinstance(src, list) else [src])]
        lines = [p for p in lines if p.exists()]
        return HookSource(layout, lines, find_still("today"), find_brand("bg-paper-1920x1080.png"))
    if kind == "card":
        p = find_brand(src)
        if p is None:
            return PaperSource(layout, find_brand("bg-paper-1920x1080.png"))
        boxes = json.loads((BRAND / "MANIFEST.json").read_text())["safe_frame_check"]["boxes"]
        return CardSource(layout, p, zoom=spec.zoom[1], content=boxes.get(src),
                          bg=find_brand("bg-paper-1920x1080.png"))
    if kind == "ui-still":
        p = find_still(src)
        if p is None:
            return PaperSource(layout, find_brand("bg-paper-1920x1080.png"))
        return UiStillSource(layout, p, zoom=spec.zoom, center=spec.center, drift=spec.drift)
    if kind == "devices":
        names = src if isinstance(src, list) else [src]
        phone = find_still(names[0])
        tablet = find_still(names[1]) if len(names) > 1 else None
        dev = DeviceShowcaseSource(layout, phone, tablet,
                                   find_brand("bg-paper-1920x1080.png"))
        # 字幕卡是半透明浅底，压住设备底部会显得"设备被切了一刀"——按本镜字幕实际高度抬升设备
        cap_h = caption_image(shot["cap"], layout.W, size=layout.cap_size,
                              max_w=int(layout.W * layout.cap_max_w_ratio)).size[1]
        cap_top = layout.H - layout.cap_bottom - cap_h
        overflow = dev.bottom() - (cap_top - 16)
        for m in dev.check_against_brand():
            print(f"  ⚠ {m}")
        if overflow > 0:
            dev.lift = -overflow
            print(f"  ℹ {shot['id']} 设备实体底部 {dev.bottom()} 会压到字幕线 {cap_top}，"
                  f"整体抬升 {dev.lift}px → 抬升后底部 {dev.bottom() + dev.lift}")
        return dev
    if kind == "ui-clip":
        if isinstance(src, list):
            ps = [q for q in (find_clip(n) for n in src) if q]
            if len(ps) > 1:
                return SeqClipSource(layout, ps, zoom=spec.zoom)
            src = src[0] if ps else src[0]
        p = find_clip(src)
        if p is None:
            alt = find_still(src)
            if alt:
                return UiStillSource(layout, alt, zoom=(1.0, 1.03))
            return PaperSource(layout, find_brand("bg-paper-1920x1080.png"))
        return UiClipSource(layout, p, zoom=spec.zoom)
    raise ValueError(f"未知 kind: {kind}")


# ── 叠加层（字幕 / 水印 / 进度条）─────────────────────────────────────────────
class Overlays:
    """统一叠加层：底部纸色渐隐 + 字幕 + 品牌水印 + 进度条 + 分镜专属装饰。"""

    def __init__(self, timeline: dict, layout: Layout):
        self.L = layout
        self.tl = timeline
        self.scrim = bottom_scrim(layout.W, layout.H, layout.scrim_h)
        self.wm = watermark_image(24 if layout.name == "16x9" else 30)
        self.caps = []
        for sh in timeline["shots"]:
            if sh["id"] == "SH-10":
                continue  # 收尾卡自带同一行「网址 · 本地优先 · 开源」，再烧字幕会叠字；srt 仍保留
            text = sh["cap"]
            img = caption_image(text, layout.W, size=layout.cap_size,
                                max_w=int(layout.W * layout.cap_max_w_ratio))
            x = (layout.W - img.size[0]) // 2
            y = layout.H - layout.cap_bottom - img.size[1]
            self.caps.append((sh["cap_in"], sh["cap_out"], img, x, y))
        # 分镜专属装饰：SH-03 的要点条（品牌给的整幅画布 → 收紧后重新落位）
        self.extras: list[tuple[float, float, Image.Image, int, int]] = []
        chip = _env_dir("PROMO_BRAND_DIR", BRAND) / "lower-third-live.png"
        sh03 = next((s for s in timeline["shots"] if s["id"] == "SH-03"), None)
        if chip.exists() and sh03 is not None:
            ci = trim_alpha(Image.open(chip))
            if layout.name == "16x9":
                x = (layout.W - ci.size[0]) // 2
                y = 46
            else:
                x = (layout.W - ci.size[0]) // 2
                y = int(layout.ui_y - ci.size[1] - 40)
            self.extras.append((sh03["start"] + 0.95, sh03["start"] + sh03["dur"] - 0.45,
                                ci, x, y))

    def apply(self, frame: np.ndarray, t: float) -> np.ndarray:
        L = self.L
        img = Image.fromarray(frame, "RGB")
        # 底部纸色渐隐
        img = Image.alpha_composite(img.convert("RGBA"), self.scrim).convert("RGB")
        # 分镜装饰
        for tin, tout, oimg, x, y in self.extras:
            a = min(1.0, max(0.0, (t - tin) / 0.3)) * min(1.0, max(0.0, (tout - t) / 0.25))
            if a <= 0.01:
                continue
            tmp = oimg.copy()
            tmp.putalpha(tmp.split()[3].point(lambda v, a=a: int(v * a)))
            img.paste(tmp.convert("RGB"), (x, y), tmp)
        # 字幕（含淡入淡出）
        for cin, cout, cimg, x, y in self.caps:
            if not (cin - 0.3 <= t <= cout + 0.25):
                continue
            a = min(1.0, max(0.0, (t - cin) / 0.25)) * min(1.0, max(0.0, (cout - t) / 0.20))
            if a <= 0.01:
                continue
            if a >= 0.995:
                img.paste(cimg.convert("RGB"), (x, y), cimg)
            else:
                tmp = cimg.copy()
                tmp.putalpha(tmp.split()[3].point(lambda v, a=a: int(v * a)))
                img.paste(tmp.convert("RGB"), (x, y), tmp)
        # 水印（仅竖版/卡片）
        if L.show_watermark:
            wm = self.wm
            img.paste(wm.convert("RGB"), (L.W - wm.size[0] - 64, 56), wm)
        # 进度条（numpy 需要可写副本）
        if L.show_progress:
            arr = np.array(img)                      # copy：Image.fromarray 的缓冲只读
            total = max(1e-6, self.tl["total_s"])
            px = int(min(1.0, max(0.0, t / total)) * L.W)
            if px > 0:
                band = arr[L.H - 3:L.H, :px].astype(np.float32)
                band = band * 0.45 + np.array(ACCENT, dtype=np.float32) * 0.55
                arr[L.H - 3:L.H, :px] = band.astype(np.uint8)
            return arr
        return np.asarray(img)


# ── 主渲染 ────────────────────────────────────────────────────────────────────
def blend(a: np.ndarray, b: np.ndarray, alpha: float) -> np.ndarray:
    return (a.astype(np.float32) * (1 - alpha) + b.astype(np.float32) * alpha).astype(np.uint8)


def frame_iter(shot: dict, n: int, src: FrameSource):
    for i in range(n):
        yield np.asarray(src.frame(i, n))


def render_frames(timeline: dict, layout: Layout, sink):
    """按分镜顺序产出 canvas 帧，相邻分镜做交叉溶解。"""
    shots = timeline["shots"]
    total = 0
    prev_tail: list[np.ndarray] | None = None
    prev_xf = 0
    for idx, sh in enumerate(shots):
        n = int(round(sh["dur"] * FPS))
        xf_next = int(round(sh["xfade_next"] * FPS)) if idx < len(shots) - 1 else 0
        head_n = prev_xf if prev_tail is not None else 0
        keep = n - head_n - xf_next
        if keep < 0:
            raise SystemExit(f"{sh['id']}: 分镜时长过短，容不下转场 "
                             f"(n={n} head={head_n} xfade_next={xf_next})")
        src = make_source(sh, layout)
        it = frame_iter(sh, n, src)
        try:
            if prev_tail is not None and prev_xf > 0:
                head = [next(it) for _ in range(prev_xf)]
                for k in range(prev_xf):
                    a = (k + 1) / (prev_xf + 1)
                    a = a * a * (3 - 2 * a)
                    sink(blend(prev_tail[k], head[k], a))
                    total += 1
            for _ in range(keep):
                sink(next(it))
                total += 1
            prev_tail = [next(it) for _ in range(xf_next)] if xf_next else []
            prev_xf = xf_next
        finally:
            src.close()
    return total


def encode(timeline: dict, layout: Layout, out_path: Path, crf: int, preset: str,
           ov: Overlays, preview_only: bool = False, preview_dir: Path | None = None) -> int:
    total_frames = int(round(timeline["total_s"] * FPS))
    if preview_only:
        assert preview_dir
        preview_dir.mkdir(parents=True, exist_ok=True)
        times = [sh["start"] + sh["dur"] * 0.5 for sh in timeline["shots"]]
        pick = collect_frames_at(timeline, layout, times)
        for sh, t, fr in zip(timeline["shots"], times, pick):
            # 预览必须**带上叠加层**（字幕/水印/进度条/装饰），否则验收看到的不是成片
            fr = ov.apply(fr, t)
            Image.fromarray(fr, "RGB").save(preview_dir / f"{sh['id']}.png")
        print(f"[preview] 写出 {len(pick)} 张（含字幕叠加）→ {preview_dir}")
        return len(pick)

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{layout.W}x{layout.H}",
           "-r", str(FPS), "-i", "-", "-an",
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
           "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
           "-movflags", "+faststart", str(out_path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    # 画面严格写成 round(total*FPS) 帧：多出来的帧会让成片比音轨长，
    # 封装时 -shortest 就会反过来剪掉尾帧（且时长不是整数秒）。

    t0 = time.time()
    state = {"n": 0}

    def sink(fr: np.ndarray):
        if state["n"] >= total_frames:      # 严格截到 round(total*FPS)，见上方说明
            return
        t = state["n"] / FPS
        out = ov.apply(fr, t)
        proc.stdin.write(out.tobytes())
        state["n"] += 1
        if state["n"] % 150 == 0:
            el = time.time() - t0
            pct = 100.0 * state["n"] / max(1, total_frames)
            fps = state["n"] / max(1e-6, el)
            eta = (total_frames - state["n"]) / max(1e-6, fps)
            print(f"  {state['n']}/{total_frames} 帧 ({pct:5.1f}%)  "
                  f"{fps:5.1f} fps  ETA {eta:5.0f}s", flush=True)

    n = render_frames(timeline, layout, sink)
    proc.stdin.close()
    err = proc.stderr.read().decode("utf-8", "replace")
    rc = proc.wait()
    if rc != 0:
        print(err[-4000:], file=sys.stderr)
        raise SystemExit(f"ffmpeg 编码失败 rc={rc}")
    print(f"[video] 写入 {state['n']} 帧 / {state['n'] / FPS:.3f}s（生成 {n} 帧，"
          f"按时间轴截到 {total_frames}）→ {out_path}  ({time.time() - t0:.0f}s)")
    return state["n"]


def collect_frames_at(timeline: dict, layout: Layout, times: list[float]) -> list[np.ndarray]:
    """一次遍历拿指定全局时刻的帧（预览用）。"""
    want = sorted(range(len(times)), key=lambda i: times[i])
    out: list[np.ndarray | None] = [None] * len(times)
    idx, t, n_frame = 0, 0.0, 0

    def gen():
        nonlocal idx, t
        prev_tail, prev_xf = None, 0
        shots = timeline["shots"]
        for i, sh in enumerate(shots):
            n = int(round(sh["dur"] * FPS))
            xf_next = int(round(sh["xfade_next"] * FPS)) if i < len(shots) - 1 else 0
            head_n = prev_xf if prev_tail is not None else 0
            src = make_source(sh, layout)
            it = frame_iter(sh, n, src)
            try:
                if prev_tail is not None and prev_xf > 0:
                    head = [next(it) for _ in range(prev_xf)]
                    for k in range(prev_xf):
                        a = (k + 1) / (prev_xf + 1)
                        a = a * a * (3 - 2 * a)
                        yield blend(prev_tail[k], head[k], a)
                for _ in range(n - head_n - xf_next):
                    yield next(it)
                prev_tail = [next(it) for _ in range(xf_next)] if xf_next else []
                prev_xf = xf_next
            finally:
                src.close()

    for fr in gen():
        gt = n_frame / FPS
        while idx < len(want) and times[want[idx]] <= gt:
            out[want[idx]] = fr
            idx += 1
        if idx >= len(want):
            break
        n_frame += 1
    return [f for f in out if f is not None]


# ── 音频 ──────────────────────────────────────────────────────────────────────
def build_mix(timeline: dict, with_vo: bool, out_path: Path) -> Path:
    bed = AUDIO / "music" / "bed.wav"
    if not bed.exists():
        raise SystemExit(f"缺少配乐 {bed}")
    total = timeline["total_s"]
    inputs, filters, vo_labels = ["-i", str(bed)], [], []
    if with_vo:
        for k, sh in enumerate(timeline["shots"], start=1):
            vo = AUDIO / "vo" / f"{sh['vo']}.wav"
            if not vo.exists():
                raise SystemExit(f"缺少旁白 {vo}")
            inputs += ["-i", str(vo)]
            ms = int((sh["start"] + VO_LEAD) * 1000)
            filters.append(
                f"[{k}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                f"adelay={ms}|{ms},volume=1.0[v{k}]")
            vo_labels.append(f"[v{k}]")
    filters.append(f"[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                   f"volume=0.16,apad[bed]")
    if with_vo:
        filters.append("".join(vo_labels) + f"amix=inputs={len(vo_labels)}:normalize=0[vobus]")
        # ⚠ 必须 asplit：一个 label 只能被消费一次。少了它 ffmpeg 8.0.1 **不报错**（rc=0）
        # 却把第二个消费者（最终 amix）静默丢掉，成品就只剩配乐——旁白凭空消失。
        # 侧链必须补零：sidechaincompress 的输出长度 = 两条输入里较短的那条，
        # 而侧链（旁白总线）在最后一句就结束了；不补零整条音轨会被截短，
        # 随后封装时 -shortest 会**把画面也一起剪掉**（实测少了 11 帧）。
        filters.append("[vobus]asplit=2[sc0][vt0]")
        filters.append("[sc0]apad[sc]")
        filters.append("[vt0]apad[vt]")
        filters.append("[bed][sc]sidechaincompress=threshold=0.035:ratio=6:attack=25:"
                       "release=425:makeup=1[bedduck]")
        filters.append("[bedduck][vt]amix=inputs=2:normalize=0:duration=first[mixed]")
    else:
        # 无旁白版**不挂 VO 支路**（挂上却不消费会让 filter_complex 直接失败）
        filters.append("[bed]anull[mixed]")
    raw = TMP / f"mix_raw{'_novo' if not with_vo else ''}.wav"
    TMP.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
           "-filter_complex", ";".join(filters), "-map", "[mixed]",
           # 故意比时间轴长 0.5s：封装时的 -shortest 由**视频流**决定收尾，
           # 于是尾帧不会被音频剪掉（此前 9:16 就被剪了 2 帧：1844→1842）。
           "-t", f"{total + 0.5:.3f}", "-ar", "48000", "-ac", "2", str(raw)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f"混音失败 rc={r.returncode}\n"
                         f"{r.stderr.decode('utf-8', 'replace')[-800:]}")

    # 两遍 loudnorm：目标 -16 LUFS / TP -1.5
    tgt = "-18" if not with_vo else "-16"
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(raw), "-af",
         f"loudnorm=I={tgt}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True)
    tail = probe.stderr[probe.stderr.rfind("{"):]
    try:
        m = json.loads(tail[:tail.rfind("}") + 1])
        ln = (f"loudnorm=I={tgt}:TP=-1.5:LRA=11:linear=true:"
              f"measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
              f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
              f"offset={m['target_offset']}")
    except Exception:
        ln = f"loudnorm=I={tgt}:TP=-1.5:LRA=11"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw),
                    "-af", ln, "-ar", "48000", "-ac", "2", str(out_path)], check=True)
    if with_vo:
        for sh in timeline["shots"]:
            vp = AUDIO / "vo" / f"{sh['vo']}.wav"
            ncc, at = ncc_with(out_path, vp)
            if ncc < 0.5:
                raise SystemExit(f"❌ 混音自检失败：{out_path.name} 里定位不到 {vp.name} "
                                 f"(ncc={ncc:.3f})；期望出现在 {sh['start'] + VO_LEAD:.2f}s 附近。"
                                 f"响度/峰值这类规格检查在纯音乐下会假通过，必须查内容。")
            want = sh["start"] + VO_LEAD
            off = abs(at - want)
            if off > 0.10:
                raise SystemExit(
                    f"❌ 混音自检失败：{sh['vo']} 出现在 {at:.2f}s，期望 {want:.2f}s，"
                    f"偏差 {off:.2f}s > 0.10s。旁白存在但整体错位同样会毁掉音画同步，"
                    f"所以这里必须致命而不是只告警。")
            print(f"[mix] 内容自检 {sh['vo']}: ncc={ncc:.4f} @ {at:6.2f}s "
                  f"(期望 {want:6.2f}s，偏差 {off * 1000:.0f}ms) ✅")
    return out_path


def _pcm16k(p: Path) -> "np.ndarray":
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", "1", "-ar", "16000",
                        "-f", "s16le", "-"], capture_output=True)
    return np.frombuffer(r.stdout, dtype="<i2").astype(np.float64)


def ncc_with(a: Path, b: Path) -> tuple[float, float]:
    """判断 b 这段音频是否真的出现在 a 里，返回 (最大归一化互相关系数, 命中的秒数)。

    ⚠ 必须**滑窗搜索**而不是零延迟直接点乘：旁白在成片里是滞后起播的（首条 0.40s），
    零延迟互相关对不上就会把"旁白明明在"误判成"旁白丢了"（我第一版就这么假报过）。
    用 FFT 做互相关，复杂度 O(n log n)，90s 音轨毫秒级。
    """
    x, y = _pcm16k(a), _pcm16k(b)
    if len(x) < 1600 or len(y) < 1600:
        return 0.0, 0.0
    y = y - y.mean()
    xd = x - x.mean()
    size = 1 << int(np.ceil(np.log2(len(x) + len(y))))
    cc = np.fft.irfft(np.fft.rfft(xd, size) * np.conj(np.fft.rfft(y, size)), size)
    csum = np.concatenate([[0.0], np.cumsum(xd * xd)])
    win, e_y = len(y), float((y * y).sum())
    m = len(x) - win + 1
    if m <= 0:
        return 0.0, 0.0
    e_x = np.maximum(csum[win:win + m] - csum[:m], 1e-9)
    vals = np.abs(cc[:m]) / np.sqrt(e_x * e_y)
    k = int(np.argmax(vals))
    return float(vals[k]), k / 16000.0


def probe_audio(p: Path) -> dict:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(p), "-af",
                        "astats=metadata=1:reset=0,volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    out = {}
    for key in ("Peak level dB", "RMS level dB", "Max volume", "Mean volume"):
        for line in r.stderr.splitlines():
            if key in line:
                out[key] = line.split(":")[-1].strip()
    return out


# ── 字幕 ──────────────────────────────────────────────────────────────────────
def fmt_ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(timeline: dict, lang: str, path: Path) -> None:
    lines = []
    for i, sh in enumerate(timeline["shots"], start=1):
        text = re.sub(r"\*\*(.+?)\*\*", r"\1", sh["cap"] if lang == "zh" else sh["en"])
        lines += [str(i), f"{fmt_ts(sh['cap_in'])} --> {fmt_ts(sh['cap_out'])}", text, ""]
    path.write_text("\n".join(lines), encoding="utf-8")


# ── CLI ───────────────────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", default="16x9", choices=list(LAYOUTS))
    ap.add_argument("--target", type=float, default=None)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--no-vo", action="store_true")
    ap.add_argument("--skip-audio", action="store_true")
    ap.add_argument("--tag", default="", help="输出文件名后缀（调试用）")
    ap.add_argument("--banner", action="store_true",
                    help="SH-03 使用带「浏览器只能录麦克风」提示条的素材（默认用隐藏该条的干净版）")
    args = ap.parse_args()

    if args.banner:
        for _s in SHOTS:
            if _s.id == "SH-03":
                _s.src = ["record-start", "live-caption"]
    layout = LAYOUTS[args.layout]
    target = args.target or (TARGET_16x9 if args.layout == "16x9" else TARGET_9x16)
    vo_meta = load_vo_meta()
    vo_dur = {k: v["dur"] for k, v in vo_meta.items()}
    if not vo_dur:
        print("⚠ 还没有 audio/vo-manifest.json，时间轴按 min_dur 估算（合成阶段需重跑）")
    use = ([s for s in SHOTS if s.id in VERTICAL_IDS] if layout.name == "9x16" else SHOTS)
    tl = build_timeline(target, vo_dur, layout, vo_meta, use)
    # 每个画幅各写一份，验收按画幅取用；timeline.json **只由 16:9 主片写**，
    # 否则竖版渲染会把它覆盖掉，校验器就会拿错时间轴去比对（曾经因此假报 1/6 通过）。
    (BUILD / f"timeline-{layout.name}.json").write_text(
        json.dumps(tl, ensure_ascii=False, indent=2), encoding="utf-8")
    if layout.name == "16x9":
        (BUILD / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=2),
                                             encoding="utf-8")
    print(f"时间轴 layout={layout.name} 分镜={len(use)} total={tl['total_s']}s "
          f"target={target}s（下限由旁白决定，到不了也不硬压）")
    for sh in tl["shots"]:
        print(f"  {sh['id']}  {sh['start']:6.2f} → {sh['start'] + sh['dur']:6.2f} "
              f"({sh['dur']:5.2f}s)  vo={sh['vo_dur']:5.2f}s  {sh['note']}")
    if args.dry_run:
        return

    OUT.mkdir(parents=True, exist_ok=True)
    if args.preview:
        encode(tl, layout, OUT / "preview.mp4", args.crf, args.preset,
               Overlays(tl, layout), preview_only=True, preview_dir=TMP / "preview")
        return

    suffix = "-novo" if args.no_vo else ""
    vid = TMP / f"video-{layout.name}{suffix}{args.tag}.mp4"
    ov = Overlays(tl, layout)
    encode(tl, layout, vid, args.crf, args.preset, ov)

    final = OUT / f"notestogo-promo-{layout.name}{suffix}{args.tag}.mp4"
    if args.skip_audio:
        vid.replace(final)
    else:
        mix = build_mix(tl, with_vo=not args.no_vo, out_path=TMP / f"mix-{layout.name}{suffix}.wav")
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                        "-i", str(vid), "-i", str(mix),
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                        "-shortest", "-movflags", "+faststart", str(final)], check=True)
        print(f"[mix] {probe_audio(mix)}")
    print(f"[done] {final}")

    if layout.name == "16x9" and not args.no_vo:
        write_srt(tl, "zh", PROMO / "script" / "subtitles-zh.srt")
        write_srt(tl, "en", PROMO / "script" / "subtitles-en.srt")
        print("[srt] subtitles-zh.srt / subtitles-en.srt")


if __name__ == "__main__":
    main()
