---
phase: 12
plan: 17
status: complete
type: execute
wave: 4
completed: 2026-05-22
requirements_addressed: [SHARE-09]
---

# Plan 12-17 — openExternal allowlist extension

## What landed

Extended the `app:open-external` IPC handler allowlist in `src/main/ipc.ts:947-963` to permit the two URLs that `DmcaContactModal` (Plan 12-14) needs to open:

- `https://dmca.copyright.gov` — US Copyright Office DMCA Designated Agent Directory (the public listing surface published per SHARE-09 / D-35a)
- `mailto:dmca@sei.app` — direct email composition for users filing takedown notices

## Implementation

The handler was structured around a single `allowedHosts` array gated by `u.protocol !== 'https:'`. That structure couldn't admit `mailto:` URLs (different scheme, no host, payload lives in `pathname`).

The refactor introduces two side-by-side allowlists and ORs their predicates:

```ts
const allowedHttpsHosts = ['sei.gg', 'www.sei.gg', 'dmca.copyright.gov'];
const allowedMailto = ['dmca@sei.app'];
const isAllowedHttps = u.protocol === 'https:' && allowedHttpsHosts.includes(u.hostname);
const isAllowedMailto = u.protocol === 'mailto:' && allowedMailto.includes(u.pathname);
if (!isAllowedHttps && !isAllowedMailto) {
  throw new Error(`app:open-external rejected: ${url}`);
}
```

Notes:
- `URL.pathname` on a `mailto:` URL returns the bare address (e.g., `URL('mailto:dmca@sei.app').pathname === 'dmca@sei.app'`). The check is an exact-match against a one-element list so injection via `mailto:foo@bar?cc=dmca@sei.app` cannot bypass.
- Preserves the previous `https:`-only invariant for web URLs; the only new web host is `dmca.copyright.gov`.
- Inline JSDoc retitled `T-11-12-01 / T-12-17-01` so the next grep finds both ticket origins.

## Verification

- `npx tsc --noEmit -p tsconfig.web.json` — clean
- `npx tsc --noEmit -p tsconfig.node.json` — only the two pre-existing errors documented in `deferred-items.md` (`loopbackPkce.ts:83` flowType, `supabaseClient.test.ts:19` spread). Not introduced by this change.
- DmcaContactModal openExternal call sites at `src/renderer/src/components/DmcaContactModal.tsx:55,58` now route to the two newly-allowed URLs.

## Caller invariant

Future allowlist additions should follow the same two-list pattern. Adding a third scheme (e.g., `tel:`) means a third predicate `isAllowedTel`, not collapsing them into one list with conditional protocols.

## Notes

- Executed inline by the orchestrator after the executor agent was rate-limited; trivial one-handler change.
- No new tests added — the handler has no existing tests in the repo; adding test coverage is out of scope for this micro-plan.
- 12-14 declared `depends_on: [12-17]` but was invoked first; the modal compiles fine and only its two openExternal calls were no-ops until this plan landed.
