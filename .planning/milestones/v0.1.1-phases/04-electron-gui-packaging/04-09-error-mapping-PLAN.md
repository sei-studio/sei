---
phase: 04-electron-gui-packaging
plan: 09
type: execute
wave: 7
depends_on: [01, 02, 05, 06, 07, 08]
files_modified:
  - src/renderer/src/lib/errors.ts
  - src/renderer/src/screens/OnboardingScreen.tsx
  - src/renderer/src/screens/CharacterPage.tsx
  - src/renderer/src/components/Banner.tsx
  - src/renderer/src/App.tsx
  - src/main/botSupervisor.ts
autonomous: true
requirements: [GUI-05]
must_haves:
  truths:
    - "Every renderer-side ErrorClass surfaces a plain-English message + action hint via lib/errors.ts ERROR_COPY map"
    - "Model row on CharacterPage uses ERROR_COPY[summon.error] when summon.kind === 'error', not the raw message"
    - "Onboarding step-4 invalid-API-key submission surfaces ERROR_COPY['INVALID_API_KEY'] when main returns an INVALID_API_KEY error"
    - "Linux basic_text safeStorage backend triggers a top-of-window Banner with KEYCHAIN_FALLBACK_PLAINTEXT copy on first boot"
    - "BotSupervisor classifies known mineflayer / Anthropic errors into ErrorClass strings before forwarding to renderer"
  artifacts:
    - path: src/renderer/src/lib/errors.ts
      provides: "ERROR_COPY map (ErrorClass → plain-English string) + classifyRendererError helper"
      exports: ["ERROR_COPY", "classifyRendererError"]
    - path: src/renderer/src/components/Banner.tsx
      provides: "Top-of-window dismissible banner for system warnings (KEYCHAIN_FALLBACK_PLAINTEXT, etc.)"
      exports: ["Banner"]
  key_links:
    - from: src/renderer/src/screens/CharacterPage.tsx
      to: src/renderer/src/lib/errors.ts
      via: "ERROR_COPY[summon.error] in model row"
      pattern: "ERROR_COPY\\["
    - from: src/renderer/src/screens/OnboardingScreen.tsx
      to: src/renderer/src/lib/errors.ts
      via: "classifyRendererError on save failure → ERROR_COPY"
      pattern: "classifyRendererError"
    - from: src/main/botSupervisor.ts
      to: src/shared/errorClasses.ts
      via: "translate raw mineflayer / fetch errors into ErrorClass"
      pattern: "ErrorClass"
---

<changes_made>
**Revision pass (Warning 10):** Task 3 verify section now documents a manual smoke-test for the Anthropic 401 → INVALID_API_KEY classification path. The regex-only grep gate proves the classifier exists in source but does NOT prove that a real Anthropic 401 produces an error string the regex actually matches. After implementing Task 3, the executor MUST run the bot once with `sk-fake-key` (or any clearly-invalid key), capture the raw error string Anthropic emits, confirm `classifyChildError` maps it to `'INVALID_API_KEY'`, and paste the captured error string verbatim into `04-09-SUMMARY.md` for traceability. If the captured string doesn't match the existing regex (`/invalid.*api.*key|401|unauthorized|x-api-key/i`), the executor MUST extend the regex before marking Task 3 complete.
</changes_made>

<objective>
Centralize error narration. Before this plan, the renderer surfaces raw error messages (`(err as Error).message`) — useful for debugging but not GUI-05 compliant. This plan ships `lib/errors.ts` with the `ERROR_COPY` map (UI-SPEC verbatim) and wires it into every error display site. Also adds a top-of-window Banner for the Linux basic_text plaintext warning. Extends botSupervisor to classify common errors into ErrorClass strings before forwarding.

Purpose: GUI-05 — every user-facing error includes a plain-English explanation + action hint. UI-SPEC §"Plain-English error copy" defines the seeded copy table.

Output: 1 new lib file, 1 new component, 4 edited files. Small plan; tight scope.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-RESEARCH.md
@.planning/phases/04-electron-gui-packaging/04-PATTERNS.md
@.planning/phases/04-electron-gui-packaging/04-UI-SPEC.md
@src/shared/errorClasses.ts
@src/shared/ipc.ts
@src/main/botSupervisor.ts
@src/main/apiKeyStore.ts
@src/renderer/src/screens/CharacterPage.tsx
@src/renderer/src/screens/OnboardingScreen.tsx
@src/renderer/src/App.tsx
@src/bot/adapter/minecraft/connect.js

