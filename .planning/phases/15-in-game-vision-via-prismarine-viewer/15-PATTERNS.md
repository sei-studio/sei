# Phase 15: In-Game Vision via prismarine-viewer - Pattern Map

**Mapped:** 2026-06-04
**Files analyzed:** 14 (8 net-new, 6 modified)
**Analogs found:** 13 / 14 (one net-new render module has no in-repo analog — see No Analog Found)

> Read order for the planner: this file pairs every Phase-15 file with the
> closest existing file to copy from, plus the exact lines + excerpts. Where a
> file is net-new, the analog gives the registration/gate/store shape; the
> novel logic (render path, LOS math) comes from 15-RESEARCH.md §"Code Examples".

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/bot/adapter/minecraft/render/povRenderer.js` | render-module (helper) | transform (world→PNG) | *(none — see No Analog Found)* | none |
| `src/bot/adapter/minecraft/behaviors/visualize.js` | behavior (action handler) | transform / request-response | `behaviors/lookAt.js`, `behaviors/pathfind.js` | role-match (timeout+abort behavior) |
| `src/bot/adapter/minecraft/observers/lineOfSight.js` | observer (helper) | transform (geometry) | `observers/targeting.js` | role-match (mineflayer geometry helper) |
| `src/bot/adapter/minecraft/registry.js` (EDIT) | registration site | — | self (existing `register(...)` calls) | exact |
| `src/bot/adapter/minecraft/prompts.js` (EDIT) | action-description | — | self (`ACTION_DESCRIPTIONS`) | exact |
| `src/bot/brain/llm/messageMappers.js` (EDIT) | provider-adapter | transform (wire-format) | self (`anthropicToOpenAIMessages` / `anthropicToGeminiContents`) | exact |
| `src/bot/brain/orchestrator.js` (EDIT) | orchestrator | request-response | self (`combinedToolsFor`, `appendUserTurn`/`appendToolResults` callers) | exact |
| `src/bot/brain/loop.js` (passthrough — likely NO edit) | message buffer | — | self (`buildAnthropicPayload` unknown-block passthrough) | exact |
| `src/bot/config.js` (EDIT) | config | — | self (`ConfigSchema` nested `z.object(...).default({})`) | exact |
| `proxy/src/rateLimit/visionHourlyGate.ts` | proxy-gate | request-response (middleware) | `personaDailyGate.ts` | exact |
| `proxy/src/rateLimit/buckets.ts` (EDIT) | proxy-gate | — | self (`BucketKind` union) | exact |
| `proxy/src/app.ts` (EDIT) | route-wiring | request-response | self (`/free/v1/messages` mount) | exact |
| `src/renderer/src/components/VisionAutoRenderConfirmModal.tsx` | renderer-component (modal) | event-driven | `SwitchBackendConfirmModal.tsx` (→ `SignOutConfirmModal.module.css`) | exact |
| `src/renderer/src/screens/SettingsScreen.tsx` (EDIT) | renderer-screen | event-driven | self (dev-console toggle row + `pendingSwitch` modal trigger) | exact |
| `src/renderer/src/lib/playtimeEstimate.ts` (EDIT) | renderer-utility | transform | self (`DEFAULT_TOKENS_PER_MIN` + `tokensRemainingToPlaytime`) | exact |

---

## Pattern Assignments

### `src/bot/adapter/minecraft/behaviors/visualize.js` (behavior, transform / request-response)

**Analogs:** `src/bot/adapter/minecraft/behaviors/lookAt.js` (timeout+abort race shape), `src/bot/adapter/minecraft/behaviors/pathfind.js` (wall-clock timeout + cleanup discipline).

The visualize handler must (per CLAUDE.md "every external call has a timeout") wrap `renderPov` in a `Promise.race` against a timer + abort signal, exactly like `lookAt`. Copy the **handler signature** `(args, bot, config)` and the **abort/timeout race** from `lookAt.js`:

**Handler signature + abort-first + timeout/abort race** (`lookAt.js:7-39`):
```javascript
export async function lookAtAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const timeoutMs = args.timeout_ms ?? config?.lookAt_timeout_ms ?? DEFAULT_TIMEOUT_MS
  // ... opPromise = bot.lookAt(...).then(()=>'looked').catch(()=>'cannot look')
  const tmo  = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))
  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })
  return Promise.race([opPromise, tmo, abrt])
}
```

**Timer/listener cleanup after the race** (the stricter discipline — copy from `pathfind.js:104-112`, since a render that resolves first must not leave an orphan timer/listener that later tears down a *reused* GL context — see RESEARCH Pitfall 5):
```javascript
const result = await Promise.race(racers)
if (timeoutHandle != null) clearTimeout(timeoutHandle)
if (signal && abortListener) {
  try { signal.removeEventListener('abort', abortListener) } catch {}
}
```

**Degrade-string return convention (VIS-08):** handlers return a short *string* on failure (`'timeout'`, `'cannot look'`, `'cant_reach (...)'`), never throw. visualize returns the degrade copy (e.g. `"I can't see clearly right now"`) as its tool_result string when chunks aren't loaded — same contract as every behavior in this folder.

**Novel logic (NOT in any analog):** the actual `renderPov()` call, the ~256px JPEG downscale, and the idle frame-dedupe hash live in 15-RESEARCH.md §"Pattern 1" and §"Code Examples". The analog gives only the wrapper discipline.

---

### `src/bot/adapter/minecraft/observers/lineOfSight.js` (observer, transform / geometry)

**Analog:** `src/bot/adapter/minecraft/observers/targeting.js`

Copy the **module shape** of an observer helper: top-of-file `import { Vec3 } from 'vec3'` + `import mcDataLib from 'minecraft-data'`, exported pure functions taking `(args/entity, bot)`, and the **defensive null-guard idiom** used throughout `resolveEntity`/`resolveEntityByName`.

**Import + entity-iteration idiom** (`targeting.js:1-2`, `:138-153`):
```javascript
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
// ...
function resolveEntityByName(name, bot) {
  const me = bot.entity
  return bot.nearestEntity((e) => {
    if (!me?.position || !e?.position) return true
    try { return e.position.distanceTo(me.position) <= NAMED_ENTITY_MAX_DIST }
    catch { return true }
  }) ?? null
}
```

**Reuse `bot.blockAt(new Vec3(...))` for ray-stepping** (already the pattern in `targeting.js:64` and `:74` for block resolution):
```javascript
return bot.blockAt(new Vec3(x, y, z))
```

**Novel logic:** the ray-march + `block.shapes`/fluid/entity-AABB occlusion test is in 15-RESEARCH.md §"Custom LOS helper (VIS-05)". Pull `FLUID_NAMES`, `hasClearLineOfSight`, `pointInAnyShape`, `segmentIntersectsEntityAABB` from there. The analog only supplies the file skeleton + bot-access idioms. **Do NOT use `bot.world.raycast`** (RESEARCH Pitfall 3 / VIS-05).

---

### `src/bot/adapter/minecraft/registry.js` (EDIT — conditional `visualize` registration)

**Analog:** the file itself — every existing `registry.register(name, zodSchema, handler)` call (`registry.js:118-371`).

**Registration call shape to copy** (`registry.js:329-338`, the `lookAt` registration — closest peer to `visualize`):
```javascript
registry.register(
  'lookAt',
  z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    entity: z.string().optional(),
    target: z.string().optional(),
  }),
  lookAtAction
)
```

**`visualize` is net-new in two ways vs every existing call:**
1. **Its Zod schema is essentially empty** — clone the `z.object({})` shape used by `unfollow`/`activateItem` (`registry.js:310`, `:349`): `registry.register('activateItem', z.object({}), activateItemAction)`.
2. **Registration is CONDITIONAL on `capabilities.vision`** (D-10) — *unlike* every unconditional call here. `createDefaultRegistry()` is unconditional today, so this is the net-new seam. Per RESEARCH §"Pattern 3" the recommended belt-and-suspenders is to filter at the orchestrator tool-list level AND skip registration here. To skip here, `createDefaultRegistry()` needs a `visionEnabled` flag threaded in:
```javascript
export function createDefaultRegistry({ visionEnabled = false } = {}) {
  // ... existing registers ...
  if (visionEnabled) {
    registry.register('visualize', z.object({}), visualizeAction)
  }
  return registry
}
```
   The caller is `createMinecraftAdapter` (`adapter/minecraft/index.js:38`: `const registry = createDefaultRegistry()`) — it must pass `{ visionEnabled }` derived from the provider's `capabilities.vision`. **Note:** the adapter is constructed without the provider today; the planner must decide whether to thread `visionEnabled` through `createMinecraftAdapter({ bot, config, visionEnabled })` or do the filtering solely at the orchestrator tool-list level (next section). Orchestrator-level filtering is the lower-friction single seam.

---

### `src/bot/brain/orchestrator.js` (EDIT — tool-list filter + fresh image user-turn)

**Analog:** the file itself.

**(a) Drop `visualize` from the tool list when provider lacks vision** — `combinedToolsFor()` (`orchestrator.js:364-381`) already merges personality + movement tools. The provider handle `anthropic` exposes `.capabilities` (`anthropicProvider.js:8` / `llm/index.js:8`). RESEARCH §"Pattern 3" excerpt:
```javascript
// orchestrator.js combinedToolsFor() — drop visualize when provider lacks vision
const visionOk = !!anthropic.capabilities?.vision
const movementTools = buildAnthropicTools(subRegistry, descMap)
  .filter(t => visionOk || t.name !== 'visualize')
