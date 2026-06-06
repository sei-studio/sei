---
phase: 04-electron-gui-packaging
plan: 10
type: execute
wave: 8
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09]
files_modified:
  - electron-builder.yml
  - build/entitlements.mac.plist
  - package.json
autonomous: false
requirements: [PKG-01, PKG-02]
must_haves:
  truths:
    - "electron-builder.yml flesh-out includes hardenedRuntime + entitlements references for macOS, AND retains the placeholder appId until the user resolves the BLOCKING task"
    - "build/entitlements.mac.plist exists with the four required entitlements (allow-jit, allow-unsigned-executable-memory, network.client, network.server)"
    - "macOS packaging config uses notarize:true (lazy — env-driven on actual builds; smoke test in plan 11 confirms config validates)"
    - "Windows config has NO signtoolOptions / NO azureSignOptions per RESEARCH §Resolved Q2 (ship unsigned v1)"
    - "appId remains placeholder `app.sei.placeholder` until checkpoint task lands the user-decided reverse-DNS form"
    - "`npm run build` (electron-vite build) produces dist/main, dist/preload, dist/renderer artifacts without errors"
  artifacts:
    - path: electron-builder.yml
      provides: "Final packaging config with mac entitlements + hardenedRuntime + DMG + NSIS + AppImage targets"
    - path: build/entitlements.mac.plist
      provides: "Hardened runtime entitlements for macOS notarization"
  key_links:
    - from: electron-builder.yml
      to: build/entitlements.mac.plist
      via: "mac.entitlements + mac.entitlementsInherit fields"
      pattern: "build/entitlements.mac.plist"
---

<objective>
Flesh out the packaging config and run a `npm run build` smoke test to confirm electron-vite produces clean artifacts. Insert the [BLOCKING] "lock identifiers" checkpoint that the user must resolve (with their final reverse-DNS appId choice) before any signed `dist:mac` build runs.

Purpose: PKG-01 (.dmg / .exe / AppImage builds), PKG-02 (postinstall hook already shipped in plan 01). Plan 11 takes the resulting packaged builds to clean VMs.

Output: Updated `electron-builder.yml`, new `build/entitlements.mac.plist`, package.json verification. One BLOCKING checkpoint task for the user to lock the appId.
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
@electron-builder.yml
@package.json

<interfaces>
From plan 01 stub electron-builder.yml: appId=`app.sei.placeholder`, asarUnpack=`src/bot/**/*`, mac/win/linux target stubs (no signing config yet), `# TODO(lock-before-signing)` marker.
From RESEARCH §Code Examples §3 (lines 738–805): full mac/dmg/win/nsis/linux config.
From RESEARCH §Code Examples §4 (lines 806–824): build/entitlements.mac.plist exact contents.
From RESEARCH §Resolved Q1: appId stays placeholder until BLOCKING task.
From RESEARCH §Resolved Q2: Windows ships UNSIGNED v1 — NO signtoolOptions / NO azureSignOptions.
From RESEARCH §Resolved Q3: CI build LOCAL-ONLY for v1 — `npm run dist:mac` / `dist:win` / `dist:linux` are the release procedure.
</interfaces>

<key_locked_decisions>
- D-60: macOS .dmg universal (arm64+x64), Hardened Runtime, signed + notarized. Linux AppImage unsigned best-effort.
- D-61: `electron-builder install-app-deps` postinstall (set in plan 01).
- D-62: Code-signing certs are external prereq (user is pursuing).
- D-63: Auto-update OUT of scope.
- RESEARCH §Resolved Q1: appId DEFERRED → BLOCKING task here (this plan).
- RESEARCH §Resolved Q2: Windows UNSIGNED v1 — NO signing blocks in electron-builder.yml.
- RESEARCH §Resolved Q3: LOCAL-ONLY CI for v1.
- Pitfall 1: asarUnpack `src/bot/**/*` (already in stub).
- Pitfall 8: macOS identity must be `Developer ID Application: <Name> (TEAM_ID)` (set this in builder.yml as a placeholder; user fills before signing).
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Flesh out electron-builder.yml + create build/entitlements.mac.plist + smoke `npm run build`</name>
  <read_first>
    - electron-builder.yml (current stub from plan 01)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §3 + §4" (lines 738–824)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Pitfall 8" (mac identity)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Resolved Q1, Q2, Q3"
    - .planning/phases/04-electron-gui-packaging/04-CONTEXT.md D-60..D-63
    - package.json (existing scripts and main field)
  </read_first>
  <behavior>
    - `electron-builder.yml` keeps the placeholder appId (TODO comment intact) but adds: `productName`, `directories`, full `files` glob, `asar`/`asarUnpack`, mac block (category, target dmg universal, hardenedRuntime, gatekeeperAssess: false, identity placeholder, notarize: true, entitlements + entitlementsInherit referencing `build/entitlements.mac.plist`), dmg block (sign:false), win block (target nsis x64, **no signing options**), nsis block (oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true), linux block (AppImage + category Game). NO `publish` block (auto-update deferred per D-63).
    - `build/entitlements.mac.plist` matches RESEARCH §Code Examples §4 verbatim.
    - `npm run build` succeeds (compiles main, preload, renderer; emits dist/).
    - Do NOT run `npm run dist:mac` (that requires signing certs the user is still acquiring).
  </behavior>
  <action>
