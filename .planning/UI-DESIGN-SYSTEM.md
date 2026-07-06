# Sei UI Design System — "Summoning Terminal / Party"

> **This is the single source of truth for Sei's GUI look & feel.** Any new
> frontend work — new screens, components, modals, states — MUST snap to what's
> already placed here. Do not invent new colors, fonts, radii, button shapes, or
> spacing. Reach for an existing token / utility / component first; only add a
> token when a value is needed by ≥1 component, and add it to `tokens.css` (not
> inline). When in doubt, open the app, find the closest existing surface, and
> match it.
>
> Current language: the **Party concept** (Jul 2026, merged from the
> sei-roster-concept mockup — see `.planning/design/UI-REDESIGN-PARTY.md` for
> the merge spec). Tokens live in `src/renderer/src/styles/tokens.css`; globals
> + utilities in `global.css`; fonts in `fonts.css`. Per-component visuals live
> in each component's `*.module.css`.

---

## 1. The aesthetic in one breath

A dark, sci-fi **summoning terminal** that reads like a party roster: sharp
edges, full-bleed character panels, condensed display type over quiet mono
micro-labels, one periwinkle accent, faint film-grain atmosphere. Companions
are residents, not files. Dark is the hero; a light "paper" mirror exists for
the theme toggle.

**Five principles**

1. **Sharp, almost never round.** Corners are square (`border-radius: 0`,
   D-28). The deliberate circles: rail sockets/avatars, status dots, the
   Toggle pill, PercentBar. Nothing else rounds.
2. **One accent, used sparingly.** Periwinkle `#7FB0FF`. It marks the active
   nav, the primary CTA, focus rings, hovered borders, "new" presence — nothing
   decorative. Surfaces stay dark navy; green is reserved for live/in-world.
3. **Three voices of type, regular case.** Condensed **Oswald** for display;
   **Rajdhani** for body/UI and buttons; **JetBrains Mono** for micro-labels,
   ids and numerics. Nothing is uppercase-transformed anymore; labels are
   written in sentence case with quiet tracking (`.04em`).
4. **Portraits are the hero image.** The home party wall and profile are
   built around full-bleed character art behind a legibility scrim; art is
   desaturated at rest and comes alive on hover.
5. **Atmosphere, not animation.** Hover lifts, panel flex expansion, presence
   pulses, the gathering-pixels mark. Flat near-black field, static grain only.
   Everything respects `prefers-reduced-motion`.

---

## 2. Color tokens

Defined in `tokens.css` under `:root[data-theme="dark"]` (hero, a navy ramp
`#070c17 → #1d2c49`) and `:root` / `:root[data-theme="light"]` (paper mirror).
**Always reference the token, never the hex.**

Key semantic tokens: surfaces `--bg --bg2 --bg3 --bg4 --window --desktop
--surface --surface-2`; chrome `--rail --rail-fg* --elbow`; text `--text
--text-2 --muted --muted-2`; accent `--accent --accent-strong --accent-soft
--accent-text --acc` (rgb triple); status `--green --red --red-strong --warn`;
lines `--border --border-strong`; shadows `--shadow-window --shadow-card
--shadow-pop`; motion `--ease --ease-pop --flux`.

Presence colors: in-world = `--green` (glowing dot), online = `--green`
(plain dot), idle = `--warn` yellow dot, new = `--accent` (glowing
dot), connecting = `--accent` (pulsing dot). Use the `Presence` component,
never hand-rolled dots.

---

## 3. Typography

Fonts are self-hosted woff2 in `public/fonts/` (no CDN — D-05). Stacks:

- `--display: 'Oswald', …` — condensed display, weight 600. Names (30px on
  panels, 38px profile), screen/modal titles (18–34px), section h3s (16px),
  big numbers (46px playtime hero, 28px plan prices).
- `--sans: 'Rajdhani', …` — body & UI at 13–15px, and **all buttons**
  (600 weight, sentence case).
