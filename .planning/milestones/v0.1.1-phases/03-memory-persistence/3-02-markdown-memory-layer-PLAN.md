---
phase: 03-memory-persistence
plan: 02
type: execute
wave: 2
depends_on: ["3-01"]
files_modified:
  - src/storage/atomicWrite.js
  - src/memory/owner.js
  - src/memory/diary.js
  - src/llm/sessionState.js
  - src/llm/orchestrator.js
  - src/bot.js
  - src/config.js
  - scripts/verify-phase3-memory.js
autonomous: true
requirements: [MEM-03, MEM-04, MEM-05]
tags: [memory, persistence, owner, diary, atomic-write, session, mineflayer]

must_haves:
  truths:
    - "On first owner-chat or first session-start with owner present, `OWNER.md` is created atomically with `owner_uuid`, `owner_username`, `first_seen`, `last_seen`, `total_sessions=1`"
    - "After OWNER.md exists, owner recognition uses UUID; username changes do not break recognition"
    - "Every Loop's seed user turn includes `OWNER.md` content (≤ seed_owner_budget_bytes) and a recency-truncated DIARY.md slice (≤ seed_diary_budget_bytes)"
    - "OWNER.md and DIARY.md writes go through `atomicWrite()` (tmp + rename in same dir); the `tmp` file lives next to the target, never `os.tmpdir()`"
    - "A bot started with no memory files boots cleanly; the seed user turn contains a `(no prior history yet)` placeholder"
    - "Files are created lazily on first write — never on read (Q4)"
    - "`src/bot.js` wires `playerJoined` / `playerLeft` listeners and a ~500ms post-spawn settle delay (D-57)"
  artifacts:
    - path: "src/storage/atomicWrite.js"
      provides: "atomicWrite(path, contents) — writeFile(tmp); rename(tmp, target) with same-dir tmp"
      min_lines: 15
    - path: "src/memory/owner.js"
      provides: "loadOwner(path), saveOwner(path, fields), formatOwnerSeedBlock(owner, budgetBytes)"
      min_lines: 60
    - path: "src/memory/diary.js"
      provides: "createDiary({ path, seedDiaryBudgetBytes }): { readAll, appendEntry, seedSlice, replaceOlderHalf }"
      min_lines: 80
    - path: "src/llm/sessionState.js"
      provides: "createSessionState({ ownerStore, diary, config, bot, logger }): { onPlayerJoined, onPlayerLeft, onSpawn, onLoopTerminal, ownerPresent, _internal }"
      min_lines: 80
    - path: "src/config.js"
      provides: "Full memory: block per D-59 (owner_md_path, diary_md_path, loop_batch_loop_count_cap, loop_batch_context_cap_bytes, sessions_per_consolidation, diary_size_cap_bytes, seed_diary_budget_bytes, seed_owner_budget_bytes)"
      contains: "owner_md_path"
    - path: "scripts/verify-phase3-memory.js"
      provides: "Cases: owner-uuid, fresh-install, atomic-write, lazy-create, seed-content-shape, username-change-recognition"
      min_lines: 80
  key_links:
    - from: "src/llm/orchestrator.js"
      to: "src/memory/owner.js + src/memory/diary.js"
      via: "Loop seed turn loader: composes seed_owner + seed_diary blocks on first user turn (D-45)"
      pattern: "seed_owner|seed_diary"
    - from: "src/bot.js"
      to: "src/llm/sessionState.js"
      via: "bot.on('playerJoined'/'playerLeft') + setTimeout(onSpawn, 500)"
      pattern: "playerJoined|playerLeft"
    - from: "src/memory/diary.js"
      to: "src/storage/atomicWrite.js"
      via: "atomicWrite for every append + replaceOlderHalf"
      pattern: "atomicWrite"
---

<objective>
Add the markdown memory layer: `OWNER.md` (YAML frontmatter + `# Notes`), `DIARY.md` (newest-first dated entries), atomic-write helper, owner UUID detection, and a session-state module that owns counters and lifecycle handlers. Wire the seed-message loader into the orchestrator so every Loop's first user turn carries OWNER + DIARY content as `seed_owner` / `seed_diary` blocks (D-45).

Purpose: Persist owner identity and game progression across restarts. Provide the seed user-turn content that satisfies MEM-03 (owner UUID recognition), MEM-04 (DIARY.md game progression), and MEM-05 (atomic writes + soft size cap, no SQLite).

Output: `src/storage/atomicWrite.js`, `src/memory/owner.js`, `src/memory/diary.js`, `src/llm/sessionState.js`, extended `src/config.js`, modified `src/bot.js` and `src/llm/orchestrator.js` (seed-loader wiring), `scripts/verify-phase3-memory.js`.

