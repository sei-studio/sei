---
quick_id: 260525-usc
type: quick
title: "Cluster I — Privacy policy + marketing rewrite scaffold"
cluster: I
mode: quick
created: 2026-05-25
files_modified:
  # sei-website (NOT git-tracked; filesystem mods only)
  - ../sei-website/privacy.html
  - ../sei-website/index.html
  - ../sei-website/terms.html
  - ../sei-website/build.html
  # sei repo (commits)
  - src/renderer/src/components/SignInModal.tsx
  - src/renderer/src/components/SignInModal.module.css
  - src/main/auth/authHandlers.ts
  - src/shared/ipc.ts
  - src/main/ipc.ts
  - supabase/functions/delete-me/index.ts
  - src/shared/legalVersions.ts
autonomous: true
requirements:
  - F-01  # marketing FAQ false-encryption claim
  - F-02  # marketing FAQ misleading privacy implication
  - F-03  # Subprocessor disclosure expansion (Anthropic, Fly, LS, OpenAI, SightEngine, Resend, Discord, Vercel, Mojang)
  - F-04  # Data-storage region disclosure
  - F-05  # Subprocessor disclosure (Vercel marketing site)
  - F-06  # Update-checker telemetry disclosure
  - F-07  # CCPA/CPRA section
  - F-08  # GDPR controller identity placeholder
  - F-09  # DPO / EU Art 27 rep placeholder
  - F-10  # COPPA DOB age gate
  - F-11  # "Do Not Sell or Share" footer link
  - F-12  # Per-category retention table
  - F-13  # International transfers safeguard
  - F-14  # Google Fonts disclosure (option b for v1.0)
  - F-15  # Account-deletion confirmation email
  - F-18  # Inbox unification note (privacy@sei.app placeholder)
  - F-19  # Subprocessor disclosure (Google Fonts CDN)
  - F-20  # Right-to-correct expansion

must_haves:
  truths:
    - "privacy.html §1 enumerates update-checker telemetry (F-06)"
    - "privacy.html §1 names the Data Controller as a VISIBLE placeholder (F-08)"
    - "privacy.html §1 names the EU Art 27 representative as a VISIBLE placeholder (F-09)"
    - "privacy.html §3 lists 11+ subprocessors with role + jurisdiction (F-03/F-05/F-19)"
    - "privacy.html §6 contains a per-category retention table (F-12)"
    - "privacy.html §7 carries COPPA under-13 deletion language (F-10)"
    - "privacy.html §8 names DPF + SCC transfer safeguards (F-13)"
    - "privacy.html §10 = California Privacy Rights with exact phrase 'Do Not Sell or Share' (F-07/F-11)"
    - "index.html FAQ 'Are my chats private' replaced with truthful answer (F-01/F-02)"
    - "index.html Schema.org FAQPage JSON-LD replaced with truthful answer (F-01/F-02)"
    - "All 4 marketing pages (index, build, terms, privacy) carry a 'Do Not Sell or Share' footer link (F-11)"
    - "Signup form requires DOB; computed age <13 rejected client-side AND server-side (F-10)"
    - "supabase/functions/delete-me sends a Resend confirmation email BEFORE auth.admin.deleteUser (F-15)"
    - "TOS_VERSION + PRIVACY_VERSION bumped to 2026-05-25 in src/shared/legalVersions.ts"
  artifacts:
    - path: "../sei-website/privacy.html"
      provides: "Full privacy policy rewrite — 11 substantive findings addressed"
      contains: "California Privacy Rights"
    - path: "../sei-website/index.html"
      provides: "FAQ truthful rewrite + Schema.org JSON-LD update"
      contains: "Do Not Sell or Share My Personal Information"
    - path: "src/renderer/src/components/SignInModal.tsx"
      provides: "DOB age gate (3-dropdown or single date input) on signup"
      contains: "date-of-birth"
    - path: "src/main/auth/authHandlers.ts"
      provides: "Server-side age <13 reject in signUpWithPassword"
      contains: "under_13"
    - path: "supabase/functions/delete-me/index.ts"
      provides: "Resend confirmation email BEFORE auth.admin.deleteUser"
      contains: "api.resend.com"
    - path: "src/shared/legalVersions.ts"
      provides: "Co-bumped TOS+PRIVACY versions to 2026-05-25"
      contains: "2026-05-25"
  key_links:
    - from: "src/renderer/src/components/SignInModal.tsx"
      to: "src/main/auth/authHandlers.ts:signUpWithPassword"
      via: "sei.signUpPassword IPC channel"
      pattern: "signUpPassword.*dob|date_of_birth"
    - from: "supabase/functions/delete-me/index.ts"
      to: "api.resend.com"
      via: "fetch BEFORE adminClient.auth.admin.deleteUser"
      pattern: "resend.*deleteUser|deleteUser.*resend"
    - from: "src/shared/legalVersions.ts"
      to: "../sei-website/privacy.html + ../sei-website/terms.html Effective Date"
      via: "AcceptToSModal blocking re-prompt on next launch"
      pattern: "2026-05-25"
