---
phase: 04-electron-gui-packaging
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified:
  - src/shared/ipc.ts
  - src/shared/characterSchema.ts
  - src/shared/errorClasses.ts
autonomous: true
requirements: [GUI-01, GUI-02, GUI-03, GUI-04, GUI-05]
must_haves:
  truths:
    - "Renderer, main, and preload code can all `import type { RendererApi, BotStatus, LanState, LogEntry, Character } from '@shared/...'`"
    - "Zod CharacterSchema validates a `<userData>/characters/<id>.json` file shape and rejects malformed inputs"
    - "ErrorClass union covers all 9 error classes seeded in UI-SPEC §Plain-English error copy table + KEYCHAIN_FALLBACK_PLAINTEXT"
    - "IPC channel constants are a single source of truth for both ipcMain.handle (main) and ipcRenderer.invoke (preload)"
  artifacts:
    - path: src/shared/ipc.ts
      provides: "RendererApi interface, BotStatus / LanState / LogEntry / BotLifecycle / UserConfig / Unsubscribe types, IpcChannel const object"
      exports: ["RendererApi", "BotStatus", "LanState", "LogEntry", "BotLifecycle", "UserConfig", "Unsubscribe", "IpcChannel"]
    - path: src/shared/characterSchema.ts
      provides: "Zod CharacterSchema + CharacterIndexSchema + Character / CharacterIndex inferred types"
      exports: ["CharacterSchema", "CharacterIndexSchema", "Character", "CharacterIndex", "UserConfigSchema", "UserConfig"]
    - path: src/shared/errorClasses.ts
      provides: "ErrorClass union string-literal type for all main→renderer error narration"
      exports: ["ErrorClass", "ALL_ERROR_CLASSES"]
  key_links:
    - from: src/shared/ipc.ts
      to: src/shared/errorClasses.ts
      via: "BotStatus error variant references ErrorClass"
      pattern: "ErrorClass"
    - from: src/shared/ipc.ts
      to: src/shared/characterSchema.ts
      via: "RendererApi character methods reference Character type"
      pattern: "Character"
---

<objective>
Define the IPC contract and data schemas that all subsequent plans (main process modules, preload, renderer screens) build against. These types are the "blueprints" that prevent contract drift between the three processes (D-03 — TS catches IPC contract drift).

Purpose: Wave 2 has many parallel plans (botSupervisor, characterStore, configStore, apiKeyStore, lanWatcher, logRouter) and Wave 3 has even more (renderer screens). All of them depend on a shared type vocabulary. Establishing it FIRST means executors don't have to invent or rediscover the contract — they consume it directly.

Output: Three files under `src/shared/` (`ipc.ts`, `characterSchema.ts`, `errorClasses.ts`). Pure TS — no runtime side effects, no IO. tsc compiles cleanly under `tsconfig.node.json`.
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
@src/bot/config.js
@src/bot/brain/types.js

<interfaces>
<!-- Reference contracts from RESEARCH.md and PATTERNS.md to embed verbatim. -->

From RESEARCH §Pattern 2 (preload contextBridge — line ~437–474):
The preload exposes `window.sei` typed as `RendererApi`. Every method's signature is the contract.

From RESEARCH §Code Examples §6 (lines 849–875):
LogEntry shape used by renderer log store: `{ timestamp, tag, message, level }` (level ∈ 'info'|'warn'|'error').

From PATTERNS §`src/shared/ipc.ts` (line ~470–500):
RendererApi + BotStatus + LanState + LogEntry types — copy as the spec.

From PATTERNS §`src/shared/characterSchema.ts` (line ~510–531):
CharacterSchema with id, name, description, persona_prompt, is_default, created (ISO), last_launched (ISO|null), playtime_ms, portrait_image. Plus CharacterIndexSchema with version + order.

From CONTEXT D-12:
UserConfig keys: mc_username, preferred_name, provider, theme_mode.

From PATTERNS §configStore (line ~243–252):
UserConfigSchema with provider enum (only 'anthropic') and theme_mode enum.

From UI-SPEC §"Plain-English error copy" (lines ~712–724):
9 seeded ErrorClass values: BOT_START_TIMEOUT, LAN_NOT_OPEN, INVALID_API_KEY, RATE_LIMITED, NETWORK_OFFLINE, BOT_CRASH, LAN_UNAVAILABLE, KEYCHAIN_LOCKED, NATIVE_MODULE_MISMATCH. Plus KEYCHAIN_FALLBACK_PLAINTEXT from RESEARCH §Pitfall 3.
</interfaces>

