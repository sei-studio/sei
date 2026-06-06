---
phase: quick-260525-ulq
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - ../sei-website/index.html
  - ../sei-website/pitch.html
  - ../sei-website/build.html
  - ../sei-website/terms.html
  - ../sei-website/privacy.html
  - ../sei-website/css/styles.css
autonomous: true
requirements:
  - F17  # reframe pricing copy off "Minecraft playtime" → AI inference / token credits
  - F18  # replace minecraft-logo.png + skyrim-logo.png with typographic treatment + TM attribution
  - F19  # add "Not affiliated with Mojang/Microsoft" disclaimer to marketing footers
user_setup: []
quick_id: 260525-ulq
target_repo: sei-website  # filesystem-only, NOT a git repo — no sei-repo commits

must_haves:
  truths:
    - "index.html no longer references img/minecraft-logo.png or img/skyrim-logo.png"
    - "Game names render as typographic text in Chakra Petch (.game-name) with TM attribution (.tm-attr) immediately adjacent"
    - "PARTY tier pricing copy reframes value as 'AI inference / token credits / companion runtime' — does NOT say 'hours of Minecraft playtime'"
    - "QUEST tier pricing copy reframes value as 'AI inference / token credits / companion runtime' — does NOT say 'hours of playtime'"
    - "Each marketing-surface footer (index.html, build.html, terms.html, privacy.html) contains a .legal-disclaimer paragraph asserting non-affiliation with Mojang/Microsoft and acknowledging the MINECRAFT trademark"
    - "PNG files (minecraft-logo.png, skyrim-logo.png) still exist on disk — only HTML references are removed"
  artifacts:
    - path: "../sei-website/index.html"
      provides: "Typographic game name + reframed pricing + footer disclaimer"
      contains: "game-name minecraft"
    - path: "../sei-website/css/styles.css"
      provides: ".game-name, .tm-attr, .legal-disclaimer classes"
      contains: ".game-name"
    - path: "../sei-website/build.html"
      provides: "Footer disclaimer"
      contains: "legal-disclaimer"
    - path: "../sei-website/terms.html"
      provides: "Footer disclaimer"
      contains: "legal-disclaimer"
    - path: "../sei-website/privacy.html"
      provides: "Footer disclaimer"
      contains: "legal-disclaimer"
  key_links:
    - from: "../sei-website/index.html"
      to: "../sei-website/css/styles.css"
      via: ".game-name / .tm-attr / .legal-disclaimer class names"
      pattern: "game-name|tm-attr|legal-disclaimer"
---

<objective>
Cluster H — Mojang Commercial Usage Guidelines compliance scaffold for the
sei-website marketing surfaces. Three coupled remediations:

  F17 (HIGH) — Reframe PARTY/QUEST pricing copy off "hours of Minecraft
              playtime" onto neutral "AI inference / token credits /
              companion runtime" language. Charging for AI inference is
              regime-neutral; charging for "Minecraft playtime" arguably
              implicates Mojang's commercial-usage prohibition.
  F18 (HIGH) — Stop rendering `img/minecraft-logo.png` (the cracked-stone
              Minecraft wordmark) and `img/skyrim-logo.png` (Bethesda's
              wordmark). Replace with Chakra Petch typographic treatment
              plus an adjacent TM attribution. PNG files are retained on
              disk (no `rm`) — only references are removed.
  F19 (MED)  — Add "Not affiliated with or endorsed by Mojang Synergies AB
              or Microsoft Corporation. MINECRAFT is a trademark of Mojang
              Synergies AB." disclaimer to every marketing-surface footer.

Purpose: Mitigate trademark / commercial-usage exposure before public
launch. Mojang explicitly prohibits using their logos / brand assets and
charging for things that look like "Minecraft access". Trademark
attribution + non-affiliation disclaimers are the standard mitigation.