```
Apply the `.filter` to the `movementTools` line at `orchestrator.js:374`.

**(b) Append the rendered frame as a FRESH user turn (VIS-02)** — NOT inside a tool_result. The tool_result for `visualize` stays a short text string ("rendered — view attached"); the image rides a new user turn. The orchestrator already appends user turns through the Loop API. Copy the **`appendUserTurn([...])` named-block call shape** used by `repairAfterAbort`/`gracefulCapClose` (`orchestrator.js:2113-2116`, `:2130-2133`):
```javascript
loop.appendUserTurn([
  { type: 'text', name: 'event',    text: eventTextWithHint },
  { type: 'text', name: 'snapshot', text: snapshotText() },
])
```
The image turn follows the same call but carries the provider-neutral image block (which `loop.js` passes through untouched — see next section):
```javascript
loop.appendUserTurn([
  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: <b64> } },
  { type: 'text', name: 'event', text: 'rendered view attached' },
])
```
The existing tool_result-string construction to mirror for the paired text result is the `handleActionComplete` slot-fill at `orchestrator.js:1180-1185`:
```javascript
pendingResults[slotIdx] = {
  type: 'tool_result', tool_use_id: pendingUse.id,
  content: data.result ?? 'done', is_error: false,
}
```

**(c) Call site for the LLM turn is unchanged** — `callPersonality` (`orchestrator.js:2159-2178`) already sends `messages: loop.buildAnthropicPayload()`. No new call shape; the image block simply rides the next `buildAnthropicPayload()`.

---

### `src/bot/brain/loop.js` (likely NO edit — verify passthrough holds)

**Analog:** the file itself — `buildAnthropicPayload()` (`loop.js:103-141`).

**Critical seam:** `buildAnthropicPayload` already deep-clones and **passes through unknown block types** (`loop.js:135-136`):
```javascript
// Unknown block type — pass through deep-cloned.
newContent.push({ ...blk })
```
So an `{ type:'image', source:{...} }` block appended via `appendUserTurn` survives into the payload unchanged. It is also exempt from the snapshot-strip rule (that rule is `if (blk.type === 'text' && blk.name === 'snapshot')`). **Therefore no loop.js edit should be needed** — the planner should confirm this with a test (mirror `messageMappers.test.js`) rather than editing loop.js. If the image block carries a `name` field, note the SDK has no `name` on image blocks either; strip it the same way text blocks are stripped (`loop.js:131`) — but cleaner to append image blocks without a `name` field at all.

---

### `src/bot/brain/llm/messageMappers.js` (EDIT — per-provider image translation, VIS-02)

**Analog:** the file itself — `anthropicToOpenAIMessages` (`:24-70`), `anthropicToGeminiContents` (`:150-195`). Both already do exactly this kind of per-provider block translation in a `for (const blk of blocks)` loop.

**Where to add the `image` case — OpenAI/Ollama** (extend the user-turn loop at `messageMappers.js:34-38`; today it only handles `text` and `tool_result`):
```javascript
for (const blk of blocks) {
  if (!blk) continue
  if (blk.type === 'text') textParts.push(blk.text)
  else if (blk.type === 'tool_result') toolResults.push(blk)
  // NEW: else if (blk.type === 'image') imageParts.push({
  //   type:'image_url',
  //   image_url:{ url:`data:${blk.source.media_type};base64,${blk.source.data}` } })
}
```
Then push a `{ role:'user', content:[...textParts, ...imageParts] }` message (OpenAI requires images on a `user` role — RESEARCH Pitfall 4). Note the current code coalesces text into a plain-string user message (`:46-48`); when an image is present the user content must become the **array form** instead.

**Gemini** — extend the user-parts loop at `messageMappers.js:166-179`:
```javascript
// NEW: else if (blk.type === 'image') parts.push({
//   inline_data:{ mime_type: blk.source.media_type, data: blk.source.data } })
```

**Anthropic** — needs NO mapper change: `anthropicClient.call` passes the `messages` array verbatim to `sdk.messages.create` (`anthropicClient.js:74,93,96`), and the Anthropic SDK natively accepts `{type:'image', source:{type:'base64',...}}`. The provider-neutral internal block IS the Anthropic wire shape (RESEARCH §"Pattern 2").

**Test analog:** `messageMappers.test.js` (same dir) — add image-translation cases mirroring its existing per-provider assertions.

---

### `src/bot/config.js` (EDIT — vision config block, D-04)

**Analog:** the file itself — every nested `z.object({...}).default({})` branch (`llm` at `:82-111`, `memory` at `:115-127`).

**Nested-block-with-defaults shape to copy** (`config.js:115-127`, the `memory` branch — closest structural peer):
```javascript
memory: z.object({
  player_md_path: z.string().default('./memory/PLAYER.md'),
  iteration_cap: z.number().int().min(1).default(30),
  // ...
}).default({}),
```

**Vision block to add** (from RESEARCH §"Vision config block (D-04)"), inserted as a top-level `ConfigSchema` field alongside `llm`/`memory`:
```javascript
vision: z.object({
  auto_render: z.boolean().default(false),                       // D-04 default OFF
  render_interval_ms: z.number().int().min(1000).default(60_000),
  image_quality: z.number().min(0.1).max(1).default(0.4),
  resolution_px: z.number().int().min(64).max(512).default(256), // VIS-06 ≤512 cap
  explicit_cap_per_hour: z.number().int().min(1).default(10),    // proxy authoritative
}).default({}),
```
The `.default({})` means existing `config.json` files parse unchanged (every sub-field has a `.default`), matching the project's no-shim stance.

---

### `proxy/src/rateLimit/visionHourlyGate.ts` (NEW, proxy-gate)

**Analog:** `proxy/src/rateLimit/personaDailyGate.ts` — near-identical structure (single bucket kind + window + `sendError` on deny).

**Whole-file shape to clone** (`personaDailyGate.ts:10-37`):
```typescript
import type { MiddlewareHandler } from 'hono';
import { checkAndIncrementBucket } from './buckets.js';
import { sendError } from '../middleware/sentinel.js';