<key_locked_decisions>
- D-09: One JSON file per character at `<userData>/characters/<id>.json` + index.json manifest.
- D-11: `last_launched` ISO timestamp, `playtime_ms` accumulating int, `created` immutable.
- D-12: UserConfig stores `mc_username`, `preferred_name`, `provider`, `theme_mode` only — NEVER the api key.
- D-14: `portrait_image` is a relative path (e.g., `<id>.png`) or null when using procedural.
- D-26 / D-27: provider enum currently only `'anthropic'`; future-proofed but other strings invalid today.
- D-19: Bot lifecycle event vocabulary: `connected`, `disconnected`, `error`, `chat`, `summon-ready`, `summon-stopped`.
- D-22: LAN states: `connected` / `not_connected` / `unavailable`.
- D-33: theme_mode ∈ `'system' | 'light' | 'dark'`.
- UI-SPEC §Defaults: IPC channel names use `prefix:verb` pattern.
- UI-SPEC §Plain-English error copy: 9 seeded error classes + KEYCHAIN_FALLBACK_PLAINTEXT (RESEARCH Pitfall 3).
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Create src/shared/errorClasses.ts</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Plain-English error copy" (lines ~712–724) — full table of 9 error classes
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 3" (lines ~664–669) — KEYCHAIN_FALLBACK_PLAINTEXT
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/renderer/src/lib/errors.ts" (lines ~571–597) — ErrorClass union shape
    - src/bot/brain/errStrings.js (analog file — central error string surface)
  </read_first>
  <behavior>
    - Importing `ErrorClass` from `@shared/errorClasses` gives a union of exactly 10 string literals.
    - Importing `ALL_ERROR_CLASSES` gives a frozen array of all 10 values, useful for runtime validation in `lib/errors.ts` (plan 09).
    - tsc compiles the file with no errors.
  </behavior>
  <action>
Create `src/shared/errorClasses.ts` with this content:

```ts
/**
 * Plain-English error narration surface (GUI-05).
 *
 * Each variant maps to a copy entry in src/renderer/src/lib/errors.ts (plan 09).
 * Sources:
 *   - UI-SPEC §"Plain-English error copy" — 9 seeded classes
 *   - RESEARCH §"Pitfall 3" — KEYCHAIN_FALLBACK_PLAINTEXT (Linux fallback warning)
 *
 * Adding a new ErrorClass: also add a row to ERROR_COPY in lib/errors.ts.
 */

export type ErrorClass =
  | 'BOT_START_TIMEOUT'
  | 'LAN_NOT_OPEN'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'NETWORK_OFFLINE'
  | 'BOT_CRASH'
  | 'LAN_UNAVAILABLE'
  | 'KEYCHAIN_LOCKED'
  | 'KEYCHAIN_FALLBACK_PLAINTEXT'
  | 'NATIVE_MODULE_MISMATCH';

export const ALL_ERROR_CLASSES: readonly ErrorClass[] = Object.freeze([
  'BOT_START_TIMEOUT',
  'LAN_NOT_OPEN',
  'INVALID_API_KEY',
  'RATE_LIMITED',
  'NETWORK_OFFLINE',
  'BOT_CRASH',
  'LAN_UNAVAILABLE',
  'KEYCHAIN_LOCKED',
  'KEYCHAIN_FALLBACK_PLAINTEXT',
  'NATIVE_MODULE_MISMATCH',
]);
```

