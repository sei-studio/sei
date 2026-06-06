/**
 * Canonical userData path resolution. ALL `<userData>/...` reads/writes
 * across main process must funnel through here so test harnesses can
 * later override `userDataOverride` if needed.
 *
 * Source: CONTEXT D-09 (paths under app.getPath('userData')).
 *
 * ── Per-profile partitioning (260603) ──────────────────────────────────────
 * Local data is partitioned by ACCOUNT SCOPE so that signing into a different
 * Supabase account (or the pre-login anonymous state) gets a fully isolated
 * bucket. There are two tiers of path:
 *
 *   DEVICE-GLOBAL  — one per install, shared across every account on the
 *     machine: the Supabase session blob (it IS the auth identity, so it can't
 *     live under an account it identifies), the MC-install wizard state, logs,
 *     temp files, and the legacy slug→UUID migration marker. These resolve
 *     from `userDataRoot()`.
 *
 *   PROFILE-SCOPED — one per account: config (mc_username / preferred_name /
 *     provider / api-backend kind), the BYOK api key, characters, skins,
 *     portraits, the (local-only, never-cloud) memory store, the cloud sync
 *     queue, the defaults-seeded tracker, and the local→cloud "modal shown"
 *     flag. These resolve from `profileRoot()` =
 *     `<userData>/profiles/<scopeId>/…`.
 *
 * `scopeId` is either the literal `'local'` (anonymous / signed-out) or a
 * Supabase auth user UUID. Switching accounts re-points `profileRoot()` at a
 * different directory, which is what makes a different account "start fresh
 * like a new install" — the per-account stores simply aren't there.
 */
import { app } from 'electron';
import path from 'node:path';

let userDataOverride: string | null = null;

/** TEST-ONLY: override userData root. Production code must not call this. */
export function _setUserDataOverride(p: string | null): void {
  userDataOverride = p;
}

function userDataRoot(): string {
  return userDataOverride ?? app.getPath('userData');
}

/** The anonymous / signed-out profile scope. */
export const SCOPE_LOCAL = 'local';

const SCOPE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let activeScopeId: string = SCOPE_LOCAL;

/**
 * Set the active profile scope. Accepts a Supabase auth user UUID or the
 * literal `'local'` (and `null`, treated as `'local'`). Any other value throws
 * — the scope id is path-joined into `profiles/<scopeId>`, so a slug with a
 * slash or `..` would escape the userData root. UUIDs and `'local'` are the
 * only shapes the auth layer ever produces.
 */
export function setActiveScope(scopeId: string | null): void {
  if (scopeId == null || scopeId === SCOPE_LOCAL) {
    activeScopeId = SCOPE_LOCAL;
    return;
  }
  if (!SCOPE_UUID_RE.test(scopeId)) {
    throw new Error(`Invalid profile scope id (expected UUID or 'local'): ${scopeId}`);
  }
  activeScopeId = scopeId.toLowerCase();
}

/** The currently-active profile scope id (`'local'` or a user UUID). */
export function getActiveScope(): string {
  return activeScopeId;
}

/** Absolute path to the active profile's data root. */
function profileRootDir(): string {
  return path.join(userDataRoot(), 'profiles', activeScopeId);
}

/** Absolute path to a specific profile's data root (scope-independent). */
export function profileRootFor(scopeId: string): string {
  const safe = scopeId === SCOPE_LOCAL || SCOPE_UUID_RE.test(scopeId);
  if (!safe) throw new Error(`Invalid profile scope id: ${scopeId}`);
  return path.join(userDataRoot(), 'profiles', scopeId.toLowerCase());
}

