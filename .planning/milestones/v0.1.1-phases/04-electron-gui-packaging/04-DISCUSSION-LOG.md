# Phase 4: Electron GUI & Packaging — Discussion Log

**Date:** 2026-05-07
**Mode:** discuss (default)
**Source for decisions:** see `04-CONTEXT.md`

This log records what was asked, what the user picked, and why — for
audit / retrospective only. Downstream agents read CONTEXT.md, not this file.

---

## Inputs the user supplied at command time

- Phase number: **4**
- Free-text intent: "We will implement a simple local electron GUI in place
  of the CLI. I have a mockup at this design file, read its readme, and
  implement the relevant aspects of the design.
  https://api.anthropic.com/v1/design/h/oYY5Sb1dlwSBuGa-jBM_yA?open_file=index.html
  Implement: index.html. Reference design choices but do not copy it
  completely as you will need to adjust content based on what we actually
  have. Also adopt good practices and separate styling. The logo image can
  be found in this dir, move them to an img/ dir."
- Design bundle: gzip tarball returned by the Anthropic design URL.
  Extracted to `/tmp/sei-design/sei-mc/`, then stashed under
  `.planning/phases/04-electron-gui-packaging/design/` for canonical reference.

## Pre-question scouting

- Read PROJECT.md / REQUIREMENTS.md / STATE.md / ROADMAP.md.
- Confirmed CLAUDE.md hard rules (three-process Electron;
  mineflayer-in-utilityProcess; native-ABI rebuild).
- Located `src/adapter/minecraft/lanDiscovery.js` (existing multicast
  receiver on 224.0.2.60:4445 — relevant to LAN-watcher decision).
- Inspected `src/cli/index.js` to see current onboarding flow + child-process
  bot spawn pattern.
- Read full design bundle: `README.md`, `chats/chat1.md` (full design
  iteration history), `project/index.html`, `project/screens.jsx`.

## Gray areas presented (multi-select)

> "Which Phase 4 gray areas should we lock down before planning?"

User picked **all four**:
- Phase scope (log viewer + packaging)
- Multi-character data model & migration
- Renderer ↔ bot IPC
- Build tooling & file layout

---

## Area 1 — Phase scope

> "What's in Phase 4 vs deferred? The design is a launcher only (no log
> viewer, no packaging). Roadmap Phase 4 has GUI-04 (log viewer) +
> PKG-01/02/03 (signed .dmg/.exe)."

Options presented:
- Launcher only — defer log viewer + packaging (Recommended)
- Launcher + log viewer; defer packaging
- Full original scope (launcher + logs + packaging)
- Launcher + minimal log viewer (single-bot tail)

**Selected:** Full original scope. Rationale (verbatim): _"Go with
utilityProcess and best practice as we will ship this to real users."_
(rationale given on the IPC question, but the scope decision is the
upstream one — user wants production-grade.)

→ Decisions D-01, D-02 in CONTEXT.md.

---

## Area 2 — Multi-character data model

> "How should multiple characters be stored, and how does the existing Sui
> persona migrate?"

Options presented:
- characters/<id>.json + index.json (Recommended)
- Single config.json with characters[] array
- SQLite via better-sqlite3 (already a roadmap dep)
- Files per character + secure store for API key only

**Selected:** characters/<id>.json + index.json (Recommended). API-key
keychain rule preserved separately (it was a hard requirement from GUI-01,
not a discussion gray area).

→ Decisions D-09 through D-14 in CONTEXT.md.

---

## Area 3 — Renderer ↔ bot IPC

> "How should the renderer talk to the mineflayer bot (which must run in
> utilityProcess only)?"

Options presented:
- main = supervisor; utilityProcess per active summon (Recommended)
- Long-lived utilityProcess; characters swap inside it
- Spawn `node src/index.js` as Node child process (skip utilityProcess)
- Multiple concurrent utility processes (one per summoned character)