Do NOT add the copy strings here — those live in `src/renderer/src/lib/errors.ts` per PATTERNS (plan 09 territory).
  </action>
  <verify>
    <automated>test -f src/shared/errorClasses.ts && grep -c "^  | '" src/shared/errorClasses.ts | grep -q '^10$' && grep -q "KEYCHAIN_FALLBACK_PLAINTEXT" src/shared/errorClasses.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -v "error TS6053\|error TS6307" | grep -c "error TS" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/shared/errorClasses.ts` exists
    - File contains exactly 10 string-literal union variants on lines starting with `  | '` (verified by `grep -c`)
    - File contains the literal `KEYCHAIN_FALLBACK_PLAINTEXT`
    - File contains the literal `NATIVE_MODULE_MISMATCH`
    - File exports `ALL_ERROR_CLASSES` as a frozen `readonly ErrorClass[]`
    - `npx tsc --noEmit -p tsconfig.node.json` produces no errors related to this file (TS6053 / TS6307 about missing other files in include glob are tolerated since plan 04/05/10 haven't created them yet)
  </acceptance_criteria>
  <done>ErrorClass union complete; importable as `import type { ErrorClass } from '@shared/errorClasses'`.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Create src/shared/characterSchema.ts (Zod schemas)</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/shared/characterSchema.ts" (lines ~504–531) — schema spec
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/configStore.ts" (lines ~226–278) — UserConfigSchema spec
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-09, D-11, D-12, D-14
    - src/bot/config.js (lines 17–77 — ConfigSchema reference for Zod patterns: defaults, nested, ISO timestamps as strings)
  </read_first>
  <behavior>
    - `CharacterSchema.parse(...)` accepts a valid character JSON: `{id, name, description, persona_prompt, is_default, created, last_launched, playtime_ms, portrait_image}`.
    - `CharacterSchema.parse(...)` rejects: missing `id`, missing `name`, missing `persona_prompt`, negative `playtime_ms`.
    - `Character` type (inferred via `z.infer`) is importable.
    - `CharacterIndexSchema.parse({version: 1, order: ['sui']})` returns the parsed object.
    - `UserConfigSchema.parse({mc_username: 'foo'})` succeeds with all defaults filled in.
    - `UserConfigSchema.parse({mc_username: 'foo', provider: 'openai'})` REJECTS (provider only allows 'anthropic' today per D-26 / D-27).
    - `UserConfigSchema.parse({mc_username: 'foo', theme_mode: 'plaid'})` REJECTS.
  </behavior>
  <action>
Create `src/shared/characterSchema.ts`:

```ts
import { z } from 'zod';

/**
 * Character JSON shape stored at `<userData>/characters/<id>.json`.
 * Source: CONTEXT D-09, D-11, D-14 + PATTERNS §characterSchema.ts.
 */
export const CharacterSchema = z.object({
  id: z.string().min(1),                              // slug, kebab-case
  name: z.string().min(1),
  description: z.string().default(''),                // shown to user (D-47)
  persona_prompt: z.string().min(1),                  // sent to model (D-48)
  is_default: z.boolean().default(false),             // sui = true after migration (D-10)
  created: z.string(),                                // ISO timestamp, immutable (D-11)
  last_launched: z.string().nullable().default(null), // ISO or null (D-11)
  playtime_ms: z.number().int().min(0).default(0),    // accumulated (D-11)
  portrait_image: z.string().nullable().default(null),// optional override file (D-14)
});

export type Character = z.infer<typeof CharacterSchema>;

/**
 * Index manifest at `<userData>/characters/index.json`.
 * Maintains ordering across the character grid (D-09).
 */
export const CharacterIndexSchema = z.object({
  version: z.literal(1).default(1),
  order: z.array(z.string()).default([]),             // character ids in display order
});

export type CharacterIndex = z.infer<typeof CharacterIndexSchema>;

/**
 * User config stored at `<userData>/config.json`.
 * NEVER contains the API key (D-13: API key lives in safeStorage `<userData>/api_key.bin`).
 * Sources: CONTEXT D-12, D-26, D-27, D-33.
 */
export const UserConfigSchema = z.object({
  mc_username: z.string().default(''),                            // Minecraft account display name
  preferred_name: z.string().default(''),                          // what bot calls the user
  provider: z.enum(['anthropic']).default('anthropic'),            // D-26 reserves more (OpenAI/Google/Local) — only anthropic valid today
  theme_mode: z.enum(['system', 'light', 'dark']).default('system'), // D-33
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
```

Note the file relies on `zod` which is already a dependency (v3.22.4 from existing package.json). Do NOT install another version.
  </action>
  <verify>
    <automated>test -f src/shared/characterSchema.ts && grep -q "export const CharacterSchema" src/shared/characterSchema.ts && grep -q "export const CharacterIndexSchema" src/shared/characterSchema.ts && grep -q "export const UserConfigSchema" src/shared/characterSchema.ts && grep -q "export type Character " src/shared/characterSchema.ts && grep -q "export type UserConfig " src/shared/characterSchema.ts && grep -q "z.enum(\['anthropic'\])" src/shared/characterSchema.ts && grep -q "z.enum(\['system', 'light', 'dark'\])" src/shared/characterSchema.ts && node --input-type=module -e "import('./src/shared/characterSchema.ts').catch(()=>process.exit(0))" 2>&1 || true && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "characterSchema\.ts.*error TS" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/shared/characterSchema.ts` exists
    - File exports: `CharacterSchema`, `CharacterIndexSchema`, `UserConfigSchema` (all Zod ZodObject); `Character`, `CharacterIndex`, `UserConfig` (all TS types)
    - `CharacterSchema` requires `id`, `name`, `persona_prompt` (min length 1) — verified by literal substrings: `id: z.string().min(1)`, `name: z.string().min(1)`, `persona_prompt: z.string().min(1)`
    - `CharacterSchema` includes `playtime_ms: z.number().int().min(0).default(0)`
    - `UserConfigSchema` constrains provider to `z.enum(['anthropic'])` ONLY (no other values)
    - `UserConfigSchema` constrains theme_mode to `z.enum(['system', 'light', 'dark'])`
    - `UserConfigSchema` does NOT contain the strings `api_key`, `apiKey`, or `anthropic.api_key` (verified by grep returning 0)
    - `npx tsc --noEmit -p tsconfig.node.json` reports no errors for `characterSchema.ts`
  </acceptance_criteria>
  <done>Character + index + user-config Zod schemas in place; downstream stores (plan 03), main IPC (plan 04), and renderer screens (plans 06–08) all consume from this single source.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Create src/shared/ipc.ts (RendererApi + lifecycle types + IpcChannel constants)</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/shared/ipc.ts" (lines ~451–500) — verbatim type spec
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pattern 2" (lines ~437–474) — preload contract
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §6" (lines ~849–875) — LogEntry shape
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-17, D-19, D-22
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Defaults" (line 759) — IPC channel naming
    - src/shared/errorClasses.ts (created in Task 1)
    - src/shared/characterSchema.ts (created in Task 2 — Character / UserConfig types)
  </read_first>
  <behavior>
    - Importing `RendererApi` gives the full preload contract: 13 methods.
    - Importing `BotStatus` gives a discriminated union: idle | connecting | online | error.
    - Importing `LanState` gives a discriminated union: connected | not_connected | unavailable.
    - Importing `BotLifecycle` gives the message types passed over MessagePortMain (D-19): connected, disconnected, error, chat, summon-ready, summon-stopped, plus init-ack and exit.
    - Importing `IpcChannel` gives a frozen const object whose values are the actual channel string literals — main and preload import the same constants.
    - `IpcChannel.bot.summon === 'bot:summon'` etc.
  </behavior>
  <action>
Create `src/shared/ipc.ts`:

```ts
/**
 * IPC contract between main, preload, and renderer.
 *
 * Single source of truth: every ipcMain.handle (in src/main/ipc.ts) and every
 * ipcRenderer.invoke (in src/preload/index.ts) imports channel names from
 * `IpcChannel` below. Method signatures imported as `RendererApi`.
 *
 * Sources:
 *   - CONTEXT D-17 (RendererApi shape)
 *   - CONTEXT D-19 (BotLifecycle vocabulary)
 *   - CONTEXT D-22 (LanState variants)
 *   - PATTERNS §src/shared/ipc.ts
 *   - RESEARCH §Pattern 2 (contextBridge contract)
 *   - UI-SPEC §Defaults (channel naming)
 */

import type { Character, UserConfig } from './characterSchema';
import type { ErrorClass } from './errorClasses';

/* -------------------------------------------------------------------------- */
/*  Lifecycle / status / log domain types                                     */
/* -------------------------------------------------------------------------- */

export type Unsubscribe = () => void;

/** Renderer-facing bot status surface (used by CharacterPage model row). */
export type BotStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'online'; uptimeMs: number; characterId: string }
  | { kind: 'error'; error: ErrorClass; message: string; characterId: string };

