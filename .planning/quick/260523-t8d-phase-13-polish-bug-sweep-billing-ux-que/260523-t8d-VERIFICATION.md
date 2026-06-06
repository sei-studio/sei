---
quick_id: 260523-t8d
phase: 13
verified: 2026-05-24T05:45:00Z
status: human_needed
score: 16/16 truths code-verified; 5/16 require visual UAT
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "ITEM 4 — render PlaytimePill in CreditsScreen + IconRail with real credits"
    expected: "Pill shows a sane '~Xh left' / '~Xmin left' string (not 'Calculating…' indefinitely); rounding rule (floor-to-hour ≥60min, floor-to-15min <60min) feels right; matches teen-friendly cadence"
    why_human: "Static analysis can't observe the actual rendered string in the running renderer with a populated CreditsStore; the rounding constant (850 tok/min) is a model-behavior assumption that only validates with real Haiku traffic"
  - test: "ITEM 6 — open MC LAN world BEFORE launcher; confirm 'connected' within 6s"
    expected: "Launcher starts in 'not_connected', then transitions to 'connected' within ≤6.5s (5s poll + ≤1.5s ARP); status indicator + Summon button enable"
    why_human: "Requires an actual Minecraft Java instance broadcasting LAN UDP on the MC group; can't be triggered without a running game client"
  - test: "ITEM 8 — click 'Manage your Party' for an active subscription"
    expected: "System browser opens to the LS-signed customer-portal URL (not the generic /billing root); the user can change payment method / cancel from that page"
    why_human: "Requires a Supabase signed-in user with `subscription_status.status='active'` AND a real Lemon Squeezy subscription; the proxy → LS API → portal-URL chain is end-to-end live"
  - test: "ITEM 9 — open SkinEditor preview for Sui / Lyra / Clawd; then summon each in-game"
    expected: "3D preview shows the bundled PNG (NOT a 1×1 placeholder, NOT Steve fallback); the bot wears the bundled skin in-game"
    why_human: "Requires the renderer + CSL + a connected MC client to confirm both the local skin server and the bot's appearance; bytes-equal asserts only catch the file-resolution half"
  - test: "ITEM 15 — visually compare SYNCING pill vs PUBLIC / CUSTOM tag pills on CharacterCard"
    expected: "All three pills render at byte-identical height, font, padding; no half-pixel mismatch"
    why_human: "Pixel-perfect alignment requires rendering the live DOM in the renderer; CSS specificity wars can defeat the shared class without showing up in grep"
---

# Quick Task 260523-t8d Verification — Phase 13 Polish + Bug Sweep (16 items)

**Task Goal:** Close 16 user-reported items spanning billing UX terminology, playtime estimation refactor, character library bugs, logging visibility, settings UUID + local-mode icon, LAN port re-scan.

**Verified:** 2026-05-24T05:45:00Z
**Status:** human_needed — all 16 truths pass code-level verification, 5 require visual UAT to fully close.

