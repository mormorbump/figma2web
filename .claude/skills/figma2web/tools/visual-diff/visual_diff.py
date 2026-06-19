#!/usr/bin/env python3
"""Region-based visual diff for gate A (design §3.5).

Compares the rendered screenshot (actual) against the Figma reference PNG.
Key design decisions (ADR-0001):
  - We do NOT chase a single global pixel score. We segment the difference into
    regions and report them, so the skill can crop ref/actual per region and
    feed only the localized diff back to the LLM (Design2Code finding).
  - Text regions are de-weighted: font renderers differ between Figma and
    Chromium, so per-glyph antialiasing diffs are expected noise, not signal.
    Pass --text-boxes (frame-coord boxes of TEXT nodes) to mask them; their
    layout is verified structurally elsewhere, not by pixels.
  - Color difference uses CIEDE2000-ish distance in LAB space.

Usage:
  python3 visual_diff.py --ref ref.png --actual actual.png --out-dir diff_out \
      [--scale 2] [--text-boxes text_boxes.json] [--delta-e 6] [--min-region 12] [--top-k 8]

Exit code: 0 if no significant non-text regions remain, 1 otherwise, 2 on error.
"""
import argparse
import json
import os
import sys
import numpy as np
import cv2


def load_resized(ref_path, actual_path):
    ref = cv2.imread(ref_path, cv2.IMREAD_COLOR)
    act = cv2.imread(actual_path, cv2.IMREAD_COLOR)
    if ref is None:
        raise FileNotFoundError(ref_path)
    if act is None:
        raise FileNotFoundError(actual_path)
    h, w = ref.shape[:2]
    ah, aw = act.shape[:2]
    if (ah, aw) != (h, w):
        ar_ref, ar_act = w / h, aw / ah
        if abs(ar_ref - ar_act) > 0.02 * ar_ref:
            print(
                f"WARN: aspect-ratio mismatch ref {w}x{h} vs actual {aw}x{ah}. "
                "The diff is likely meaningless — match viewport width and devicePixelRatio to the Figma export.",
                file=sys.stderr,
            )
        act = cv2.resize(act, (w, h), interpolation=cv2.INTER_AREA)
    return ref, act


