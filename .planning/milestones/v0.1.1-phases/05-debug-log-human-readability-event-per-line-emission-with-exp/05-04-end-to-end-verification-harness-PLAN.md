---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 04
type: execute
wave: 3
depends_on:
  - 05-01-logger-multiline-emit-and-hash-dictionary-PLAN.md
  - 05-02-orchestrator-wire-named-user-blocks-PLAN.md
  - 05-03-logrouter-multiline-state-machine-PLAN.md
files_modified:
  - scripts/verify-phase5.mjs
autonomous: false
requirements: []
must_haves:
  truths:
    - "A standalone Node script `scripts/verify-phase5.mjs` exercises log.js + logRouter.ts end-to-end without a live Minecraft server or Anthropic API."
    - "The script asserts: (a) every event renders as begin/end with one shared timestamp and 2-space continuation indent; (b) the first [haiku?] of a session prints persona/capability/diary bodies in FULL; (c) the second [haiku?] prints `<persona @sha=...>`, `<capability @sha=...>`, `<diary @sha=...>` short refs and inlines snapshot/event/recent_* in full; (d) when only the diary body changes between calls, persona and capability stay elided but diary prints in full (new hash); (e) logRouter coalesces a synthetic multi-line block into ONE LogEntry; (f) an unmatched-begin produces a `  [truncated]` recovery entry."
    - "The script returns exit code 0 on success and prints a one-line FAIL diagnostic plus exit 1 on any assertion failure."
    - "A user-driven live-bot checkpoint follows the automated script — the developer launches the bot, summons it from the GUI, lets it run for >=2 personality calls, and visually inspects the rolling log file to confirm the elision behavior in vivo."
  artifacts:
    - path: "scripts/verify-phase5.mjs"
      provides: "End-to-end synthetic harness covering log.js elision + logRouter multi-line coalescing + truncation recovery."
      contains: "createLogRouter"
  key_links:
    - from: "scripts/verify-phase5.mjs"
      to: "src/bot/brain/log.js (via import)"
      via: "ESM dynamic import + console.log capture"
      pattern: "import.*log\\.js"
    - from: "scripts/verify-phase5.mjs"
      to: "src/main/logRouter.ts (via tsx loader OR by replaying log.js stdout into a hand-rolled append driver)"
      via: "tsx loader or a fixture-replay approach"
      pattern: "logRouter|append\\("
---

<objective>
Build a single end-to-end automated harness (`scripts/verify-phase5.mjs`) that proves Phase 5's correctness without booting a live Minecraft server or hitting the Anthropic API. Follow with one manual checkpoint where the developer launches the actual bot and visually confirms the new log shape on disk.

Purpose: Verification scripts are this project's established pattern (`scripts/verify-phase2.js`, `scripts/verify-phase3.js`). A reproducible synthetic test is the gating signal for "Phase 5 ships"; the manual checkpoint is the seal of live behavior since the executor has no Minecraft instance.
Output: A passing `node scripts/verify-phase5.mjs` plus a developer-confirmed live log inspection.
</objective>

<execution_context>
@/Users/ouen/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ouen/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-01-logger-multiline-emit-and-hash-dictionary-PLAN.md
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-03-logrouter-multiline-state-machine-PLAN.md
@/Users/ouen/slop/sei/src/bot/brain/log.js
@/Users/ouen/slop/sei/src/main/logRouter.ts

<interfaces>
The harness lives at `scripts/verify-phase5.mjs` and is invoked as `node scripts/verify-phase5.mjs`.

For exercising `logRouter.ts` from a pure-Node script (no Electron, no tsx required), the recommended approach is to NOT import the TypeScript module directly. Instead the harness re-implements the SENTINEL_RE state machine in a small inline `simulateRouter(lines)` helper that mirrors the Plan 05-03 logic. This avoids a TypeScript build step in the verify path AND it keeps the harness honest: if the real logRouter diverges from the agreed contract, the synthetic harness still represents the contract.