---

<objective>
Cluster I — privacy-policy rewrite + marketing-FAQ truthification, with code-side scaffolding for COPPA age gate, deletion confirmation email, and version bump.

Purpose: Close 18 legal/marketing-truth findings flagged in the Cluster I audit — false encryption-at-rest claims in marketing copy, missing subprocessors, missing California rights, missing GDPR controller identity, missing COPPA gate, missing transfer safeguards, undisclosed update-checker telemetry, missing deletion confirmation, missing per-category retention.

Output:
- 4 sei-website filesystem mods (privacy.html full rewrite, index.html FAQ+JSON-LD fix, terms.html + build.html "Do Not Sell or Share" footer link)
- 5 sei-repo commits (DOB age gate UI, server-side age guard + IPC type, delete-me confirmation email, version bump, optional polish)
</objective>

<context>
@.planning/STATE.md
@./CLAUDE.md
@../sei-website/privacy.html
@../sei-website/index.html
@../sei-website/terms.html
@src/main/updateChecker.ts
@src/renderer/src/components/SignInModal.tsx
@src/main/auth/authHandlers.ts
@supabase/functions/delete-me/index.ts
@src/shared/legalVersions.ts
@src/shared/ipc.ts
@supabase/functions/notify-report/index.ts  # Resend call pattern (verified sender + 15s timeout)
@supabase/config.toml  # Supabase region disclosure (us-east-1 default)
@proxy/fly.toml  # Fly region disclosure (lax)
</context>

<tasks>

