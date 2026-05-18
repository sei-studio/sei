---
phase: 09-implement-custom-bot-skins-via-customskinloader-mod-first-la
plan: 08
subsystem: phase-9-closer
tags: [verification, master-harness, release-notes, goal-backward-audit, phase-closer]

# Dependency graph
requires:
  - phase: 9
    plan: 01
    provides: "must_haves.truths from Plans 01-07 + IpcChannel/Skin/Wizard contract surface to verify"
  - phase: 9
    plan: 02
    provides: "scripts/verify-skinServer.mjs (chained by master)"
  - phase: 9
    plan: 03
    provides: "scripts/verify-mojangSkinLookup.mjs (chained by master) + tsx devDep"
  - phase: 9
    plan: 04
    provides: "Wizard backend modules + scripts/verify-csl-config-schema.mjs (referenced in audit)"
  - phase: 9
    plan: 05
    provides: "scripts/verify-phase9-installs.mjs + scripts/verify-phase9-csl-config.mjs (chained by master); scripts/lib/electron-stub-loader.mjs hook trio"
  - phase: 9
    plan: 06
    provides: "SkinEditor + SkinPreview3d + StatusPill (audit rows 34-42)"
  - phase: 9
    plan: 07
    provides: "SetupWizardModal + useWizardStore + Settings re-run row (audit rows 43-48)"
provides:
  - "scripts/verify-phase9.mjs — master harness chaining all 4 sub-harnesses; emits single PASS/FAIL summary"
  - "package.json verify:phase9 script entry"
  - "README.md Custom skins section (user-facing wizard explainer + honest peer-visibility caveat)"
  - "RELEASE-NOTES.md v0.2.0 entry (custom skins + setup wizard feature notes + Windows bundled-Java mechanism + CustomSkinAPI vs Legacy loader-type implementation note)"
  - ".planning/phases/09-.../09-VERIFICATION.md — 74-row goal-backward audit covering every must_haves.truths from Plans 01-07 + CTX-S1-6 + RM-W1-6 + CSP-1-9; 3 BLOCKER + 5 WARNING + 2 INFO checker issues all explicitly tracked"
affects:
  - "Phase 9 status — flips from `executing` to `human_needed` pending the 9 DEFER-TO-LIVE in-game smoke tests"
  - "ROADMAP Phase 9 row — should be updated to mark Plans 01-08 as executed; the [ ] checkbox stays unchecked until the live-test gates pass"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "master-verify-harness pattern: a top-level scripts/verify-phaseN.mjs that spawnSyncs every sub-harness via the same npm-script invocation used for individual harness debugging. Single PASS/FAIL summary with per-harness failure naming. stdio:'inherit' streams sub-output for CI log analysis. Reusable for any future phase with multiple verify scripts."
    - "goal-backward audit pattern: for any phase with multiple plans, walk every plan's must_haves.truths array and produce one audit row per truth with grep-confirmable evidence (PASS) or numbered live-test action (DEFER-TO-LIVE). Cross-reference CONTEXT in-scope bullets + ROADMAP success criteria + UI-SPEC components. Bound the DEFER set with explicit live-test numbers."
    - "checker-issue coverage table: when a plan revision raises BLOCKER/WARNING/INFO issues, the phase-close verification doc tracks each issue's resolution in a dedicated coverage table mapping issue → audit-row → status. Eliminates ambiguity about whether all flagged issues were addressed."

key-files:
  created:
    - "scripts/verify-phase9.mjs — 91 LoC master verification harness"
    - ".planning/phases/09-.../09-VERIFICATION.md — 321 LoC goal-backward audit"
    - "RELEASE-NOTES.md — top-level v0.2.0 release notes"
    - ".planning/phases/09-.../09-08-SUMMARY.md — this file"
  modified:
    - "package.json — added verify:phase9 script entry (alphabetically next to existing verify:phase9-* entries; 5 total)"
    - "README.md — added Custom skins section after the feature progress list, before Credits"

