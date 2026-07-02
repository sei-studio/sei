# Design: In-App Discord-Style Chat + Cross-Surface Memory

Branch: `feat/app-chat-ui` (worktree). Covers ROADMAP Phase 18 (in-app chat, placeholder
brain) + Phase 19 (UI overhaul). The brain↔game decoupling proper is being done in
parallel (phase-16 / phase-17 worktrees), so the chat LLM here is a **self-contained
placeholder** that we wire to the real brain later. Written plain/factual per memory
[[writing-style-objective]].

## 1. Requirements (extracted from the user's goal)

Functional:
- R1. Clicking a character card on Home (or a character avatar in the IconRail) opens a
  Discord-style chat with that companion.
- R2. Chat connects to the Anthropic API using `chat-baseline + persona + user message`
  (same prompt shape as MC). Persona uses the character's existing `persona.expanded`
  (placeholder; "Sui" is just the default character).
- R3. Chat baseline adds: persona-appropriate curiosity; inviting the user to play games;
  a `launch()` tool wrapping summon; and plain-language context on how the player starts
  MC if they ask.
- R4. Discord-style message rendering: NO bubbles — avatar + name + time/date + message
  text, grouped by consecutive author.
- R5. A user profile-pic uploader in Settings, reusing the character portrait uploader.
  The user pic is the user's avatar in chat.
- R6. Top-right of chat: a **companion profile** button (opens the existing CharacterPage
  info screen), a **voice call** button next to it (Discord-style call UI: big avatar,
  mute, hang-up — placeholder, no audio), and a **games** button.
- R7. Games button opens a tiled grid of supported games; clicking a tile opens an About
  page with a Summon button. This is the new primary summon path. Minecraft is live;
  other games render as locked "coming soon" tiles.
- R8. `launch()` (companion-initiated) starts the summon immediately. If no LAN world is
  open, return a **system message to the agent** explaining in plain words that the user's
  LAN world isn't open and how to open it (Open to LAN), which the agent paraphrases in
  its own tone.
- R9. Replies appear complete with a typing indicator (no token streaming for v1).
- R10. Chat transcripts persist to disk per character, per user/profile (like memory).

Cross-surface memory (researched; see §4):
- R11. Consistent + long-term memory shared across app chat and Minecraft, without token
  bloat. Chat context flows into MC at launch; in-game memory is available in chat.

## 2. Key architectural decision: chat LLM runs in MAIN

`personaExpansion.ts` already calls the Anthropic SDK directly from the main process
(it is the only process holding the decrypted key / cloud JWT). The chat service mirrors
that exactly:

- `src/main/chat/chatService.ts` builds `system = [CHAT_BASELINE, renderPersona(persona),
  continuityBlocks]`, `messages = [...recentHistory, {role:'user', ...}]`, one `launch`
  tool, and calls `new Anthropic(buildSdkOptions())` (local apiKey OR cloud baseURL+JWT,
  the same `getAiBackendKind()` + `apiKeyStore` + auth-session paths the supervisor uses).
- No forked bot, no mineflayer, no LAN needed to chat. This is the "placeholder" wiring
  the user asked for and it cannot collide with the in-flight brain refactor (additive
  new files + thin IPC).
- Reply = the model's text content (direct, not the MC `say()` tool — chat IS the output
  channel, so the scratchpad/say split is unnecessary here). The `launch` tool is the one
  tool. We keep replies short via the baseline.

## 3. Surfaces, IPC, and persistence

### 3.1 IPC (additions to `src/shared/ipc.ts`)
Invoke channels (renderer → main):
- `chat:history` `(characterId) -> ChatMessage[]` — load persisted transcript (recent window).
- `chat:send` `({characterId, text}) -> { reply: ChatMessage; launched?: LaunchSignal }` —
  append user msg, call LLM, append reply, persist, return.
- `chat:clear` `(characterId) -> void`.
- `user:getProfile` `() -> { profilePicture: string | null; preferredName: string }`.
- `user:applyProfilePicture` `({bytesBase64, format}) -> string` (path ref).
- `user:removeProfilePicture` `() -> void`.

Push channel (main → renderer):
- `chat:launch-result` — after a `launch()` tool call resolves (summon started / LAN not
  open), so the chat can show the system→agent follow-up and route the user (open About
  page or start summon). Carries `{ characterId, status, agentNote }`.

`ChatMessage = { id, role: 'user'|'companion'|'system', text, ts }`. `system` messages are
the agent-facing notes (e.g. "LAN world not open") and are NOT shown raw to the user; they
are fed back to the model on the next turn so it paraphrases. (We persist them flagged
`hidden: true`.)