A separate assertion confirms that the real `src/main/logRouter.ts` source text contains the same SENTINEL_RE pattern and `finalizeOpenEvent('truncated')` literal — a structural fingerprint of the contract.

For exercising `log.js` the harness uses ESM dynamic import (`await import('../src/bot/brain/log.js')`) and captures `console.log` calls via monkey-patch.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write scripts/verify-phase5.mjs covering log.js elision + logRouter contract + truncation recovery</name>
  <files>scripts/verify-phase5.mjs</files>
  <read_first>
    - /Users/ouen/slop/sei/scripts/verify-phase3.js (the existing project pattern — assertion style, exit codes, output format)
    - /Users/ouen/slop/sei/src/bot/brain/log.js (the post-Plan-05-01 implementation, to confirm import shape)
    - /Users/ouen/slop/sei/src/main/logRouter.ts (the post-Plan-05-03 implementation, to mirror SENTINEL_RE and the state machine)
  </read_first>
  <action>
Create `scripts/verify-phase5.mjs`. The script:

1. Opens with a shebang `#!/usr/bin/env node` and a 6-line header comment describing scope.
2. Defines a `fail(label, details)` helper that prints `FAIL: <label>\n<details>` to stderr and `process.exit(1)`.
3. Defines a `pass(label)` helper that pushes `OK: <label>` into a results array, printed at end.
4. Runs the following assertions, in order. Use plain `console.assert`-style checks; on any failure invoke `fail(...)` immediately.

**Block A — log.js multi-line sentinel shape**

- Dynamic-import `../src/bot/brain/log.js`.
- Monkey-patch `console.log` to push into an array `captured`.
- Call `logChatOut('hello there')`, `logHeal({pos:'1,2,3',vel:'0,0,0',yaw:0,pitch:0})`, `logActionResult('dig',{ok:true,block:'oak_log'})`.
- Restore `console.log`.
- Assert `captured.length` MUST equal 4. `captured[0]` is the single-line dictionary-init header (contains literal `cache-prefix dictionary initialized`); `captured[1..3]` are the three event blocks (one per emitter call). Per Plan 05-01 Task 2 step 3, `maybeWriteDictHeader()` is called at the top of every emitter and is flag-guarded by `_headerWritten`, so it fires exactly once on the first emission of the process lifetime — deterministic.
- For each non-header block:
  - Count `begin` and `end` sentinels via regex `/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\] (begin|end)$/m` — must be exactly 1 begin and 1 end.
  - Extract both timestamps; assert they are equal.
  - Assert at least one line between them starts with two spaces (continuation indent).

**Block B — log.js cache-prefix elision (D-4..D-8)**

- Build fixture inputs:

```js
const systemBlocks = [
  { type: 'text', text: 'SYS-INSTRUCTIONS' },
  { type: 'text', text: 'PERSONA-BODY-XYZ' },
  { type: 'text', text: 'CAPABILITY-BODY-ABC' },
  { type: 'text', text: 'PRIMER' },
  { type: 'text', text: 'TOOLS' },
];
const namedUserBlocksFirst = [
  { role: 'user', content: [
    { type:'text', name:'seed_owner', text:'OWNER-INFO-1' },
    { type:'text', name:'seed_diary', text:'DIARY-BODY-V1' },
    { type:'text', name:'event',      text:'event1' },
    { type:'text', name:'snapshot',   text:'pos=1,64,1 hp=20' },
  ]},
];
const namedUserBlocksSecond = JSON.parse(JSON.stringify(namedUserBlocksFirst));  // unchanged blocks
const namedUserBlocksAfterCompaction = JSON.parse(JSON.stringify(namedUserBlocksFirst));
namedUserBlocksAfterCompaction[0].content.find(b => b.name === 'seed_diary').text = 'DIARY-BODY-V2-AFTER-COMPACTION';
```