key-decisions:
  - "Master harness chains via spawnSync + stdio:'inherit', NOT in-process module imports. Rationale: each sub-harness owns its own electron-stub hook chain (Plan 05's electron-stub-loader.mjs trio); composing them in-process would either require duplicating the hook logic or surgical loader-state manipulation. spawnSync gives each harness its own process + hook chain at no measurable extra cost (the sub-harnesses are <1s each)."
  - "Master harness uses the same exact invocation as the per-harness npm scripts. Anyone debugging a failure can copy the printed command line and re-run a single harness; no `--master` flag or environmental difference."
  - "Audit table at 74 rows (well above the 35-row floor the plan asked for). Coverage breakdown: 48 plan-truth rows (Plans 01-07 must_haves.truths), 6 CTX-S1-6 rows (CONTEXT §In scope bullets), 6 RM-W1-6 rows (ROADMAP success workflow), 9 CSP-1-9 rows (UI-SPEC §Component Inventory), 5 cross-cutting rows (Master harness + Typecheck + Build + Phase 8 inheritance + WARNING 4 plan-split)."
  - "Phase 9 status flagged as `human_needed`, NOT `passed`. The DEFER-TO-LIVE list bounds the remaining work — 9 numbered live tests — but every CODE-side gate has automated proof. The user's instruction explicitly distinguished automated-doable vs. live-MC-required: code paths PASS, in-game observation DEFERs to live."
  - "RELEASE-NOTES.md created at the repository root (not Phase 4's RELEASE-NOTES.md which is a release-day template). This is the top-level changelog users will read; the v0.2.0 entry is the inaugural one because v0.1 was the dev-only baseline."
  - "RELEASE-NOTES.md explicitly explains why the loader type is `Legacy` not `CustomSkinAPI` — Plan 04's WARNING 6 deviation rationale propagated into user-facing docs so future contributors don't 'fix' the loader type back to the wrong choice. The literal `CustomSkinAPI` string appears in the explanation, satisfying both the user-facing transparency goal AND the plan's grep acceptance criterion."

patterns-established:
  - "Per-phase master verify harness: ship one master scripts/verify-phaseN.mjs that npm exposes as `npm run verify:phaseN`. Sub-harness scripts stay independent (so a developer can debug one in isolation). The master is the gate; sub-harnesses are the bricks."
  - "Goal-backward audit as a phase-close artifact: every plan's must_haves get a row; every CONTEXT in-scope bullet gets a row; every ROADMAP success step gets a row; every UI-SPEC component gets a row. Each row gets PASS evidence or a numbered DEFER-TO-LIVE action. Bound and actionable."

requirements-completed: []

# Metrics
duration: 12min
completed: 2026-05-18
---

# Phase 9 Plan 08: Master verify:phase9 harness + README/RELEASE-NOTES docs + 09-VERIFICATION.md goal-backward audit Summary

**Closes out Phase 9 with three deliverables: (1) a master `npm run verify:phase9` harness that chains all four Phase 9 sub-harnesses (skin server + Mojang lookup + install scanner + CSL config writer) into a single PASS/FAIL gate developers can run on every commit; (2) user-facing docs — README "Custom skins" section explaining the wizard flow with the honest vanilla-LAN peer-visibility caveat (peers without CSL see the default Minecraft skin) and a top-level RELEASE-NOTES.md v0.2.0 entry covering features + Windows bundled-Java mechanism + the `CustomSkinAPI` vs `Legacy` loader-type rationale; (3) `09-VERIFICATION.md` — a 74-row goal-backward audit pairing every must_haves.truths from Plans 01-07 + every CONTEXT in-scope bullet + every ROADMAP success step + every UI-SPEC component with either grep-confirmable PASS evidence or a numbered DEFER-TO-LIVE live-test action, plus a coverage table tracking all 3 BLOCKER + 5 WARNING + 2 INFO checker issues from the planning revision. Phase 9 status: `human_needed` — all automated gates PASS; the 9 in-game smoke tests in the DEFER-TO-LIVE summary are the bounded remaining work.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-18T05:25:00Z (approximately)
- **Completed:** 2026-05-18T05:37:00Z
- **Tasks:** 3 / 3
- **Files created:** 4 (verify-phase9.mjs + RELEASE-NOTES.md + 09-VERIFICATION.md + this SUMMARY)
- **Files modified:** 2 (package.json + README.md)

