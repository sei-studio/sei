# Sei UI Design System — "Summoning Terminal"

> **This is the single source of truth for Sei's GUI look & feel.** Any new
> frontend work — new screens, components, modals, states — MUST snap to what's
> already placed here. Do not invent new colors, fonts, radii, button shapes, or
> spacing. Reach for an existing token / utility / component first; only add a
> token when a value is needed by ≥1 component, and add it to `tokens.css` (not
> inline). When in doubt, open the app, find the closest existing surface, and
> match it.
>
> Ported from the `~/Downloads/sei-gui-improved` mockup (Jun 2026). Tokens live
> in `src/renderer/src/styles/tokens.css`; globals + utilities in `global.css`;
> fonts in `fonts.css`. Per-component visuals live in each component's
> `*.module.css`.

---

## 1. The aesthetic in one breath

A dark, sci-fi **summoning terminal**: sharp-edged, full-bleed, condensed
display type over tracked mono micro-labels, a single periwinkle accent, and a
faint atmosphere (static grain + edge vignette only). Characters are
"summons"; the app reads like an operator console, not a SaaS dashboard. Dark is
the hero; a light "paper" mirror exists for the theme toggle.

**Five principles**

1. **Sharp, never round.** Every corner is square (`border-radius: 0`, D-28),
   **including the rail's character avatars**. The only curves are circular
   status dots. Emphasis comes from the accent and the clip-path notch, not from
   rounding.
2. **One accent, used sparingly.** Periwinkle `#7FB0FF`. It marks the active
   nav, the primary CTA, focus rings, hovered borders, and live status — nothing
   decorative. Surfaces stay near-black; the accent is the only saturated color.
3. **Three voices of type.** Condensed **Oswald** for display (names, headings,
   big numbers); **Rajdhani** for body/UI; **JetBrains Mono** for every tracked
   uppercase micro-label and numeric. A label is almost always mono + uppercase +
   wide tracking.
4. **Portraits are the hero image.** Cards and the detail screen are built
   around full-bleed character art with a per-character accent tint behind it and
   a bottom/side scrim for legibility.
5. **Atmosphere, not animation.** Motion is restrained: hover lifts, an accent
   bar that fills, a decode/glint shimmer on the CTA. The window field is a
   flat near-black (no accent bloom, no sweep band, no scanlines).
   Everything respects `prefers-reduced-motion`.

---

## 2. Color tokens

Defined in `tokens.css` under `:root[data-theme="dark"]` (hero) and `:root` /
`:root[data-theme="light"]` (paper mirror). **Always reference the token, never
the hex.** Components are theme-agnostic because they read semantic tokens.

| Token | Dark (hero) | Role |
|---|---|---|
| `--bg` `--bg2` `--bg3` `--bg4` | `#09090b` → `#1c1c23` | Background ramp (darkest→lightest) |
| `--window` | `#09090b` | App window fill (matches `--bg` — the mockup has no lighter "window" tone) |
| `--surface` `--surface-2` | `#0e0e12` / `#15151b` | Cards, panels, inputs, menus |
| `--card-top` `--card-bottom` | `#0c0c10` / `#08080a` | Portrait-card backing ramp (darker than surfaces; the per-character tint sits over it) |
| `--rail` | `#0a0a0d` | Sidebar rail |
| `--text` | `#e9e7e1` | Primary text |
| `--text-2` | `#a8a6a0` | Secondary text |
| `--muted` `--muted-2` | `#82807a` / `#56544e` | Labels, hints, disabled |
| `--accent` | `#7FB0FF` | The one accent |
| `--accent-strong` | `#9cc4ff` | Accent hover |
| `--accent-soft` | `rgba(127,176,255,.16)` | Accent tints, glows, rings |
| `--accent-text` | `#1a1206` | Text/icon on an accent fill (near-black; mockup CTA value) |
| `--acc` / `--acc-c` | `127 176 255` / `rgb(var(--acc))` | rgb-triple for custom `rgba()` |
| `--green` | `#78c878` | Ready / online / public |
| `--red` `--red-strong` | `#c0443c` / `#e8746b` | Error / danger / disconnected |
| `--warn` | `#e0be5c` | Warnings, connecting |
| `--border` / `--line` | `rgba(255,255,255,.07)` | Hairline dividers, card borders |
| `--border-strong` / `--line2` | `rgba(255,255,255,.13)` | Stronger borders, inputs, secondary buttons |

Shadows: `--shadow-card`, `--shadow-pop`, `--shadow-window`. Theme-aware fades
inside scrims use `color-mix(in srgb, var(--window) NN%, transparent)`.

---

## 3. Typography

Fonts are self-hosted woff2 in `public/fonts/` (no CDN — D-05). Stacks:

