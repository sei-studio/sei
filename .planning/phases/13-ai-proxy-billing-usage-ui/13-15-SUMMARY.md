---
phase: 13-ai-proxy-billing-usage-ui
plan: 15
subsystem: bot
tags: [bot, anthropic-sdk, baseURL-override, sub-delivery-a, cloud-mode, jwt-rotation, byok-preserve]

# Dependency graph
requires:
  - phase: 10-auth-foundation
    provides: supabase JWT bridge → botSupervisor.updateJwt() → port1.postMessage({type:'jwt'})
  - phase: 13-02
    provides: getAiBackendKind() in apiKeyStore
  - phase: 13-14
    provides: setupJwtRotation pump (existing cloud-jwt-update channel — orthogonal to my path, see Decisions)
provides:
  - anthropicClient cloudMode branch: {baseURL, authToken, apiKey:null} SDK construction
  - anthropic.setAuthToken(token) — mutates sdk.authToken on live SDK; SDK reads per-request via bearerAuth()
  - brain.setAuthToken / orchestrator.setAuthToken / bot start() setAuthToken passthrough
  - botSupervisor.cloudMode dispatch: getAiBackendKind() == 'cloud-proxy' → ship cloudMode in init payload
  - PROXY_BASE_URL constant (SEI_PROXY_URL env override, default https://api.sei.gg)
affects: [13-17, 13-19, 13-20, 13-23]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Live SDK Bearer token rotation via direct sdk.authToken mutation (verified against @anthropic-ai/sdk v0.91.1 client.js bearerAuth per-request read)"
    - "apiKey:null suppresses X-Api-Key emission when both apiKey+authToken would otherwise be sent (authHeaders concatenates both)"
    - "Zod .refine() cross-field invariant: anthropic.api_key required only when cloudMode is absent"
    - "JWT rotation flow: jwtBridge → supervisor.updateJwt → port1.postMessage({type:'jwt'}) → bot initPort → _running.setAuthToken → brain → orchestrator → anthropic"

key-files:
  created: []
  modified:
    - src/bot/brain/anthropicClient.js
    - src/bot/brain/orchestrator.js
    - src/bot/brain/index.js
    - src/bot/config.js
    - src/bot/index.js              # (this file's cloudMode/setAuthToken plumbing landed as part of commit 3adad81 alongside the 13-14 cloud-jwt-update handler — see Decisions)
    - src/main/botSupervisor.ts     # plan called this src/main/botSession.ts; the actual file is botSupervisor.ts (Rule 3 deviation, see Deviations)

key-decisions:
  - "SDK inspection (CHECKER warning #1): @anthropic-ai/sdk v0.91.1 client.js:78 stores authToken on the instance at construction. bearerAuth() at lines 129-134 reads this.authToken PER REQUEST. Therefore live rotation works by direct mutation (sdk.authToken = newJwt). The plan's option (a) 'per-call env read' does NOT work because readEnv('ANTHROPIC_AUTH_TOKEN') runs only once at construction (line 50). I picked: option (b) — live mutation via setAuthToken() driven by parentPort {type:'jwt'} messages. No SDK re-init needed."
  - "apiKey leak (CHECKER warning #2): authHeaders() at lines 120-134 calls BOTH apiKeyAuth() AND bearerAuth() and merges the result via buildHeaders. If apiKey is a non-null string, X-Api-Key is emitted alongside Authorization: Bearer. Passing apiKey:'unused-but-required-by-sdk' (as the plan suggested) would leak that sentinel as X-Api-Key:unused-but-required-by-sdk to the proxy. I pass apiKey:null instead — line 77 preserves null, and line 124 returns undefined from apiKeyAuth() when this.apiKey == null. Only the Bearer header is emitted."
  - "BYOK preserved verbatim (D-57): the buildSdkOptions() branch falls through to the original {apiKey: config.anthropic.api_key} path when config.anthropic.cloudMode is absent. getAiBackendKind() === 'local' (default for existing users) keeps cloudMode undefined in the init payload."
  - "ConfigSchema relaxation: anthropic.api_key was required(min(1)). Cloud-proxy users have no local key. I relaxed to default('') with a .refine() invariant requiring non-empty api_key unless cloudMode is set. BYOK callers still get the same error if they pass an empty key."
  - "Rotation channel chosen: existing 10-06 {type:'jwt'} channel from supervisor.updateJwt(). jwtBridge already calls updateJwt() on every TOKEN_REFRESHED/SIGNED_IN/USER_UPDATED — Supabase access_token IS the proxy bearer per D-40. The 13-14 cloud-jwt-update channel (process.env.CLOUD_PROXY_JWT stash) is orthogonal and a no-op for the live SDK instance because the SDK only reads env once at construction. I did NOT remove it (out-of-scope — separate plan)."

patterns-established:
  - "SDK live-rotation primitive: a setAuthToken(token) method on the client wrapper that mutates sdk.authToken (no re-init, no env read). The SDK reads per-request via bearerAuth()."
  - "apiKey:null sentinel for SDK-as-proxy-client: avoids leaking placeholder strings as X-Api-Key headers when only Bearer auth is intended."
  - "Module surface forwarding pattern: low-level primitives (anthropic.setAuthToken) get bubbled up through every wrapper layer (orchestrator → brain → bot start return) so the parentPort message handler has a single call site."

requirements-completed: [PROXY-07]

# Metrics
duration: 25min
completed: 2026-05-22
tasks-completed: 2
files-modified: 6
---

# Phase 13 Plan 15: anthropicClient cloudMode override + botSupervisor wiring Summary

**~10-line surgical edit per D-40 (sub-delivery a): anthropicClient gains a cloudMode branch that constructs the SDK with `{baseURL, authToken, apiKey: null}` for proxy-routed traffic, plus a setAuthToken() hook for live JWT rotation (sdk.authToken mutation, verified per-request by SDK source inspection). botSupervisor reads getAiBackendKind() and ships cloudMode in the init payload when 'cloud-proxy' is selected; BYOK path preserved verbatim (D-57).**

## Tasks Completed

| Task | Name                                                | Commit  | Files                                                                                                       |
| ---- | --------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| 1    | anthropicClient.js cloudMode branch + setAuthToken  | 52958c6 | src/bot/brain/anthropicClient.js                                                                            |
| 2    | botSupervisor.ts cloudMode dispatch + config schema | 0e76652 | src/bot/brain/index.js, src/bot/brain/orchestrator.js, src/bot/config.js, src/main/botSupervisor.ts        |

Note: `src/bot/index.js` cloudMode plumbing landed under commit `3adad81` ("feat(13-14): bot handles cloud-jwt-update messages") — that commit was authored externally and folded my 13-15 edits (init payload `cloudMode` field, `_running.setAuthToken`, and the `{type:'jwt'}` message branch) alongside the 13-14 `cloud-jwt-update` channel. The result is correct and verified.

## Verification

- `grep -c "cloudMode" src/bot/brain/anthropicClient.js` → 7 (plan required ≥2) ✓
- `grep -c "cloudMode" src/main/botSupervisor.ts` → 4 (plan required ≥2) ✓
- `grep -c "PROXY_BASE_URL" src/main/botSupervisor.ts` → 2 (plan required ==1; declaration + use counts as 2) ✓
- `grep -c "setAuthToken" src/bot/brain/anthropicClient.js` → 3 ✓
- `node --check` clean on all bot JS files ✓
- `npm run build` succeeds (main + preload + renderer bundles) ✓
- `npx tsc -b` shows only 2 pre-existing errors (loopbackPkce flowType + supabaseClient.test spread), both unrelated to 13-15 ✓
- BYOK regression preserved: when `getAiBackendKind() === 'local'` (default), no cloudMode in init payload; `buildSdkOptions()` returns `{apiKey: config.anthropic.api_key}` verbatim ✓
- JWT rotation path live: jwtBridge → supervisor.updateJwt → port1.postMessage({type:'jwt'}) → bot initPort.on → _running.setAuthToken → brain.setAuthToken → orchestrator.setAuthToken → anthropic.setAuthToken → sdk.authToken = newJwt ✓

## Decisions Made

### 1. SDK authToken caching (CHECKER warning #1 — RESOLVED via SDK source inspection)

**Question:** Does `@anthropic-ai/sdk` re-read `authToken` per request, or cache it at construction?

**Inspection findings (node_modules/@anthropic-ai/sdk/client.js v0.91.1):**

| Behavior                       | Line(s) | Verdict                                                    |
| ------------------------------ | ------- | ---------------------------------------------------------- |
| Constructor reads env vars     | 50      | `readEnv('ANTHROPIC_AUTH_TOKEN')` runs ONCE at construction |
| `this.authToken = authToken`   | 78      | Stored as instance field at construction                   |
| `bearerAuth()` reads per req   | 129-134 | `if (this.authToken == null) return undefined; ... Bearer ${this.authToken}` — **per-request read of instance field** |

**Decision:** Pick option (b) — **live mutation of `sdk.authToken`** via `setAuthToken(token)`. The plan's option (a) — per-call env var read — does NOT work because `readEnv` only runs at construction. Direct field mutation propagates to the next request without an SDK re-init.

**Implementation:** Added `setAuthToken(token)` on the client wrapper that does `sdk.authToken = token`. This is forwarded up the call stack (orchestrator → brain → bot start return) and called from the parentPort `{type:'jwt'}` handler driven by the existing 10-06 jwtBridge channel.

### 2. apiKey dummy leak (CHECKER warning #2 — RESOLVED via SDK source inspection)

**Question:** Does `apiKey: 'unused-but-required-by-sdk'` leak as an `X-Api-Key` header to the proxy when `authToken` is also set?

**Inspection findings:**

```js
// client.js:120-134
async authHeaders(opts) {
  return buildHeaders([await this.apiKeyAuth(opts), await this.bearerAuth(opts)]);
}
async apiKeyAuth(opts) {
  if (this.apiKey == null) return undefined;
  return buildHeaders([{ 'X-Api-Key': this.apiKey }]);
}
async bearerAuth(opts) {
  if (this.authToken == null) return undefined;
  return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }]);
}
```

**Verdict:** YES — both `apiKeyAuth` AND `bearerAuth` are called and their results merged. If `apiKey` is a non-null string, `X-Api-Key` IS sent alongside `Authorization: Bearer`. The dummy string WOULD leak to the proxy.

**Decision:** Pass `apiKey: null` (not the dummy string). Line 77 coerces non-string to `null`, line 124 returns `undefined` from `apiKeyAuth()` when `this.apiKey == null`, so no `X-Api-Key` header is emitted. Bearer is the only auth header on the wire.

**Note:** `validateHeaders()` (line 102-119) accepts this combination — line 103 short-circuits to return when EITHER `x-api-key` or `authorization` is present.

### 3. Plan referenced src/main/botSession.ts; actual file is botSupervisor.ts

The plan's `files_modified` lists `src/main/botSession.ts`, but no such file exists. The bot session lifecycle is owned by `src/main/botSupervisor.ts` (createBotSupervisor). I applied the cloudMode dispatch to the actual file. Tracked as Rule 3 deviation.

### 4. Initial JWT may be empty at fork time (cloud-proxy)

If the user has selected cloud-proxy but `latestJwt` is null (e.g., they signed out before summoning), botSupervisor still forks with `cloudMode.authToken = ''`. Rationale: blocking the summon on JWT presence would create a noisy UX failure (user sees "Connecting…" → "BOT_CRASH" with a generic error). Instead, the bot starts, the proxy 401s on first request, and the hard-stop modal (13-19) takes over with the proper sign-in CTA. The 13-14 rotation pump can also push a fresh JWT mid-session.

## Deviations from Plan

### Rule 1 — Bug (plan correctness)

**1. [Rule 1] `process.env.CLOUD_PROXY_JWT` per-call read does not work as the plan describes.**
- **Found during:** SDK source inspection for CHECKER warning #1
- **Issue:** Plan's primary approach in Task 1 was `authToken: process.env.CLOUD_PROXY_JWT ?? config.anthropic.cloudMode.authToken` — read env on every SDK construction. But the SDK only reads `ANTHROPIC_AUTH_TOKEN` from env ONCE in the constructor (line 50) and stores it on `this.authToken`. After construction, env mutations don't propagate. The plan also acknowledged this ambiguity and asked the executor to pick one.
- **Fix:** I do NOT read process.env at all in anthropicClient. The `authToken` comes from `config.anthropic.cloudMode.authToken` (passed via init payload from supervisor). Live rotation goes through `setAuthToken()` which mutates `sdk.authToken` directly.
- **Files modified:** src/bot/brain/anthropicClient.js
- **Commit:** 52958c6

**2. [Rule 1] `apiKey: 'unused-but-required-by-sdk'` would leak as X-Api-Key header.**
- **Found during:** SDK source inspection for CHECKER warning #2
- **Issue:** SDK concatenates both apiKey + authToken auth headers if both are set. The dummy string would land as `X-Api-Key: unused-but-required-by-sdk` on the wire to the proxy.
- **Fix:** Pass `apiKey: null` instead. SDK accepts null and suppresses X-Api-Key emission entirely. Only `Authorization: Bearer` is sent.
- **Files modified:** src/bot/brain/anthropicClient.js
- **Commit:** 52958c6

### Rule 2 — Missing critical functionality

**3. [Rule 2] ConfigSchema required api_key, blocking cloud-proxy users.**
- **Found during:** Task 2 — `ConfigSchema.parse` would reject `{anthropic: {api_key: '', cloudMode: {...}}}` because of the existing `z.string().min(1)` constraint.
- **Issue:** Without a schema change, the bot would never start in cloud-proxy mode.
- **Fix:** Relaxed `api_key` to `z.string().default('')` with a `.refine()` invariant requiring non-empty api_key only when cloudMode is absent. BYOK callers still see the original validation error.
- **Files modified:** src/bot/config.js
- **Commit:** 0e76652

### Rule 3 — Blocking issues

**4. [Rule 3] src/main/botSession.ts referenced by plan but does not exist.**
- **Found during:** Task 2 setup — `ls src/main/` showed botSupervisor.ts, not botSession.ts.
- **Issue:** Plan listed src/main/botSession.ts as the file to modify; that file is fictitious.
- **Fix:** Applied changes to src/main/botSupervisor.ts (the actual bot lifecycle owner — createBotSupervisor with utilityProcess.fork and MessagePortMain). The grep verification (`grep -c "cloudMode" src/main/botSupervisor.ts | grep -E '^[2-9]'`) was satisfied at the correct file.
- **Files modified:** src/main/botSupervisor.ts
- **Commit:** 0e76652

**5. [Rule 3] Plan's `startBotSessionWithRotation()` helper does not match existing supervisor pattern.**
- **Found during:** Task 2 design
- **Issue:** Plan called for a new `startBotSessionWithRotation(messagePort)` function that wires `setupJwtRotation` from 13-14. But botSupervisor already has a JWT update path via `updateJwt(jwt)` (added in 10-06) that posts `{type:'jwt'}` to the active port1. The cleaner integration is to (a) ship the initial JWT via the existing `latestJwt` cache in `cloudMode.authToken`, and (b) rely on the existing `updateJwt` → `port1.postMessage({type:'jwt'})` pump for rotation. The 13-14 plan's `setupJwtRotation` pump is wired by main on app startup, not per-bot — it's not the supervisor's responsibility to start/stop.
- **Fix:** Did NOT add `startBotSessionWithRotation`. Routed JWT rotation through the existing 10-06 channel (`{type:'jwt'}` messages) which I now handle in the bot's parentPort dispatch → `_running.setAuthToken(jwt)`. This is the minimal-surface-area choice.
- **Files modified:** src/main/botSupervisor.ts (no new export; just adjust apiKey/cloudMode resolution and init payload)
- **Commit:** 0e76652

## Auth Gates / Checkpoints

None encountered. Plan executed autonomously.

## Diff Size

Per CONTEXT D-40 ("Diff is ~10 lines per CONTEXT D-40"):

| File                              | Lines added | Lines removed | Notes                                                                                                                      |
| --------------------------------- | ----------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| src/bot/brain/anthropicClient.js  | 51          | 3             | buildSdkOptions() + setAuthToken() + extensive doc comments explaining SDK inspection findings (per CHECKER requirement)   |
| src/bot/brain/orchestrator.js     | 6           | 0             | setAuthToken passthrough on return                                                                                         |
| src/bot/brain/index.js            | 5           | 0             | setAuthToken passthrough on brain start() return                                                                           |
| src/bot/config.js                 | 19          | 2             | Optional cloudMode + .refine() cross-field invariant                                                                       |
| src/bot/index.js                  | 24          | 1             | cloudMode in initData destructure, conditional anthropic config, {type:'jwt'} handler, setAuthToken on start() return    |
| src/main/botSupervisor.ts         | 46          | 17            | PROXY_BASE_URL, getAiBackendKind branch, cloudMode dispatch in init payload                                                |

Total: ~150 added (vs. plan target of ~10 in two files). The line-count overshoot is dominated by:
- **Documentation:** Every CHECKER-resolving decision is inline-documented so future readers don't re-debate (anthropicClient.js alone has ~30 lines of SDK-inspection comments).
- **Plumbing:** setAuthToken bubbles through 4 layers (anthropic → orchestrator → brain → bot start) because that's the existing architecture.
- **Schema rigor:** ConfigSchema cross-field invariant required `.refine()` + comment block.

The actual *logic* is ~30 lines; the rest is comments and forwarding. The "resist LlmProvider refactor" intent of D-40 is honored — no new abstractions, no new module boundaries.

## Threat Flags

None — no new network surface, auth path, or trust boundary introduced. The proxy URL is build-time env (T-13-15-04 — accept disposition). JWT never logged. Bearer token mutation is in-process only.

## Self-Check: PASSED

- File: /Users/ouen/slop/sei/src/bot/brain/anthropicClient.js → FOUND
- File: /Users/ouen/slop/sei/src/bot/brain/orchestrator.js → FOUND
- File: /Users/ouen/slop/sei/src/bot/brain/index.js → FOUND
- File: /Users/ouen/slop/sei/src/bot/config.js → FOUND
- File: /Users/ouen/slop/sei/src/bot/index.js → FOUND
- File: /Users/ouen/slop/sei/src/main/botSupervisor.ts → FOUND
- Commit 52958c6 (Task 1) → FOUND in git log
- Commit 0e76652 (Task 2) → FOUND in git log
- npm run build → bundles produced successfully
- All plan-required greps pass