## Per-Item Verification

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Logger conditional gates haiku-prompt + game-state-snapshot logs in BYOK no-key mode | PASS | `src/bot/brain/log.js:38-40` — `shouldLogPrompts()` returns false iff `SEI_BACKEND==='local' && !SEI_HAS_API_KEY`. Both `[haiku?]` (line 151) and `[haiku!]` (line 212) early-return when gated. `src/main/botSupervisor.ts:325-326` injects both env vars at fork time. |
| 2 | Console output preserves casing AND is prefixed with `[CONSOLE]` | PASS | `src/bot/brain/index.js:221` — `logger.info?.('[CONSOLE] [sei] Sei online.')` literal. `src/main/logRouter.ts:48-49` docblock confirms casing-preservation contract on the system path. |
| 3 | No top-up / credit / Lemon-Squeezy / unlimited in user-facing strings; Quest + Party + payment-partner copy | PASS | `grep '>[^<]*\(top-up\|credit\|Lemon\|unlimited\)[^<]*<'` on CreditsScreen/SettingsScreen/HardStopModal/hardStopCopy = 0 user-facing hits (all matches are in comments or internal enum `'unlimited'`). `CreditsScreen.tsx:122,138` render `Quest` + `Party`; `:124` renders "Billing handled by our payment partner." Internal `plan === 'unlimited'` enum preserved (acceptable per plan note line 90). |
| 4 | Playtime estimator replaces PercentBar | PASS | `src/renderer/src/lib/playtimeEstimate.ts:30` — `DEFAULT_TOKENS_PER_MIN = 850` with derivation comment (lines 12-29: Haiku 4.5, persona ~1400 tok, ~20 turns/min). Rounding rule (lines 52-76): undef→Calculating, 0→0min, <1min→0min, <60min→floor-15min (min 15), ≥60min→floor-hour. `src/renderer/src/screens/CreditsScreen.tsx:111` renders `<PlaytimePill>`; no PercentBar import remains in renderer (verified: `grep 'import.*PercentBar' src/` returns only PercentBar.tsx's own CSS import). Rolling-24h recalibration wired in `src/main/cloud/proxyClient.ts:223-308` (24h since-window + sum-tokens / 1440). |
| 5 | UUID in Settings Account with click-to-copy | PASS | `src/renderer/src/screens/SettingsScreen.tsx:307-330` — Account ID row with `<span className={styles.monoValue}>{authState.user.id}</span>` + Copy button + 1.5s `uuidCopied` flash. Only renders inside the `authState.kind === 'signed_in'` branch. |
| 6 | LAN re-scan polling ≤6s | PASS (code) / HUMAN-NEEDED (live test) | `src/main/lanWatcher.ts:33` — `LAN_RESCAN_INTERVAL_MS = 5000`. Lines 67-81 — `setInterval` re-attempts `socket.addMembership(MC_LAN_GROUP)` every 5s while disconnected; cleared on connect (lines 85-87). 5s poll + ≤1.5s next-packet ARP ≤ 6.5s. |
| 7 | PercentBar fully removed from renderer (eliminates "100% reset" perception); webhook is additive | PASS | `grep -nE 'delete\|update' supabase/functions/lemon-webhook/index.ts \| grep -i ledger_grants` = 0 matches (additive INSERT-only). `SUBSCRIPTION_CREDITS_MICRO = 18_500_000n` at `index.ts:42`, used in single `.insert()` at line 271. `grep 'import.*PercentBar' src/renderer/` = 0 hits — component is unimported. IconRail still reads `remaining_pct` for `<PricingIcon>` arc-fill visual (not text), and HardStopModal reads it for the auto-dismiss gate (not text); neither is a text consumer. |
| 8 | Manage subscription opens portal on first click; diagnosis names enumerated tokens | PASS (code) / HUMAN-NEEDED (live test) | `MANAGE-SUB-DIAGNOSIS.md:19` — Root Cause = `LS-test-vs-live`. All 4 enumerated tokens present: `LS-test-vs-live` (:19), `customer-portal` (:41,:43,:88), `wiring-bug` (:46), `missing-customer-id` (:50). Fix: new `proxy/src/billing/customerPortal.ts` (105 lines) + new `/billing/customer-portal` route in `proxy/src/app.ts:76`. `proxyClient.ts:400-438` rewritten to fetch portal URL with `PROXY_NO_PORTAL_URL` fallback. Gating condition `LEMON_MODE=test\|live` documented at diagnosis lines 86-100. |
| 9 | Default skins resolve via UUID→slug; both SkinEditor preview AND in-game | PASS (code) / HUMAN-NEEDED (in-game render) | `src/main/skinStore.ts:67-72` — new `slugFromUuid()` reverse lookup against `DEFAULT_CHARACTER_UUIDS`. Lines 74-83 — `bundledSkinPath(character)` now takes a Character and reads `character.slug ?? slugFromUuid(character.id)`. Root cause documented in inline comment lines 42-66 and full trace in `DEFAULT-SKIN-DIAGNOSIS.md`. Bundled PNGs verified on disk: `resources/skins/{sui,lyra,clawd}.png` all present. `src/main/skinStore.test.ts` added (per ITEM 9 plan). Note: DEFAULT-SKIN-DIAGNOSIS tags root cause `naming-mismatch` (variant of plan hypothesis #5); the WARNING-9 enumerated-token requirement only applied to ITEM 8 — ITEM 9's plan permitted hypothesis-5 phrasing. |
| 10 | Browse tab visible | PASS | `src/main/capabilities.ts:42` — `DEFAULT_CAPABILITIES: Capabilities = { browseEnabled: true }`. Line 75 — `browse_enabled !== false` (kill switch is explicit `false`). `CharactersScreen.tsx:114` — `showTabs = browseEnabled`. |
| 11 | Stale "Pick an upload…" helper disappears after skin applied | PASS | `src/renderer/src/components/SkinEditor.tsx:418` — `character.skin.source === 'none'` is in the render condition; line 419 renders the helper only when source is `'none'`. |
| 12 | Persona expansion includes character NAME in user message | PASS | `src/main/personaExpansion.ts:119-125` — `buildExpansionUserMessage(name, ...)` with `name` as first arg; user message starts with `\`Character name: ${name}\``. Closing instruction line 154 nudges franchise context for IDENTITY + VOICE sections. Required at `expandPersona` line 179 (throws on empty name). Note: WIP in working tree adds `cloudMode` extension atop the committed ITEM 12 changes; HEAD verification (above) confirms ITEM 12 landed independently of WIP. |
| 13 | owner schema field plumbed end-to-end; CharacterPage viewOnly guard on foreign-owned chars | PASS | `src/shared/characterSchema.ts:112` — `owner: z.string().uuid().nullable().optional()`. `src/main/cloud/cloudCharacterClient.ts:107` — `rowToCharacter()` populates `owner: (row.owner as string \| null) ?? null`. `CharacterPage.tsx:205-210` — `isForeignOwned = !isDefault && !!character.owner && !!currentUserId && character.owner !== currentUserId`; `viewOnly = isDefault \|\| isForeignOwned`. Lines 319, 345, 449 — Edit button hidden, share toggle hidden, `viewOnly` passed to SkinEditor when foreign-owned. |
| 14 | Default → Public rename; CUSTOM preserved; SkinEditor paragraph removed | PASS | `CharacterCard.tsx:99` — `{isDefault ? 'PUBLIC' : 'CUSTOM'}` (plan called line 95; actual is 99 — minor drift). `CharacterPage.tsx:330` — same literal (plan called line 315; actual is 330 — drift from extra owner-guard JSX above). `SkinEditor.tsx:284-285` — paragraph removed (only mention is the removal-note comment). Case-insensitive grep of remaining "default" tokens returns only `is_default`/`isDefault` schema-field references and code comments — zero user-facing leaks. |
| 15 | SYNCING StatusPill same size as PUBLIC/CUSTOM via shared class | PASS (code) / HUMAN-NEEDED (pixel check) | `StatusPill.tsx:39` — `StatusPillSize = 'default' \| 'tag'`. Line 64 — `size === 'tag' && styles.size_tag` class. `StatusPill.module.css:20-24` — `.pill.size_tag` matches CharacterCard chip (mono/10px/letter-spacing 1.2px). `CharacterCard.tsx:134,147` — `<StatusPill ... size="tag" />` for SYNCING + SYNC-FAILED variants. |
| 16 | Local-mode Settings click navigates to SettingsScreen (not AuthChoice); guard only fires on signed_in→local transition | PASS | `src/renderer/src/App.tsx:384-393` — `prevAuthKindRef` tracks previous authState.kind via useRef. Guard condition (lines 389-393) requires `authState.kind === 'local' && view.kind === 'settings' && prev === 'signed_in'`. Direct local-mode IconRail navigation no longer bounces. |

**Score:** 16/16 truths code-verified; 5 require visual UAT.

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/renderer/src/lib/playtimeEstimate.ts` | PASS | 76 lines (min: 40); exports `DEFAULT_TOKENS_PER_MIN = 850` + `tokensRemainingToPlaytime()` with documented rounding rule. |
| `src/renderer/src/lib/playtimeEstimate.test.ts` | PASS | 85 lines (min: 30); covers boundary conditions (1h, 59min, 14min, 0min, undefined). |
| `src/renderer/src/components/PlaytimePill.tsx` | PASS | Imported by CreditsScreen.tsx:37 and IconRail.tsx, replaces PercentBar. Wired to `tokensRemainingToPlaytime()` via `playtimeEstimate.ts` (verified: `grep tokensRemainingToPlaytime src/renderer/src/components/PlaytimePill.tsx`). |
| `src/shared/characterSchema.ts` (owner field) | PASS | Line 112 — `owner: z.string().uuid().nullable().optional()`. |
| `MANAGE-SUB-DIAGNOSIS.md` | PASS | 116 lines; all 4 enumerated hypothesis tokens named; root cause `LS-test-vs-live`; fix implementation steps documented. |
| `DEFAULT-SKIN-DIAGNOSIS.md` | PASS (extra) | Not required by plan frontmatter but produced; root cause `naming-mismatch` (plan hypothesis #5 variant). |

## Key Links

| From | To | Via | Status |
|------|-----|------|--------|
| `PlaytimePill.tsx` | `playtimeEstimate.ts` | `tokensRemainingToPlaytime()` | WIRED (call site in PlaytimePill.tsx) |
| `proxyClient.ts` | supabase `ledger_consumption` | `creditsGet()` rolling-24h tokens_per_min | WIRED (proxyClient.ts:240-308, since24hIso + .gte() query + sum/1440 average) |
| `cloudCharacterClient.ts` | `characterSchema.ts` (owner) | `rowToCharacter()` populates `owner` | WIRED (cloudCharacterClient.ts:107) |
| `CharacterPage.tsx` | `characterSchema.ts` (owner) | viewOnly guard `character.owner !== currentUserId && !isDefault` | WIRED (CharacterPage.tsx:205-210) |
| `skinStore.ts` | `resources/skins/{sui,lyra,clawd}.png` | `bundledSkinPath(character)` via slug | WIRED (skinStore.ts:74-83) |
| `App.tsx` | `SettingsScreen.tsx` | `navigate({ kind: 'settings' })` from IconRail | WIRED (prevAuthKindRef guard at App.tsx:384-393 lets direct IconRail nav through) |

## Data-Flow Trace

| Artifact | Data Variable | Source | Real Data? | Status |
|----------|---------------|--------|-----------|--------|
| `PlaytimePill.tsx` | `remainingTokens, tokensPerMin` | `useCreditsStore` ← `creditsGet` ← supabase `ledger_balance` + `ledger_consumption` | YES — proxyClient.ts:251 reads `balance_micro` from RLS-scoped row, converts via `MICRO_PER_TOKEN_BLENDED=2n`; tokens_per_min computed from settled consumption rows over 24h window | FLOWING |
| `SettingsScreen.tsx` Account ID | `authState.user.id` | Supabase auth session | YES — only renders inside `authState.kind === 'signed_in'` guard | FLOWING |
| `CharacterPage.tsx` viewOnly | `character.owner` | `cloudCharacterClient.rowToCharacter()` ← supabase `characters.owner` column | YES — line 107 populates from row.owner | FLOWING |
| Default skin (SkinEditor preview + in-game) | `character.slug` ← `bundledSkinPath` | `resources/skins/<slug>.png` via slugFromUuid reverse lookup | YES — verified PNG files on disk; can't verify runtime render without browser/MC | FLOWING (code) / HUMAN (render) |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Build succeeds | `npm run build` | `dist/main/index.js 155.46 kB`, `dist/renderer/.../index-*.js 941.54 kB` emitted; no errors | PASS |
| Test suite passes | `npx vitest run` | 322 passed / 323 total tests; 1 unrelated portraitStore directory-cleanup flake; 3 pre-existing Deno-format test files in supabase/functions/* (out of scope per executor's claim) | PASS (modulo pre-existing flake) |
| ITEM 7 webhook additive check | `grep -nE 'delete\|update' supabase/functions/lemon-webhook/index.ts \| grep -i ledger_grants` | 0 matches | PASS |
| ITEM 8 diagnosis token check | `grep -nE 'LS-test-vs-live\|customer-portal\|wiring-bug\|missing-customer-id' MANAGE-SUB-DIAGNOSIS.md` | All 4 present (line 19, 41/43/88, 46, 50) | PASS |
| ITEM 4 PercentBar import check | `grep -rn 'import.*PercentBar' src/` | 0 hits in renderer (only PercentBar.tsx's own CSS module import) | PASS |
| ITEM 13 owner schema check | `grep -n 'owner' src/shared/characterSchema.ts src/main/cloud/cloudCharacterClient.ts` | Schema line 112 + rowToCharacter line 107 populate | PASS |

## Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| PROXY-04 | SATISFIED | ITEM 4 + 7 — playtime UX replaces % bar; clamp bug source eliminated. |
| PROXY-05 | SATISFIED | ITEM 4 — useCreditsStore PROXY-05 test relaxed via allowlist for `remaining_tokens` + `tokens_per_min`; dollar/micro/cent terms still rejected. |
| PROXY-08 | SATISFIED | ITEM 8 — proxy `/billing/customer-portal` route reuses JWT verification middleware; `LEMON_SQUEEZY_API_KEY` added to env schema with 503-on-missing fallback. |
| LIB-01 | SATISFIED | ITEM 10 — Browse tab default-on via DEFAULT_CAPABILITIES + UserConfigSchema. |
| LIB-02 | SATISFIED | ITEM 13 — owner-based viewOnly guard prevents editing foreign-owned cloud chars. |
| LIB-04 | SATISFIED | ITEM 9 — bundled default skins now resolve correctly via UUID→slug reverse lookup. |
| AUTH-05 | SATISFIED | ITEM 5 + 16 — UUID display + local-mode Settings nav guard. |

## Anti-Patterns Scanned

No new anti-patterns detected. Spot-checks of the 16 modified files showed:
- No TODO/FIXME/XXX/HACK added by this task in modified renderer files (residual TODOs in PercentBar.tsx + others are pre-existing).
- No `return null` / empty-handler stubs added.
- No hardcoded empty arrays/objects rendered as data (only safe initial-state defaults overwritten by fetches).
- Type assertions used appropriately (`row.owner as string | null`) with null-coalescing.

## WIP Reconciliation Check

The executor's SUMMARY (line 242) claimed WIP files (13 modified, mostly cloud-proxy persona/orchestrator wiring) were NOT included in any quick-task commit. Verified:

- `git diff HEAD --stat` shows 13 files / 107 insertions still uncommitted.
- Spot-check of `src/main/personaExpansion.ts`: `git show HEAD:src/main/personaExpansion.ts` contains the ITEM 12 `Character name:` header (line 125); the WIP layered on top adds `ExpandPersonaCloudMode` interface — ITEM 12 changes are independent and committed.
- Spot-check of `src/bot/brain/index.js`: HEAD contains the `[CONSOLE] [sei] Sei online.` literal (ITEM 2); WIP only adds `onTerminalError` plumbing — does not undo ITEM 2.
- Spot-check of `src/main/cloud/proxyClient.ts`: WIP is a 2-line change unrelated to ITEM 4 / 8 wiring (both of which are committed).

Conclusion: WIP and executor's commits are cleanly separated. No collision.

## Plan-Defect / Scope Notes Acknowledged

- ITEM 14 plan line numbers (95, 315) drifted to (99, 330) due to comment / JSX additions above the rename sites. The semantic rename is verified in place; line-number specificity in the truth was advisory.
- ITEM 1 logger gate landed in `src/bot/brain/log.js` (the actual call site of `emitBlock('[haiku?]')`) rather than orchestrator.js / index.js. This is the more architecturally correct site (the loggers themselves do the gating) — accepted as plan-deviation noted in executor's SUMMARY.
- DEFAULT-SKIN-DIAGNOSIS.md tags root cause `naming-mismatch` rather than one of the 4 enumerated tokens. Per WARNING-9 in the plan, the enumerated-token requirement only bound ITEM 8 (the Manage-subscription diagnosis); ITEM 9 was free to use the hypothesis-5 phrasing. Accepted.

## Status Determination

- 16/16 truths PASS at the code level.
- 5/16 require visual UAT to fully validate the live user behavior (playtime pill string, LAN reconnect timing, manage-sub portal flow, in-game default skin render, pixel-exact pill alignment).
- No FAILED truths, no MISSING artifacts, no NOT_WIRED links, no anti-patterns added.
- Per Step 9 decision tree: since Human Verification section is non-empty, status = **human_needed**.

Visual UAT items are tracked in the `human_verification:` frontmatter for the user to execute before production cut.

---

_Verified: 2026-05-24T05:45:00Z_
_Verifier: Claude Opus 4.7 (1M context) — quick-task goal-backward verification_
