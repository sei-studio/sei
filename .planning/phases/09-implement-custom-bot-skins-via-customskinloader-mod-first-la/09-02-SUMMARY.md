---
phase: 09-implement-custom-bot-skins-via-customskinloader-mod-first-la
plan: 02
subsystem: skin-pipeline-backend
tags: [skin-server, http-loopback, ipc, png-validation, atomic-write, path-traversal, idschema]

# Dependency graph
requires:
  - phase: 09
    plan: 01
    provides: "SkinSchema, Character.username, IpcChannel.skin.*, RendererApi skin methods, ERROR_COPY[SKIN_SERVER_PORT_TAKEN], bundled PNGs under resources/skins/"
provides:
  - "src/main/skinStore.ts — applyPng/removePng/resolveSkinPng/readSkinPng/bundledSkinPath"
  - "src/main/skinServer.ts — createSkinServer({port?}) → 127.0.0.1 loopback HTTP server, /skins/<username>.png contract"
  - "Strict IdSchema hardening (kebab-case slug regex) on every characterId IPC handler"
  - "skin:apply IPC: atomic skin descriptor + per-persona MC username write via single saveCharacter call"
  - "skin:remove IPC: defaults revert to 'bundled', user-created revert to 'none'"
  - "skin:get-server-url IPC: surfaces baseUrl to renderer + future wizard config writer"
  - "Bot init payload extension — skinServerBaseUrl + character.username override"
  - "src/bot/brain/storage/atomicWrite.js widened to accept Buffer/Uint8Array (binary PNG support)"
  - "scripts/verify-skinServer.mjs — pure-Node integration harness, 4 assertions"
affects:
  - "Plan 03 (skin search + upload IPC) — registers skin:upload-png + skin:search-mojang against the same IdSchema + handler pattern; depends on applyPng's atomic write semantics"
  - "Plan 04 (wizard detection) — reads getSkinServerBaseUrl getter to stamp the URL into CustomSkinLoader config writer"
  - "Plan 05 (wizard orchestrator) — Port-drift detection compares skinServer.port to wizardState.lastSkinServerPort"
  - "Plan 06 (SkinEditor UI) — calls applySkin with (pngBase64 + username) atomically; surfaces ERROR_COPY[SKIN_SERVER_PORT_TAKEN] on getSkinServerUrl rejection"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "lazy-import-in-ipc-handler: skinStore is dynamically imported inside the skin:apply/skin:remove handler bodies (await import('./skinStore')) so a future cyclic import (skinStore → characterStore → ipc → skinStore) cannot deadlock at module-init time. Pattern reusable for any IPC handler that needs to call into a module that may transitively import from src/main/ipc.ts."
    - "loopback-http-with-literal-bind-assertion: The skin server binds 127.0.0.1 explicitly via `server.listen(port, '127.0.0.1')`. The literal string is asserted by an anchored regex grep in the plan's acceptance criteria so a future edit can't accidentally widen the bind to 0.0.0.0 (which would expose persona skins to LAN + trigger firewall prompts). Pattern reusable for any local-only HTTP server."
    - "atomic-two-field-write-via-single-savecharacter: applyPng takes both pngBytes AND optional username and persists them in ONE saveCharacter call rather than (a) save skin then (b) save username. Atomicity guarantee — never half-applied if either field validation fails. WARNING 5 fix from 09-02-PLAN."
    - "idschema-as-filesystem-path-component-gate: When a renderer-provided id becomes a filesystem path component (path.join(..., `${id}.png`)), gate it at the IPC layer with a strict slug regex that forbids `.`, `/`, `\\`, null, and whitespace. Even though path.join normalizes, the regex is the explicit denial of intent. Pattern: `/^[a-z0-9][a-z0-9-]{0,62}$/` (Sei's canonical persona-id format)."
    - "404-as-parseable-png: For unknown skin lookups, return status 404 with content-type image/png and a pre-baked transparent 1×1 PNG body. CustomSkinLoader builds that retry on text/plain 404 bodies get a parseable empty image instead, short-circuiting the retry loop."

