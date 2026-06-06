---
quick_id: 260525-ulq
date: 2026-05-25
cluster: H (Mojang Commercial Usage compliance)
requirements: [F17, F18, F19]
target_repo: sei-website   # filesystem-only, NOT a git repo
sei_repo_commits: 0
files_modified:
  - ../sei-website/css/styles.css
  - ../sei-website/index.html
  - ../sei-website/build.html
  - ../sei-website/terms.html
  - ../sei-website/privacy.html
files_preserved_on_disk_but_unreferenced:
  - ../sei-website/img/minecraft-logo.png   # 201,681 bytes — orphan, operator may rm
  - ../sei-website/img/skyrim-logo.png      # 71,023 bytes — orphan, operator may rm
pitch_html_status: untouched   # slide deck — no game logos, no "playtime" copy, no public-facing footer
---

# Cluster H Mojang Compliance Scaffold — SUMMARY

## Scope

Three coupled remediations from the Cluster H legal-exposure review:

| Req | Risk | Mitigation |
|-----|------|------------|
| F17 (HIGH) | Pricing copy framed value as "Minecraft playtime" — arguably implicates Mojang's commercial-usage prohibition (charging for access to their game). | Reframe both QUEST and PARTY tier descriptions onto "AI inference / token credits / companion runtime" language. |
| F18 (HIGH) | `img/minecraft-logo.png` (cracked-stone wordmark) and `img/skyrim-logo.png` (Bethesda wordmark) were rendered in the public marketing surface — direct use of unlicensed brand assets. | Replace `<img>` references with typographic spans in Chakra Petch (existing site font), uppercase + letter-spaced, with adjacent TM attribution. PNG files preserved on disk (no `rm`). |
| F19 (MED) | No non-affiliation disclaimer on marketing footers — only buried in ToS. | Add `.legal-disclaimer` paragraph to all four marketing-surface footers (index, build, terms, privacy). |

## Files Modified

### 1. `../sei-website/css/styles.css` (appended ~46 lines)

Added a new compliance block at end of file, composed entirely of existing CSS variables (`--f`, `--ink-0/1/2`, `--border`) — no new fonts, no new colors.

**New classes:**
- `.game-name` — typographic wordmark container (Chakra Petch, weight 700, uppercase, letter-spacing 0.18em, bordered chip)
- `.game-name--mc`, `.game-name--skyrim` — per-game tone modifiers
- `.tm-attr` — small TM acknowledgement (11px, ink-2, centered)
- `.game-name-wrap` — inline-flex column to stack name + TM attribution
- `.legal-disclaimer` — italic 12px footer disclaimer paragraph

### 2. `../sei-website/index.html`

**F18 — Minecraft logo (line ~217), BEFORE:**
```html
<img class="game-logo game-logo--mc" src="img/minecraft-logo.png" alt="Minecraft" width="3602" height="603" loading="lazy" />
```
**AFTER:**
```html
<span class="game-name-wrap">
  <span class="game-name game-name--mc" role="img" aria-label="Minecraft">MINECRAFT</span>
  <small class="tm-attr">MINECRAFT&trade; Mojang Synergies AB</small>
</span>
```

**F18 — Skyrim logo (line ~222), BEFORE:**
```html
<img class="game-logo game-logo--skyrim" src="img/skyrim-logo.png" alt="Skyrim" width="759" height="236" loading="lazy" />
```
**AFTER:**
```html
<span class="game-name-wrap">
  <span class="game-name game-name--skyrim" role="img" aria-label="The Elder Scrolls V: Skyrim">SKYRIM</span>
  <small class="tm-attr">SKYRIM&reg; Bethesda Softworks LLC</small>
</span>
```

**F17 — QUEST tier (line ~303), BEFORE:**
```html
<p class="tier__desc">Cloud-hosted, no setup. ~2 hours of playtime.</p>
```
**AFTER:**
```html
<p class="tier__desc">Cloud-hosted Sei AI inference. Token credits sized for ~2 hours of typical companion runtime.</p>
```

