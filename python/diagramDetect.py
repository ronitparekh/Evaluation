import os
import sys

import cv2
import numpy as np


def clip_box(x, y, w, h, width, height):
    x = max(0, min(int(x), width - 1))
    y = max(0, min(int(y), height - 1))
    w = max(1, min(int(w), width - x))
    h = max(1, min(int(h), height - y))
    return x, y, w, h


def boxes_overlap(a, b, gap_x=0, gap_y=0):
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ax1, ay1 = ax0 + aw, ay0 + ah
    bx1, by1 = bx0 + bw, by0 + bh

    ax0 -= gap_x
    ay0 -= gap_y
    ax1 += gap_x
    ay1 += gap_y
    bx0 -= gap_x
    by0 -= gap_y
    bx1 += gap_x
    by1 += gap_y

    return ax0 <= bx1 and bx0 <= ax1 and ay0 <= by1 and by0 <= ay1


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    ix1 = max(ax, bx)
    iy1 = max(ay, by)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0

    union = aw * ah + bw * bh - inter
    return inter / float(max(1, union))


def containment(a, b):
    # overlap / min(area(a), area(b))
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    ix1 = max(ax, bx)
    iy1 = max(ay, by)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    return inter / float(max(1, min(aw * ah, bw * bh)))


def find_boxes(mask, min_area_px):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w * h >= min_area_px:
            boxes.append((x, y, w, h))
    return boxes


def preprocess(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    ink = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35,
        11,
    )
    ink = cv2.medianBlur(ink, 3)
    edges = cv2.Canny(gray, 50, 150)
    return ink, edges


def propose_from_edges(edges, width, height):
    min_area = 0.0025 * width * height
    proposals = []
    params = [((7, 7), 2), ((11, 11), 1), ((15, 9), 1)]
    for kernel_size, iters in params:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, kernel_size)
        mask = cv2.dilate(edges, kernel, iterations=iters)
        for box in find_boxes(mask, min_area):
            proposals.append({"box": box, "weight": 1.0, "source": "edges"})
    return proposals


def propose_from_ink_groups(ink, width, height):
    min_area = 0.004 * width * height
    proposals = []

    kernels = [
        (max(17, int(0.02 * width)), max(13, int(0.015 * height))),
        (max(27, int(0.03 * width)), max(17, int(0.02 * height))),
    ]

    for kx, ky in kernels:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kx, ky))
        mask = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, kernel)
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)), 1)
        for box in find_boxes(mask, min_area):
            proposals.append({"box": box, "weight": 1.15, "source": "ink"})

    return proposals


def _fill_short_false_runs(mask, max_len):
    out = mask.copy()
    n = len(out)
    i = 0
    while i < n:
        if out[i]:
            i += 1
            continue
        j = i
        while j < n and not out[j]:
            j += 1
        if i > 0 and j < n and (j - i) <= max_len and out[i - 1] and out[j]:
            out[i:j] = True
        i = j
    return out


def propose_from_layout_bands(ink, width, height):
    row_density = np.count_nonzero(ink, axis=1).astype(np.float32) / max(1, width)
    row_smooth = cv2.GaussianBlur(
        row_density.reshape(-1, 1), (1, 0), sigmaX=0, sigmaY=max(1, int(0.0035 * height))
    ).reshape(-1)

    valley_threshold = max(0.015, min(0.08, float(np.percentile(row_smooth, 30))))
    valley_rows = row_smooth < valley_threshold
    valley_rows = _fill_short_false_runs(valley_rows, max(2, int(0.004 * height)))

    min_gap = max(20, int(0.012 * height))
    valleys = []
    i = 0
    while i < height:
        if not valley_rows[i]:
            i += 1
            continue
        start = i
        while i < height and valley_rows[i]:
            i += 1
        end = i
        if end - start >= min_gap:
            valleys.append((start, end))

    blocks = []
    cursor = 0
    for start, end in valleys:
        if start - cursor >= min_gap:
            blocks.append((cursor, start))
        cursor = end
    if height - cursor >= min_gap:
        blocks.append((cursor, height))

    proposals = []
    min_band_h = max(70, int(0.08 * height))
    for y0, y1 in blocks:
        if y1 - y0 < min_band_h:
            continue

        band = ink[y0:y1, :]
        col_density = np.count_nonzero(band, axis=0).astype(np.float32) / max(1, y1 - y0)
        active_threshold = max(0.01, float(col_density.mean() * 0.35))
        active_cols = np.where(col_density > active_threshold)[0]
        if active_cols.size == 0:
            continue

        x0 = max(0, int(active_cols.min()) - int(0.01 * width))
        x1 = min(width, int(active_cols.max()) + int(0.01 * width))
        box = (x0, y0, max(1, x1 - x0), max(1, y1 - y0))
        proposals.append({"box": box, "weight": 1.35, "source": "layout"})

    return proposals