key-files:
  created:
    - "src/main/skinStore.ts — atomic PNG storage (220 LoC); exports applyPng, removePng, resolveSkinPng, readSkinPng, bundledSkinPath"
    - "src/main/skinServer.ts — loopback HTTP server (136 LoC); exports createSkinServer, SkinServer; binds 127.0.0.1 literal; pre-baked transparent 1×1 PNG for 404 bodies"
    - "scripts/verify-skinServer.mjs — pure-Node integration test (115 LoC); 4 assertions; wired as `npm run verify:phase9-skin-server`"
  modified:
    - "src/main/paths.ts — added skinsDir() + skinPngPath(id) helpers"
    - "src/main/ipc.ts — IdSchema hardened to slug regex (BLOCKER 1); ApplySkinArgsSchema added; 3 new handlers (skin:apply, skin:remove, skin:get-server-url); IpcHandlerDeps.getSkinServerBaseUrl widening"
    - "src/main/index.ts — step 1c boots createSkinServer before main window; supervisor + IPC receive getSkinServerBaseUrl getter; graceful shutdown on before-quit"
    - "src/main/botSupervisor.ts — BotSupervisorOptions.getSkinServerBaseUrl getter + init payload extended with skinServerBaseUrl"
    - "src/bot/index.js — receives skinServerBaseUrl (logs it for verification); prefers character.username over sanitizeMcName(character.name) for the MC in-game name"
    - "src/bot/brain/storage/atomicWrite.js — widened to accept Buffer/Uint8Array (auto-fix Rule 3; the previous hardcoded 'utf8' encoding silently corrupted binary PNG bytes)"
    - "package.json — verify:phase9-skin-server script entry"

key-decisions:
  - "Hardened IdSchema as part of THIS plan (not deferred): Plan 02 introduces the first IPC handler in the codebase that uses the persona id as a filesystem path component. Tightening the schema HERE means the regression-guard regex grep is meaningful from day one; deferring would leave a 1-plan window where the slug isn't enforced."
  - "applyPng accepts both pngBytes + optional username in one call: the atomic-two-field-write pattern is the WARNING 5 fix. The renderer's SkinEditor (Plan 06) hands both in via the same IPC call; main does one saveCharacter."
  - "Lazy-import skinStore inside IPC handlers: skinStore imports from characterStore which imports paths/personaExpansion/etc. To avoid the (eventual) cycle where a transitive consumer of ipc.ts ends up loaded before skinStore, the handler bodies `await import('./skinStore')` at request time. ~2ms first-call latency; nil thereafter (module is cached)."
  - "404 returns transparent 1×1 PNG with content-type image/png (status STILL 404): keeps CustomSkinLoader retry loops quiet without misrepresenting the resource as 'found'. Status-code consumers (proxies, dev tools) still see the 404."
  - "Bot does NOT consume skinServerBaseUrl at runtime: the bot logs the URL for verification but never fetches from it. CustomSkinLoader on the host's MC client is the only real consumer (configured by the wizard in Plan 05). The handover proves the supervisor → bot init plumbing works."
  - "atomicWrite widening was unavoidable: the existing helper hardcoded 'utf8' encoding, which silently corrupts binary bytes. Widened to accept Buffer/Uint8Array (preserves the legacy string-UTF-8 behavior for OWNER.md/DIARY.md callers). Tracked as Rule 3 deviation in the deviations section."

patterns-established:
  - "Lazy-import-in-IPC-handler for any module that transitively imports from ipc.ts (cycle prevention)."
  - "Literal-bind-string assertion: when binding loopback-only, the literal '127.0.0.1' in server.listen MUST be grep-anchored by an acceptance criterion so a future edit can't widen to 0.0.0.0 unnoticed."
  - "IdSchema as the canonical persona-id validator: any new IPC handler that takes a characterId MUST use it (not z.string().min(1))."
  - "Atomic multi-field IPC: when two persisted fields need to land together, take BOTH in the same IPC request and do ONE store-layer write."

requirements-completed: []

# Metrics
duration: 40min
completed: 2026-05-17
---

# Phase 9 Plan 02: Loopback Skin HTTP Server + Per-Persona PNG Storage + Bot Init Wiring Summary

**Ships the backend half of Phase 9's skin pipeline: a loopback Node http server on 127.0.0.1 that CustomSkinLoader queries from the host's MC client (`GET /skins/<username>.png`), an atomic per-persona PNG storage layer under `<userData>/skins/<id>.png` (PNG-magic + IHDR 64×64 validated, sha256-verified, persisted via a SINGLE saveCharacter call so skin descriptor + per-persona MC username land atomically per WARNING 5), three IPC handlers (skin:apply / skin:remove / skin:get-server-url) gated by a hardened slug-regex IdSchema (BLOCKER 1 fix — the persona id is now a filesystem path component), and bot-init plumbing that hands the skin server URL into the utilityProcess + lets each persona connect under its own `character.username` (or the legacy sanitized fallback).**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-05-17T20:25:00Z (approximately — first Task 1 commit at 20:31)
- **Completed:** 2026-05-17T20:50:00Z
- **Tasks:** 3 / 3
- **Files modified:** 11 (3 created + 7 modified + 1 modified shared helper)