- `--mono: 'JetBrains Mono', …` — micro-labels (`.u-lbl`: 10.5px, `.04em`,
  regular case), ids (`IdTag`), kv keys, timestamps, day separators.
- `--pixel` — reserved for the procedural pixel-portrait fallback only.

**No `text-transform: uppercase` anywhere** (sole exemption: Google button,
brand-locked). Write labels in sentence case.

---

## 4. Utility classes (global.css)

- `.u-lbl` — mono micro-label (10.5px / `.04em`, regular case).
- `.u-mono` — mono with tabular numerics.
- `.u-display` — Oswald display.
- `.u-brk` + `.tl/.tr/.bl/.br` — corner brackets (used by UniqueReveal).
- `[data-tip]` — fast CSS tooltip (mono, sharp, below the element).

HUD overlays (grain only; vignette neutralized) are mounted once by
`MacosWindow`. No scanlines, no sweep band — do not reintroduce.

---

## 5. Components & patterns (the placed vocabulary — match these)

**Window shell (`MacosWindow`)** — frameless dark window, 34px drag strip with
the "Sei vX.X.X" mark, platform-branched controls (macOS traffic lights /
Windows custom / Linux native). Default size **1180×720, floor 1000×560**
(`src/main/windowChrome.ts`; the CSS floor in `MacosWindow.module.css`
matches).

**Rail (`IconRail`, 74px `--rail-w`)** — top→bottom: Home (2×2 grid icon),
World (compass), divider, **character sockets**, dormant + socket, spacer,
Playtime (spark, cloud only), Settings. Sockets are 40px **circles**:
`--border-strong` ring at rest, **green pulsing ring when summoned**, accent
double ring when selected, hover lifts 1px. The dormant socket is a
accent-tinted circle with a plus that routes to the Awaken view. Active nav =
3px left accent bar.

**Buttons (`Button`)** — Rajdhani 600, sentence case, sharp, padding-driven
sizes (sm 5×12 / md 7×14 / lg 10×24).
- `primary` (and legacy alias `accent`) = accent fill, `--accent-text` text,
  hover `--accent-strong`. No clip-path notch — that language is retired.
- `ghost` = bordered `--border-strong`, hover lights to accent + accent-soft.
- `quiet` = borderless muted, hover accent. Used for Cancel/back/text actions.
- `danger` = red-tinted border + `--red-strong` text, full red on hover.

**Modals (`ModalShell` + `ModalFooter`)** — the ONLY modal pattern. Scrim
`rgba(4,7,15,.72)`; panel `--bg2` + `--border-strong`, 20px padding, Oswald
18px title; z tiers `base` 1000 / `stacked` 1100 / `recovery` 1200; Esc and
scrim-click behavior via props. Footer: quiet/ghost dismiss first, then one
`primary` (confirm) or `danger` (destructive) CTA. Never hand-roll a scrim.

**Presence (`Presence` + `lib/presence.ts`)** — dot + label line for the five
categories (in-game "In your world" / connecting / new / online / idle),
computed by `presenceOf(character, summons[id])` with `useMinuteTick()` for
decay. In-game "now" lines come from `actionVerb(useDataStore.actions[id])`
("gathering wood…", "following you…").

**Home party wall (`CharactersScreen` HomeGrid)** — 4 full-height flex panels
(one per slot): full-bleed portrait (desaturated at rest), bottom scrim,
Oswald name + Presence line; hover expands the panel and reveals the lastline
(chat preview via `chatPreviewFor`, or the action verb when in-game) +
[Message primary][Play ghost]. Empty slots are dormant panels with the
`GatherPixels` mark + "Awaken" → Awaken view.

**Awaken view (`AwakenScreen`)** — "Meet my companion" match hero (unique
flow, Leo starfield) + side column "Create my own" / "Invite from World".
Replaces the old chooser modal.

**World grid (`WorldGrid` + `BrowseCard`)** — search + sort + "N slots open"
top bar; 3:4 art cards with meta below (Oswald 16px name, "by creator") and a
hover overlay button (Invite / In your party / Party full).