export const paths = {
  // ── Device-global (one per install, never per-account) ───────────────────
  userData: userDataRoot,
  /** Root of the `profiles/` tree (device-global container of all scopes). */
  profilesDir: () => path.join(userDataRoot(), 'profiles'),
  sessionPath: () => path.join(userDataRoot(), 'session.bin'),
  logsDir: () => path.join(userDataRoot(), 'logs'),
  // Wizard state JSON. Persists which MC installs the user ticked,
  // `hasRunOnce` (gates the first-launch modal vs the settings-reopen flow),
  // and the last skin-server port (used for port-drift detection on bootstrap).
  // Device-global: the linked MC installs are a property of the MACHINE, not
  // the signed-in account.
  wizardStatePath: () => path.join(userDataRoot(), 'skin-setup-state.json'),
  // D-23 / RESEARCH §Pattern 6: idempotency marker for the slug→UUID rename.
  // Device-global — the legacy on-disk format predates per-account profiles.
  migrationManifestPath: () => path.join(userDataRoot(), 'migration-uuid-rename.json'),
  // In-app updater state (quick/260604-uoy). Records the last-launched version
  // and any stashed post-update "what's new" changelog so it can be shown on
  // the next launch. DEVICE-GLOBAL by design: the installed app version is a
  // property of the MACHINE/install, not of any signed-in account — it must
  // survive account switches and sign-outs (mirrors wizardStatePath's tier).
  updateStatePath: () => path.join(userDataRoot(), 'update-state.json'),
  // 260603: one-shot marker that the global→profile partition has run for
  // this install. Device-global (the partition is a one-time layout upgrade).
  partitionMarkerPath: () => path.join(userDataRoot(), 'profiles-partitioned.json'),

  // ── Anti-abuse / DDOS-guard (260603) — DEVICE-GLOBAL by design ────────────
  // These describe the MACHINE, not any signed-in account, so they MUST stay
  // in the device-global tier and survive account switches / sign-outs — never
  // under profiles/<scope>/. See .planning/security/ABUSE-GUARD-PLAN.md §6/§9.

  // Random, locally-generated UUID v4 (NOT hardware fingerprinting, NOT PII)
  // backing the device-global trial-claim gate (one trial per device OR per
  // account, whichever is more restrictive).
  deviceIdPath: () => path.join(userDataRoot(), 'device-id.json'),

  // Rolling-window log of signup ATTEMPT timestamps (no emails / no PII) that
  // backs the escalating per-device account-creation cooldown.
  signupAttemptsPath: () => path.join(userDataRoot(), 'signup-attempts.json'),

  // ── Profile-scoped (one per account; re-points on account switch) ─────────
  /** Active profile's data root. */
  profileRoot: profileRootDir,
  configPath: () => path.join(profileRootDir(), 'config.json'),
  charactersDir: () => path.join(profileRootDir(), 'characters'),
  characterPath: (id: string) => path.join(profileRootDir(), 'characters', `${id}.json`),
  characterPortraitPath: (id: string) => path.join(profileRootDir(), 'characters', `${id}.png`),
  indexPath: () => path.join(profileRootDir(), 'characters', 'index.json'),
  apiKeyPath: () => path.join(profileRootDir(), 'api_key.bin'),
  memoryDir: (characterId: string) => path.join(profileRootDir(), 'memory', characterId),
  // Per-persona skin PNG storage. Files live under
  // <profileRoot>/skins/<personaId>.png. The persona id has already been
  // validated by main/ipc.ts's IdSchema (kebab-case slug regex, no '.', '/',
  // or '\\') before any of these path-builders is invoked, so path.join's
  // normalization never has to deal with an escape-attempting component.
  skinsDir: () => path.join(profileRootDir(), 'skins'),
  skinPngPath: (personaId: string) => path.join(profileRootDir(), 'skins', `${personaId}.png`),

  // ── Phase 11 additions — Source: 11-RESEARCH §Component Responsibilities ──

  // D-28: portrait moves from inline base64 data URL to a file/object.
  // Local cache layout mirrors the Storage bucket layout:
  // <profileRoot>/portraits/<uuid>.png. The caller (Plan 11-06) is responsible
  // for validating that `uuid` is a UUID v4 before invoking, so path.join's
  // normalization never has to defend against escape-attempting components.
  portraitPath: (uuid: string) => path.join(profileRootDir(), 'portraits', `${uuid}.png`),
  portraitsDir: () => path.join(profileRootDir(), 'portraits'),

  // Claude's Discretion (CONTEXT §sync retry queue shape):
  // JSON-file persistent queue mirroring apiKeyStore.ts atomic-write semantics.
  // Drained by syncWorker.ts (Plan 11-08) when network returns. Profile-scoped
  // so a different account never drains another account's queued cloud ops.
  syncQueuePath: () => path.join(profileRootDir(), 'sync-queue.json'),

  // 260516-x62 / 11-05: tracker of which bundled defaults (sui/lyra/clawd)
  // have been seeded into THIS profile, so user deletions persist per-account.
  defaultsSeededPath: () => path.join(profileRootDir(), 'defaults-seeded.json'),

  // Plan 11-18 (D-20): one-shot local→cloud migration modal "shown" flag.
  // Existence of this file means the user has already dismissed (or completed)
  // the auto-mount migration prompt at least once. Profile-scoped — each
  // account decides independently whether to push its local-only characters
  // to the cloud.
  migrationModalShownPath: () => path.join(profileRootDir(), 'migration-modal-shown.json'),

  // First-summon skin-setup nudge "shown" flag. Existence means the user has
  // already seen the one-time "run skin setup" prompt that fires when they
  // first try to summon a character. Profile-scoped (mirrors
  // migrationModalShownPath) so each account is nudged at most once; the
  // Settings → re-run setup entry remains available regardless.
  skinSetupPromptShownPath: () => path.join(profileRootDir(), 'skin-setup-prompt-shown.json'),
};