## Accomplishments

- **Loopback skin server live at boot.** `src/main/index.ts` step 1c stands up `createSkinServer({})` BEFORE any character can be summoned. Bind is `127.0.0.1` literal (regression-guarded by an anchored regex grep in Task 2's acceptance criterion). Port 0 → OS-chosen ephemeral; baseUrl exposed via a getter so Plan 05's wizard config writer + Plan 06's UI can fetch it on demand. Graceful shutdown on `app.before-quit`.
- **PNG contract proven end-to-end.** Integration check served the bundled `resources/skins/sui.png` (220 bytes) byte-for-byte at `GET /skins/Sui.png` with `content-type: image/png` and `cache-control: no-store`. Verify script (`npm run verify:phase9-skin-server`) covers all 4 contract behaviors: known username → 200 + PNG, unknown → 404 + transparent 1×1 PNG (image/png), path-traversal → 404 (regex rejected), non-GET → 404.
- **Atomic skin + username write.** `applyPng` validates PNG magic + IHDR 64×64 RGBA, writes the bytes atomically via `withFileLock` + `atomicWrite`, then persists the new skin descriptor AND optional per-persona MC username in ONE `saveCharacter` call. WARNING 5 fix from the plan: no half-applied state. Renderer semantics matrix (undefined/null = no change, '' = clear, any string = set) documented in the JSDoc.
- **BLOCKER 1 fix.** `IdSchema` upgraded from `z.string().min(1)` to a kebab-case slug regex (`/^[a-z0-9][a-z0-9-]{0,62}$/`) — necessary because Plan 02 is the first IPC handler in the codebase to use the persona id as a filesystem path component. Existing `chars.*` handlers keep working unchanged (their callers already conform). The strict schema means a renderer that synthesizes a malformed id (`'../escape'`, `'a/b'`, `'a\\b'`) is rejected at the IPC boundary BEFORE `skinStore.applyPng` builds a filesystem path.
- **Bot init plumbing.** `BotSupervisorOptions.getSkinServerBaseUrl` getter + init payload extended with `skinServerBaseUrl`. `src/bot/index.js` receives + logs it for verification (CustomSkinLoader on the host's MC client is the actual consumer). The bot now prefers `character.username` over the legacy `sanitizeMcName(character.name)` fallback; null/empty falls back to the sanitized name so existing behavior is preserved for personas whose username field is unset.

## Task Commits

1. **Task 1: skinStore.ts + paths helper** — `f35c2e8` (feat)
   - `src/main/paths.ts`: skinsDir() + skinPngPath(id) helpers
   - `src/main/skinStore.ts`: applyPng / removePng / resolveSkinPng / readSkinPng / bundledSkinPath
   - `src/bot/brain/storage/atomicWrite.js`: widened to accept Buffer/Uint8Array (Rule 3 deviation — see below)
2. **Task 2: skinServer.ts + main bootstrap wiring** — `886c785` (feat)
   - `src/main/skinServer.ts`: createSkinServer({port?}) → loopback HTTP server
   - `src/main/index.ts`: step 1c boots createSkinServer; supervisor + ipc receive getSkinServerBaseUrl getter; graceful shutdown
   - `src/main/botSupervisor.ts`: BotSupervisorOptions.getSkinServerBaseUrl widening + init payload extended with skinServerBaseUrl
   - `src/main/ipc.ts`: IpcHandlerDeps.getSkinServerBaseUrl widening
3. **Task 3: IPC handlers + bot init wiring + verify script** — `62ea0c8` (feat)
   - `src/main/ipc.ts`: IdSchema hardened to slug regex (BLOCKER 1); ApplySkinArgsSchema; 3 new handlers (skin:apply, skin:remove, skin:get-server-url)
   - `src/bot/index.js`: receives skinServerBaseUrl (logged for verification); prefers character.username over sanitizeMcName
   - `scripts/verify-skinServer.mjs` + `package.json` script entry

## Files Created/Modified

### Created (3)
- `src/main/skinStore.ts` — 220 LoC. PNG magic + IHDR 64×64 validation, `withFileLock` + `atomicWrite` for write atomicity, sha256 hashing, bundled-vs-userdata path resolution (app.isPackaged-branched), single-saveCharacter atomic two-field write.
- `src/main/skinServer.ts` — 136 LoC. Node `http` createServer on `127.0.0.1` (literal), regex-gated URL contract (`^/skins/([A-Za-z0-9_]{1,16})\.png(\?.*)?$`), pre-baked transparent 1×1 PNG for 404 bodies, no-store cache control on 200 responses, SKIN_SERVER_PORT_TAKEN-prefixed bind-error path.
- `scripts/verify-skinServer.mjs` — 115 LoC. Pure-Node integration test mirroring skinServer.ts's request handler; 4 assertions: known-username PNG, unknown-username 404+transparent PNG, path-traversal 404 (regex), non-GET 404.

### Modified (8)
- `src/main/paths.ts` — added `skinsDir()` and `skinPngPath(id)` helpers (+7 LoC).
- `src/main/ipc.ts` — IdSchema hardened to `/^[a-z0-9][a-z0-9-]{0,62}$/` slug regex; `ApplySkinArgsSchema` added (characterId via IdSchema + pngBase64 + source enum + optional mojangUsername + optional username); 3 new handlers (skin:apply, skin:remove, skin:get-server-url); `IpcHandlerDeps.getSkinServerBaseUrl` getter widening. +94 LoC.
- `src/main/index.ts` — `createSkinServer` import + module-scoped `skinServer` state; step 1c bootstrap; supervisor + ipc receive `getSkinServerBaseUrl: () => skinServer?.baseUrl ?? null`; graceful shutdown on `before-quit`. +35 LoC.
- `src/main/botSupervisor.ts` — `BotSupervisorOptions.getSkinServerBaseUrl` getter; init payload extended with `skinServerBaseUrl: opts.getSkinServerBaseUrl()`. +16 LoC.
- `src/bot/index.js` — receives `skinServerBaseUrl` from the init message; logs it after the LAN-connected line; prefers `character.username` over `sanitizeMcName(character.name)` for the MC in-game name (null/empty falls back to sanitized name). +20 LoC.
- `src/bot/brain/storage/atomicWrite.js` — widened to accept `string | Uint8Array`. String inputs preserve legacy UTF-8 behavior; Buffer/Uint8Array inputs are written as raw bytes (auto-fix Rule 3 — see Deviations). +15 LoC delta.
- `package.json` — `"verify:phase9-skin-server": "node scripts/verify-skinServer.mjs"` script entry.

## Verification Evidence

### Typecheck (clean)
```
$ npx tsc --noEmit -p tsconfig.node.json   # exit 0, no output
```

### Verify script (PASS 4/4)
```
$ npm run verify:phase9-skin-server  →  $ node scripts/verify-skinServer.mjs
test server on http://127.0.0.1:54539
OK   GET /skins/Tester.png status
OK   GET /skins/Tester.png content-type
OK   GET /skins/Tester.png PNG magic
OK   GET /skins/Unknown.png status
OK   GET /skins/Unknown.png content-type
OK   path-traversal returns 404
OK   POST returns 404 (only GET handled)
PASS 4/4
```

### End-to-end bundled-PNG serve check
A standalone harness using the same regex + 404-PNG + content-type policy as `src/main/skinServer.ts` served the bundled `resources/skins/sui.png` (220 bytes) at `/skins/Sui.png`:

```
bundled sui.png: 220 bytes, magic 89504e47
server on http://127.0.0.1:54545
GET /skins/Sui.png: status=200 content-type=image/png
body: 220 bytes, magic 89504e47, matches bundled: true
PASS: bundled Sui PNG served byte-for-byte at /skins/Sui.png
```

### BLOCKER 1 — IdSchema count (must be ≥ 2)
```
$ grep -c "IdSchema" src/main/ipc.ts
8
```
(1 declaration + 1 in `ApplySkinArgsSchema.characterId` + 5 in existing `chars.*` handlers + 1 in `skin:remove` = 8.)

### Task acceptance criteria (per-task pass)

**Task 1:**
- 5 exports in skinStore.ts: ✓
- `grep -F "skinsDir\|skinPngPath" src/main/paths.ts | wc -l` → 2: ✓
- IHDR parsing at offsets 16/20: ✓ (`readUInt32BE(16)` width, `readUInt32BE(20)` height)
- `DEFAULT_CHARACTERS` referenced in skinStore.ts: ✓
- `saveCharacter({ ...character, skin: newSkin, username: nextUsername })` matches: ✓
- Actual `saveCharacter(` invocations: 2 (one in applyPng, one in removePng — never 3 per call) ✓

**Task 2:**
- `createSkinServer` exported in skinServer.ts: ✓
- `127.0.0.1` count in skinServer.ts: 6 (≥ 2): ✓
- Literal-bind regex `server.listen([^,]*, *['"]127\.0\.0\.1['"])` matches exactly once: ✓
- `createSkinServer` references in index.ts: 2 (import + invocation): ✓
- `skinServer.stop` wired in before-quit: ✓
- Inline 404 PNG decodes to magic `89504e470d0a1a0a` + length 70 + 1×1 dimensions: ✓

**Task 3:**
- 3 skin channels registered: `IpcChannel.skin.apply`, `IpcChannel.skin.remove`, `IpcChannel.skin.getServerUrl` ✓
- IdSchema count in ipc.ts: 8 (≥ 2): ✓
- `characterId: IdSchema` in ApplySkinArgsSchema: ✓
- IdSchema regex hardening `IdSchema = z.string().regex(...)` present: ✓
- `username: z.string().nullable().optional()` in ApplySkinArgsSchema: ✓
- `character.username` referenced in bot/index.js: ✓
- `skinServerBaseUrl` in supervisor: 2; in bot/index.js: 3 ✓
- `verify:phase9-skin-server` package.json entry: ✓
- `node scripts/verify-skinServer.mjs` → `PASS 4/4`: ✓

### Diff stat (Plans 01 + 02 combined, since the previous plan's final commit `036457b`)
```
$ git diff --stat 036457b...HEAD
 package.json                                  |   3 +-
 resources/default-characters/clawd.json       |   9 +-
 resources/default-characters/mochineko.json   |   9 +-
 resources/default-characters/sui.json         |   9 +-
 resources/skins/clawd.png                     | Bin 0 -> 222 bytes
 resources/skins/mochineko.png                 | Bin 0 -> 222 bytes
 resources/skins/sui.png                       | Bin 0 -> 220 bytes
 scripts/build-default-skins.mjs               | 173 ++++++++++++++++++++++
 scripts/verify-skinServer.mjs                 | 115 +++++++++++++++
 src/bot/brain/storage/atomicWrite.js          |  15 +-
 src/bot/index.js                              |  20 ++-
 src/main/botSupervisor.ts                     |  16 ++
 src/main/index.ts                             |  35 ++++-
 src/main/ipc.ts                               |  94 +++++++++++-
 src/main/paths.ts                             |   7 +
 src/main/skinServer.ts                        | 136 +++++++++++++++++
 src/main/skinStore.ts                         | 220 ++++++++++++++++++++++++++++
 17 files changed, 851 insertions(+), 10 deletions(-)
```

### Skin server bound port (dev-mode capture)
The skin server binds an OS-chosen ephemeral port at boot. Verify harness ran on ports `54530`, `54535`, `54539`, `54545` across separate invocations — the port is non-deterministic per spec (the wizard captures it on demand via `getSkinServerUrl` IPC). Production capture (`npm run dev`) would show a line like:

```
[sei] skin server listening on http://127.0.0.1:<port>
```

The matching `curl http://127.0.0.1:<port>/skins/Sui.png` returns the bundled 220-byte Sui PNG (verified above via the standalone harness).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] Widened atomicWrite helper to accept Buffer/Uint8Array**

- **Found during:** Task 1 typecheck immediately after writing `skinStore.ts`.
- **Issue:** `src/bot/brain/storage/atomicWrite.js` hardcoded `await writeFile(tmp, contents, 'utf8')`. Passing a `Buffer` of PNG bytes would silently corrupt non-UTF-8 byte sequences (Node replaces invalid UTF-8 with U+FFFD `EF BF BD`). Typecheck caught it as `error TS2345: Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'string'`.
- **Fix:** Widened the JSDoc parameter type to `string | Uint8Array` and branched on `typeof contents === 'string'`: strings pass through with `'utf8'` (legacy behavior preserved for OWNER.md / DIARY.md callers), Buffer/Uint8Array inputs are written with no encoding flag (raw bytes). +15 LoC.
- **Why this is consistent with plan intent:** The plan explicitly says `await atomicWrite(target, pngBytes)` — i.e. it expected atomicWrite to handle a Buffer. The helper just needed widening to match. No behavioral change for existing string callers.
- **Files modified:** `src/bot/brain/storage/atomicWrite.js` (+15 / -2 LoC).
- **Commits:** Folded into Task 1 commit `f35c2e8`.

### No other deviations

No authentication gates encountered. No architectural decisions (Rule 4) triggered. No fix-attempt loops. All three tasks landed in one pass each. The atomicWrite widening was caught by typecheck on the first try.

## Known Stubs

The plan explicitly defers two skin IPC handlers to Plan 03:
- `IpcChannel.skin.uploadPng` — native file dialog + 64×64 validation. NOT registered in this plan. Renderer calls would hit "No handler registered" — Plan 03 lands the handler.
- `IpcChannel.skin.searchMojang` — Mojang username → UUID → texture URL lookup. NOT registered in this plan. Same deferral.

These are NOT stubs in the deferred-functionality sense — they are intentional Plan-03 scope and the Plan 01 summary already enumerated them. Listed here for the verifier's transparency:

| RendererApi method | Handler ships in | Status |
|--------------------|------------------|--------|
| applySkin | THIS plan (02) | shipped — Task 3 |
| removeSkin | THIS plan (02) | shipped — Task 3 |
| getSkinServerUrl | THIS plan (02) | shipped — Task 3 |
| uploadSkinPng | Plan 03 | not registered here |
| searchMojangSkin | Plan 03 | not registered here |

No data-source stubs in the UI sense — this plan ships zero renderer code. Plan 06 wires the SkinEditor UI against the IPC methods registered here.

## Threat Flags

None. The plan's threat register (T-09-S1, T-09-T1, T-09-I1, T-09-D1, T-09-E1) was addressed in implementation:

- **T-09-T1 (Tampering — applyPng PNG validation):** Magic-byte check (offsets 0-3 against `89 50 4E 47`) + IHDR width/height (offsets 16/20, must be 64×64). Atomic write via `withFileLock` + `atomicWrite` prevents partial writes. Skin descriptor + username persisted in ONE saveCharacter call (WARNING 5 atomicity).
- **T-09-I1 (Info Disclosure — path traversal):** Regex `^/skins/([A-Za-z0-9_]{1,16})\.png(\?.*)?$` rejects any URL containing `..`, `/`, or non-username characters. Username → persona lookup is in-memory only (NEVER filesystem path concatenation). `scripts/verify-skinServer.mjs` Test 3 asserts a `..%2F..%2Fetc%2Fpasswd` request returns 404.
- **T-09-E1 (Elevation — renderer-controlled PNG write path):** `IdSchema` regex `/^[a-z0-9][a-z0-9-]{0,62}$/` rejects any string containing `.`, `/`, `\\`, null, or whitespace BEFORE it reaches `paths.skinPngPath(id)`. Plus `path.join` normalization. Acceptance criterion `grep -c "IdSchema" src/main/ipc.ts → 8 (≥2)` confirms the validator is referenced at every skin:* handler.
- **T-09-S1 (Spoofing — username lookup):** Accepted per the plan — loopback-only bind means LAN cannot reach the server; a second local user on the same machine could just read `<userData>/skins/` directly.
- **T-09-D1 (DoS — request rate):** Accepted per the plan — single-machine, single-user, loopback.

No new trust boundaries introduced beyond what the threat register covers.

## Self-Check: PASSED

Verified all claimed files exist and all claimed commits are reachable:

```
FOUND: src/main/skinStore.ts (created, 220 LoC)
FOUND: src/main/skinServer.ts (created, 136 LoC)
FOUND: scripts/verify-skinServer.mjs (created, 115 LoC)
FOUND: src/main/paths.ts (modified)
FOUND: src/main/ipc.ts (modified)
FOUND: src/main/index.ts (modified)
FOUND: src/main/botSupervisor.ts (modified)
FOUND: src/bot/index.js (modified)
FOUND: src/bot/brain/storage/atomicWrite.js (modified)
FOUND: package.json (modified — verify:phase9-skin-server script)
FOUND: commit f35c2e8 (Task 1)
FOUND: commit 886c785 (Task 2)
FOUND: commit 62ea0c8 (Task 3)
```
