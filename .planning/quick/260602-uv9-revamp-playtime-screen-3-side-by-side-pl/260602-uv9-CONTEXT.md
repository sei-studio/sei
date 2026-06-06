# Quick Task 260602-uv9: Revamp Playtime screen — plan cards, prices, no-refunds, in-app checkout - Context

**Gathered:** 2026-06-03
**Status:** Ready for planning

<domain>
## Task Boundary

Revamp the in-app **Playtime / Credits** surface (`src/renderer/src/screens/CreditsScreen.tsx`) and the usage/refund policies that back it:

1. Remove the "depleted" text from the user-facing UI.
2. Give the **unused** portion of the usage bar a distinct color so it reads against the page background.
3. Replace the stacked individual Quest/Party sections with a single **"Plans"** section containing **three side-by-side cards: Trial, Quest, Party**.
4. Each card leads with the plan name, then a **big money number**, then a **small "~X hours of playtime"** line, then a **buy button** that opens the Polar checkout.
5. Remove the **refund** option everywhere — no refunds ever. "Cancel anytime" means autorenewal stops at end of the current period.
6. Move the **Manage billing** button to the **bottom**, after the plan cards. Add a small disclaimer that playtime is only an estimate and varies by usage.

This reverses the prior **PROXY-05** "no dollar amounts / percent-only" bright-line for this screen — that is an explicit, intentional user override (see Decisions).
</domain>

<decisions>
## Implementation Decisions