- `--display: 'Oswald', 'Noto Sans', system-ui, sans-serif` — condensed display.
  Weights 500/600/700. Use for: page titles (44px), character names
  (`clamp(40px,8vh,72px)` on the detail screen, 25px on cards), stat values
  (19px), plan prices (40px). Letter-spacing ~`.02–.04em`, line-height `.84–.95`.
- `--sans: 'Rajdhani', 'Noto Sans', …` — body & UI. Descriptions, settings rows,
  modal copy. 14–16px.
- `--mono: 'JetBrains Mono', …` — **every tracked micro-label**, numerics, ids,
  the clock, button labels. 10–12px, `letter-spacing .14–.22em`,
  `text-transform: uppercase`. The smaller the label, the wider the tracking.
- `--pixel: 'Press Start 2P'` — reserved for procedural pixel-portrait fallback
  only. Do not use for UI text.

**Rule of thumb:** heading → Oswald; prose → Rajdhani; anything UPPERCASE & small
→ JetBrains Mono.

---

## 4. Utility classes (global.css)

Use these instead of re-deriving the ramp:

- `.u-lbl` — the workhorse tracked uppercase mono micro-label (10px / `.22em`).
- `.u-mono` — mono with tabular numerics.
- `.u-display` — Oswald display.
- `.u-brk` + `.tl/.tr/.bl/.br` — the four L-shaped corner brackets that frame a
  card/panel. Place four `<span class="u-brk tl">…</span>` inside a
  `position:relative` ancestor; toggle opacity on hover in the component module
  via `.card:hover :global(.u-brk){opacity:1}`.

HUD overlay layers are mounted once by `MacosWindow` above all content,
`pointer-events:none`. Only **two** layers ship: `.hud-grain` (faint film
grain) and `.hud-vignette` (soft edge darkening). The mockup's scanline layer
(`--scan:0`) and its travelling accent "sweep" band are **off by design** — they
read as a distracting moving scan over the UI; do not reintroduce them. Don't
remount the overlays per-screen.

---

## 5. Components & patterns (the placed vocabulary — match these)

**Window shell (`MacosWindow`)** — full-bleed dark window with a **flat
`--window` field** (no accent-bloom gradient — keep it a solid near-black; the
grain + vignette overlays supply the only depth). **No visible title bar** — the
SEI mark + clock were removed; only a thin transparent **drag strip**
(`.dragStrip`, ~30px) remains so the frameless window stays movable and the OS
window controls (macOS traffic lights / Windows overlay) clear the content.

**Sidebar rail (`IconRail`, 74px / `--rail-w`)** — muted icons that light to
`--text` on hover and `--accent` when active; active nav carries a 2px **left
accent bar**. Glyphs are the mockup's sharp/geometric set (`hud.jsx Icon.*`):
the Home/roster nav is a **2×2 square grid** (`RosterIcon`), World is a globe,
Mana is a four-point spark (`StarIcon`), Settings is a two-track slider
(`SettingsIcon` — the cog is reserved for the per-character `GearIcon`).
Character avatars are 38px **squares** with a `--border-strong` ring, accent
ring when active, `scale(1.06)` on hover (the +/World tiles in that cluster are
square too, to match).

**Buttons (`Button`)** — mono, uppercase, tracked, sharp.
- `accent` = primary CTA: accent fill + **notched clip-path corner**
  (`polygon(8px 0, … 0 8px)`), weight 700, hover `brightness(1.12)`.
