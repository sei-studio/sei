---
phase: 04-electron-gui-packaging
plan: 03
type: execute
wave: 2
depends_on: [01, 02]
files_modified:
  - src/main/configStore.ts
  - src/main/characterStore.ts
  - src/main/apiKeyStore.ts
  - src/main/migration.ts
  - src/main/paths.ts
autonomous: true
requirements: [GUI-01, GUI-04, GUI-05]
must_haves:
  truths:
    - "Reading/writing `<userData>/config.json` round-trips a UserConfig through Zod validation with atomicWrite + per-path lock"
    - "Reading/writing `<userData>/characters/<id>.json` round-trips a Character through Zod validation with atomicWrite + per-path lock"
    - "Saving the API key encrypts via safeStorage and writes `<userData>/api_key.bin`; loading decrypts in main only; renderer never sees plaintext"
    - "First-launch migration converts a legacy cwd `config.json` with a `persona` field into `<userData>/characters/sui.json` and is idempotent"
    - "Linux fallback (basic_text backend) is detectable via apiKeyStore.backendKind() and surfaced as KEYCHAIN_FALLBACK_PLAINTEXT to callers"
  artifacts:
    - path: src/main/paths.ts
      provides: "Canonical resolution of userData paths (configPath, charactersDir, indexPath, apiKeyPath, logsDir, memoryDir)"
      exports: ["paths"]
    - path: src/main/configStore.ts
      provides: "loadConfig / saveConfig — UserConfigSchema-validated, atomic, per-path locked"
      exports: ["loadConfig", "saveConfig", "DEFAULT_CONFIG"]
    - path: src/main/characterStore.ts
      provides: "listCharacters / getCharacter / saveCharacter / deleteCharacter using existing brain/storage atomic-write + file-lock helpers"
      exports: ["listCharacters", "getCharacter", "saveCharacter", "deleteCharacter"]
    - path: src/main/apiKeyStore.ts
      provides: "saveApiKey / loadApiKey / hasApiKey / backendKind via Electron safeStorage"
      exports: ["saveApiKey", "loadApiKey", "hasApiKey", "backendKind"]
    - path: src/main/migration.ts
      provides: "runFirstLaunchMigration — idempotent legacy persona → characters/sui.json + cwd memory → userData memory transfer"
      exports: ["runFirstLaunchMigration"]
  key_links:
    - from: src/main/characterStore.ts
      to: src/bot/brain/storage/atomicWrite.js
      via: "ESM import (reuse existing atomic helper per CONTEXT)"
      pattern: "from '\\.\\./bot/brain/storage/atomicWrite"
    - from: src/main/characterStore.ts
      to: src/bot/brain/storage/fileLock.js
      via: "ESM import (reuse existing per-path mutex)"
      pattern: "from '\\.\\./bot/brain/storage/fileLock"
    - from: src/main/apiKeyStore.ts
      to: electron.safeStorage
      via: "encryptString / decryptString / isEncryptionAvailable / getSelectedStorageBackend"
      pattern: "safeStorage\\."
    - from: src/main/migration.ts
      to: src/main/characterStore.ts
      via: "saveCharacter call to write characters/sui.json"
      pattern: "saveCharacter"
---

<changes_made>
**Revision pass (BLOCKER 3, Warning 8):**
- Task 2 (`saveCharacter`): now calls `mkdir(paths.memoryDir(validated.id), { recursive: true })` after writing the character JSON, so the per-character memory directory exists before the bot's first OWNER.md/DIARY.md/AFFECT.md write. Added matching acceptance_criteria and verify grep.
- Task 3 (`runFirstLaunchMigration`): the cwd `config.json` strip-write is gated behind `!app.isPackaged` so packaged builds never attempt to mutate the signed read-only Sei.app bundle (would EROFS otherwise). Added matching acceptance_criteria and verify grep.
</changes_made>

<objective>
Build the three main-process persistence modules that back the renderer's character CRUD, user-config, and API-key flows: `configStore.ts`, `characterStore.ts`, `apiKeyStore.ts`. Add the first-launch migration that converts legacy `config.json.persona` into `characters/sui.json`. Establish `paths.ts` as the single source of truth for `<userData>/...` resolution.

Purpose: GUI-01 (setup form persists API key via OS keychain), GUI-04 (personality form), CONTEXT D-09..D-14 (multi-character data model + safeStorage). These four modules are pure file/IO + crypto — no Electron BrowserWindow / IPC code. They are consumed by `src/main/ipc.ts` (plan 04). Building them as a self-contained Wave-2 plan means later plans can depend on stable module surfaces.

Output: 5 TS files under `src/main/`. All file-IO uses the existing `src/bot/brain/storage/{atomicWrite,fileLock}.js` helpers (CONTEXT explicit "DO NOT roll a separate file-write helper").
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
@.planning/phases/04-electron-gui-packaging/04-02-shared-types-PLAN.md
@src/shared/characterSchema.ts
@src/shared/errorClasses.ts
@src/bot/brain/storage/atomicWrite.js
@src/bot/brain/storage/fileLock.js
@src/bot/brain/memory/owner.js
@src/bot/config.js

