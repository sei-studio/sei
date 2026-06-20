#!/usr/bin/env python3
"""Generate three minimalist flowchart SVGs for the proactiveness redesign.

Design language: white canvas, thin slate strokes, rounded boxes, periwinkle
(#7FB0FF) accent for the load-bearing node, a few words per shape, no bullet
points, no dashes in any label. Converted to PDF with rsvg-convert.
"""

BG = "#ffffff"
INK = "#1c2230"
LINE = "#9aa3b2"
ACCENT = "#7FB0FF"
ACCENT_INK = "#0f2a52"
SOFT = "#eef2f9"
LANE_P = "#f3f5f9"   # passive
LANE_R = "#eef4ff"   # reactive
LANE_A = "#e6efff"   # agentic

FONT = "Helvetica, Arial, sans-serif"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def box(x, y, w, h, lines, fill="#ffffff", stroke=LINE, ink=INK,
        rx=10, lead_size=17, sub_size=12.5, bold_first=True, sw=1.6):
    """lines: list of (text, is_sub). Centered."""
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" ry="{rx}" '
           f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>']
    total = []
    for t, sub in lines:
        total.append(sub_size if sub else lead_size)
    gap = 5
    block_h = sum(total) + gap * (len(lines) - 1)
    cy = y + h / 2 - block_h / 2
    baseline = cy
    for i, (t, sub) in enumerate(lines):
        size = total[i]
        baseline += size
        weight = "700" if (i == 0 and bold_first and not sub) else "400"
        col = ink if not sub else "#5b6strip"
        col = ink if not sub else "#5b6678"
        out.append(
            f'<text x="{x + w/2}" y="{baseline - size*0.22}" font-family="{FONT}" '
            f'font-size="{size}" font-weight="{weight}" fill="{col}" '
            f'text-anchor="middle">{esc(t)}</text>')
        baseline += gap
    return "\n".join(out)


def arrow(x1, y1, x2, y2, stroke=LINE, sw=1.8):
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" '
            f'stroke-width="{sw}" marker-end="url(#ah)"/>')


def title(x, y, eyebrow, t):
    return (f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="13" '
            f'font-weight="700" fill="{ACCENT_INK}" letter-spacing="2">{esc(eyebrow)}</text>'
            f'<text x="{x}" y="{y+26}" font-family="{FONT}" font-size="22" '
            f'font-weight="700" fill="{INK}">{esc(t)}</text>')