<interfaces>
From shared:
- `ErrorClass` (10 variants from plan 02): BOT_START_TIMEOUT, LAN_NOT_OPEN, INVALID_API_KEY, RATE_LIMITED, NETWORK_OFFLINE, BOT_CRASH, LAN_UNAVAILABLE, KEYCHAIN_LOCKED, KEYCHAIN_FALLBACK_PLAINTEXT, NATIVE_MODULE_MISMATCH
- `ALL_ERROR_CLASSES`

From UI-SPEC §"Plain-English error copy" — verbatim copy table (lines 712–724).
From PATTERNS §"Error narration" + `src/bot/adapter/minecraft/connect.js` `humanizeReason` — analog for classifying raw error strings.

From plan 04 (botSupervisor.ts):
- catches `loadApiKey()` failures, child errors, summon-ready timeouts
- Currently emits `'BOT_START_TIMEOUT'` and `'LAN_NOT_OPEN'`. Plan 09 extends with classification of raw child errors.
</interfaces>

<key_locked_decisions>
- GUI-05: every user-facing error includes plain-English explanation + action hint.
- UI-SPEC §"Plain-English error copy" — 9 seeded entries + KEYCHAIN_FALLBACK_PLAINTEXT (RESEARCH Pitfall 3) verbatim copy.
- D-13: API key plaintext crosses MessagePort only — when main warns about basic_text, the warning is purely advisory; the key still saves.
- RESEARCH §Pitfall 3: Linux fallback toast is one-time, non-blocking.
- Plan 03's `apiKeyStore.backendKind()` already detects this; plan 05 wires the warn log; plan 09 surfaces in renderer.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Create src/renderer/src/lib/errors.ts + Banner component</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Plain-English error copy" (lines ~712–724) — full table
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 3" — KEYCHAIN_FALLBACK_PLAINTEXT copy idea
    - src/shared/errorClasses.ts (ErrorClass union)
    - src/bot/adapter/minecraft/connect.js (humanizeReason analog — for classifyRendererError pattern reference)
  </read_first>
  <behavior>
    - `ERROR_COPY: Record<ErrorClass, string>` — exact strings from UI-SPEC table.
    - `classifyRendererError(err: unknown): { class: ErrorClass; copy: string }` — examines an arbitrary error (Error instance or string from `(err as Error).message`) and tries to classify into an ErrorClass. Falls back to a generic copy + a sentinel class. Used by OnboardingScreen and other renderer-initiated IPC failure sites.
    - `Banner({ kind, message, onDismiss })` — top-of-window banner, sharp corners, dismissible. `kind: 'warn' | 'error'` controls colors (warn=accent-soft bg, error=red).
  </behavior>
  <action>
**Step 1.** `src/renderer/src/lib/errors.ts`:

