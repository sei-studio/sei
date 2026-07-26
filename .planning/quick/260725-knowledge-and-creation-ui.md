# 260725 — Creation-UI tweaks + Knowledge feature

## Scope

Two workstreams requested together:

A. Creation/edit UI changes (existing surfaces).
B. New per-character "Knowledge" input: user-uploaded reference files cached
   into every AI interaction (chat, voice call, chess, Minecraft bot).
C. Double the MEMORY.md compaction ceiling.

## A. Existing UI changes

### A1. "Who are they?" text box (FullscreenTextField)
Current: a rounded (10px) trigger button with a 4-line clamped preview and an
uppercase "Expand" hint; the ONLY way to type is the fullscreen modal.
Change:
- Render a real inline `<textarea>` (normal typing, no modal needed),
  `border-radius: 0` (matches TextField's D-28 sharp corners).
- Replace the EXPAND text with an expand icon button (corner-arrows glyph) in
  the top-right of the box; clicking the icon opens the existing ModalShell
  fullscreen editor. Modal editor also goes sharp-cornered.

### A2/A3. "Expand my prompt" row
- Description ("Let AI build on what you wrote...") moves into a tooltip on an
  (i) icon next to the label; the inline paragraph goes away.
- Toggle moves to the RIGHT of the label (label + info icon left, toggle right).
- Default flips to ON (`useState(true)`).

### A4. Expand-off characters open in Advanced
No flag exists today (edit modal always opens Standard). Add
`metadata.prompt_mode: 'standard' | 'advanced'`:
- persistCreate stamps `expandPrompt ? 'standard' : 'advanced'`.
- EditCharacterModal seeds `personaMode` from it (fallback 'standard').
- saveAdvanced() stamps 'advanced'; regenerate() stamps 'standard', so the
  choice tracks the user's latest editing mode.

## B. Knowledge feature

### Storage
- New `paths.knowledgeDir(id)` = `<profileRoot>/knowledge/<characterId>/` —
  deliberately OUTSIDE memoryDir so "Reset memory" never wipes it.
- Layout: `index.json` manifest `{version:1, entries:[{id, title, file,
  bytes, added, source:'upload'|'text'|'compacted'}]}` + one `<uuid>.md` per
  entry. Titles live in the manifest (rename without fs rename); filenames are
  always our own UUIDs (uploaded filename never becomes a path component).
- Lifecycle: deleteCharacter wipes knowledgeDir; slug→UUID migration and
  profile localImport move it; resetMemoryForCharacter leaves it alone.

### Ingestion + security
Single validated path: renderer sends `{name, bytesBase64}` to main
(`knowledge:extract`); main decides everything.
- Allowed extensions: .md .markdown .txt .text .docx .doc.
- Text types: UTF-8 decode; reject on NUL bytes / high replacement-char ratio
  ("binary masquerading as text").
- .docx: minimal in-repo zip reader (central directory + inflateRawSync via
  node:zlib), extract word/document.xml, strip tags, decode entities. No new
  dependency, no external parser executing anything.
- Legacy binary .doc: rejected with "save as .txt, .md, or .docx" copy.
- Sanitize: strip control chars (keep \n\t), collapse 3+ blank lines, cap.
- Caps: 512 KB per uploaded file (pre-extract), 64 KB per stored entry,
  20 entries per character.
- Prompt-injection stance: knowledge is DATA. It is injected inside a framed
  block that tells the model it is user-provided reference material, never
  instructions; it is rendered in the UI as plain text (React escaping, no
  HTML rendering); it is never executed, never used as a path, never eval'd.

### Prompt wiring (the "cached for any interaction" part)
- Chat + voice + chess (one shot): new `knowledge?: string` on
  `BuildSystemArgs`; block inserted right after the persona block in
  `buildSystemBlocks` (inside the cached stable region; the existing
  stable-block breakpoint still covers it — NO fifth cache_control).
  Suppliers: `prepareChatTurn` (chatService) and `runChessLlmTurn`
  (chessService) read via a shared `readKnowledgeForPrompt(characterId)`.
- Minecraft bot: main reads the same text at summon and ships it in the init
  payload (`knowledge` field, stashed as `config._seiKnowledge` — the
  continuity pattern); orchestrator APPENDS a knowledge block in
  `rebuildPersonalitySystem` (append-only per the log.js index warning), so it
  lives in the session-cached system prefix. Edits apply on next summon
  (chat/chess pick them up next turn).
- Prompt budget: 48 KB hard cap with a truncation marker.

### Compaction
- Threshold: total pending knowledge > 32 KB at Create-click triggers the
  "Compact memory?" warn modal. (32 KB ≈ 8k tokens — noticeable on
  first-call latency for calls/games, cheap after caching.)
- We only ever store copies (upload = read content, write our own file), so
  originals are never touched; the modal says so.
- `knowledge:compact` runs in main via buildChatSdk() (chessProfile.ts shape +
  continuity's Sonnet→Haiku model fallback), replaces all entries with ONE
  `source:'compacted'` entry targeted ≤ 8 KB (the new MEMORY.md trigger).

### UI surfaces
1. AwakenScreen: third tile "Import from another platform" between "Create my
   own" and "Invite from World" (quota-gated like Create), navigates to
   add-character with `importFirst: true`.
2. AddCharacterScreen: when importFirst, an import phase renders before step 0:
   big drop zone, copy: "Upload your companion's memories and knowledge here.
   You can always edit this later. Please do not upload your AI prompt here."
   Files accumulate as pending entries (listed with remove). Then the usual
   questions. On Create: if total > 32 KB show the compact-confirm modal, then
   persistCreate → knowledge:add each → optional knowledge:compact.
3. CharacterPage gear menu: becomes the single settings menu for ALL
   characters — items: Edit companion (owned custom only), Knowledge (always),
   Reset memory, Unbind. (Owned customs currently skip the menu and open the
   editor directly; one extra click, but Knowledge sits "next to Unbind and
   Reset memory" for every character, as specified.)
4. KnowledgeModal (ModalShell ~880px, two columns): left = entry list with
   pencil (edit title/content in a stacked form modal) + trashcan; right =
   drop zone with "Add text context" button top-right opening the same form
   modal empty.

### New IPC (src/shared/ipc.ts `knowledge` group)
- `knowledge:extract` ({name, bytesBase64}) → {title, content} | typed error
- `knowledge:list` (characterId) → meta[]
- `knowledge:read` (characterId, entryId) → {meta, content}
- `knowledge:add` (characterId, {title, content}) → meta
- `knowledge:update` (characterId, entryId, {title?, content?}) → meta
- `knowledge:delete` (characterId, entryId) → void
- `knowledge:compact` (characterId) → meta (the single compacted entry)

## C. Double MEMORY.md limit before compaction
- `compaction_trigger_bytes` 4096 → 8192 (src/bot/config.js).
- To preserve the stated invariant (trigger must sit BELOW the seed budget so
  compaction fires before seed truncation): `seed_memory_budget_bytes`
  8192 → 16384.
- Chat-side mirrors: `MEMORY_BUDGET_BYTES` 6000 → 12000 (chatService.ts) and
  the duplicated hardcoded 6000 in chessService.ts readMemoryTail.

## Decisions taken (flagging for review)
- Legacy .doc rejected (binary format; unsafe/unreliable to parse) — .docx,
  .md, .txt, .text accepted. The picker still lists .doc so the rejection
  message can explain.
- Owned-custom gear now opens a menu (Edit companion moved inside) instead of
  jumping straight into the editor.
- Compact threshold 32 KB; compacted output target 8 KB; prompt cap 48 KB.
- Knowledge edits reach a LIVE Minecraft bot on next summon only (no hot
  port message in v1).