<interfaces>
<!-- Reuse contracts (from existing brain helpers — DO NOT reimplement) -->

From src/bot/brain/storage/atomicWrite.js:
```js
export async function atomicWrite(path, contents)   // tmp+rename, throws on error
```

From src/bot/brain/storage/fileLock.js:
```js
export async function withFileLock(filePath, fn)    // per-path serialized mutex
```

From src/bot/brain/memory/owner.js (analog for read-modify-write skeleton):
```js
async function loadOwner(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
  return parseFrontmatter(raw);
}
```

From src/shared/characterSchema.ts (Plan 02):
```ts
export const CharacterSchema, CharacterIndexSchema, UserConfigSchema
export type Character, CharacterIndex, UserConfig
```

From RESEARCH §"Pattern 4" (lines ~555–591) — safeStorage spec:
```ts
import { safeStorage, app } from 'electron';
const buf = safeStorage.encryptString(plaintext);     // -> Buffer
const plain = safeStorage.decryptString(buf);          // throws if KEYCHAIN_LOCKED
safeStorage.isEncryptionAvailable(): boolean
safeStorage.getSelectedStorageBackend(): 'kwallet'|'kwallet5'|'kwallet6'|'gnome_libsecret'|'basic_text'|'unknown'
```

From Electron docs (relied on by tasks below):
```ts
app.getPath('userData'): string         // platform-specific user-data directory
```
</interfaces>

<key_locked_decisions>
- D-09: One JSON file per character at `<userData>/characters/<id>.json` + `<userData>/characters/index.json` manifest.
- D-10: First-launch migration is IDEMPOTENT. Legacy `config.json.persona` (in cwd, from CLI users) → `characters/sui.json` with `id: 'sui'`, `is_default: true`, `created: <now>`, `last_launched: null`, `playtime_ms: 0`. Strip `persona` from config.
- D-11: `last_launched` ISO; `playtime_ms` accumulating; `created` immutable.
- D-12: `<userData>/config.json` keeps `mc_username`, `preferred_name`, `provider`, `theme_mode` only. NEVER api key.
- D-13: API key via Electron `safeStorage` → `<userData>/api_key.bin`.
- D-14: Optional `portrait_image: '<id>.png'` relative; missing file → fall back to procedural in renderer.
- RESEARCH Pitfall 3: Linux without kwallet/libsecret falls back to `basic_text` (plaintext-with-hardcoded-key). Detect via `getSelectedStorageBackend()`; surface `KEYCHAIN_FALLBACK_PLAINTEXT` warning. Don't block.
- RESEARCH §Pattern 4 + PATTERNS §`apiKeyStore.ts`: reuse `atomicWrite` for the encrypted blob (write Buffer as binary, not base64).
- CONTEXT explicit: "DO NOT roll a separate file-write helper" — reuse `src/bot/brain/storage/atomicWrite.js` and `fileLock.js`.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Create src/main/paths.ts + src/main/configStore.ts</name>
  <read_first>
    - src/shared/characterSchema.ts (UserConfigSchema, UserConfig type — created in plan 02)
    - src/bot/brain/storage/atomicWrite.js (atomicWrite implementation — verify ESM export shape)
    - src/bot/brain/storage/fileLock.js (withFileLock implementation — verify ESM export shape)
    - src/bot/config.js (lines 86–118 — `migrateLegacyAdapterFields` + `loadConfig` patterns to mirror)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/configStore.ts" (lines ~226–278)
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-09, D-12
  </read_first>
  <behavior>
    - `paths.userData()` returns `app.getPath('userData')` (called lazily — Electron app must be ready before this runs).
    - `paths.configPath()`, `paths.charactersDir()`, `paths.indexPath()`, `paths.apiKeyPath()`, `paths.logsDir()`, `paths.memoryDir()` return correct subpaths under userData.
    - `loadConfig()` reads `<userData>/config.json` if it exists; if missing, returns `DEFAULT_CONFIG` (all UserConfigSchema defaults). On parse error, throws.
    - `saveConfig(cfg)` validates with UserConfigSchema, atomic-writes JSON, runs under withFileLock so two simultaneous saves don't corrupt the file.
    - `loadConfig()` strips any `persona` key (legacy from CLI users) — caller (migration) handles surfacing it; loadConfig itself just sanitizes.
  </behavior>
  <action>
**Step 1.** Create `src/main/paths.ts`:

