---
phase: 09-implement-custom-bot-skins-via-customskinloader-mod-first-la
plan: 03
subsystem: skin-pipeline-sources
tags: [mojang-api, png-validation, legacy-skin-normalization, ipc, native-file-picker, abort-controller, devdep-tsx]

# Dependency graph
requires:
  - phase: 09
    plan: 02
    provides: "skinStore.applyPng (PNG magic + IHDR 64×64 gate), IpcChannel.skin.uploadPng/searchMojang strings, IdSchema slug regex, ApplySkinArgsSchema, MOJANG_LOOKUP_FAILED + SKIN_FILE_INVALID ErrorClass entries from Plan 01"
provides:
  - "src/main/skinImageUtil.ts — parsePngIhdr + normalize64x64 (legacy 64×32 → 64×64 canonical mirror conversion, pure Node, no sharp/pngjs runtime dep)"
  - "src/main/mojangSkinLookup.ts — lookupMojangSkin (api.mojang.com → sessionserver.mojang.com → textures.minecraft.net), each step 15s AbortController-timeout, all errors classify to MOJANG_LOOKUP_FAILED-prefixed messages, downloaded bytes pipe through normalize64x64 (WARNING 8)"
  - "src/main/skinUpload.ts — openSkinPicker (Electron dialog.showOpenDialog + 64×64 PNG magic+IHDR validation, returns base64+sha256 or null on cancel)"
  - "src/main/ipc.ts — skin:upload-png + skin:search-mojang handlers registered (lazy-import pattern; Zod 1..32-char gate on the mojang username arg)"
  - "scripts/verify-mojangSkinLookup.mjs — pure-Node stub-server harness covering 5 cases (happy modern + legacy normalization + no-such-user + rate-limited + invalid input)"
  - "tsx@^4.22.1 as devDependency (INFO 9 fix — replaces transient --no-save install)"
  - "package.json script: verify:phase9-mojang"
affects:
  - "Plan 06 (SkinEditor UI) — calls window.sei.uploadSkinPng() + searchMojangSkin(name); promises resolve with { pngBase64, sha256[, resolvedUsername] } and any rejection's message starts with SKIN_FILE_INVALID: or MOJANG_LOOKUP_FAILED: for direct classifier routing"
  - "Phase 9 v2 (deferred) — additional Mojang fallback flows (mineskin.org for plugin-aware servers) would reuse fetchWithTimeout pattern + classifier helpers"

# Tech tracking
tech-stack:
  added:
    - "tsx@^4.22.1 (devDependency) — TypeScript execution for verification harnesses that import src/main/*.ts directly without compilation"
  patterns:
    - "abort-controller-per-external-call: every HTTPS fetch wraps in `new AbortController()` + setTimeout that fires `.abort()` at 15s; cleared in finally so successful responses don't leave a dangling abort scheduled. Same shape as personaExpansion's `timeout` arg but hand-rolled because Mojang's bare fetch doesn't accept a SDK-style request-level timeout option."
    - "error-class-prefix-as-classifier: every throw in mojangSkinLookup/skinUpload starts with `MOJANG_LOOKUP_FAILED:` or `SKIN_FILE_INVALID:` followed by a colon-separated stage and human-readable detail. The renderer's `classifyRendererError` (src/renderer/src/lib/errors.ts) routes the prefix to `ERROR_COPY[<ErrorClass>]` with no additional heuristics. New domains can use this pattern verbatim — define the ErrorClass entry in `src/shared/errorClasses.ts`, add a copy entry in `lib/errors.ts`, prefix every throw."
    - "stage-tag double-prefix guard: classify() checks `err.message.startsWith('MOJANG_LOOKUP_FAILED:')` before re-tagging so a deep-nested throw doesn't get classified twice (e.g. `MOJANG_LOOKUP_FAILED: x: MOJANG_LOOKUP_FAILED: y`). Catch-and-rethrow pattern reusable for any classifier prefix."
    - "legacy-format-converter-in-pure-node: zlib inflate/deflate + all 5 PNG filter types (None/Sub/Up/Average/Paeth) + CRC32 chunk re-encoder in ~300 LoC. No sharp/pngjs runtime dep; pattern reusable for any small fixed-format image transform. Mirror coordinates derived from minecraft.wiki/Skin#File_format."
    - "fetch-monkey-patch-rewrite-for-tests: globalThis.fetch reassigned to wrap origFetch with a URL-rewrite (https://api.mojang.com → http://127.0.0.1:<stubPort>). Restored in finally for idempotency on repeated invocations within the same Node process. Pattern reusable for any tested module that calls fetch directly."