def delta_e_map(ref_bgr, act_bgr):
    # OpenCV 8-bit LAB: L in [0,255], a/b in [0,255] with a +128 offset. Put all
    # three channels on a consistent perceptual scale so the Euclidean distance
    # approximates deltaE76: L -> [0,100], a/b -> ~[-128,127].
    def to_lab(bgr):
        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
        lab[..., 0] *= 100.0 / 255.0
        lab[..., 1:] -= 128.0
        return lab

    diff = to_lab(ref_bgr) - to_lab(act_bgr)
    return np.sqrt(np.sum(diff * diff, axis=2))  # ~deltaE76


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--actual", required=True)
    ap.add_argument("--out-dir", default="diff_out")
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--text-boxes", default=None, help="JSON list of {x,y,w,h} in FRAME coords for TEXT nodes")
    ap.add_argument("--decoration-boxes", default=None, help="JSON list of {x,y,w,h} (FRAME coords) for decorative/background z-layers to EXEMPT from the score (from layout-reconstruct's decoration_boxes.json)")
    ap.add_argument("--delta-e", type=float, default=6.0, help="per-pixel LAB distance threshold")
    ap.add_argument("--min-region", type=int, default=12, help="min region side in px to report")
    ap.add_argument("--top-k", type=int, default=8)
    ap.add_argument("--fidelity-floor", type=float, default=0.985, help="min non-text fidelity to pass gate A")
    args = ap.parse_args()

    try:
        ref, act = load_resized(args.ref, args.actual)
    except Exception as e:
        print(f"visual_diff error: {e}", file=sys.stderr)
        sys.exit(2)

    os.makedirs(args.out_dir, exist_ok=True)
    H, W = ref.shape[:2]
    de = delta_e_map(ref, act)
    mask = (de > args.delta_e).astype(np.uint8)

    def boxes_mask(path, pad):
        m = np.zeros((H, W), np.uint8)
        if path and os.path.exists(path):
            with open(path) as f:
                for b in json.load(f):
                    x0 = max(0, int(b["x"] * args.scale) - pad)
                    y0 = max(0, int(b["y"] * args.scale) - pad)
                    x1 = min(W, int((b["x"] + b["w"]) * args.scale) + pad)
                    y1 = min(H, int((b["y"] + b["h"]) * args.scale) + pad)
                    m[y0:y1, x0:x1] = 1
        return m

    # Mask out text (font AA noise) and decoration/background z-layers (exempt:
    # a CSS approximation of an image-based backdrop can't pixel-match — this was
    # the dominant false-diff in real-data runs). decoration_boxes comes from
    # layout-reconstruct so the score reflects real CONTENT fidelity.
    text_mask = boxes_mask(args.text_boxes, 2)
    decoration_mask = boxes_mask(args.decoration_boxes, 0)
    exempt_mask = (text_mask | decoration_mask).astype(np.uint8)
    nontext_mask = mask & (1 - exempt_mask)

    # Clean up speckle, then connected components on the non-exempt mask.
    kernel = np.ones((3, 3), np.uint8)
    cleaned = cv2.morphologyEx(nontext_mask, cv2.MORPH_OPEN, kernel)
    cleaned = cv2.dilate(cleaned, kernel, iterations=2)
    num, labels, statsm, _ = cv2.connectedComponentsWithStats(cleaned, connectivity=8)

    regions = []
    for i in range(1, num):
        x, y, w, h, area_px = statsm[i]
        if w < args.min_region and h < args.min_region:
            continue
        regions.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h), "areaPx": int(area_px)})
    regions.sort(key=lambda r: r["areaPx"], reverse=True)

    # Scores. contentFidelity = fidelity over the region that is NEITHER text NOR
    # decoration — the meaningful "did I reproduce the real content" number.
    content_total = int((1 - exempt_mask).sum())
    content_mismatch = int(nontext_mask.sum())
    text_total = int(text_mask.sum())
    text_mismatch = int((mask & text_mask).sum())
    decoration_total = int(decoration_mask.sum())
    nontext_fidelity = 1.0 - (content_mismatch / content_total) if content_total else 1.0
    content_fidelity = nontext_fidelity  # alias: both exclude text+decoration now

    # Write artifacts: diff heatmap + per-region crops.
    heat = cv2.applyColorMap(np.clip(de * 4, 0, 255).astype(np.uint8), cv2.COLORMAP_JET)
    cv2.imwrite(os.path.join(args.out_dir, "diff.png"), heat)
    crops_dir = os.path.join(args.out_dir, "crops")
    os.makedirs(crops_dir, exist_ok=True)
    for idx, r in enumerate(regions[: args.top_k]):
        pad = 8
        x0, y0 = max(0, r["x"] - pad), max(0, r["y"] - pad)
        x1, y1 = min(W, r["x"] + r["w"] + pad), min(H, r["y"] + r["h"] + pad)
        cv2.imwrite(os.path.join(crops_dir, f"region{idx}_ref.png"), ref[y0:y1, x0:x1])
        cv2.imwrite(os.path.join(crops_dir, f"region{idx}_actual.png"), act[y0:y1, x0:x1])
        r["crops"] = {"ref": f"crops/region{idx}_ref.png", "actual": f"crops/region{idx}_actual.png"}
        # frame-coord box for feeding back coordinates
        r["frameBox"] = {"x": round(r["x"] / args.scale, 1), "y": round(r["y"] / args.scale, 1), "w": round(r["w"] / args.scale, 1), "h": round(r["h"] / args.scale, 1)}

    # Gate A passes only when no significant region remains AND aggregate
    # non-text fidelity clears the floor (guards against death-by-a-thousand-cuts
    # sub-threshold diffs that never aggregate into a region).
    ok = len(regions) == 0 and nontext_fidelity >= args.fidelity_floor
    report = {
        "imageSize": {"w": W, "h": H},
        "scale": args.scale,
        "nonTextFidelity": round(nontext_fidelity, 4),
        "contentFidelity": round(content_fidelity, 4),
        "fidelityFloor": args.fidelity_floor,
        "contentMismatchPx": content_mismatch,
        "textMismatchPx": text_mismatch,
        "textTotalPx": text_total,
        "decorationExemptPx": decoration_total,
        "regionCount": len(regions),
        "regions": regions[: args.top_k],
        "deltaEThreshold": args.delta_e,
        "verdict": "pass" if ok else "diffs-remain",
        "note": "Text regions are de-weighted (font renderer noise). Verify text layout structurally, not by pixels.",
    }
    with open(os.path.join(args.out_dir, "report.json"), "w") as f:
        json.dump(report, f, indent=2)

    print(json.dumps({k: report[k] for k in ["nonTextFidelity", "regionCount", "verdict", "textMismatchPx"]}, indent=2))
    print(f"Artifacts in {args.out_dir}/ (diff.png, crops/, report.json)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