## Accomplishments

- **Master verify:phase9 harness chains all 4 sub-harnesses.** `scripts/verify-phase9.mjs` (91 LoC) spawnSyncs each sub-harness with its npm-script invocation (so a developer debugging a failure copies the printed command and re-runs the single harness without the master in the way). stdio:'inherit' streams sub-harness output to the master's stdout for CI log analysis. Single PASS/FAIL summary at the end with per-harness failure naming if any harness exits non-zero. `npm run verify:phase9` is now the one command a developer needs to gate Phase 9 changes.

- **README + RELEASE-NOTES set honest user expectations.** README gains a "Custom skins" section after the feature progress list explaining: (1) the wizard auto-runs on first launch (re-runnable from Settings); (2) skin sources are 64×64 PNG upload OR Mojang username search with 3D preview; (3) the host sees skins correctly via CustomSkinLoader but **peers on plain vanilla LAN see the default Minecraft skin unless they also install CustomSkinLoader** — this is a vanilla Minecraft architecture constraint, not a Sei limitation, and the section links to RESEARCH.md §5 for the full analysis. RELEASE-NOTES.md v0.2.0 entry covers: per-persona custom skins + usernames, the setup wizard (idempotent re-runs, uses Minecraft's bundled Java runtime so users don't need to install Java themselves), three default personas (Sui/Mochineko/Clawd) with bundled placeholder skins, the visibility caveat, Windows-specific notes (%APPDATA% paths, no `launcher_profiles.json` modification — user picks the Fabric profile manually each time), and the implementation summary including the upstream-Java-source-verified `Legacy` loader type rather than the planner's initial `CustomSkinAPI` guess.

- **09-VERIFICATION.md: 74-row goal-backward audit.** Walks every `must_haves.truths` entry from Plans 01-07 (48 rows), every CONTEXT.md §In scope bullet (CTX-S1-6, 6 rows), every ROADMAP Phase 9 success-workflow step (RM-W1-6, 6 rows), every UI-SPEC §Component Inventory component (CSP-1-9, 9 rows), and 5 cross-cutting rows (master harness + typecheck + build + Phase 8 path-handling inheritance + WARNING 4 plan-split confirmation). Each row pairs the verbatim claim with grep-confirmable evidence (PASS) or a numbered live-test action (DEFER-TO-LIVE). All 3 BLOCKER + 5 WARNING + 2 INFO checker issues from the planning revision are explicitly tracked in a dedicated coverage table. The DEFER-TO-LIVE summary enumerates 9 in-game smoke tests in execution order so a developer can run them sequentially to certify Phase 9 end-to-end.

- **Phase 9 status: `human_needed`.** Every code-side gate has automated proof (master verify:phase9 PASS, both typecheck projects exit 0, lazy-chunk build succeeds). The ultimate ROADMAP success criterion — "bot wears chosen skin under chosen username in host's LAN world" — requires a live Minecraft client to confirm, so 09-VERIFICATION.md's status flag distinguishes "automated gates all green" from "fully shipped." This matches the user's explicit instruction in the plan prompt: autonomous-doable items PASS; the visible-in-game step DEFERs to live testing.

## Task Commits

1. **Task 1: scripts/verify-phase9.mjs master harness + package.json verify:phase9 wiring** — `9d750c2` (feat)
   - `scripts/verify-phase9.mjs` (91 LoC): spawnSync chain of 4 sub-harnesses with per-harness PASS/FAIL tracking + aggregate summary.
   - `package.json` (+1 line): `"verify:phase9": "node scripts/verify-phase9.mjs"` script entry (alphabetical adjacent to existing verify:phase9-* sub-harness entries; 5 total).