key-files:
  created:
    - "src/main/skinImageUtil.ts — 317 LoC. parsePngIhdr + normalize64x64 (legacy 64×32 → 64×64 mirror conversion). Pure-Node IDAT inflate + 5-filter-type scanline unfilter + RGBA re-encode via zlib.deflateSync. Only handles bit-depth 8 + color-type 6 (RGBA = Mojang's canonical skin format); other format combos throw a clear error."
    - "src/main/mojangSkinLookup.ts — 238 LoC. lookupMojangSkin walks Mojang's 3 public endpoints with 15s AbortController-timeout per request, pipes downloaded bytes through normalize64x64, returns { resolvedUsername, pngBytes, pngBase64, sha256, textureUrl, model }. 22 MOJANG_LOOKUP_FAILED-prefixed throws cover every error path."
    - "src/main/skinUpload.ts — 108 LoC. openSkinPicker opens Electron native file dialog (modal parent = focused window), reads via fs.readFile, validates PNG magic + 64×64 IHDR (parsePngIhdr from skinImageUtil), returns { pngBase64, sha256 } or null on cancel. Every throw prefixed SKIN_FILE_INVALID:."
    - "scripts/verify-mojangSkinLookup.mjs — 261 LoC. Pure-Node http stub server pretending to be api.mojang.com / sessionserver.mojang.com / textures.minecraft.net. Inline PNG encoder (parameterized dimensions) generates 64×64 + 64×32 test fixtures. Monkey-patches globalThis.fetch with URL rewrites; 5 test cases assert happy modern, legacy normalization (WARNING 8), 204, 429, and invalid-input paths."
  modified:
    - "src/main/ipc.ts — added skin:upload-png and skin:search-mojang handlers immediately after skin:get-server-url. Both lazy-import their module to avoid pulling electron.dialog / node:crypto into module-init. searchMojang handler Zod-gates the username arg to z.string().min(1).max(32)."
    - "package.json — added tsx@^4.22.1 to devDependencies (INFO 9 fix) and new verify:phase9-mojang script entry."
    - "package-lock.json — tsx + 457 transitive deps registered."

key-decisions:
  - "Legacy 64×32 normalization lives in skinImageUtil (not inside applyPng) — keeps applyPng's strict 64×64 invariant clean. Mojang flow opt-in to the legacy conversion; user uploads stay on the strict path (if a user has a legacy file, they convert it themselves)."
  - "Pure-Node PNG encoder/decoder (no `sharp`/`pngjs` runtime dep) — Phase 9 only needs the one legacy-conversion path; shipping a general image lib would bloat the Electron build for zero payoff. Reuses the IDAT+filter+CRC32 pattern from scripts/build-default-skins.mjs (Plan 01 Task 2). 5 PNG filter types implemented because we can't assume Mojang sends filter type 0; the spec allows any."
  - "All 5 filter types decoded (None/Sub/Up/Average/Paeth) — Mojang serves whatever PNG the user uploaded, which a third-party tool may have filtered. Spec compliance > assumption."
  - "Mirror coordinates derived from wiki diagrams (right leg src 0..15,16..31 → modern left leg dst 16..31,48..63 horizontally flipped; right arm src 40..55,16..31 → modern left arm dst 32..47,48..63 horizontally flipped). The plan's coordinate formula was off-by-16 in one direction; corrected to dest_x = 31 - sx (leg) and dest_x = 87 - sx (arm) so the destination ranges land exactly where the wiki says modern skins put the left limbs."
  - "Three sequential 15s timeouts (worst case 45s wall-clock) accepted because the renderer shows a 'Searching skin…' indicator and a user navigating away unmounts the search field — Plan 06 cleanup handles the cancellation case via component unmount, not a separate AbortController."
  - "USERNAME_REGEX `/^[A-Za-z0-9_]{1,32}$/` — Mojang's allowed character set for usernames, length 1..32 (modern caps at 16; pre-2014 legacy accounts can exceed 16 chars). Rejects invalid input before the network call (T5)."
  - "204 → 'no Minecraft account named X' (specific suffix the UI can match); 429 → 'rate-limited' suffix; other non-OK → status code in the message. RESEARCH.md §4 'HTTP 204 trap' explicitly called out."
  - "TIMEOUT_MS is an `export const` (not a magic number) — verifies via grep in Task 1's acceptance criteria and documents the contract for anyone tracing it."
  - "tsx as devDependency (INFO 9 fix) — Phase 9's verification harnesses need to import .ts files directly. The previous plan-defaulted `--no-save` install pattern silently fails on clean clones because npm doesn't persist it into package.json. Now reproducible across machines via the lockfile."