Output: 6 modified files in ../sei-website/ (filesystem only, NOT a git
repo). 0 sei-repo commits — orchestrator writes SUMMARY only.
</objective>

<execution_context>
Filesystem-only edits to a sibling repo. No sei-repo git operations.
Planner-executor inline (orchestrator constraints).
</execution_context>

<context>
@./CLAUDE.md
@.planning/STATE.md

Source-of-truth files already read in this turn:
- ../sei-website/index.html  (Minecraft logo line 217, Skyrim line 222,
                              QUEST tier line 303, PARTY tier line 313,
                              footer lines 391-435, foot__base line 433)
- ../sei-website/pitch.html  (line 702 "$20 / month" — neutral already,
                              no game logos, no playtime copy, no footer)
- ../sei-website/build.html  (footer lines 173-217, copyright line 215)
- ../sei-website/terms.html  (legal__footer line 328)
- ../sei-website/privacy.html (legal__footer line 200)
- ../sei-website/css/styles.css (Chakra Petch via --f, .game-logo line
                                 331-339, .tier__note line 511-520)

<interfaces>
Existing CSS variables and classes the new styles must compose with:

```css
:root {
  --ink-0: #ffffff;
  --ink-1: #c8cee0;
  --ink-2: #7b819a;       /* used by .tier__note for de-emphasized text */
  --accent: #8ec5ff;
  --f: 'Chakra Petch', 'Bender', system-ui, sans-serif;
}

/* current logo block we are replacing */
.game-logo { display: block; width: auto; object-fit: contain; ... }
.game-logo--mc { height: 64px; }
.game-logo--skyrim { height: 64px; filter: brightness(1.05); }
```

New classes this plan introduces:
- `.game-name` — typographic wordmark in Chakra Petch (uppercase,
                  letter-spacing, weight, optional bordered chip)
- `.game-name--mc` / `.game-name--skyrim` — per-game tone modifiers
- `.tm-attr` — small TM acknowledgement adjacent to game name
- `.legal-disclaimer` — small italicized non-affiliation paragraph in
                         marketing footers
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add CSS classes (.game-name, .tm-attr, .legal-disclaimer) to styles.css</name>
  <files>../sei-website/css/styles.css</files>
  <action>
    Append a new block at the end of styles.css (after the existing tier
    rules) introducing three classes that use the existing Chakra Petch
    `--f` variable and `--ink-1`/`--ink-2` palette. No new fonts, no new
    colors — composes with existing design system.

    ```
    /* ============================================================
       quick/260525-ulq — Mojang Commercial Usage compliance
       (F17/F18/F19). Typographic game wordmarks replace cracked-stone
       PNG logos; TM attribution + non-affiliation disclaimer surfaces.
    ============================================================ */
    .game-name {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--f);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 28px;
      line-height: 1;
      color: var(--ink-0);
      padding: 14px 22px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.02);
      user-select: none;
    }
    .game-name--mc { color: var(--ink-0); }
    .game-name--skyrim { color: var(--ink-1); }
    .tm-attr {
      display: block;
      font-family: var(--f);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--ink-2);
      margin-top: 6px;
      text-align: center;
    }
    .game-name-wrap {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
    }
    .legal-disclaimer {
      font-style: italic;
      font-size: 12px;
      color: var(--ink-2);
      line-height: 1.5;
      margin: 8px 0 0;
      max-width: 720px;
    }
    ```
  </action>
  <verify>
    <automated>grep -q "quick/260525-ulq" ../sei-website/css/styles.css && grep -q "\.game-name " ../sei-website/css/styles.css && grep -q "\.tm-attr" ../sei-website/css/styles.css && grep -q "\.legal-disclaimer" ../sei-website/css/styles.css</automated>
  </verify>
  <done>styles.css contains the three new classes, all referencing only existing CSS variables (--f, --ink-0/1/2, --border).</done>
</task>

