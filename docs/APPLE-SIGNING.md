# Apple code signing & notarization

v0.1 ships **unsigned**. macOS users will see a Gatekeeper warning the first
time they open the .dmg ("Sei.app can't be opened because Apple cannot check
it for malicious software") and must right-click → Open. To remove that
friction for v0.2+, follow this checklist.

Apple Developer account on file: **wangshawn369@gmail.com**.

## 1. Create the Developer ID Application certificate

1. Sign in to <https://developer.apple.com/account> with `wangshawn369@gmail.com`.
2. Membership tab → confirm "Apple Developer Program" is active. If not, enroll
   ($99/yr individual). Wait for approval before continuing.
3. **Certificates, IDs & Profiles** → **Certificates** → **+** (Create new).
4. Select **Developer ID Application** → Continue.
5. On your Mac: Keychain Access → Certificate Assistant → **Request a Certificate from a Certificate Authority…**
   - Email: `wangshawn369@gmail.com`
   - Common Name: `Sei Developer ID`
   - "Saved to disk" → save the `.certSigningRequest` file.
6. Upload the CSR back on the Apple page → download the resulting `.cer` file
   → double-click to install into the login keychain.
7. In Keychain Access, find "Developer ID Application: <Your Name> (TEAM_ID)".
   Right-click → Export → save as `developer-id.p12` with a strong password.
   Keep this file and the password — both are needed for CI.

## 2. Generate an app-specific password for notarytool

1. Sign in to <https://appleid.apple.com>.
2. **Sign-In and Security** → **App-Specific Passwords** → **+**.
3. Label it `Sei notarytool`. Save the generated password (e.g. `abcd-efgh-ijkl-mnop`).

You also need your **Team ID**: visit
<https://developer.apple.com/account#MembershipDetailsCard> and copy the 10-char
Team ID (e.g. `ABCDE12345`).

## 3. Wire secrets into GitHub Actions

In <https://github.com/sei-studio/sei/settings/secrets/actions>, add:

| Name | Value |
| --- | --- |
| `APPLE_ID` | `wangshawn369@gmail.com` |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 2 |
| `APPLE_TEAM_ID` | the 10-char Team ID |
| `CSC_LINK` | base64-encoded `developer-id.p12` (run `base64 -i developer-id.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | the p12 password from step 1 |

## 4. Flip the build config

Edit `electron-builder.yml`:

```yaml
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  identity: "Developer ID Application: <Your Name> (TEAM_ID)"   # was: identity: null
  notarize: true                                                # was: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
```

Edit `.github/workflows/release.yml` — replace the `env:` block under the Build
step with:

```yaml
env:
  CSC_LINK: ${{ secrets.CSC_LINK }}
  CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Remove the `CSC_IDENTITY_AUTO_DISCOVERY: false` line.

## 5. Verify locally before pushing a release tag

```bash
export CSC_LINK="$(base64 -i developer-id.p12)"
export CSC_KEY_PASSWORD='…'
export APPLE_ID='wangshawn369@gmail.com'
export APPLE_APP_SPECIFIC_PASSWORD='…'
export APPLE_TEAM_ID='…'
npm run dist:mac
# Wait for notarization to complete (5–15 min). The dmg should land in release/.
spctl -a -t open --context context:primary-signature -v release/Sei-mac-universal.dmg
# Expect: "release/Sei-mac-universal.dmg: accepted"
```

## Windows signing (deferred)

Windows ships unsigned for v0.1. Users will see a SmartScreen warning. To sign
later, buy an OV or EV code-signing cert (DigiCert / Sectigo, ~$200–400/yr),
then add `signtoolOptions` to the `win:` block in `electron-builder.yml`.