/** Renderer-facing LAN watcher status (used by HomeScreen pill + LAN modal). */
export type LanState =
  | { kind: 'connected'; port: number; motd: string; lastSeenAt: number }
  | { kind: 'not_connected' }
  | { kind: 'unavailable' };

/** Single log line forwarded from utilityProcess stdout/stderr → main → renderer. */
export interface LogEntry {
  timestamp: string;             // ISO; main attaches this when it tees the line
  tag: string | null;            // e.g. "[chat<-]", "[haiku!]"; null when no prefix matches
  message: string;               // raw line text including any prefix
  level: 'info' | 'warn' | 'error';
}

/** Batched log delivery (Pitfall 7 — main coalesces ~50ms / 100 lines per batch). */
export interface LogBatch {
  entries: LogEntry[];
  dropped?: number;              // sentinel when backpressure clipped lines
}

/**
 * Internal main↔utilityProcess MessagePort message vocabulary.
 * Renderer never sees these directly — main translates to BotStatus.
 */
export type BotLifecycle =
  | { type: 'init-ack' }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'error'; error: ErrorClass; message: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'summon-ready' }
  | { type: 'summon-stopped' }
  | { type: 'exit'; code: number | null };

/* -------------------------------------------------------------------------- */
/*  Preload-exposed RendererApi                                                */
/* -------------------------------------------------------------------------- */

