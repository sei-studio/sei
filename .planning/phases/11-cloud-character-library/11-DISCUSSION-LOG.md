# Phase 11: Cloud Character Library - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-21
**Phase:** 11-cloud-character-library
**Areas discussed:** Sync strategy & cache behavior, v0.1.1 migration UX, Character ID & dual-library UX, Legal gating + image validation

---

## Sync strategy & cache behavior

### Write order for create / edit (signed-in)

| Option | Description | Selected |
|--------|-------------|----------|
| Cloud-first, then cache | Spinner → write to Supabase → mirror to local on success → surface error if cloud fails | |
| Optimistic local, queued cloud sync | Write to local cache immediately → enqueue cloud sync → reconcile on success/conflict | |
| Cloud-only write, cache fills on read | Write to Supabase only → next listCharacters refreshes cache | |
| (Other / freeform) | **Local immediately. Public / private toggle in character creation for cloud upload.** | ✓ |

**User's choice:** Freeform — local-first write; cloud opt-in via public/private toggle.
**Notes:** Triggered a clarifying exchange about whether the toggle controls local-only-vs-cloud-backed or cloud-private-vs-cloud-public. User initially leaned toward a single `shared` flag model; later refined (see "How does a character first enter the cloud" below).

### Cache-on-demand vs eager

| Option | Description | Selected |
|--------|-------------|----------|
| Cache-on-demand | Sign-in lists cloud chars; only opened chars get cached | ✓ |
| Eager prefetch on sign-in | All cloud chars cached immediately at sign-in | |

**User's choice:** Cache-on-demand.
**Notes:** Preserves LIB-04 wording. Lighter on disk + egress.

### Reversibility of local→cloud promotion

| Option | Description | Selected |
|--------|-------------|----------|
| Reversible (cloud → local-only deletes Supabase data) | Toggle off cloud-backed → row + Storage deleted | |
| Non-reversible (cloud row persists, hidden only) | Toggle off = hide from Browse; cloud data remains | ✓ |

**User's choice:** Non-reversible. "private → public uploads to cloud, public → private just hides it from other users".
**Notes:** Drives D-16 / D-17. Made the final shape clear: a single `shared` flag, default `true` for signed-in users; toggling `false` hides without deleting.

### How does a character first enter the cloud in Phase 11?

| Option | Description | Selected |
|--------|-------------|----------|
| Signed-in creation defaults to cloud (two flags: cloud_backed + shared) | New chars cloud-backed by default; opt-out via "keep local-only" | |
| 'Make public' toggle ships in Phase 11 (single `shared` flag) | Phase 11 ships the toggle + upload path; Phase 12 wraps with moderation + Browse | |
| Cloud upload UI ships in Phase 12 only | Phase 11 = plumbing only; user-facing upload deferred | |
| (Other / freeform) | **Character page public/private toggle, public by default. Private = hidden on cloud. No local-only for signed-in users. Signed-out: private by default; sliding to public triggers sign-in prompt.** | ✓ |

**User's choice:** Freeform — collapsed to a single `shared` flag, default `true` for signed-in users; no local-only path for new signed-in chars; signed-out flow re-uses the SignInModal upgrade.
**Notes:** This was the keystone decision that simplified the whole model. D-15 / D-16 / D-17 in CONTEXT.md.

---

## v0.1.1 migration UX (LIB-03)

### When is migration offered?

| Option | Description | Selected |
|--------|-------------|----------|
| First sign-in only, modal blocks app | One-shot modal at first sign-in with per-char checkbox | |
| First sign-in, non-blocking banner | Dismissable banner at the top of Characters page | |
| Every sign-in until done or dismissed | Modal re-appears until migrated or "don't ask again" | |
| (Other / freeform) | **v0.1.1 has no users. Skip.** | ✓ |

**User's choice:** Skip — v0.1.1 has no real user base.
**Notes:** Forced a reinterpretation: the upload surface is still needed for v1.0 users who start in "Continue Locally" and later sign up. See next item. LIB-03's wording in REQUIREMENTS.md flagged for a follow-up edit (deferred idea).

### Local mode → sign-in transition for new v1.0 users

| Option | Description | Selected |
|--------|-------------|----------|
| Inline prompt at sign-in, pick which to upload | Per-char checkboxes; skipped chars stay as local files with "local only" chip | ✓ |
| Auto-upload everything, no prompt | Silent upload of all local chars as shared=true on first sign-in | |
| Local chars stay local; cloud library is separate | Dual-library Home UX with two sections | |

**User's choice:** Inline prompt at sign-in.
**Notes:** Drives D-20. Preserves the "local only" first-class-citizen invariant for skipped chars.

---

## Character ID & dual-library UX

### ID model

| Option | Description | Selected |
|--------|-------------|----------|
| UUID is the canonical ID | Files become `<uuid>.json` / `<uuid>.png`; defaults get hardcoded UUIDs | ✓ |
| Slug + owner_id composite | Local cache keeps slugs; cloud PK is (owner_id, slug) | |
| UUID for cloud-backed, slug for local-only | Two namespaces, file rename at promotion | |

**User's choice:** UUID is canonical.
**Notes:** Drives D-23. Clean cross-device + cross-user; no collisions. Requires slug→UUID rename of existing files at first launch.

### Schema mapping + bundled defaults