### 3.2 Persistence (`src/main/chat/chatStore.ts`)
- File: `<profileRoot>/memory/<characterId>/chat.jsonl` — one JSON line per message.
  Lives **inside the per-character memory dir** so it is already per-user/per-profile and
  travels with memory. Append-only; `chat:clear` truncates.
- `readRecent(characterId, n)` returns the last n messages (default 50). Older lines stay
  on disk for the rolling summary but are not loaded into the prompt.
- Reuses the existing `withFileLock` + atomic-append helpers from `memoryLog.js` patterns
  (reimplemented main-side; bot's are ESM in src/bot).

### 3.3 User profile pic
- Extend `UserConfigSchema` with `profile_picture: string | null` (path ref, same
  validation as `portrait_image` — no `data:` URLs).
- Store bytes at `<profileRoot>/portraits/_user.png` reusing `portraitStore`/`applyPortrait`
  semantics (validate magic+size+dims, atomic write, file lock). Served by the existing
  `sei-portrait://local/_user.png` protocol — no new protocol needed.
- Settings: reuse `PortraitImagePicker`, generalized to accept `apply`/`remove` callbacks
  (default keeps the character path; user variant points at the new IPC).

## 4. Cross-surface memory architecture (the researched part)

### 4.1 Problem & evidence
The user's seed idea: at MC launch, cache conversation history into the system prompt =
last 50 messages + a summary of everything older; regenerate the summary before each launch
unless the recent window is unchanged; and give chat access to in-game memory.

Grounding (from `.planning/research/v0.4-memory-and-relationship.md`, June 2026):
- Character.AI keeps a small recent window + manual "Pinned/Chat Memories"; it visibly
  degrades ~turn 20 and "better memory" is its #1 request. Window ≠ memory.
- MemGPT/Letta: recursive summary `new = f(old, evicted)` + flush at pressure; **sleep-time
  compute** does consolidation OFF the hot path (same accuracy at ~5× less test-time cost).
- The felt "it remembers me" comes from **concrete fact-callbacks**, which Sei already has
  in the compacted, world-segmented `MEMORY.md` — the durable substrate is built.
- Token economics: Sei's corpus is dozens–hundreds of short entity-dense facts; the durable
  layer already compacts at 4096 bytes. Keep retrieval as ordering, not recall — no
  embeddings needed now.

### 4.2 Design — three tiers, one shared durable store
The unifying principle: **`MEMORY.md` is the single shared long-term store across both
surfaces.** Chat and game both read it and both append to it via `remember()`. This is what
makes the companion feel continuous, and it is already compacted, so it is cheap.

Three tiers of context, smallest-decay first (mirrors the locked prompt-cache layout):

1. **Durable memory — `MEMORY.md` (shared, already exists).**
   - Read into both surfaces' cached system prefix (chat reads it the same way the bot's
     `readMemoryForSeed` does, byte-budgeted, world headers preserved).
   - Chat-written memories append with no `## World` header (surface-agnostic facts live in
     the pre-world header region the reader already supports). Game memories stay
     world-segmented. Net: one file, both surfaces, no schema change.
   - Compaction stays the existing 4096-byte Haiku pass. (No change required for v1.)

2. **Rolling conversation summary — `<memDir>/bridge.md` (new, cheap, incremental).**
   - A compact running summary (hard cap ~800 tokens) of conversation that has scrolled out
     of the recent window — across BOTH chat and game. Updated **recursively**
     (`new = f(old, evicted_messages)`) so we never re-summarize the whole backlog.
   - Update triggers (off the hot path, never blocking a user message):
     - At a **surface handoff** (open chat / launch MC) **iff** new messages have aged past
       the recent window since the last summary (the user's "unless unchanged" guard, made
       incremental). If the window is unchanged, reuse the cached summary verbatim — zero
       LLM cost.
     - During a long chat, opportunistically when ≥K messages (default 20) have aged out.
   - Stored with a `lastSummarizedTs` watermark so we only fold in genuinely-new evictions.

3. **Recent window — verbatim last N messages (default 50, configurable).**
   - Chat: the last N persisted `chat.jsonl` messages become the `messages[]` array.
   - Launch handoff: the init message to the bot carries
     `continuity = { summary: bridge.md, recent: lastN }`. The bot injects this as an early
     cached seed block ("Recent conversation with the player (from the app):"), so in MC the
     companion immediately knows what you were just talking about. N defaults to 50 but is
     capped by a token budget; we trim oldest-first if over budget.

### 4.3 Why this beats the literal seed idea
- Bounded prompt cost: durable (~1k tok, cached) + summary (~800 tok cap) + window (N×~30
  tok). The window is the only knob that scales with N; everything older is O(1) summary.