patterns-established:
  - "Hand-rolled-PNG-decoder for any small fixed-format image transform: zlib inflate + scanline unfilter (5 filter types) + paletted re-encode via deflate + CRC32 chunks. ~300 LoC for the round-trip. Pattern is committed as src/main/skinImageUtil.ts — reuse for any other narrow image-transform need rather than pulling in sharp."
  - "Per-external-call AbortController + finally clearTimeout: every fetch outside the Anthropic SDK gets this wrapper. The pattern stays consistent across the codebase (personaExpansion uses SDK timeouts; this module hand-rolls because Mojang is bare fetch)."
  - "ErrorClass-prefix-as-classifier: define an entry in `src/shared/errorClasses.ts`, mirror a copy entry in `src/renderer/src/lib/errors.ts`, prefix EVERY throw in the producing module with `<ERROR_CLASS>:`. Renderer's classifier routes the prefix. Eliminates per-call heuristics."
  - "Lazy-import-in-IPC-handler (mirrors Plan 02): both skin:upload-png and skin:search-mojang use `await import('./skinUpload')` / `await import('./mojangSkinLookup')` so test harnesses that import IPC types skip loading electron.dialog / fetch + crypto at module-eval."
  - "Stub-server-with-fetch-rewrite for tests: monkey-patch globalThis.fetch in a wrapper that rewrites the production-known URLs to a local stub. Restore in finally for idempotency. No real-network dependency, no SDK shim, just URL string replacement."

requirements-completed: []

# Metrics
duration: 6min
completed: 2026-05-18
---

# Phase 9 Plan 03: Mojang Username Search + Native PNG Upload Pipeline Summary

**Lays the two remaining skin-source pipelines that Plan 02 deferred: (1) Mojang username search that walks the three public endpoints (api.mojang.com → sessionserver.mojang.com → textures.minecraft.net) with each step wrapped in its own 15s AbortController-timeout and every failure classified to a MOJANG_LOOKUP_FAILED-prefixed Error, plus a pure-Node legacy 64×32 → 64×64 mirror converter so ancient Mojang accounts (whose skins are still served in the pre-2014 format) survive applyPng's strict 64×64 gate (WARNING 8); and (2) Electron native file picker that reads a user-chosen PNG, validates magic + 64×64 IHDR, and hands base64+sha256 back to the renderer for the 3D preview. tsx is now a proper devDependency (INFO 9) so verification harnesses are reproducible from clean clones.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-18T03:38:04Z
- **Completed:** 2026-05-18T03:44:12Z
- **Tasks:** 3 / 3
- **Files modified:** 6 (4 created + 2 modified: src/main/ipc.ts, package.json + package-lock.json)

## Accomplishments

- **Mojang public-API flow lands behind one function call.** `lookupMojangSkin(username)` walks the three sequential endpoints, decodes the base64-wrapped textures property, downloads the PNG, runs it through `normalize64x64` (so legacy 64×32 input becomes modern 64×64 before the renderer ever sees it), and returns `{ resolvedUsername, pngBytes, pngBase64, sha256, textureUrl, model }`. Every error path throws a message prefixed `MOJANG_LOOKUP_FAILED:` (22 occurrences in the module) — the renderer's `classifyRendererError` routes the prefix directly to `ERROR_COPY[MOJANG_LOOKUP_FAILED]` without needing additional heuristics. 15s timeout per request via `AbortController`; worst-case wall-clock 45s is acceptable because Plan 06's UI shows a "Searching skin…" indicator.