export const PERSONA_DAILY_LIMIT = 20n;
const PERSONA_DAILY_WINDOW_SECONDS = 86_400;

export const personaDailyGate: MiddlewareHandler<{ Variables: { userId: string } }> =
  async (c, next) => {
    const userId = c.get('userId');
    const result = await checkAndIncrementBucket(
      userId, 'persona_daily', 1n, PERSONA_DAILY_LIMIT, PERSONA_DAILY_WINDOW_SECONDS);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retry_after_seconds));
      return sendError(c, {
        code: 'rate_limited', kind: result.kind,
        retry_after_seconds: result.retry_after_seconds,
      });
    }
    await next();
  };
```
For `visionHourlyGate`: swap `'persona_daily'` → `'vision_hourly'`, `20n` → `10n` (`VISION_HOURLY_LIMIT`, D-09 configurable), `86_400` → `3600`. The full target is in RESEARCH §"Proxy per-hour vision gate (VIS-07/D-09)" and matches this analog 1:1.

**Co-located test:** clone `customerPortalMinuteGate.test.ts` (same dir — closest single-bucket-gate test).

---

### `proxy/src/rateLimit/buckets.ts` (EDIT — add `vision_hourly` to `BucketKind`)

**Analog:** the file itself — the `BucketKind` union (`buckets.ts:22-29`):
```typescript
export type BucketKind =
  | 'rpm' | 'itpm' | 'otpm' | 'daily_dollar'
  | 'persona_daily' | 'reports_ip_daily' | 'customer_portal_minute';
