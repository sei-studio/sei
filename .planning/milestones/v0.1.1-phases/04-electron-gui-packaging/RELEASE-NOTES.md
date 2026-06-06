# Sei v1.0 — Release Notes

**Released:** _PENDING — fill in on actual tag day_
**Tag:** `v1.0`

Sei is a Minecraft AI companion. This is the first packaged release — onboarding,
character creation, and live summon-to-LAN flows all work as a polished desktop
app instead of a developer CLI.

> **Pre-ship checklist (project-owner — do NOT ship until checked):**
>
> - [ ] Final reverse-DNS `appId` chosen (one of `gg.sei.app` / `studio.sei.app` /
>       `bot.sei.app`) and locked in `electron-builder.yml`. The `# TODO(lock-before-signing)`
>       comment removed. **This is permanent — see "Bundle ID is locked" below.**
> - [ ] `mac.identity` populated with `Developer ID Application: <Name> (<TEAM_ID>)`.
> - [ ] Notarization env vars exported (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
>       `APPLE_TEAM_ID`, _or_ `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`).
> - [ ] `npm run dist:mac` produced a signed + notarized `Sei-1.0.0-universal.dmg`.
> - [ ] `npm run dist:win` produced `Sei Setup 1.0.0.exe` (unsigned — see Windows section).
> - [ ] `npm run dist:linux` produced `Sei-1.0.0.AppImage`.
> - [ ] All three artifacts smoke-tested on clean VMs per plan 04-11 (PKG-03).
> - [ ] Replace placeholder strings below: `<the-locked-appId>`, `<your identity>`,
>       release date.

---

## Install

### macOS (.dmg, signed + notarized)

1. Download `Sei-1.0.0-universal.dmg`.
2. Double-click. The DMG mounts. Drag **Sei** into the **Applications** shortcut.
3. Launch Sei from Applications. macOS will briefly verify with Gatekeeper —
   no extra clicks needed because the build is notarized.

If macOS shows _"Sei is from an unidentified developer"_ on first launch (rare with
notarization but possible if the cert combo triggers a Gatekeeper edge case),
right-click **Sei** in Applications → **Open** → confirm **Open**. After once,
normal double-click works.

The macOS build is **universal** — it ships both Apple Silicon (`arm64`) and
Intel (`x64`) slices in one `.dmg`.

### Windows (.exe, **UNSIGNED in v1**)

1. Download `Sei Setup 1.0.0.exe`.
2. Double-click. **Windows SmartScreen will warn:**
   _"Windows protected your PC … Unknown publisher."_
3. Click **More info** → **Run anyway**.
4. The NSIS installer walks you through. Sei installs **per-user** — no admin
   prompt and no UAC elevation.
5. Launch Sei from the Start menu.

This is expected for v1. Sei ships unsigned on Windows for the first release; a
future maintenance release will add Authenticode signing once the company is
formed (see Roadmap).

### Linux (.AppImage, best-effort unsigned)

1. Download `Sei-1.0.0.AppImage`.
2. `chmod +x Sei-1.0.0.AppImage`
3. `./Sei-1.0.0.AppImage`

If your Linux desktop lacks `gnome-keyring` / `kwallet` / `libsecret`, Sei will
show a yellow banner at the top of the window:

> Your system has no secret store. Sei will save your API key but it won't be
> hardware-protected.

Internally this means `safeStorage.getSelectedStorageBackend() === 'basic_text'`
and the `KEYCHAIN_FALLBACK_PLAINTEXT` warning has been raised. The API key blob
in `~/.config/Sei/api_key.bin` is encrypted with a fallback hardcoded key —
effectively plaintext.

To fix: install `gnome-keyring` (Ubuntu Desktop has it by default) or `kwallet5`
on KDE, then restart Sei. It will pick up the protected store automatically on
next launch.

---

## What's in v1

- **Setup form:** Minecraft username, preferred name, provider (Anthropic only
  in v1 — others are visible but disabled), API key (stored via the OS keychain
  on macOS / DPAPI on Windows / libsecret on Linux).
- **Multi-character launcher:** create personas, summon them into your
  open-to-LAN world, see live logs streaming line-by-line.
- **LAN auto-detect:** Sei watches multicast (`224.0.2.60:4445`) for your LAN
  world; press **Summon** when ready. The cached port is handed straight to the
  bot — no re-discovery handshake on summon.
- **Personality engine:** single-Haiku LLM with reasoning + dispatch combined
  into one call. Closed action registry (Zod-typed); no LLM-generated code.
- **Per-character memory:** isolated memory directories at
  `<userData>/memory/<character-id>/` — different personas keep separate
  diaries / owner notes. (`<userData>` is `~/Library/Application Support/Sei`
  on macOS, `%APPDATA%\Sei` on Windows, `~/.config/Sei` on Linux.)
- **Light + dark themes**, with system-default on first run and a manual
  toggle in the sidebar rail.

---

## Known caveats

### Fresh install starts empty (no auto-migration from CLI)