```ts
/**
 * Canonical userData path resolution. ALL `<userData>/...` reads/writes
 * across main process must funnel through here so test harnesses can
 * later override `userDataOverride` if needed.
 *
 * Source: CONTEXT D-09 (paths under app.getPath('userData')).
 */
import { app } from 'electron';
import path from 'node:path';

let userDataOverride: string | null = null;

/** TEST-ONLY: override userData root. Production code must not call this. */
export function _setUserDataOverride(p: string | null): void {
  userDataOverride = p;
}

function userDataRoot(): string {
  return userDataOverride ?? app.getPath('userData');
}

export const paths = {
  userData: userDataRoot,
  configPath: () => path.join(userDataRoot(), 'config.json'),
  charactersDir: () => path.join(userDataRoot(), 'characters'),
  characterPath: (id: string) => path.join(userDataRoot(), 'characters', `${id}.json`),
  characterPortraitPath: (id: string) => path.join(userDataRoot(), 'characters', `${id}.png`),
  indexPath: () => path.join(userDataRoot(), 'characters', 'index.json'),
  apiKeyPath: () => path.join(userDataRoot(), 'api_key.bin'),
  logsDir: () => path.join(userDataRoot(), 'logs'),
  memoryDir: (characterId: string) => path.join(userDataRoot(), 'memory', characterId),
};
```

**Step 2.** Create `src/main/configStore.ts`:

```ts
/**
 * UserConfig persistence: <userData>/config.json.
 * Reads/writes are Zod-validated and atomic.
 *
 * Sources:
 *   - PATTERNS §src/main/configStore.ts
 *   - CONTEXT D-09 (path), D-12 (schema — no api_key)
 *   - Reuse: src/bot/brain/storage/atomicWrite.js + fileLock.js
 */
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { UserConfigSchema, type UserConfig } from '../shared/characterSchema';
// ESM imports of existing brain JS helpers (.js extension required under nodenext-style resolution)
// @ts-expect-error - JS module without .d.ts; keeping .js for ESM resolution under TS allowJs.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
// @ts-expect-error - JS module without .d.ts.
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';

export const DEFAULT_CONFIG: UserConfig = UserConfigSchema.parse({});

/**
 * Load config. Missing file → return DEFAULT_CONFIG.
 * Legacy `persona` field (from CLI users) is silently stripped — migration
 * runFirstLaunchMigration handles transferring it to characters/sui.json.
 */
export async function loadConfig(): Promise<UserConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.configPath(), 'utf8');
  } catch (err: unknown) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`Invalid JSON in ${paths.configPath()}: ${(err as Error).message}`);
  }

  // Strip legacy fields the schema doesn't know about (persona, anthropic.api_key, etc.)
  // UserConfigSchema only knows mc_username/preferred_name/provider/theme_mode.
  return UserConfigSchema.parse(parsed);
}

export async function saveConfig(config: UserConfig): Promise<void> {
  const validated = UserConfigSchema.parse(config);
  const target = paths.configPath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}
```