```
Add `| 'vision_hourly'`. The `check_and_increment_bucket` RPC takes `p_bucket_kind` as free text (`buckets.ts:84-90` — `p_bucket_kind: kind`), so this is a **TS-only change with no SQL migration** (RESEARCH Open Q3 / A3 — planner must still verify the migration SQL doesn't enumerate kinds).

---

### `proxy/src/app.ts` (EDIT — mount the vision route)

**Analog:** the file itself — the `/free/v1/messages` mount (`app.ts:79-84`):
```typescript
app.post('/free/v1/messages', originLockGate, ipRateLimitGate, verifyJwt, personaDailyGate, (c) => {
  return forwardFreeToAnthropic(c, { fetchImpl: fetch, anthropicApiKey: env.ANTHROPIC_API_KEY });
});
```
**Middleware-chain order is the load-bearing pattern:** `originLockGate → ipRateLimitGate → verifyJwt → <bucketGate> → forward` (every route in `app.ts` follows this; `:63`, `:79`, `:93`). The vision route inserts `visionHourlyGate` in the bucket-gate slot, and (per RESEARCH Open Q1 / D-09) explicit-render LLM turns must hit a dedicated path (e.g. `/vision/v1/messages`) chained `originLockGate → ipRateLimitGate → verifyJwt → visionHourlyGate → rateLimitGate → forwardToAnthropic`. **Idle renders MUST NOT route here** (D-09) — only the explicit-`visualize`-triggered turn. The bot-side routing of just that one turn to the vision path is RESEARCH Open Q1 (planner to design — note `anthropicClient` has a single `baseURL` today).

---

### `src/renderer/src/components/VisionAutoRenderConfirmModal.tsx` (NEW, renderer-component)

**Analog:** `SwitchBackendConfirmModal.tsx` (which itself was "Scaffold cloned from SignOutConfirmModal").

**Whole-component scaffold to clone** (`SwitchBackendConfirmModal.tsx:13-85`) — note it imports the **shared** `SignOutConfirmModal.module.css` (no new CSS file needed; reuse `styles.scrim/.modal/.title/.body/.footer`):
```typescript
import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './SignOutConfirmModal.module.css';   // REUSE — no new .module.css

