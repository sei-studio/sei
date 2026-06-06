---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/bot/brain/log.js
  - src/bot/brain/anthropicClient.js
autonomous: true
requirements: []
must_haves:
  truths:
    - "Every logger emission (haiku?, haiku!, chat<-, chat->, act!, heal) writes a multi-line block with explicit [ts] [tag] begin and [ts] [tag] end sentinels using one identical timestamp."
    - "Continuation lines between begin and end are indented exactly 2 spaces."
    - "MAX_INLINE inline truncation is gone — long payloads print in full unless elided by hash reference."
    - "On the first event of a session, a single 'cache-prefix dictionary initialized' header line is written before any begin sentinel."
    - "[haiku?] events show three short hash references — <persona @sha=xxxxxxxx>, <capability @sha=xxxxxxxx>, <diary @sha=xxxxxxxx> — on the second and subsequent appearances of that block body in the same session; the first appearance prints the full body inline above the ref."
    - "Snapshot, recent_events, recent_owner_chat, your_recent_messages, owner-chat are never hashed — they print inline in full."
    - "The session hash dictionary is in-memory in log.js and does NOT persist across bot restarts."
  artifacts:
    - path: "src/bot/brain/log.js"
      provides: "Multi-line emit, per-event-kind section renderers, session-scoped hash dictionary, MAX_INLINE removal, cache-prefix dictionary header."
      contains: "function emitBlock"
    - path: "src/bot/brain/anthropicClient.js"
      provides: "Pass systemBlocks + canonical named user-content (via new namedUserBlocks arg) to logHaikuQuery so persona/capability/diary can be hashed against their raw bytes."
      contains: "logHaikuQuery({ systemBlocks"
  key_links:
    - from: "src/bot/brain/anthropicClient.js call()"
      to: "src/bot/brain/log.js logHaikuQuery"
      via: "structured arg shape — { systemBlocks, messages, tools, namedUserBlocks }"
      pattern: "logHaikuQuery\\(\\{[^}]*systemBlocks"
    - from: "src/bot/brain/log.js emit"
      to: "stdout (one console.log per multi-line block via a single \\n-joined string)"
      via: "single process.stdout.write or console.log carrying embedded newlines"
      pattern: "begin[\\s\\S]*?end"
---

<objective>
Refactor `src/bot/brain/log.js` from single-line tee to event-per-line multi-line emission with `[ts] [tag] begin` / `[ts] [tag] end` sentinels (D-1), drop `MAX_INLINE` truncation entirely (D-9), and add a session-scoped hash dictionary that elides three cached prompt blocks — **persona**, **capability**, **diary** — to short `<persona @sha=...>` refs on second and later appearances per session (D-4..D-8). Extend `src/bot/brain/anthropicClient.js` to surface the raw `systemBlocks` and the canonical pre-strip user content to the logger so hashing happens over the exact bytes Anthropic sees.

Purpose: Make debug logs grep-friendly and human-readable. Today a single `[haiku?]` line wraps 8–11 KB across the terminal because the full cached prefix (persona ~600t + capability ~400t + diary ~1000t) repeats on every iteration. With elision, the second and later `[haiku?]` events of a session collapse to ~3 short hash refs + the per-call dynamic sections (snapshot / recent_events / owner-chat).
Output: A logger that writes multi-line begin/end blocks, per-event-kind human-prose sections, and a working in-memory hash dictionary.
</objective>

<execution_context>
@/Users/ouen/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ouen/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ouen/slop/sei/.planning/PROJECT.md
@/Users/ouen/slop/sei/.planning/ROADMAP.md
@/Users/ouen/slop/sei/.planning/STATE.md
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md
@/Users/ouen/slop/sei/CLAUDE.md
@/Users/ouen/slop/sei/src/bot/brain/log.js
@/Users/ouen/slop/sei/src/bot/brain/anthropicClient.js
@/Users/ouen/slop/sei/src/bot/brain/orchestrator.js
@/Users/ouen/slop/sei/src/bot/brain/compaction.js

