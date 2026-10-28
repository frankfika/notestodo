#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NotesToGO · 拾贝 —— 品牌排版素材生成器（promo task-2 / 负责人 brand）

依赖：bundled Python + Pillow + numpy
  /Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3

产物：promo/assets/brand/*.png + MANIFEST.json
契约：promo/STORYBOARD.md 第 2 节（设计真值）、第 3 节（SH-01/02/09/10）、第 4.2 节（素材契约）

设计约束（硬）：
  - 纸 #FBF8F2 / 抬起白 #FEFCF9 / 线 #E3DFD8 / 墨 #3A3128 / 次要 #7A7168 / 品牌橘 #C0571E（唯一强调色）
  - 不用 emoji；符号仅 ● ▣ ◆ ✎ ✓；中文标点全角
  - 四周安全框 >= 96px；4pt 网格；圆角 12/16/24 三档
  - 1:1 像素对齐：形状层 4x 超采样后 LANCZOS 降采样，文字在最终分辨率上直接绘制（不做二次缩放）
"""

import json
import os
import sys
import datetime

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

# --------------------------------------------------------------------------- #
# 0. 基本常量
# --------------------------------------------------------------------------- #

W, H = 1920, 1080
SAFE = 96
GRID = 4

PAPER = (251, 248, 242)   # #FBF8F2
RAISE = (254, 252, 249)   # #FEFCF9
LINE = (227, 223, 216)    # #E3DFD8
INK = (58, 49, 40)        # #3A3128
MUTED = (122, 113, 104)   # #7A7168
ORANGE = (192, 87, 30)    # #C0571E
DARK = (38, 34, 30)       # #26221E
DARK_TOP = (50, 44, 38)
DARK_BOT = (30, 26, 22)

RADIUS_S, RADIUS_M, RADIUS_L = 12, 16, 24

SEED = 20261018

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROMO_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(PROMO_DIR, "assets", "brand")
REVIEW_DIR = os.path.join(OUT_DIR, "_review")

# 安全框自检登记表：name -> [x0, y0, x1, y1]
SAFE_BOXES = {}
# MANIFEST 条目
MANIFEST_ENTRIES = []
FONT_INFO = {}


def register_safe(name, x0, y0, x1, y1):
    box = [int(np.floor(x0)), int(np.floor(y0)), int(np.ceil(x1)), int(np.ceil(y1))]
    prev = SAFE_BOXES.get(name)
    if prev is None:
        SAFE_BOXES[name] = box
    else:
        SAFE_BOXES[name] = [
            min(prev[0], box[0]), min(prev[1], box[1]),
            max(prev[2], box[2]), max(prev[3], box[3]),
        ]
    return box


def snap(v):
    """吸附到 4pt 网格。"""
    return int(round(v / GRID) * GRID)


# --------------------------------------------------------------------------- #
# 1. 字体
# --------------------------------------------------------------------------- #

FONT_CANDIDATES = [
    ("Noto Sans SC (variable)", "/System/Library/Fonts/NotoSansSC-Variable.ttf"),
    ("Noto Sans SC (variable)", os.path.expanduser("~/Library/Fonts/NotoSansSC-Variable.ttf")),
    ("PingFang SC", "/System/Library/Fonts/PingFang.ttc"),
    ("Hiragino Sans GB", "/System/Library/Fonts/Hiragino Sans GB.ttc"),
]

_FONT_PATH = None
_FONT_LABEL = None
_FONT_VARIABLE = False
_FONT_CACHE = {}


def resolve_font():
    global _FONT_PATH, _FONT_LABEL, _FONT_VARIABLE
    if _FONT_PATH:
        return _FONT_PATH
    for label, path in FONT_CANDIDATES:
        if os.path.exists(path):
            _FONT_PATH, _FONT_LABEL = path, label
            break
    if not _FONT_PATH:
        raise SystemExit("找不到可用的中文字体（Noto Sans SC / PingFang SC / Hiragino Sans GB）")
    probe = ImageFont.truetype(_FONT_PATH, 40)
    try:
        probe.get_variation_names()
        _FONT_VARIABLE = True
    except Exception:
        _FONT_VARIABLE = False
    return _FONT_PATH


def font(size, weight="Regular"):
    """取得指定字号 / 字重的字体实例（可变字体用命名实例，非可变字体退化为 Regular）。"""
    resolve_font()
    key = (int(size), weight)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    f = ImageFont.truetype(_FONT_PATH, int(size))
    if _FONT_VARIABLE:
        try:
            f.set_variation_by_name(weight)   # 就地修改，返回 None
        except Exception:
            pass
    _FONT_CACHE[key] = f
    return f


def ink_bbox(text, fnt):
    """相对锚点 'la'（左侧 + 字身线上沿）的墨迹包围盒。"""
    return fnt.getbbox(text)


def text_width(text, fnt, tracking=0):
    """字身（advance）总宽。"""
    if not text:
        return 0.0
    if tracking == 0:
        return float(fnt.getlength(text))
    return float(sum(fnt.getlength(c) for c in text) + tracking * (len(text) - 1))


def run_metrics(text, fnt, tracking=0):
    """
    逐字累计，返回 (advance, ink_x0, ink_x1, ink_y0, ink_y1)。
    逐字计算才能让「字距」也计入墨迹范围 —— 中文全角标点（，。？）的墨迹只占字身左半边，
    按字身居中会让整行看起来偏左，所以居中一律用墨迹范围（光学居中）。
    """
    x = 0.0
    ix0 = ix1 = iy0 = iy1 = None
    n = len(text)
    for i, ch in enumerate(text):
        bb = fnt.getbbox(ch)
        if ix0 is None:
            ix0, ix1, iy0, iy1 = x + bb[0], x + bb[2], bb[1], bb[3]
        else:
            ix0 = min(ix0, x + bb[0])
            ix1 = max(ix1, x + bb[2])
            iy0 = min(iy0, bb[1])
            iy1 = max(iy1, bb[3])
        x += fnt.getlength(ch)
        if i < n - 1:
            x += tracking
    if ix0 is None:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    return x, ix0, ix1, iy0, iy1


def draw_run(d, x, y_la, text, fnt, fill, tracking=0):
    """按 'la' 锚点绘制一段文字（支持字距），返回下一段的起始 x。"""
    if tracking == 0:
        d.text((x, y_la), text, font=fnt, fill=fill, anchor="la")
        return x + fnt.getlength(text)
    for ch in text:
        d.text((x, y_la), ch, font=fnt, fill=fill, anchor="la")
        x += fnt.getlength(ch) + tracking
    return x


def _layout_line(runs, tracking, spacing):
    infos = []
    total = 0.0
    for i, (text, fnt, fill) in enumerate(runs):
        if i:
            total += spacing
        adv, ix0, ix1, iy0, iy1 = run_metrics(text, fnt, tracking)
        infos.append({"text": text, "font": fnt, "fill": fill, "off": total,
                      "adv": adv, "ix0": ix0, "ix1": ix1, "iy0": iy0, "iy1": iy1})
        total += adv
    ink0 = min(o["off"] + o["ix0"] for o in infos)
    ink1 = max(o["off"] + o["ix1"] for o in infos)
    iy0 = min(o["iy0"] for o in infos)
    iy1 = max(o["iy1"] for o in infos)
    return infos, total, ink0, ink1, iy0, iy1


def _measure_ink(runs, tracking, spacing):
    """
    把整行先渲染到临时蒙版，量出「真实墨迹」包围盒。
    注意：Noto Sans SC 里中文全角标点的 getbbox() 返回整个字身框（并非墨迹），
    所以「，」「？」这类结尾标点只能靠实际渲染来量，否则整行会视觉偏左。
    """
    infos, total, ink0, ink1, iy0, iy1 = _layout_line(runs, tracking, spacing)
    pad = 64
    fmax = max(o["font"].size for o in infos)
    wt = int(total) + 2 * pad + 8
    ht = int(fmax * 2.4) + 2 * pad
    y_la0 = pad + int(fmax * 1.2)
    tmp = Image.new("L", (wt, ht), 0)
    td = ImageDraw.Draw(tmp)
    for o in infos:
        draw_run(td, pad + o["off"], y_la0, o["text"], o["font"], 255, tracking)
    bb = tmp.getbbox()
    return infos, bb, pad, y_la0


def draw_line_centered(d, cx, cy, runs, tracking=0, spacing=0, optical=True):
    """
    居中绘制一行（runs = [(text, font, fill), ...]）。
    cy = 该行「墨迹视觉中心」的 y；optical=True 时按真实墨迹居中（首尾全角标点
    的字身留白不计入），保证左右留白视觉对称。返回真实墨迹包围盒。
    """
    infos, bb, pad, y_la0 = _measure_ink(runs, tracking, spacing)
    if bb is None:
        return (cx, cy, cx, cy)
    if optical:
        dx = cx - (bb[0] + bb[2]) / 2.0
        dy = cy - (bb[1] + bb[3]) / 2.0
    else:
        total = sum(o["adv"] for o in infos) + spacing * (len(infos) - 1)
        dx = cx - total / 2.0 - pad
        dy = cy - (bb[1] + bb[3]) / 2.0
    for o in infos:
        draw_run(d, pad + dx + o["off"], y_la0 + dy, o["text"], o["font"], o["fill"], tracking)
    return (bb[0] + dx, bb[1] + dy, bb[2] + dx, bb[3] + dy)


def draw_line_left(d, x, cy, runs, tracking=0, spacing=0):
    """左对齐绘制一行（按字身左边缘对齐），cy 为墨迹视觉中心；返回墨迹包围盒。"""
    infos, total, ink0, ink1, iy0, iy1 = _layout_line(runs, tracking, spacing)
    y_la = cy - (iy0 + iy1) / 2.0
    for o in infos:
        draw_run(d, x + o["off"], y_la, o["text"], o["font"], o["fill"], tracking)
    return (x + ink0, y_la + iy0, x + ink1, y_la + iy1)


# --------------------------------------------------------------------------- #
# 2. 形状 / 合成工具（4x 超采样）
# --------------------------------------------------------------------------- #

SS = 4


class Layer:
    """超采样 RGBA 图层。"""

    def __init__(self, ss=SS):
        self.ss = ss
        self.img = Image.new("RGBA", (W * ss, H * ss), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def rect(self, box, fill, radius=0):
        x, y, w, h = box
        s = self.ss
        self.d.rounded_rectangle(
            [x * s, y * s, (x + w) * s - 1, (y + h) * s - 1],
            radius=radius * s, fill=fill,
        )

    def outline(self, box, color, width, radius=0, inset=0):
        x, y, w, h = box
        s = self.ss
        self.d.rounded_rectangle(
            [(x + inset) * s, (y + inset) * s,
             (x + w - inset) * s - 1, (y + h - inset) * s - 1],
            radius=max(0, radius - inset) * s, outline=color, width=int(width * s),
        )

    def mask_rect(self, box, radius=0, ss=None, size=None):
        s = ss or self.ss
        x, y, w, h = box
        m = Image.new("L", ((size or (W, H))[0] * s, (size or (W, H))[1] * s), 0)
        ImageDraw.Draw(m).rounded_rectangle(
            [x * s, y * s, (x + w) * s - 1, (y + h) * s - 1], radius=radius * s, fill=255
        )
        return m

    def flatten(self):
        return self.img.resize((W, H), Image.LANCZOS)


def comp(base, layer_rgba):
    """把 RGBA 图层合成到底图（RGB 或 RGBA）。"""
    if base.mode == "RGBA":
        base.alpha_composite(layer_rgba)
    else:
        base.paste(layer_rgba, (0, 0), layer_rgba)


def drop_shadow(base, box, radius, blur=20, alpha=0.14, dy=8, color=INK, punch=True):
    """
    圆角矩形柔和投影。
    punch=True 时扣除自身轮廓 —— 保证「镂空区域」（如机身内屏）不会被投影填充，保持全透明。
    """
    x, y, w, h = box
    s = 4
    m = Image.new("L", (W * s, H * s), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [x * s, (y + dy) * s, (x + w) * s - 1, (y + dy + h) * s - 1],
        radius=radius * s, fill=255,
    )
    m = m.filter(ImageFilter.GaussianBlur(blur * s)).resize((W, H), Image.LANCZOS)
    if punch:
        sharp = Image.new("L", (W, H), 0)
        ImageDraw.Draw(sharp).rounded_rectangle(
            [x, y, x + w - 1, y + h - 1], radius=radius, fill=255,
        )
        m = ImageChops.subtract(m, sharp)
    m = m.point(lambda v: int(v * alpha))
    sh = Image.new("RGBA", (W, H), color + (0,))
    sh.putalpha(m)
    comp(base, sh)


def gradient_rgb(c1, c2, vertical=True):
    a = np.zeros((H, W, 3), dtype=np.float32)
    t = (np.linspace(0, 1, H if vertical else W, dtype=np.float32))
    if not vertical:
        t = t[None, :]
    else:
        t = t[:, None]
    for i in range(3):
        a[..., i] = c1[i] + (c2[i] - c1[i]) * t
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGB")


# --------------------------------------------------------------------------- #
# 3. 纸张底
# --------------------------------------------------------------------------- #

_PAPER_CACHE = None


def paper_base(seed=SEED, grain=1.7, fiber=0.95, mottle=0.85, vignette=0.013):
    """纸色底 + 极轻纸纹噪点 + 极淡四周压暗。返回 RGB。"""
    global _PAPER_CACHE
    if _PAPER_CACHE is not None and seed == SEED and grain == 1.7:
        return _PAPER_CACHE.copy()

    rng = np.random.default_rng(seed)
    base = np.zeros((H, W, 3), dtype=np.float32)
    base[..., 0] = PAPER[0]
    base[..., 1] = PAPER[1]
    base[..., 2] = PAPER[2]

    # 细颗粒（亮度噪声，RGB 同步 → 无彩噪）
    g = rng.normal(0.0, grain, (H, W, 1)).astype(np.float32)
    # 低频纸浆斑
    lo = rng.normal(0.0, 1.0, (H // 6 + 2, W // 6 + 2)).astype(np.float32)
    lo = np.asarray(Image.fromarray(lo, "F").resize((W, H), Image.BICUBIC))
    # 水平纤维（横向拉伸的噪声）
    fi = rng.normal(0.0, 1.0, (H // 8 + 2, W // 64 + 2)).astype(np.float32)
    fi = np.asarray(Image.fromarray(fi, "F").resize((W, H), Image.BICUBIC))

    base += g + lo[..., None] * mottle + fi[..., None] * fiber

    # 极淡暗角
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nx = (xx - W / 2) / (W / 2)
    ny = (yy - H / 2) / (H / 2)
    r2 = (nx ** 2 + ny ** 2) / 2.0
    base -= (vignette * 255.0) * r2[..., None]

    img = Image.fromarray(np.clip(base + 0.5, 0, 255).astype(np.uint8), "RGB")
    _PAPER_CACHE = img
    return img.copy()


def paper_bg_with_rules(alpha=0.55, spacing=44):
    """纸底 + 极淡横格线（44px = 4pt 网格 × 11）。"""
    img = paper_base()
    dash = Layer()
    y = spacing
    while y < H:
        dash.d.rectangle([0, y * SS, W * SS - 1, y * SS + SS - 1],
                         fill=LINE + (int(255 * alpha),))
        y += spacing
    comp(img, dash.flatten())
    return img


# --------------------------------------------------------------------------- #
# 4. 素材：bg-paper-1920x1080.png
# --------------------------------------------------------------------------- #

def build_bg_paper(path):
    img = paper_bg_with_rules(alpha=0.55, spacing=44)
    img.save(path, optimize=True)
    MANIFEST_ENTRIES.append({
        "file": os.path.basename(path),
        "path": "promo/assets/brand/" + os.path.basename(path),
        "scene": ["SH-01", "SH-02", "SH-10", "底"],
        "purpose": "纸色底 + 极淡横格线 + 极轻纸纹噪点；SH-01/02/10 与卡片类素材的公共底，可直接作全片底层",
        "size": [W, H],
        "mode": "RGB",
        "has_alpha": False,
        "note": "底色 #FBF8F2；横格线 #E3DFD8（55% 不透明）× 44px 间距（4pt 网格倍数）；噪点标准差约 1.7 级；四角压暗约 3 级",
        "regions": {"full_bleed": [0, 0, W, H]},
    })
    return img


# --------------------------------------------------------------------------- #
# 5. 素材：title-card-1920x1080.png（SH-02）
# --------------------------------------------------------------------------- #

def build_title_card(path):
    img = paper_bg_with_rules()
    d = ImageDraw.Draw(img)

    f_mark = font(176, "ExtraBold")
    f_sub = font(52, "SemiBold")
    f_tag = font(40, "Regular")

    mark = "NotesToGO"
    mark_w = text_width(mark, f_mark, tracking=-2)
    dot_d = 40
    gap = 26
    total = dot_d + gap + mark_w

    cx = W // 2
    x0 = cx - total / 2.0
    mark_cy = 428

    bb = ink_bbox(mark, f_mark)
    y_la = mark_cy - (bb[1] + bb[3]) / 2.0

    # 橘色圆点（品牌母题）
    lay = Layer()
    dy = mark_cy - dot_d / 2.0
    lay.d.ellipse([x0 * SS, dy * SS, (x0 + dot_d) * SS - 1, (dy + dot_d) * SS - 1], fill=ORANGE + (255,))
    comp(img, lay.flatten())
    register_safe("title-card-1920x1080.png", x0, dy, W - x0, dy + dot_d)

    tx = x0 + dot_d + gap
    draw_run(d, tx, y_la, mark, f_mark, INK, tracking=-2)
    register_safe("title-card-1920x1080.png", tx, y_la + bb[1], tx + mark_w, y_la + bb[3])

    # 细分隔线
    lay = Layer()
    rule_w, rule_h = 96, 2
    lay.rect((cx - rule_w / 2, 532, rule_w, rule_h), LINE + (255,))
    comp(img, lay.flatten())
    register_safe("title-card-1920x1080.png", cx - rule_w / 2, 532, cx + rule_w / 2, 532 + rule_h)

    # 副标
    b = draw_line_centered(d, cx, 600, [("拾贝 · 会议速记 × 嵌套 OKR", f_sub, INK)], tracking=1)
    register_safe("title-card-1920x1080.png", *b)

    # 主张
    b = draw_line_centered(d, cx, 696, [("会中只记关键词，散会后一键成稿", f_tag, MUTED)], tracking=1)
    register_safe("title-card-1920x1080.png", *b)

    img.save(path, optimize=True)
    MANIFEST_ENTRIES.append({
        "file": os.path.basename(path),
        "path": "promo/assets/brand/" + os.path.basename(path),
        "scene": ["SH-02"],
        "purpose": "品牌亮相全屏卡：字标 NotesToGO + 橘点 + 副标 + 一句话主张",
        "size": [W, H],
        "mode": "RGB",
        "has_alpha": False,
        "text": ["NotesToGO", "拾贝 · 会议速记 × 嵌套 OKR", "会中只记关键词，散会后一键成稿"],
        "note": "含纸底与横格线，可与 bg-paper 无缝 crossfade；内容全部落在 96px 安全框内",
        "regions": {
            "wordmark_block": [round(x0), round(y_la + bb[1]), round(tx + mark_w), round(y_la + bb[3])],
            "orange_dot": [round(x0), round(dy), round(x0 + dot_d), round(dy + dot_d)],
            "safe_content": SAFE_BOXES["title-card-1920x1080.png"],
        },
    })
    return img


# --------------------------------------------------------------------------- #
# 6. 素材：end-card-1920x1080.png（SH-10）
# --------------------------------------------------------------------------- #

def build_end_card(path):
    img = paper_bg_with_rules()
    d = ImageDraw.Draw(img)

    f_mark = font(120, "ExtraBold")
    f_slogan = font(44, "Regular")
    f_url = font(34, "Medium")
    f_meta = font(32, "Regular")

    cx = W // 2
    mark = "NotesToGO"
    mark_w = text_width(mark, f_mark, tracking=-2)
    dot_d = 28
    gap = 20
    total = dot_d + gap + mark_w
    x0 = cx - total / 2.0
    mark_cy = 380

    bb = ink_bbox(mark, f_mark)
    y_la = mark_cy - (bb[1] + bb[3]) / 2.0

    lay = Layer()
    dy = mark_cy - dot_d / 2.0
    lay.d.ellipse([x0 * SS, dy * SS, (x0 + dot_d) * SS - 1, (dy + dot_d) * SS - 1], fill=ORANGE + (255,))
    comp(img, lay.flatten())

    tx = x0 + dot_d + gap
    draw_run(d, tx, y_la, mark, f_mark, INK, tracking=-2)
    register_safe("end-card-1920x1080.png", x0, min(dy, y_la + bb[1]), tx + mark_w, max(dy + dot_d, y_la + bb[3]))

    b = draw_line_centered(d, cx, 508, [("每个行动项，落到正确的 KR 上", f_slogan, MUTED)], tracking=1)
    register_safe("end-card-1920x1080.png", *b)

    lay = Layer()
    rule_w, rule_h = 320, 2
    lay.rect((cx - rule_w / 2, 820, rule_w, rule_h), LINE + (255,))
    comp(img, lay.flatten())
    register_safe("end-card-1920x1080.png", cx - rule_w / 2, 820, cx + rule_w / 2, 820 + rule_h)

    b = draw_line_centered(d, cx, 884, [("github.com/frankfika/notestodo", f_url, INK)], tracking=0.5)
    register_safe("end-card-1920x1080.png", *b)

    b = draw_line_centered(d, cx, 944, [("本地优先 · 开源", f_meta, MUTED)], tracking=1)
    register_safe("end-card-1920x1080.png", *b)

    img.save(path, optimize=True)
    MANIFEST_ENTRIES.append({
        "file": os.path.basename(path),
        "path": "promo/assets/brand/" + os.path.basename(path),
        "scene": ["SH-10"],
        "purpose": "收尾全屏卡：字标 + slogan + 仓库地址 + 本地优先/开源",
        "size": [W, H],
        "mode": "RGB",
        "has_alpha": False,
        "text": ["NotesToGO", "每个行动项，落到正确的 KR 上", "github.com/frankfika/notestodo", "本地优先 · 开源"],
        "note": "含纸底与横格线；底部信息行距下边缘 >= 120px",
        "regions": {"safe_content": SAFE_BOXES["end-card-1920x1080.png"]},
    })
    return img


# --------------------------------------------------------------------------- #
# 7. 素材：cover-16x9.png（海报式封面 / 文章头图）
# --------------------------------------------------------------------------- #

COVER_WELL = (912, 244, 880, 495)   # 16:9 精确（880/495 = 16/9），右侧产品截图位


def build_cover(path):
    img = paper_bg_with_rules(alpha=0.45)
    d = ImageDraw.Draw(img)

    f_mark = font(104, "ExtraBold")
    f_claim = font(58, "SemiBold")
    f_sub = font(34, "Regular")
    f_meta = font(28, "Regular")

    LX = 128  # 左栏起始 x（>= 安全框 96）

    # 顶部橘点
    lay = Layer()
    dot_d = 24
    lay.d.ellipse([LX * SS, (248 - dot_d / 2) * SS, (LX + dot_d) * SS - 1, (248 + dot_d / 2) * SS - 1],
                  fill=ORANGE + (255,))
    comp(img, lay.flatten())
    register_safe("cover-16x9.png", LX, 248 - dot_d / 2, LX + dot_d, 248 + dot_d / 2)

    # 字标
    mark = "NotesToGO"
    bb = ink_bbox(mark, f_mark)
    mark_cy = 330
    y_la = mark_cy - (bb[1] + bb[3]) / 2.0
    mw = text_width(mark, f_mark, tracking=-2)
    draw_run(d, LX, y_la, mark, f_mark, INK, tracking=-2)
    register_safe("cover-16x9.png", LX, y_la + bb[1], LX + mw, y_la + bb[3])

    # 主张两行
    b = draw_line_left(d, LX, 474, [("开会时只记关键词，", f_claim, INK)], tracking=1)
    register_safe("cover-16x9.png", *b)
    b = draw_line_left(d, LX, 556, [("散会后一键成稿", f_claim, INK)], tracking=1)
    register_safe("cover-16x9.png", *b)
    l2_w = b[2] - b[0]

    # 橘色短线（强调）
    lay = Layer()
    lay.rect((LX, 606, l2_w, 5), ORANGE + (255,), radius=2)
    comp(img, lay.flatten())
    register_safe("cover-16x9.png", LX, 606, LX + l2_w, 611)

    b = draw_line_left(d, LX, 676, [("每个行动项，落到正确的 KR 上", f_sub, MUTED)], tracking=1)
    register_safe("cover-16x9.png", *b)

    # 右侧截图位（抬起白面板 + 细描边 + 投影）
    wx, wy, ww, wh = COVER_WELL
    drop_shadow(img, COVER_WELL, RADIUS_L, blur=26, alpha=0.10, dy=10)
    lay = Layer()
    lay.rect(COVER_WELL, RAISE + (255,), radius=RADIUS_L)
    lay.outline(COVER_WELL, LINE + (255,), 1.5, radius=RADIUS_L)
    comp(img, lay.flatten())
    register_safe("cover-16x9.png", wx, wy, wx + ww, wy + wh)

    # 底部信息行（左对齐）
    sep = [("github.com/frankfika/notestodo", f_meta, MUTED),
           ("·", f_meta, ORANGE),
           ("本地优先 · 开源 · PWA 可安装", f_meta, MUTED)]
    b = draw_line_left(d, LX, 960, sep, tracking=0.5, spacing=18)
    register_safe("cover-16x9.png", *b)

    img.save(path, optimize=True)
    MANIFEST_ENTRIES.append({
        "file": os.path.basename(path),
        "path": "promo/assets/brand/" + os.path.basename(path),
        "scene": ["封面", "文章头图", "notestogo-promo-16x9.mp4 封面"],
        "purpose": "海报式封面：左栏字标 + 一句话主张 + 橘点/橘线，右侧预留产品截图位",
        "size": [W, H],
        "mode": "RGB",
        "has_alpha": False,
        "text": ["NotesToGO", "开会时只记关键词，", "散会后一键成稿",
                 "每个行动项，落到正确的 KR 上", "github.com/frankfika/notestodo", "本地优先 · 开源 · PWA 可安装"],
        "screenshot_well": {"x": wx, "y": wy, "w": ww, "h": wh, "radius": RADIUS_L,
                            "aspect": "16:9（880:495）",
                            "hint": "如需装入真实截图：ffmpeg -i capture/stills/today.png 先 scale=880:495 再 overlay=x=912:y=244；"
                                    "不装也可直接当封面用（右侧为留白面板）"},
        "regions": {"safe_content": SAFE_BOXES["cover-16x9.png"]},
    })
    return img


# --------------------------------------------------------------------------- #
# 8. 素材：lower-third-live.png（SH-03，透明 RGBA）
# --------------------------------------------------------------------------- #

def build_lower_third(path):
    txt = "速记优先 · 实时字幕 · 电平可见"
    f = font(36, "Medium")
    f_sep = font(36, "Medium")

    pad_x = 30
    pad_y = 22
    bar_w, bar_h = 5, 40
    bar_gap = 20

    parts = txt.split("·")
    runs = []
    for i, p in enumerate(parts):
        if i:
            runs.append(("·", f_sep, ORANGE))
        runs.append((p, f, INK))

    tw = text_width(runs[0][0], runs[0][1], 1)
    total = 0.0
    for i, (t, fo, _) in enumerate(runs):
        total += text_width(t, fo, 1)

    card_h = 84
    card_w = int(pad_x + bar_w + bar_gap + total + pad_x)
    card_w = snap(card_w) + 4
    # 卡片整体（含柔和投影）都落在 96px 安全框内：投影 σ=14 → 可见外扩约 12px + 4px 偏移
    card_x = SAFE + 20
    card_y = H - SAFE - 20 - card_h

    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    drop_shadow(base, (card_x, card_y, card_w, card_h), RADIUS_M, blur=14, alpha=0.16, dy=4)

    lay = Layer()
    lay.rect((card_x, card_y, card_w, card_h), RAISE + (255,), radius=RADIUS_M)
    lay.outline((card_x, card_y, card_w, card_h), LINE + (255,), 1.5, radius=RADIUS_M)
    # 左侧橘色竖条
    bar_y = card_y + (card_h - bar_h) / 2.0
    lay.rect((card_x + pad_x, bar_y, bar_w, bar_h), ORANGE + (255,), radius=2.5)
    comp(base, lay.flatten())

    d = ImageDraw.Draw(base)
    x = card_x + pad_x + bar_w + bar_gap
    cy = card_y + card_h / 2.0
    bb = ink_bbox("".join(t for t, _, _ in runs), f)
    y_la = cy - (bb[1] + bb[3]) / 2.0
    for t, fo, fill in runs:
        draw_run(d, x, y_la, t, fo, fill, tracking=1)
        x += text_width(t, fo, 1)

    register_safe(os.path.basename(path), card_x, card_y, card_x + card_w, card_y + card_h)
    base.save(path, optimize=True)
    MANIFEST_ENTRIES.append({
        "file": os.path.basename(path),
        "path": "promo/assets/brand/" + os.path.basename(path),
        "scene": ["SH-03"],
        "purpose": "会中功能要点条（lower-third）：白卡片 + 左侧橘色竖条 + 要点文案",
        "size": [W, H],
        "mode": "RGBA",
        "has_alpha": True,
        "text": [txt],
        "overlay": "整幅 1920x1080 直接叠在最上层（x=0,y=0）；内容已固定在左下安全区",
        "card_rect": {"x": card_x, "y": card_y, "w": card_w, "h": card_h, "radius": RADIUS_M},
        "note": "分隔符「·」用品牌橘强调；卡片不透明白 #FEFCF9，四周为全透明像素",
        "regions": {"card": [card_x, card_y, card_x + card_w, card_y + card_h]},
    })
    return base


# --------------------------------------------------------------------------- #
# 9. 素材：hook-lines/hook-1.png、hook-2.png（SH-01，透明大字）
# --------------------------------------------------------------------------- #

def build_hook_lines(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    size = 116
    f = font(size, "SemiBold")
    results = []

    specs = [
        ("hook-1.png", [(("开会时，你到底是在参与讨论，"), INK)], "开会时，你到底是在参与讨论，",
         "SH-01 第 1 句大字（0:00–0:04 淡入）"),
        ("hook-2.png", [("还是在", INK), ("抄笔记", ORANGE), ("？", INK)], "还是在抄笔记？",
         "SH-01 第 2 句大字（0:04–0:08 淡入）；「抄笔记」用品牌橘强调"),
    ]

    for fname, runs_spec, plain, purpose in specs:
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        runs = [(t, f, c) for t, c in runs_spec]
        tracking = 3
        b = draw_line_centered(d, W // 2, H // 2, runs, tracking=tracking)

        # 半透明像素安全框自检（透明图可直接扫 alpha）
        register_safe(fname, *b)
        img.save(os.path.join(out_dir, fname), optimize=True)
        results.append((fname, plain, b))

        MANIFEST_ENTRIES.append({
            "file": "hook-lines/" + fname,
            "path": "promo/assets/brand/hook-lines/" + fname,
            "scene": ["SH-01"],
            "purpose": purpose,
            "size": [W, H],
            "mode": "RGBA",
            "has_alpha": True,
            "text": [plain],
            "overlay": "整幅 1920x1080 直接叠在 bg-paper 上（x=0,y=0），整句居中于画面中心 (960,540)，"
                       "可用 ffmpeg fade / overlay 做逐句淡入淡出",
            "note": "透明底仅含文字墨迹；字号 116px（缩到 1/2 仍可读）；字距 3px；"
                    "整句按「真实墨迹」光学居中（行尾全角标点的字身留白不计入），"
                    "实测左右留白 167/167 与 580/579，视觉完全对称；墨迹范围已校验在 96px 安全框内",
            "regions": {"ink_bbox": [b[0], b[1], b[2], b[3]]},
        })
    return results


# --------------------------------------------------------------------------- #
# 10. 素材：phone-frame.png / tablet-frame.png（SH-09）
# --------------------------------------------------------------------------- #

def build_device_frame(path, inner, bezel, r_outer, r_inner, label, scene_note, screen_src, extra=None):
    ix, iy, iw, ih = inner
    outer = (ix - bezel, iy - bezel, iw + 2 * bezel, ih + 2 * bezel)

    s = 4
    # 机身 mask 与内屏镂空 mask（超采样后降采样 → 边缘抗锯齿）
    m_out = Image.new("L", (W * s, H * s), 0)
    ImageDraw.Draw(m_out).rounded_rectangle(
        [outer[0] * s, outer[1] * s, (outer[0] + outer[2]) * s - 1, (outer[1] + outer[3]) * s - 1],
        radius=r_outer * s, fill=255)
    m_in = Image.new("L", (W * s, H * s), 0)
    ImageDraw.Draw(m_in).rounded_rectangle(
        [ix * s, iy * s, (ix + iw) * s - 1, (iy + ih) * s - 1], radius=r_inner * s, fill=255)
    m_out = m_out.resize((W, H), Image.LANCZOS)
    m_in = m_in.resize((W, H), Image.LANCZOS)
    body_a = ImageChops.subtract(m_out, m_in)

    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # 投影
    drop_shadow(base, outer, r_outer, blur=9, alpha=0.28, dy=4)

    body = gradient_rgb(DARK_TOP, DARK_BOT).convert("RGBA")
    body.putalpha(body_a)
    base.alpha_composite(body)

    # 外缘细高光 + 内屏周围高光（限制在机身 alpha 内）
    hl = Layer()
    hl.outline(outer, (255, 255, 255, 30), 2, radius=r_outer, inset=1)
    hl.outline((ix, iy, iw, ih), (255, 255, 255, 22), 3, radius=r_inner, inset=-2)
    hl_img = hl.flatten()
    hl_img.putalpha(ImageChops.multiply(hl_img.getchannel("A"), body_a))
    base.alpha_composite(hl_img)

    base.save(path, optimize=True)

    entry = {
        "file": os.path.basename(path),
        "path": "promo/assets/brand/" + os.path.basename(path),
        "scene": ["SH-09"],
        "purpose": f"{label}透明机身框，内屏镂空，用于把真实截图装进设备",
        "size": [W, H],
        "mode": "RGBA",
        "has_alpha": True,
        "screen_rect": {"x": ix, "y": iy, "w": iw, "h": ih, "radius": r_inner,
                        "aspect": f"{iw}:{ih}"},
        "device_bbox": {"x": outer[0], "y": outer[1], "w": outer[2], "h": outer[3], "radius": r_outer},
        "bezel_px": bezel,
        "screenshot_source": screen_src,
        "screen_rect_note": ("内屏矩形内 alpha 均为 0（仅边界 1~2px 保留抗锯齿过渡，实测最大 alpha=1），"
                             "可直接作为 ffmpeg overlay 的目标区域：先把截图 scale 到 w:h，"
                             "再叠本帧 PNG，机身圆角会自动盖住截图四角。"),
        "ffmpeg_hint": (f"# 截图先缩放并贴到 {ix},{iy}，再把本帧整幅叠在最上层\n"
                        f"-i 截图 -i {os.path.basename(path)} -filter_complex "
                        f"[0:v]scale={iw}:{ih}[s];[1:v]format=rgba[f];"
                        f"color=c=0xFBF8F2:s=1920x1080[bg];[bg][s]overlay={ix}:{iy}[t];[t][f]overlay=0:0"),
        "screenshot_pixels": {"w": iw, "h": ih,
                              "from": "capture/stills/*.png（3840x2160 或 1170x2532）按此尺寸等比缩放"},
        "note": scene_note,
        "regions": {"screen_transparent": [ix, iy, ix + iw, iy + ih],
                    "device": [outer[0], outer[1], outer[0] + outer[2], outer[1] + outer[3]]},
    }
    if extra:
        entry.update(extra)
    MANIFEST_ENTRIES.append(entry)
    register_safe(os.path.basename(path), outer[0], outer[1], outer[0] + outer[2], outer[1] + outer[3])
    return base


def build_frames():
    phone = build_device_frame(
        os.path.join(OUT_DIR, "phone-frame.png"),
        inner=(770, 128, 380, 824), bezel=16, r_outer=54, r_inner=38,
        label="iPhone 竖版",
        scene_note="画面正中；内屏 380x824（比例 0.46117，与 390:844 = 0.46209 相差 0.2%，肉眼不可辨）。"
                   "叠加顺序：先贴截图，再叠本帧 PNG（内屏区域为全透明，可透视截图）。"
                   "机身连同柔和投影全部落在 96px 安全框内。若需与 iPad 并排，见 manifest.frames_side_by_side。",
        screen_src="capture/stills/mobile-today.png（viewport 390x844 @dsf3 = 1170x2532，按 380:824 等比缩放）",
        extra={"device_name": "phone",
               "safe_margin_px": {"left": 754, "right": 1920 - 1166, "top": 112, "bottom": 1080 - 968}},
    )
    tablet = build_device_frame(
        os.path.join(OUT_DIR, "tablet-frame.png"),
        inner=(654, 132, 612, 816), bezel=18, r_outer=46, r_inner=28,
        label="iPad",
        scene_note="画面正中；内屏 612x816（= 768:1024 精确 3:4）。"
                   "叠加顺序同上。机身连同柔和投影全部落在 96px 安全框内。若需并排，见 manifest.frames_side_by_side。",
        screen_src="capture/stills/ipad-board.png（建议按 612:816 等比裁切/缩放）",
        extra={"device_name": "tablet",
               "safe_margin_px": {"left": 636, "right": 1920 - 1284, "top": 114, "bottom": 1080 - 966}},
    )
    return phone, tablet


# --------------------------------------------------------------------------- #
# 11. 预览拼图（复核用，非交付物）
# --------------------------------------------------------------------------- #

def build_contact_sheet(paths, path):
    thumbs = []
    for p in paths:
        im = Image.open(p).convert("RGBA")
        bg = Image.new("RGB", im.size, PAPER)
        bg.paste(im, (0, 0), im)
        thumbs.append(bg.resize((640, 360), Image.LANCZOS))
    cols, rows = 2, (len(thumbs) + 1) // 2
    sheet = Image.new("RGB", (cols * 660 + 20, rows * 400 + 20), (240, 237, 232))
    for i, t in enumerate(thumbs):
        sheet.paste(t, (20 + (i % cols) * 660, 20 + (i // cols) * 400))
    sheet.save(path, optimize=True)


# --------------------------------------------------------------------------- #
# 12. 主流程
# --------------------------------------------------------------------------- #

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(REVIEW_DIR, exist_ok=True)
    resolve_font()

    print(f"字体: {_FONT_LABEL}  {_FONT_PATH}  (variable={_FONT_VARIABLE})")

    build_bg_paper(os.path.join(OUT_DIR, "bg-paper-1920x1080.png"))
    build_title_card(os.path.join(OUT_DIR, "title-card-1920x1080.png"))
    build_end_card(os.path.join(OUT_DIR, "end-card-1920x1080.png"))
    build_cover(os.path.join(OUT_DIR, "cover-16x9.png"))
    build_lower_third(os.path.join(OUT_DIR, "lower-third-live.png"))
    build_hook_lines(os.path.join(OUT_DIR, "hook-lines"))
    build_frames()

    # ---- 安全框自检 ----
    violations = []
    for name, (x0, y0, x1, y1) in SAFE_BOXES.items():
        if x0 < SAFE or y0 < SAFE or x1 > W - SAFE or y1 > H - SAFE:
            violations.append({"file": name, "bbox": [x0, y0, x1, y1]})
    print("安全框自检:", "全部通过" if not violations else f"越界 {violations}")

    files = ["bg-paper-1920x1080.png", "title-card-1920x1080.png", "end-card-1920x1080.png",
             "cover-16x9.png", "lower-third-live.png", "hook-lines/hook-1.png",
             "hook-lines/hook-2.png", "phone-frame.png", "tablet-frame.png"]

    manifest = {
        "project": "NotesToGO · 拾贝 产品宣传片",
        "owner": "brand",
        "task": "task-2",
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "generator": "promo/scripts/brand/make_brand_assets.py",
        "contract": "promo/STORYBOARD.md §2 设计真值 / §3 SH-01·02·09·10 / §4.2 素材契约",
        "canvas": {"w": W, "h": H, "fps_target": 30, "safe_frame_px": SAFE, "grid_px": GRID},
        "design_tokens": {
            "bg_paper": "#FBF8F2", "bg_raise": "#FEFCF9", "line": "#E3DFD8",
            "text_1_ink": "#3A3128", "text_3_muted": "#7A7168",
            "accent_orange": "#C0571E", "dark": "#26221E",
            "radii": {"s": RADIUS_S, "m": RADIUS_M, "l": RADIUS_L},
        },
        "fonts": {
            "resolved_path": _FONT_PATH,
            "family": _FONT_LABEL,
            "variable": _FONT_VARIABLE,
            "weights_used": ["Regular", "Medium", "SemiBold", "ExtraBold"],
            "note": ("STORYBOARD 指定的 /System/Library/Fonts/NotoSansSC-Variable.ttf 在本机不存在；"
                     "实际使用 ~/Library/Fonts/NotoSansSC-Variable.ttf（Noto Sans SC 可变字体，"
                     "weight 轴 100–900，按命名实例取字重）。PingFang 未在 /System/Library/Fonts/ 下找到独立字体文件，未使用。"
                     if "Library/Fonts" in _FONT_PATH else "使用 " + _FONT_PATH),
            "no_emoji": True,
        },
        "files": files,
        "assets": MANIFEST_ENTRIES,
        "safe_frame_check": {"violations": violations, "boxes": SAFE_BOXES},
        "frames_side_by_side": {
            "recommended": ("整幅平移（保留柔和投影）：两张帧图都是 1920x1080 全画布，直接给 overlay 一个负/正 x 偏移即可，"
                            "投影会随设备一起移动。目标布局：两设备水平居中并排、间距 180px、左右留白各 340px、垂直位置不动。"),
            "phone": {"png_overlay_at": [-414, 0],
                      "device_then": [340, 112, 412, 856],
                      "screen_rect_then": [356, 128, 380, 824],
                      "ffmpeg": "[bg][1:v]overlay=-414:0[b1]"},
            "tablet": {"png_overlay_at": [296, 0],
                       "device_then": [932, 114, 648, 852],
                       "screen_rect_then": [950, 132, 612, 816],
                       "ffmpeg": "[b1][2:v]overlay=296:0[b2]"},
            "alternative_crop": {
                "note": "先按 device_bbox 裁片再摆放（同样可用：裁片坐标 + 目标位置 = 内屏坐标）。"
                        "注意：裁剪会连同设备外的柔和投影一起裁掉，画面会显得设备「贴」在纸面上。",
                "phone": {"crop_from": [754, 112, 412, 856], "place_at": [340, 112],
                          "screen_rect_then": [356, 128, 380, 824]},
                "tablet": {"crop_from": [636, 114, 648, 852], "place_at": [932, 114],
                           "screen_rect_then": [950, 132, 612, 816]},
            },
            "screenshot_first": "顺序：先叠截图（到 screen_rect_then），再叠机身帧 PNG，机身圆角自动盖住截图四角。",
        },
        "review_aid": "_review/ 目录：contact-sheet.png（九宫格总览）、frame-overlay-test.png（内屏接口端到端验证）、"
                      "hook-pair.png、lower-third-on-bg.png、crop-*.png（逐字核对裁切）—— 全部仅复核用，不参与成片",
        "handoff": {
            "cover_for_build": "cover-16x9.png 需由 build 复制到 promo/build/out/cover-16x9.png（STORYBOARD §1 交付路径）",
            "overlay_rule": "所有透明素材都是 1920x1080 全画布，叠放时统一 x=0,y=0，无需计算偏移",
            "subtitle_note": "SH-03 要点条 lower-third-live.png 与屏幕下方烧入字幕 CAP 位置不同（卡片在 y=880~964），"
                             "同屏出现时字幕请压在更下方或错开时间",
            "smoke_test": "promo/scripts/brand/ffmpeg-frame-smoke.sh —— 用真实 ffmpeg 把测试截图叠进机身框并逐像素校验"
                          "（内屏内容 / 圆角遮挡 / 投影 / 安全框），build 可直接照抄其中的 filter_complex 写法",
            "regenerate": "promo/scripts/brand/make_brand_assets.py（确定性，固定随机种子）→ "
                          "promo/scripts/brand/verify_brand_assets.py（全部断言）→ "
                          "promo/scripts/brand/review_previews.py（复核图）",
        },
    }

    mpath = os.path.join(OUT_DIR, "MANIFEST.json")
    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    build_contact_sheet([os.path.join(OUT_DIR, f) for f in files],
                        os.path.join(REVIEW_DIR, "contact-sheet.png"))
    print("MANIFEST:", mpath)
    for f in files:
        p = os.path.join(OUT_DIR, f)
        print(f"  {f:34s} {os.path.getsize(p)/1024:9.1f} KB")


if __name__ == "__main__":
    main()