```ts
import type { ErrorClass } from '@shared/errorClasses';

/**
 * Plain-English error copy. Verbatim from UI-SPEC §"Plain-English error copy" table.
 * Adding a new ErrorClass requires adding a row here AND updating src/shared/errorClasses.ts.
 */
export const ERROR_COPY: Record<ErrorClass, string> = {
  BOT_START_TIMEOUT: "Couldn't start the bot in 30s. Make sure your LAN world is still open and try again.",
  LAN_NOT_OPEN: "We can't see an open LAN world. Press ESC in Minecraft and choose Open to LAN.",
  INVALID_API_KEY: "Your Anthropic API key was rejected. Open Settings → re-run onboarding to paste a fresh key.",
  RATE_LIMITED: "Anthropic is throttling requests. Wait a minute and try again.",
  NETWORK_OFFLINE: "No internet connection. Reconnect and try again.",
  BOT_CRASH: "Sei stopped unexpectedly. Press Summon to restart.",
  LAN_UNAVAILABLE: "LAN auto-detect is blocked on this network. Try a home Wi-Fi network.",
  KEYCHAIN_LOCKED: "Couldn't read your saved API key from the system keychain. Re-run onboarding to re-save it.",
  KEYCHAIN_FALLBACK_PLAINTEXT: "Your system has no secret store. Sei will save your API key but it won't be hardware-protected.",
  NATIVE_MODULE_MISMATCH: "A bundled module didn't load. Reinstall Sei from the .dmg / .exe.",
};

/**
 * Best-effort classification of an arbitrary error into an ErrorClass + copy.
 *
 * Uses keyword heuristics on the error message — falls back to BOT_CRASH-shaped
 * generic narration if nothing matches. The renderer uses this for ad-hoc IPC
 * failures (saveConfig, saveApiKey, etc.); structured BotStatus from main
 * already comes pre-classified — those should NOT be re-run through this
 * helper, just look up `ERROR_COPY[status.error]` directly.
 */
export function classifyRendererError(err: unknown): { class: ErrorClass; copy: string } {
  const msg = (err && typeof err === 'object' && 'message' in err)
    ? String((err as { message: unknown }).message)
    : String(err);
  const lower = msg.toLowerCase();

  if (/keychain|safestorage|encryption.*unavailable|decrypt/i.test(lower)) {
    return { class: 'KEYCHAIN_LOCKED', copy: ERROR_COPY.KEYCHAIN_LOCKED };
  }
  if (/invalid.*api.*key|401|unauthorized|x-api-key/i.test(lower)) {
    return { class: 'INVALID_API_KEY', copy: ERROR_COPY.INVALID_API_KEY };
  }
  if (/429|rate.?limit|throttl/i.test(lower)) {
    return { class: 'RATE_LIMITED', copy: ERROR_COPY.RATE_LIMITED };
  }
  if (/enotfound|enetunreach|getaddrinfo|dns|offline|fetch failed/i.test(lower)) {
    return { class: 'NETWORK_OFFLINE', copy: ERROR_COPY.NETWORK_OFFLINE };
  }
  if (/lan|multicast|no minecraft lan|open to lan/i.test(lower)) {
    return { class: 'LAN_NOT_OPEN', copy: ERROR_COPY.LAN_NOT_OPEN };
  }
  if (/timeout|did not signal ready/i.test(lower)) {
    return { class: 'BOT_START_TIMEOUT', copy: ERROR_COPY.BOT_START_TIMEOUT };
  }
  // Generic fallback
  return {
    class: 'BOT_CRASH',
    copy: `Something went wrong. ${msg ? msg + '.' : ''} Try again.`,
  };
}
```

**Step 2.** `src/renderer/src/components/Banner.tsx`:

```tsx
import React from 'react';
import styles from './Banner.module.css';

export interface BannerProps {
  kind: 'warn' | 'error' | 'info';
  message: string;
  onDismiss?: () => void;
}

export function Banner({ kind, message, onDismiss }: BannerProps): React.ReactElement {
  return (
    <div className={`${styles.banner} ${styles[kind]}`} role="alert">
      <span className={styles.message}>{message}</span>
      {onDismiss ? (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">×</button>
      ) : null}
    </div>
  );
}
```