**F17 — PARTY tier (line ~313), BEFORE:**
```html
<p class="tier__desc">Cloud-hosted, no setup. ~10 hours of playtime every month.</p>
```
**AFTER:**
```html
<p class="tier__desc">Cloud-hosted Sei AI inference. Token credits sized for ~10 hours of typical companion runtime per month.</p>
```

**F19 — Footer (line ~433), BEFORE:**
```html
<p>© 2026 Sei Studio. · <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p>
```
**AFTER (appended sibling paragraph):**
```html
<p>© 2026 Sei Studio. · <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p>
<p class="legal-disclaimer">Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.</p>
```

### 3. `../sei-website/build.html`

**F19 — Footer (line ~215), BEFORE:**
```html
<p>© 2026 Sei Studio.</p>
```
**AFTER:**
```html
<p>© 2026 Sei Studio.</p>
<p class="legal-disclaimer">Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.</p>
```

### 4. `../sei-website/terms.html`

Legal pages use inline styles (don't load `styles.css`). Used inline `style="font-style: italic;"` instead of the class.

**F19 — Footer (line ~328), BEFORE:**
```html
<p class="legal__footer">
  Effective 2026-05-26 · <a href="/privacy.html">Privacy Policy</a> · <a href="/">Home</a>
</p>
```
**AFTER:**
```html
<p class="legal__footer">
  Effective 2026-05-26 · <a href="/privacy.html">Privacy Policy</a> · <a href="/">Home</a>
</p>
<p class="legal__footer" style="font-style: italic;">
  Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.
</p>
```

### 5. `../sei-website/privacy.html`

**F19 — Footer (line ~200), BEFORE:**
```html
<p class="legal__footer">
  Effective 2026-05-23 · <a href="/terms.html">Terms of Service</a> · <a href="/">Home</a>
</p>
```
**AFTER:**
```html
<p class="legal__footer">
  Effective 2026-05-23 · <a href="/terms.html">Terms of Service</a> · <a href="/">Home</a>
</p>
<p class="legal__footer" style="font-style: italic;">
  Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.
</p>
```

## Files NOT Modified (intentional)

### `../sei-website/pitch.html`
- Slide deck for live presentation (internal use, not a public marketing surface in the same sense).
- Scanned for issues: only mention is `<p class="list-item"><span class="tag">Party</span>$20 / month.</p>` at line 702 — neutral, no "playtime" framing.
- No `<img src="img/minecraft-logo.png">` or `<img src="img/skyrim-logo.png">` references.
- No `<footer>` element exists (deck layout).
- **Decision:** leave untouched. Re-evaluate if pitch.html is ever surfaced as a public marketing page.

### `../sei-website/img/minecraft-logo.png` and `../sei-website/img/skyrim-logo.png`
- **Preserved on disk per planner constraints** (no `rm`). 201,681 + 71,023 bytes.
- Now orphaned (no HTML references). Operator may `rm` after visual verification, or keep as backup.

## Trademark-Sensitive Asset Audit (F18 secondary)

Listed contents of `../sei-website/img/`. Findings:

| File | Status |
|------|--------|
| `minecraft-logo.png` | Trademark-sensitive — **delisted** (HTML refs removed). PNG preserved on disk. |
| `skyrim-logo.png` | Trademark-sensitive — **delisted** (HTML refs removed). PNG preserved on disk. |
| `sei-logo.png` | Our own brand — not sensitive. Still referenced in footers. |
| `app-screenshot.png` | Sei launcher screenshot — own UI, not sensitive. |
| `game1.png`, `game2.png` | In-game screenshots showing Sei + player in Minecraft worlds. **Worth a follow-up review** — screenshots of gameplay are generally permitted under Mojang's commercial-usage guidelines (they explicitly allow "videos and screenshots" of gameplay), but worth confirming the screenshots don't include the Minecraft logo/title-screen branding. |
| `hero-background.jpg` | Atmospheric art — confirm provenance separately. |
| `loop.mp4` / `loop.original.mp4` | Background video loop — confirm provenance. |
| `favicon.png`, `favicon.svg` | Own brand. |

**No other trademark-sensitive logos discovered in `img/`.** `game1.png` / `game2.png` flagged for operator's secondary review (gameplay screenshots are generally permitted under Mojang's MCUG; flagging only to confirm no UI chrome with the official logo is visible).