<task type="auto">
  <name>Task 1: privacy.html full rewrite (F-03/04/05/06/07/08/09/10-disclosure/11/12/13/18/19/20)</name>
  <files>../sei-website/privacy.html</files>
  <action>
    Full rewrite of /Users/ouen/slop/sei-website/privacy.html. Preserve existing CSS scaffolding (legal class, nav, footer scaffolding). New section structure:
      §1 What We Collect — add update-checker telemetry disclosure (F-06: sei.gg/version.json → Vercel; IP + UA). Add Data Controller placeholder block (F-08: "[LEGAL ENTITY NAME — TBD]") + EU Rep placeholder (F-09: "[EU REPRESENTATIVE — TBD, e.g. Prighter, EDPO]"). Add DPO note "Sei does not appoint a DPO under Art 37(1) at this scale; will publish here if status changes."
      §2 Why We Collect It — keep substance.
      §3 Third-Party Subprocessors — table-style list of 11+ processors with name, role, jurisdiction, transfer safeguard (F-03/F-05/F-19): Anthropic (LLM inference; US; DPF), Supabase (backend/auth/db/storage; AWS us-east-1; DPF), Fly.io (proxy; LAX US), Lemon Squeezy (MoR/payments; US; DPF), OpenAI (text moderation; US; DPF), SightEngine (image moderation; France/EU; GDPR-native), Resend (transactional email; US; DPF), Discord (operator notifications webhook only; US), Vercel (marketing-site hosting; US; DPF), Mojang/Microsoft (mc_username + skin lookup; api.mojang.com/sessionserver.mojang.com/textures.minecraft.net), Google (Google Fonts CDN; F-14 disclosure path — note "consider self-hosting in v1.1" in HTML comment).
      §4 What We Don't Do — keep.
      §5 Your Rights — keep access/portability/deletion/object; expand correction (F-20): "Edit any character in-app; change email via account settings; contact privacy@sei.app for any other correction request."
      §6 Data Retention — replace single paragraph with a per-category retention table (F-12) covering account creds, characters, memories (local-only), Lemon Squeezy payment records (7yr US tax), Fly/Vercel/Supabase server logs (~30d), Anthropic API logs (Anthropic-governed; ~30d), OpenAI moderation submissions (OpenAI-governed; ~30d), DMCA strike records (duration of repeat-infringer policy), session tokens (1h access / 90d refresh).
      §7 Children — REPLACE with COPPA disclosure (F-10 copy half): "Sei is not directed at children under 13. At signup we collect a date of birth solely to verify you are at least 13; we store only the year (or a derived boolean) and do not retain the full date. If you become aware that a child under 13 has registered, contact privacy@sei.app and we will delete the account within 30 days."
      §8 International Transfers — REPLACE (F-04/F-13) with concrete regions + DPF/SCC language: "Sei's Supabase project runs in AWS us-east-1 (United States). Sei's proxy runs on Fly.io in the LAX region (United States). Anthropic processes requests in the United States. For data leaving the EU/UK, Sei relies on the EU-US Data Privacy Framework where the processor is DPF-certified (Anthropic, Supabase, Lemon Squeezy, OpenAI, Resend, Vercel — verify current DPF list at dataprivacyframework.gov), and Standard Contractual Clauses (Module 2 or 3) otherwise. A current list of processors and their certifications is available on request."
      §9 Security — keep substantive content; drop "Cloud storage is encrypted at rest by Supabase" claim ONLY if it remains accurate (Supabase Storage is AES-256 at rest per their docs — keep, this is true; the false claim was specifically about cloud MEMORIES which don't exist).
      §10 California Privacy Rights — NEW SECTION (F-07/F-11): categories collected per Cal Civ Code §1798.140(v) (identifiers, customer records, commercial info, internet activity, professional info via mc_username), sources, third-party categories (link to §3), sensitive PI (account credentials + contents of communications under CPRA), right to limit SPI use (§1798.121), right to know/delete/correct/port/opt-out of automated decisionmaking, retention link (§6), EXACT statutory phrase "Do Not Sell or Share My Personal Information" with explicit "Sei does NOT sell or share PI for cross-context behavioral advertising", non-discrimination (§1798.125), authorized agent contact (privacy@sei.app or hello@sei.gg). Include anchor id="california" so footer links resolve.
      §11 Changes to This Policy — keep, version mechanism unchanged.
      §12 Contact — keep hello@sei.gg as primary; add note about privacy@sei.app placeholder (F-18): "For California rights requests and other privacy correspondence, you may also email [privacy@sei.app — TBD: operator to provision this inbox or route to hello@sei.gg]."
    Update Effective Date: 2026-05-25. Footer link "Do Not Sell or Share My Personal Information" appended to existing legal__footer.
    Preserve the existing trademark disclaimer paragraph. Preserve canonical link, fonts preconnect, font stylesheet link.
  </action>
  <verify>
    grep -c 'Do Not Sell or Share My Personal Information' /Users/ouen/slop/sei-website/privacy.html  # >= 2 (§10 + footer)
    grep -c 'EU REPRESENTATIVE — TBD' /Users/ouen/slop/sei-website/privacy.html  # == 1
    grep -c 'LEGAL ENTITY NAME — TBD' /Users/ouen/slop/sei-website/privacy.html  # >= 1
    grep -c 'id="california"' /Users/ouen/slop/sei-website/privacy.html  # == 1
    grep -c '2026-05-25' /Users/ouen/slop/sei-website/privacy.html  # >= 2 (effective + footer)
    grep -c 'Anthropic\|Supabase\|Fly.io\|Lemon Squeezy\|OpenAI\|SightEngine\|Resend\|Discord\|Vercel\|Mojang\|Google Fonts' /Users/ouen/slop/sei-website/privacy.html  # >= 11
    grep -c 'sei.gg/version.json' /Users/ouen/slop/sei-website/privacy.html  # == 1 (F-06)
    grep -c 'Data Privacy Framework\|DPF' /Users/ouen/slop/sei-website/privacy.html  # >= 2
    grep -c 'AWS us-east-1' /Users/ouen/slop/sei-website/privacy.html  # == 1 (F-04)
  </verify>
  <done>All grep gates pass. File renders cleanly (visually inspect §3 list, §6 table, §10 California section).</done>
</task>

<task type="auto">
  <name>Task 2: index.html FAQ + Schema.org JSON-LD truthful rewrite (F-01/F-02) + footer "Do Not Sell or Share" link (F-11)</name>
  <files>../sei-website/index.html</files>
  <action>
    Two surgical edits to /Users/ouen/slop/sei-website/index.html:
    (a) Replace the "Are my chats private?" FAQ answer (currently lines ~373-377):
        OLD: "Yes. On Free, nothing leaves your machine. You bring the model. On cloud tiers, your memories are encrypted at rest and never used to train models."
        NEW (split into two sentences for clarity inside the <div class="faq__a">):
          "On Free, Sei runs entirely on your machine — your API key, your model calls, nothing leaves your computer.
           On cloud tiers, your chat is forwarded to Anthropic (via our Fly.io proxy) so the model can reply, and when you publish a shared character, the persona text + portrait are scanned by OpenAI + SightEngine for moderation. Memories never leave your machine on any tier.
           See our <a href=\"/privacy.html\">Privacy Policy</a> for the full list of subprocessors."
    (b) Replace the corresponding Schema.org FAQPage JSON-LD answer (currently line ~135):
        OLD: "Yes. On the Free tier, nothing leaves your machine - you bring your own model. On cloud tiers, memories are encrypted at rest and never used to train models."
        NEW (one-line plain text — JSON-LD): "On the Free tier, Sei runs entirely on your machine - your API key, your model calls, nothing leaves your computer. On cloud tiers, your chat is forwarded to Anthropic via our Fly.io proxy to generate the response; when you publish a shared character, the persona text and portrait are scanned by OpenAI and SightEngine for moderation. Memories never leave your machine on any tier. See https://sei.gg/privacy.html for the full subprocessor list."
    (c) Footer "Do Not Sell or Share My Personal Information" link (F-11): add to the existing foot__base block (line ~439) immediately after the Privacy link:
        ` · <a href="/privacy.html#california">Do Not Sell or Share My Personal Information</a>`

    Do NOT touch other FAQ items, the hero, pricing tiers, or any other content.
  </action>
  <verify>
    grep -c 'encrypted at rest and never used to train' /Users/ouen/slop/sei-website/index.html  # == 0 (both removed)
    grep -c 'Do Not Sell or Share My Personal Information' /Users/ouen/slop/sei-website/index.html  # == 1
    grep -c 'Memories never leave your machine on any tier' /Users/ouen/slop/sei-website/index.html  # == 2 (FAQ + JSON-LD)
    grep -c 'Fly.io proxy' /Users/ouen/slop/sei-website/index.html  # >= 2 (FAQ HTML + JSON-LD)
    node -e "JSON.parse(require('fs').readFileSync('/Users/ouen/slop/sei-website/index.html','utf8').match(/<script type=\"application\/ld\+json\">([\s\S]*?)<\/script>/)[1])" && echo "JSON-LD valid"
  </verify>
  <done>All grep gates pass; JSON-LD parses without error.</done>
</task>

<task type="auto">
  <name>Task 3: terms.html + build.html footer "Do Not Sell or Share" link (F-11)</name>
  <files>../sei-website/terms.html, ../sei-website/build.html</files>
  <action>
    Add ` · <a href="/privacy.html#california">Do Not Sell or Share My Personal Information</a>` to:
    - /Users/ouen/slop/sei-website/terms.html — in legal__footer paragraph (line ~329 area: after `<a href="/">Home</a>`)
    - /Users/ouen/slop/sei-website/build.html — in foot__base paragraph (line ~215 area: after the `<a href="/privacy.html">Privacy</a>` link)
    Match the index.html pattern from Task 2 exactly so the link reads consistently.
    privacy.html already carries the link inline via Task 1's footer edit, so no additional change needed there.
  </action>
  <verify>
    grep -c 'Do Not Sell or Share My Personal Information' /Users/ouen/slop/sei-website/terms.html  # == 1
    grep -c 'Do Not Sell or Share My Personal Information' /Users/ouen/slop/sei-website/build.html  # == 1
  </verify>
  <done>Both pages carry the link; grep gates pass.</done>
</task>

<task type="auto">
  <name>Task 4: COPPA DOB age gate — SignInModal.tsx + authHandlers.ts + IPC type</name>
  <files>src/renderer/src/components/SignInModal.tsx, src/renderer/src/components/SignInModal.module.css, src/shared/ipc.ts, src/main/ipc.ts, src/main/auth/authHandlers.ts</files>
  <action>
    F-10 implementation.

    (a) src/shared/ipc.ts:
        - Extend signUpPassword args from `{ email; password }` to `{ email; password; dobYear: number; dobMonth: number; dobDay: number }`.
        - Extend SignUpResult `code` union: add `'under_13'` variant with copy.
        Existing `requiresVerification: true` shape unchanged.

    (b) src/main/ipc.ts: extend SignUpPasswordSchema to require dobYear (z.number().int().min(1900).max(<current year>)), dobMonth (1..12), dobDay (1..31). Pass through to signUpWithPassword.

    (c) src/main/auth/authHandlers.ts: signUpWithPassword — compute age from {dobYear, dobMonth, dobDay} via wall-clock today. If age < 13, return `{ ok: false, code: 'under_13', message: 'Sorry — Sei accounts require you to be at least 13 years old. (COPPA compliance.)' }` BEFORE the supabase.auth.signUp call. Do NOT log the DOB. Do NOT pass the DOB to Supabase (no PII expansion). Comment block explains: "we only store the boolean fact `age >= 13`; the DOB itself is never persisted (privacy minimization per F-10)."

    (d) src/renderer/src/components/SignInModal.tsx: in signup mode add a DOB block (three <select> dropdowns: month / day / year) ABOVE the ToS checkbox. Defaults: empty (placeholder option). Submit button additionally disabled when any DOB field is unset. On submit failure with `code: 'under_13'`, show the message inline (existing error path handles arbitrary message text). Years dropdown: 100 years back from current year (1926..2026) by default.

    (e) src/renderer/src/components/SignInModal.module.css: add `.dobRow { display: flex; gap: 8px; }` and `.dobSelect { flex: 1; }` (or analogous; match existing TextField sizing).

    Tests: update src/main/auth/authHandlers.test.ts (only if existing tests already cover signUpWithPassword positive paths — extend them with valid DOB args; add ONE new test for the under-13 reject). Ensure 395/395 vitest baseline preserved.
  </action>
  <verify>
    cd /Users/ouen/slop/sei && npx vitest run src/main/auth/authHandlers.test.ts 2>&1 | tail -20
    cd /Users/ouen/slop/sei && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10
    grep -c 'under_13' /Users/ouen/slop/sei/src/main/auth/authHandlers.ts  # >= 1
    grep -c 'dobYear\|dobMonth\|dobDay' /Users/ouen/slop/sei/src/shared/ipc.ts  # >= 3
    grep -c 'dobYear\|dobMonth\|dobDay' /Users/ouen/slop/sei/src/renderer/src/components/SignInModal.tsx  # >= 3
  </verify>
  <done>tsc clean; authHandlers vitest passes; greps confirm DOB plumbing reaches all 3 layers.</done>
</task>

<task type="auto">
  <name>Task 5: delete-me account-deletion confirmation email (F-15)</name>
  <files>supabase/functions/delete-me/index.ts</files>
  <action>
    F-15. In supabase/functions/delete-me/index.ts, BEFORE the `adminClient.auth.admin.deleteUser(userId)` call (currently line ~60), capture the user's email from `userData.user.email` (already in scope) and POST a confirmation email via Resend. Pattern mirrors notify-report/index.ts:247-280:
      - read RESEND_API_KEY from Deno.env (skip silently if absent — best-effort)
      - 15s AbortController timeout (CLAUDE.md every-external-call-has-a-timeout invariant; reuse the inline timedFetch pattern from notify-report OR wrap fetch in Promise.race with setTimeout)
      - from: 'Sei Account <noreply@sei.app>' (matches existing reports@sei.app verified-sender domain)
      - to: [userEmail]
      - subject: 'Your Sei account has been deleted'
      - text body: short confirmation that the account + all cloud rows + Storage objects associated are being purged; 30-day Storage purge timeline; contact privacy@sei.app (placeholder TBD) for questions.
    Email failure (network, missing key, non-2xx Resend response) MUST NOT block the deletion — log via console.error and continue to the auth.admin.deleteUser path. The email is best-effort; the deletion is mandatory.
    Order is critical: the email MUST send BEFORE auth.admin.deleteUser because the user.email is needed for the `to` field AND we cannot recover it after the row is gone.
  </action>
  <verify>
    grep -c 'api.resend.com' /Users/ouen/slop/sei/supabase/functions/delete-me/index.ts  # == 1
    awk '/api.resend.com/{r=NR}/auth.admin.deleteUser/{d=NR}END{print "resend:"r" delete:"d; if (r && d && r<d) print "ORDER OK"; else print "ORDER WRONG"}' /Users/ouen/slop/sei/supabase/functions/delete-me/index.ts
    cd /Users/ouen/slop/sei && deno check supabase/functions/delete-me/index.ts 2>&1 | tail -5 || true
  </verify>
  <done>Resend POST exists ABOVE the deleteUser call; deno check passes (or unchanged from baseline if deno not invoked).</done>
</task>

<task type="auto">
  <name>Task 6: Co-bump TOS_VERSION + PRIVACY_VERSION → 2026-05-25</name>
  <files>src/shared/legalVersions.ts</files>
  <action>
    Update src/shared/legalVersions.ts:
      TOS_VERSION = '2026-05-25'
      PRIVACY_VERSION = '2026-05-25'
    Per the project convention (Cluster G + I bundled into one AcceptToSModal cycle): both bump together so the user sees a single blocking re-prompt on next launch instead of two consecutive prompts.

    Also update the Effective Date line in /Users/ouen/slop/sei-website/terms.html from `Effective Date: 2026-05-26` → `Effective Date: 2026-05-25` (and the matching legal__footer instance) so terms.html and privacy.html share the same effective date AND match the TOS_VERSION constant. (The TOS body itself is unchanged in this Cluster — only the date stamp moves backward by one day to align with the privacy rewrite.)

    Wait — re-read STATE.md: terms.html was just bumped to 2026-05-26 in cluster 13-22. Per the operator convention the version constant must match the Effective Date in the HTML. So actually we bump BOTH constants to 2026-05-26 (matching the already-updated terms.html) AND set privacy.html Effective Date to 2026-05-26. Re-checking: the constraints block says "Bump PRIVACY_VERSION to today's date in src/shared/legalVersions.ts (co-bump TOS_VERSION too per convention)" — today is 2026-05-25. STATE.md last activity was 2026-05-26 (one-day-future drift — common in this project's STATE.md narrative). The constraints specify today (2026-05-25) explicitly. Resolution: bump both constants to 2026-05-25 AND update terms.html Effective Date from 2026-05-26 → 2026-05-25 to maintain the equality invariant.

    Net edits:
      - src/shared/legalVersions.ts: both constants → '2026-05-25'
      - ../sei-website/terms.html: Effective Date `2026-05-26` → `2026-05-25` (2 occurrences: line 54 + line 329 footer)
      - ../sei-website/privacy.html: Effective Date `2026-05-25` (already set in Task 1)
  </action>
  <verify>
    grep -c "'2026-05-25'" /Users/ouen/slop/sei/src/shared/legalVersions.ts  # == 2
    grep -c '2026-05-25' /Users/ouen/slop/sei-website/terms.html  # >= 2
    grep -c '2026-05-25' /Users/ouen/slop/sei-website/privacy.html  # >= 2
    grep -c '2026-05-26' /Users/ouen/slop/sei-website/terms.html  # == 0 (no stale date)
  </verify>
  <done>All four greps pass; both constants and both HTML pages aligned on 2026-05-25.</done>
</task>

<task type="auto">
  <name>Task 7: Verification — full vitest + tsc + deno baseline</name>
  <files>(no files modified)</files>
  <action>
    Run the project's regression baselines to confirm zero new failures introduced by Tasks 4-6:
    - cd /Users/ouen/slop/sei && npx vitest run 2>&1 | tail -5  (expect 395/395 baseline preserved + any new tests added in Task 4)
    - cd /Users/ouen/slop/sei && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5  (expect clean)
    - cd /Users/ouen/slop/sei && npx tsc --noEmit -p tsconfig.web.json 2>&1 | tail -5  (expect clean)
    If new failures appear, fix in the appropriate task file before committing.
  </action>
  <verify>vitest exit 0; tsc both projects exit 0</verify>
  <done>Baselines preserved.</done>
</task>

</tasks>

<commit_plan>
3 sei-repo commits (sei-website edits are NOT git-tracked — filesystem mods only, captured in SUMMARY):
1. `feat(260525-usc-1): COPPA DOB age gate at signup (F-10)` — Task 4 (SignInModal + authHandlers + IPC type)
2. `feat(260525-usc-2): delete-me confirmation email via Resend (F-15)` — Task 5
3. `feat(260525-usc-3): co-bump TOS+PRIVACY versions → 2026-05-25 (Cluster I + G bundle)` — Task 6

sei-website filesystem mods (no commit; surfaced in SUMMARY for the operator's separate deploy):
- privacy.html (full rewrite — Task 1)
- index.html (FAQ + JSON-LD + footer link — Task 2)
- terms.html (footer link + Effective Date stamp — Tasks 3, 6)
- build.html (footer link — Task 3)
</commit_plan>

<success_criteria>
- 11 substantive findings closed in privacy.html (F-03/04/05/06/07/08/09/11/12/13/19/20)
- 2 findings closed in index.html (F-01/F-02) and propagated to JSON-LD
- 1 finding closed across all 4 footer pages (F-11)
- F-10 COPPA gate ships end-to-end (UI + IPC type + server-side guard)
- F-15 deletion confirmation email ships before auth.admin.deleteUser
- F-14 disclosed in privacy.html §3 (self-host deferred to v1.1 TODO)
- F-18 privacy@sei.app placeholder visible in privacy.html §12
- Vitest baseline 395/395 preserved (+ any new tests added in Task 4)
- TypeScript clean in both tsconfig.json and tsconfig.web.json
- 3 atomic commits on dev branch
</success_criteria>

<output>
SUMMARY.md at /Users/ouen/slop/sei/.planning/quick/260525-usc-privacy-policy-marketing-rewrite-scaffol/260525-usc-SUMMARY.md listing:
- all 4 sei-website filesystem mods (operator deploys separately)
- all 3 sei-repo commit hashes
- per-finding closure status (F-01..F-20)
- regression test outcome (vitest + tsc + deno baselines)
- any deferred work (F-14 self-host TODO, F-18 inbox provisioning TODO, F-08/F-09 legal entity + EU rep TBD)
</output>