def merge_layout_bands(layout_candidates, width, height):
    if not layout_candidates:
        return []

    ordered = sorted(layout_candidates, key=lambda c: c["box"][1])
    merged = []
    current = ordered[0].copy()

    for item in ordered[1:]:
        x1, y1, w1, h1 = current["box"]
        x2, y2, w2, h2 = item["box"]
        bottom1 = y1 + h1
        gap = y2 - bottom1

        overlap_w = max(0, min(x1 + w1, x2 + w2) - max(x1, x2))
        min_w = float(max(1, min(w1, w2)))
        overlap_ratio = overlap_w / min_w

        if (
            y1 >= int(0.25 * height)
            and gap <= int(0.05 * height)
            and overlap_ratio >= 0.35
        ):
            nx0 = min(x1, x2)
            ny0 = min(y1, y2)
            nx1 = max(x1 + w1, x2 + w2)
            ny1 = max(y1 + h1, y2 + h2)
            current["box"] = clip_box(nx0, ny0, nx1 - nx0, ny1 - ny0, width, height)
            current["weight"] += item["weight"] * 0.85
            continue

        merged.append(current)
        current = item.copy()

    merged.append(current)
    return merged


def dedupe_candidates(candidates):
    if not candidates:
        return []

    ordered = sorted(
        candidates,
        key=lambda c: (c["weight"], c["box"][2] * c["box"][3]),
        reverse=True,
    )
    kept = []
    for item in ordered:
        box = item["box"]
        if any(iou(box, existing["box"]) >= 0.82 for existing in kept):
            continue
        kept.append(item)
    return kept


def analyze_box(box, ink, width, height):
    x, y, w, h = box
    area_ratio = (w * h) / float(width * height)

    if w < max(80, int(0.08 * width)):
        return None
    if h < max(80, int(0.07 * height)):
        return None
    if area_ratio < 0.01 or area_ratio > 0.88:
        return None
    if h < int(0.05 * height) and w > int(0.7 * width):
        return None

    roi = ink[y : y + h, x : x + w]
    ink_ratio = np.count_nonzero(roi) / float(max(1, w * h))
    if ink_ratio < 0.008 or ink_ratio > 0.46:
        return None

    _, _, stats, _ = cv2.connectedComponentsWithStats(roi, 8)
    stats = stats[1:]
    if stats.size == 0:
        return None

    areas = stats[:, cv2.CC_STAT_AREA]
    medium = int(np.sum(areas > max(25, int(0.00015 * w * h))))
    large = int(np.sum(areas > max(200, int(0.003 * w * h))))
    if medium < 3:
        return None

    row_profile = np.count_nonzero(roi, axis=1).astype(np.float32) / max(1, w)
    row_active = float(np.mean(row_profile > 0.01))
    row_std = float(row_profile.std())
    component_density = medium / max(1.0, (w * h) / 100000.0)

    if area_ratio > 0.12 and component_density > 4.7 and row_active > 0.96:
        return None

    return {
        "area_ratio": area_ratio,
        "ink_ratio": ink_ratio,
        "medium_components": medium,
        "large_components": large,
        "row_active": row_active,
        "row_std": row_std,
        "component_density": component_density,
    }


def score_candidate(weight, features, box, width, height):
    x, y, w, h = box
    score = float(weight)
    score += min(1.25, features["area_ratio"] * 4.0)
    score += 0.25 if w >= 0.25 * width else 0.0
    score += 0.20 if h >= 0.12 * height else 0.0
    score += 0.20 if 0.02 <= features["ink_ratio"] <= 0.30 else 0.0
    score += min(0.45, 0.08 * features["large_components"])
    score += 0.15 if features["row_active"] < 0.985 else 0.0
    score += 0.2 if 1.0 <= features["component_density"] <= 4.0 else 0.0
    score -= 0.35 if features["component_density"] > 6.0 else 0.0

    # Slight preference against tiny top-margin fragments.
    if y < 0.08 * height and h < 0.12 * height:
        score -= 0.4

    return score


def non_maximum_suppression(candidates, max_count=8):
    kept = []
    for cand in sorted(candidates, key=lambda item: item["score"], reverse=True):
        box = cand["box"]
        should_keep = True
        for existing in kept:
            if iou(box, existing["box"]) >= 0.55 or containment(box, existing["box"]) >= 0.85:
                should_keep = False
                break
        if should_keep:
            kept.append(cand)
        if len(kept) >= max_count:
            break
    return kept