export function VisionAutoRenderConfirmModal({ onCancel, onConfirm }: Props): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !submitting) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);
  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try { await onConfirm(); } finally { setSubmitting(false); }
  };
  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onCancel(); }}>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>Turn on auto-look?</h2>
        <p className={styles.body}>{/* D-06: "uses more playtime" — NO token counts / numbers */}</p>
        <div className={styles.footer}>
          <Button kind="ghost"   size="md" onClick={onCancel}     disabled={submitting}>Cancel</Button>
          <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>Turn on auto-look</Button>
        </div>
      </div>
    </div>
  );
}
```
**Body copy constraint (D-06 / PROXY-05):** plain "uses more playtime" — no token/dollar/numeric estimate. Reuse `Button` (`kind="ghost"`/`"primary"`) and tokens via the shared module CSS (CLAUDE.md design-system rule — never literal hex/px).

---

### `src/renderer/src/screens/SettingsScreen.tsx` (EDIT — toggle row + confirm trigger)

**Analog:** the file itself — two existing patterns.

**(a) The single toggle row** — clone the "Show developer console" row (`SettingsScreen.tsx:485-495`):
```tsx
<div className={styles.row}>
  <span className={styles.rowLabel}>Show developer console</span>
  <Button kind="ghost" size="sm" aria-pressed={devConsoleVisible}
    onClick={() => void onToggleDevConsole()}>
    {devConsoleVisible ? 'On' : 'Off'}
  </Button>