If you previously used the `sei` CLI (which stored config in your dev clone's
`./config.json`), the GUI does **not** auto-detect or migrate that data. On
first launch you walk through onboarding from scratch. The CLI continues to
work from your dev clone for headless use.

This was a deliberate scope-control choice for v1. A future release may add a
one-shot "import from CLI" if there's demand.

### Windows shows "Unknown publisher" on first install

Per the install steps above. The SmartScreen warning is expected because the
v1 Windows binary is unsigned. Click **More info → Run anyway**.

This will go away in a future release once Authenticode signing is in place
(see Roadmap).

### LAN auto-detect requires same-network multicast

Sei watches multicast packets at `224.0.2.60:4445` to know when you've opened
a Minecraft world to LAN. If your network blocks or filters multicast, the
LAN status pill stays **NOT CONNECTED** even when Minecraft is open to LAN.
Common environments where this happens:

- **Virtual machines on default NAT** (VirtualBox NAT, Parallels Shared, UTM
  Shared). NAT does not bridge multicast across the host boundary. Switch the
  VM to a **bridged network adapter** if you need LAN auto-detect inside a VM.
- **Corporate / guest Wi-Fi** that disables peer-to-peer or multicast traffic.
- **Some VPN profiles** that route all LAN traffic through the tunnel.

There is **no manual port-override** in the UI by design — the cached LAN port
is required for a clean summon, and we'd rather fail closed than let users lie
their way to a port number that doesn't work.

If multicast is blocked but you really need to test, run Sei on a bare-metal
machine on the same physical LAN as the Minecraft host.

### Linux secret-store fallback is plaintext-equivalent

Already covered in the Linux install instructions above. To recap: if no
secret store is detected, your API key is encrypted with a fallback key that
ships with the application — treat it as plaintext for threat-modelling
purposes. The yellow banner says so. Install `gnome-keyring` or `kwallet` to
upgrade to OS-protected storage.

### Bundle ID is locked

The macOS bundle ID is `<the-locked-appId>`. On Windows, the corresponding
AppUserModelID derives from the same value. **This is permanent.** Changing it
in a future release would:

- Strand all existing users' macOS Keychain entries (their saved API key blob
  becomes unreadable because `safeStorage` keys it on bundle ID).
- Re-register the app in Launchpad / Start menu as if it were a different
  product.
- Break any future auto-update channel.

Treat the bundle ID as a permanent contract. If the project ever needs to
migrate, it must ship a one-shot migration that re-encrypts existing
`api_key.bin` blobs under the new identity before swapping the bundle ID.

### Auto-update not yet wired

Sei does not auto-update in v1. To get a new version: download the new
installer and re-run it. Auto-update via `electron-updater` is on the roadmap.

### Per-character memory does not hot-reload mid-summon

If you delete a character via the UI, their memory directory at
`<userData>/memory/<character-id>/` is removed. But if Sei is running and
currently connected as that character, deletion is refused — stop the bot
first. (Defense-in-depth: the main process gates this, the renderer also
gates it.)

### Edit-persona button is a placeholder in v1

The **Edit persona** button on a character page does not yet open an editor.
You can delete and re-create a character to change its persona. A real edit
flow lands in v1.x.

### Image-upload portrait override is procedural-only in v1

Pixel portraits are deterministically generated from `id + name`. The optional
"upload your own image" override is documented in the design but not wired in
v1. Coming in v1.x.

---

## Roadmap

- **v1.x** — Windows code-signing (Azure Trusted Signing or EV cert), removing
  the SmartScreen warning.
- **v1.x** — Auto-update via `electron-updater`.
- **v1.x** — Edit-persona flow on the character page.
- **v1.x** — Image-upload override for character portraits.
- **v2** — Vision (OS screenshot → Haiku 3.5).
- **v2** — Multi-character concurrent summons (one persona per world right now).

---

## Reporting issues

GitHub Issues / project page (link TBD). Logs are written to:

- macOS: `~/Library/Application Support/Sei/logs/<character-id>-<timestamp>.log`
- Windows: `%APPDATA%\Sei\logs\<character-id>-<timestamp>.log`
- Linux: `~/.config/Sei/logs/<character-id>-<timestamp>.log`

Include the relevant log file in any bug report. The live log viewer in the
character page also has a **Copy all** button — paste the output into the issue
if it's reproducible interactively.

---

## Build provenance

- **Built locally**, not via CI, per RESEARCH §"Resolved Q3" — local-only build
  pipeline for v1.
- **macOS:** signed with `<your identity>` and notarized via Apple's
  `notarytool` (electron-builder ≥26 invokes `notarytool` natively when
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` env vars are set). Hardened Runtime
  enabled with the four entitlements declared in `build/entitlements.mac.plist`
  (allow-jit, allow-unsigned-executable-memory, network.client, network.server).
- **Windows:** unsigned. SmartScreen warning is expected on first install.
- **Linux:** AppImage, unsigned. Best-effort.

Source: tag `v1.0` in the project repo. Phase 4 plans 01–11 produced this
build.