| Option | Description | Selected |
|--------|-------------|----------|
| Hardcoded UUIDs for bundled defaults + full row mirror | Every CharacterSchema field gets a column; defaults uploaded as regular cloud chars | |
| Bundled defaults stay local-only, never sync | is_default=true never uploads regardless of `shared`; user edits to defaults don't cross-device | |
| Cloud row holds only sync-essential fields | Smaller cloud rows; per-device playtime stats | |
| (Other / freeform) | **Option 1 BUT users cannot edit defaults; users can receive updates on existing defaults or new defaults.** | ✓ |

**User's choice:** Hybrid — full row mirror schema; defaults are read-only at the user level; defaults are updatable.
**Notes:** Drives D-22 + D-24. Read-only treatment of defaults requires extending the existing `'sui' is undeletable` rule. Triggered a follow-up question on update-delivery mechanism.

### How are default character updates delivered?

| Option | Description | Selected |
|--------|-------------|----------|
| App-update only | Defaults ship in defaultCharacters.ts + resources/skins/. Updating = new app release | ✓ |
| Cloud-fetched defaults table | Separate Supabase table; client polls at startup | |
| Hybrid: bundle ships, cloud overrides | Bundled baseline + optional cloud override | |

**User's choice:** App-update only.
**Notes:** Simplest. Cloud-fetched defaults table captured as a deferred idea.

---

## Legal gating + image validation

### Where ToS/PP content lives + how acceptance is recorded

| Option | Description | Selected |
|--------|-------------|----------|
| External URL + Supabase row records acceptance | Hosted statically; tos_acceptance table records who accepted what version | ✓ |
| Embedded in app + acceptance in Supabase row | Markdown in app bundle; updating requires app release | |
| External URL + acceptance recorded in UserConfig local-only | Per-device acceptance; no central record | |

**User's choice:** External URL + Supabase row.
**Notes:** Drives D-25 / D-27.

### When is acceptance prompted?

| Option | Description | Selected |
|--------|-------------|----------|
| At first cloud-write trigger | Modal on first create/promotion attempt | |
| Immediately on sign-up (not sign-in) | Checkbox embedded in signup form / OAuth first-callback | ✓ |
| On first sign-in (any time) | Modal on first auth callback | |

**User's choice:** At sign-up (not sign-in).
**Notes:** Drives D-26. For Phase 10 alpha accounts without acceptance, a blocking modal forces retroactive acceptance.

### Where should ToS/PP pages be hosted?

| Option | Description | Selected |
|--------|-------------|----------|
| GitHub Pages on a sei-legal repo | Free, version-controlled | |
| Supabase Edge Function returning HTML | In-stack; markdown rendered server-side | |
| Static page on the existing Sei marketing site | Cleaner branding; depends on marketing site existing | |
| (Other / freeform) | **Marketing site at ../sei-website (sibling repo, editable)** | ✓ |

**User's choice:** Sibling `sei-website` repo.
**Notes:** Drives D-25. Phase 11 plan must include edits to this repo (terms.html, privacy.html, footer links).

### Image validation rules

| Option | Description | Selected |
|--------|-------------|----------|
| Skin = existing 64×64 RGBA rule; portrait = PNG/JPEG/WebP, max 1024×1024, 500 KB | Reuses skinImageUtil; portrait downscaled client-side | ✓ |
| Tighter: portrait max 512×512, 200 KB | Better free-tier headroom; lower quality | |
| Looser: portrait max 2048×2048, 2 MB | Higher fidelity; faster quota exhaustion | |

**User's choice:** Recommended baseline.
**Notes:** Drives D-28. Server-side CSAM scan deferred to Phase 12.

### Skin storage model

| Option | Description | Selected |
|--------|-------------|----------|
| Always upload PNG bytes when source = upload/username; bundled = reference | Source-aware branching | |
| Upload bytes for all, even bundled | Uniform pattern, no branching | ✓ |
| Username-source: store Mojang username, re-fetch on cache miss | Smallest storage, external dep at open | |

**User's choice:** Upload bytes for all.
**Notes:** Drives D-29. Since bundled defaults never become cloud-backed (D-22), the uniformity applies to user-created cloud chars only.

---

## Claude's Discretion

The following were left to the planner / executor:

- CRUD architecture (direct supabase-js + RLS as the default; Edge Functions reserved for admin-privileged actions)
- Sync retry queue shape (likely persistent JSON queue in `<userData>/`)
- "local only" chip styling and migration modal copy
- Slug→UUID file rename mechanics (one-shot startup migration)
- Delete-character cascade (Storage cleanup + orphan reaper via existing `deletion_queue` cron pattern)
- Conflict resolution on stale local cache (last-write-wins + optional `.conflict` shadow file; full UX deferred)

## Deferred Ideas

- REQUIREMENTS.md wording fix for LIB-03 (one-line edit widening the migration scope from "v0.1.1 chars" to "pre-sign-up local-mode chars")
- Cloud-fetched defaults table (could enable default updates without app releases — Phase 1x candidate)
- Full conflict resolution UI for stale-cache scenarios (rare; defer to a v1.x phase if it materializes)
- Per-character `recommended_model` hint (already in REQUIREMENTS.md "Future Requirements")
- Retroactive moderation scan for Phase 11 → Phase 12 window (Phase 12 planner deliverable; flagged in D-30)
