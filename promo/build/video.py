"""
NotesToGO 宣传片 · 合成引擎（Lead 维护）

设计：
  - 画面 100% 由本脚本逐帧合成（Pillow + numpy），运镜/转场/字幕完全可控；
  - ffmpeg 只承担三件事：① 把录屏 webm 解码成 RGB 帧；② 编码最终 H.264；③ 混音。
  - 不调用任何视频生成模型。

坐标/配色真值来自 web/src/styles/main.css 与真实截图像素（见 promo/STORYBOARD.md §2）。
"""
from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── 路径 ──────────────────────────────────────────────────────────────────────
BUILD = Path(__file__).resolve().parent
PROMO = BUILD.parent
ROOT = PROMO.parent
CAPTURE = PROMO / "capture"
BRAND = PROMO / "assets" / "brand"
AUDIO = PROMO / "audio"
OUT = BUILD / "out"
TMP = BUILD / "_tmp"

# ── 设计真值 ──────────────────────────────────────────────────────────────────
PAPER = (251, 248, 242)          # #FBF8F2
PAPER_RAISE = (255, 253, 250)    # #FFFDFA
LINE = (227, 223, 216)           # #E3DFD8
INK = (58, 49, 40)               # #3A3128
INK2 = (122, 113, 104)           # #7A7168
ACCENT = (192, 87, 30)           # #C0571E  ← 品牌橘（README 里的青蓝已过期）

FONT_PATH = "/System/Library/Fonts/NotoSansSC-Variable.ttf"
FALLBACK_FONTS = [
    "/Users/fangchen/Library/Fonts/NotoSansSC-Variable.ttf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
]

_BRAND_MF: dict | None = None

FPS = 30
XFADE = 0.50      # 默认转场时长（秒）
VO_LEAD = 0.40      # 每条 VO 相对分镜起点的起播延迟
VO_TAIL = 0.35      # VO 结束后至少留白
VO_MIN_TAIL = 0.22  # 分镜时长下限里必须留给旁白的尾部余量

# ── 工具 ──────────────────────────────────────────────────────────────────────
_font_cache: dict[tuple[int, str], ImageFont.FreeTypeFont] = {}