<interfaces>
<!-- These are the contracts the executor MUST honor. Do not invent new shapes. -->

From src/bot/brain/log.js (PUBLIC API — keep call signatures stable for existing consumers):
```js
export function logChatIn(username, message)
export function logChatOut(text)
export function logHaikuQuery({ messages, tools })           // EXTEND, see below
export function logHaikuResponse({ text, toolUses, usage, stopReason })
export function logHeal({ pos, vel, yaw, pitch })
export function logActionResult(name, result)
```

Extension required for `logHaikuQuery`: accept two NEW optional fields without breaking existing callers:
```js
export function logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })
// systemBlocks: the 5-block array from anthropicClient.buildCachedSystem (system_instructions, persona+learning, capability, primer, tools)
// namedUserBlocks: the canonical pre-strip user-content array(s) with `name` fields intact (loop's _internal.messages OR just the last user turn's named content)
```

From src/bot/brain/anthropicClient.js (call site that must be updated):
```js
async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024 }) {
  logHaikuQuery({ messages, tools })   // ← MUST become: logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks: <see below> })
  ...
}
```

`namedUserBlocks` integration choice (path b from CONTEXT.md `<code_context>` line 130): the orchestrator does NOT need to change YET — anthropicClient receives a NEW optional sibling field `namedUserBlocks` that callers may pass alongside `messages`. Plan 05-02 wires the orchestrator to pass it. For this plan, anthropicClient simply forwards whatever it receives (or omits the field if not present — the logger then prints diary inline without elision).

System block index → hash name mapping (D-4):
- `systemBlocks[1]` (persona+learning) → hash name `persona`
- `systemBlocks[2]` (capability)        → hash name `capability`
- For `diary`: scan `namedUserBlocks` last user turn for a text block whose `name === 'seed_diary'`; hash its `text` field.

