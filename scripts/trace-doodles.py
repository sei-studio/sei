#!/usr/bin/env python3
"""
trace-doodles.py — turn a black-line-art PNG into centreline polylines.

Why this exists (260728). The Draw! start page shows three real drawings, and
they are displayed at different sizes: the crown small, the shrimp and horse
large. A raster scaled to different sizes has different apparent line weight,
which breaks the one rule the whole surface is built on ("every line is one
pen, --hand-stroke wide"). Tracing the ink to VECTORS fixes it at the root: the
geometry scales and the stroke width does not, because the renderer draws them
as SVG paths with vector-effect: non-scaling-stroke.

It is a centreline trace, not a contour trace. Outlining the ink would give two
paths per stroke (both sides of the line) and then filling them would re-encode
the original thickness, which is exactly what we are trying to discard. So:

  threshold -> Zhang-Suen thinning to a 1px skeleton -> walk the skeleton graph
  into polylines -> Ramer-Douglas-Peucker simplify -> normalise to a viewBox.

Usage:
    python3 scripts/trace-doodles.py OUT.ts NAME=SRC.png [NAME=SRC.png ...]

e.g. python3 scripts/trace-doodles.py \
        src/renderer/src/components/draw/doodles.ts \
        shrimp=~/Screenshots/left.png \
        crown=~/Screenshots/center.png \
        horse=~/Screenshots/right.png

Needs Pillow. The OUTPUT is the committed artifact; the source PNGs are not in
the repo. Re-run this only when the drawings themselves change.
"""

import os
import sys
from PIL import Image

# Ink threshold on the 0-255 grey image. The sources are black marker on white,
# so anything in the middle is an antialiased edge and belongs to the stroke.
INK_MAX = 170
# Below this many pixels a traced path is a thinning artefact (a stub spur off a
# junction), not a line anyone drew. Kept low, because spur removal is
# prune_spurs' job: a high value here silently deletes real geometry whenever
# the walk fragments, which is how the first version lost most of the drawing.
MIN_PATH_PX = 3
# Ramer-Douglas-Peucker tolerance, in source pixels. Large enough to throw away
# the stair-stepping the skeleton inherits from the pixel grid, small enough to
# keep the wobble that makes the drawing look hand-made.
RDP_EPS = 1.1
# The traced coordinate space. Height is derived per drawing from its aspect.
VIEW_W = 1000


# Thinning is O(ink pixels) per pass in pure Python, which is far too slow on a
# 1105x852 source (minutes). The trace is normalised and simplified afterwards,
# so resolution beyond this buys nothing but time.
WORK_MAX = 420


def load_ink(path):
    """Binary ink mask as a set of (x, y), plus the working image size."""
    im = Image.open(os.path.expanduser(path))
    # Composite onto white BEFORE dropping to greyscale. These sources have an
    # alpha channel with a transparent background, and .convert('L') simply
    # discards alpha: the transparent pixels carry RGB 0,0,0, so the whole page
    # reads as ink and the trace comes back as the image's bounding box.
    im = im.convert('RGBA')
    im = Image.alpha_composite(Image.new('RGBA', im.size, (255, 255, 255, 255)), im).convert('L')
    if max(im.size) > WORK_MAX:
        k = WORK_MAX / max(im.size)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    w, h = im.size
    px = im.load()
    return {(x, y) for y in range(h) for x in range(w) if px[x, y] <= INK_MAX}, w, h


def thin(ink, w, h):
    """Zhang-Suen thinning down to a 1px-wide skeleton."""
    ink = set(ink)
    while True:
        removed = []
        for step in (0, 1):
            marked = []
            for (x, y) in ink:
                # P2..P9 clockwise from north, as in the paper.
                p = [
                    (x, y - 1), (x + 1, y - 1), (x + 1, y), (x + 1, y + 1),
                    (x, y + 1), (x - 1, y + 1), (x - 1, y), (x - 1, y - 1),
                ]
                n = [1 if q in ink else 0 for q in p]
                b = sum(n)
                if b < 2 or b > 6:
                    continue
                # Number of 0->1 transitions around the ring.
                a = sum(1 for i in range(8) if n[i] == 0 and n[(i + 1) % 8] == 1)
                if a != 1:
                    continue
                if step == 0:
                    if n[0] * n[2] * n[4] != 0 or n[2] * n[4] * n[6] != 0:
                        continue
                else:
                    if n[0] * n[2] * n[6] != 0 or n[0] * n[4] * n[6] != 0:
                        continue
                marked.append((x, y))
            for q in marked:
                ink.discard(q)
            removed.extend(marked)
        if not removed:
            return ink


NEIGHBOURS = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


def neighbours(p, skel):
    """
    Graph neighbours of a skeleton pixel, with redundant diagonals removed.

    This is the difference between a trace that works and one that shreds the
    drawing. A thinned line is 8-connected, so wherever it steps diagonally the
    pixels form a little triangle: A is orthogonally adjacent to B, B to C, and
    A is ALSO diagonally adjacent to C. Counting that diagonal as an edge gives
    three pixels of degree 3 in the middle of a perfectly ordinary straight
    line, the walk reads them as junctions and stops at every one, and the
    stroke comes apart into two-pixel crumbs that the length filter then throws
    away entirely.

    A diagonal step is redundant exactly when one of the two orthogonal pixels
    that would complete its corner is also ink, so those are dropped.
    """
    x, y = p
    out = []
    for dx, dy in NEIGHBOURS:
        q = (x + dx, y + dy)
        if q not in skel:
            continue
        if dx and dy and ((x + dx, y) in skel or (x, y + dy) in skel):
            continue
        out.append(q)
    return out