Implementation notes:
- The `@ts-expect-error` annotations on the JS imports suppress TS's "no declaration file" complaint cleanly. The `allowJs: true` in tsconfig.node.json (plan 01) means imports work at runtime.
- All file-creation paths use `mkdir(..., { recursive: true })` because `<userData>/...` may not exist on first run.
- `withFileLock(target, ...)` uses the file path as the lock key, exactly as `owner.js` does.
  </action>
  <verify>
    <automated>test -f src/main/paths.ts && test -f src/main/configStore.ts && grep -q "export const paths" src/main/paths.ts && grep -q "configPath: () =>" src/main/paths.ts && grep -q "apiKeyPath: () =>" src/main/paths.ts && grep -q "memoryDir: (characterId" src/main/paths.ts && grep -q "import { UserConfigSchema" src/main/configStore.ts && grep -q "from '../bot/brain/storage/atomicWrite.js'" src/main/configStore.ts && grep -q "from '../bot/brain/storage/fileLock.js'" src/main/configStore.ts && grep -q "export async function loadConfig" src/main/configStore.ts && grep -q "export async function saveConfig" src/main/configStore.ts && grep -q "export const DEFAULT_CONFIG" src/main/configStore.ts && grep -q "withFileLock(target" src/main/configStore.ts && grep -q "atomicWrite(target" src/main/configStore.ts && ! grep -q "fs.writeFile\|fs\.promises\.writeFile\|writeFile.*config\.json" src/main/configStore.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "(paths|configStore)\.ts.*error TS" | grep -v "TS6053\|TS6307\|TS2307.*../bot/" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/paths.ts` exists and exports `paths` object with at least 7 path functions: `userData`, `configPath`, `charactersDir`, `characterPath`, `indexPath`, `apiKeyPath`, `logsDir`, `memoryDir`
    - `src/main/configStore.ts` exists
    - `configStore.ts` imports `UserConfigSchema` and `UserConfig` from `'../shared/characterSchema'`
    - `configStore.ts` imports `atomicWrite` from `'../bot/brain/storage/atomicWrite.js'` (note `.js` extension)
    - `configStore.ts` imports `withFileLock` from `'../bot/brain/storage/fileLock.js'`
    - `configStore.ts` exports `loadConfig`, `saveConfig`, `DEFAULT_CONFIG`
    - `configStore.ts` does NOT contain raw `fs.writeFile` calls for config.json (must funnel through atomicWrite — verified by grep returning 0 for `fs.writeFile.*config\.json`)
    - `saveConfig` body wraps `atomicWrite` call inside `withFileLock(target, async () => { ... })`
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `paths.ts` and `configStore.ts` (TS2307 referring to `../bot/...` paths is tolerated since those JS files don't have .d.ts files; allowJs handles them at compile time)
  </acceptance_criteria>
  <done>UserConfig persistence layer ready: any caller can `import { loadConfig, saveConfig } from '../main/configStore'` and round-trip a UserConfig. Path resolution centralized in `paths.ts`.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Create src/main/characterStore.ts + src/main/apiKeyStore.ts</name>
  <read_first>
    - src/shared/characterSchema.ts (CharacterSchema, CharacterIndexSchema, Character, CharacterIndex types)
    - src/bot/brain/memory/owner.js (lines 65–78 — `loadOwner` ENOENT-tolerant read pattern)
    - src/bot/brain/storage/atomicWrite.js
    - src/bot/brain/storage/fileLock.js
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/characterStore.ts" (lines ~174–223)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/apiKeyStore.ts" (lines ~318–331)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pattern 4: safeStorage" (lines ~555–591)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 3" (lines ~664–669)
    - src/main/paths.ts (created in Task 1)
  </read_first>
  <behavior>
    **characterStore.ts:**
    - `listCharacters()` reads `<userData>/characters/index.json`, parses with `CharacterIndexSchema`, then for each id reads/parses the corresponding character JSON. Returns `Character[]` ordered by `index.order`. Missing/corrupt index → returns `[]`. Skip individual character files that fail to parse (log a warn, don't throw the whole list).
    - `getCharacter(id)` reads `<userData>/characters/<id>.json` and parses. Missing file → returns `null` (not throws — UI calls `hasCharacter` semantics).
    - `saveCharacter(c)` validates with CharacterSchema, atomic-writes JSON under file-lock, AND updates `index.json` (appends id if new) under the index file's lock. New char → adds to end of order; existing → no order change.
    - `deleteCharacter(id)` removes `<id>.json`, optional `<id>.png`, recursively removes `<userData>/memory/<id>/`, and removes id from `index.order`. Idempotent (deleting absent id is a no-op without error).

    **apiKeyStore.ts:**
    - `saveApiKey(plaintext)` calls `safeStorage.encryptString(plaintext)` → Buffer → atomicWrite to `<userData>/api_key.bin`. Throws `KEYCHAIN_UNAVAILABLE` if `safeStorage.isEncryptionAvailable()` is false.
    - `loadApiKey()` reads file, returns `safeStorage.decryptString(buf)`. Throws if file missing or decrypt fails (caller maps to `KEYCHAIN_LOCKED`).
    - `hasApiKey()` returns true iff file exists.
    - `backendKind()` returns `safeStorage.getSelectedStorageBackend()` (or 'unknown' if API not present). Renderer-facing callers use this to surface the `KEYCHAIN_FALLBACK_PLAINTEXT` warning when result is `'basic_text'`.
  </behavior>
  <action>
**Step 1.** Create `src/main/characterStore.ts`:

```ts
/**
 * Per-character JSON CRUD: `<userData>/characters/<id>.json` + index.json manifest.
 *
 * Sources:
 *   - PATTERNS §src/main/characterStore.ts
 *   - CONTEXT D-09 (file layout), D-11 (timestamps)
 *   - Reuse: existing brain atomicWrite + withFileLock helpers
 */
import { readFile, mkdir, unlink, rm } from 'node:fs/promises';
import { CharacterSchema, CharacterIndexSchema, type Character, type CharacterIndex } from '../shared/characterSchema';
// @ts-expect-error - JS module without .d.ts.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
// @ts-expect-error - JS module without .d.ts.
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

async function readJson<T>(p: string): Promise<T | null> {
  let raw: string;
  try { raw = await readFile(p, 'utf8'); }
  catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

async function loadIndex(): Promise<CharacterIndex> {
  const data = await readJson<unknown>(paths.indexPath());
  if (!data) return CharacterIndexSchema.parse({});
  try { return CharacterIndexSchema.parse(data); }
  catch (err) {
    logger.warn(`characters/index.json invalid; treating as empty: ${(err as Error).message}`);
    return CharacterIndexSchema.parse({});
  }
}

async function writeIndex(idx: CharacterIndex): Promise<void> {
  const target = paths.indexPath();
  await mkdir(paths.charactersDir(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(idx, null, 2) + '\n');
  });
}

export async function listCharacters(): Promise<Character[]> {
  const idx = await loadIndex();
  const out: Character[] = [];
  for (const id of idx.order) {
    try {
      const c = await getCharacter(id);
      if (c) out.push(c);
    } catch (err) {
      logger.warn(`characters/${id}.json failed to load: ${(err as Error).message}`);
    }
  }
  return out;
}