- No redundant work: recursive summary + watermark means a launch with no new chat costs
  zero extra tokens (reuses cached summary + unchanged window) — strictly better than
  "summarize everything older than 50 every launch".
- Bidirectional by construction: because the durable store and the rolling summary both span
  chat+game, in-app chat sees in-game events (the bot's `remember()` writes + the summary of
  the last session) and MC sees the chat. Satisfies R11 both directions.
- Consolidation off the hot path (sleep-time pattern): summary updates run at handoff/idle,
  not inside a user's send→reply latency.

### 4.4 v1 scope vs. deferred
- v1 builds tiers 1 and 3 fully, and tier 2 as a **synchronous-at-handoff** recursive
  summary (simple, correct). Moving the summary fully background/idle and adding
  importance-scored retrieval are deferred (they are the parallel brain phase's domain).
- We do NOT sync transcripts or `bridge.md` to cloud (runtime memory stays local — carried
  v0.3 decision). Only the existing local-only memory rules apply.

## 5. UI plan (renderer)

New views (useUiStore `View` union): `{kind:'chat', characterId}` and
`{kind:'voice-call', characterId}`. New modals: `{kind:'games-picker', characterId}` and
`{kind:'game-about', characterId, gameId}`.

- `ChatScreen` — header (companion name + status) with right-aligned **Games / Profile /
  Voice** buttons; a Discord message list (avatar+name+timestamp, consecutive grouping,
  no bubbles); a bottom composer with typing indicator while awaiting a reply.
  - Profile button → `navigate({kind:'character', id})`. CharacterPage back returns to the
    chat when it was opened from chat (track origin in the store).
  - Voice button → `navigate({kind:'voice-call', id})`.
  - Games button → `openModal({kind:'games-picker', characterId})`.
- `GamesPickerModal` — tiled grid; Minecraft tile active, others locked "coming soon".
  Click Minecraft → `openModal({kind:'game-about', characterId, gameId:'minecraft'})`.
- `GameAboutModal` — game blurb + **Summon** button → existing `attemptSummon(characterId)`
  flow (LAN modal, skin nudge, conflict guard all reused).
- `VoiceCallModal`/screen — big companion avatar, name, mute toggle (local UI state only),
  hang-up → back to chat. Placeholder, no audio.
- Routing changes: `CharacterCard.onOpen` and IconRail avatar click → `navigate({kind:'chat'})`
  instead of `{kind:'character'}`. (CharacterPage remains reachable via the chat Profile
  button + add-character flow.)
- Chat Zustand store (`useChatStore`) holds per-character message arrays + "awaiting" flag;
  hydrates via `sei.chatHistory(id)` on open; appends optimistic user msg + typing → reply.

All styling via `tokens.css` + `Button`/modal primitives. No literal hex/px.

## 6. Chat baseline prompt (sketch, `src/main/chat/chatPrompts.ts`)
Plain, factual, second-person. Sections: you are in a text chat with the player (not in a
game right now); speak in your own voice; keep replies short and human, lowercase texting
style, no stage directions / no em-dashes (mirror MC baseline voice rules); be curious about
the player at a level matching your persona's proactiveness; you can invite them to play —
Minecraft is available now, other games are coming; how the player starts a game ("they tap
the games button, pick a game, then Summon" — paraphrase, don't recite UI); and the
`launch` tool contract: call `launch(game:"minecraft")` when you and the player agree to
play and you want to jump in yourself; if it returns that the LAN world isn't open, tell them
in your own words to open their world to LAN first. Curiosity/proactivity is modulated by the
persona's existing PROACTIVENESS section (no separate tier knob for v1).

## 7. File-level task list
Backend: shared/ipc.ts (types+channels) · main/chat/{chatPrompts,chatStore,continuity,
chatService}.ts · main/userProfile.ts (config + portrait reuse) · main/ipc.ts (handlers) ·
preload/index.ts (api) · botSupervisor init message (+continuity) · bot/index.js +
brain/prompts.js (inject continuity block — minimal, additive).
Renderer: lib/stores/{useUiStore(+views/origin), useChatStore}.ts · screens/ChatScreen.tsx ·
components/{ChatMessageList,ChatComposer,GamesPickerModal,GameAboutModal,VoiceCallModal}.tsx ·
CharacterCard/IconRail onOpen rewire · CharacterPage back-to-chat origin · SettingsScreen
user-pic section · App.tsx (route new views/modals).

## 8. Verification
- `npm run typecheck` + `npm test` (bot memory + any new units) green.
- Manual: card→chat, send→typing→reply, launch() with/without LAN, profile/voice/games
  buttons, user pic upload shows in chat, transcript survives reopen, launch carries recent
  chat into MC system prompt (log-verify), chat reads a memory written in-game.