Compaction call dispatch is OUT OF SCOPE — Plan 3-03 plugs into the `onLoopTerminal` hook this plan exposes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/03-memory-persistence/03-CONTEXT.md
@.planning/phases/03-memory-persistence/03-SPEC.md
@.planning/phases/03-memory-persistence/03-RESEARCH.md
@.planning/phases/03-memory-persistence/03-PATTERNS.md
@.planning/phases/03-memory-persistence/03-01-SUMMARY.md

@src/llm/loop.js
@src/llm/orchestrator.js
@src/llm/inflight.js
@src/llm/goals.js
@src/bot.js
@src/config.js

<interfaces>
<!-- Locked from CONTEXT D-46..D-50, D-56..D-58, D-59 + verified mineflayer shape -->

OwnerStore (src/memory/owner.js):
```typescript
type OwnerData = {
  owner_uuid: string | null,
  owner_username: string | null,
  first_seen: string | null,    // ISO
  last_seen: string | null,     // ISO
  total_sessions: number,       // default 0
  preferred_name: string | null,
  pronouns: string | null,
  notes: string,                // freeform # Notes section body
  exists: boolean,              // false if file absent on disk (fresh install)
}

async function loadOwner(path: string): Promise<OwnerData>
async function saveOwner(path: string, data: OwnerData): Promise<void>   // atomic
function formatOwnerSeedBlock(owner: OwnerData, budgetBytes: number): string
  // Returns the verbatim `# Owner` markdown block to inject as a `seed_owner` text block.
  // If !owner.exists, returns "# Owner\n(no owner recorded yet)\n".
```

Diary (src/memory/diary.js):
```typescript
type DiaryEntry = { headingLine: string, body: string, isConsolidated: boolean }

interface Diary {
  readAll(): Promise<DiaryEntry[]>
  appendEntry(opts: { topic: string, body: string, when?: Date }): Promise<void>   // atomic; lazy-creates file
  seedSlice(): Promise<string>   // newest-first byte-budget walk; returns the verbatim `# Diary (recent first)` markdown
  replaceOlderHalf(replacement: string): Promise<void>   // atomic; for consolidation (Plan 3-03 consumer)
  getFileSizeBytes(): Promise<number>   // 0 if file absent
}

function createDiary(opts: { path: string, seedDiaryBudgetBytes: number, logger?: any }): Diary
```

SessionState (src/llm/sessionState.js):
```typescript
interface SessionState {
  // Lifecycle hooks called from bot.js / orchestrator
  onPlayerJoined(player: { uuid: string, username: string }): Promise<void>
  onPlayerLeft(player: { uuid: string, username: string }): Promise<void>
  onSpawn(): Promise<void>                                         // D-57 settle-delay-protected check
  onLoopTerminal(loop: { messagesByteSize: number }): Promise<void>  // hook for Plan 3-03

  // Read-only state for orchestrator gating
  ownerPresent(): boolean
  currentSessionLoopBatch(): { loopCount: number, cumulativeBytes: number, sessionsSinceConsolidation: number }
  ownerData(): OwnerData                                           // current cached owner snapshot

  _internal: { /* counters + cached ownerData for tests */ }
}