## Verification (all green)

```
(1) grep -c "minecraft-logo.png\|skyrim-logo.png" index.html       → 0
(2) grep -cE "hours of playtime|hours of Minecraft" index.html     → 0
(3) Disclaimer present in: index.html, build.html, terms.html, privacy.html → 4/4
(4) PNG files preserved: img/minecraft-logo.png, img/skyrim-logo.png → both exist
(5) No other trademark-sensitive logos in img/                     → confirmed
```

## Operator Screenshot Recommendations (manual UAT)

Before/after visual diff suggested for the following surfaces:

| Surface | Selector / Region | Before | After |
|---------|-------------------|--------|-------|
| `index.html` — Compatibility strip | `#play .strip__row` | Cracked-stone MINECRAFT PNG (very tall, wordmark-style) | Plain "MINECRAFT" in Chakra Petch uppercase, bordered chip, "MINECRAFT™ Mojang Synergies AB" beneath |
| `index.html` — Coming-to strip | `#play .strip__row` (2nd) | Skyrim dragon-script PNG | Plain "SKYRIM" in Chakra Petch uppercase, bordered chip, "SKYRIM® Bethesda Softworks LLC" beneath |
| `index.html` — Pricing tiers | `.tiers` | "~2 hours of playtime" / "~10 hours of playtime every month" | "Token credits sized for ~2 hours…" / "Token credits sized for ~10 hours… per month" |
| `index.html` — Footer base | `.foot__base` | Single copyright line | Copyright line + italic non-affiliation disclaimer below |
| `build.html` — Footer base | `.foot__base` | Single copyright line | Copyright line + italic non-affiliation disclaimer below |
| `terms.html` — Footer | `.legal__footer` | Single "Effective …" line | Plus italic non-affiliation disclaimer below |
| `privacy.html` — Footer | `.legal__footer` | Single "Effective …" line | Plus italic non-affiliation disclaimer below |

**Quick visual smoke test (one command from sei-website/):**
```sh
python3 -m http.server 8080 --bind 127.0.0.1
# open http://127.0.0.1:8080/index.html and confirm:
#   1. The cracked-stone Minecraft logo is GONE — typographic MINECRAFT chip in its place
#   2. Skyrim logo similarly replaced
#   3. Pricing cards say "Cloud-hosted Sei AI inference. Token credits sized for…"
#   4. Footer base now has italic non-affiliation paragraph
```

## Follow-ups (not in this quick)

1. **Operator decision:** `rm ../sei-website/img/minecraft-logo.png ../sei-website/img/skyrim-logo.png` once the typographic replacement is visually approved (deferred to operator per planner constraint).
2. **Gameplay screenshot review:** confirm `game1.png` / `game2.png` don't show the Minecraft main-menu logo or title-screen branding (gameplay screenshots themselves are permitted under Mojang MCUG).
3. **In-app surfaces:** this quick covers `sei-website/` only. The Electron app's `AddCharacterScreen` and any other surface mentioning "Minecraft playtime" or rendering the Minecraft logo should get a parallel sweep (separate quick).
4. **`build.html` footer narrowness:** the `.foot__base` `<p>` may need slight CSS tweak if the disclaimer wraps awkwardly on narrow viewports — current `.legal-disclaimer { max-width: 720px }` should be fine but verify mobile.

## Result

- **0 sei-repo commits** (target is sei-website which is not a git repo, per constraints).
- **6 files modified** in `../sei-website/`.
- **2 PNG files preserved on disk** (delisted from HTML, not deleted).
- **All 4 verification gates green.**