def font(size: int, weight: str = "Medium") -> ImageFont.FreeTypeFont:
    key = (size, weight)
    if key in _font_cache:
        return _font_cache[key]
    path = FONT_PATH if Path(FONT_PATH).exists() else next(
        (p for p in FALLBACK_FONTS if Path(p).exists()), None
    )
    if path is None:
        raise RuntimeError("找不到可用的中文字体")
    f = ImageFont.truetype(path, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    _font_cache[key] = f
    return f


def ease_io(t: float) -> float:
    """smoothstep 缓入缓出，比线性运镜自然。"""
    t = min(max(t, 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def ease_out(t: float) -> float:
    t = min(max(t, 0.0), 1.0)
    return 1.0 - (1.0 - t) ** 3


def _even(v: float) -> int:
    return max(2, int(round(v / 2.0)) * 2)


def crop_resize(img: Image.Image, zoom: float, cx: float, cy: float, w: int, h: int) -> Image.Image:
    """以 (cx,cy) 为归一化中心、按 zoom 裁切并缩放到 w×h。zoom>=1 表示放大。"""
    iw, ih = img.size
    # 先按目标宽高比裁出最大可用区域，保证不变形
    target_ar = w / h
    src_ar = iw / ih
    if src_ar > target_ar:
        ch = ih
        cw = ih * target_ar
    else:
        cw = iw
        ch = iw / target_ar
    cw /= zoom
    ch /= zoom
    x = cx * iw - cw / 2
    y = cy * ih - ch / 2
    x = min(max(x, 0.0), iw - cw)
    y = min(max(y, 0.0), ih - ch)
    box = (int(round(x)), int(round(y)), int(round(x + cw)), int(round(y + ch)))
    patch = img.crop(box)
    ratio = cw / w
    if abs(ratio - 1.0) < 0.004:
        return patch if patch.size == (w, h) else patch.resize((w, h), Image.BILINEAR)
    if ratio > 1.25:
        filt = Image.BOX                      # 大幅降采样：BOX 又快又准
    else:
        filt = Image.BILINEAR                 # 小幅缩放：BILINEAR 足够且快得多
    return patch.resize((w, h), filt)


# ── 字幕 ──────────────────────────────────────────────────────────────────────
_TOKEN = re.compile(r"\*\*(.+?)\*\*")


def _measure(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont) -> float:
    return draw.textlength(text, font=f)


def caption_image(text: str, box_w: int, size: int = 36, max_w: int | None = None) -> Image.Image:
    """生成字幕胶囊（RGBA）。支持 **关键词** 语法渲染成品牌橘。"""
    max_w = max_w or int(box_w * 0.66)
    while size > 20:
        f = font(size, "Medium")
        parts = _TOKEN.split(text)
        tmp = Image.new("RGBA", (8, 8))
        d = ImageDraw.Draw(tmp)
        total = sum(_measure(d, p, f) for p in parts if p)
        # 中英混排留一点字距补偿
        total *= 1.02
        if total + size * 2.2 <= max_w:
            break
        size -= 2
    f = font(size, "Medium")
    parts = _TOKEN.split(text)
    asc, desc = f.getmetrics()
    text_h = asc + desc
    pad_x, pad_y = int(size * 0.86), int(size * 0.52)
    w = int(sum(_measure(d, p, f) for p in parts if p) * 1.02) + pad_x * 2
    h = text_h + pad_y * 2

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(size * 0.42),
                        fill=PAPER_RAISE + (238,), outline=LINE + (255,), width=2)
    x = pad_x
    for i, p in enumerate(parts):
        if not p:
            continue
        if i % 2 == 0:
            d.text((x, pad_y), p, font=f, fill=INK + (255,))
        else:
            # 关键词后垫一层极淡橘色底
            tw = _measure(d, p, f) * 1.02
            d.rounded_rectangle([x - size * 0.14, pad_y - size * 0.1,
                                 x + tw + size * 0.14, pad_y + text_h + size * 0.08],
                                radius=int(size * 0.3), fill=(192, 87, 30, 26))
            d.text((x, pad_y), p, font=f, fill=ACCENT + (255,))
        x += _measure(d, p, f) * 1.02
    return img


def watermark_image(size: int = 24) -> Image.Image:
    """● NotesToGO · 拾贝 品牌水印（RGBA）。"""
    f = font(size, "SemiBold")
    f2 = font(size, "Regular")
    label, sub = "NotesToGO", " · 拾贝"
    tmp = Image.new("RGBA", (8, 8))
    d = ImageDraw.Draw(tmp)
    dot = int(size * 0.5)
    gap = int(size * 0.62)
    w1, w2 = _measure(d, label, f), _measure(d, sub, f2)
    asc, desc = f.getmetrics()
    W = dot + gap + int(w1 + w2) + 4
    H = asc + desc
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cy = int(H * 0.52)
    d.ellipse([0, cy - dot // 2, dot, cy + dot // 2], fill=ACCENT + (245,))
    d.text((dot + gap, 0), label, font=f, fill=INK + (232,))
    d.text((dot + gap + w1, 0), sub, font=f2, fill=INK2 + (232,))
    return img


# ── 图层 ──────────────────────────────────────────────────────────────────────
def bottom_scrim(w: int, h: int, height: int, alpha: float = 0.93) -> Image.Image:
    """底部纸色渐隐，让 UI 自然过渡到字幕区（暖纸主题的语言）。"""
    col = np.zeros((height, 1, 4), dtype=np.float32)
    ramp = np.linspace(0.0, alpha, height, dtype=np.float32) ** 0.85
    col[:, 0, 0] = PAPER[0]
    col[:, 0, 1] = PAPER[1]
    col[:, 0, 2] = PAPER[2]
    col[:, 0, 3] = ramp * 255.0
    band = np.repeat(col, w, axis=1).astype(np.uint8)
    img = Image.fromarray(band, "RGBA")
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(img, (0, h - height))
    return canvas


def card_shadow(img: Image.Image, blur: int = 26, spread: int = 0,
                alpha: int = 46, offset_y: int = 14) -> Image.Image:
    """给 RGBA 卡片生成柔和投影，返回比原图大一圈的 RGBA。"""
    pad = blur * 2 + spread + offset_y
    w, h = img.size
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    alpha_mask = img.split()[3].point(lambda v: min(255, int(v * alpha / 255)))
    shadow = Image.new("RGBA", img.size, (60, 45, 34, 255))
    shadow.putalpha(alpha_mask)
    sh.paste(shadow, (pad, pad + offset_y), shadow)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    sh.alpha_composite(img, (pad, pad))
    return sh


def rounded(img: Image.Image, radius: int) -> Image.Image:
    out = img.convert("RGBA")
    mask = Image.new("L", out.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1],
                                           radius=radius, fill=255)
    out.putalpha(mask)
    return out


def trim_alpha(img: Image.Image, pad: int = 0) -> Image.Image:
    """把 RGBA 图裁到实际墨迹范围（品牌素材给的是整幅 1080p 画布，需先收紧）。"""
    img = img.convert("RGBA")
    bb = img.getbbox()
    if bb is None:
        return img
    if pad:
        bb = (max(0, bb[0] - pad), max(0, bb[1] - pad),
              min(img.size[0], bb[2] + pad), min(img.size[1], bb[3] + pad))
    return img.crop(bb)


def brand_manifest() -> dict:
    """读品牌素材的 MANIFEST.json（device 内屏坐标等接口真值）。失败则返回空。"""
    global _BRAND_MF
    if _BRAND_MF is None:
        p = BRAND / "MANIFEST.json"
        try:
            _BRAND_MF = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        except Exception:
            _BRAND_MF = {}
    return _BRAND_MF


def _asset_entry(fname: str) -> dict:
    for a in brand_manifest().get("assets", []):
        if a.get("file") == fname:
            return a
    return {}


# ── 版式 ──────────────────────────────────────────────────────────────────────
@dataclass
class Layout:
    name: str
    W: int
    H: int
    ui_full_bleed: bool = True       # 16:9：UI 铺满；9:16：UI 做成居中小窗
    scrim_h: int = 340
    cap_size: int = 36
    cap_bottom: int = 62
    cap_max_w_ratio: float = 0.66
    ui_y: int = 0                    # 小窗模式下的 y
    ui_w_ratio: float = 1.0
    show_watermark: bool = False
    show_progress: bool = True

    def ui_size(self) -> tuple[int, int]:
        if self.ui_full_bleed:
            return self.W, self.H
        uw = int(self.W * self.ui_w_ratio)
        return uw, _even(uw * 9 / 16)


LAYOUTS = {
    "16x9": Layout("16x9", 1920, 1080),
    "9x16": Layout("9x16", 1080, 1920, ui_full_bleed=False, scrim_h=620,
                   cap_size=44, cap_bottom=280, cap_max_w_ratio=0.86,
                   ui_y=430, ui_w_ratio=0.92, show_watermark=True),
}


# ── 帧源 ──────────────────────────────────────────────────────────────────────
class FrameSource:
    """统一接口：给出 canvas 级 RGB 帧（不含字幕/水印，那由 driver 统一叠）。"""

    def __init__(self, layout: Layout):
        self.layout = layout

    def frame(self, i: int, n: int) -> Image.Image:  # pragma: no cover - 抽象
        raise NotImplementedError

    def close(self) -> None:
        pass


class PaperSource(FrameSource):
    """纯纸底 + 淡横格线（无品牌素材也能跑）。"""

    def __init__(self, layout: Layout, bg_png: Path | None = None):
        super().__init__(layout)
        L = layout
        if bg_png and Path(bg_png).exists():
            base = Image.open(bg_png).convert("RGB").resize((L.W, L.H), Image.LANCZOS)
        else:
            base = Image.new("RGB", (L.W, L.H), PAPER)
            d = ImageDraw.Draw(base)
            step = 48
            for y in range(140, L.H, step):
                d.line([(0, y), (L.W, y)], fill=(238, 233, 224), width=1)
        self.base = base

    def frame(self, i: int, n: int) -> Image.Image:
        return self.base.copy()


class CardSource(FrameSource):
    """整屏品牌卡片（hook / title / end / cover），带极缓推近。"""

    def __init__(self, layout: Layout, png: Path, zoom: float = 0.03,
                 content: tuple | None = None, bg: Path | None = None):
        super().__init__(layout)
        self.img = Image.open(png).convert("RGB")
        self.zoom = zoom
        # 竖版：16:9 卡片居中裁切会切掉字标 → 只取内容框，放大落到纸底中央
        self.portrait = None
        if content and layout.H > layout.W:
            x0, y0, x1, y1 = content
            pad = 24
            self.portrait = self.img.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
            base = Image.open(bg).convert("RGB") if bg else Image.new("RGB", (8, 8), PAPER)
            self.bg = crop_resize(base, 1.0, 0.5, 0.5, layout.W, layout.H)

    def frame(self, i: int, n: int) -> Image.Image:
        L = self.layout
        t = ease_io(i / max(1, n - 1))
        z = 1.0 + self.zoom * t
        if self.portrait is None:
            return crop_resize(self.img, z, 0.5, 0.5 - 0.012 * t, L.W, L.H)
        w = int((L.W - 2 * 96) * z)
        h = int(self.portrait.size[1] * w / self.portrait.size[0])
        out = self.bg.copy()
        out.paste(self.portrait.resize((w, h), Image.LANCZOS), ((L.W - w) // 2, (L.H - h) // 2))
        return out


class UiStillSource(FrameSource):
    """真实 UI 静帧（4K），Ken Burns 后按版式落位。

    性能：先把 4K 源一次性降到「最大缩放所需的分辨率」，之后逐帧只做小幅重采样。
    """

    def __init__(self, layout: Layout, png: Path, zoom=(1.0, 1.045),
                 center=(0.5, 0.5), drift=(0.0, 0.0)):
        super().__init__(layout)
        img = Image.open(png).convert("RGB")
        uw, uh = layout.ui_size()
        need_w = math.ceil(uw * max(zoom) * 1.02 / 64) * 64
        if img.size[0] > need_w:
            h = int(round(img.size[1] * need_w / img.size[0] / 2) * 2)
            img = img.resize((need_w, h), Image.LANCZOS)
        self.img = img
        self.zoom = zoom
        self.center = center
        self.drift = drift

    def frame(self, i: int, n: int) -> Image.Image:
        L = self.layout
        t = ease_io(i / max(1, n - 1))
        z = self.zoom[0] + (self.zoom[1] - self.zoom[0]) * t
        cx = self.center[0] + self.drift[0] * t
        cy = self.center[1] + self.drift[1] * t
        uw, uh = L.ui_size()
        ui = crop_resize(self.img, z, cx, cy, uw, uh)
        return self._place(ui)

    def _place(self, ui: Image.Image) -> Image.Image:
        L = self.layout
        canvas = Image.new("RGB", (L.W, L.H), PAPER)
        if L.ui_full_bleed:
            return ui
        card = card_shadow(rounded(ui, 18), blur=30, alpha=52, offset_y=16)
        x = (L.W - card.size[0]) // 2
        y = L.ui_y - (card.size[1] - ui.size[1]) // 2
        canvas.paste(card.convert("RGB"), (x, y), card)
        return canvas


class UiClipSource(FrameSource):
    """录屏 webm：ffmpeg 解码成 RGB 帧流，逐帧 Ken Burns + 落位。短则冻结末帧。"""

    def __init__(self, layout: Layout, webm: Path, zoom=(1.0, 1.02)):
        super().__init__(layout)
        L = layout
        self.zoom = zoom
        self._last: Image.Image | None = None
        vf = (f"fps={FPS},scale=1920:1080:force_original_aspect_ratio=increase,"
              f"crop=1920:1080,setsar=1,format=rgb24")
        self.proc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-i", str(webm), "-an", "-vf", vf,
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=10 ** 8)
        self.raw_w, self.raw_h = 1920, 1080
        self.nbytes = self.raw_w * self.raw_h * 3
        self._exhausted = False

    def _read(self) -> Image.Image | None:
        if self._exhausted:
            return None
        buf = self.proc.stdout.read(self.nbytes)
        if not buf or len(buf) < self.nbytes:
            self._exhausted = True
            return None
        return Image.frombytes("RGB", (self.raw_w, self.raw_h), buf)

    def frame(self, i: int, n: int) -> Image.Image:
        L = self.layout
        img = self._read()
        if img is not None:
            self._last = img
        elif self._last is not None:
            img = self._last                     # 冻结末帧（主持久定格）
        else:
            img = Image.new("RGB", (self.raw_w, self.raw_h), PAPER)
        t = ease_io(i / max(1, n - 1))
        z = self.zoom[0] + (self.zoom[1] - self.zoom[0]) * t
        uw, uh = L.ui_size()
        ui = crop_resize(img, z, 0.5, 0.5, uw, uh) if z > 1.0005 or not L.ui_full_bleed \
            else img.resize((uw, uh), Image.LANCZOS)
        return UiStillSource._place(self, ui)

    def close(self) -> None:
        try:
            self.proc.stdout.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class HookSource(FrameSource):
    """SH-01 钩子：纸底大字逐句浮现 → 结尾小窗推入真实 UI。

    注意：品牌给的 hook-*.png 是**整幅 1920x1080 画布**（文字居中），所以先
    trim_alpha 收紧成紧裁文字图，再由本类自己排版（两行堆叠）。
    """

    def __init__(self, layout: Layout, lines: list[Path], ui_png: Path | None,
                 bg_png: Path | None = None):
        super().__init__(layout)
        L = layout
        self.bg = PaperSource(layout, bg_png).base.convert("RGBA")
        self.raw_lines = [trim_alpha(Image.open(p)) for p in lines if Path(p).exists()]
        if self.raw_lines:
            maxw = int(L.W * 0.86)
            scaled = []
            for ln in self.raw_lines:
                if ln.size[0] > maxw:
                    h = int(round(ln.size[1] * maxw / ln.size[0]))
                    ln = ln.resize((maxw, h), Image.LANCZOS)
                scaled.append(ln)
            self.lines = scaled
        else:
            self.lines = []
        self.ui = Image.open(ui_png).convert("RGB") if ui_png and Path(ui_png).exists() else None
        if self.ui:
            uw = int(L.W * 0.46)
            uh = _even(uw * self.ui.size[1] / self.ui.size[0])
            self.ui_small = card_shadow(rounded(self.ui.resize((uw, uh), Image.LANCZOS), 14),
                                        blur=24, alpha=48, offset_y=12)
        else:
            self.ui_small = None

    def _line_y(self, k: int) -> int:
        """两行整体垂直居中在 0.40*H 附近（下方留出小窗空间）。"""
        L = self.layout
        hs = [ln.size[1] for ln in self.lines]
        gap = int(L.H * 0.045)
        block = sum(hs) + gap * max(0, len(hs) - 1)
        top = int(L.H * 0.40 - block / 2)
        return top + sum(hs[:k]) + gap * k

    def frame(self, i: int, n: int) -> Image.Image:
        L = self.layout
        base = self.bg.copy()
        t = i / FPS
        for k, ln in enumerate(self.lines[:2]):
            t0 = 0.40 + k * 1.55
            a = ease_out((t - t0) / 0.60)
            if a <= 0:
                continue
            y = self._line_y(k) + int((1 - a) * 28)
            x = (L.W - ln.size[0]) // 2
            tmp = ln.copy()
            tmp.putalpha(tmp.split()[3].point(lambda v, a=a: int(v * a)))
            base.alpha_composite(tmp, (x, y))
        # 小窗：最后 2.4s 推入
        if self.ui_small is not None and n / FPS > 2.4:
            t0 = n / FPS - 2.4
            a = ease_out((t - t0) / 0.95)
            if a > 0:
                card = self.ui_small
                x = int(L.W * 0.5 - card.size[0] / 2)
                y = int(L.H * 0.635 + (1 - a) * 120)
                tmp = card.copy()
                tmp.putalpha(tmp.split()[3].point(lambda v, a=a: int(v * a)))
                base.alpha_composite(tmp, (x, y))
        return base.convert("RGB")


def probe_duration(path: Path) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)], capture_output=True, text=True)
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def blend_np(a: np.ndarray, b: np.ndarray, alpha: float) -> np.ndarray:
    return (a.astype(np.float32) * (1 - alpha) + b.astype(np.float32) * alpha).astype(np.uint8)


class SeqClipSource(FrameSource):
    """把多段录屏串在一个分镜里（如「点开始录音」→「实时字幕」）。

    段间用 0.2s 交叉溶解；每段内部沿用 UiClipSource 的 Ken Burns 与落位。
    帧数记账与分镜级转场同一套：每段承担 head/tail 各 xf 帧的溶解消耗。
    """

    def __init__(self, layout: Layout, paths: list[Path], zoom=(1.0, 1.02), xfade: float = 0.2):
        super().__init__(layout)
        self.sources = [UiClipSource(layout, p, zoom=zoom) for p in paths]
        self.durs = [max(0.4, probe_duration(p)) for p in paths]
        self.xf = max(1, int(round(xfade * FPS)))
        self._gen = None

    def _counts(self, n: int) -> list[int]:
        k = len(self.sources)
        if k == 1:
            return [n]
        budget = n + self.xf * (k - 1)          # 段总帧数（含被溶解吃掉的）
        tot = sum(self.durs)
        cs = [max(self.xf * 2 + 2, int(round(budget * d / tot))) for d in self.durs]
        # 修正到精确 n
        for _ in range(8):
            delta = sum(cs) - self.xf * (k - 1) - n
            if delta == 0:
                break
            i = 0 if delta > 0 else int(np.argmax(cs))
            cs[i] -= 1 if delta > 0 else -1
        return cs

    def _frames(self, n: int):
        cs = self._counts(n)
        prev_tail: list[np.ndarray] = []
        prev_xf = 0
        for s, c in enumerate(cs):
            xf_next = self.xf if s < len(cs) - 1 else 0
            src = self.sources[s]
            it = (np.asarray(src.frame(k, c)) for k in range(max(1, c)))
            head_n = prev_xf
            if prev_tail and head_n:
                head = [next(it) for _ in range(head_n)]
                for k in range(head_n):
                    a = (k + 1) / (head_n + 1)
                    yield blend_np(prev_tail[k], head[k], a * a * (3 - 2 * a))
            for _ in range(max(0, c - head_n - xf_next)):
                yield next(it)
            prev_tail = [next(it) for _ in range(xf_next)] if xf_next else []
            prev_xf = xf_next

    def frame(self, i: int, n: int) -> Image.Image:
        if self._gen is None:
            self._gen = self._frames(n)
        return Image.fromarray(next(self._gen), "RGB")

    def close(self) -> None:
        for s in self.sources:
            s.close()


class DeviceShowcaseSource(FrameSource):
    """SH-09 多端：真实截图装进品牌机身框，两台设备依次滑入。

    采用 brand 实测并逐像素校验过的「整幅平移」方案（frames_side_by_side）：
    整张 1920x1080 机身帧直接平移，以保住机身自带的柔和投影；不做裁片。
    内屏坐标来自 assets/brand/MANIFEST.json 的 screen_rect（brand↔build 的接口真值）。
    """

    DEF_PHONE = {"screen": (770, 128, 380, 824), "offset": (-414, 0)}
    DEF_TABLET = {"screen": (654, 132, 612, 816), "offset": (296, 0)}
    V_PHONE = {"screen": (770, 128, 380, 824), "offset": (-420, 256)}

    def __init__(self, layout: Layout, phone_png: Path | None, tablet_png: Path | None,
                 bg_png: Path | None = None):
        super().__init__(layout)
        self.bg = PaperSource(layout, bg_png).base.convert("RGBA")
        self.layers: list[tuple[Image.Image, int, int, float]] = []
        self.boxes: list[tuple[int, int, int, int]] = []   # 各设备在成片里的 bbox
        self.lift = 0                                      # 由 render 按字幕位置设定
        vertical = layout.name == "9x16"
        if phone_png and Path(phone_png).exists():
            g = self.V_PHONE if vertical else self._geom("phone-frame.png", self.DEF_PHONE)
            layer = self._compose("phone-frame.png", phone_png, g["screen"])
            if layer is not None:
                self.layers.append((layer, g["offset"][0], g["offset"][1], 0.35))
                self.boxes.append(self._box("phone-frame.png", g["offset"]))
        if not vertical and tablet_png and Path(tablet_png).exists():
            g = self._geom("tablet-frame.png", self.DEF_TABLET)
            if self._aspect_ok(tablet_png, g["screen"]):
                layer = self._compose("tablet-frame.png", tablet_png, g["screen"])
                if layer is not None:
                    self.layers.append((layer, g["offset"][0], g["offset"][1], 0.80))
                    self.boxes.append(self._box("tablet-frame.png", g["offset"]))
            else:
                # 截图比例与内屏差太多（如横版截图配竖版机身）：cover 会裁掉近一半画面，
                # 宁可降级成「手机居中」也不要出一台看起来被裁烂的平板。
                self.layers = [(l, 0, 0, d) for (l, _, _, d) in self.layers]
                print(f"  ⚠ 平板截图 {Path(tablet_png).name} 比例与内屏不符，SH-09 降级为手机居中")

    @staticmethod
    def _box(frame_name: str, offset: tuple) -> tuple:
        """机身整幅平移后，设备实体在成片里的 bbox（用于安全框/避让字幕的几何校验）。"""
        e = _asset_entry(frame_name)
        b = e.get("device_bbox") or {}
        return (int(b.get("x", 0) + offset[0]), int(b.get("y", 0) + offset[1]),
                int(b.get("w", 0)), int(b.get("h", 0)))

    def check_against_brand(self) -> list[str]:
        """把品牌在 MANIFEST 里给出的目标坐标当作接口契约，逐项对账。"""
        side = brand_manifest().get("frames_side_by_side", {})
        msgs = []
        for (frame_name, box) in zip(("phone-frame.png", "tablet-frame.png"), self.boxes):
            key = "phone" if frame_name.startswith("phone") else "tablet"
            want = (side.get(key) or {}).get("device_then")
            if not want:
                continue
            if [int(v) for v in want] != [int(v) for v in box]:
                msgs.append(f"{key} 设备落位与 MANIFEST.device_then 不一致: "
                            f"实算 {list(box)} vs 品牌 {list(want)}")
        return msgs

    def bottom(self) -> int:
        return max((y + h for _, y, _, h in self.boxes), default=0)

    @staticmethod
    def _aspect_ok(png: Path, screen: tuple, tol: float = 0.25) -> bool:
        try:
            from PIL import Image as _I
            with _I.open(png) as im:
                a = im.size[0] / im.size[1]
        except Exception:
            return False
        b = screen[2] / screen[3]
        return abs(a - b) / b <= tol

    @staticmethod
    def _geom(frame_name: str, default: dict) -> dict:
        e = _asset_entry(frame_name)
        sr, rc = e.get("screen_rect") or {}, e.get("regions", {})
        off = None
        key = "phone" if frame_name.startswith("phone") else "tablet"
        node = brand_manifest().get("frames_side_by_side", {}).get(key, {}) or {}
        # brand 的「推荐方案」给的是整幅画布的 overlay 偏移（png_overlay_at）；
        # alternative_crop 分支才是 place_at（裁片后落位），两者不可混用。
        if node.get("png_overlay_at"):
            off = (int(node["png_overlay_at"][0]), int(node["png_overlay_at"][1]))
        elif node.get("place_at"):
            dev = e.get("device_bbox") or {}
            off = (int(node["place_at"][0]) - dev.get("x", 0),
                   int(node["place_at"][1]) - dev.get("y", 0))
        return {"screen": (sr["x"], sr["y"], sr["w"], sr["h"]) if sr else default["screen"],
                "offset": off or default["offset"]}

    def _compose(self, frame_name: str, shot_png: Path, screen: tuple) -> Image.Image | None:
        frame_path = BRAND / frame_name
        if not Path(frame_path).exists():
            return None
        sx, sy, sw, sh = screen
        shot = Image.open(shot_png).convert("RGB")
        k = max(sw / shot.size[0], sh / shot.size[1])          # cover：铺满内屏再居中裁
        rs = shot.resize((max(1, int(shot.size[0] * k)), max(1, int(shot.size[1] * k))),
                         Image.LANCZOS)
        rs = rs.crop(((rs.size[0] - sw) // 2, (rs.size[1] - sh) // 2,
                      (rs.size[0] - sw) // 2 + sw, (rs.size[1] - sh) // 2 + sh))
        layer = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
        layer.paste(rs, (sx, sy))
        layer.alpha_composite(Image.open(frame_path).convert("RGBA"), (0, 0))
        return layer

    def frame(self, i: int, n: int) -> Image.Image:
        L = self.layout
        base = self.bg.copy()
        t = i / FPS
        for layer, dx, dy, delay in self.layers:
            a = ease_out((t - delay) / 0.75)
            if a <= 0:
                continue
            y = int(dy + self.lift + (1 - a) * 90)
            tmp = layer.copy()
            tmp.putalpha(tmp.split()[3].point(lambda v, a=a: int(v * a)))
            base.alpha_composite(tmp, (int(dx), y))
        out = base.convert("RGB")
        z = 1.0 + 0.03 * ease_io(i / max(1, n - 1))
        if z > 1.0005:
            out = crop_resize(out, z, 0.5, 0.5, L.W, L.H)
        return out