`Banner.module.css`:
```css
.banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; font-family: var(--sans); font-size: 13px; border-bottom: 1px solid var(--border-strong); }
.warn { background: var(--accent-soft); color: var(--text); }
.error { background: var(--red); color: var(--window); }
.info { background: var(--surface); color: var(--text-2); }
.message { flex: 1; }
.dismiss { background: transparent; border: 0; font-size: 18px; line-height: 1; cursor: pointer; color: inherit; padding: 0 4px; }
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/lib/errors.ts && test -f src/renderer/src/components/Banner.tsx && grep -q "export const ERROR_COPY" src/renderer/src/lib/errors.ts && grep -q "export function classifyRendererError" src/renderer/src/lib/errors.ts && grep -q "BOT_START_TIMEOUT:" src/renderer/src/lib/errors.ts && grep -q "LAN_NOT_OPEN:" src/renderer/src/lib/errors.ts && grep -q "INVALID_API_KEY:" src/renderer/src/lib/errors.ts && grep -q "KEYCHAIN_FALLBACK_PLAINTEXT:" src/renderer/src/lib/errors.ts && grep -q "NATIVE_MODULE_MISMATCH:" src/renderer/src/lib/errors.ts && (grep -c "^[[:space:]]*[A-Z_]\\+: " src/renderer/src/lib/errors.ts | awk "\$1 >= 10 {exit 0} {exit 1}") && grep -q "Press ESC in Minecraft" src/renderer/src/lib/errors.ts && grep -q "re-run onboarding" src/renderer/src/lib/errors.ts && grep -q "export function Banner" src/renderer/src/components/Banner.tsx && grep -q "kind: .warn. | .error. | .info." src/renderer/src/components/Banner.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(errors|Banner)\\.ts.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `errors.ts` exports `ERROR_COPY` and `classifyRendererError`
    - `ERROR_COPY` contains all 10 error class keys (verified by grep counting `^  [A-Z_]+: ` ≥ 10)
    - File contains the verbatim UI-SPEC strings (`Press ESC in Minecraft`, `re-run onboarding`, etc.)
    - `Banner.tsx` exports `Banner` with kind union `'warn' | 'error' | 'info'`
    - tsc passes
  </acceptance_criteria>
  <done>Error vocabulary + banner ready. Edit sites consume them.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Wire ERROR_COPY into OnboardingScreen + CharacterPage; add KEYCHAIN_FALLBACK_PLAINTEXT banner in App.tsx</name>
  <read_first>
    - src/renderer/src/screens/OnboardingScreen.tsx (existing inline error display from plan 07)
    - src/renderer/src/screens/CharacterPage.tsx (model row error display from plan 08)
    - src/renderer/src/App.tsx (top-level shell from plan 06; modal layer from plan 08)
    - src/renderer/src/lib/errors.ts (Task 1)
    - src/renderer/src/components/Banner.tsx (Task 1)
    - src/main/botSupervisor.ts (the ErrorClass values it currently emits)
    - src/shared/ipc.ts (BotStatus.error field)
  </read_first>
  <behavior>
    - **OnboardingScreen.tsx:** when step 4 submit fails, run `classifyRendererError(err)` and display `result.copy` (instead of raw `err.message`) inline below the field.
    - **CharacterPage.tsx:** when `summon.kind === 'error'`, the model-row label reads `ERROR_COPY[summon.error]` (NOT `summon.message`); "Try again" link still re-issues `sei.summon(id)`.
    - **App.tsx:** Add a top-level Banner area. On mount: detect Linux `basic_text` backend. The renderer side has no direct access to `safeStorage` (main process only — D-13). Solution: extend the IPC contract minimally with a one-shot startup query, OR have main attach a status hint. Simplest: add a new IPC channel `app:warnings` that returns `{ keychainFallbackPlaintext: boolean }` — main computes from `apiKeyStore.backendKind() === 'basic_text'`. Plumb through ipc.ts (handle) + preload (invoke) + RendererApi (method `getStartupWarnings()`).
    - On `App.tsx` mount: `await window.sei.getStartupWarnings()`. If `keychainFallbackPlaintext`, render `<Banner kind="warn" message={ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT} onDismiss={...} />` once-per-session at top of MacosWindow.
    - Add `getStartupWarnings()` to `RendererApi`, IpcChannel, ipc.ts handler, preload.
  </behavior>
  <action>
**Step 1.** Extend the IPC contract.

In `src/shared/ipc.ts`:

Add `app.warnings: 'app:warnings'` to IpcChannel.app:
```ts
app: {
  ready: 'app:ready',
  warnings: 'app:warnings',
},
```

Add `getStartupWarnings` to `RendererApi`:
```ts
export interface StartupWarnings {
  keychainFallbackPlaintext: boolean;
}