- Clear `captured` and call `logHaikuQuery({ messages:[{role:'user',content:'x'}], tools:[{name:'say'}], systemBlocks, namedUserBlocks: namedUserBlocksFirst })`.
- Assert the captured block contains the literal `PERSONA-BODY-XYZ` AND a hash ref `/<persona @sha=[0-9a-f]{8}>/`.
- Assert it contains `DIARY-BODY-V1` AND `<diary @sha=[0-9a-f]{8}>`.
- Assert it contains the inline section labels `event:` and `snapshot:` followed by the literal text (snapshot/event are NEVER elided — D-8).
- Capture the persona / capability / diary hashes via regex for later comparison.

- Call `logHaikuQuery({ ..., namedUserBlocks: namedUserBlocksSecond })`.
- Assert the new block does NOT contain `PERSONA-BODY-XYZ`, `CAPABILITY-BODY-ABC`, or `DIARY-BODY-V1` (all elided).
- Assert it DOES contain the three same hash refs from call 1.
- Assert it still inlines `event:` and `snapshot:` with their literal text.

- Call `logHaikuQuery({ ..., namedUserBlocks: namedUserBlocksAfterCompaction })`.
- Assert persona and capability hashes are still elided (same refs).
- Assert diary now prints in FULL (`DIARY-BODY-V2-AFTER-COMPACTION` literal appears) and the NEW diary hash ref appears.
- Assert the new diary hash differs from the original.

**Block C — Source-text fingerprint of logRouter contract**

- `readFile('src/main/logRouter.ts', 'utf8')`.
- Assert it contains `SENTINEL_RE`, the literal `finalizeOpenEvent('truncated')`, the literal `'  [truncated]'`, and the regex source fragment `\\s+(begin|end)\\s*$`.
- This is a cheap structural check; it does NOT execute TypeScript.

**Block D — In-script simulation of the multi-line state machine**

- Implement `simulateRouter(lines)` inline — a JS port of the Plan 05-03 logic that returns an array of finalized `{ tag, message, level }` entries. Mirror the SENTINEL_RE and the open-tag / finalize / truncated logic exactly.
- Feed it a synthetic stream:

```js
const lines = [
  '[12:00:00.000] [haiku?] begin',
  '  tools: say, dig',
  '  user: <persona @sha=ab12abcd>',
  '         <capability @sha=cd34cd34>',
  '         snapshot: pos=0,0,0',
  '[12:00:00.000] [haiku?] end',
  '[12:00:01.000] [chat->] begin',
  '  text: hello world',
  '[12:00:01.000] [chat->] end',
];
const entries = simulateRouter(lines);
```

- Assert `entries.length === 2`.
- Assert `entries[0].tag === '[haiku?]'` and `entries[0].message` contains all six original lines joined by `\n`.
- Assert `entries[1].tag === '[chat->]'` and `entries[1].message.split('\n').length === 3`.

**Block E — Truncation recovery**

- Feed `simulateRouter` a stream with a dropped end:

```js
const truncatedLines = [
  '[12:00:00.000] [haiku?] begin',
  '  tools: say',
  '[12:00:00.500] [chat->] begin',   // second begin arrives before first end
  '  text: hi',
  '[12:00:00.500] [chat->] end',
];
const entries2 = simulateRouter(truncatedLines);
```

- Assert `entries2.length === 2`.
- Assert `entries2[0].tag === '[haiku?]'` and `entries2[0].message` ends with `\n  [truncated]`.
- Assert `entries2[1].tag === '[chat->]'` and its message does NOT contain `[truncated]`.

**Tail**