def prune_context_fragments(candidates, width, height):
    if not candidates:
        return candidates

    large = [
        c
        for c in candidates
        if (c["box"][2] * c["box"][3]) / float(width * height) >= 0.25
    ]
    if not large:
        return candidates

    anchor = max(large, key=lambda c: c["score"])
    ax, ay, aw, ah = anchor["box"]
    anchor_top = ay

    pruned = []
    for item in candidates:
        x, y, w, h = item["box"]
        area_ratio = (w * h) / float(width * height)
        if (
            item is not anchor
            and area_ratio < 0.05
            and y < anchor_top
            and item["score"] < anchor["score"] * 0.55
        ):
            continue
        pruned.append(item)

    return pruned


def refine_false_positives(candidates, width, height):
    if not candidates:
        return candidates

    best_score = max(c["score"] for c in candidates)
    refined = []

    for item in candidates:
        x, y, w, h = item["box"]
        area_ratio = (w * h) / float(width * height)

        # Page-edge vertical strips are usually contour spillover, not diagrams.
        if (
            h >= 0.75 * height
            and w <= 0.28 * width
            and (x <= 0.05 * width or (x + w) >= 0.95 * width)
            and item["score"] < best_score * 0.70
        ):
            continue

        # Very wide, short top strips are typically heading text regions.
        if (
            y <= 0.22 * height
            and w >= 0.80 * width
            and h <= 0.18 * height
            and item["score"] < best_score * 0.60
        ):
            continue

        refined.append(item)

    # If a strong interior diagram exists, suppress oversized border-hugging page chunks.
    if not refined:
        return candidates

    edge_chunks = []
    for item in refined:
        x, y, w, h = item["box"]
        area_ratio = (w * h) / float(width * height)
        touches_border = (
            x <= 0.01 * width
            or y <= 0.01 * height
            or (x + w) >= 0.99 * width
            or (y + h) >= 0.99 * height
        )
        if area_ratio >= 0.35 and touches_border and w >= 0.82 * width:
            edge_chunks.append(item)

    if edge_chunks:
        edge_best = max(item["score"] for item in edge_chunks)
        alternatives = []
        for item in refined:
            x, y, w, h = item["box"]
            area_ratio = (w * h) / float(width * height)
            interior = x > 0.02 * width and (x + w) < 0.98 * width
            if (
                interior
                and 0.06 <= area_ratio <= 0.35
                and item["score"] >= edge_best * 0.35
            ):
                alternatives.append(item)

        if alternatives:
            refined = [item for item in refined if item not in edge_chunks]

    return refined


def extract_diagrams(image_path, output_dir):
    os.makedirs(output_dir, exist_ok=True)

    img = cv2.imread(image_path)
    if img is None:
        return []

    height, width = img.shape[:2]
    ink, edges = preprocess(img)

    edge_candidates = propose_from_edges(edges, width, height)
    ink_candidates = propose_from_ink_groups(ink, width, height)
    layout_candidates = propose_from_layout_bands(ink, width, height)
    merged_layout = merge_layout_bands(layout_candidates, width, height)

    proposals = edge_candidates + ink_candidates + layout_candidates + merged_layout
    proposals = dedupe_candidates(proposals)

    scored = []
    for item in proposals:
        box = item["box"]
        area_ratio = (box[2] * box[3]) / float(width * height)
        if area_ratio > 0.88:
            continue
        features = analyze_box(box, ink, width, height)
        if not features:
            continue
        score = score_candidate(item["weight"], features, box, width, height)
        scored.append({"box": box, "score": score})

    final_boxes = non_maximum_suppression(scored, max_count=8)
    final_boxes = refine_false_positives(final_boxes, width, height)
    final_boxes = prune_context_fragments(final_boxes, width, height)

    written = []
    for idx, entry in enumerate(sorted(final_boxes, key=lambda c: (c["box"][1], c["box"][0]))):
        x, y, w, h = entry["box"]
        pad_x = max(8, int(0.02 * w))
        pad_y = max(8, int(0.02 * h))
        x, y, w, h = clip_box(x - pad_x, y - pad_y, w + 2 * pad_x, h + 2 * pad_y, width, height)

        crop = img[y : y + h, x : x + w]
        out_path = os.path.join(output_dir, f"diagram_{idx}.png")
        cv2.imwrite(out_path, crop)
        written.append(out_path)

    return written


def main():
    if len(sys.argv) < 3:
        sys.exit(0)

    image_path = sys.argv[1]
    output_dir = sys.argv[2]
    files = extract_diagrams(image_path, output_dir)
    for file_path in files:
        print(file_path)


if __name__ == "__main__":
    main()