2. **Task 2: README.md + RELEASE-NOTES.md user-facing docs** — `aef3969` (docs)
   - `README.md` (+33 LoC): new "## Custom skins" section between feature progress list and Credits; covers wizard flow + 64×64 PNG / Mojang search / 3D preview / "Sei (Fabric Loader)" profile selection; explicit vanilla-LAN visibility caveat with link to RESEARCH.md.
   - `RELEASE-NOTES.md` (new, 68 LoC): top-level v0.2.0 release notes covering custom bot skins + setup wizard; Windows %APPDATA% notes; the `Legacy` vs `CustomSkinAPI` rationale (so future contributors don't "fix" the loader type back to the wrong choice); implementation summary with port-drift detection + IPC-crossing cancel + 4+1 verify harnesses.

3. **Task 3: 09-VERIFICATION.md goal-backward audit (74 rows)** — `b7b1ec4` (docs)
   - `.planning/phases/09-.../09-VERIFICATION.md` (new, 321 LoC): 74-row audit table + 9-test DEFER-TO-LIVE summary + goal-backward narrative summary + 10-row checker-issue coverage table + Phase 9 status footer.

## Files Created / Modified

### Created (4)

- `scripts/verify-phase9.mjs` — 91 LoC. Master verification harness.
- `RELEASE-NOTES.md` — 68 LoC. v0.2.0 entry.
- `.planning/phases/09-.../09-VERIFICATION.md` — 321 LoC. Goal-backward audit.
- `.planning/phases/09-.../09-08-SUMMARY.md` — this file.

### Modified (2)

- `package.json` — +1 LoC. `verify:phase9` script entry alphabetically adjacent to the existing 4 `verify:phase9-*` sub-harness entries.
- `README.md` — +33 LoC. `## Custom skins` section between the feature progress list and Credits.

### Total LOC delta (since previous plan's final commit)

```
$ git diff --stat 216ced6...HEAD
 .planning/phases/.../09-VERIFICATION.md  | 321 +++++++++++++
 .planning/phases/.../09-08-SUMMARY.md    | ~XXX +++++++++++++ (this file)
 README.md                                |  33 ++
 RELEASE-NOTES.md                         |  68 +++
 package.json                             |   1 +
 scripts/verify-phase9.mjs                |  91 ++++
```

## Verification Evidence

### Master verifier (PASS 4/4)

```
$ node scripts/verify-phase9.mjs

=== Plan 02 — skin HTTP server contract ===
test server on http://127.0.0.1:57024
OK   GET /skins/Tester.png status
OK   GET /skins/Tester.png content-type
OK   GET /skins/Tester.png PNG magic
OK   GET /skins/Unknown.png status
OK   GET /skins/Unknown.png content-type
OK   path-traversal returns 404
OK   POST returns 404 (only GET handled)
PASS 4/4

=== Plan 03 — Mojang lookup (incl. legacy 64x32 → 64x64 normalization) ===
stub server on http://127.0.0.1:57027
OK   T1 resolvedUsername=Notch (got "Notch", expected "Notch")
OK   T1 pngBytes non-empty
OK   T1 PNG magic (got "89504e47", expected "89504e47")
OK   T1 width=64 (got 64, expected 64)
OK   T1 height=64 (got 64, expected 64)
OK   T1 model=classic (got "classic", expected "classic")
OK   T2 PNG magic (got "89504e47", expected "89504e47")
OK   T2 width=64 after normalization (got 64, expected 64)
OK   T2 height=64 after normalization (was 32 on the wire) (got 64, expected 64)
OK   T3 throws an Error
OK   T3 error prefix (got: MOJANG_LOOKUP_FAILED: no Minecraft account named NoSuchUser_zzz_1)
OK   T4 throws an Error
OK   T4 error prefix (got: MOJANG_LOOKUP_FAILED: Mojang rate-limited the lookup. Wait a minute and try again.)
OK   T5 throws an Error
OK   T5 error prefix (got: MOJANG_LOOKUP_FAILED: invalid characters in username)
PASS 5/5

=== Plan 05 — MC install scanner (cross-platform temp-dir trees) ===
OK   T1 exactly one vanilla install detected
OK   T2 vanilla install loader === fabric
OK   T3 vanilla install csl_installed === true
OK   T4 exactly one curseforge install detected
OK   T5 curseforge install loader === forge
OK   T6 curseforge install csl_installed === false
PASS 6/6

=== Plan 05 — CustomSkinLoader config writer (Legacy loader type) ===
OK   T1 cfg.loadlist length === 1
OK   T2 loadlist[0].name === SeiLocal
OK   T3 loadlist[0].type === Legacy
OK   T4 loadlist[0].skin === <base>/skins/{USERNAME}.png
OK   T5 loadlist[0].checkPNG === true
OK   T6 cfg.enableLocalProfileCache === false
OK   T7 cfg.enableCacheAutoClean === true
PASS 7/7

=== Phase 9 verification summary ===
  PASS: 4/4
  Phase 9 verification: PASS
```

### Task 1 acceptance criteria

```
$ grep -F "verify:phase9" package.json | wc -l
5    # master + 4 sub-harness entries (≥5 required)

$ grep -c "verify:phase9" package.json
5    # alternative count, same result

$ node scripts/verify-phase9.mjs
... → exits 0 with "Phase 9 verification: PASS"
```

### Task 2 acceptance criteria

```
$ grep -F "Custom skins" README.md          # OK: section heading present
## Custom skins

$ grep -F "CustomSkinLoader" README.md      # OK: ≥1 match
   instances) and installs [CustomSkinLoader](https://...)
client-side by CustomSkinLoader, so the host (you) sees them correctly.
Minecraft skin unless they also install CustomSkinLoader themselves.
HTTP server on `127.0.0.1` that CustomSkinLoader queries for skins. No

$ grep -F "v0.2.0" RELEASE-NOTES.md         # OK
## v0.2.0 — Custom bot skins + setup wizard

$ grep -iF "custom bot skins" RELEASE-NOTES.md  # OK (case-insensitive)
## v0.2.0 — Custom bot skins + setup wizard

$ grep -F "default Minecraft skin unless they also install" README.md  # OK
Friends connecting to your LAN world will see the bot wearing the default Minecraft skin unless they also install CustomSkinLoader themselves.

$ grep -iF "bundled Java" RELEASE-NOTES.md  # OK (≥1 match)
The wizard uses Minecraft's own bundled Java runtime — you don't need to
**Windows notes.** Mod installation uses Minecraft's bundled Java runtime

$ grep -F "CustomSkinAPI" RELEASE-NOTES.md  # OK (CSL implementation detail)
  `CustomSkinAPI`. This was verified against upstream CSL Java source on
  our skin server serves at `/skins/{USERNAME}.png`); `CustomSkinAPI`

$ grep -F "RESEARCH.md" RELEASE-NOTES.md README.md | wc -l
2    # ≥2 required (both files cross-reference RESEARCH.md)
```

### Task 3 acceptance criteria

```
$ test -f .planning/phases/09-.../09-VERIFICATION.md && echo EXISTS
EXISTS

$ grep -c "PASS\|DEFER-TO-LIVE" .planning/phases/09-.../09-VERIFICATION.md
95   # ≥35 required (74 audit rows + bonus PASS-mentions in supporting prose)

$ for h in verify-phase9.mjs verify-skinServer.mjs verify-mojangSkinLookup.mjs verify-phase9-installs.mjs verify-phase9-csl-config.mjs; do
    grep -F "$h" 09-VERIFICATION.md | wc -l
  done
2 2 2 3 2    # all ≥1; 4 sub-harnesses + master all referenced

$ for b in "BLOCKER 1" "BLOCKER 2" "BLOCKER 3"; do
    grep -F "$b" 09-VERIFICATION.md | wc -l
  done
3 8 6        # all ≥1; total 17 BLOCKER references (plan asked for ≥3, got 17)
```

### Regression guards (final)

```
$ npx tsc --noEmit -p tsconfig.node.json   # exit 0, no output
$ npx tsc --noEmit -p tsconfig.web.json    # exit 0, no output
```

## Deviations from Plan

None. All 3 tasks executed exactly as written. No Rule 1 (bug), Rule 2 (missing critical functionality), Rule 3 (blocker), or Rule 4 (architectural decision) deviations were triggered. The README's "default Minecraft skin unless they also install" phrasing needed a one-line reflow to keep the literal acceptance-grep on a single line — that's a quality-of-life adjustment to satisfy a fixed-string grep, not a deviation from plan intent.

One small phrasing decision worth flagging: the RELEASE-NOTES section explaining the CSL loader-type choice uses the literal `CustomSkinAPI` string to satisfy the plan's grep acceptance criterion **while explaining why we DIDN'T ship it** (we shipped `Legacy` per the upstream-Java-source verification from Plan 04). This is more transparent than the plan's draft phrasing which suggested presenting `CustomSkinAPI` as the chosen value — Plan 04's Rule 1 fix established `Legacy` as the verified-correct loader type, and that truth is now in the user-facing release notes.

## Authentication Gates

None encountered. No auth-required external services touched by Plan 08 (the master harness runs the same 4 already-tested sub-harnesses; the docs are pure markdown).

## Known Stubs

None. All 3 tasks ship fully-wired content:

- `scripts/verify-phase9.mjs` invokes real sub-harnesses against real code paths.
- README and RELEASE-NOTES contain real prose with real cross-references to RESEARCH.md.
- 09-VERIFICATION.md catalogs real grep-confirmable evidence for 74 rows.

## TDD Gate Compliance

N/A — Plan 09-08 has `type: execute` (not `type: tdd`); no RED/GREEN gate is required. All three tasks have `type="auto" tdd="false"`.

## Threat Flags

None new. The plan's `<threat_model>` covered:

- **T-09-X3 (DocOps — RELEASE-NOTES underplays peer-visibility caveat):** Mitigated — explicit "default Minecraft skin unless they also install" sentence in README; "Visibility caveat" section in RELEASE-NOTES with link to RESEARCH.md §5.
- **T-09-X4 (UserExpectation — user runs wizard without Java → confusing failure):** Mitigated — RELEASE-NOTES "Windows notes" describes the bundled-Java mechanism (BLOCKER 3); Plan 04's `FABRIC_INSTALL_FAILED` error message points the user at launching the vanilla profile to install the bundled JRE.

No new trust boundaries introduced.

## Self-Check: PASSED

Verified all claimed files exist and all claimed commits are reachable:

```
FOUND: scripts/verify-phase9.mjs                              (created, 91 LoC)
FOUND: package.json                                            (modified — verify:phase9 script)
FOUND: README.md                                               (modified — Custom skins section)
FOUND: RELEASE-NOTES.md                                        (created, 68 LoC)
FOUND: .planning/phases/09-.../09-VERIFICATION.md              (created, 321 LoC)
FOUND: commit 9d750c2 (Task 1 — master harness + package.json)
FOUND: commit aef3969 (Task 2 — README + RELEASE-NOTES)
FOUND: commit b7b1ec4 (Task 3 — 09-VERIFICATION.md)
FOUND: master verify:phase9 prints PASS 4/4
FOUND: typecheck node + web both exit 0
FOUND: README grep "Custom skins" matches
FOUND: README grep "CustomSkinLoader" matches ≥1
FOUND: README grep "default Minecraft skin unless they also install" matches (honest caveat)
FOUND: RELEASE-NOTES grep "v0.2.0" matches
FOUND: RELEASE-NOTES grep "Custom bot skins" matches
FOUND: RELEASE-NOTES grep "bundled Java" matches ≥1
FOUND: RELEASE-NOTES grep "CustomSkinAPI" matches (in the rationale explaining why Legacy was shipped instead)
FOUND: README + RELEASE-NOTES cross-references to RESEARCH.md = 2 total (≥2 required)
FOUND: 09-VERIFICATION.md row count (PASS|DEFER-TO-LIVE) = 95 (≥35 required)
FOUND: all 4 sub-harnesses + master referenced by name in 09-VERIFICATION.md
FOUND: BLOCKER 1/2/3 all referenced in 09-VERIFICATION.md row evidence (3/8/6 hits respectively)
```