/**
 * The shape of `window.sei` in renderer code.
 * Preload (src/preload/index.ts) uses `contextBridge.exposeInMainWorld('sei', api)`
 * with `api: RendererApi`. Main registers ipcMain.handle for every request/response method.
 */
export interface RendererApi {
  // Bot supervision (request/response with timeouts — main enforces)
  summon(characterId: string): Promise<void>;
  stop(): Promise<void>;

  // Character CRUD
  listCharacters(): Promise<Character[]>;
  getCharacter(id: string): Promise<Character | null>;
  saveCharacter(character: Character): Promise<void>;
  deleteCharacter(id: string): Promise<void>;

  // User config + secret
  getConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
  saveApiKey(plaintext: string): Promise<void>;
  hasApiKey(): Promise<boolean>;

  // Push subscriptions — return Unsubscribe (renderer cleans up on unmount)
  onStatus(cb: (status: BotStatus) => void): Unsubscribe;
  onLog(cb: (batch: LogBatch) => void): Unsubscribe;
  onLan(cb: (state: LanState) => void): Unsubscribe;
}

/* -------------------------------------------------------------------------- */
/*  IPC channel string constants — single source of truth for both sides       */
/* -------------------------------------------------------------------------- */

export const IpcChannel = {
  bot: {
    summon: 'bot:summon',
    stop: 'bot:stop',
    status: 'bot:status',
    logBatch: 'bot:log:batch',
  },
  lan: {
    state: 'lan:state',
  },
  chars: {
    list: 'chars:list',
    get: 'chars:get',
    save: 'chars:save',
    delete: 'chars:delete',
  },
  config: {
    get: 'config:get',
    save: 'config:save',
    saveApiKey: 'config:save-api-key',
    hasApiKey: 'config:has-api-key',
  },
  app: {
    ready: 'app:ready',
  },
} as const;

export type IpcChannelName =
  | typeof IpcChannel.bot[keyof typeof IpcChannel.bot]
  | typeof IpcChannel.lan[keyof typeof IpcChannel.lan]
  | typeof IpcChannel.chars[keyof typeof IpcChannel.chars]
  | typeof IpcChannel.config[keyof typeof IpcChannel.config]
  | typeof IpcChannel.app[keyof typeof IpcChannel.app];