def svg(w, h, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs>
<marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
<path d="M0,0 L8,3 L0,6 z" fill="{LINE}"/>
</marker>
</defs>
<rect width="{w}" height="{h}" fill="{BG}"/>
{body}
</svg>'''


# ───────────────────────── FIG 1 ─────────────────────────
def fig1():
    W, H = 1160, 760
    b = [title(60, 64, "FIGURE 1", "Proactiveness Levels In Game")]
    # top node
    tnx, tny, tnw, tnh = W/2 - 150, 110, 300, 56
    b.append(box(tnx, tny, tnw, tnh, [("Quiet tick, no goal", False)], fill=SOFT))
    lanes = [
        ("Passive", "every 10 min", LANE_P,
         [("Comment", False), ("or stay quiet", True)],
         [("No goals of its own", False)]),
        ("Reactive", "every 1 min", LANE_R,
         [("Comment", False), ("or offer help", True)],
         [("No goals of its own", False)]),
        ("Agentic", "every 20 sec", LANE_A,
         [("Resume agenda", False), ("set goal if none", True)],
         [("Sets own goals", False)]),
    ]
    lane_w = 300
    gap = 30
    total_w = lane_w * 3 + gap * 2
    x0 = (W - total_w) / 2
    head_y = 250
    act_y = 372
    goal_y = 486
    cy_top = tny + tnh
    for i, (name, cad, fill, act, goal) in enumerate(lanes):
        lx = x0 + i * (lane_w + gap)
        cx = lx + lane_w / 2
        accent = (name == "Agentic")
        # connector from top node
        b.append(arrow(W/2, cy_top, cx, head_y, sw=1.6))
        # header chip
        hb_fill = ACCENT if accent else "#ffffff"
        hb_stroke = ACCENT if accent else LINE
        hb_ink = ACCENT_INK if accent else INK
        b.append(box(lx, head_y, lane_w, 70,
                     [(name, False), (cad, True)],
                     fill=hb_fill, stroke=hb_stroke, ink=hb_ink, sw=2 if accent else 1.6))
        b.append(arrow(cx, head_y + 70, cx, act_y, sw=1.6))
        # idle action
        b.append(box(lx + 20, act_y, lane_w - 40, 84, act, fill=fill))
        b.append(arrow(cx, act_y + 84, cx, goal_y, sw=1.6))
        # goals
        gfill = "#dbe8ff" if accent else "#ffffff"
        b.append(box(lx + 40, goal_y, lane_w - 80, 56, goal, fill=gfill,
                     stroke=ACCENT if accent else LINE))
    # shared bottom bar
    bar_y = 600
    b.append(arrow(x0 + lane_w/2, goal_y + 56, x0 + lane_w/2, bar_y, sw=1.4, stroke="#c2cad8"))
    b.append(arrow(W/2, goal_y + 56, W/2, bar_y, sw=1.4, stroke="#c2cad8"))
    b.append(arrow(x0 + 2*(lane_w+gap) + lane_w/2, goal_y + 56,
                   x0 + 2*(lane_w+gap) + lane_w/2, bar_y, sw=1.4, stroke="#c2cad8"))
    b.append(box(x0, bar_y, total_w, 58,
                 [("All record a player's long task with setGoal", False)],
                 fill=SOFT, stroke="#c2cad8"))
    return svg(W, H, "\n".join(b))


# ───────────────────────── FIG 2 ─────────────────────────
def fig2():
    W, H = 1240, 700
    b = [title(60, 64, "FIGURE 2", "Character Expander Content")]
    # input + expander (top left)
    ix, iy, iw, ih = 60, 150, 210, 66
    b.append(box(ix, iy, iw, ih, [("Short blurb", False), ("name plus tier", True)], fill=SOFT))
    ex, ey, ew, eh = 310, 150, 200, 66
    b.append(box(ex, ey, ew, eh, [("Expander", False), ("Haiku call", True)], fill="#ffffff"))
    b.append(arrow(ix + iw, iy + ih/2, ex, ey + eh/2))

    # three source buckets, stacked in the middle column
    colx, colw = 560, 360
    by = [100, 280, 460]
    bh = 156
    buckets = [
        ("Universal rules", "Hard coded, every character",
         ["Length and voice", "Memory rule, tools"], "#ffffff", LINE),
        ("Proactiveness rules", "Per tier directive",
         ["Cadence and agency", "When to set goal"], "#eef4ff", ACCENT),
        ("Character flavor", "Expander writes this",
         ["Identity, voice", "Goal type, memory"], "#ffffff", LINE),
    ]
    for i, (head, sub, body_lines, fill, stroke) in enumerate(buckets):
        yy = by[i]
        lines = [(head, False), (sub, True)] + [(t, True) for t in body_lines]
        b.append(box(colx, yy, colw, bh, lines, fill=fill, stroke=stroke,
                     lead_size=18, sub_size=13))
    # expander feeds ONLY the flavor bucket (stays left of the stack)
    b.append(arrow(ex + ew/2, ey + eh, colx, by[2] + bh/2, sw=1.5))
    b.append(f'<text x="{ex + ew/2 + 6}" y="{ey + eh + 150}" font-family="{FONT}" '
             f'font-size="12.5" fill="#5b6678" text-anchor="middle">writes only the flavor</text>')

    # merge into the assembled prompt (right, vertically centered) via clean fan in
    mx, my, mw, mh = 1010, 320, 200, 116
    b.append(box(mx, my, mw, mh, [("Assembled", False), ("prompt", False), ("each loop", True)],
                 fill=ACCENT, stroke=ACCENT, ink=ACCENT_INK, sw=2))
    for i in range(3):
        b.append(arrow(colx + colw, by[i] + bh/2, mx, my + mh/2, sw=1.4, stroke="#c2cad8"))
    return svg(W, H, "\n".join(b))


# ───────────────────────── FIG 3 ─────────────────────────
def fig3():
    W, H = 1420, 760
    b = [title(60, 60, "FIGURE 3", "Full In Game Loop")]
    # triggers (left column)
    trig = ["Player chat", "Attacked", "Action done", "Idle tick"]
    tx, tw, th = 60, 190, 56
    ty0, tgap = 150, 78
    qx, qy, qw, qh = 320, 250, 210, 90
    for i, t in enumerate(trig):
        yy = ty0 + i * tgap
        sub = "20 sec to 10 min" if t == "Idle tick" else None
        lines = [(t, False)] + ([(sub, True)] if sub else [])
        b.append(box(tx, yy, tw, th, lines, fill=SOFT, lead_size=15.5))
        b.append(arrow(tx + tw, yy + th/2, qx, qy + qh/2, sw=1.4))
    # priority queue
    b.append(box(qx, qy, qw, qh, [("Priority queue", False), ("FSM, one at a time", True)],
                 fill="#ffffff"))
    # compose context
    cx, cy, cw, ch = 600, 250, 210, 90
    b.append(box(cx, cy, cw, ch, [("Compose", False), ("context", False)], fill=SOFT))
    b.append(arrow(qx + qw, qy + qh/2, cx, cy + ch/2))

    # context feeders (top)
    feeders = ["World snapshot", "Prismarine view", "Heartbeat", "Memory", "Recent chat"]
    fw, fh = 168, 48
    fy = 70
    fx0 = 470
    fgap = 12
    for i, f in enumerate(feeders):
        fx = fx0 + i * (fw + fgap)
        fill = "#eef4ff" if f == "Heartbeat" else "#ffffff"
        stroke = ACCENT if f == "Heartbeat" else LINE
        b.append(box(fx, fy, fw, fh, [(f, False)], fill=fill, stroke=stroke, lead_size=14))
        b.append(arrow(fx + fw/2, fy + fh, cx + cw/2, cy, sw=1.1, stroke="#c2cad8"))

    # brain
    bx, by_, bw, bh = 900, 248, 230, 94
    b.append(box(bx, by_, bw, bh, [("LLM brain", False), ("one call", True)],
                 fill=ACCENT, stroke=ACCENT, ink=ACCENT_INK, sw=2))
    b.append(arrow(cx + cw, cy + ch/2, bx, by_ + bh/2))

    # outputs (right column)
    outs = [
        ("Chat to game", "#ffffff"),
        ("World action", "#ffffff"),
        ("Set goal or remember", "#eef4ff"),
        ("End loop", "#ffffff"),
    ]
    ox, ow, oh = 900, 230, 52
    oy0, ogap = 430, 66
    for i, (o, fill) in enumerate(outs):
        yy = oy0 + i * ogap
        b.append(box(ox, yy, ow, oh, [(o, False)], fill=fill, lead_size=15))
        b.append(arrow(bx + bw/2, by_ + bh, ox + ow/2, yy, sw=1.2, stroke="#c2cad8"))

    # world action loops back to action done
    wa_y = oy0 + 1 * ogap + oh / 2
    b.append(f'<path d="M {ox} {wa_y} '
             f'C 720 {wa_y}, 700 {ty0 + 2*tgap + th/2}, {tx + tw + 4} {ty0 + 2*tgap + th/2}" '
             f'fill="none" stroke="#c2cad8" stroke-width="1.4" marker-end="url(#ah)"/>')
    b.append(f'<text x="690" y="{wa_y + 150}" font-family="{FONT}" font-size="12.5" '
             f'fill="#5b6678" text-anchor="middle">action runs, then back to queue</text>')
    return svg(W, H, "\n".join(b))


import os
here = os.path.dirname(os.path.abspath(__file__))
for name, fn in [("fig1_levels", fig1), ("fig2_expander", fig2), ("fig3_loop", fig3)]:
    p = os.path.join(here, name + ".svg")
    with open(p, "w") as f:
        f.write(fn())
    print("wrote", p)
