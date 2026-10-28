#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QA 专用：把指定 layout 的时间轴重新生成到 **promo/qa/_probe/**，不碰 Lead 的
`promo/build/timeline.json`。

为什么需要它
------------
`promo/build/timeline.json` 是**单一文件、按 layout 覆盖写**的：跑完 16x9 再跑 9x16，
文件里就只剩 9x16 的内容（实测：9x16 / 6 个分镜 / total_s=61.452）。
而 `promo/build/tools/verify_captions.py` 依赖 `--timeline`（默认就是那个文件）与
`--layout`（默认 16x9）**成对匹配**。若直接拿它去比对 16x9 的 preview 帧，就会
用 9x16 的几何 + 6 条字幕去比 1920×1080 的 10 张帧 → 必然大面积假 FAIL，
而且只覆盖 6/10 个分镜。

本脚本用只读方式 import Lead 的 `render.py`，调用其纯函数 `build_timeline()`
（不写任何 Lead 的文件），输出到 `promo/qa/_probe/timeline-<layout>.json`，
再交给 verify_captions.py 使用。

用法
----
  $PY promo/qa/probe_timeline.py --layout 16x9 --target 90
  $PY promo/qa/probe_timeline.py --layout 9x16 --target 60
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

QA = Path(__file__).resolve().parent
BUILD = QA.parent / "build"
PROBE = QA / "_probe"

sys.path.insert(0, str(BUILD))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", default="16x9", choices=["16x9", "9x16"])
    ap.add_argument("--target", type=float, default=None,
                    help="目标总时长；默认取 render.py 里该 layout 的默认 target")
    ap.add_argument("--out", default=None)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    import render  # noqa: E402  ← Lead 的模块，只读 import

    layout = render.LAYOUTS[args.layout]
    target = args.target
    if target is None:
        # render.py:568 起 main() 里对每个 layout 用不同 target；这里给出契约值
        target = 90.0 if args.layout == "16x9" else 60.0

    vo_meta = render.load_vo_meta()
    vo_dur = {k: v["dur"] for k, v in vo_meta.items()}
    use = ([s for s in render.SHOTS if s.id in render.VERTICAL_IDS]
           if args.layout == "9x16" else render.SHOTS)

    tl = render.build_timeline(target, vo_dur, layout, vo_meta, use)

    out = Path(args.out) if args.out else PROBE / f"timeline-{args.layout}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(tl, ensure_ascii=False, indent=2), encoding="utf-8")

    if not args.quiet:
        print(f"layout={tl['layout']} size={tl['size']} target_s={tl['target_s']} "
              f"total_s={tl['total_s']} shots={len(tl['shots'])}")
        print(f"写出: {out.relative_to(QA.parent.parent)}")
        print()
        print(f"{'id':7s} {'start':>8s} {'dur':>7s} {'cap_in':>8s} {'cap_out':>8s}  cap")
        for s in tl["shots"]:
            print(f"{s['id']:7s} {s['start']:8.3f} {s['dur']:7.3f} "
                  f"{s['cap_in']:8.3f} {s['cap_out']:8.3f}  {s['cap']}")
        # 字幕领先真实人声的标称值：cap_in - (start + vo_lead + speech_start)
        lead = tl["vo_lead"]
        deltas = []
        for s in tl["shots"]:
            ss = vo_meta.get(s["vo"], {}).get("speech_start", 0.15)
            deltas.append(round(s["cap_in"] - (s["start"] + lead + ss), 4))
        print()
        print(f"标称「字幕领先人声」= {sorted(set(deltas))} s "
              f"（sync 实测应约等于此值，负值=字幕早于人声）")
        print(f"总时长校验: sum(dur) - sum(xfade) = "
              f"{sum(s['dur'] for s in tl['shots']) - sum(s['xfade_next'] for s in tl['shots']):.3f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