**Step 1.** Replace `electron-builder.yml` content. Current stub gets extended; preserve the placeholder appId + TODO comment.

```yml
# electron-builder.yml — Phase 4 final.
# Source: .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §3 + §4"
#         + §"Resolved During Plan-Phase" Q1, Q2, Q3.
#
# BLOCKING: appId below is a PLACEHOLDER. Plan 04-10 task 2 is a [BLOCKING]
# checkpoint that requires the user to lock the final reverse-DNS form
# (e.g., gg.sei.app / studio.sei.app / bot.sei.app). Once shipped, changing
# this strands all existing safeStorage Keychain entries.

# TODO(lock-before-signing) — chosen by user in plan 04-10 task 2 BLOCKING checkpoint
appId: app.sei.placeholder
productName: Sei
copyright: Copyright (c) 2026 Sei

directories:
  output: release
  buildResources: build

files:
  - dist/**/*
  - package.json
  - "!**/node_modules/*/{test,tests,__tests__,*.md,*.markdown,LICENSE*,license*}"
  - "!**/*.map"

asar: true
asarUnpack:
  - "src/bot/**/*"

mac:
  category: public.app-category.games
  target:
    - target: dmg
      arch: [universal]
  hardenedRuntime: true
  gatekeeperAssess: false
  # TODO(lock-before-signing) — set to user's actual Apple Developer identity:
  # identity: "Developer ID Application: <Name> (TEAM_ID)"
  notarize: true            # electron-builder ≥26 uses notarytool natively when APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD env vars are set
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist

dmg:
  sign: false               # default since electron-builder 20.43.0
  contents:
    - x: 410
      y: 220
      type: link
      path: /Applications
    - x: 130
      y: 220
      type: file

win:
  target:
    - target: nsis
      arch: [x64]
  # NO signtoolOptions / NO azureSignOptions per RESEARCH §Resolved Q2 (ship unsigned v1).
  # SmartScreen "unknown publisher" warning is accepted UX for v1; documented in plan 11 release notes.

nsis:
  oneClick: false                          # show Welcome / Choose Path
  perMachine: false                        # per-user install — no admin prompt
  allowToChangeInstallationDirectory: true

linux:
  target:
    - AppImage
  category: Game
  # AppImage is best-effort unsigned per D-60.

# DO NOT add publish: auto-update is OUT of scope per D-63.
```

**Step 2.** Create `build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- V8 JIT — required by Electron's Chromium runtime -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>

  <!-- Anthropic API + Minecraft TCP connect -->
  <key>com.apple.security.network.client</key>
  <true/>

  <!-- LAN multicast watcher (UDP receive bound to 0.0.0.0:4445) -->
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
```

(Source: RESEARCH §Code Examples §4 verbatim.)

**Step 3.** Run a build smoke test. The command `npm run build` runs `electron-vite build`, which compiles main + preload + renderer to `dist/`. This must succeed on the developer machine before plan 11 can do clean-VM smoke.

```bash
npm run build
```

Expected output: `dist/main/index.js`, `dist/preload/index.js`, `dist/renderer/index.html` + assets. Any errors here MUST be fixed before this task completes (most likely cause: missing tsconfig path mapping, unresolved imports, or missing renderer entry — all should be addressed in plans 02–08).

