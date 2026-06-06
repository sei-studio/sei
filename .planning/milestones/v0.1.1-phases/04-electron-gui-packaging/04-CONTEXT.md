# Phase 4: Electron GUI & Packaging — Context

**Gathered:** 2026-05-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the `sei` CLI with a polished Electron desktop launcher (CurseForge-style)
that lets a non-technical user onboard, pick or create an AI persona, and click
**Summon** to drop that persona into their open-to-LAN Minecraft world — with
live log visibility while the bot is running, and signed `.dmg` / `.exe`
installers so it can ship to real users.

Workflow the launcher owns end-to-end:
*Player launches MC singleplayer → Open to LAN → opens Sei → picks persona →
presses Summon → sees status / logs in the GUI*

Out of scope (deferred to later phases): movement-LLM revival, screenshot/vision,
multi-character concurrent summons, scheduled/recurring summons.

</domain>

<decisions>
## Implementation Decisions

### Phase scope
- **D-01:** Full original roadmap scope — launcher UI **+** live log viewer
  (GUI-04) **+** signed `.dmg` / `.exe` packaging (PKG-01/02/03) all ship in
  this phase. User explicitly chose full scope because this ships to real
  users.
- **D-02:** This phase is reordered ahead of Phases 5/6/7 in execution order
  (STATE.md previously had 5/6/7 first; user re-prioritized 2026-05-07).
  ROADMAP.md numbering stays as-is.

### Build tooling
- **D-03:** **Vite + React + TypeScript** for the renderer. The mockup is
  React-shaped so this is a 1:1 port. TS catches IPC contract drift between
  main/renderer/utility processes.
- **D-04:** **electron-builder** for packaging; **`@electron/rebuild`** in
  `postinstall` for native module ABI matching (mineflayer's prismarine deps).
- **D-05:** No CDN-loaded React/Babel — that was prototype-only. All renderer
  deps are bundled by Vite.

### Repository layout (everything under `src/`)
- **D-06:** Reshuffle existing code under `src/bot/` so the top of `src/` reads
  as the Electron app:
  ```
  src/
    main/             — Electron main process (window, utilityProcess
                        supervisor, IPC, LAN watcher, keychain access)
    preload/          — contextBridge typed renderer→main API
    renderer/         — Vite + React app
      index.html      — entrypoint (separate styling, no inlined <style>)
      src/
        App.tsx
        screens/      — Onboarding, Home, AddCharacter, CharacterPage,
                        Settings, ComingSoon, Loading
        components/   — Button, TextField, IconRail, MacosWindow,
                        PixelPortrait, LanModal, SummonToast, StepDots
        lib/          — ipcClient, theme, characterStore, logBuffer
        styles/       — tokens.css (CSS variables), global.css, animations.css
      public/
        img/          — sei-logo.{svg,png}, sei-logo-small.{svg,png}
                        (moved from repo root; reachable as /img/... and
                        as `mask-image: url(/img/sei-logo-small.svg)`)
    bot/              — current src/{brain,adapter,cli,config.js,registry.js,
                        index.js} renamed (utilityProcess imports from here)
    shared/           — TS types: IpcMessage, CharacterSchema,
                        OnboardingState, LanState
  ```
- **D-07:** The existing CLI (`sei start` / `sei config`) keeps shipping for
  headless/dev use. It moves to `src/bot/cli/index.js` and remains the
  `bin: { sei: ... }` entrypoint in package.json. The Electron app gets a new
  `electron` script and a separate `bin` for the packaged app.
- **D-08:** Logo files (`sei_logo.svg/png`, `sei_logo_small.svg/png`) move from
  repo root to `src/renderer/public/img/`. The repo-root copies are deleted.

### Multi-character data model & persistence
- **D-09:** **One JSON file per character** under `<userData>/characters/<id>.json`,
  plus a small `<userData>/characters/index.json` manifest for ordering / quick
  enumeration. `<userData>` resolves to Electron's `app.getPath('userData')`
  (NOT the repo) — the packaged app must not write inside its app bundle.
- **D-10:** First-launch migration: if legacy `config.json` has a `persona`
  field, write it to `characters/sui.json` with `id: 'sui'`,
  `created: <now>`, empty `last_launched` / `playtime: 0`. The legacy `persona`
  key is then stripped from `config.json`. The migration is idempotent.
- **D-11:** `last_launched` (ISO timestamp) is set at summon-start.
  `playtime_ms` accumulates from each summon session (start→stop delta) and is
  written on summon-stop. `created` is set at character-add time and never
  mutates.
- **D-12:** Top-level `<userData>/config.json` keeps non-secret user prefs:
  `mc_username`, `preferred_name`, `provider`, `theme_mode`. The API key is
  **never** in `config.json`.
- **D-13:** API key stored via Electron's `safeStorage` API (OS keychain on
  macOS, DPAPI on Windows, libsecret on Linux). Persisted as a single
  `api_key.bin` file under `<userData>/`. Satisfies GUI-01.
