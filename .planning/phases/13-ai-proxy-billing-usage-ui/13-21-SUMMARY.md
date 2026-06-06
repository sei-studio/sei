---
phase: 13
plan: 21
subsystem: main/ipc
tags: [main, openexternal, allowlist, security, lemonsqueezy]
one_liner: "Extends the openExternal IPC allowlist with sei.lemonsqueezy.com (exact-host match) so the 13-13 checkout + customer-portal flows survive the main-process URL gate."
requires:
  - "Phase 11 openExternal handler (sei.gg / www.sei.gg https allowlist)"
  - "Phase 12-17 additions (dmca.copyright.gov https + mailto:dmca@sei.app)"
  - "13-13 proxyClient.openCheckout / customerPortal (composes sei.lemonsqueezy.com URLs)"
provides:
  - "shell.openExternal can route to https://sei.lemonsqueezy.com/* (checkout + /billing customer-portal)"
  - "Threat-model comment block above the allowlist documenting per-phase rationale + exact-host guarantee"
affects:
  - "src/main/ipc.ts (app:open-external handler)"
tech_stack_added: []
patterns:
  - "Allowlist-as-defense-in-depth: proxyClient.ts already constructs sei.lemonsqueezy.com URLs in the main process, but the IPC gate is the chokepoint — adding the host here closes the loop without trusting any caller (13-PATTERNS §IPC handlers)."
  - "Exact-host match via Array.prototype.includes on a string array — NOT substring. Documented in the comment block so future maintainers don't 'optimise' it to a regex test."
key_files:
  modified:
    - "src/main/ipc.ts: extended allowedHttpsHosts array + expanded threat-model comment block above the openExternal handler."
  created: []
  deleted: []
decisions:
  - "Kept the allowlist as an inline `const` inside the handler closure (Phase 11 shape) rather than extracting to a module-level constant. Rationale: lazy-import discipline (12-PATTERNS §IPC handlers) keeps module-init cycles impossible; the allowlist has 4 entries, not 40, so refactor isn't justified."
  - "Did NOT add wildcard / subdomain handling. T-13-21-01 explicitly calls for exact-host match to defeat `evil.sei.lemonsqueezy.com.attacker.tld` substring attacks. If LS ever uses subdomains for checkout we will add each one as an explicit entry."
metrics:
  duration_minutes: 2
  tasks_completed: 1
  files_modified: 1
  files_created: 0
  completed: 2026-05-23
---

# Phase 13 Plan 21: openExternal Allowlist — Lemon Squeezy Summary

## One-Liner

Extends the openExternal IPC allowlist with `sei.lemonsqueezy.com` (exact-host match) so the 13-13 checkout + customer-portal flows survive the main-process URL gate.

## What Changed

**Single file modified:** `src/main/ipc.ts` — the `app:open-external` handler (around L961–L995).

### Before

```ts
const allowedHttpsHosts = ['sei.gg', 'www.sei.gg', 'dmca.copyright.gov'];
const allowedMailto = ['dmca@sei.app'];
```

### After

```ts
const allowedHttpsHosts = [
  'sei.gg',
  'www.sei.gg',
  'dmca.copyright.gov',
  'sei.lemonsqueezy.com', // Phase 13-21 — LS checkout + customer portal (PROXY-01/02).
];
const allowedMailto = ['dmca@sei.app'];
```

Plus a multi-paragraph threat-model comment block above the handler that:

1. Records the per-phase additions (11 → 12-17 → 13-21) with rationale for each host.
2. States explicitly that comparison is exact-equality (Array.prototype.includes on a string array, NOT substring) so `evil.sei.lemonsqueezy.com.attacker.tld` is rejected (T-13-21-01).
3. Notes the protocol gate (https / mailto only) is enforced separately so `javascript:` / `data:` / `file:` URLs that happen to parse with a matching `hostname` field are still rejected (T-13-21-03).

## Threat Model Coverage

| Threat ID  | Disposition | Status                                                                                                             |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| T-13-21-01 | mitigate    | DONE — exact-host match via `Array.prototype.includes` on a string array; documented in the comment block.         |
| T-13-21-02 | accept      | DOCUMENTED — LS is Merchant of Record; phishing risk on LS, not Sei.                                               |
| T-13-21-03 | mitigate    | DONE — pre-existing protocol gate (`u.protocol === 'https:'` / `'mailto:'`) restricts schemes; comment updated.    |
| T-13-21-04 | mitigate    | DONE — threat-model comment block above the allowlist warns future PRs that grep the file for "openExternal".      |

## Verification

- `grep -c "sei.lemonsqueezy.com" src/main/ipc.ts` returns `4` (one allowlist entry + three doc-comment mentions; the existing L1048 reference from 13-13's `openCheckout` comment is preserved).
- All four pre-existing entries (`sei.gg`, `www.sei.gg`, `dmca.copyright.gov`, `dmca@sei.app`) confirmed present at the expected lines.
- `npx tsc --noEmit` — clean exit, no output.
- No file deletions in the commit (`git diff --diff-filter=D --name-only HEAD~1 HEAD` empty).

## Success Criteria

- [x] Allowlist extended with `sei.lemonsqueezy.com`.
- [x] `shell.openExternal` from proxyClient.ts (13-13) no longer rejected.
- [x] Existing Phase 11/12 hosts preserved.

## Deviations from Plan

None — plan executed exactly as written. The "comment block above the allowlist" requested in Task 1 step 5 was integrated into the existing top-of-handler comment block rather than added as a separate block, because the existing block was already the threat-model anchor; keeping a single block avoids two-doc-comment drift on future additions. This is a cosmetic choice within the plan's spec, not a deviation.

## Commits

- `9d5ef09` — feat(13-21): add sei.lemonsqueezy.com to openExternal allowlist

## Self-Check: PASSED

- FOUND: src/main/ipc.ts (modified)
- FOUND: 9d5ef09 in `git log --oneline --all`