**Chat (`ChatScreen`)** — Discord-style list (grouped rows, mono day
separators), boxed composer (`--bg2` + `--border-strong`, accent send glyph),
and the collapsible 260px **presence panel** (portrait, presence + now line,
Play/Disconnect + Voice call + Full profile). Header name toggles the panel;
author-name clicks swap the card.

**Profile (`CharacterPage`)** — full-bleed right portrait, left content: back,
Oswald name + IdTag, origin chip (Matched / Created by you / Invited / Sei),
share Toggle, tabs **Description** (persona card + kv rows Bonded / Played /
Last launch / Memory+Reset) and **Game** (skin pane + proactiveness), deploy
row [Play primary][Release danger].

**Settings / Playtime rhythm** — centered column (560 / 620px), Oswald 16px
group h3s, hairline rows `label | value | control` using `Seg` (segmented
control) and `Toggle` (pill switch) primitives.

**Inputs / search** — underline or boxed with `--border-strong`, focus →
accent. TextField unchanged.

**Status dots** — use `Presence` for residents; `StatusPill` remains for
install/sync states (sans 12px, regular case).

---

## 6. Motion

- Easing `--ease` / `--ease-pop`; `--flux` scales durations.
- Panel flex expansion (.34s), art scale + saturate on hover, `.more` 0fr→1fr
  reveals, presence/socket pulses (2.6s opacity), GatherPixels cycle (8s).
- No full-window sweep, no scanlines. Motion is interaction feedback plus the
  two ambient marks (socket pulse, gathering pixels).
- **Always** neutralize under `prefers-reduced-motion` (global in
  `animations.css`; component keyframes carry their own guards).

---

## 7. Adding new UI — the checklist

1. **Theme via tokens only.** No literal hex/px colors.
2. **Pick the right type voice** per §3 — and no uppercase transforms.
3. **Sharp corners**; circles only for sockets/dots/Toggle.
4. **Reuse a placed component** (`Button`, `ModalShell`, `Presence`, `Seg`,
   `Toggle`, `GatherPixels`, panel recipes in `HomeScreen.module.css`) before
   writing new CSS.
5. **Match an existing screen's rhythm** (20px modal grid, 560/620px columns,
   12px row padding, hairline dividers).
6. **Both themes must read** — dark (hero) and light.
7. **Respect reduced motion** on anything animated.
8. **Never remove an existing feature** to match a mock. Restyle, don't drop.

---

## 8. Source map

| Concern | File |
|---|---|
| Color / type / motion / layout tokens | `src/renderer/src/styles/tokens.css` |
| `@font-face` (self-hosted woff2) | `src/renderer/src/styles/fonts.css` + `public/fonts/` |
| Resets, utilities, HUD overlays, data-tip | `src/renderer/src/styles/global.css` |
| Keyframes | `src/renderer/src/styles/animations.css` |
| Window shell + drag strip + size floor | `components/MacosWindow.*`, `src/main/windowChrome.ts` |
| Rail + sockets | `components/IconRail.*` |
| Buttons | `components/Button.*` |
| Modal primitive | `components/ModalShell.*` |
| Seg / Toggle / Presence / GatherPixels | `components/Seg.*`, `Toggle.*`, `Presence.*`, `GatherPixels.*` |
| Presence + action-verb model | `lib/presence.ts`, `lib/actionVerb.ts` |
| Party wall + World grid | `screens/CharactersScreen.*`, `screens/HomeScreen.module.css`, `components/BrowseCard.*` |
| Awaken | `screens/AwakenScreen.*` |
| Chat + presence panel | `screens/ChatScreen.*` |
| Profile | `screens/CharacterPage.*` |
| Settings / Playtime rhythm | `screens/SettingsScreen.module.css`, `screens/CreditsScreen.module.css` |

The pre-Party language (mono/uppercase buttons, notched CTA, card grid home,
per-modal scrims) is retired; if you find a straggler, migrate it to the
patterns above rather than matching it.