```

This file has NO runtime side effects — it is pure type definitions + a frozen const object. Importable by main, preload, AND renderer (TS only; no node-only or browser-only API surface).
  </action>
  <verify>
    <automated>test -f src/shared/ipc.ts && grep -q "export interface RendererApi" src/shared/ipc.ts && grep -q "export type BotStatus" src/shared/ipc.ts && grep -q "export type LanState" src/shared/ipc.ts && grep -q "export type BotLifecycle" src/shared/ipc.ts && grep -q "export const IpcChannel" src/shared/ipc.ts && grep -q "summon(characterId: string): Promise<void>" src/shared/ipc.ts && grep -q "saveApiKey(plaintext: string): Promise<void>" src/shared/ipc.ts && grep -q "hasApiKey(): Promise<boolean>" src/shared/ipc.ts && grep -q "onLog(cb: (batch: LogBatch) => void)" src/shared/ipc.ts && grep -c "summon\|stop\|listCharacters\|getCharacter\|saveCharacter\|deleteCharacter\|getConfig\|saveConfig\|saveApiKey\|hasApiKey\|onStatus\|onLog\|onLan" src/shared/ipc.ts | awk '$1 >= 13 {exit 0} {exit 1}' && grep -c "'bot:\|'lan:\|'chars:\|'config:\|'app:" src/shared/ipc.ts | awk '$1 >= 14 {exit 0} {exit 1}' && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "ipc\.ts.*error TS" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/shared/ipc.ts` exists
    - File exports `RendererApi` interface with all 13 methods (summon, stop, listCharacters, getCharacter, saveCharacter, deleteCharacter, getConfig, saveConfig, saveApiKey, hasApiKey, onStatus, onLog, onLan) — verified by grep matching all 13 method names
    - File exports `BotStatus`, `LanState`, `LogEntry`, `LogBatch`, `BotLifecycle`, `Unsubscribe` types
    - File exports `IpcChannel` const with at least 14 channel string literals (5 bot + 1 lan + 4 chars + 4 config + 1 app)
    - File contains `'bot:summon'`, `'bot:stop'`, `'bot:status'`, `'bot:log:batch'`, `'lan:state'`, `'chars:list'`, `'chars:get'`, `'chars:save'`, `'chars:delete'`, `'config:get'`, `'config:save'`, `'config:save-api-key'`, `'config:has-api-key'`, `'app:ready'` (verified per-string)
    - File imports `Character` and `UserConfig` from `./characterSchema`
    - File imports `ErrorClass` from `./errorClasses`
    - `npx tsc --noEmit -p tsconfig.node.json` reports no errors for `ipc.ts`
  </acceptance_criteria>
  <done>RendererApi contract published; main, preload, renderer all import from `@shared/ipc`. No method signature drift possible — TS compiler catches it.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| renderer→main | Renderer can lie about types even with TS at compile time; runtime Zod validation in main is required (Plan 04 territory) |
| utilityProcess→main | Lifecycle messages over MessagePort; main treats as untrusted and validates |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-05 | Tampering | renderer-supplied Character payload | mitigate | Plan 04 (main/ipc.ts) re-validates with `CharacterSchema.parse(...)` at every `chars:save` boundary; this plan ships the schema |
| T-04-06 | Information Disclosure | UserConfig containing api_key by accident | mitigate | UserConfigSchema explicitly excludes any api_key field; type-check + runtime parse both reject extra props with `.strict()` if needed |
| T-04-07 | Spoofing | renderer claiming to be a different "process" | mitigate | RendererApi method signatures are typed; main's ipcMain.handle binds responses to webContents — main never trusts renderer-supplied identity |
</threat_model>

<verification>
- `npx tsc --noEmit -p tsconfig.node.json` exits 0 (zero errors related to shared/*.ts)
- `import { CharacterSchema } from '@shared/characterSchema'; CharacterSchema.parse({id:'sui',name:'Sui',persona_prompt:'You are Sui',created:'2026-05-08T00:00:00Z'})` returns a parsed Character (smoke check — to be exercised once main/characterStore.ts lands in plan 03)
- All three files have zero runtime imports (`grep -L "console\\.\|fs\\.\|path\\.\|new \\(.*Client\\|.*Worker\\)" src/shared/*.ts`) — pure types + Zod schemas only
</verification>

<success_criteria>
- Plan 03 (stores + secrets) imports `Character`, `CharacterIndex`, `UserConfig` from `@shared/characterSchema` — type-checks pass
- Plan 04 (bot supervisor + main entry + IPC) imports `RendererApi`, `BotStatus`, `LanState`, `BotLifecycle`, `IpcChannel` from `@shared/ipc` and `ErrorClass` from `@shared/errorClasses` — type-checks pass
- Plan 06+ (renderer) imports the same types via the `@shared/*` alias from tsconfig.web.json — type-checks pass
- ZERO type contract drift between processes is possible: changing a method signature requires editing this one file, and tsc errors propagate to all three processes
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-02-SUMMARY.md` documenting:
- Final exports from each file
- Any deviations from PATTERNS spec (should be none; document if necessary)
- Note for plan 03 / plan 04 / plan 09 executors: import paths use `@shared/*` alias (configured in `tsconfig.web.json` paths field) for renderer; main/preload import via relative path `'../shared/ipc'` because `tsconfig.node.json` does not configure path aliases.
</output>