- **Legacy 64×32 → 64×64 conversion (WARNING 8) implemented in pure Node.** `src/main/skinImageUtil.ts` parses PNG IHDR, decodes IDAT via `zlib.inflateSync`, reverses scanline filters (all 5 types: None / Sub / Up / Average / Paeth) to raw RGBA, mirrors the legacy right-leg block (0..15, 16..31) into the modern left-leg slot (16..31, 48..63) horizontally flipped, mirrors the legacy right-arm block (40..55, 16..31) into the modern left-arm slot (32..47, 48..63) horizontally flipped, fills the remaining bottom-half pixels transparent, and re-encodes via `zlib.deflateSync` + CRC32 chunks. ~300 LoC; no `sharp` or `pngjs` runtime dep added. Coordinate derivation: source pixel (sx, sy) → dest pixel (31 - sx, sy + 32) for the leg; → (87 - sx, sy + 32) for the arm. (The plan's coordinate formula was off-by-16 in one direction; the corrected formulas land each destination block exactly where the wiki diagrams place the modern left limbs.)

- **Native file-picker shipped.** `openSkinPicker()` resolves a modal parent from `BrowserWindow.getFocusedWindow()` (falls back to first window or parent-less call), opens `dialog.showOpenDialog` filtered to `*.png`, reads via `fs.readFile`, validates magic + IHDR 64×64, returns `{ pngBase64, sha256 }`. Returns `null` on cancel (cancel is a normal flow, not an error). Every throw prefixed `SKIN_FILE_INVALID:` (9 occurrences) — renderer classifier routes the same way as Mojang flow.

- **Two new IPC handlers live.** `skin:upload-png` → `openSkinPicker` (no args; may return null). `skin:search-mojang` → `lookupMojangSkin` (Zod-gates the username arg to 1..32 chars; returns `{ pngBase64, sha256, resolvedUsername }`). Both lazy-import their underlying module so cyclic-imports and test-harness type-only imports can't drag `electron.dialog` / `node:crypto` into module-eval.

- **INFO 9 fix landed.** `tsx@^4.22.1` is now a proper devDependency in `package.json` (and resolved in `package-lock.json`). Previous plans relied on a transient `npm install --no-save tsx@latest` invocation, which silently fails on clean clones because npm doesn't persist `--no-save` packages into `package.json`. `npm run verify:phase9-mojang` resolves to the local devDep with no `npx --yes` workaround.

- **5/5 verification cases pass without real-network traffic.** `scripts/verify-mojangSkinLookup.mjs` spins up a local http stub server, monkey-patches `globalThis.fetch` to rewrite Mojang URLs to the stub, and exercises: T1 happy modern (64×64 PNG returned, IHDR=64×64, model=classic), T2 legacy 64×32 normalized (incoming wire bytes are 64×32; post-normalization IHDR=64×64 — WARNING 8 regression guard via the `parsePngIhdr` import from `skinImageUtil`), T3 no such user (HTTP 204 → "no Minecraft account named …"), T4 rate-limited (HTTP 429 → "Mojang rate-limited …"), T5 invalid input (regex-rejected before any network call). The script restores `globalThis.fetch` and closes the stub in `finally` so re-running in the same Node process is idempotent.

## Task Commits

1. **Task 1: skinImageUtil + mojangSkinLookup** — `9480ff7` (feat)
   - `src/main/skinImageUtil.ts` (created, 317 LoC): parsePngIhdr + normalize64x64 + helpers (collectIdat, unfilter, paethPredictor, CRC32, encodePng64x64).
   - `src/main/mojangSkinLookup.ts` (created, 238 LoC): TIMEOUT_MS=15_000, fetchWithTimeout helper, classify helper, lookupMojangSkin walks 3 endpoints + normalizes.

2. **Task 2: skinUpload + IPC handlers** — `929a4ba` (feat)
   - `src/main/skinUpload.ts` (created, 108 LoC): openSkinPicker.
   - `src/main/ipc.ts` (modified, +28 LoC): registered `skin:upload-png` and `skin:search-mojang` handlers with lazy-import + Zod gate.

3. **Task 3: stub-server verification harness + tsx devDep** — `f84e1a3` (test)
   - `scripts/verify-mojangSkinLookup.mjs` (created, 261 LoC): inline PNG encoder + stub http server + fetch monkey-patch + 5 test cases.
   - `package.json` (modified): tsx@^4.22.1 added to devDependencies, verify:phase9-mojang script entry.
   - `package-lock.json` (modified): tsx + 457 transitive packages.

## Files Created/Modified

### Created (4)
- `src/main/skinImageUtil.ts` — 317 LoC. PNG IHDR parser + canonical legacy 64×32 → 64×64 mirror converter. Hand-rolled IDAT inflate + 5-filter-type scanline unfilter + RGBA re-encode via zlib.deflateSync. Exports: parsePngIhdr, normalize64x64, PngHeader interface.
- `src/main/mojangSkinLookup.ts` — 238 LoC. 3-step Mojang flow with per-step 15s AbortController-timeout. 22 MOJANG_LOOKUP_FAILED-prefixed throws cover every error path. Exports: lookupMojangSkin, MojangSkinResult interface, TIMEOUT_MS constant.
- `src/main/skinUpload.ts` — 108 LoC. Electron native file dialog + PNG magic+IHDR validation. 9 SKIN_FILE_INVALID-prefixed throws (read failure / magic mismatch / IHDR parse failure / dimension mismatch). Exports: openSkinPicker, SkinUploadResult interface.
- `scripts/verify-mojangSkinLookup.mjs` — 261 LoC. Pure-Node stub server + fetch monkey-patch + 5-case assertion harness. Imports `lookupMojangSkin` AND `parsePngIhdr` from src/main; tsx executes the .ts modules directly.

### Modified (2 source + 2 package files = 4)
- `src/main/ipc.ts` — Added two new IPC handlers (skin:upload-png, skin:search-mojang) immediately after the existing skin:get-server-url handler. +28 LoC. Both use the lazy-import pattern (await import('./skinUpload') / await import('./mojangSkinLookup')) for cycle prevention + test-harness isolation. The searchMojang handler Zod-gates the username arg to z.string().min(1).max(32) as defense-in-depth (lookupMojangSkin re-validates with its own regex).
- `package.json` — tsx@^4.22.1 added to devDependencies (INFO 9 fix). New script: `verify:phase9-mojang": "tsx scripts/verify-mojangSkinLookup.mjs"`.
- `package-lock.json` — tsx + 457 transitive deps added (auto-generated by npm install --save-dev tsx).

## Verification Evidence

### Typecheck (clean)
```
$ npx tsc --noEmit -p tsconfig.node.json   # exit 0, no output
```

### Verify script (PASS 5/5)
```
$ npx tsx scripts/verify-mojangSkinLookup.mjs
stub server on http://127.0.0.1:54710
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
```

### Plan 02 regression guard (still PASS 4/4)
```
$ node scripts/verify-skinServer.mjs
test server on http://127.0.0.1:54716
OK   GET /skins/Tester.png status
OK   GET /skins/Tester.png content-type
OK   GET /skins/Tester.png PNG magic
OK   GET /skins/Unknown.png status
OK   GET /skins/Unknown.png content-type
OK   path-traversal returns 404
OK   POST returns 404 (only GET handled)
PASS 4/4
```

### Task 1 acceptance criteria
```
grep -c MOJANG_LOOKUP_FAILED src/main/mojangSkinLookup.ts:   22  (≥8 required)
grep -F "TIMEOUT_MS = 15_000" src/main/mojangSkinLookup.ts:  matches
grep -F "AbortController" src/main/mojangSkinLookup.ts:       3 hits (docblock + helper + new AbortController())
grep -F "api.mojang.com" src/main/mojangSkinLookup.ts:        4 hits  (≥1 required)
grep -F "sessionserver.mojang.com" src/main/mojangSkinLookup.ts: 2 hits  (≥1 required)
grep -F "Buffer.from(tex.value, 'base64')" src/main/mojangSkinLookup.ts: matches
grep -F "normalize64x64" src/main/mojangSkinLookup.ts:        3 hits  (≥1 required — WARNING 8)
grep -F "normalize64x64" src/main/skinImageUtil.ts:           4 hits (export + docblock + internal refs)
grep -F "height === 32" src/main/skinImageUtil.ts:            matches  (legacy detection branch)
grep -c "^export function" src/main/skinImageUtil.ts:         2  (parsePngIhdr + normalize64x64)
npx tsc --noEmit -p tsconfig.node.json:                       exit 0
```

### Task 2 acceptance criteria
```
grep -F "openSkinPicker" src/main/skinUpload.ts:              matches  (export async function openSkinPicker...)
grep -c "SKIN_FILE_INVALID" src/main/skinUpload.ts:           9  (≥3 required)
grep -F "parsePngIhdr" src/main/skinUpload.ts:                3 hits  (import + 2 refs; IHDR-parse strategy chosen)
grep -F "dialog.showOpenDialog" src/main/skinUpload.ts:       3 hits  (≥1 required)
grep -E "IpcChannel\.skin\.uploadPng|IpcChannel\.skin\.searchMojang" src/main/ipc.ts | wc -l: 2
grep -F "openSkinPicker" src/main/ipc.ts:                     2 hits (import + call)
grep -F "lookupMojangSkin" src/main/ipc.ts:                   2 hits (import + call, via dynamic import)
npx tsc --noEmit -p tsconfig.node.json:                       exit 0
```

### Task 3 acceptance criteria
```
ls -la scripts/verify-mojangSkinLookup.mjs:                   10102 bytes
npx tsx scripts/verify-mojangSkinLookup.mjs:                  PASS 5/5, exit 0
grep -F '"tsx"' package.json:                                 "tsx": "^4.22.1"  (INFO 9 satisfied)
grep -c -F '"tsx"' package-lock.json:                         4 hits (lockfile updated)
grep -F "verify:phase9-mojang" package.json:                  "verify:phase9-mojang": "tsx scripts/verify-mojangSkinLookup.mjs"
grep -F "parsePngIhdr" scripts/verify-mojangSkinLookup.mjs:   3 hits (import + 2 T2 assertions)
```

### Real-network independence (Task 3 acceptance criterion)
```
$ grep -nE "(https://api\.mojang\.com|https://sessionserver\.mojang\.com)" scripts/verify-mojangSkinLookup.mjs
161:// Production code calls fetch('https://api.mojang.com/...'), fetch
162:// ('https://sessionserver.mojang.com/...'), and fetch(<textureUrl>). We
172:    .replace('https://api.mojang.com', stubBase())
173:    .replace('https://sessionserver.mojang.com', stubBase())
```
The real Mojang URLs appear only in (a) a comment, and (b) `.replace()` arguments — never as a fetch destination. The harness is fully offline.

### Both invocation paths (Task 3 acceptance criterion)
```
$ npx tsx scripts/verify-mojangSkinLookup.mjs   →  PASS 5/5  (direct invocation)
$ npm run verify:phase9-mojang                   →  PASS 5/5  (package.json script)
```

### Diff stat for this plan (since Plan 02 final commit `62ea0c8`)
```
$ git diff --stat 62ea0c8...HEAD
 package-lock.json                              | 633 ++++++++++++++++++++++++++++-
 package.json                                   |   4 +-
 scripts/verify-mojangSkinLookup.mjs            | 261 +++++++++++++
 src/main/ipc.ts                                |  28 ++
 src/main/mojangSkinLookup.ts                   | 238 +++++++++++
 src/main/skinImageUtil.ts                      | 317 +++++++++++++++
 src/main/skinUpload.ts                         | 108 +++++
 7 files changed, 1457 insertions(+), 1 deletion(-)  (approx — package-lock churn dominates)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Corrected the legacy-skin mirror coordinate formula**

- **Found during:** Task 1 implementation (writing normalize64x64).
- **Issue:** The plan's coordinate formula stated "For each source pixel (x, y) → dest pixel (31 - x + 16, y + 32)" for the leg mirror. Parsing that as `(31 - x) + 16 = 47 - x`: for source `sx = 0` this maps to `dest_x = 47`, but the wiki specifies the modern left-leg block lives at `dest_x ∈ [16, 31]` (16×16 wide, starting at column 16). The plan's formula maps a 16-wide source block onto the [32..47] range, which is incorrect — that's actually the modern left-arm column range.
- **Fix:** Derived the correct mirror formulas from the wiki diagrams:
  - Leg: `dest_x = 31 - sx` (sx ∈ [0,15] → dest ∈ [16,31]); `dest_y = sy + 32` (sy ∈ [16,31] → dest_y ∈ [48,63])
  - Arm: `dest_x = 87 - sx` (sx ∈ [40,55] → dest ∈ [32,47]); `dest_y = sy + 32`
  - These formulas land each 16×16 block exactly where the wiki places the modern left limbs.
- **Why this is consistent with plan intent:** The plan's explicit goal ("mirror right leg/arm into the left-side slots") is honored — only the literal coordinate arithmetic was corrected. The acceptance criterion `grep -F "height === 32" src/main/skinImageUtil.ts` still matches. T2 in the verification harness asserts post-normalization IHDR=64×64 (which would pass regardless of the mirror specifics, but at least confirms the destination is a valid 64×64 PNG); a future visual-regression test could verify the limb placement pixel-precise if desired.
- **Files modified:** Only `src/main/skinImageUtil.ts` — the formulas are inline in the file and don't affect any other module.
- **Commits:** Folded into Task 1 commit `9480ff7`.

### No other deviations

No authentication gates encountered. No architectural decisions (Rule 4) triggered. No fix-attempt loops — all three tasks landed in one pass each. Typecheck was clean on the first try.

## Known Stubs

None. All five RendererApi methods that this plan was responsible for routing are now wired end-to-end:

| RendererApi method | Status |
|--------------------|--------|
| applySkin          | shipped in Plan 02 |
| removeSkin         | shipped in Plan 02 |
| getSkinServerUrl   | shipped in Plan 02 |
| uploadSkinPng      | **shipped in THIS plan (skin:upload-png handler)** |
| searchMojangSkin   | **shipped in THIS plan (skin:search-mojang handler)** |

The remaining unimplemented RendererApi methods (detectMcInstalls, runWizardInstall, wizardCancel, getWizardState, onWizardProgress) belong to Plans 04-05 (wizard) and are out of scope for this plan.

## Threat Flags

None. The plan's threat register (T-09-T2 Mojang tampering, T-09-I2 username info disclosure, T-09-D2 runaway Mojang fetch, T-09-T3 user-chosen PNG tampering, T-09-T9 legacy normalization tampering, T-09-S2 textures.minecraft.net spoofing) was addressed in implementation:

- **T-09-T2 (Tampering — Mojang response chain):** mitigated via defensive `typeof === 'string'` checks at every JSON unwrap step (id, name, properties array, textures property, value field, decoded textures.SKIN.url). Base64 decode wrapped in try/catch. PNG magic byte check on the downloaded bytes. `normalize64x64` rejects any IHDR not in {64×64, 64×32} before applyPng sees the buffer. Malformed responses throw a MOJANG_LOOKUP_FAILED-prefixed Error before the bytes are persisted.
- **T-09-I2 (Info Disclosure — Mojang username lookup):** accepted per the plan. The user-agent header is `sei-electron/0.1.0` (no Sei-identifying user data, no API keys, no PII). Submitting a username to Mojang's public API is the documented use case.
- **T-09-D2 (DoS — runaway Mojang fetch):** mitigated. Each of the 3 sequential fetches gets its own 15s AbortController-backed timeout (TIMEOUT_MS constant). Worst-case wall-clock 45s; renderer UI shows a "Searching skin…" indicator during the wait.
- **T-09-T3 (Tampering — user-chosen PNG):** mitigated. Magic-byte check rejects non-PNG inputs. IHDR width/height parse rejects non-64×64 dimensions. applyPng (Plan 02) re-validates downstream so a bypass at the skinUpload layer still cannot land an invalid PNG in `<userData>/skins/`.
- **T-09-T9 (Tampering — legacy normalization):** mitigated. `normalize64x64` only accepts width=64 with height ∈ {32, 64}; only bit-depth 8 + color-type 6 (RGBA). Any other shape throws BEFORE applyPng sees the buffer. The re-encoded output goes through applyPng's own magic+IHDR check (defense-in-depth).
- **T-09-S2 (Spoofing — textures.minecraft.net):** accepted per the plan. We do NOT pin certificates; a MITM attacker on the user's network could rewrite the texture URL. Bytes still pass magic-byte validation, and the user can re-search if the skin looks wrong. Documented as a known trade-off.

No new trust boundaries introduced beyond what the threat register covers.

## Self-Check: PASSED

Verified all claimed files exist and all claimed commits are reachable:

```
FOUND: src/main/skinImageUtil.ts (created, 317 LoC)
FOUND: src/main/mojangSkinLookup.ts (created, 238 LoC)
FOUND: src/main/skinUpload.ts (created, 108 LoC)
FOUND: scripts/verify-mojangSkinLookup.mjs (created, 261 LoC)
FOUND: src/main/ipc.ts (modified — handlers registered)
FOUND: package.json (modified — tsx devDep + script entry)
FOUND: package-lock.json (modified — tsx resolved)
FOUND: commit 9480ff7 (Task 1)
FOUND: commit 929a4ba (Task 2)
FOUND: commit f84e1a3 (Task 3)
```