export async function getCharacter(id: string): Promise<Character | null> {
  const data = await readJson<unknown>(paths.characterPath(id));
  if (!data) return null;
  return CharacterSchema.parse(data);
}

export async function saveCharacter(character: Character): Promise<void> {
  const validated = CharacterSchema.parse(character);
  const target = paths.characterPath(validated.id);
  await mkdir(paths.charactersDir(), { recursive: true });

  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });

  // BLOCKER-3 fix: pre-create the per-character memory directory so the
  // bot's atomic-write helper (which assumes the parent dir exists) can
  // write OWNER.md / DIARY.md / AFFECT.md on first run without ENOENT.
  // The bot supervisor injects explicit memory paths under this dir
  // (per BLOCKER-2 fix in plan 04 task 2).
  await mkdir(paths.memoryDir(validated.id), { recursive: true });

  // Maintain index ordering — append new ids; leave existing order alone.
  const idx = await loadIndex();
  if (!idx.order.includes(validated.id)) {
    idx.order.push(validated.id);
    await writeIndex(idx);
  }
}

export async function deleteCharacter(id: string): Promise<void> {
  // Remove JSON
  try { await unlink(paths.characterPath(id)); }
  catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove optional portrait
  try { await unlink(paths.characterPortraitPath(id)); }
  catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove memory dir recursively (idempotent)
  await rm(paths.memoryDir(id), { recursive: true, force: true });

  // Remove from index
  const idx = await loadIndex();
  const next = idx.order.filter((x) => x !== id);
  if (next.length !== idx.order.length) {
    idx.order = next;
    await writeIndex(idx);
  }
}
```

**Step 2.** Create `src/main/apiKeyStore.ts`:

```ts
/**
 * API key persistence via Electron safeStorage.
 *
 * Sources:
 *   - PATTERNS §src/main/apiKeyStore.ts
 *   - RESEARCH §Pattern 4 + Pitfall 3 (Linux basic_text fallback)
 *   - CONTEXT D-13
 *
 * SECURITY: This module is main-process only. The renderer NEVER imports
 * from here. Plaintext crosses to utilityProcess via MessagePortMain only.
 */