User initially asked for the question to be re-explained ("Explain in
simple terms what you're asking me") and then asked specifically about
the trade-off between utilityProcess and `sei start` (option 3).

The trade-off was explained:
- utilityProcess gives lifecycle-tied-to-app cleanup, built-in
  MessagePort, sandboxing, future-proofing for Mac App Store.
- `child_process.spawn` (option 3) is genuinely fine for one-bot-at-a-time
  but means hand-rolling a stdout/stdin protocol and manually killing
  the child on app exit.

**Selected:** _"Go with utilityProcess and best practice as we will ship
this to real users."_

→ Decisions D-15 through D-19 in CONTEXT.md.

---

## Area 4 — Build tooling & file layout

> "How should the renderer be built? The mockup uses CDN React + Babel
> (prototype-only). Real options:"

Options presented:
- Vite + React + TypeScript (Recommended)
- Vite + vanilla JS, no framework
- Plain HTML + CSS + JS, no bundler
- Next.js / SvelteKit / other meta-framework

**Selected:** Vite + React + TypeScript (Recommended).

> "Where should files live in the repo?"

Options presented:
- src/electron/{main,preload,renderer} + img/ at repo root (Recommended)
- Top-level renderer/ + electron/ + shared/
- Everything under src/ but split: src/main, src/renderer, src/preload,
  src/bot (rename current src/* to src/bot)

**Selected (verbatim):** _"Everything under src, reshuffle existing code
for clean best practice organization. Same thing with img/ override my
suggestion if there is a better placement for that dir."_

Claude's call on `img/`: place at `src/renderer/public/img/`. Vite copies
`public/` verbatim to dist root, so the loading-screen `mask-image:
url(/img/sei-logo-small.svg)` recolor trick works without an asset import,
and any component can reference `/img/...`.

→ Decisions D-03 through D-08 in CONTEXT.md.

---

## Follow-up — LAN connectivity (user-driven question)

After the build/layout decision, user asked unprompted:
> "Can we have this driven as a LAN searcher, such that it'll say connected
> if it finds an open LAN port? Would it be computationally expensive to
> constantly search for LAN while app is open? I was thinking we could use
> a similar process to what 'sei start' currently runs to find LAN world.
> So 'connected' will mean LAN world is found without bot needing to join,
> and then bot can join that directly."

Claude answered: yes, effectively free — passive UDP multicast listener,
~80B parsed twice/second, kernel does the filtering. Proposed continuous
watcher in main process, pill green when packet seen within 3s, cached
port handed to bot at summon time. Refactor `lanDiscovery.js` into
`watchLan()` + thin one-shot wrapper.

> "Lock LAN approach: ..."

Options:
- Yes, lock it
- Yes, but always allow manual override
- Adjust something — I'll explain

**Selected (verbatim):** _"Yes lock it. And remove the manual button as
manually marking connected does not make sense. Also, when 'summon' is
pressed but LAN is not connected, show instructions and a 'searching...'
text and loading animation window to explicitly tell users we are
watching lan."_

→ Decisions D-20 through D-25 in CONTEXT.md.

---

## Final batch — provider, logs, portraits

> "Provider picker — the design shows Anthropic / OpenAI / Google / Local.
> Today only Anthropic works."

Options:
- Anthropic only; show others as "Coming soon" disabled tiles (Recommended)
- Anthropic only; remove the other tiles
- Wire all 4 providers in this phase

**Selected:** Anthropic only; show others as "Coming soon" disabled tiles.

> "Where does the live log viewer live?"

Options:
- Tab on the character page, only when summoned (Recommended)
- Bottom drawer, app-global
- Dedicated 'Logs' icon in the sidebar rail
- Floating window (separate Electron BrowserWindow)

**Selected:** Tab on the character page, only when summoned.

> "Character portraits — procedural pixel art or images?"

Options:
- Procedural by default; allow image upload override (Recommended)
- Procedural only
- Image upload required, no procedural
- Static logo for all characters

**Selected:** Procedural by default; allow image upload override.

→ Decisions D-26, D-27, D-53, D-14 (portrait clause) in CONTEXT.md.

---

## Deferred / out of scope (captured)

See `<deferred>` section in CONTEXT.md. Highlights:
- Concurrent multi-character summons
- OpenAI / Google / Ollama provider clients (UI shows "Coming soon")
- Auto-update (electron-updater)
- Telemetry / crash reporting
- Custom-server connection (non-LAN)
- Per-character model overrides
- Character export / import / share

---

## Notable user feedback patterns (for future sessions)

- User wants explanations in plain terms when a question is jargon-heavy;
  appreciated the "Explain in simple terms" follow-up flow.
- User pushes back when an option set hides a real trade-off (asked
  "what benefit is there of utility process over sei start" rather than
  picking blind).
- User is willing to override Claude's recommendations when the reasoning
  fits their goals (chose full scope over recommended "launcher only";
  chose all-under-src reshuffle over recommended `src/electron` split).
- User volunteers architecture ideas that improve the design (LAN-watcher
  decoupling from bot connection was their idea — and it's better than
  what the mockup had).