export interface RendererApi {
  // ... existing ...
  getStartupWarnings(): Promise<StartupWarnings>;
}
```

In `src/main/ipc.ts` add the handler:
```ts
import { backendKind } from './apiKeyStore';
// ...
ipcMain.handle(IpcChannel.app.warnings, async () => {
  return { keychainFallbackPlaintext: process.platform === 'linux' && backendKind() === 'basic_text' };
});
```

In `src/preload/index.ts` add the binding:
```ts
const api: RendererApi = {
  // ... existing ...
  getStartupWarnings: () => ipcRenderer.invoke(IpcChannel.app.warnings),
};
```

**Step 2.** Edit `src/renderer/src/screens/OnboardingScreen.tsx`:

- Import `classifyRendererError` from `'../lib/errors'`.
- In the catch block of the final-submit handler, replace `setError((err as Error).message)` with `setError(classifyRendererError(err).copy)`.
- The inline error display (`<div style={{...color: 'var(--red)'}}>{error}</div>`) stays — it now shows the plain-English copy.

**Step 3.** Edit `src/renderer/src/screens/CharacterPage.tsx`:

- Import `ERROR_COPY` from `'../lib/errors'`.
- In the model-row label render, where the code currently shows `summon.message` for error state, replace with:
  ```tsx
  {isErrored ? (ERROR_COPY[summon.error] ?? 'Something went wrong.') : ...}
  ```
  (Keep the rest of the conditional — Online / Connecting / Ready.)

**Step 4.** Edit `src/renderer/src/App.tsx`:

- Import `Banner` from `'./components/Banner'` and `ERROR_COPY` from `'./lib/errors'`.
- Add state: `const [warnings, setWarnings] = useState<{ keychainFallbackPlaintext: boolean; dismissed: boolean }>({ keychainFallbackPlaintext: false, dismissed: false });`
- Add to bootstrap effect (before the loading-floor wait):
  ```ts
  try {
    const w = await sei.getStartupWarnings();
    if (cancelled) return;
    setWarnings({ keychainFallbackPlaintext: w.keychainFallbackPlaintext, dismissed: false });
  } catch {}
  ```
- Render a Banner above MacosWindow content area when `warnings.keychainFallbackPlaintext && !warnings.dismissed`:
  ```tsx
  {warnings.keychainFallbackPlaintext && !warnings.dismissed ? (
    <Banner
      kind="warn"
      message={ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT}
      onDismiss={() => setWarnings((w) => ({ ...w, dismissed: true }))}
    />
  ) : null}
  ```
  Place it inside MacosWindow but above the IconRail+main flex row.
  </action>
  <verify>
    <automated>bash -c 'grep -q "app:warnings" src/shared/ipc.ts && grep -q "getStartupWarnings" src/shared/ipc.ts && grep -q "StartupWarnings" src/shared/ipc.ts && grep -q "ipcMain.handle(IpcChannel.app.warnings" src/main/ipc.ts && grep -q "backendKind() === .basic_text." src/main/ipc.ts && grep -q "getStartupWarnings: () => ipcRenderer.invoke" src/preload/index.ts && grep -q "classifyRendererError" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "ERROR_COPY\\[summon\\.error\\]" src/renderer/src/screens/CharacterPage.tsx && grep -q "import { Banner }" src/renderer/src/App.tsx && grep -q "ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT" src/renderer/src/App.tsx && grep -q "sei.getStartupWarnings" src/renderer/src/App.tsx && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "(ipc|preload).*error TS" | grep -v "TS2307.*\\.\\.bot/" | wc -l | grep -qE "^[[:space:]]*0$" && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(OnboardingScreen|CharacterPage|App)\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `src/shared/ipc.ts` contains `'app:warnings'` channel and `getStartupWarnings` method on RendererApi
    - `src/main/ipc.ts` registers handler `ipcMain.handle(IpcChannel.app.warnings, ...)` returning `{keychainFallbackPlaintext}` based on `backendKind()`
    - `src/preload/index.ts` exposes `getStartupWarnings`
    - `OnboardingScreen.tsx` calls `classifyRendererError`
    - `CharacterPage.tsx` looks up `ERROR_COPY[summon.error]` instead of raw message
    - `App.tsx` imports `Banner`, calls `sei.getStartupWarnings()`, and conditionally renders a Banner with `ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT`
    - tsc passes for both tsconfigs
  </acceptance_criteria>
  <done>All renderer error sites use central copy map. Linux basic_text warning surfaces non-blockingly.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Extend botSupervisor.ts to classify raw child errors into ErrorClass</name>
  <read_first>
    - src/main/botSupervisor.ts (existing — emits BOT_START_TIMEOUT and LAN_NOT_OPEN; raw child errors fall through)
    - src/main/apiKeyStore.ts (loadApiKey can throw KEYCHAIN_LOCKED-shaped errors)
    - src/bot/adapter/minecraft/connect.js (humanizeReason — pattern reference)
    - src/shared/errorClasses.ts (ErrorClass union)
  </read_first>
  <behavior>
    - Add a `classifyChildError(err: unknown): ErrorClass` helper near the top of botSupervisor.ts.
    - Heuristics:
      - safeStorage / "decrypt" / "Keychain" → `'KEYCHAIN_LOCKED'`
      - 401 / "unauthorized" / "x-api-key" → `'INVALID_API_KEY'`
      - 429 / "rate" → `'RATE_LIMITED'`
      - "ENOTFOUND" / "ENETUNREACH" / "getaddrinfo" / "fetch failed" → `'NETWORK_OFFLINE'`
      - "ECONNREFUSED" / "Could not reach server" / "no Minecraft LAN" → `'LAN_NOT_OPEN'`
      - "EADDRNOTAVAIL" / multicast → `'LAN_UNAVAILABLE'`
      - default → `'BOT_CRASH'`
    - Apply at three sites already in the supervisor:
      1. `loadApiKey()` catch in `_summon`: wrap the throw with classification → emit error status + rethrow.
      2. `port1.on('message', ...)` BotLifecycle `error` events: pass through (already typed); don't reclassify (bot already classified).
      3. `child.on('error', ...)` and `child.on('exit', ...)` paths: when no `summon-ready` arrived, classify the error and emit a BotStatus with that ErrorClass.
    - `summon()` always emits a BotStatus with a classified `error` field on failure (never the raw message alone).
  </behavior>
  <action>
Edit `src/main/botSupervisor.ts`. Add helper:

```ts
function classifyChildError(err: unknown): ErrorClass {
  const msg = (err && typeof err === 'object' && 'message' in err)
    ? String((err as { message: unknown }).message)
    : String(err);
  const lower = msg.toLowerCase();
  if (/keychain|safestorage|encryption.*unavailable|decrypt/i.test(lower)) return 'KEYCHAIN_LOCKED';
  if (/invalid.*api.*key|401|unauthorized|x-api-key/i.test(lower)) return 'INVALID_API_KEY';
  if (/429|rate.?limit|throttl/i.test(lower)) return 'RATE_LIMITED';
  if (/enotfound|enetunreach|getaddrinfo|fetch failed/i.test(lower)) return 'NETWORK_OFFLINE';
  if (/econnrefused|could not reach|no minecraft lan|lan/i.test(lower)) return 'LAN_NOT_OPEN';
  if (/eaddrnotavail|multicast/i.test(lower)) return 'LAN_UNAVAILABLE';
  if (/timeout|did not signal ready/i.test(lower)) return 'BOT_START_TIMEOUT';
  return 'BOT_CRASH';
}
```

Update three failure sites:

1. **loadApiKey wrap.** Where `_summon` calls `await loadApiKey()`, wrap in try/catch:
```ts
let apiKey: string;
try { apiKey = await loadApiKey(); }
catch (err) {
  const ec = classifyChildError(err);
  opts.sendStatus({ kind: 'error', error: ec, message: (err as Error).message ?? String(err), characterId });
  throw err;
}
```

2. **child.on('error')** path: classify before emitting status:
```ts
child.on('error', (err) => {
  logger.error(`bot child error: ${err.message}`);
  if (!summonResolved) {
    summonResolved = true;
    clearTimeout(summonTimer);
    const ec = classifyChildError(err);
    opts.sendStatus({ kind: 'error', error: ec, message: err.message, characterId });
    summonReject(err);
  }
});
```

3. **child.on('exit')** path when `!summonResolved`:
```ts
child.on('exit', (code) => {
  if (!summonResolved) {
    summonResolved = true;
    clearTimeout(summonTimer);
    const message = `Bot exited before summon-ready (code=${code ?? 'null'})`;
    opts.sendStatus({ kind: 'error', error: 'BOT_CRASH', message, characterId });
    summonReject(new Error(message));
  }
  session.resolveExited();
});
```

(Existing `summon-timeout` path already emits `BOT_START_TIMEOUT` — leave it.)

Make sure `classifyChildError` is reachable from `_summon` (defined module-level in botSupervisor.ts) and that `import type { ErrorClass } from '../shared/ipc'` is present (or move to errorClasses).
  </action>
  <verify>
    <automated>bash -c 'grep -q "function classifyChildError" src/main/botSupervisor.ts && grep -q "KEYCHAIN_LOCKED" src/main/botSupervisor.ts && grep -q "INVALID_API_KEY" src/main/botSupervisor.ts && grep -q "RATE_LIMITED" src/main/botSupervisor.ts && grep -q "NETWORK_OFFLINE" src/main/botSupervisor.ts && grep -q "LAN_UNAVAILABLE" src/main/botSupervisor.ts && grep -q "BOT_CRASH" src/main/botSupervisor.ts && (grep -c "classifyChildError" src/main/botSupervisor.ts | awk "\$1 >= 3 {exit 0} {exit 1}") && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "botSupervisor\\.ts.*error TS" | grep -v "TS2307.*\\.\\.bot/" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `botSupervisor.ts` defines `function classifyChildError`
    - File contains all 7 ErrorClass strings: `KEYCHAIN_LOCKED`, `INVALID_API_KEY`, `RATE_LIMITED`, `NETWORK_OFFLINE`, `LAN_UNAVAILABLE`, `BOT_CRASH` (and pre-existing `BOT_START_TIMEOUT`, `LAN_NOT_OPEN`)
    - `classifyChildError` is called at minimum 3 times (loadApiKey, child.on('error'), and at least one other site)
    - tsc passes for tsconfig.node.json
  </acceptance_criteria>
  <manual_smoke_test>
    **WARNING-10 fix — Anthropic 401 truth gap:**

    Static greps prove the classifier and regex exist in source. They do NOT prove that a real Anthropic 401 response produces an error string the regex actually matches. The string Anthropic returns ("invalid x-api-key", "401 Unauthorized: ...", or just `{"type":"error","error":{"type":"authentication_error","message":"..."}}`) varies by SDK version and request shape.

    After implementing Task 3, the executor MUST:
    1. Set `ANTHROPIC_API_KEY=sk-fake-key-clearly-invalid` (or use the GUI to save a fake key via onboarding).
    2. Trigger a summon. The bot will fail on its first Haiku call.
    3. Capture the raw error string from the bot's stdout / lifecycle `error` event message field.
    4. Confirm `classifyChildError(thatString) === 'INVALID_API_KEY'` (run a tiny one-off node REPL or unit test).
    5. **If the regex does NOT match:** extend `/invalid.*api.*key|401|unauthorized|x-api-key/i` to cover the captured shape (commit the change as part of this task — do NOT defer).
    6. Paste the captured raw error string verbatim into `04-09-SUMMARY.md` for traceability — future regex tweaks can be regression-tested against it.

    This step is mandatory before Task 3 is considered done. The plan's `<done>` only flips when the smoke test is captured and documented.
  </manual_smoke_test>
  <done>BotSupervisor classifies all common error shapes. Renderer's CharacterPage model row now displays plain-English copy for every failure scenario. **Anthropic 401 manual smoke test captured in 04-09-SUMMARY.md (per WARNING-10 fix).**</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| classifier heuristics | Best-effort; an unclassified error falls through to BOT_CRASH (generic-but-safe) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-38 | Information Disclosure | error message exposing api key fragment | mitigate | classifyChildError discards the raw message except for fallback BOT_CRASH; even there, ERROR_COPY['BOT_CRASH'] is generic. Renderer never displays raw subset of api key. |
| T-04-39 | Spoofing | child sends a fake ErrorClass over MessagePort | accept | The bot is our own code; lifecycle types are typed at compile time. Untrusted content lives only in `message` strings, which are rendered as plain text. |
</threat_model>

<verification>
- Trigger an INVALID_API_KEY in onboarding (paste `sk-fake`): renderer shows "Your Anthropic API key was rejected. Open Settings → re-run onboarding to paste a fresh key."
- Trigger BOT_START_TIMEOUT (set summon timeout artificially short): CharacterPage model row shows "Couldn't start the bot in 30s. Make sure your LAN world is still open and try again."
- On Linux without kwallet: top-of-window banner shows "Your system has no secret store. Sei will save your API key but it won't be hardware-protected." with × dismiss.
- tsc passes for both tsconfigs
</verification>

<success_criteria>
- Plan 11 (clean-VM smoke) verifies that triggering known error scenarios surfaces plain-English copy, not raw stack traces.
- GUI-05 satisfied.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-09-SUMMARY.md` documenting:
- Final list of error scenarios verified end-to-end (or note which require live trigger to validate)
- Note for plan 11 executor: when smoke-testing on macOS, `KEYCHAIN_LOCKED` requires actual Keychain lockout — usually surfaces only after long delay or user denial; not easily reproducible in CI. Verify the copy renders correctly via DevTools setState test.
</output>