import { safeStorage } from 'electron';
import { readFile, writeFile, access, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths';

/**
 * Persist plaintext API key encrypted by OS keychain.
 * Note: We use raw fs.writeFile (with a tmp+rename to keep it atomic) instead
 * of the brain's atomicWrite helper because that helper writes utf8 strings —
 * the encrypted blob is binary and must be written as Buffer.
 */
export async function saveApiKey(plaintext: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('KEYCHAIN_UNAVAILABLE');
  }
  const buf = safeStorage.encryptString(plaintext);
  const target = paths.apiKeyPath();
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(tmp, buf);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export async function hasApiKey(): Promise<boolean> {
  try { await access(paths.apiKeyPath()); return true; }
  catch { return false; }
}

/**
 * Decrypt and return the plaintext API key. Throws if the file is missing
 * or decrypt fails (e.g., user is locked out of Keychain). Caller maps to
 * the `KEYCHAIN_LOCKED` ErrorClass.
 */
export async function loadApiKey(): Promise<string> {
  const buf = await readFile(paths.apiKeyPath());
  return safeStorage.decryptString(buf);
}

/**
 * Returns the safeStorage backend name. On Linux without a desktop secret
 * store this returns `'basic_text'`, signalling that encryption is using a
 * hardcoded key (effectively plaintext) — surfaced to the user as the
 * KEYCHAIN_FALLBACK_PLAINTEXT warning per RESEARCH Pitfall 3.
 *
 * Possible values: 'kwallet' | 'kwallet5' | 'kwallet6' | 'gnome_libsecret' |
 *                  'basic_text' | 'unknown' (older Electron without API)
 */
export function backendKind(): string {
  const fn = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof fn !== 'function') return 'unknown';
  try { return fn.call(safeStorage); }
  catch { return 'unknown'; }
}
```

Note on `apiKeyStore.ts`: PATTERNS suggests "string-encode for atomicWrite (toString('base64'))" but storing as binary preserves the cleanest decryption round-trip and avoids accidentally introducing a base64 mismatch on reads. The hand-rolled tmp+rename mirrors the atomic-write algorithm exactly (same tmp path shape as `atomicWrite.js` lines 22–36).
  </action>
  <verify>
    <automated>test -f src/main/characterStore.ts && test -f src/main/apiKeyStore.ts && grep -q "export async function listCharacters" src/main/characterStore.ts && grep -q "export async function getCharacter" src/main/characterStore.ts && grep -q "export async function saveCharacter" src/main/characterStore.ts && grep -q "export async function deleteCharacter" src/main/characterStore.ts && grep -q "from '../bot/brain/storage/atomicWrite.js'" src/main/characterStore.ts && grep -q "from '../bot/brain/storage/fileLock.js'" src/main/characterStore.ts && grep -q "CharacterSchema.parse" src/main/characterStore.ts && grep -q "CharacterIndexSchema.parse" src/main/characterStore.ts && grep -q "rm(paths.memoryDir" src/main/characterStore.ts && grep -q "mkdir(paths.memoryDir" src/main/characterStore.ts && grep -q "withFileLock(target" src/main/characterStore.ts && grep -q "import { safeStorage } from 'electron'" src/main/apiKeyStore.ts && grep -q "export async function saveApiKey" src/main/apiKeyStore.ts && grep -q "export async function loadApiKey" src/main/apiKeyStore.ts && grep -q "export async function hasApiKey" src/main/apiKeyStore.ts && grep -q "export function backendKind" src/main/apiKeyStore.ts && grep -q "safeStorage.encryptString" src/main/apiKeyStore.ts && grep -q "safeStorage.decryptString" src/main/apiKeyStore.ts && grep -q "isEncryptionAvailable" src/main/apiKeyStore.ts && grep -q "getSelectedStorageBackend" src/main/apiKeyStore.ts && ! grep -E "import.*safeStorage|safeStorage" src/main/characterStore.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "(characterStore|apiKeyStore)\.ts.*error TS" | grep -v "TS2307.*../bot/\|TS6053\|TS6307" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/characterStore.ts` exports `listCharacters`, `getCharacter`, `saveCharacter`, `deleteCharacter`
    - `characterStore.ts` imports `atomicWrite` from `'../bot/brain/storage/atomicWrite.js'` and `withFileLock` from `'../bot/brain/storage/fileLock.js'` (no separate file-write helper rolled)
    - `characterStore.ts` parses with `CharacterSchema.parse` on every `getCharacter` and `saveCharacter`
    - `characterStore.ts` parses index manifest with `CharacterIndexSchema.parse`
    - `deleteCharacter` removes the memory dir via `rm(paths.memoryDir(id), { recursive: true, force: true })` (verified by literal substring)
    - **BLOCKER-3 fix:** `saveCharacter` calls `mkdir(paths.memoryDir(validated.id), { recursive: true })` after writing the character JSON (verified by grep `mkdir(paths.memoryDir`) — guarantees the bot's memory parent dir exists before first OWNER.md/DIARY.md/AFFECT.md write
    - `characterStore.ts` does NOT import `safeStorage` (separation of concerns: only apiKeyStore knows about secrets — verified by grep)
    - `src/main/apiKeyStore.ts` imports `safeStorage` from `'electron'`
    - `apiKeyStore.ts` exports `saveApiKey`, `loadApiKey`, `hasApiKey`, `backendKind`
    - `saveApiKey` body contains `safeStorage.encryptString(plaintext)` and `safeStorage.isEncryptionAvailable()` check
    - `loadApiKey` body contains `safeStorage.decryptString(buf)`
    - `backendKind` body references `getSelectedStorageBackend` (defensive — Electron <22 may lack it)
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `characterStore.ts` and `apiKeyStore.ts` (TS2307 for `../bot/...` is tolerated)
  </acceptance_criteria>
  <done>Character JSON CRUD + safeStorage-backed API key persistence ready. Both modules use existing brain helpers; no key plaintext leaks to disk.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Create src/main/migration.ts (first-launch idempotent migration)</name>
  <read_first>
    - src/bot/config.js (lines 86–100 — `migrateLegacyAdapterFields` early-return idempotency pattern)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/main/migration.ts" (lines ~265–276)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"Idempotent migrations" (lines ~700–704)
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-10 (legacy persona migration)
    - src/main/characterStore.ts (saveCharacter — created in Task 2)
    - src/main/configStore.ts (loadConfig / saveConfig — created in Task 1)
  </read_first>
  <behavior>
    - On first run: detect a legacy `cwd/config.json` (the CLI shipping format with a top-level `persona: {name, backstory, tone}` field). If it exists AND `<userData>/characters/sui.json` is absent, write `characters/sui.json` with `id: 'sui'`, `name: persona.name || 'Sui'`, `description: ''`, `persona_prompt: persona.backstory || `, `is_default: true`, `created: <now>`, `last_launched: null`, `playtime_ms: 0`, `portrait_image: null`. Then strip `persona` from the legacy config and re-save.
    - Idempotent: running twice does not duplicate; re-running is a no-op (early-return when sui.json already exists).
    - Behavior is conservative: if legacy file is malformed JSON, log a warn and do NOT crash — the user can re-onboard.
    - **Per RESEARCH §Resolved Q4: cross-machine cwd/config.json migration is OUT of scope.** This task only handles the case where the user dev-cloned and runs the Electron app from the same cwd that has the CLI's `config.json`. In packaged builds the cwd is typically the installer directory and no legacy file exists — migration is a no-op. Document this in code comments.
    - Do NOT migrate `cwd/memory/` → `<userData>/memory/sui/`. Per RESEARCH §Resolved Q4 (TREAT AS FRESH), packaged users start fresh.
  </behavior>
  <action>