</div>
```
For auto-render the toggle's `onClick` does NOT flip immediately — when turning **on** it opens the confirm modal first (D-05). When **off**, it can flip directly (turning a cost feature off needs no confirm).

**(b) Optimistic-update-then-write-through handler** — clone `onToggleDevConsole` (`SettingsScreen.tsx:300-314`): update local state first, persist via `sei.saveConfig(updated)`, roll back on failure. The vision toggle writes through to `config.vision.auto_render` (D-05 — config is source of truth).

**(c) Modal trigger via pending-state** — clone the `pendingSwitch` pattern: a `useState` holds the pending intent, the row's onClick sets it, and the modal renders conditionally at the bottom of the tree. Trigger (`SettingsScreen.tsx:668`): `onClick={() => setPendingSwitch('cloud-proxy')}`. Conditional render (`SettingsScreen.tsx:788-794`):
```tsx
{pendingSwitch ? (
  <SwitchBackendConfirmModal
    direction={pendingSwitch}
    onCancel={() => setPendingSwitch(null)}
    onConfirm={confirmSwitch}
  />
) : null}
```
Mirror this with a `pendingVisionEnable` boolean → `<VisionAutoRenderConfirmModal onCancel={...} onConfirm={confirmEnableAutoRender} />`. `confirmEnableAutoRender` does the write-through then closes the modal (mirror `confirmSwitch` at `:88-98`).

**Project pitfall (RESEARCH Pitfall 6 / CLAUDE.md):** after editing this `.tsx`, delete the sibling `SettingsScreen.js` artifact (and the new modal's stale `.js` if `tsc --build` emits one) — NEVER touch anything under `src/bot` — then restart dev, or Vite serves the stale `.js`.

---

### `src/renderer/src/lib/playtimeEstimate.ts` (EDIT — vision multiplier, D-07)

**Analog:** the file itself — `DEFAULT_TOKENS_PER_MIN` (`:34`) + `tokensRemainingToPlaytime(remainingTokens, tokensPerMin)` (`:57-81`).

The function already accepts `tokensPerMin` as its second arg (`:59`). D-07 is a **multiplied rate passed in**, not a new code path (RESEARCH §"Playtime shrink (D-07)"):
```typescript
export const VISION_MULTIPLIER = 1.4; // Claude's discretion 1.3–1.5×; honest heavier-usage estimate
// caller (CreditsScreen / UsageBar / IconRail):
const rate = autoRenderOn ? DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER : DEFAULT_TOKENS_PER_MIN;
tokensRemainingToPlaytime(remaining_tokens, rate);
```
A higher effective `tokensPerMin` shrinks the `~Xh left` figure (`:65` `rawMin = remainingTokens / tokensPerMin`). The `autoRenderOn` flag comes from `config.vision.auto_render` (read wherever the screen reads config). **No UI rewrite** — same display strings, smaller number. PROXY-05 holds: still percent/time only, no token counts surfaced.

**Test analog:** `playtimeEstimate` has no co-located test in the listing; mirror `useCreditsStore.test.ts` / `SettingsScreen.test.tsx` style if adding one.

---

## Shared Patterns

### Wall-clock timeout on every external call (CLAUDE.md invariant)
**Source:** `behaviors/pathfind.js:71-112` (`Promise.race([navigationPromise, timeoutPromise, abortPromise])` + post-race `clearTimeout`/`removeEventListener`), `behaviors/lookAt.js:32-39`.
**Apply to:** `povRenderer.js` / `visualize.js` (wrap `renderPov` incl. `waitForChunksToRender`), and any bot→proxy vision call. Return a degrade *string*, never throw/hang.

### Closed-registry Zod action shape
**Source:** `registry.js:329-349` (`registry.register(name, z.object({...}), handler)`); empty-schema form `z.object({})` at `:310,:349`.
**Apply to:** `visualize` registration. Never widen the registry to run generated code (CLAUDE.md closed-registry invariant).

### Provider-neutral block translation in one seam
**Source:** `messageMappers.js` per-block loops (`:34-38` OpenAI, `:166-179` Gemini); Anthropic passthrough at `anthropicClient.js:93-96`.
**Apply to:** the new `image` block — single seam in `messageMappers.js`; orchestrator + loop.js stay provider-agnostic.

### Proxy bucket gate (server-authoritative cap)
**Source:** `personaDailyGate.ts` (whole file) + `buckets.ts:74-104` (`checkAndIncrementBucket`) + `app.ts:79` chain order.
**Apply to:** `visionHourlyGate.ts` + `BucketKind` union + the `/vision/v1/messages` mount. Cap is server-side (D-09 / ASVS V4) — never trust a bot-side count.

### Renderer confirm-modal scaffold
**Source:** `SwitchBackendConfirmModal.tsx` (clone) → reuses `SignOutConfirmModal.module.css`. Escape-to-cancel `useEffect`, scrim-click cancel, `submitting` guard, `Button kind="ghost"|"primary"`.
**Apply to:** `VisionAutoRenderConfirmModal.tsx`. No new CSS file; reuse the shared module + tokens (CLAUDE.md design system).

### Settings toggle: optimistic update → write-through → rollback
**Source:** `SettingsScreen.tsx:300-314` (`onToggleDevConsole`) + `pendingSwitch` modal trigger (`:668`, `:788-794`) + `confirmSwitch` (`:88-98`).
**Apply to:** the auto-render toggle row + its confirm flow, writing through to `config.vision.auto_render`.

### Config: nested block with all-defaulted fields
**Source:** `config.js:115-127` (`memory: z.object({...}).default({})`).
**Apply to:** the `vision` block — every field `.default(...)` + outer `.default({})` so legacy `config.json` parses unchanged.

### Idle (P3) tick reuse — no new scheduler
**Source:** `brain/fsm.js:83-85` (`idleTimer` → `enqueue(Priority.P3_IDLE, 'sei:idle', {})`); `brain/index.js:113,205` (`sei:idle` routing). The 60s idle tick already exists.
**Apply to:** idle auto-render — hook the existing `sei:idle` dispatch path (gate on `config.vision.auto_render` + 16-block + LOS); do NOT add a timer.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/bot/adapter/minecraft/render/povRenderer.js` | render-module | transform (world→PNG) | No headless-3D/native-GL render code exists anywhere in the repo (`prismarine-viewer`/`node-canvas-webgl`/`gl`/`canvas` are not yet dependencies — RESEARCH Standard Stack). The render path has no in-repo precedent; planner uses **15-RESEARCH.md §"Pattern 1: Direct single-frame headless render"** as the source. The *only* repo conventions that apply are the wall-clock-timeout wrapper (from `pathfind.js`/`lookAt.js`) and the new-file-under-adapter/minecraft placement (RESEARCH §"Recommended Project Structure"). This is also the phase's highest-risk task (native ABI rebuild — RESEARCH Pitfall 1) and should be de-risked against a packaged build first. |

---

## Metadata

**Analog search scope:** `src/bot/adapter/minecraft/{behaviors,observers}`, `src/bot/adapter/minecraft/{registry,index}.js`, `src/bot/registry.js`, `src/bot/brain/{orchestrator,loop,index,fsm}.js`, `src/bot/brain/llm/{index,anthropicProvider,messageMappers,anthropicClient}.js`, `src/bot/config.js`, `proxy/src/rateLimit/{personaDailyGate,buckets}.ts`, `proxy/src/app.ts`, `src/renderer/src/components/{SwitchBackendConfirmModal,SignOutConfirmModal}.tsx`, `src/renderer/src/screens/SettingsScreen.tsx`, `src/renderer/src/lib/playtimeEstimate.ts`, `src/renderer/src/lib/stores/useCreditsStore.ts`.
**Files scanned (read in full or targeted):** 16
**Skills loaded:** none (no `.claude/skills/` or `.agents/skills/` directory present)
**Pattern extraction date:** 2026-06-04