If `npm run build` fails, capture the error output, fix the root cause, and re-run. Do NOT proceed if the build is broken.

After successful build, verify:
```bash
test -d dist/main && test -f dist/main/index.js
test -d dist/preload && test -f dist/preload/index.js
test -d dist/renderer && test -f dist/renderer/index.html
```

Do NOT run `npm run dist:mac` / `dist:win` / `dist:linux` here — those require signing certs the user is still acquiring + they're tested in plan 11 on clean VMs.
  </action>
  <verify>
    <automated>bash -c 'test -f electron-builder.yml && test -f build/entitlements.mac.plist && grep -q "^appId: app.sei.placeholder" electron-builder.yml && grep -q "# TODO(lock-before-signing)" electron-builder.yml && grep -q "hardenedRuntime: true" electron-builder.yml && grep -q "notarize: true" electron-builder.yml && grep -q "entitlements: build/entitlements.mac.plist" electron-builder.yml && grep -q "entitlementsInherit: build/entitlements.mac.plist" electron-builder.yml && grep -q "arch: \\[universal\\]" electron-builder.yml && grep -q "AppImage" electron-builder.yml && grep -q "perMachine: false" electron-builder.yml && grep -q "allowToChangeInstallationDirectory: true" electron-builder.yml && ! grep -q "signtoolOptions:" electron-builder.yml && ! grep -q "azureSignOptions:" electron-builder.yml && ! grep -q "^publish:" electron-builder.yml && grep -q "com.apple.security.cs.allow-jit" build/entitlements.mac.plist && grep -q "com.apple.security.network.client" build/entitlements.mac.plist && grep -q "com.apple.security.network.server" build/entitlements.mac.plist && npm run build 2>&1 | tail -30 | grep -q "build successful\\|completed\\|✓" && test -f dist/main/index.js && test -f dist/preload/index.js && test -f dist/renderer/index.html'</automated>
  </verify>
  <acceptance_criteria>
    - `electron-builder.yml` line `appId: app.sei.placeholder` still present
    - File contains `# TODO(lock-before-signing)` (preserved from stub)
    - File contains `hardenedRuntime: true`, `notarize: true`, `entitlements: build/entitlements.mac.plist`, `entitlementsInherit: build/entitlements.mac.plist`
    - mac block has `arch: [universal]`
    - File does NOT contain `signtoolOptions:` or `azureSignOptions:` (RESEARCH Q2)
    - File does NOT contain a `publish:` top-level key (D-63 — auto-update deferred)
    - File contains `AppImage`, `perMachine: false`, `allowToChangeInstallationDirectory: true`
    - `build/entitlements.mac.plist` exists
    - File contains all 4 entitlement keys: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.network.client`, `com.apple.security.network.server`
    - `npm run build` exits 0
    - `dist/main/index.js`, `dist/preload/index.js`, `dist/renderer/index.html` all exist after build
  </acceptance_criteria>
  <done>Packaging config complete. Build pipeline verified end-to-end. Ready for plan 11 clean-VM smoke (after the BLOCKING task below).</done>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 2: [BLOCKING] User locks final appId before any signed dist:mac build</name>
  <what-built>
    Plan 01–10 have built the entire Electron app + packaging config. The `electron-builder.yml` `appId:` is currently the placeholder `app.sei.placeholder`. This is the LAST chance to change it before the first signed release strands all existing safeStorage Keychain entries (RESEARCH §Resolved Q1: "Once shipped, changing this strands all existing users' safeStorage entries — pick once.").

    BLOCKING because:
    1. The user controls the domain and naming choice — Claude cannot pick a reverse-DNS form for them.
    2. Once `dist:mac` produces a signed/notarized build with one appId, the macOS Keychain entries created by safeStorage on first install are bound to that bundle. Changing appId later means existing users lose access to their saved API key on update.
    3. Apple Developer cert + Apple App-Specific Password (or App Store Connect API key) — the user's parallel todo per STATE.md — must be in place before notarize:true succeeds. Surfacing here so the user has a clear "ready to sign?" gate.
  </what-built>
  <how-to-verify>
1. Decide the final reverse-DNS appId. Common choices given the project name "Sei":
   - `gg.sei.app` (if user owns sei.gg)
   - `studio.sei.app` (if user owns sei.studio)
   - `bot.sei.app`
   - `app.sei.io` / `com.sei.app` / etc.
   - Match it to a domain you control or plan to. Apple Developer ID does NOT require domain ownership but using one you control is conventional and prevents collision.

2. Edit `electron-builder.yml` and replace `appId: app.sei.placeholder` with your chosen value. Remove the `# TODO(lock-before-signing)` comment line.

