---
quick_id: 260504-oh9
slug: fix-sei-cli-entrypoint-guard-silent-exit
date: 2026-05-04
status: complete
---

# Summary — sei CLI silent-exit fix

## What changed

1. **`src/cli/index.js` entrypoint guard now resolves symlinks.** Replaced
   the inline `if (import.meta.url === pathToFileURL(process.argv[1]).href)`
   check with `isDirectInvocation()`, which calls `realpathSync(argv[1])`
   first. Falls back to running `main()` if `argv[1]` is missing/unreadable.
2. **`requireOnboarded(cmdName)` helper** added; called from `cmdStart` and
   `cmdConfig`. If `config.json` is missing, prints a clear "run `sei` first"
   message and exits with code 1.
3. **README quickstart switched from `npx sei` → `npm link` + `sei`.** Keeps
   `npx sei` mentioned as a fallback for one-off use.

## Why

`process.argv[1]` under `npx`/`npm install -g`/`npm link` is the symlink path
in `node_modules/.bin/`, while `import.meta.url` is the realpath URL of the
source file. They never matched, so `main()` was never called and the CLI
exited silently with no output and no error. Users hitting this had no signal
at all that anything was wrong.

## Verification

- `node src/cli/index.js help` → shows help (existing behavior preserved).
- `<symlink>/sei help` → shows help (was: silent exit; now fixed).
- `sei start` with no `config.json` → "run sei first" error, exit 1.
- `sei config` with no `config.json` → "run sei first" error, exit 1.
- `sei start` with `config.json` present → proceeds to LAN discovery and
  bot startup as before.
- `sei nonsense` → unknown-command error + help, exit 1.

## Files

- `src/cli/index.js` — guard fix + onboarding gate.
- `README.md` — install instructions updated.