def prune_spurs(skel, max_len=4):
    """
    Drop short dead-end branches.

    Thinning a hand-drawn marker line leaves whiskers wherever the stroke was
    slightly wider (a start, a corner, a crossing). They are only a few pixels
    long, they are not anything the person drew, and each one becomes both a
    stray mark and a false junction that fragments the trace.
    """
    skel = set(skel)
    changed = True
    while changed:
        changed = False
        ends = [p for p in skel if len(neighbours(p, skel)) == 1]
        for p in ends:
            if p not in skel:
                continue
            branch, cur = [p], p
            while len(branch) <= max_len:
                nb = [q for q in neighbours(cur, skel) if q not in branch]
                if len(nb) != 1:
                    break
                # Reached a junction: this branch is a spur, not a stroke.
                if len(neighbours(nb[0], skel)) > 2:
                    for q in branch:
                        skel.discard(q)
                    changed = True
                    break
                branch.append(nb[0])
                cur = nb[0]
    return skel


def trace(skel):
    """
    Walk the skeleton into polylines.

    Every edge of the pixel graph is consumed exactly once. Paths are started at
    endpoints and junctions first, so open strokes come out whole; whatever is
    left is a closed loop (an outline like the shrimp's body) and is walked from
    an arbitrary point on it.
    """
    used_edges = set()

    def edge(a, b):
        return (a, b) if a <= b else (b, a)

    def walk(start, first):
        path = [start, first]
        used_edges.add(edge(start, first))
        cur, prev = first, start
        while True:
            nb = [q for q in neighbours(cur, skel) if q != prev and edge(cur, q) not in used_edges]
            # Stop at a junction: a path through one would join two strokes that
            # a person drew separately.
            if len(nb) != 1 or len(neighbours(cur, skel)) > 2:
                break
            used_edges.add(edge(cur, nb[0]))
            prev, cur = cur, nb[0]
            path.append(cur)
        return path

    paths = []
    ranked = sorted(skel, key=lambda p: (len(neighbours(p, skel)) != 1, p))
    for p in ranked:
        for q in neighbours(p, skel):
            if edge(p, q) in used_edges:
                continue
            paths.append(walk(p, q))
    return paths


def rdp(points, eps):
    """Ramer-Douglas-Peucker, iterative so a long path cannot blow the stack."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = points[i]
        bx, by = points[j]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        worst, worst_i = -1.0, -1
        for k in range(i + 1, j):
            px, py = points[k]
            if norm == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > worst:
                worst, worst_i = d, k
        if worst > eps and worst_i > 0:
            keep[worst_i] = True
            stack.append((i, worst_i))
            stack.append((worst_i, j))
    return [p for p, k in zip(points, keep) if k]


def trace_file(src):
    ink, w, h = load_ink(src)
    if not ink:
        raise SystemExit(f'no ink found in {src}')
    skel = prune_spurs(thin(ink, w, h))
    paths = [p for p in trace(skel) if len(p) >= MIN_PATH_PX]
    paths = [rdp(p, RDP_EPS) for p in paths]

    # Normalise to the ink's own bounding box, so every drawing arrives
    # tightly cropped and the layout does not inherit the source's margins.
    xs = [x for p in paths for x, _ in p]
    ys = [y for p in paths for _, y in p]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    span = max(maxx - minx, 1)
    scale = VIEW_W / span
    view_h = round((maxy - miny) * scale)

    out = []
    for p in paths:
        out.append([[round((x - minx) * scale, 1), round((y - miny) * scale, 1)] for x, y in p])
    return out, VIEW_W, view_h


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out_path, specs = sys.argv[1], sys.argv[2:]

    blocks = []
    names = []
    for spec in specs:
        name, _, src = spec.partition('=')
        paths, vw, vh = trace_file(src)
        pts = sum(len(p) for p in paths)
        print(f'{name}: {len(paths)} paths, {pts} points, viewBox {vw}x{vh}', file=sys.stderr)
        body = ',\n    '.join(
            '[' + ','.join(f'[{x},{y}]' for x, y in p) + ']' for p in paths
        )
        names.append(name)
        blocks.append(
            f'export const {name}: Doodle = {{\n'
            f'  width: {vw},\n  height: {vh},\n  paths: [\n    {body},\n  ],\n}};\n'
        )

    header = f'''/**
 * Traced doodles for the Draw! start page. GENERATED — do not edit by hand.
 * Regenerate with scripts/trace-doodles.py (see that file for the why).
 *
 * These are centrelines, not outlines: each path is the middle of one pen
 * stroke, so the drawings carry no thickness of their own and take it from
 * --hand-stroke like every other line on the surface. That is what lets the
 * crown be shown small and the horse large without their line weights
 * disagreeing, which a scaled bitmap cannot do.
 *
 * Coordinates are normalised to each drawing's own ink bounding box, width
 * {VIEW_W}, height per drawing.
 */

export interface Doodle {{
  width: number;
  height: number;
  /** Polylines, each a list of [x, y] in the doodle's own viewBox. */
  paths: number[][][];
}}

'''
    with open(out_path, 'w') as f:
        f.write(header + '\n'.join(blocks))
    print(f'wrote {out_path} ({", ".join(names)})', file=sys.stderr)


if __name__ == '__main__':
    main()