Hash algorithm (D-5):
```js
import { createHash } from 'node:crypto'
function shortHash(s) { return createHash('sha256').update(s).digest('hex').slice(0, 8) }
```
Hash input is the raw `text` string (UTF-8 bytes — Node's `.update(string)` defaults to utf8) of each block, NOT the rendered log text.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Multi-line emit primitive + per-event-kind section renderers + drop MAX_INLINE</name>
  <files>src/bot/brain/log.js</files>
  <read_first>
    - /Users/ouen/slop/sei/src/bot/brain/log.js (the full current file — every existing export is being touched)
    - /Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md sections `<decisions>` (D-1, D-3, D-9) and `<specifics>` (the exact event preview)
    - /Users/ouen/slop/sei/src/main/logRouter.ts lines 28-40 (the TAG_RE — to confirm the begin/end suffix is appended to the existing tag and the timestamp prefix stays identical to today's format)
  </read_first>
  <action>
Rewrite `src/bot/brain/log.js` end-to-end:

1. **Remove `MAX_INLINE` and `trunc()`** entirely (D-9). Long payloads print in full; elision (Task 2) is the only size control. `safeStringify()` and `ts()` stay.

2. **Add a new `emitBlock(tag, sections)` primitive**. `tag` is the existing bracketed tag string (e.g., `'[haiku?]'`). `sections` is an array of `{ label: string, body: string }`. Output format (D-1, D-3):
   ```
   [HH:MM:SS.mmm] [tag] begin
     label1: body-line-1
       body-line-2-if-multiline
     label2: body-line-1
   [HH:MM:SS.mmm] [tag] end
   ```
   - The begin and end sentinels MUST share ONE timestamp captured at the start of the call (compute `const t = ts()` once and reuse — D-3 / `<code_context>` Established Patterns line 126).
   - Continuation lines are indented exactly 2 spaces from column 0 (D-1, "2-space continuation indent").
   - If a section body itself contains a `\n`, additional lines of that body are indented an extra 2 spaces (4 spaces total) so it visually nests under its label.
   - Emit by joining all output lines with `\n` and writing them through a SINGLE `console.log(...)` call. (Single call = atomic from Node's perspective; logRouter splits on `\n` again.) Wrap in `try { ... } catch {}` per `<code_context>` "Best-effort try/catch around stream writes (Pitfall 7 logging guard) — preserve."

3. **Replace each emitter helper with a per-event-kind section schema**:

   **`logChatIn(username, message)`** → tag `[chat<-]`, sections:
   - `from: <username>`
   - `text: <message>`

   **`logChatOut(text)`** → tag `[chat->]`, sections:
   - `text: <text>`

   **`logHeal({pos, vel, yaw, pitch})`** → tag `[heal]`, sections:
   - `pos: <pos>`
   - `vel: <vel>`
   - `yaw: <yaw>`
   - `pitch: <pitch>`

   **`logActionResult(name, result)`** → tag `[act!]`, sections:
   - `action: <name>`
   - `result: <stringified result>` (use `safeStringify` if not a string; NO truncation)

   **`logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })`** → tag `[haiku?]`, sections built in this exact order:
   - `tools: <comma-separated tool names>`
   - `user:` — body is a multi-line composition (see precise layout below). This is the only section that emits elision hash refs. Hashing logic lives in Task 2; for this task just stub the body as `safeStringify(messages?.[messages.length-1]?.content)` so the test in Task 3 can confirm the multi-line skeleton works without elision.

   **`logHaikuResponse({text, toolUses, usage, stopReason})`** → tag `[haiku!]`, sections:
   - `stop: <stopReason>`
   - `text: <text or "(empty)">`
   - `calls: <one tool call per line, format "name(<json input>)" — multi-line if more than one call, "(none)" if none>`
   - `usage: <safeStringify(usage)>`

4. **Public API stability**: All existing call sites (anthropicClient.js, orchestrator.js, behaviors/chat.js, observers/posHealer.js) must continue to compile without changes. The new optional fields on `logHaikuQuery` are additive.

Do NOT introduce any other behavioral changes. Do NOT modify logRouter — Plan 05-02 owns that.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei &amp;&amp; node -e "import('./src/bot/brain/log.js').then(m =&gt; { const orig = console.log; const lines = []; console.log = (s) =&gt; lines.push(s); m.logChatOut('hello world'); m.logHeal({pos:'1,2,3',vel:'0,0,0',yaw:0,pitch:0}); m.logActionResult('dig',{ok:true,block:'oak_log'}); console.log = orig; const out = lines.join('\n'); const begins = (out.match(/\\] begin$/gm)||[]).length; const ends = (out.match(/\\] end$/gm)||[]).length; /* Filter to multi-line blocks only — excludes the future single-line dictionary-init header (Task 2) so the sameTs check stays meaningful. */ const multiline = lines.filter(blk =&gt; blk.includes('\n')); const sameTs = multiline.length &gt; 0 &amp;&amp; multiline.every(blk =&gt; { const ts = blk.match(/^\\[(\\d\\d:\\d\\d:\\d\\d\\.\\d\\d\\d)\\]/); if (!ts) return false; const all = [...blk.matchAll(/\\[(\\d\\d:\\d\\d:\\d\\d\\.\\d\\d\\d)\\]/g)].map(m=&gt;m[1]); return all.length &gt;= 2 &amp;&amp; all.every(t =&gt; t === ts[1]); }); const indent = /^  \\w/m.test(out); if (begins !== 3 || ends !== 3 || !sameTs || !indent) { console.error('FAIL', {begins, ends, sameTs, indent, multilineCount: multiline.length, out}); process.exit(1); } console.log('OK'); })"</automated>
  </verify>
  <acceptance_criteria>
    - Running the verify command above prints `OK`.
    - `grep -n "MAX_INLINE\|function trunc" src/bot/brain/log.js` returns NO matches.
    - `grep -v '^//' src/bot/brain/log.js | grep -c "begin\b\|end\b"` ≥ 2 (begin and end sentinel literals appear in non-comment lines).
    - Existing callers in src/bot/brain/anthropicClient.js, src/bot/brain/orchestrator.js, src/bot/adapter/minecraft/behaviors/chat.js, src/bot/adapter/minecraft/observers/posHealer.js still resolve their imports — `node --check src/bot/brain/log.js` exits 0.
  </acceptance_criteria>
  <done>log.js writes multi-line begin/end blocks; MAX_INLINE is gone; same timestamp on begin and end; 2-space continuation indent; existing public function signatures remain callable with their old args.</done>
</task>

<task type="auto">
  <name>Task 2: Session hash dictionary + elision logic + cache-prefix dictionary header + anthropicClient wiring</name>
  <files>src/bot/brain/log.js, src/bot/brain/anthropicClient.js</files>
  <read_first>
    - /Users/ouen/slop/sei/src/bot/brain/log.js (post-Task-1 state)
    - /Users/ouen/slop/sei/src/bot/brain/anthropicClient.js (the `call()` function and `buildCachedSystem` for block layout)
    - /Users/ouen/slop/sei/src/bot/brain/orchestrator.js (find every text block emitted into the user-content array — grep for `name:` inside content arrays — to enumerate the ACTUAL name strings produced; do NOT rely on the illustrative list in CONTEXT.md)
    - /Users/ouen/slop/sei/src/bot/brain/compaction.js (same — any text blocks produced here as part of compaction output also flow through namedUserBlocks)
    - /Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md sections D-4..D-8
    - /Users/ouen/slop/sei/src/bot/brain/loop.js lines 1-30, 95-105 (to understand that `name` is preserved in `_internal.messages` but stripped in `buildAnthropicPayload`)
  </read_first>
  <action>
**Part A — in `src/bot/brain/log.js`:**

1. Add session-scoped state (module-scope `let`):
   ```js
   const _seenHashes = new Set()     // hash strings that have been printed in full at least once
   let _headerWritten = false        // becomes true after the dictionary-init header is emitted
   ```
   These are module-scope; restarting the Node process resets them (D-6: no cross-restart persistence).

2. Add a private helper:
   ```js
   import { createHash } from 'node:crypto'
   function shortHash(s) {
     return createHash('sha256').update(typeof s === 'string' ? s : safeStringify(s)).digest('hex').slice(0, 8)
   }
   ```
   Hash input is the RAW `text` field of each block (not the rendered log line).

3. Add a `maybeWriteDictHeader()` helper that — only on first invocation per process — emits exactly this single line via `console.log`:
   ```
   [HH:MM:SS.mmm] [log] cache-prefix dictionary initialized (sha256-8, session-scoped)
   ```
   The `[log]` tag is new; logRouter's TAG_RE already matches any `\[...\]` so it will classify cleanly. This header is a SINGLE physical line (no begin/end sentinels — it is metadata, not an event). Call `maybeWriteDictHeader()` at the top of every emitter helper (cheap; flag-guarded). Because it is flag-guarded by `_headerWritten`, it fires EXACTLY ONCE — on the first emission of the process lifetime.

4. Add a private `elideOrFull(name, body)` helper that:
   - Computes `h = shortHash(body)`.
   - If `_seenHashes.has(h)`: returns the single-line ref string `<${name} @sha=${h}>`.
   - Else: adds `h` to `_seenHashes` and returns a TWO-PART string: the full body verbatim, followed by `\n<${name} @sha=${h}>` on its own line so the reader can grep the hash that maps to this body for later refs.

5. Rewrite the `user:` section of `logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })`. Build the body as an array of lines, then `.join('\n')`:

   a. **Persona** — if `systemBlocks?.[1]?.text` is a non-empty string: append `elideOrFull('persona', systemBlocks[1].text)`. Else skip.

   b. **Capability** — if `systemBlocks?.[2]?.text` is a non-empty string: append `elideOrFull('capability', systemBlocks[2].text)`. Else skip.

   c. **Diary** — locate the diary text. Scan `namedUserBlocks` (if provided) for the LAST entry where role === 'user', then within that entry's content array find the first block where `name === 'seed_diary'` and `type === 'text'`. If found and `text` is non-empty: append `elideOrFull('diary', diaryBlock.text)`. Else skip.

   d. **Dynamic sections** (D-8 — NEVER hashed, always inline in full). Per D-4, ONLY persona/capability/diary are hashed. By complement, every OTHER named user block is printed inline in full — D-8's examples (snapshot / recent_events / owner-chat) are an illustrative subset of this rule, not an exhaustive whitelist.

      Implementation: from the same last user turn in `namedUserBlocks`, iterate ALL `name`d text blocks whose `name` is NOT in `{'persona', 'capability', 'diary', 'seed_diary'}` (those four are handled in 5a/5b/5c — `seed_diary` is the diary slot and is hashed there). For each remaining block, emit one labeled section using the block's `name` field verbatim as the label: `<name>: <text>`. Multi-line bodies indented per Task 1 rules.

      Iteration order: preserve the order in which blocks appear in the content array (the orchestrator's emission order is the developer-facing display order). Do NOT impose a fixed display list — the actual set of names is whatever orchestrator.js + compaction.js produce, which the executor must enumerate from the read_first files.

   e. **Fallback** — if `namedUserBlocks` is absent or empty, fall back to printing `safeStringify(messages?.[messages.length-1]?.content)` as a single `raw:` line so the call site that hasn't been wired yet still produces SOMETHING readable.

6. **`logHaikuResponse`** does NOT participate in elision — Haiku's response content is always novel. No changes from Task 1 beyond what Task 1 already did.

**Part B — in `src/bot/brain/anthropicClient.js`:**

1. Extend the `call()` argument destructure to accept the optional sibling `namedUserBlocks`:
   ```js
   async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024, namedUserBlocks }) {
   ```

2. Update the `logHaikuQuery` invocation to forward both:
   ```js
   logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })
   ```

3. Do NOT alter the actual Anthropic SDK call — `namedUserBlocks` is logger-only metadata, NOT sent to the API. Confirm: only `logHaikuQuery` consumes it; the `sdk.messages.create({ ... })` call body is unchanged from current.

4. Update the JSDoc `@param` block to document the new optional field with: `@param {Array<{role:string, content:Array<{type:string, name?:string, text?:string}>}>} [req.namedUserBlocks] Canonical pre-strip messages array carrying \`name\` fields on text blocks; used by log.js for cache-prefix hash elision. Logger-only; not sent to API.`

**Do NOT touch orchestrator.js in this plan** — that's Plan 05-02's job. Until then, namedUserBlocks is `undefined` and the logger uses the `raw:` fallback.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei &amp;&amp; node -e "import('./src/bot/brain/log.js').then(m =&gt; { const orig = console.log; const lines = []; console.log = (s) =&gt; lines.push(s); const systemBlocks = [{type:'text',text:'sys-instructions'},{type:'text',text:'PERSONA-BODY-XYZ'},{type:'text',text:'CAPABILITY-BODY-ABC'},{type:'text',text:'primer'},{type:'text',text:'tools'}]; const namedUserBlocks = [{role:'user', content:[{type:'text',name:'seed_owner',text:'owner-info'},{type:'text',name:'seed_diary',text:'DIARY-BODY-123'},{type:'text',name:'event',text:'hello'},{type:'text',name:'snapshot',text:'pos=0,0,0'}]}]; m.logHaikuQuery({ messages: [{role:'user', content:'unused-fallback'}], tools: [{name:'say'},{name:'dig'}], systemBlocks, namedUserBlocks }); m.logHaikuQuery({ messages: [{role:'user', content:'unused-fallback'}], tools: [{name:'say'},{name:'dig'}], systemBlocks, namedUserBlocks }); console.log = orig; const all = lines.join('\n'); const headers = (all.match(/cache-prefix dictionary initialized/g)||[]).length; const firstHaiku = lines[1] || ''; const secondHaiku = lines[2] || ''; const firstHasPersonaBody = firstHaiku.includes('PERSONA-BODY-XYZ'); const firstHasPersonaRef = /&lt;persona @sha=[0-9a-f]{8}&gt;/.test(firstHaiku); const secondHasPersonaBody = secondHaiku.includes('PERSONA-BODY-XYZ'); const secondHasPersonaRef = /&lt;persona @sha=[0-9a-f]{8}&gt;/.test(secondHaiku); const secondHasCapabilityRef = /&lt;capability @sha=[0-9a-f]{8}&gt;/.test(secondHaiku); const secondHasDiaryRef = /&lt;diary @sha=[0-9a-f]{8}&gt;/.test(secondHaiku); const secondHasSnapshotInline = secondHaiku.includes('pos=0,0,0'); const secondHasEventInline = secondHaiku.includes('snapshot:') &amp;&amp; secondHaiku.includes('event:'); if (headers !== 1 || !firstHasPersonaBody || !firstHasPersonaRef || secondHasPersonaBody || !secondHasPersonaRef || !secondHasCapabilityRef || !secondHasDiaryRef || !secondHasSnapshotInline || !secondHasEventInline) { console.error('FAIL', JSON.stringify({headers, firstHasPersonaBody, firstHasPersonaRef, secondHasPersonaBody, secondHasPersonaRef, secondHasCapabilityRef, secondHasDiaryRef, secondHasSnapshotInline, secondHasEventInline}, null, 2)); console.error('FIRST:\n'+firstHaiku); console.error('SECOND:\n'+secondHaiku); process.exit(1); } console.log('OK'); })"</automated>
  </verify>
  <acceptance_criteria>
    - Running the verify command prints `OK`.
    - `grep -v '^//' src/bot/brain/log.js | grep -c "createHash('sha256')\|sha256"` ≥ 1.
    - `grep -n "cache-prefix dictionary initialized" src/bot/brain/log.js` returns exactly one match (the header literal).
    - `grep -n "namedUserBlocks" src/bot/brain/anthropicClient.js` returns at least two matches (one in the destructure, one in the forward to logHaikuQuery).
    - `node --check src/bot/brain/anthropicClient.js` exits 0.
    - The Anthropic SDK call `sdk.messages.create({ model, max_tokens, system, tools, messages })` is unchanged — `git diff src/bot/brain/anthropicClient.js` shows NO modification to the object passed to `sdk.messages.create`.
  </acceptance_criteria>
  <done>Persona / capability / diary print in full on first appearance and as short hash refs on later appearances within the same session; all other named user blocks always print inline; header line written once at session start; anthropicClient forwards systemBlocks + namedUserBlocks to logHaikuQuery without altering the API call body.</done>
</task>

</tasks>

<verification>
- Module loads cleanly: `node --check src/bot/brain/log.js && node --check src/bot/brain/anthropicClient.js` exits 0.
- Existing call sites are import-compatible (no signature breaks): `grep -n "logHaikuQuery\|logHaikuResponse\|logChatIn\|logChatOut\|logHeal\|logActionResult" src/bot/{brain,adapter}/**/*.js` resolves and the files still `node --check` clean.
- The two embedded verify commands in Tasks 1 and 2 both print `OK`.
- No `MAX_INLINE` literal remains: `grep -rn "MAX_INLINE" src/bot/brain/log.js` returns no matches.
</verification>

<success_criteria>
- A `[haiku?]` event in a live bot run renders as a multi-line block with begin/end sentinels sharing one timestamp and 2-space-indented sections.
- The second `[haiku?]` event in the SAME session shows three short hash refs (`<persona @sha=...>`, `<capability @sha=...>`, `<diary @sha=...>`) instead of repeating the full ~3KB prefix.
- A `cache-prefix dictionary initialized` header line precedes the first event of the session.
- All other event kinds (`[haiku!]`, `[chat<-]`, `[chat->]`, `[act!]`, `[heal]`) also use the begin/end sentinel format with the section labels specified above.
</success_criteria>

<output>
After completion, create `.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-01-SUMMARY.md` documenting:
- Final `logHaikuQuery` arg shape and the persona/capability/diary index assumptions.
- Confirmation that `MAX_INLINE` is gone.
- The exact header line written at session start.
- The complete set of named blocks the executor found in orchestrator.js + compaction.js, and confirmation that ALL non-{persona,capability,diary,seed_diary} names are emitted inline.
</output>
</output>