function createSessionState(opts: {
  ownerMdPath: string,
  diary: Diary,
  config: Config,
  bot: MineflayerBot,
  logger?: any,
}): Promise<SessionState>   // async because it loads OWNER.md on construction
```

Mineflayer event/object shape (verified at node_modules/mineflayer/lib/plugins/entities.js:649-661, 733, 752):
```javascript
bot.on('playerJoined', (player: { uuid, username, ping, gamemode, entity }) => {})
bot.on('playerLeft',   (player: { uuid, username, ping, gamemode, entity }) => {})
bot.players[username] = player          // keyed by username
bot.uuidToUsername[uuid] = username     // reverse map
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement atomicWrite, OWNER.md store, DIARY.md store with lazy-create + seed slice; extend config</name>
  <files>src/storage/atomicWrite.js, src/memory/owner.js, src/memory/diary.js, src/config.js, scripts/verify-phase3-memory.js</files>
  <read_first>
    - src/config.js (lines 14-37 — Zod nested-block pattern; line 41 for readFileSync style)
    - src/llm/inflight.js, src/llm/goals.js (factory + closure pattern from PATTERNS.md)
    - 03-RESEARCH.md "Pattern 3: Atomic write" (lines 259-274), "Code Examples — Atomic write idiom" (lines 419-431), "Pitfalls" 270-274
    - 03-RESEARCH.md "Pattern 4: Owner UUID resolution" (lines 276-285)
    - 03-RESEARCH.md "Pitfall 7: Consolidation collides with active write"
    - 03-RESEARCH.md "Open Question 4" (file-creation timing)
    - 03-CONTEXT.md D-46 (OWNER.md schema), D-47 (frontmatter fields), D-49 (DIARY entry format), D-50 (truncation), D-59 (config block)
    - 03-PATTERNS.md "src/storage/atomicWrite.js", "src/memory/owner.js", "src/memory/diary.js", "src/config.js" sections
  </read_first>
  <behavior>
    - Test (`atomic-write`): `atomicWrite('./fixture/foo.md', 'hello')` creates `./fixture/foo.md`. The tmp filename matches `^\.foo\.md\.tmp\.\d+\.\d+$` and lives in `./fixture/` (NOT `os.tmpdir()`). After completion, the tmp file no longer exists. Concurrent atomicWrite calls to different paths complete without interference.
    - Test (`fresh-install`): `loadOwner('./does-not-exist.md')` returns `{ exists: false, owner_uuid: null, total_sessions: 0, notes: '', ... }` — does NOT throw, does NOT create the file (Q4 lazy-create rule).
    - Test (`owner-roundtrip`): `saveOwner(path, { owner_uuid: 'u1', owner_username: 'shawn', first_seen: '2026-04-30T...', last_seen: '...', total_sessions: 1, preferred_name: null, pronouns: null, notes: '' })` then `loadOwner(path)` returns equal data.
    - Test (`owner-tolerates-malformed`): hand-craft an `OWNER.md` with extra unknown frontmatter keys and malformed lines; `loadOwner` returns the recognized fields, ignores unknown keys, does NOT throw (SPEC line 82 + V5 input validation).
    - Test (`owner-seed-block`): `formatOwnerSeedBlock(owner, 1024)` returns markdown beginning with `# Owner` and is ≤ 1024 bytes; truncates `notes` if needed (preserve frontmatter, truncate prose at the byte boundary).
    - Test (`diary-lazy-create`): `createDiary({ path: './does-not-exist.md', seedDiaryBudgetBytes: 3072 })` followed by `seedSlice()` returns `# Diary (recent first)\n(no prior history yet)\n` and the file is NOT created on disk. Then `appendEntry({ topic: 'first', body: '...' })` creates the file atomically.
    - Test (`diary-newest-first`): append three entries with distinct timestamps (oldest → middle → newest); `readAll()` returns them in newest-first order; `seedSlice()` includes them all (they fit in 3072 bytes).
    - Test (`diary-byte-budget`): create a diary with 20 entries each ~500 bytes; `seedSlice()` (budget 3072 bytes) includes only the most recent N entries that fit, drops the rest. The output is ≤ 3072 bytes.
    - Test (`diary-heading-format`): `appendEntry({ topic: 'fought a creeper', body: '...', when: new Date('2026-04-30T14:25:00Z') })` produces a heading exactly matching `## 2026-04-30 14:25 — fought a creeper` (D-49). Topic is truncated to ≤ 6 words.
    - Test (`diary-replace-older-half`): with 4 entries, `replaceOlderHalf('## Earlier (consolidated through 2026-04-15)\nDense paragraph.\n')` keeps the 2 most recent entries unchanged and replaces the rest with the consolidated block at the bottom.
  </behavior>
  <action>
    **`src/storage/atomicWrite.js`** — implement verbatim from RESEARCH.md lines 419-431:
    ```javascript
    import { writeFile, rename } from 'node:fs/promises'
    import { dirname, basename, join } from 'node:path'

    export async function atomicWrite(path, contents) {
      const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}.${Date.now()}`)
      await writeFile(tmp, contents, 'utf8')
      await rename(tmp, path)
    }
    ```
    Add the JSDoc header from PATTERNS.md (lines 99-110): warn that tmp must be same-dir, no fsync needed for v1.

    **`src/memory/owner.js`** — implement `loadOwner`, `saveOwner`, `formatOwnerSeedBlock`:
    - `loadOwner(path)` — `fs.readFile(path, 'utf8')` inside try/catch; on `ENOENT`, return `{ exists: false, owner_uuid: null, owner_username: null, first_seen: null, last_seen: null, total_sessions: 0, preferred_name: null, pronouns: null, notes: '' }`. Other errors throw. On success: parse YAML-like frontmatter using flat regex `^([a-z_]+):\s*(.*)$` (PATTERNS.md line 149, no `js-yaml` dep). Frontmatter is delimited by leading `---\n` and trailing `---\n`. Tolerate missing delimiters (treat whole file as notes). Tolerate unknown keys (ignore). Convert `total_sessions` to integer with `Number()` fallback to 0. Body after the closing `---` becomes `notes` (strip leading `# Notes\n` if present).
    - `saveOwner(path, data)` — serialize: leading `---\n`, then known fields in fixed order (`owner_uuid`, `owner_username`, `first_seen`, `last_seen`, `total_sessions`, `preferred_name`, `pronouns`), each `key: value` (empty string for nulls except `total_sessions: 0`); closing `---\n`, then `# Notes\n${data.notes}\n`. Pass to `atomicWrite(path, ...)`.
    - `formatOwnerSeedBlock(owner, budgetBytes)` — returns: if `!owner.exists`, `"# Owner\n(no owner recorded yet)\n"`. Else: `# Owner\n` + frontmatter table (key: value) + `\n## Notes\n${notes}\n`. If total bytes > budget, truncate the `notes` portion at the byte boundary, append `\n…(truncated)\n`. Frontmatter is always preserved (it's the recognition data).

    **`src/memory/diary.js`** — implement `createDiary({ path, seedDiaryBudgetBytes, logger = console })`:
    - Internal `let cached: DiaryEntry[] | null = null`. Lazy-load on first read; invalidate on every write.
    - `readAll()` — `fs.readFile(path)` inside try/catch on `ENOENT` → return `[]`. Parse: split on lines starting with `## `; first line of each entry is the heading (`## YYYY-MM-DD HH:MM — topic` or `## Earlier (consolidated through YYYY-MM-DD)`); body is everything until the next `## ` heading. Tag entries with `isConsolidated: heading.startsWith('## Earlier (')`. Sort/keep file order (newest-first by file convention).
    - `appendEntry({ topic, body, when = new Date() })` — derive heading: format `when` as `YYYY-MM-DD HH:MM` UTC; truncate `topic` to first 6 words; assemble `## ${ts} — ${topic}\n${body}\n\n`. PREPEND to existing file contents (newest-first). Lazy-create: if `ENOENT`, treat existing as `''`. Write via `atomicWrite`.
    - `seedSlice()` — `entries = await readAll()`. If empty: return `# Diary (recent first)\n(no prior history yet)\n`. Else: walk entries newest-first, accumulate serialized form (`heading + body + blank line`), stop when adding next would exceed `seedDiaryBudgetBytes`. Prefix output with `# Diary (recent first)\n`. If there are entries truncated, append `…(older entries truncated)\n`.
    - `replaceOlderHalf(replacement)` — read entries; split at 50% by entry count (Q5 — locked: 50% by entry count, with min 5 entries kept untouched at the top). If total entries ≤ 5, no-op (warn). Else: keep top `max(Math.ceil(N/2), 5)` entries; replace the rest with `replacement` (assumed to be a single `## Earlier (consolidated through ...)` block). Write atomically.
    - `getFileSizeBytes()` — `fs.stat(path).size`; on `ENOENT` return 0.
    - Concurrency: module-level `let writeLock = false` mutex. `appendEntry` and `replaceOlderHalf` both acquire it (if locked, wait via `await new Promise(setImmediate)` poll up to 2s, then drop with warn — Pitfall 7). Loss of one diary entry is acceptable.

    **`src/config.js`** — extend the existing `memory:` block (Plan 3-01 added only `iteration_cap`) to the FULL D-59 schema:
    ```javascript
    memory: z.object({
      owner_md_path: z.string().default('./OWNER.md'),
      diary_md_path: z.string().default('./DIARY.md'),
      iteration_cap: z.number().int().min(1).default(20),
      loop_batch_loop_count_cap: z.number().int().min(1).default(10),
      loop_batch_context_cap_bytes: z.number().int().min(1024).default(32768),
      sessions_per_consolidation: z.number().int().min(1).default(4),
      diary_size_cap_bytes: z.number().int().min(1024).default(204800),
      seed_diary_budget_bytes: z.number().int().min(256).default(3072),
      seed_owner_budget_bytes: z.number().int().min(256).default(1024),
    }).default({}),
    ```

    **`scripts/verify-phase3-memory.js`** — argv `--case=<name>` selector. Implement all behavior cases above. Use a temp directory under `os.tmpdir()/sei-test-<pid>/` for fixtures (created/cleaned per test). Exit non-zero with diff on failure.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=atomic-write &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=fresh-install &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=owner-roundtrip &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=diary-lazy-create &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=diary-newest-first &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=diary-byte-budget &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=diary-heading-format &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=diary-replace-older-half</automated>
  </verify>
  <acceptance_criteria>
    - All eight harness cases above pass.
    - `grep -c "os.tmpdir" src/storage/atomicWrite.js | grep -v '^#'` returns `0` (tmp must NOT use os.tmpdir).
    - `loadOwner` on a non-existent path does not create the file (verified by file-system inspection in `fresh-install` case).
    - `createDiary({path}).seedSlice()` on a non-existent path does not create the file.
    - `config.memory.owner_md_path` defaults to `./OWNER.md`; full D-59 schema present.
  </acceptance_criteria>
  <done>Storage primitives + memory stores ship. Files are created lazily on first write, never on read.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Implement sessionState with owner UUID resolution + lifecycle handlers; wire bot.js listeners</name>
  <files>src/llm/sessionState.js, src/bot.js, scripts/verify-phase3-memory.js</files>
  <read_first>
    - src/bot.js (lines 68-119 — existing event handler block; spawn handler + reconnect)
    - src/llm/inflight.js, src/llm/chains.js (factory pattern)
    - 03-RESEARCH.md "Pattern 4: Owner UUID resolution" (lines 276-285), "Pitfall 2: bot.players settle delay" (lines 332-337)
    - 03-CONTEXT.md D-48, D-56, D-57, D-58
    - 03-PATTERNS.md "src/llm/sessionState.js", "src/bot.js" sections
  </read_first>
  <behavior>
    - Test (`owner-uuid-cold`): With OWNER.md absent, simulate `bot.players = { shawn: { uuid: 'u-shawn', username: 'shawn' } }` and config `owner_username: 'shawn'`. Call `onPlayerJoined({ uuid: 'u-shawn', username: 'shawn' })`. After the call, OWNER.md exists with `owner_uuid: u-shawn`, `owner_username: shawn`, `total_sessions: 1`, `first_seen` and `last_seen` set to ISO timestamps within the last 5 seconds.
    - Test (`owner-uuid-warm`): With OWNER.md pre-populated (`owner_uuid: u-shawn`, `total_sessions: 3`), call `onPlayerJoined({ uuid: 'u-shawn', username: 'newname' })`. After: `total_sessions === 4`, `owner_username === 'newname'`, `last_seen` updated, `first_seen` unchanged.
    - Test (`username-change-recognition`): With OWNER.md `owner_uuid: u-shawn, owner_username: shawn`, call `onPlayerJoined({ uuid: 'u-shawn', username: 'shawn-renamed' })`. Recognition succeeds (UUID match); username field gets updated. Then call `onPlayerJoined({ uuid: 'u-someone-else', username: 'shawn' })` — recognition FAILS (UUID mismatch), no counter changes.
    - Test (`owner-uuid-fallback`): OWNER.md exists but `owner_uuid` is empty/null (hand-edited file). Then `onPlayerJoined({ username: 'shawn', uuid: 'u-shawn' })` falls back to `config.owner_username` matching, captures the UUID, writes it to disk (D-48 fallback path).
    - Test (`spawn-settle-delay`): On `onSpawn()`, the owner check is delayed by `config.memory.spawn_settle_delay_ms ?? 500`. If `bot.players[owner_username]` is populated within the delay, session-start fires. If empty, no session-start fires (and a one-shot `playerJoined` listener handles the late-arrival case).
    - Test (`session-end-flush`): Mid-session has `loopCount: 5, cumulativeLoopBytes: 12000`. Call `onPlayerLeft({ uuid: 'u-shawn' })`. Counters reset; `last_seen` is updated; the on-loop-terminal hook is informed of session-end (Plan 3-03 will use this for the final flush — for Plan 3-02, just emit a structured log).
    - Test (`bot-disconnect-not-session-end`): Simulate `bot.on('end')` while owner is still on-server (no `playerLeft` for owner) — `onPlayerLeft` is NOT called. `total_sessions` does NOT increment on the next `spawn` if D-58 says crash-recovery counts as a new session (v1 trade-off — accepted; document in code comment).
    - Test (`per-loop-batch-counter`): Call `onLoopTerminal({ messagesByteSize: 5000 })` ten times → `currentSessionLoopBatch().loopCount === 10` and `cumulativeBytes === 50000`. The hook does NOT write to disk (Plan 3-03 owns that — Plan 3-02 just maintains counters).
  </behavior>
  <action>
    **`src/llm/sessionState.js`** — implement `createSessionState({ ownerMdPath, diary, config, bot, logger = console })` as a named factory. State (closure-private):
    - `let ownerData: OwnerData = await loadOwner(ownerMdPath)`
    - `let activeOwnerUuid: string | null = null` (null when owner not present)
    - `let loopCount = 0`
    - `let cumulativeLoopBytes = 0`
    - `let sessionsSinceConsolidation = 0`
    - `let onSpawnLatePlayerListener: ((p: any) => void) | null = null`

    Methods:
    - `onPlayerJoined(player)` — recognition logic:
      1. If `ownerData.exists && ownerData.owner_uuid && player.uuid === ownerData.owner_uuid` → recognized.
      2. Else if `ownerData.exists && !ownerData.owner_uuid && player.username === config.owner_username` → fallback, capture UUID (D-48).
      3. Else if `!ownerData.exists && player.username === config.owner_username` → cold path, capture UUID + create OWNER.md.
      4. Else → not the owner; return.
      Recognized → fire session-start: increment `total_sessions`; set `first_seen` if null; set `last_seen` to now; update `owner_username` to current; reset `loopCount` and `cumulativeLoopBytes`; increment `sessionsSinceConsolidation`. Save OWNER.md atomically. Set `activeOwnerUuid = player.uuid`. Emit structured log `[sei/session] start uuid=... session_count=...`.
    - `onPlayerLeft(player)` — if `player.uuid !== activeOwnerUuid` return. Update `last_seen` and save OWNER.md. Emit `[sei/session] end uuid=...`. Set `activeOwnerUuid = null`. Reset `loopCount` and `cumulativeLoopBytes` (Plan 3-03 will hook here for final flush).
    - `onSpawn()` — schedule `setTimeout(checkOwnerPresent, config.memory.spawn_settle_delay_ms ?? 500)`. `checkOwnerPresent`: if owner found in `bot.players` (by UUID first if known, else by username), invoke `onPlayerJoined` synthetically. Else: attach a one-shot `bot.once('playerJoined', latePlayerHandler)` (Pitfall 2 belt-and-suspenders); the handler self-checks owner presence and unbinds.
    - `onLoopTerminal({ messagesByteSize })` — increment `loopCount`; add to `cumulativeLoopBytes`. Emit structured log `[sei/session] loop terminal loop_count=N cumulative_bytes=M`. **No disk writes here** — this is the hook Plan 3-03 will subscribe to.
    - `ownerPresent()` → `activeOwnerUuid !== null`.
    - `currentSessionLoopBatch()` → `{ loopCount, cumulativeBytes: cumulativeLoopBytes, sessionsSinceConsolidation }`.
    - `ownerData()` → snapshot copy of `ownerData`.
    - `_internal: { /* counters + ownerData ref for tests */ }`.

    Add a small helper, exported from `sessionState.js` (or factored if the planner prefers): `resetLoopBatchCounters()` — only callable by Plan 3-03's compaction module after a successful diary write. Plan 3-02 reserves the seam.

    **`src/bot.js`** — extend the existing `if (!_spawned)` block at lines 68-90 (PATTERNS.md MODIFIED src/bot.js):
    1. After the orchestrator is created (before/after — pick clean ordering), construct: `const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }; const diary = createDiary({ path: config.memory.diary_md_path, seedDiaryBudgetBytes: config.memory.seed_diary_budget_bytes, logger }); const sessionState = await createSessionState({ ownerMdPath: config.memory.owner_md_path, diary, config, bot, logger })`.
    2. Pass `sessionState`, `ownerStore`, `diary` to the orchestrator factory (orchestrator changes in Task 3).
    3. Add listeners: `bot.on('playerJoined', (p) => sessionState.onPlayerJoined(p)); bot.on('playerLeft', (p) => sessionState.onPlayerLeft(p));`.
    4. Add `setTimeout(() => sessionState.onSpawn(), 0)` (the function itself owns the 500ms settle delay; outer setTimeout=0 just defers to next tick so spawn handlers all complete first).
    5. **Do NOT** add session-end calls into `bot.on('end')` — D-58 explicitly: bot disconnect ≠ session end.

    **`scripts/verify-phase3-memory.js`** — add cases: `owner-uuid-cold`, `owner-uuid-warm`, `username-change-recognition`, `owner-uuid-fallback`, `spawn-settle-delay`, `session-end-flush`, `per-loop-batch-counter`. Use a stub `bot` object with `players`, `uuidToUsername`, `on`, `once` methods (no real mineflayer needed for these tests).
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=owner-uuid-cold &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=owner-uuid-warm &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=username-change-recognition &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=owner-uuid-fallback &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=spawn-settle-delay &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=per-loop-batch-counter</automated>
  </verify>
  <acceptance_criteria>
    - All seven behavior cases pass.
    - `grep -n "playerJoined\|playerLeft" src/bot.js | grep -v '^#'` returns ≥ 2 matches.
    - `git diff src/bot.js` shows no changes inside `bot.on('end')` (D-58).
    - sessionState exports `createSessionState`; no default export.
    - Manual smoke test: boot the bot fresh (no OWNER.md), connect with the configured owner username — OWNER.md is created with a real UUID after first chat or spawn-settle.
  </acceptance_criteria>
  <done>Session lifecycle is wired. OWNER.md captures UUID on first encounter. Counters maintained for Plan 3-03 to consume.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Wire seed-message loader into orchestrator's Loop construction (seed_owner + seed_diary blocks)</name>
  <files>src/llm/orchestrator.js, scripts/verify-phase3-memory.js</files>
  <read_first>
    - src/llm/orchestrator.js (the new Loop construction site from Plan 3-01)
    - src/llm/loop.js (Plan 3-01 — appendUserTurn signature, seed flag)
    - 03-CONTEXT.md D-45 (seed turn permanence), D-50 (truncation strategy)
    - 03-RESEARCH.md "Pitfall 4: Cache invalidation" (OWNER/DIARY in user turn, NOT system blocks)
  </read_first>
  <behavior>
    - Test (`seed-content-shape`): A new Loop's first user turn (with `seed: true`) contains exactly these blocks in order: `{type:'text', name:'seed_owner', text: <OWNER.md formatted>}`, `{type:'text', name:'seed_diary', text: <DIARY.md slice formatted>}`, `{type:'text', name:'event', text: <event>}`, `{type:'text', name:'snapshot', text: <snapshot>}`.
    - Test (`seed-content-fresh-install`): When no OWNER.md / DIARY.md exist, the seed_owner block contains `# Owner\n(no owner recorded yet)\n` and seed_diary contains `# Diary (recent first)\n(no prior history yet)\n` (SPEC A6).
    - Test (`seed-budget-respected`): With a 5 KB OWNER.md notes section and a 10 KB DIARY.md, the seed_owner block is ≤ 1024 bytes and seed_diary is ≤ 3072 bytes (defaults).
    - Test (`seed-permanent-across-iterations`): After 5 iterations on a Loop, `loop.buildAnthropicPayload()` still includes seed_owner and seed_diary blocks on the first user turn (D-45).
    - Test (`seed-not-in-system-blocks`): The system blocks passed to `anthropic.call` for any iteration of a Loop do NOT contain owner_uuid, OWNER.md content, or DIARY.md content (Pitfall 4 — cache invariant).
  </behavior>
  <action>
    Modify `src/llm/orchestrator.js` (the Loop construction path from Plan 3-01) to inject seed content on the first user turn.

    1. The orchestrator factory now receives `sessionState`, `ownerStore`, `diary` (wired in Task 2). Add to the factory args.

    2. In the dispatch handler, where Plan 3-01 created `currentLoop = createLoop(...)`, immediately compose the seed blocks BEFORE the first `appendUserTurn`:
       ```javascript
       const owner = sessionState.ownerData()
       const seedOwnerText = ownerStore.formatOwnerSeedBlock(owner, config.memory.seed_owner_budget_bytes)
       const seedDiaryText = await diary.seedSlice()
       const seedBlocks = [
         { type: 'text', name: 'seed_owner', text: seedOwnerText },
         { type: 'text', name: 'seed_diary', text: seedDiaryText },
       ]
       const eventBlock    = { type: 'text', name: 'event',    text: `Event: ${event}\nData: ${JSON.stringify(data)}` }
       const snapshotBlock = { type: 'text', name: 'snapshot', text: composeSnapshot(...) }
       loop.appendUserTurn([...seedBlocks, eventBlock, snapshotBlock], { seed: true })
       ```
       Subsequent `appendUserTurn` calls within the same Loop do NOT include seed blocks (Loop owns seed permanence per D-45).

    3. **Cache invariant (Pitfall 4):** verify (and add a runtime assertion at orchestrator construction) that `cachedSystemBlocks` does NOT contain any string starting with `# Owner` or `# Diary`. This is a structural defense against accidental regressions.

    4. **Loop terminal hook → sessionState:** at the loop-terminal site reserved by Plan 3-01, call:
       ```javascript
       const messagesByteSize = JSON.stringify(loop._internal.messages).length
       await sessionState.onLoopTerminal({ messagesByteSize })
       // PHASE 3-03: compaction call lands here, after sessionState.onLoopTerminal
       currentLoop = null
       ```

    5. **Add cases to `scripts/verify-phase3-memory.js`** — `seed-content-shape`, `seed-content-fresh-install`, `seed-budget-respected`, `seed-permanent-across-iterations`, `seed-not-in-system-blocks`. These can drive the orchestrator factory directly with a stubbed `anthropic.call` (carry over from Plan 3-01 harness) and stubbed `bot`.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=seed-content-shape &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=seed-content-fresh-install &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=seed-budget-respected &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=seed-permanent-across-iterations &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=seed-not-in-system-blocks</automated>
  </verify>
  <acceptance_criteria>
    - All five seed-related cases pass.
    - `grep -n "seed_owner\|seed_diary" src/llm/orchestrator.js | grep -v '^#'` returns ≥ 2 matches.
    - `grep -nE "(# Owner|# Diary)" src/llm/persona.js` returns no matches (OWNER/DIARY content stays out of the cached system prefix).
    - Manual smoke test: boot the bot, owner chats. In the orchestrator log, the first user turn's content array has exactly 4 blocks (seed_owner, seed_diary, event, snapshot). After 3 follow-up tool_use cycles, the seed turn still carries seed_owner and seed_diary.
  </acceptance_criteria>
  <done>OWNER.md and DIARY.md content reaches the personality LLM via the seed user turn on every Loop. The cache stays warm. The Loop-terminal hook is wired to sessionState, with the compaction-call seam reserved for Plan 3-03.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User-editable markdown ↔ loadOwner parser | Hand-edited OWNER.md may contain malformed YAML; parser must tolerate (V5 input validation) |
| Atomic write (tmp → rename) | Crash mid-write must not corrupt target file (Pattern 3) |
| Per-loop-batch counter ↔ consolidation rewrite | Two concurrent writers (Pitfall 7) — mutex required |
| OWNER/DIARY content ↔ Anthropic cached prefix | OWNER/DIARY MUST NOT enter system blocks (Pitfall 4) |
| Config path resolution ↔ filesystem | `owner_md_path` could be malicious `../../etc/passwd`; Phase 3 trusts config.json (single-user local bot) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-07 | Tampering | Crash-mid-write file corruption | mitigate | atomicWrite (writeFile tmp + rename) — kernel-atomic same-fs replacement |
| T-03-08 | Tampering | Concurrent diary writer race | mitigate | Module-level mutex in diary.js (Pitfall 7) |
| T-03-09 | Information disclosure | OWNER/DIARY in cache prefix invalidates cache + leaks PII into cache key | mitigate | Structural: seed blocks live in user turn only; runtime assertion in orchestrator construction guards |
| T-03-10 | Tampering | Owner UUID spoofing (different player same username) | mitigate | UUID is source of truth post-capture; username-based recognition only on cold/fallback paths |
| T-03-11 | Input validation | Malformed YAML frontmatter | mitigate | loadOwner regex-parses, ignores unknown keys, tolerates malformed lines (SPEC line 82) |
| T-03-12 | Tampering | Path traversal via config.memory.owner_md_path | accept | Single-user local bot; user controls config.json. Phase 4 GUI may add path validation. |
</threat_model>

<verification>
- All harness cases in `scripts/verify-phase3-memory.js` pass.
- Manual smoke test: fresh install (no OWNER.md, no DIARY.md), boot bot, connect with owner — OWNER.md is created within ~500ms after spawn (or first chat). Log emits `[sei/session] start uuid=... session_count=1`. Seed user turn on first Loop contains placeholder text for diary.
- Manual smoke test: rename owner in-game (server-side), restart bot, chat — recognition still works (UUID match), `owner_username` updates in OWNER.md.
- `grep -n "writeFile\|rename" src/storage/atomicWrite.js` confirms atomic-write pattern.
- `grep -nE "(# Owner|# Diary)" src/llm/persona.js src/llm/anthropicClient.js` returns no matches (cache invariant).
</verification>

<success_criteria>
- `src/storage/atomicWrite.js`, `src/memory/owner.js`, `src/memory/diary.js`, `src/llm/sessionState.js` exist and exports match locked interfaces.
- `OWNER.md` is created on first owner-encounter with a real UUID; survives username changes.
- `DIARY.md` lazy-creates on first append; `seedSlice()` returns a budgeted markdown block.
- Every Loop's seed user turn includes seed_owner + seed_diary blocks; subsequent iterations omit them but `buildAnthropicPayload()` keeps them on the seed turn (D-45).
- `src/fsm.js` byte-unchanged.
- Loop-terminal hook calls `sessionState.onLoopTerminal({ messagesByteSize })`; compaction seam reserved.
</success_criteria>

<output>
After completion, create `.planning/phases/03-memory-persistence/03-02-SUMMARY.md` documenting:
- Public APIs as shipped (atomicWrite, ownerStore, diary, sessionState)
- D-48 cold/warm/fallback paths exercised in tests
- Observed file sizes for OWNER.md / DIARY.md after a manual smoke session
- Hook reserved for Plan 3-03 in orchestrator (location and call signature)
- Q4 resolution: lazy-create on first write confirmed
</output>