### Checkout UX — in-app popup window (user-selected)
- Buy buttons (Quest, Party) open the Polar checkout **inside an Electron popup `BrowserWindow`**, not the system browser.
- The proxy still mints the checkout URL (`proxyClient.openCheckout(kind)` → returns a `buy.polar.sh` / `*.polar.sh` URL). Reuse the existing **`externalUrlValidator` allowlist** to validate the URL BEFORE loading it into the popup — do not relax the allowlist.
- Harden the popup `webContents`: `contextIsolation: true`, `nodeIntegration: false`, no `preload`, block in-popup `window.open`, and constrain navigation to the validated Polar origin (deny navigation off the allowlisted host). The main window stays untouched.
- The Party (subscription) buy button MUST still pass through the **`AutoRenewalConsentModal`** consent gate before opening checkout (CA ARL §17602(b) — legally required; do not remove). The Quest (one-time pack) button opens checkout directly (no auto-renewal, no consent gate).
- Close behavior: the popup can be closed manually; balance refresh continues to flow through the existing webhook → `onCreditsStatusUpdate` push (no special success-detection wiring required, though closing the popup may trigger a `refresh()` for snappier UX — implementer's discretion).
- Keep the IPC contract surface minimal — the open-popup logic lives in the **main process** (it owns `BrowserWindow`); the renderer keeps calling through `useCreditsStore.openCheckout(kind)` → `sei.creditsOpenCheckout`.

### Policy scope — GUI + website legal docs + DB/edge audit (user-selected)
- **GUI (this repo):** drop the "14-day refund on unused credits" line from `PreCtaDisclosure.tsx` (keep the three CA-required lines: price, auto-renew, cancel-in-settings). Update any other in-app copy that references refunds.
- **Website legal (`/Users/ouen/slop/sei-website`):** rewrite `terms.html` §8 "Refunds and Cancellations" to a **no-refund** clause (all sales final; cancellation stops autorenewal at end of the current paid period, non-prorated). NOTE: `sei-website` is **NOT a git repo on this machine** — edits land as persistent filesystem mods that the operator deploys separately (same workflow deviation as quick 13-22 / 12-15). The sei-repo commit covers `legalVersions.ts` only.
- **Version bump:** bump `src/shared/legalVersions.ts` `TOS_VERSION` (and co-bump `PRIVACY_VERSION` only if `privacy.html` is also touched — otherwise leave privacy alone) so users re-accept the updated terms via the existing `AcceptToSModal` cycle. Keep the website `terms.html` "Effective Date" in sync with the new `TOS_VERSION`.
- **DB / Edge audit (user explicitly added "any potential database changes"):** audit the Polar billing path for refund logic that contradicts "no refunds": review `supabase/functions/polar-webhook` and `apply_polar_event` (migration `20260602000000`) for any refund/clawback event handling, and confirm subscription cancel is **end-of-period (cancel-at-period-end), non-prorated** (the migration already maps `cancel_eop → 'cancelled'`). If a refund-clawback code path exists, decide deliberately whether to neutralize it; if none exists, record that no DB migration is needed. Do NOT invent a new migration unless the audit surfaces a concrete contradiction — prefer a documented "no DB change required" finding.

### Playtime numbers — recalibrate estimator to marketing hours (user-selected)
- Card labels (static marketing copy): **Trial ~1 hour, Quest ~5 hours, Party ~20 hours**.
- Recalibrate `src/renderer/src/lib/playtimeEstimate.ts` so the **live "~Xh left" estimate on a full grant** lands on those numbers. Math (blended `MICRO_PER_TOKEN = 2`, so tokens = `credits_micro / 2`):
  - Trial $1 → 1,000,000 µ$ → 500,000 tokens
  - Quest $3.825 grant → 3,825,000 µ$ → 1,912,500 tokens
  - Party $16.65 grant → 16,650,000 µ$ → 8,325,000 tokens
- A single flat `tokens/min` with the current **floor**-to-hour rounding CANNOT hit both Quest=5h and Party=20h (the grant ratio is ~4.35, not 4). To match marketing, **switch the ≥60min branch from floor to round-to-nearest hour** and set `DEFAULT_TOKENS_PER_MIN ≈ 6800`:
  - Trial: 500,000 / 6800 = 73.5 min → 1.22h → **~1h** ✓
  - Quest: 1,912,500 / 6800 = 281 min → 4.69h → **~5h** ✓
  - Party: 8,325,000 / 6800 = 1224 min → 20.4h → **~20h** ✓
- This intentionally relaxes the prior "aggressive DOWN-rounding, never overpromise" rule in favor of marketing alignment (user directive). Keep the sub-hour behavior honest (still floor/down for <60min so we don't overpromise small remainders). Update `playtimeEstimate.test.ts` to the new constant + rounding.
- The implementer may fine-tune the exact constant within the overlap window (≈6768–7083 tok/min) so both Quest rounds to 5 and Party rounds to 20; 6800 is the recommended anchor.

### PROXY-05 override (explicit user reversal)
- Showing real dollar amounts ($0 / $5.00 one-time / $20.00 per month) and "~X hours" on the plan cards is an **intentional reversal** of PROXY-05 for this screen. Update the file-header docstrings in `CreditsScreen.tsx` / `CreditsScreen.module.css` that assert "NO monetary amounts" so they reflect the new intent (don't leave contradictory comments). The PROXY-05 percent-only rule still governs the IPC/store state shape (`useCreditsStore` must still carry NO token/dollar/micro fields — `usage_pct` / `remaining_pct` / `remaining_tokens` stay as-is) — only the *rendered card copy* changes.

### Claude's Discretion
- **"Plans" section + three side-by-side cards:** one `<section>` titled `PLANS` containing a flex/grid row of three cards. At ~720px max-width that's ~3×226px — implementer chooses flex vs grid and responsive wrap. Card body order per the explicit layout spec: **plan name → big money number → small "~X hours" line → buy button** (this supersedes the looser "lead with ~x hours" phrasing in the request).
- **Card prices:** Trial = "Free" (no money number, or "$0"); Quest = "$5.00" with a small "one time" qualifier; Party = "$20.00" with a small "/month" qualifier.
- **Trial card button:** Trial is auto-claimed (free, keyed to mc_username) — it has NO Polar checkout. The Trial card's CTA should be a non-checkout affordance (e.g. "Current plan" / "Included" / disabled), reflecting current-plan state where known. Only Quest/Party buttons open checkout popups.
- **Remove "depleted" text:** drop the literal `'Depleted'` label from `PLAN_LABEL` and anywhere else user-visible (grep `depleted` / `Depleted` in `src/renderer`); replace the `plan==='depleted'` display with a neutral, non-alarming label (e.g. "Trial" fallback, "No active plan", or omit the plan label) — do NOT show the word "Depleted". The internal `'depleted'` enum value stays (used by store/IPC contract); only the displayed string changes.
- **Usage-bar unused color:** give the `PercentBar` track (`.root` in `PercentBar.module.css`, currently `var(--bg-2)`) a distinct fill/border so the unused portion is visibly separate from the page background in both themes. Prefer existing theme tokens; if `--bg-2` already differs from page bg, add a subtle `1px var(--border)` outline + a slightly stronger track tone. Keep it accessible (sufficient contrast, theme-aware, no raw hex).
- **Manage billing button:** a single button at the bottom (after the plan cards) labeled "Manage billing" (or "Manage billing or cancel"). Routes through the existing `handleManage()` → Polar customer-portal flow. Show it for everyone; for never-subscribed users the portal call no-ops gracefully (existing behavior). This replaces the per-card "Manage billing / Unsubscribe" link and the per-card subscriber Unsubscribe button — consolidate cancel into this one bottom button (cancel = stop autorenewal at period end, via the portal).
- **Estimate disclaimer:** small muted line at the very bottom: "Playtime shown is an estimate — actual playtime varies by usage." (reuse `ESTIMATE_TOOLTIP` wording/spirit from `UsageBar.tsx`).
</decisions>

<specifics>
## Specific Ideas

- Primary file: `src/renderer/src/screens/CreditsScreen.tsx` (+ `.module.css`).
- Supporting renderer: `components/UsageBar.tsx`, `components/PercentBar.module.css`, `components/PreCtaDisclosure.tsx`, `lib/playtimeEstimate.ts` (+ tests), `lib/stores/useCreditsStore.ts` (state shape unchanged — percent/token fields only).
- Main process (popup checkout): `src/main/ipc.ts` (`credits:openCheckout` handler), `src/main/cloud/proxyClient.ts` (`openCheckout`), `src/main/windowChrome.ts` / a new popup helper, `externalUrlValidator` allowlist (do not relax).
- Legal: `src/shared/legalVersions.ts` (TOS_VERSION bump), `/Users/ouen/slop/sei-website/terms.html` §8 (no-refund rewrite; filesystem edit, not committed in this repo).
- DB/Edge audit: `supabase/functions/polar-webhook/index.ts`, `apply_polar_event` in `supabase/migrations/20260602000000_polar_billing_migration.sql`.
- Known constants: Trial grant `TRIAL_CREDITS_MICRO = 1_000_000n` ($1); Quest grant 3,825,000 µ$; Party grant 16,650,000 µ$; blended `MICRO_PER_TOKEN = 2`.
</specifics>

<canonical_refs>
## Canonical References

- `.planning/POLAR-MIGRATION.md` — Polar pricing / unit economics / event→ledger mapping.
- `.planning/STATE.md` Decisions-To-Log 13-22 — original terms.html §8 Refunds insertion + legalVersions co-bump convention (this task reverses the refund clause).
- CA Bus & Prof Code §17602(a)(1)/(b) — pre-purchase auto-renewal disclosure + affirmative consent (PreCtaDisclosure + AutoRenewalConsentModal must remain).
- FTC 16 CFR §425 / Click-to-Cancel — online cancel path must exist without an email round-trip (the bottom Manage billing button satisfies this).
</canonical_refs>
</content>
</invoke>