Create `src/main/migration.ts`:

```ts
/**
 * First-launch migration. Idempotent.
 *
 * Sources:
 *   - CONTEXT D-10 (legacy persona → characters/sui.json)
 *   - RESEARCH §Resolved Q4 (TREAT AS FRESH — no cross-machine migration)
 *   - PATTERNS §"Idempotent migrations" (early-return pattern)
 *
 * Scope (v1):
 *   - Dev-clone case: user runs Electron app from same cwd that has CLI's config.json.
 *     We pull persona out and write characters/sui.json, then strip persona from cwd config.
 *   - Packaged-app case: cwd has no legacy file → no-op.
 *
 * Out of scope:
 *   - cross-machine migration of `cwd/memory/` → `<userData>/memory/sui/`.
 *     Packaged users start fresh per RESEARCH §Resolved Q4.
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { saveCharacter } from './characterStore';
import { paths } from './paths';
import type { Character } from '../shared/characterSchema';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; }
  catch { return false; }
}

interface LegacyPersona {
  name?: string;
  backstory?: string;
  tone?: string;
}

interface LegacyConfigShape {
  persona?: LegacyPersona;
  [key: string]: unknown;
}

/**
 * Run on app boot, AFTER app.whenReady so userData path resolves.
 *
 * @param cwdConfigPath  Path to the legacy CLI's config.json (defaults to './config.json' in cwd).
 *                       Tests can pass a fixture path.
 */
export async function runFirstLaunchMigration(
  cwdConfigPath: string = path.resolve(process.cwd(), 'config.json'),
): Promise<void> {
  // Idempotent guard: already migrated → no-op
  if (await fileExists(paths.characterPath('sui'))) {
    return;
  }

  // No legacy file → nothing to migrate (packaged-app case)
  if (!await fileExists(cwdConfigPath)) {
    return;
  }

  let raw: string;
  try { raw = await readFile(cwdConfigPath, 'utf8'); }
  catch (err) {
    logger.warn(`migration: legacy config read failed: ${(err as Error).message}`);
    return;
  }

  let parsed: LegacyConfigShape;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    logger.warn(`migration: legacy config invalid JSON, skipping: ${(err as Error).message}`);
    return;
  }

  if (!parsed.persona || typeof parsed.persona !== 'object') {
    return; // already migrated or never had a persona
  }

  const p = parsed.persona;
  const character: Character = {
    id: 'sui',
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Sui',
    description: '',
    persona_prompt: typeof p.backstory === 'string' && p.backstory.trim()
      ? p.backstory
      : `You are ${typeof p.name === 'string' ? p.name : 'Sui'}, a Minecraft companion.`,
    is_default: true,
    created: new Date().toISOString(),
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
  };

  try {
    await saveCharacter(character);
    logger.info(`migration: created characters/sui.json from legacy persona`);
  } catch (err) {
    logger.warn(`migration: saveCharacter failed: ${(err as Error).message}`);
    return;
  }

  // Strip persona from legacy file (idempotent — running twice is harmless).
  // WARNING-8 fix: only attempt to mutate the cwd legacy file when running
  // unpackaged (dev clone). In packaged builds the cwd is typically the
  // installer dir / signed Sei.app bundle, which is read-only — writeFile
  // would throw EROFS and noisily mark the otherwise-clean migration as
  // failed. Skipping the strip-write in packaged mode is harmless because
  // packaged users never had a legacy CLI cwd config to begin with (per
  // RESEARCH §Resolved Q4 — packaged users start fresh).
  const { persona, ...rest } = parsed;
  void persona;
  if (!app.isPackaged) {
    try {
      await writeFile(cwdConfigPath, JSON.stringify(rest, null, 2) + '\n', 'utf8');
      logger.info(`migration: stripped persona field from ${cwdConfigPath}`);
    } catch (err) {
      logger.warn(`migration: failed to strip persona from legacy config: ${(err as Error).message}`);
    }
  } else {
    logger.info('migration: skipping cwd config strip-write in packaged build (read-only bundle)');
  }
}
```
  </action>
  <verify>
    <automated>test -f src/main/migration.ts && grep -q "export async function runFirstLaunchMigration" src/main/migration.ts && grep -q "if (await fileExists(paths.characterPath('sui')))" src/main/migration.ts && grep -q "saveCharacter(character)" src/main/migration.ts && grep -q "is_default: true" src/main/migration.ts && grep -q "id: 'sui'" src/main/migration.ts && grep -q "TREAT AS FRESH\|packaged users start fresh\|RESEARCH §Resolved Q4\|RESEARCH .Resolved Q4" src/main/migration.ts && ! grep -q "memoryDir\|memory/sui" src/main/migration.ts && grep -q "app.isPackaged" src/main/migration.ts && grep -q "if (!app.isPackaged)" src/main/migration.ts && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E "migration\.ts.*error TS" | grep -v "TS6053\|TS6307" | grep -c "" | grep -qE '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - `src/main/migration.ts` exists
    - Exports `runFirstLaunchMigration(cwdConfigPath?: string): Promise<void>`
    - Function body contains the idempotent early-return: `if (await fileExists(paths.characterPath('sui')))`
    - Function calls `saveCharacter(character)` with `id: 'sui'` and `is_default: true`
    - File contains a comment string referencing `RESEARCH §Resolved Q4` AND words `packaged users start fresh` (or `TREAT AS FRESH`) — proving the executor read and respected the scoping decision
    - File does NOT touch memory directories — verified by grep returning 0 for `memoryDir` and `memory/sui` in this file
    - **WARNING-8 fix:** the cwd `writeFile(cwdConfigPath, ...)` strip-write is gated behind `if (!app.isPackaged) { ... }` (verified by grep `if (!app.isPackaged)`), preventing EROFS attempts to mutate the signed Sei.app bundle in packaged builds
    - `npx tsc --noEmit -p tsconfig.node.json` reports 0 errors for `migration.ts`
  </acceptance_criteria>
  <done>First-launch migration ready. Plan 04 wires the call into `app.whenReady()` (after createMainWindow, before createBotSupervisor).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| filesystem→main | Reading user-controlled JSON; trust nothing — Zod validates every parse |
