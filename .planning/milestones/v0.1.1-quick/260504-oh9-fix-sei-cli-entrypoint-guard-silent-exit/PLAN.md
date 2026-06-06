---
quick_id: 260504-oh9
slug: fix-sei-cli-entrypoint-guard-silent-exit
date: 2026-05-04
status: in-progress
---

# Fix sei CLI silent-exit + first-run gate + global-install docs

## Problem

`npx sei`, `npx sei start`, `npx sei config` all return immediately with no output and do nothing.

## Root Cause

`src/cli/index.js:304` guards `main()` with:

```js
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(...)
}
```

When the CLI is invoked through the npm `bin` field (npx, `npm install -g`, `npm link`), npm
creates a symlink at `node_modules/.bin/sei` pointing at the actual file. At runtime:

- `process.argv[1]` is the **symlink path** (e.g. `…/.npm/_npx/<hash>/node_modules/.bin/sei`)
- `import.meta.url` is the **realpath URL** (`file://…/node_modules/sei/src/cli/index.js`)

They never match, so `main()` is never called and the process exits silently.

## Fixes

1. **Resolve the symlink** in the entrypoint guard so it matches under npm/npx bin dispatch.
   - Use `realpathSync(process.argv[1])` before `pathToFileURL`.
   - Wrap in try/catch — if argv[1] is missing or unreadable, default to running `main()`
     (the script was clearly invoked, so booting is the right call).
2. **First-run gate for `start` and `config`**: if `config.json` is missing, refuse and
   point the user at `sei` (which runs onboarding).
   - Spec says: "start and config must wait for `sei` to be ran first."
3. **Document running as `sei` (no `npx`)**: add a `npm install -g .` (or `npm link`)
   line to the README quickstart, then show usage as plain `sei`, `sei start`,
   `sei config`. Keep `npx sei` mentioned as an alternative for one-off use.

## Out of scope

- No new dependencies.
- No restructure of CLI commands beyond the gate check.
- Not touching `src/index.js` — its `main()` is invoked unconditionally and works.

## Verification

- `node src/cli/index.js` (direct invocation) shows the menu — should still work.
- `npx sei` from the project root shows the menu / onboarding — should now work.
- `sei start` (or `npx sei start`) with no `config.json` prints a clear "run `sei` first"
  message and exits non-zero.
- `sei config` with no `config.json` does the same.
- After running `sei` once and writing `config.json`, `sei start` proceeds to spawn the bot.