- **D-14:** Procedural pixel portraits by default (deterministic from
  `id + name`, FNV-1a → xorshift → 12×12 mirrored grid + fixed eyes per the
  design's `PixelPortrait` algorithm). Optional **image upload override** on
  add/edit; uploaded image is copied to
  `<userData>/characters/<id>.png` and referenced by relative path in the
  character JSON. If the image file is missing at load time, fall back to
  procedural.

### Renderer ↔ bot IPC architecture
- **D-15:** **Three-process Electron exactly per CLAUDE.md.** main ↔ renderer
  (contextIsolation, no nodeIntegration) ↔ utilityProcess (mineflayer +
  orchestrator). Mineflayer is _only_ in utilityProcess.
- **D-16:** **One bot at a time.** Summoning a different character stops the
  current utilityProcess cleanly (graceful disconnect via existing
  `bot.quit()`) before starting the next. No concurrent summons in this phase.
- **D-17:** Main supervises the utilityProcess. The contextBridge in
  `src/preload/index.ts` exposes a typed renderer-facing API:
  ```ts
  // shared/ipc.ts
  type RendererApi = {
    summon(characterId: string): Promise<void>;
    stop(): Promise<void>;
    onStatus(cb: (s: BotStatus) => void): Unsubscribe;
    onLog(cb: (entry: LogEntry) => void): Unsubscribe;
    onLan(cb: (s: LanState) => void): Unsubscribe;
    // CRUD
    listCharacters(): Promise<Character[]>;
    getCharacter(id: string): Promise<Character>;
    saveCharacter(c: Character): Promise<void>;
    deleteCharacter(id: string): Promise<void>;
    // onboarding
    getConfig(): Promise<UserConfig>;
    saveConfig(c: UserConfig): Promise<void>;
    saveApiKey(plaintext: string): Promise<void>;  // → safeStorage
    hasApiKey(): Promise<boolean>;
  };
  ```
  Renderer never has direct Node access; every privileged op goes through
  `ipcRenderer.invoke` / `on` shims in preload.
- **D-18:** Main spawns the utilityProcess with `utilityProcess.fork(
  src/bot/index.js, { stdio: 'pipe' })`, passing the chosen character's full
  config (including the decrypted API key, freshly read from `safeStorage`)
  over a `MessagePortMain` pair. The child's stdout/stderr are tee'd to two
  sinks: (a) main forwards line-by-line to renderer via `onLog` for the live
  log viewer, (b) main also writes them to a rolling file at
  `<userData>/logs/<characterId>-<timestamp>.log` so post-mortem inspection
  is possible.
- **D-19:** Bot lifecycle events the utilityProcess emits to main (and main
  forwards to renderer): `connected`, `disconnected`, `error`, `chat`,
  `summon-ready`, `summon-stopped`. Used to drive the character page status
  row and the Summon button state.

### LAN connectivity (auto-detect)
- **D-20:** **Continuous multicast watcher** in main process. Refactor
  `src/adapter/minecraft/lanDiscovery.js` (now `src/bot/adapter/minecraft/lanDiscovery.js`):
  pull socket-open + `[MOTD]…[/MOTD][AD]port[/AD]` parse logic into
  `watchLan({ onUpdate, staleMs }) → { stop }`. Existing one-shot
  `discoverLanPort()` becomes a thin wrapper (`watchLan` + first-event-resolve).
- **D-21:** Watcher is opened **once** at app boot in main, lives for the
  whole app session, single shared UDP socket bound to `224.0.2.60:4445`
  with `reuseAddr: true`. Cost is negligible (kernel does multicast
  filtering; userland parses ~80B twice/second when LAN is open, zero CPU
  when not).
- **D-22:** Pill state machine in main, broadcast to renderer via `onLan`:
  - `connected`: a packet was received within the last **3000 ms**;
    payload is `{ port, motd, lastSeenAt }`.
  - `not_connected`: no packet for >3000 ms.
  - `unavailable`: `socket.addMembership` failed (multicast filtered on this
    network). Renderer shows pill in red with tooltip "LAN auto-detect
    unavailable on this network."
- **D-23:** **No manual override** ("Mark as connected" was prototype-only —
  you can't lie your way to a port number).
- **D-24:** **Summon-while-disconnected behavior:** if user clicks Summon and
  pill is not green, the LAN modal opens immediately, shows the 4-step
  instructions plus a "**Searching…**" line with a loading animation. The
  modal listens to `onLan`; the moment a `connected` event arrives it
  auto-dismisses and proceeds with the summon, passing the cached `port` to
  the utilityProcess. ESC or "Cancel" aborts the pending summon.
- **D-25:** Summoning hands the cached `{ port }` directly to the bot — the
  utilityProcess does **not** re-discover LAN. (Saves the 1.5–5s discovery
  handshake on every summon.)

### Provider picker
- **D-26:** Render all 4 tiles (Anthropic / OpenAI / Google / Local) for
  visual fidelity with the mockup. **Only Anthropic is selectable** — the
  others render with a "Coming soon" chip and `aria-disabled`. No
  OpenAI/Google/Ollama clients are built in this phase.
- **D-27:** `provider` is persisted in `config.json` as a string. Today only
  `'anthropic'` is valid; future-proofed for the rest.

### Visual design (locked from mockup, verbatim)
- **D-28:** **All edges sharp** — `border-radius: 0` across every component.
- **D-29:** **Color tokens** (CSS variables in `styles/tokens.css`):
  - Light: `--window:#FDFEFF`, `--accent:#F4C2AA` (warm beige),
    `--accent-strong:#E5A382`, `--accent-soft:rgba(244,194,170,0.30)`,
    `--desktop:#F2F1EE`, `--surface:#F6F5F2`, `--surface-2:#FFFFFF`,
    `--rail:#F6F5F2`, `--rail-active:#ECEAE3`, `--text:#1A1D24`,
    `--text-2:#4A4D55`, `--muted:#8A8D95`, `--green:#5E8E47`, `--red:#C4523A`.
  - Dark: `--window:#191C21`, `--accent:#7AA9ED` (light blue),
    `--accent-strong:#94BBF2`, `--accent-soft:rgba(122,169,237,0.16)`,
    `--desktop:#14161B`, `--surface:#1F232A`, `--surface-2:#252932`,
    `--rail:#15181D`, `--rail-active:#252932`, `--text:#E8EBF0`,
    `--text-2:#B4B9C2`, `--muted:#6E7480`, `--green:#7DB868`, `--red:#E07259`.
- **D-30:** **Typography**:
  - Body / sans: **Noto Sans** (`--sans`).
  - Pixel / 8-bit: **Press Start 2P** (`--pixel`) — used **sparingly**: Sei
    wordmark, character names, modal step numbers. Never on body copy.
  - Mono: **JetBrains Mono** (`--mono`) — eyebrows, status pill, API-key
    field, log viewer, the Persona-prompt card body.
- **D-31:** **Inputs**: borderless underline (1.5px bottom border, accent on
  focus, no surrounding box, no focus ring). API-key field uses `type=password`
  + `--mono`.
- **D-32:** **macOS window chrome**: traffic lights **top-LEFT** (matches
  macOS native; user explicitly moved them there in iteration 3).
- **D-33:** **Theme behavior**: respects `prefers-color-scheme` on first run,
  user override stored in `config.json.theme_mode` (`'system' | 'light' | 'dark'`).
  Toggle lives in the sidebar rail.
- **D-34:** **Sidebar rail icons** (top→bottom; 72px wide; centered icons,
  26–34px each):
  Home → MC pixel block (no real Minecraft branding; user said use a generic
  green/brown block) → "+" (other games → Coming Soon screen) → spacer →
  Theme toggle → Settings (gear → Settings screen with Re-run onboarding).
  **No "Sei" wordmark in the rail** (user removed it in iteration 5).
- **D-35:** **Loading screen** at app boot (~1.6s). Renders the recolored
  `sei-logo-small.svg` via `mask-image` so it picks up `var(--accent)`
  automatically. Gentle pulse + three blinking dots. Skipped on subsequent
  in-app screen transitions (those use 220–280ms `fade` / `fade-up`).
- **D-36:** **Step-dot progress indicator**: active dot 22×6px, inactive 6×6px,
  past steps `var(--text-2)`, future steps `var(--border-strong)`.

### Onboarding (5 steps, one question at a time)
- **D-37:** Step 0 — Welcome, centered. Title is the inline-flex composition
  "Welcome to [SeiPixelMark height=22 color='var(--accent)']." with
  `align-items: baseline` so the pixel logo's bottom and the text baseline
  align (user spent multiple iterations getting this right).
- **D-38:** Step 1 — "What's your Minecraft username?" (mono input, no
  placeholder).
- **D-39:** Step 2 — "What should they call you?" (preferred name, sans input,
  no placeholder).
- **D-40:** Step 3 — Provider picker (4 tiles per D-26).
- **D-41:** Step 4 — "Paste your `<Provider>` API key." Password field, mono,
  placeholder `sk-ant-...` (only kept on this step per user's iteration).
  "Finish" button. On submit: persist via `safeStorage`, save user prefs to
  `config.json`, run first-launch migration (D-10), navigate to Home.
- **D-42:** Re-onboarding (from Settings → Re-run onboarding) reuses the
  same flow; "Back" exits to Settings on Step 0 instead of cancelling.

### Home / character grid
- **D-43:** Header reads "Characters" (h1, sans 32px, weight 600, letter
  spacing -0.6). Right side: **LAN status pill** (mono, uppercase, 7px dot)
  + "+ New" button.
- **D-44:** Grid: `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`,
  18px gap. Each card: aspect-ratio 1/1 portrait + bottom info row (name +
  "Last: <date>" or "Never summoned"). Hover: translateY(-2px), elevated
  shadow, a **Summon button overlays** the portrait. Status chip top-left
  ("Default" green for Sui / "Custom" gray for everything else).
- **D-45:** Last card is the dashed `AddCard` ("New character" — opens
  AddCharacter flow).

### Add character (3 steps)
- **D-46:** Step 0 — "Name your character." (sans input).
- **D-47:** Step 1 — eyebrow "Shown to you", title "Describe them.", hint
  "A short bio that appears on this character's page. Just for you — purely
  flavour." (multiline, 5 rows).
- **D-48:** Step 2 — eyebrow "Sent to the model", title "Write the persona
  prompt.", hint "The system instruction the language model receives. Speak
  to the model directly." (multiline, 7 rows, mono). On submit ("Create"):
  generate `id` from name slug (collision-safe with -2, -3 suffix), seed
  procedural palette, write `characters/<id>.json`, navigate to that
  character's page.

### Character page
- **D-49:** Two-column layout (320px portrait + 1fr details, 36px gap).
  Portrait card uses `var(--shadow-card)`. Below portrait: full-width
  "Summon into Minecraft" button (accent, sparkle icon — **not** play icon),
  then "Edit persona" + "Delete" (Delete is hidden for `id === 'sui'`).
- **D-50:** Right column: eyebrow ("Default" / "Custom"), pixel-font title
  (Press Start 2P, 30px), Description card (sans body, "For you" tag), then
  Persona-prompt card — **collapsed by default**, shows "Hidden" tag, expand
  via "Show / Hide" toggle (accent, mono, uppercase). When expanded: accent
  left-border, mono body, fade-in animation, eyebrow becomes
  "Sent to {model}".
- **D-51:** Stats grid (3×1): Last launched / Total playtime / Created.
  Mono eyebrows, sans value. Default values: '—' for never-summoned.
- **D-52:** Model status row (single line): green dot + "Ready" + dot
  separator + mono model id. When summoned: green dot stays, label flips
  to "Online" with mono uptime; on error: red dot + plain-English error +
  "Try again" link that re-issues summon.
- **D-53:** **Logs tab** is added next to the implicit Description / Persona
  prompt sections. The tab is **only enabled when this character is the
  active summon**; otherwise it shows a disabled "Logs available while
  summoned" stub. When active: a virtualized scroll-pinned terminal panel
  showing utilityProcess stdout/stderr line-by-line, mono, color-tagged by
  level (info / warn / error / haiku-prompt / haiku-response / chat). Copy-all
  button in the header. Buffer cap: last 5000 lines in renderer; main keeps
  the rolling file (D-18).

### LAN modal
- **D-54:** 4 numbered steps (mono pixel-font numbers in accent), exactly:
  1. "Launch Minecraft and open your singleplayer world."
  2. "Press ESC, then choose Open to LAN."
  3. "Set Allow Cheats to On, then click Start LAN World."
  4. "Return to Sei and press Summon."
- **D-55:** Modal header: live "Connected / Not connected" indicator (D-22),
  plus when modal was opened by a Summon-while-disconnected attempt
  (D-24), an additional "Searching…" row with three blinking dots and the
  loading animation.
- **D-56:** When `onLan` flips to `connected` while the Summon-while-disconnected
  modal is open: auto-dismiss → resume the pending summon. (Cancel /
  ESC in the modal aborts.)
- **D-57:** No "Mark as connected" button (D-23). The only modal CTAs are
  "Close" and the read-only steps.

### Settings
- **D-58:** Three sections: Account (rows: MC username, Preferred name,
  Provider, API key shown as bullets), Appearance (Theme toggle), Setup
  (Re-run onboarding button).

### Summon flow & toast
- **D-59:** Summon (from card hover or character page button): if no LAN →
  open LAN modal in "Searching…" mode (D-24). If LAN → show summon toast
  (bottom-right, dark background, mono character name, auto-dismiss 4.2s)
  and instruct main to spawn the utilityProcess. Status row + Logs tab go
  live as IPC events arrive.

### Packaging (PKG-01/02/03)
- **D-60:** **electron-builder** config in `electron-builder.yml` produces:
  - macOS: `.dmg` (universal — arm64 + x64), Hardened Runtime, signed +
    notarized.
  - Windows: NSIS `.exe`, signed with EV cert.
  - Linux: AppImage (unsigned, best-effort).
- **D-61:** **`@electron/rebuild`** runs in `postinstall`. Rebuilds
  `better-sqlite3` (dep added in this phase for character indexing? — see
  Claude's Discretion below) and any other native modules against the
  bundled Electron's ABI. Verified manually on a clean macOS VM and clean
  Windows VM before each release (PKG-03).
- **D-62:** Code-signing certificates are **external dependencies** the user
  is already pursuing (Apple Developer + Windows EV cert per STATE.md
  Todos). Plan must surface this as a prerequisite, not a task.
- **D-63:** Auto-update is **out of scope** for this phase (deferred to a
  future maintenance phase).

### Claude's Discretion
- Exact React component hierarchy / file split inside `src/renderer/src/`.
- Animation timings (the design used 200/220/240/280ms — match closely
  but exact values flex if a transition feels off).
- IPC channel names (`bot:summon`, `bot:stop`, `bot:status`, `bot:log`,
  `lan:state`, `chars:list`, etc. — pick consistently).
- Whether to introduce `better-sqlite3` for the character index now or stick
  with JSON files. CONTEXT locks JSON files (D-09); SQLite can come back if
  perf/atomicity proves a problem (V2 per ROADMAP).
- Renderer state management — pick one (Zustand / Jotai / plain context).
  No Redux.
- Loading-screen exact duration — design said ~1.6s, but if first-paint
  takes longer than that we can tie it to actual ready state instead of a
  fixed timer.
- Log-line color tagging algorithm (regex on `[haiku?]` / `[chat->]` etc.)
  — best-effort; clean fallback to plain mono if no match.

</decisions>

<specifics>
## Specific Ideas

- The mockup's procedural pixel-portrait algorithm is documented verbatim in
  the chat transcript — we port it as-is (FNV-1a hash → xorshift PRNG → 12×12
  grid, left half generated and mirrored to right, fixed eye pixels at
  (row 4, col 3) and (row 4, col 8), 6-color palette selected deterministically
  by name hash).
- "MC" sidebar block uses generic green-top / brown-side pixel coloring —
  **not** real Minecraft branding (user explicitly avoided trademarked marks).
- "Welcome to [Sei]" title baseline-aligns the pixel logo with the text
  baseline (`align-items: baseline`, logo height matches h1 cap height
  ~22px). Multiple iterations went into this — match exactly.
- Summon button uses a **four-point sparkle** icon (with a smaller secondary
  sparkle), not a play icon. Applied identically on hover overlay and
  character-page primary button.
- "Other games coming soon" stub: pixel-font "Other games" header + "Coming
  soon." sans h1 + "Back to Minecraft" button. Centered, max-width 440.
- LAN modal step numbers use Press Start 2P with `padStart(2, '0')`
  ("01", "02", "03", "04") in accent color.
- No "Sei" wordmark anywhere in the launcher chrome — only in the loading
  screen and the onboarding welcome step.
- Deletion is gated for default Sui (`id === 'sui'` → no Delete button).

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & roadmap
- `.planning/ROADMAP.md` §"Phase 4: Electron GUI & Packaging" — original
  goal, success criteria, requirement IDs (GUI-01..05, PKG-01..03).
- `.planning/REQUIREMENTS.md` — full text of GUI-01..05 + PKG-01..03.
- `.planning/STATE.md` §"Decisions" + §"Roadmap Evolution" — three-process
  Electron rule, native-ABI rebuild requirement, packaging cert prerequisites.

### Project rules (hard constraints)
- `CLAUDE.md` §"Key Architecture Decisions" — three-process Electron;
  mineflayer-must-run-in-utilityProcess-only.
- `CLAUDE.md` §"Critical Pitfalls" — native ABI mismatch (`@electron/rebuild`
  in postinstall), pathfinder timeout discipline.

### Design source of truth (stashed under this phase dir)
- `.planning/phases/04-electron-gui-packaging/design/README.md` — Claude
  Design handoff README; "What you should do" instructions.
- `.planning/phases/04-electron-gui-packaging/design/chats/chat1.md` — full
  user↔assistant design conversation. Contains the iteration history and
  the explicit color tokens, typography choices, and the procedural-portrait
  algorithm description. **Read this before implementing visuals.**
- `.planning/phases/04-electron-gui-packaging/design/project/index.html` —
  CSS variables, font imports, theme tokens, animations.
- `.planning/phases/04-electron-gui-packaging/design/project/screens.jsx` —
  Onboarding, Home, AddCharacter, CharacterPage, Settings, ComingSoon,
  SummonToast, LanModal — all screen logic and inline styles.
- `.planning/phases/04-electron-gui-packaging/design/project/ui.jsx` —
  Button, TextField, IconRail, MacosWindow, PixelPortrait, icon SVGs.
- `.planning/phases/04-electron-gui-packaging/design/project/macos-window.jsx`
  — window chrome (traffic lights top-left).
- `.planning/phases/04-electron-gui-packaging/design/project/app.jsx` —
  top-level orchestration, routing, theme application, demo state.

### Existing code to refactor / preserve
- `src/adapter/minecraft/lanDiscovery.js` — refactor target for D-20/D-21.
  Pull socket logic into long-lived `watchLan(...)`; existing one-shot
  `discoverLanPort()` becomes a thin wrapper.
- `src/cli/index.js` — onboarding flow + config.json schema reference. CLI
  keeps shipping; relocates to `src/bot/cli/index.js`.
- `src/index.js` — bot entry; relocates to `src/bot/index.js`. Becomes the
  utilityProcess entrypoint (no behavioral change required this phase).
- `src/{brain,adapter,registry.js,config.js}` — relocate to `src/bot/...`.
  All imports updated. No logic changes.

### Logo assets to relocate
- `sei_logo.svg`, `sei_logo.png`, `sei_logo_small.svg`, `sei_logo_small.png`
  at repo root → move to `src/renderer/public/img/`. Repo-root copies
  removed.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/adapter/minecraft/lanDiscovery.js`** — already does multicast
  receive on `224.0.2.60:4445` and parses `[MOTD]…[/MOTD][AD]port[/AD]`.
  Refactor into `watchLan({ onUpdate, staleMs })` returning `{ stop }`,
  keep one-shot as thin wrapper.
- **`src/cli/index.js`** — onboarding Q&A flow (MC username, preferred name,
  persona, API key) maps directly onto the launcher's onboarding +
  add-character screens. Validation rules and config-shape migration logic
  lift cleanly.
- **`src/cli/index.js` `cmdStart`** — current child-process spawn pattern
  is the conceptual ancestor of the utilityProcess supervisor in `src/main/`.
  Replace `spawn(node, [INDEX_PATH], { stdio: 'inherit' })` with
  `utilityProcess.fork(BOT_INDEX, { stdio: 'pipe' })` + MessagePort plumbing.
- **`config.json` shape** (current): `owner_username`, `owner_preferred_name`,
  `chat_mode`, `persona{name, backstory, tone}`, `anthropic{api_key}`,
  `adapter.minecraft{...}`, `llm{...}`. Migration in D-10 keeps everything
  except splits `persona` into per-character files and lifts the API key
  out to `safeStorage`.

### Established Patterns
- **Single LLM call for both reasoning and action dispatch** (CLAUDE.md
  Decision 2). The summon flow doesn't change this — the GUI just supplies
  the persona / character data; the bot itself runs unchanged inside the
  utilityProcess.
- **Wall-clock timeouts on every external call** (pathfinder, Anthropic).
  IPC contracts MUST also include timeouts: `summon()` returns within 30s
  or fails with `BOT_START_TIMEOUT`; `stop()` within 10s or escalates to
  hard kill.
- **Atomic JSON writes via tmp+rename** (existing pattern in
  `src/brain/atomicWrite.js`). Reuse for character JSON saves; do NOT roll
  a separate file-write helper.

### Integration Points
- **Bot startup currently happens in `src/index.js`** — that file becomes
  the utilityProcess entrypoint at `src/bot/index.js`. It already accepts
  config from `loadConfig()`; we extend that to accept a config object
  passed via MessagePort (the supervisor reads `<userData>/config.json` +
  `<userData>/characters/<id>.json` + `safeStorage` and ships the merged
  shape).
- **Owner UUID detection / OWNER.md / DIARY.md** (Phase 3) is per-bot-run.
  Each utilityProcess has its own memory dir at
  `<userData>/memory/<characterId>/` so different characters maintain
  separate diaries / owner notes. Migration: move existing `memory/` to
  `<userData>/memory/sui/` on first launch.

</code_context>

<deferred>
## Deferred Ideas

- **Concurrent character summons** — multiple bots in the world at once.
  Out of scope (D-16). Future phase: 4.1 or a v2 milestone item.
- **Movement-LLM (Ollama Qwen) revival** — was removed in 260505-iqo.
  Stays out; provider tile "Local" is disabled.
- **OpenAI / Google provider clients** — visible in UI but not wired
  (D-26). Defer to a "multi-provider" phase.
- **Auto-update** — electron-updater integration deferred (D-63).
- **Settings: per-character defaults** — no per-character LLM model
  override or per-character LAN-port override this phase.
- **Theming beyond light/dark** — accent color picker / custom palettes
  was in the prototype's tweaks panel; not shipping.
- **Character export / import / share** — no export of character JSON yet.
- **Discord-style "rich presence"** showing which character is currently
  summoned to the OS — out of scope.
- **Custom server connection (non-LAN)** — current scope is open-to-LAN
  only, matches existing CLI behavior.
- **Telemetry / crash reporting** — Sentry / Electron crashReporter
  deferred.

</deferred>

---

*Phase: 04-electron-gui-packaging*
*Context gathered: 2026-05-07*