| main→OS keychain | safeStorage abstraction; OS provides isolation |
| renderer→main (downstream) | Plan 04's IPC layer must re-validate Character payloads — these stores accept ANY caller's input |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-08 | Tampering | malformed JSON in characters/sui.json | mitigate | `CharacterSchema.parse()` rejects with descriptive error; getCharacter returns null on missing, but throws on malformed (caller surfaces to user as load error). |
| T-04-09 | Information Disclosure | api_key.bin contents leaking via crash dumps / logs | mitigate | Plaintext key never written to disk; safeStorage encrypts before fs.writeFile; loadApiKey only returns to in-memory string passed to utilityProcess via MessagePort (never IPC) |
| T-04-10 | Information Disclosure | Linux basic_text fallback (effectively plaintext) | accept (warn) | `backendKind()` returns 'basic_text' → main surfaces KEYCHAIN_FALLBACK_PLAINTEXT warning per RESEARCH Pitfall 3; user accepts risk on Linux best-effort builds |
| T-04-11 | Tampering | symlink attack on `<userData>/api_key.bin` | mitigate | atomicWrite uses tmp+rename in same dir; Electron's userData path is per-user OS-protected (Library/Application Support on macOS, AppData on Windows) — only the user can write there |
| T-04-12 | Denial of Service | concurrent saveCharacter on same id → corrupt file | mitigate | `withFileLock(target, ...)` serializes per-path mutations; existing brain helper proven in Phase 3 |
| T-04-13 | Tampering | migration runs more than once and clobbers user data | mitigate | Idempotent guard `if (await fileExists(paths.characterPath('sui'))) return` — re-running is safe |
</threat_model>

<verification>
- `npx tsc --noEmit -p tsconfig.node.json` exits with 0 errors for `src/main/{paths,configStore,characterStore,apiKeyStore,migration}.ts`
- `grep -L "atomicWrite\|withFileLock" src/main/{configStore,characterStore}.ts` returns nothing (both files use the existing helpers)
- `grep -L "import.*safeStorage" src/main/apiKeyStore.ts` returns nothing (safeStorage is imported)
- `grep -l "safeStorage" src/main/characterStore.ts src/main/configStore.ts src/main/migration.ts` returns nothing (separation of concerns: only apiKeyStore touches safeStorage)
</verification>

<success_criteria>
- Plan 04 (botSupervisor + main entry + IPC) imports `loadConfig`, `saveConfig`, `loadApiKey`, `listCharacters`, `getCharacter`, `saveCharacter`, `deleteCharacter`, `runFirstLaunchMigration` and wires them into `ipcMain.handle` registrations.
- Plan 10 (packaging) does not need to change anything in these modules — they're stable.
- Plan 11 (clean-VM smoke) verifies that fresh-install creates `<userData>/config.json`, `characters/index.json`, `characters/sui.json` (after onboarding) and `api_key.bin` (after onboarding step 4) without errors.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-03-SUMMARY.md` documenting:
- Module surface signatures (final exported function shapes — paste from code)
- Confirmation that all file IO funnels through `atomicWrite` / `withFileLock` (or hand-rolled tmp+rename for the binary api_key.bin)
- Note for plan 04 executor: `runFirstLaunchMigration` MUST be called inside `app.whenReady().then(...)` BEFORE the first `loadConfig()` is called (because migration may strip a stale persona field that loadConfig would silently drop anyway, but ordering is cleaner this way).
- Note for plan 11 executor: `paths._setUserDataOverride(...)` exists for testing but production code never calls it.
</output>
