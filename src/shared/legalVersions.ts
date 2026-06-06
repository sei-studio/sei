/**
 * Phase 11 — Versioned legal documents.
 *
 * Source: 11-CONTEXT D-27 (version bump → re-prompt via blocking modal) +
 *         11-RESEARCH §Pattern 7 (versioning strategy) +
 *         11-02-PLAN (terms.html + privacy.html date-stamped to this value).
 *
 * Bump these constants when the published legal text materially changes.
 * The next time a user signs in, tosGate.isTosAccepted() returns false
 * because the tos_acceptance row's tos_version/privacy_version no longer
 * match these constants → AcceptToSModal mounts.
 *
 * MUST stay in sync with the "Effective Date" lines in
 * ../sei-website/terms.html and ../sei-website/privacy.html.
 */
// 260602-uv9: TOS bumped to re-prompt users after the no-refund §8 rewrite in
// ../sei-website/terms.html (all sales final). PRIVACY_VERSION unchanged —
// privacy.html was not touched.
export const TOS_VERSION = '2026-06-03';
export const PRIVACY_VERSION = '2026-05-25';
