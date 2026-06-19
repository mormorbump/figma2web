#!/usr/bin/env python3
"""Draw the candidate IR boxes on top of ref.png for the early structure check.

This is the gate before any code is written (design §3.3): a human / the skill
eyeballs whether the geometry reconstruction grouped things sensibly.

Usage:
  python3 overlay.py --in .context/figma/<slug> [--scale 2] [--out ir-overlay.png]
"""
import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROLE_COLORS = {
    "frame": (120, 120, 120),
    "container": (0, 140, 255),
    "text": (0, 200, 0),
    "image": (255, 140, 0),
    "icon": (200, 0, 200),
    "shape": (0, 190, 190),
    "component": (255, 0, 80),
}


def walk(node, depth, boxes):
    boxes.append((node, depth))
    for c in node.get("children", []):
        walk(c, depth + 1, boxes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="indir", required=True)
    ap.add_argument("--scale", type=float, default=None)
    ap.add_argument("--out", default="ir-overlay.png")
    ap.add_argument("--ir", default="ir-candidates.json")
    args = ap.parse_args()

    ir_path = os.path.join(args.indir, args.ir)
    ref_path = os.path.join(args.indir, "ref.png")
    with open(ir_path) as f:
        ir = json.load(f)

    scale = args.scale
    if scale is None:
        try:
            with open(os.path.join(args.indir, "index.json")) as f:
                scale = json.load(f).get("refImage", {}).get("scale", 2)
        except Exception:
            scale = 2

    if os.path.exists(ref_path):
        base = Image.open(ref_path).convert("RGBA")
    else:
        w = int(ir["frame"]["width"] * scale)
        h = int(ir["frame"]["height"] * scale)
        base = Image.new("RGBA", (w, h), (255, 255, 255, 255))

    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 11)
    except Exception:
        font = ImageFont.load_default()

    boxes = []
    walk(ir["tree"], 0, boxes)

    for node, depth in boxes:
        r = node["rect"]
        x0, y0 = r["x"] * scale, r["y"] * scale
        x1, y1 = (r["x"] + r["w"]) * scale, (r["y"] + r["h"]) * scale
        color = ROLE_COLORS.get(node.get("role", "container"), (0, 140, 255))
        flags = node.get("flags", {}) or {}
        width = 3 if flags.get("absoluteCandidate") or flags.get("figmaAbsolute") else 2
        draw.rectangle([x0, y0, x1, y1], outline=color + (255,), width=width)
        label = node.get("role", "?")[:1]
        if flags.get("component"):
            label = "C"
        if flags.get("absoluteCandidate"):
            label += "*"
        draw.text((x0 + 2, y0 + 1), label, fill=color + (255,), font=font)

    out = Image.alpha_composite(base, overlay).convert("RGB")
    out_path = os.path.join(args.indir, args.out)
    out.save(out_path)
    print(f"Wrote {out_path}  ({len(boxes)} boxes, scale {scale})")
    print("Legend: blue=container green=text orange=image purple=icon red=component  '*'=absolute-candidate")


if __name__ == "__main__":
    main()