- `primary` = accent fill, square.
- `ghost` = bordered (`--border-strong`), transparent, lights to accent on hover
  (the mockup's `.btn-sec` secondary — used for most non-primary actions).
- `quiet` = borderless muted, → accent on hover.
- `danger` = bordered red (`.btn-sec.danger`) for destructive actions.
- Sizes sm/md/lg. The big detail CTA adds a travelling glint (`.deployBtn`).
- **The primary "create" action is `accent`, not `ghost`** — e.g. Home's "New".

**Cards (`CharacterCard` / `BrowseCard` / `AddCard`)** — tall `aspect-ratio:
210/312` portrait tiles. Layers (z 0→5): per-character accent **tint** bg →
full-bleed portrait → bottom **scrim** → top-right chip/sync rail → bottom
**meta** (Oswald name + mono status line with a status dot) → hover overlay
(quick action). The status line shows the bare last-summoned **date** (e.g.
"May 23, 2026") or "Never summoned" — no "Last summoned ·" prefix on the card
(the full label lives on the detail screen's stat cell). Hover:
`translateY(-7px)`, accent border + soft ring, portrait
`scale(1.05)`, accent **bar** fills the bottom, corner brackets fade in. Grid:
`repeat(auto-fill, minmax(190px,1fr))`, `gap: 6px`. `AddCard` = dashed tile, same
footprint.

**Character detail (`CharacterPage`)** — portrait **bleeds off the right edge**
(56% wide) behind a left→right `--window` scrim; a left content panel (≤640px)
holds: back crumb (mono) → Oswald name (huge) → inline status line (dot + tracked
label) → public/private toggle → underlined tabs (Details/Skin) → persona/desc
card + 3 stat cells → a bottom **deploy bar** (accent Summon CTA with glint +
square gear button). All editors/menus/modals preserved.

**Tabs** — mono uppercase tracked; active tab marked by a 2px accent underline,
muted otherwise.

**Stat / info cells** — `--surface` tint, hairline border, mono eyebrow
(`.u-lbl` style) + Oswald value. Lay out in tight `gap: 5px` grids.

**Status dots** — circular, color by state (`--green` ready/online/public,
`--warn` connecting, `--red` error/offline, `--muted` idle), `box-shadow: 0 0 6–8px
currentColor` glow when "live". Paired with a mono uppercase label.

**Inputs / search** — `rgba(127,127,127,.03)` fill, `--border-strong` border,
mono text, border → `--accent` on focus, sharp.

**Modals / sheets** — scrim `rgba(0,0,0,.62)`; card on `--surface` with a
`--border-strong` outline + `--shadow-pop`; Oswald title, Rajdhani body, button
row bottom-right (`quiet` cancel + `accent`/`primary` confirm). Sharp.

**Section layout (Settings / Mana)** — `--space-xl` between sections, a
`--border` top rule per section, a mono uppercase **eyebrow** title, then
key/value rows. Danger zone = bordered red `dangerBtn`, red label.

---

## 6. Motion

- Easing: `--ease` `cubic-bezier(.22,.61,.36,1)` (entrances/cards), `--ease-pop`
  for snappy pops. `--flux` scales durations (calm/standard/max).
- Card hover lift + accent-bar fill (`.35s var(--ease)`), portrait `scale`.
- Detail name uses a decode-in shimmer; the deploy CTA has a looping glint.
- No full-window "sweep" band and no scanlines — atmosphere is just static grain
  + vignette (see §4). Motion is reserved for direct interaction feedback.
- **Always** wrap motion so `@media (prefers-reduced-motion: reduce)` neutralizes
  it (already global in `animations.css` + `global.css`).

---

## 7. Adding new UI — the checklist

1. **Theme via tokens only.** No literal hex/px colors; reference `tokens.css`.
   New shared value → add a token there with a one-line rationale.
2. **Pick the right type voice** (Oswald / Rajdhani / JetBrains Mono) per §3.
3. **Sharp corners**, one accent, generous tracking on small labels.
4. **Reuse a placed component** (`Button`, card primitives in
   `CharacterCard.module.css`, stat cells, status dots, the modal pattern)
   before writing new CSS. Composing `CharacterCard.module.css` is how Browse
   cards stay identical to Home cards — prefer that over a parallel implementation.
5. **Match an existing screen's rhythm** (padding `34px 40px`, section
   `--space-xl`, grid `gap 6px`, etc.).
6. **Both themes must read** — check dark (hero) and light. Token references make
   this automatic; only override per-theme when truly needed
   (`:root[data-theme="light"] .x { … }`).
7. **Respect reduced motion** on anything animated.
8. **Never remove an existing feature** to match a mock. The mockup is a visual
   reference, not a feature spec — popups, sync pills, billing, editors, etc.
   stay; restyle them, don't drop them.

---

## 8. Source map

| Concern | File |
|---|---|
| Color / type / motion / layout tokens | `src/renderer/src/styles/tokens.css` |
| `@font-face` (self-hosted woff2) | `src/renderer/src/styles/fonts.css` + `public/fonts/` |
| Resets, wallpaper, utilities, HUD overlays | `src/renderer/src/styles/global.css` |
| Keyframes | `src/renderer/src/styles/animations.css` |
| Window shell + title bar + overlay mount | `components/MacosWindow.tsx` |
| Rail | `components/IconRail.*` |
| Buttons | `components/Button.*` |
| Card primitives (shared) | `components/CharacterCard.module.css` |
| Detail screen | `screens/CharacterPage.*` |
| Summons / World grids | `screens/HomeScreen.module.css`, `screens/CharactersScreen.module.css` |
| Mana / Settings rhythm | `screens/CreditsScreen.module.css`, `screens/SettingsScreen.module.css` |

The earlier `04-UI-SPEC.md` (archived milestone) described the prior light
macOS-window design and is **superseded by this document** for all look & feel.