- Print all `OK:` lines to stdout, then `Phase 5 verification: PASS` and `process.exit(0)`.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei &amp;&amp; node scripts/verify-phase5.mjs</automated>
  </verify>
  <acceptance_criteria>
    - `node scripts/verify-phase5.mjs` exits 0 and prints `Phase 5 verification: PASS` on its last line.
    - The script contains at least these literal substrings: `cache-prefix dictionary initialized`, `PERSONA-BODY-XYZ`, `DIARY-BODY-V2-AFTER-COMPACTION`, `SENTINEL_RE`, `simulateRouter`, `[truncated]`.
    - Running it twice in a row both succeed (the in-script monkey-patched console capture and module re-import are idempotent across invocations).
  </acceptance_criteria>
  <done>End-to-end synthetic harness passes; both the elision behavior and the logRouter state-machine contract are exercised without any live external dependency.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Developer-driven live-bot log inspection</name>
  <what-built>
    Plan 05-01 + 05-02 + 05-03 together changed the debug logger format end to end. The automated harness in Task 1 proves the synthetic contract; this checkpoint confirms behavior in an actual bot run on the developer's machine (which has access to a Minecraft server and Anthropic API credentials — the executor does not).
  </what-built>
  <action>Manual checkpoint — the developer performs the live-bot inspection described under &lt;how-to-verify&gt; below. No autonomous executor action is taken; this task pauses execution until the developer signs off.</action>
  <how-to-verify>
    1. From the project root: `npm run sei` (or launch the Electron app and summon a character via the GUI, whichever the developer prefers) and connect to a local Minecraft server.
    2. Let the bot run for at least 2 personality iterations (e.g., send it one chat message, wait for it to act, send another).
    3. Stop the bot.
    4. Open the most recent log file under the per-character logs directory (`~/Library/Application Support/Sei/logs/...` on macOS, or wherever `paths.logsDir()` resolves on the developer's OS).
    5. Confirm visually:
       a. The first non-header line for the session is the literal `cache-prefix dictionary initialized` header (single line, no begin/end).
       b. The FIRST `[haiku?] begin ... [haiku?] end` block contains a section `user:` whose body includes the full persona text, the full capability text, the full diary text (each immediately followed by a `<persona @sha=...>` / `<capability @sha=...>` / `<diary @sha=...>` ref line), plus inline `snapshot:` / `event:` sections.
       c. The SECOND `[haiku?]` block (next iteration) shows only the three short hash refs in the persona/capability/diary positions — none of the full bodies repeat — and still shows the per-call `snapshot:` / `event:` / any `recent_*` inline.
       d. No physical line in the file exceeds ~200 chars EXCEPT the lines that ARE the full persona / capability / diary body on first appearance (those are deliberately long).
       e. `[chat<-]`, `[chat->]`, `[act!]`, `[heal]` events all use the begin/end sentinel format with 2-space-indented sections.
    6. If anything looks off, describe what differs from the expected shape.
  </how-to-verify>
  <resume-signal>Type "approved" if the log file matches all five sub-checks; otherwise describe the deviation so it can be patched.</resume-signal>
</task>

</tasks>

<verification>
- `node scripts/verify-phase5.mjs` exits 0.
- The developer signs off on the live log inspection.
- **Block D scope clarification:** Block D verifies the multi-line state-machine CONTRACT as documented in Plan 05-03 — it does NOT execute the real `src/main/logRouter.ts`. The in-script `simulateRouter()` is a JS port of the contract, not a test of the production code. Detection of divergence between the documented contract and the actual TypeScript implementation is the explicit responsibility of Task 2's live-bot checkpoint (the developer inspects renderer log output for begin/end framing and `[truncated]` recovery). Block C's source-text fingerprint check is the only static guard against contract drift; treat it as necessary but not sufficient. verify-phase MUST NOT treat Block D as authoritative evidence that the TS router is correct.
</verification>

<success_criteria>
- Phase 5's user-visible payoff is real: a live debug log file shows event-per-line begin/end blocks, persona/capability/diary print once per session and elide thereafter, and the file is grep-friendly (e.g., `grep -A 20 '\[haiku?\] begin'` yields one coherent event body per match).
</success_criteria>

<output>
After completion, create `.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-04-SUMMARY.md` with the harness output transcript and the developer's verification note.
</output>