<task type="auto">
  <name>Task 2: Replace minecraft-logo.png + skyrim-logo.png img tags in index.html with typographic wordmarks (F18)</name>
  <files>../sei-website/index.html</files>
  <action>
    In ../sei-website/index.html, replace the two <img class="game-logo …">
    elements (lines ~217 and ~222) with typographic spans wrapped in
    .game-name-wrap so the TM attribution sits directly under each name.

    BEFORE (line ~217):
      <img class="game-logo game-logo--mc" src="img/minecraft-logo.png" alt="Minecraft" width="3602" height="603" loading="lazy" />

    AFTER:
      <span class="game-name-wrap">
        <span class="game-name game-name--mc" role="img" aria-label="Minecraft">MINECRAFT</span>
        <small class="tm-attr">MINECRAFT™ Mojang Synergies AB</small>
      </span>

    BEFORE (line ~222):
      <img class="game-logo game-logo--skyrim" src="img/skyrim-logo.png" alt="Skyrim" width="759" height="236" loading="lazy" />

    AFTER:
      <span class="game-name-wrap">
        <span class="game-name game-name--skyrim" role="img" aria-label="The Elder Scrolls V: Skyrim">SKYRIM</span>
        <small class="tm-attr">SKYRIM® Bethesda Softworks LLC</small>
      </span>

    Do NOT delete the PNG files in ../sei-website/img/. Just remove the
    HTML references. PNGs remain on disk as orphaned artifacts (note in
    SUMMARY so operator can rm later if desired).
  </action>
  <verify>
    <automated>! grep -q "minecraft-logo.png" ../sei-website/index.html && ! grep -q "skyrim-logo.png" ../sei-website/index.html && grep -q "game-name game-name--mc" ../sei-website/index.html && grep -q "game-name game-name--skyrim" ../sei-website/index.html && grep -q "MINECRAFT™ Mojang Synergies AB" ../sei-website/index.html</automated>
  </verify>
  <done>index.html no longer references either PNG; both wordmarks render as Chakra Petch typographic chips with TM attribution adjacent.</done>
</task>

<task type="auto">
  <name>Task 3: Reframe QUEST + PARTY tier pricing copy in index.html (F17)</name>
  <files>../sei-website/index.html</files>
  <action>
    Reword the two tier__desc paragraphs to decouple pricing from
    "Minecraft playtime" framing.

    BEFORE (line ~303 — QUEST tier):
      <p class="tier__desc">Cloud-hosted, no setup. ~2 hours of playtime.</p>

    AFTER:
      <p class="tier__desc">Cloud-hosted Sei AI inference. Token credits sized for ~2 hours of typical companion runtime.</p>

    BEFORE (line ~313 — PARTY tier):
      <p class="tier__desc">Cloud-hosted, no setup. ~10 hours of playtime every month.</p>

    AFTER:
      <p class="tier__desc">Cloud-hosted Sei AI inference. Token credits sized for ~10 hours of typical companion runtime per month.</p>

    Note: pitch.html line 702 ("$20 / month.") is already neutral — no
    "playtime" language to reword there. Confirmed in SUMMARY.
  </action>
  <verify>
    <automated>! grep -qE "hours of playtime|hours of Minecraft" ../sei-website/index.html && grep -q "Cloud-hosted Sei AI inference" ../sei-website/index.html && grep -q "Token credits sized for ~2 hours" ../sei-website/index.html && grep -q "Token credits sized for ~10 hours" ../sei-website/index.html</automated>
  </verify>
  <done>Both QUEST and PARTY tier descriptions frame the offering as AI inference / token credits / runtime — not as Minecraft access.</done>
</task>