3. Edit `electron-builder.yml` and uncomment + populate the mac identity line:
   ```yml
   mac:
     # ...
     identity: "Developer ID Application: <Your Name> (<TEAM_ID>)"
   ```
   Get TEAM_ID from your Apple Developer account → Membership tab. The identity string MUST match the Common Name of the Developer ID Application certificate in your Keychain Access.

4. Confirm Apple Developer cert is installed in your local Keychain:
   ```
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   Should list at least one identity. If empty, you need to download the cert from developer.apple.com and import it.

5. Set notarization environment variables (one of these two methods):
   - **App-specific password method:** Set `APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=<TEAM_ID>` in your shell before running dist:mac.
   - **App Store Connect API key method:** Set `APPLE_API_KEY=/path/to/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=<UUID>`.

6. Test-build (do NOT release):
   ```
   npm run dist:mac
   ```
   Expected: `release/Sei-<version>-universal.dmg` produced; build log shows successful sign + notarize ticket stapled. Failure modes:
   - "Code signing identity not found" → step 3 / step 4 issue.
   - "Notarization failed" → step 5 issue (env vars or app-specific password expired).

7. Mount the .dmg, install Sei to /Applications, launch. Verify the OS shows it as a known publisher (Gatekeeper allows without right-click → Open).

8. Once the test build succeeds, commit `electron-builder.yml` with the locked appId.
  </how-to-verify>
  <resume-signal>Type "appId locked: <your-chosen-appId>" or describe issues encountered.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| local-build → end-user machine | Signed/notarized .dmg crosses Gatekeeper trust boundary; appId binds Keychain entries. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-40 | Spoofing | unsigned .dmg masquerading as Sei on user's machine | mitigate | Hardened runtime + notarization + Developer ID Application signing. Once Task 2 BLOCKING resolves with the user's identity, signed builds are tamper-evident. |
| T-04-41 | Tampering | future appId change strands all existing API keys | mitigate (deferred) | Task 2 BLOCKING ensures user picks once, before first release. After release, changing appId is treated as an irreversible breaking change in release notes. |
| T-04-42 | Elevation of Privilege | Hardened Runtime entitlements too permissive | mitigate | Only the four required entitlements granted (allow-jit + allow-unsigned-executable-memory for V8; network.client + network.server for Anthropic + LAN multicast). No file-system, no microphone, no camera, no AppleEvents. |
| T-04-43 | Repudiation | unsigned Windows build flagged by SmartScreen | accept | Per RESEARCH Q2, Windows ships UNSIGNED v1; documented in plan 11 release notes. Future phase ships Windows signing. |
</threat_model>

<verification>
- `electron-builder.yml` validates against electron-builder schema (run `npx electron-builder --help` — if config is malformed, this command surfaces issues; for full validation, `npm run dist:mac --dry-run` if available)
- `build/entitlements.mac.plist` validates as plist: `plutil -lint build/entitlements.mac.plist`
- `npm run build` exits 0 with dist artifacts present
- After Task 2 BLOCKING resolves: `npm run dist:mac` produces a signed .dmg + notarized ticket
</verification>

<success_criteria>
- Plan 11 (clean-VM smoke) takes the resulting .dmg / .exe / AppImage to clean macOS / Windows / Linux VMs and validates first-launch UX.
- After this plan + Task 2 resolution, the project ships its first installable artifact.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-10-SUMMARY.md` documenting:
- The final appId chosen (after Task 2 resolves)
- The exact `mac.identity` value
- Whether `npm run dist:mac` was test-built locally (and for which architecture)
- Note for plan 11 executor: bring the .dmg to a clean macOS VM (parallels/utm/cloud), bring the .exe to a clean Windows VM, bring the AppImage to a clean Ubuntu VM. Record the SmartScreen UX on Windows for the release notes (per RESEARCH Q2).
</output>