<task type="auto">
  <name>Task 4: Add .legal-disclaimer paragraph to marketing footers (F19)</name>
  <files>../sei-website/index.html, ../sei-website/build.html, ../sei-website/terms.html, ../sei-website/privacy.html</files>
  <action>
    Insert a `<p class="legal-disclaimer">…</p>` immediately after the
    existing copyright line in each marketing footer. Single shared
    string across all four pages for consistency.

    Disclaimer text:
      "Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC."

    Insertion points:

    (a) index.html line ~433 (inside `.foot__base`):
        BEFORE:
          <p>© 2026 Sei Studio. · <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p>
        AFTER (append):
          <p>© 2026 Sei Studio. · <a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p>
          <p class="legal-disclaimer">Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.</p>

    (b) build.html line ~215 (inside `.foot__base`):
        BEFORE:
          <p>© 2026 Sei Studio.</p>
        AFTER (append):
          <p>© 2026 Sei Studio.</p>
          <p class="legal-disclaimer">Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.</p>

    (c) terms.html — legal pages use inline styles (no shared
        styles.css). Add an inline-style version inside the
        `.legal__footer` paragraph at line ~328 OR add a sibling <p>.
        Chosen: add a sibling <p> with inline style so we don't depend
        on styles.css (terms.html doesn't load it).

        BEFORE (line ~328):
          <p class="legal__footer">
            Effective 2026-05-26 · <a href="/privacy.html">Privacy Policy</a> · <a href="/">Home</a>
          </p>
        AFTER (append):
          <p class="legal__footer">
            Effective 2026-05-26 · <a href="/privacy.html">Privacy Policy</a> · <a href="/">Home</a>
          </p>
          <p class="legal__footer" style="font-style: italic;">
            Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.
          </p>

    (d) privacy.html line ~200 — same pattern as terms.html (sibling <p>
        with inline italic style):
        AFTER (append):
          <p class="legal__footer" style="font-style: italic;">
            Not affiliated with or endorsed by Mojang Synergies AB or Microsoft Corporation. MINECRAFT is a trademark of Mojang Synergies AB. SKYRIM is a trademark of Bethesda Softworks LLC.
          </p>

    pitch.html (slide deck — no footer, internal-facing) is intentionally
    excluded. Documented in SUMMARY.
  </action>
  <verify>
    <automated>for f in ../sei-website/index.html ../sei-website/build.html ../sei-website/terms.html ../sei-website/privacy.html; do grep -q "Not affiliated with or endorsed by Mojang Synergies AB" "$f" || { echo "MISSING: $f"; exit 1; }; done; echo OK</automated>
  </verify>
  <done>All four marketing-surface footers carry the non-affiliation + TM-acknowledgement disclaimer.</done>
</task>

</tasks>

<verification>
After all 4 tasks:
  1. `grep -c "minecraft-logo.png\|skyrim-logo.png" ../sei-website/index.html` → 0
  2. `grep -c "hours of playtime\|hours of Minecraft" ../sei-website/index.html` → 0
  3. `grep -l "legal-disclaimer\|legal__footer.*italic\|Not affiliated with" ../sei-website/{index,build,terms,privacy}.html` → all 4 files
  4. `ls ../sei-website/img/minecraft-logo.png ../sei-website/img/skyrim-logo.png` → both still exist (preserved, just unreferenced)
  5. Open ../sei-website/index.html in a browser → MINECRAFT and SKYRIM render as typographic chips (Chakra Petch, uppercase, letter-spaced), TM attribution beneath each, footer carries the non-affiliation paragraph.
</verification>

<success_criteria>
- 0 references to img/minecraft-logo.png or img/skyrim-logo.png in any HTML
- 0 references to "hours of playtime" or "hours of Minecraft" in tier copy
- 4/4 marketing footers carry the non-affiliation disclaimer
- PNG files preserved on disk (no `rm`)
- All edits compose with existing Chakra Petch / .tier__note design system
</success_criteria>

<output>
After completion (handled inline by planner-executor):
  - Modify the 6 files listed in `files_modified`
  - Write 260525-ulq-SUMMARY.md to the same quick directory
  - NO sei-repo git commit (target is sei-website which is not a git repo)
</output>
