/**
 * IPC contract between main, preload, and renderer.
 *
 * Single source of truth: every ipcMain.handle (in src/main/ipc.ts) and every
 * ipcRenderer.invoke (in src/preload/index.ts) imports channel names from
 * `IpcChannel` below. Method signatures imported as `RendererApi`.
 *
 * Sources:
 *   - CONTEXT D-17 (RendererApi shape)
 *   - CONTEXT D-19 (BotLifecycle vocabulary)
 *   - CONTEXT D-22 (LanState variants)
 *   - PATTERNS §src/shared/ipc.ts
 *   - RESEARCH §Pattern 2 (contextBridge contract)
 *   - UI-SPEC §Defaults (channel naming)
 */

import { z } from 'zod';
import type { Character, Skin, SkinSource, UserConfig, UserPreferences } from './characterSchema';
import type { ErrorClass } from './errorClasses';
export type { ErrorClass } from './errorClasses';

/* -------------------------------------------------------------------------- */
/*  Lifecycle / status / log domain types                                     */
/* -------------------------------------------------------------------------- */

export type Unsubscribe = () => void;

/**
 * Renderer-facing bot status surface (used by CharacterPage model row).
 *
 * EVERY variant carries `characterId`. Multiple bots can now be summoned into
 * the same world concurrently, and they all share the single `bot:status` push
 * channel — so a status update must say WHICH character it is about, otherwise
 * the renderer can't route an `idle`/`connecting` transition to the right entry
 * in its per-character `summons` map. (Before multi-summon, `idle`/`connecting`
 * omitted the id because there was only ever one session; that ambiguity is no
 * longer safe.) The renderer keys `useDataStore.summons` by this id.
 */
export type BotStatus =
  | { kind: 'idle'; characterId: string }
  | { kind: 'connecting'; characterId: string }
  // `startedAtMs` is the epoch ms when this session's clock started (main and
  // renderer share the system clock). The renderer derives a LIVE uptime from
  // it (Date.now() - startedAtMs) so the status line counts up even though main
  // emits 'online' only once. `uptimeMs` is the elapsed-at-emit snapshot, kept
  // for callers that just want a number without ticking.
  | { kind: 'online'; uptimeMs: number; startedAtMs: number; characterId: string }
  | {
      kind: 'error';
      error: ErrorClass;
      message: string;
      characterId: string;
      /**
       * When set, the session is still LIVE — this error is advisory, not a
       * session end (e.g. a mid-session backend switch to local with no saved
       * key: the bot stays connected in-world and just 401s on LLM calls).
       * Receivers must NOT treat a transient error as a terminal status: do not
       * drop the character from the online/routing set and do not post a
       * "played for X" play-session row. A non-transient error is terminal (the
       * session is gone or was never live).
       */
      transient?: true;
    };

/**
 * Phase 15 (D-10 / VIS-03) — the active LLM provider's vision capability,
 * pushed bot→main→renderer over the dedicated `vision:capability` channel.
 *
 * The bot reads `provider.capabilities.vision` (Phase 14 descriptor) on
 * summon-ready and re-emits it on a live backend switch. The renderer holds
 * `visionCapable` in useUiStore so the Settings auto-render toggle (15-05) can
 * disable itself for a non-VLM provider with a REAL signal — not an
 * ai_backend_kind inference and not a deferral. Fail-closed: the store defaults
 * to false until a VLM-backed bot reports true.
 *
 * Deliberately a SEPARATE channel, NOT a new BotStatus variant: the
 * CharacterPage model row consumes BotStatus, so a parallel channel is cleaner
 * and lower-risk than overloading that discriminated union.
 */
export interface VisionCapability {
  visionCapable: boolean;
}

/**
 * LAN world-detection status from the loopback watcher.
 *
 * This describes ONLY whether an open-to-LAN Minecraft world is detected on the
 * machine — NOT whether a companion has joined it. "Connected / not connected"
 * is reserved for the user-facing *companion-in-game* state (BotStatus). Keep
 * this vocabulary about world detection:
 *   - 'open'        → an open-to-LAN world is detected (port + motd known).
 *   - 'closed'      → no open world detected right now.
 *   - 'unavailable' → the OS port-listing tool itself failed (can't tell).
 */
export type LanState =
  | { kind: 'open'; port: number; motd: string; lastSeenAt: number }
  | { kind: 'closed' }
  | { kind: 'unavailable' };

// ── In-app chat (Phase 18/19) ───────────────────────────────────────────────
/** A quoted-reply reference (the message this one is replying to). */
export interface ChatReplyRef {
  /** Role of the quoted message's author. */
  role: 'user' | 'companion';
  /** Verbatim text of the quoted message (snapshot at reply time). */
  text: string;
}

/** One persisted chat message. `companion` = the AI; `system` reserved for UI. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'companion' | 'system';
  text: string;
  /** Unix ms. */
  ts: number;
  /** Set when this message is a reply that quotes an earlier one (Discord-style). */
  replyTo?: ChatReplyRef;
  /**
   * Set on a `system` row that records a finished play session, so the UI can
   * render it with the game icon (Discord-style "You and X played Minecraft for
   * Y"). `text` carries the human-readable line; `event` carries the structured
   * data. Also read by the chat brain (toMessages) as shared history so the
   * companion knows you actually played, not just talked about it.
   */
  event?: { kind: 'play'; game: string; durationMs: number };
}

/** Result of a chat turn. `launch` is set when the companion called launch(). */
export interface ChatSendResult {
  /**
   * The companion's reply, split into one-or-more messages on blank lines (a
   * paragraph break sends a new message, like double-tapping enter). The renderer
   * reveals them one at a time. Always at least one entry.
   */
  replies: ChatMessage[];
  /**
   * True when the character has a LIVE in-game session and this message was
   * routed INTO that session instead of the standalone chat brain (so the two
   * surfaces share one conversation). The reply then arrives asynchronously over
   * the `chat:message` push, so `replies` is empty and the renderer keeps the
   * typing indicator up until the pushed reply lands.
   */
  routed?: boolean;
  launch?: {
    game: string;
    /** 'summoning' → the bot is joining a LAN world; 'lan-not-open' → could not join. */
    status: 'summoning' | 'lan-not-open';
  };
}

/** A main → renderer chat push (bot reply while in-game, or a system line). */
export interface ChatMessagePush {
  characterId: string;
  message: ChatMessage;
}

/** In-app user profile surfaced to the chat + settings. */
export interface UserProfile {
  /** Portrait path ref ('_user.png') or null. Resolve via sei-portrait://. */
  profilePicture: string | null;
  preferredName: string;
}

/**
 * Startup warnings reported by main on first boot (one-shot query).
 * `keychainFallbackPlaintext` is true when running on Linux with the
 * `basic_text` safeStorage backend (no kwallet/libsecret available) —
 * surfaces as a top-of-window Banner per RESEARCH §Pitfall 3.
 */
export interface StartupWarnings {
  keychainFallbackPlaintext: boolean;
  /** Phase 10: Linux basic_text safeStorage also affects session.bin (Pitfall A2). Same backend signal, different consumer Banner. */
  sessionFallbackPlaintext: boolean;
}

/** Single log line forwarded from utilityProcess stdout/stderr → main → renderer. */
export interface LogEntry {
  timestamp: string;             // ISO; main attaches this when it tees the line
  tag: string | null;            // e.g. "[chat<-]", "[haiku!]"; null when no prefix matches
  message: string;               // raw line text including any prefix
  level: 'info' | 'warn' | 'error';
}

/** Batched log delivery (Pitfall 7 — main coalesces ~50ms / 100 lines per batch). */
export interface LogBatch {
  entries: LogEntry[];
  dropped?: number;              // sentinel when backpressure clipped lines
}

/**
 * Internal main↔utilityProcess MessagePort message vocabulary.
 * Renderer never sees these directly — main translates to BotStatus.
 */
export type BotLifecycle =
  | { type: 'init-ack' }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'error'; error: ErrorClass; message: string; retryAfterSeconds?: number }
  | { type: 'chat'; from: string; text: string }
  | { type: 'summon-ready' }
  | { type: 'summon-stopped' }
  | { type: 'exit'; code: number | null };

/* -------------------------------------------------------------------------- */
/*  Skin pipeline + setup-wizard domain types                                  */
/* -------------------------------------------------------------------------- */

/**
 * A detected Minecraft installation surfaced to the wizard.
 * Source: CONTEXT.md §decisions "Cross-platform paths" + "First-launch wizard scope".
 *
 * Zod-schema asymmetry (260518-o1k T2): the `kind` and `compatibility`
 * fields below ride the main→renderer push channel as plain TS objects;
 * inbound IPC zod-validation in `src/main/ipc.ts` only gates
 * `runWizardInstall` args (sessionId/installIds/skinServerBaseUrl) and
 * `wizardCancel` args (sessionId). The widened McInstall / Wizard*Event
 * unions therefore require NO zod schema changes — they are pure TS
 * contracts. Documented here so a future security pass doesn't conclude
 * the validation step was skipped.
 */
export interface McInstall {
  /** Stable hash of `${kind}:${absolutePath}` — durable across re-detects on the same machine. */
  id: string;
  kind: 'vanilla' | 'curseforge' | 'lunar';
  /** e.g. "Vanilla Launcher" or "Pixelmon · 1.20.1" or "Lunar Client" */
  label: string;
  /** Absolute on-disk path — game dir for vanilla, instance dir for CurseForge. */
  path: string;
  mc_version: string | null;
  loader: 'fabric' | 'forge' | null;
  loader_version: string | null;
  csl_installed: boolean;
  csl_version: string | null;
  /** True when persisted wizard state previously enabled Sei here. */
  sei_enabled: boolean;
  /**
   * Functional compatibility marker (260518-o1k D3).
   *   - `full`    — wizard can install Fabric + CSL here (vanilla, curseforge).
   *   - `limited` — read-only listing; wizard does NOT install (Lunar Client
   *                 has no user-accessible mods/ — surfaced for UX
   *                 transparency only).
   * Required field; scanners set it on every emission.
   */
  compatibility: 'full' | 'limited';
}

/** Per-install install result returned from runWizardInstall. */
export interface WizardInstallResult {
  installId: string;
  ok: boolean;
  error?: ErrorClass;
  message?: string;
  installedFabricVersion?: string;
  installedCslVersion?: string;
  /**
   * Vanilla-only (260518-o1k T6). Summary of the mod-link pass that ran
   * between the Fabric install and the CSL config write. Absent for
   * curseforge / lunar installs.
   */
  modLinkSummary?: {
    linked: number;
    excluded: number;
    linkedJars: { sourceName: string; strategy: 'link' | 'symlink' | 'copy' }[];
    excludedJars: {
      name: string;
      reason: 'mc-version-mismatch' | 'unparseable' | 'no-metadata' | 'read-error';
      declaredMc?: string;
    }[];
  };
}

/** Persisted wizard state at <userData>/skin-setup-state.json. */
export interface WizardState {
  version: 1;
  hasRunOnce: boolean;
  enabledInstallIds: string[];
  lastRunAt: string | null;
  lastSkinServerPort: number | null;
}

/** Push events emitted while runWizardInstall is in flight. */
export type WizardProgressEvent =
  | { installId: string; stage: 'queued' }
  | { installId: string; stage: 'fabric-downloading'; pct: number }
  | { installId: string; stage: 'fabric-installing' }
  /**
   * 260518-o1k T2: vanilla-only stage that runs between Fabric install and
   * CSL download. `totalEstimate` is null until the orchestrator has
   * `readdir`'d the source mods/ directory; after that it's the count of
   * candidate JARs. `scanned/linked/excluded` are monotonic running counts.
   */
  | {
      installId: string;
      stage: 'mods-linking';
      scanned: number;
      linked: number;
      excluded: number;
      totalEstimate: number | null;
    }
  | { installId: string; stage: 'mod-downloading'; pct: number }
  | { installId: string; stage: 'mod-placing' }
  | { installId: string; stage: 'config-writing' }
  | { installId: string; stage: 'done' }
  | { installId: string; stage: 'failed'; error: ErrorClass; message: string }
  | { installId: string; stage: 'cancelled' };

/**
 * Push events emitted while a persona-expansion LLM call streams during
 * `chars:save` (new-character creation or Edit-modal regeneration).
 *
 * `requestId` correlates the stream to the renderer-side saveCharacter call
 * that started it — mirrors the wizard's `sessionId` routing so two flows (or
 * a stale unmounted screen) can't cross their progress bars. `fraction` is a
 * 0..1 estimate the renderer scales to a 0..100 PercentBar; `section` is a
 * short human label of what the model is currently writing.
 */
export interface ExpansionProgressEvent {
  requestId: string;
  fraction: number;
  section: string;
}

/* -------------------------------------------------------------------------- */
/*  Unique-companion generation (260703 procgen)                              */
/* -------------------------------------------------------------------------- */

/** The single per-slot question asked before generating a unique companion. */
export type UniqueGender = 'male' | 'female' | 'other';

export interface GenerateUniqueInput {
  /** Correlates gen:progress pushes to this invocation (renderer-minted UUID),
   *  mirroring the expansionRequestId pattern on chars:save. */
  requestId: string;
  gender: UniqueGender;
}

/**
 * Result of the full generation pipeline (soulcaster-1 sheet → parallel
 * portrait/skin + persona expansion → save). Resolves only when the character
 * is saved locally (cloud mirror is the standard async syncQueue path).
 */
export type GenerateUniqueResult =
  | { ok: true; characterId: string }
  | {
      ok: false;
      code: 'not_signed_in' | 'slot_limit' | 'daily_limit' | 'generation_failed' | 'network';
      message: string;
    };

/**
 * Pipeline stages, in rough order. 'portrait' and 'persona' run in parallel;
 * 'skin' follows 'portrait' (img2skin). Renderer shows these as ritual copy
 * on the generation progress screen.
 */
export type GenStage = 'sheet' | 'portrait' | 'skin' | 'persona' | 'saving';

export interface GenProgressEvent {
  requestId: string;
  stage: GenStage;
  status: 'start' | 'done' | 'error';
  /** Optional human-readable detail (e.g. the error summary for status 'error'). */
  message?: string;
}

/** Result of prefs:get — the questionnaire gate reads `needed`. */
export interface PrefsGetResult {
  profile: UserPreferences | null;
  /**
   * True when the signed-in user should be shown the first-sign-in
   * questionnaire: no completed profile locally AND no cloud
   * user_preferences row. Always false when signed out.
   */
  needed: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Auth domain types (Phase 10)                                              */
/* -------------------------------------------------------------------------- */

/** Renderer-facing user shape; subset of Supabase's User. */
export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string; // ISO 8601
}

/**
 * Top-level auth state. Two-state model per CONTEXT D-06:
 * there is no separate 'signed_out' — AuthChoice gates the app
 * so 'local' is the resting-state when no session is loaded.
 */
export type AuthState =
  | { kind: 'local' }
  | { kind: 'signed_in'; user: AuthUser };

export type SignInResult =
  | { ok: true }
  | { ok: false; code: 'invalid_credentials' | 'invalid_email' | 'network' | 'rate_limited'; message: string };

export type SignUpResult =
  | { ok: true; requiresVerification: boolean }
  // SECURITY (T-10-04 — enumeration resistance): no `email_in_use` variant.
  // Already-registered emails return { ok: true, requiresVerification: true }
  // so an attacker probing signup cannot tell registered from new addresses.
  // See authHandlers.signUpWithPassword for the two detection branches.
  //
  // F-10 (quick/260525-usc) — COPPA DOB age gate. `under_13` is returned
  // BEFORE any Supabase call when the user's self-attested date of birth
  // implies they're younger than 13. The DOB itself is NEVER persisted —
  // we only retain the derived boolean fact `age >= 13`. The renderer's
  // SignInModal shows the message inline via the existing error path.
  //
  // 260603 anti-abuse — `cooldown` is returned BEFORE any Supabase call when
  // the escalating per-device signup cooldown is still in effect (too many
  // signups from this machine recently). `retryAfterMs` lets the renderer show
  // a live countdown. This is friction, not a hard lock — a human spacing
  // signups never hits it.
  | { ok: false; code: 'weak_password' | 'invalid_email' | 'network' | 'under_13'; message: string }
  | { ok: false; code: 'cooldown'; message: string; retryAfterMs: number }
  // No-silent-failure (260605): an already-registered email no longer returns a
  // neutral "check your email" that sends nothing. We surface it honestly so the
  // user can sign in instead. `provider` (when known) names the existing sign-in
  // method (e.g. 'Google') so the renderer can steer them to the right button.
  // This intentionally trades the previous enumeration resistance for honesty,
  // per the product owner's explicit "cannot silently fail" directive.
  | { ok: false; code: 'already_registered'; message: string; provider?: string };

export type OAuthResult =
  | { ok: true }
  | { ok: false; reason: 'user_cancelled' | 'timeout' | 'browser_closed' | 'google_rejected' | 'exchange_failed' | 'port_collision' | 'network'; message: string };

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: 'network' | 'edge_function_error'; message: string };

export type ExportDataResult =
  | { ok: true; savedPath: string }
  | { ok: false; code: 'cancelled' | 'network' | 'write_failed'; message: string };

export type ResendVerificationResult =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'network'; message: string };

/**
 * Password-reset request result. Neutral by design (T-10-04 enumeration
 * resistance): a valid and an unknown address both return { ok: true }, so the
 * renderer cannot reveal whether an email is registered. `rate_limited` maps the
 * Supabase 429 (email-send rate limit); `network` is the catch-all.
 *
 * `oauth_only` (260605): the address belongs to an OAuth-only account (e.g.
 * Google) with no password identity. Sending a reset link would let the user
 * graft a password onto an account that never had one — so we refuse and point
 * them at their provider instead. `provider` names it (e.g. 'Google').
 */
export type PasswordResetResult =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'network'; message: string }
  | { ok: false; code: 'oauth_only'; message: string; provider?: string };

/**
 * Result of setting a new password from SetNewPasswordModal (post-recovery).
 * `not_signed_in` covers the expired-recovery-session case (the user must
 * request a fresh reset link); `weak_password` mirrors the signup classifier.
 */
export type UpdatePasswordResult =
  | { ok: true }
  | { ok: false; code: 'weak_password' | 'not_signed_in' | 'network'; message: string };

/**
 * Phase 11 plan 12 — ToS status returned by IpcChannel.tos.status.
 *
 * `accepted` is tri-state (260610 offline-misfire fix):
 *   - true  → a row matches the active TOS_VERSION + PRIVACY_VERSION
 *   - false → DEFINITIVELY no matching row (query succeeded; user must
 *             accept — App.tsx mounts the blocking AcceptToSModal), or the
 *             user is not signed in
 *   - null  → the check could not reach the database (offline / DNS / timeout);
 *             App.tsx shows the dismissible offline-retry notice instead of
 *             the legal modal
 *
 * `tosVersion` / `privacyVersion` are the ACTIVE constants (not whatever the
 * user accepted) — the blocking modal shows these in its footer.
 */
export interface TosStatus {
  accepted: boolean | null;
  tosVersion: string;
  privacyVersion: string;
}

export type TosAcceptResult =
  | { ok: true }
  | { ok: false; message: string };

/* -------------------------------------------------------------------------- */
/*  Sync queue domain types (Phase 11)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Renderer-facing cloud-sync queue status. Drives the per-card pill (syncing /
 * failed / synced) plus a future global header indicator.
 *
 * `pending` is the count of ops in the queue that have not exceeded
 * MAX_ATTEMPTS yet (still being retried with backoff).
 * `failed` lists ops that have run out of retries — the renderer surfaces a
 * "retry" affordance keyed off `uuid`.
 * `pendingByUuid` maps character.id → 'syncing' | 'failed' so a card can do
 * an O(1) lookup; 'failed' wins over 'syncing' when both somehow exist.
 */
export interface SyncStatus {
  pending: number;
  failed: Array<{ uuid: string; kind: 'upsert' | 'delete'; attempts: number; lastError?: string }>;
  pendingByUuid: Record<string, 'syncing' | 'failed'>;
}

/** Push payload for IpcChannel.sync.statusUpdate (a slim subset of SyncStatus). */
export interface SyncStatusPushEvent {
  pending: number;
  pendingByUuid: Record<string, 'syncing' | 'failed'>;
}

/* -------------------------------------------------------------------------- */
/*  Phase 12 — Browse + moderation + reports domain types                     */
/* -------------------------------------------------------------------------- */

/**
 * A single Browse-tab card payload — main pre-joins everything the renderer
 * needs so the grid renders in one pass without crossing two stores. The
 * `inMyLibrary` predicate is precomputed in the main handler (Researcher
 * correction #4: predicate is "is this in useDataStore.characters", i.e. on
 * local disk) so a fresh-machine user who has signed in but downloaded
 * nothing yet sees no false "Already in My Library" badges.
 */
export interface BrowseEntry {
  id: string;
  name: string;
  /** First ~120 chars of persona_source with ellipsis (D-31d). */
  personaSnippet: string;
  /** "by anonymous" or "by user-<short uuid frag>" per CONTEXT §specifics. */
  creatorLabel: string;
  /** Public Storage URL (Pitfall 11: never round-trip to Mojang here). */
  portraitUrl: string | null;
  skinUrl: string | null;
  /** ISO timestamp. */
  updatedAt: string;
  /** Precomputed by main handler — true when the character JSON exists on local disk. */
  inMyLibrary: boolean;
}

/**
 * Sentinel error codes mirrored from src/main/cloud/cloudErrors.ts. The
 * publish-with-moderation IPC surface exposes only these three to the
 * renderer (raw provider categories never cross the boundary —
 * T-12-07-03). The renderer ERROR_COPY map in Plan 12-10/11 routes by
 * exact match.
 */
export const PUBLISH_MODERATION_CODES = [
  'CLOUD_MODERATION_IMAGE_FLAGGED',
  'CLOUD_MODERATION_PROMPT_FLAGGED',
  'CLOUD_MODERATION_PROVIDER_UNAVAILABLE',
] as const;
export type PublishModerationCode = (typeof PUBLISH_MODERATION_CODES)[number];

/* -------------------------------------------------------------------------- */
/*  Phase 13 — Proxy + billing + credits domain types                          */
/* -------------------------------------------------------------------------- */

/**
 * Step size for the remaining-pct UI bar (CONTEXT D-41).
 *
 * The proxy server emits `X-Sei-Remaining-Pct` rounded to the nearest 5%, and
 * the renderer pins the % bar to the same step so successive responses don't
 * visually jitter. Exposed as a const so future grid / progress components
 * (PricingIcon hover, CreditsScreen bar) line up by reference rather than a
 * magic number.
 */
export const REMAINING_PCT_ROUND_STEP = 5;

/**
 * Renderer-facing credits status snapshot. Read on demand via `creditsGet()`
 * and pushed via `credits:status:update` after every proxied Anthropic
 * response (which carries `X-Sei-Remaining-Pct`).
 *
 *   - `remaining_pct`     — 0..100, rounded to REMAINING_PCT_ROUND_STEP.
 *   - `plan`              — drives copy in CreditsScreen + HardStopModal.
 *                            'depleted' is the hard-stop state.
 *   - `renews_at`         — ISO date when an active subscription renews;
 *                            null for pack / trial / no-plan users.
 *   - `trial_claimed`     — true once this account has a kind='trial'
 *                            ledger_grants row (the trial is bound to the
 *                            account UUID; one claim per account).
 *   - `ai_backend_kind`   — mirrors `apiKeyStore.getAiBackendKind()`; the
 *                            credits UI hides itself when this is 'local'.
 */
export interface CreditsStatus {
  remaining_pct: number;
  /**
   * 260602-hbr — usage as a percent of total available credits:
   * `used / available × 100`, where `available = SUM(ledger_grants)` and
   * `used = available − balance`. Starts at 0% on a fresh grant and grows to
   * 100% as credits are consumed. Topping up (subscription + one or more Quest
   * packs) is additive on `available`, so the bar moves left on a top-up.
   * Percent only — PROXY-05 keeps raw token/dollar units server-side.
   * Optional during rollout; the renderer treats `undefined` as 0%.
   */
  usage_pct?: number;
  plan: 'trial' | 'pack' | 'unlimited' | 'depleted';
  renews_at: string | null;
  /**
   * ISO date a subscription will END. Set only when the subscription has been
   * cancelled but is still inside its paid period ("to be cancelled") — the
   * user keeps full access until this date. null for auto-renewing subscribers
   * (use `renews_at`) and non-subscribers. When set alongside plan='unlimited',
   * the renderer shows "Subscription will end {ends_at}" + a Resume CTA instead
   * of the renewal line + "Subscribed".
   */
  ends_at: string | null;
  trial_claimed: boolean;
  ai_backend_kind: 'local' | 'cloud-proxy';
  // ITEM 4 (quick/260523-t8d): backend-supplied tokens count so the UI can
  // compute a "~Xh left" playtime string. 260602-hbr: the personalized
  // rolling-24h `tokens_per_min` was dropped — the renderer now applies a flat
  // `DEFAULT_TOKENS_PER_MIN` multiplier to this value. Optional during rollout.
  remaining_tokens?: number;        // server-computed: ledger_balance_micro / MICRO_PER_TOKEN_BLENDED
  /**
   * Lifetime spend in USD and total granted credits in USD (`used / available`,
   * the dollar form of `usage_pct`). main computes these in creditsGet from the
   * same ledger micros it already reads (µ$ ÷ 1e6), so they are real numbers in
   * cloud mode. NOTE: this deliberately extends past the PROXY-05 "percent only"
   * line at the owner's request — the UsageBar tooltip shows "$used/$total".
   * Optional: undefined for local/BYOK, no session, or a cold-load before the
   * first creditsGet.
   */
  used_usd?: number;
  total_usd?: number;
  /**
   * quick/260525-sbo Task 8 — raw subscription status mirrored
   * from `subscription_status.status` via the my_subscription view. Drives
   * contextual banners in SettingsScreen (past-due, paused) and lets future
   * UI distinguish 'cancelled' vs 'expired' vs 'refunded'. Optional during
   * rollout — falls back to null when the user has never subscribed OR when
   * the subRow query returned no data.
   */
  subscription_status_raw?:
    | 'active'
    | 'cancelled'
    | 'expired'
    | 'past_due'
    | 'refunded'
    | 'paused'
    | null;
}

/**
 * Subscription state read from the `subscription_status` table (D-46 / D-47).
 * `active` is the derived predicate the UI uses to gate the Unlimited tile
 * cancel/portal-link surface; `status` is the raw enum mirrored from Polar
 * webhook events so settings copy can disambiguate 'cancelled' vs 'expired'
 * vs 'past_due'.
 */
export interface SubscriptionStatusInfo {
  active: boolean;
  // quick/260525-sbo Task 8: 'paused' + 'refunded' added so the renderer
  // can route on the raw LS status (past-due banner, paused banner, etc.)
  // without losing fidelity at the IPC boundary. 'none' is the sentinel
  // for "no row in subscription_status" (never subscribed).
  status: 'active' | 'cancelled' | 'expired' | 'past_due' | 'refunded' | 'paused' | 'none';
  renews_at: string | null;
  ends_at: string | null;
}

/**
 * Push payload for `credits:hard-stop`. Fires when the proxy returns 402
 * (ledger empty) or `remaining_pct` hits 0, OR when the per-user rate-bucket
 * trips (D-51). The renderer surfaces the HardStopModal off this event;
 * `retry_after_seconds` is set only for the rate-limited branch and is the
 * `Retry-After` header value in seconds.
 */
export interface CreditsHardStopEvent {
  reason: 'depleted' | 'rate_limited';
  retry_after_seconds?: number;
}

/**
 * Zod-validated argument shapes for the new Phase 13 IPC channels. Validation
 * lives at the main-process trust boundary (every ipcMain.handle runs
 * `.parse(args)` before dispatch) — see PATTERNS §"Zod validation at every
 * external boundary".
 *
 * Note: `trial:claim` takes NO arguments — the trial is bound to the account
 * UUID (derived server-side from the session JWT), not the Minecraft username
 * (migration 20260603000000 dropped the mc_username-keyed `trial_claims`
 * table). So there is no TrialClaimArgsSchema.
 */
export const ProxyConfigureArgsSchema = z.object({
  kind: z.enum(['local', 'cloud-proxy']),
});
export const CreditsCheckoutArgsSchema = z.object({
  kind: z.enum(['pack', 'subscription']),
});
/**
 * quick/260525-sbo Task 3 — auto-renewal consent gate.
 *
 * The renderer hands main a consent_version (= TOS_VERSION at click-time) so
 * the Edge Function can stamp it on the immutable subscription_consents row.
 * Bounded at 64 chars to match the Edge Function's defensive shape gate.
 */
export const RecordConsentArgsSchema = z.object({
  consent_version: z.string().min(1).max(64),
});

/* -------------------------------------------------------------------------- */
/*  Preload-exposed RendererApi                                                */
/* -------------------------------------------------------------------------- */

/**
 * The shape of `window.sei` in renderer code.
 * Preload (src/preload/index.ts) uses `contextBridge.exposeInMainWorld('sei', api)`
 * with `api: RendererApi`. Main registers ipcMain.handle for every request/response method.
 */
export interface RendererApi {
  // Bot supervision (request/response with timeouts — main enforces).
  // `stop(id)` stops one summoned character; `stop()` (no id) stops every
  // active session (used by sign-out / account-swap teardown).
  summon(characterId: string): Promise<void>;
  stop(characterId?: string): Promise<void>;

  // Character CRUD
  listCharacters(): Promise<Character[]>;
  getCharacter(id: string): Promise<Character | null>;
  // 260516-0yw: saveCharacter now returns the persisted Character so the
  // renderer can pick up the LLM-generated persona.expanded after main
  // ran the expansion call.
  // 260517-frz: optional { skipExpansion } lets the renderer hand main a
  // manually-edited persona.expanded and skip the LLM regeneration. When
  // omitted/false, main regenerates expanded from persona.source as before.
  // `expansionRequestId`: opaque renderer-generated id (e.g. crypto.randomUUID())
  // that tags the streaming ExpansionProgressEvent ticks so the caller can
  // filter progress for THIS save. Ignored when skipExpansion is true (no LLM
  // call runs). When omitted, expansion still runs/streams but emits no ticks.
  saveCharacter(
    character: Character,
    options?: { skipExpansion?: boolean; expansionRequestId?: string },
  ): Promise<Character>;
  deleteCharacter(id: string): Promise<void>;
  resetMemory(id: string): Promise<void>;

  // Phase 11 D-28 — portrait pipeline (file-on-disk, not inline data URL).
  /** Write portrait bytes for a character and return the path reference ('<uuid>.png'). */
  charsApplyPortrait(args: { characterId: string; bytesBase64: string; format: 'png' | 'jpeg' | 'webp' }): Promise<string>;
  /** Clear portrait_image and delete the on-disk file (ENOENT-tolerant). */
  charsRemovePortrait(characterId: string): Promise<void>;

  // Phase 11 D-16 — toggle public/private visibility of a character. Refuses
  // when the character is a bundled default. Triggers the standard cloud-mirror
  // upsert via saveCharacter under the hood.
  charsSetShared(args: { id: string; shared: boolean }): Promise<void>;

  /**
   * Pre-flight daily character-creation quota check (persona_daily cap).
   * Called before entering the new-character flow so a maxed-out user sees a
   * "come back tomorrow" modal instead of failing mid-expansion. Best-effort —
   * returns { blocked:false } for BYOK users and on any error.
   */
  checkCreateQuota(): Promise<{ blocked: boolean; resetsAt: string | null }>;

  // Phase 11 plan 17 — fetch the UUID set of the signed-in user's cloud
  // characters. Used by useCloudCharactersStore to drive the "LOCAL ONLY"
  // chip on CharacterCard. Returns { ids: [], ok: true } when signed-out;
  // { ids: [], ok: false } on a listMyCharacters failure so the renderer
  // can preserve its prior cloudIds set instead of flashing every char as
  // LOCAL ONLY during a transient outage (HR-01).
  charsListCloud(): Promise<{ ids: string[]; ok: boolean }>;

  // Phase 11 plan 19 (D-19) — cache-on-demand sync surface. openPrepare
  // ensures a character is hydrated to local disk BEFORE the renderer
  // navigates into it; listMerged returns the local + cloud union with a
  // per-row source annotation so HomeScreen can render cloud-only entries.
  charsOpenPrepare(uuid: string): Promise<void>;
  charsListMerged(): Promise<{
    characters: Array<{ id: string; name: string; is_default: boolean; source: 'local' | 'cloud' | 'both' }>;
  }>;
  /** Re-add a bundled default to the library (clears it from removed_default_ids). */
  charsRestoreDefault(id: string): Promise<void>;
  /**
   * Add a non-default World character to the user's library: download +
   * cache locally (cacheOnDemand) AND add the id to
   * UserConfig.added_world_ids so HomeGrid / IconRail surface it on Home
   * even though the character's owner !== currentUserId.
   */
  charsAddToLibrary(id: string): Promise<void>;
  /**
   * Remove a foreign-owned World character from the user's library: drop the
   * id from UserConfig.added_world_ids AND wipe the local cache (JSON +
   * portrait + skin + memory dir). Does NOT touch the cloud row — the user
   * doesn't own it. Use chars:delete for self-owned characters.
   */
  charsRemoveFromLibrary(id: string): Promise<void>;

  // Phase 11 — cloud-sync queue surface for the per-card pill driver.
  /** Snapshot of pending + failed cloud ops. */
  syncStatus(): Promise<SyncStatus>;
  /** Force a retry of a single op (resets attempts, schedules nextAttemptAt=now). */
  syncRetry(uuid: string): Promise<void>;
  /** Subscribe to sync:status:update pushes — returns the unsubscribe fn. */
  onSyncStatusUpdate(cb: (status: SyncStatusPushEvent) => void): Unsubscribe;

  // User config + secret
  getConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
  saveApiKey(plaintext: string): Promise<void>;
  hasApiKey(): Promise<boolean>;

  // --- In-app chat (Phase 18/19) ---
  /** Load a character's persisted chat transcript (recent window). */
  chatHistory(characterId: string): Promise<ChatMessage[]>;
  /** Send a chat message; returns the companion reply (+ launch signal if the companion launched a game). */
  chatSend(args: { characterId: string; text: string; replyTo?: ChatReplyRef }): Promise<ChatSendResult>;
  /** Clear a character's chat transcript + rolling summary bridge. */
  chatClear(characterId: string): Promise<void>;
  /**
   * Subscribe to chat messages pushed OUTSIDE a send() round-trip: the live
   * game bot replying to a routed message, and "joined/left your world" system
   * lines. The renderer appends them to the transcript (deduped by id).
   */
  onChatMessage(cb: (push: ChatMessagePush) => void): Unsubscribe;

  // --- Voice calls (260705) ---
  /**
   * Synthesize a companion's spoken line in its assigned ElevenLabs voice.
   * Resolves to encoded audio bytes (audio/mpeg) for renderer playback. Main
   * resolves the character's voice (metadata.voiceId, with a deterministic
   * fallback assignment for pre-voice characters) and routes through the Sei
   * proxy with the Supabase JWT — the ElevenLabs key never reaches the client.
   * Rejects with sentinel-prefixed messages: VOICE_NO_SESSION (signed out),
   * VOICE_RATE_LIMITED (daily voice allowance), VOICE_NOT_CONFIGURED,
   * VOICE_TTS_FAILED.
   */
  voiceTts(args: { characterId: string; text: string }): Promise<ArrayBuffer>;
  /**
   * Mark a voice call open (active:true) or hung up (active:false) for a
   * character. Main records it (voice/callState) so idle-chat prompts carry
   * the voice-call primer, and forwards {type:'voice-call'} into a live game
   * session so say() reroutes to the call instead of in-game chat. The
   * supervisor re-applies the state on summon-ready, so a companion that
   * launch()es into the world mid-call keeps speaking to the call.
   */
  voiceCallSetActive(args: { characterId: string; active: boolean }): Promise<void>;

  // --- User profile (Phase 19) ---
  /** The in-app user profile (avatar ref + preferred name). */
  userGetProfile(): Promise<UserProfile>;
  /** Apply user profile-picture bytes; returns the path ref ('_user.png'). */
  userApplyProfilePicture(args: { bytesBase64: string; format: 'png' | 'jpeg' | 'webp' }): Promise<string>;
  /** Clear the user profile picture and delete the on-disk file. */
  userRemoveProfilePicture(): Promise<void>;

  // App-level one-shot queries
  getStartupWarnings(): Promise<StartupWarnings>;

  // --- Skin pipeline ---
  /**
   * Apply an already-validated PNG (from upload or Mojang search) as the persona's skin, AND
   * update the persona's per-persona MC username, atomically (single saveCharacter call).
   * `username` is the per-persona MC in-game name; pass null/undefined to leave the existing value untouched.
   * Pass an empty string to clear it (falls back to sanitized persona name).
   * The main process writes the PNG to <userData>/skins/<id>.png and updates the character's skin descriptor + username in one saveCharacter call.
   */
  applySkin(args: { characterId: string; pngBase64: string; source: SkinSource; mojangUsername?: string | null; username?: string | null }): Promise<{ skin: Skin; username: string | null }>;
  /** Reset the persona to its bundled default skin (or 'none' for user-created personas). */
  removeSkin(characterId: string): Promise<{ skin: Skin }>;
  /** Open native file dialog, validate dimensions (64×64), and return base64 + sha256 for renderer-side preview + applySkin. */
  uploadSkinPng(): Promise<{ pngBase64: string; sha256: string } | null>;
  /** Resolve Mojang username -> UUID -> texture URL -> PNG bytes. 15s timeout. Normalizes legacy 64×32 skins to 64×64 before returning. */
  searchMojangSkin(username: string): Promise<{ pngBase64: string; sha256: string; resolvedUsername: string }>;
  /** Returns the loopback URL prefix that CustomSkinLoader is configured against (e.g. 'http://127.0.0.1:54321'). */
  getSkinServerUrl(): Promise<{ baseUrl: string }>;

  // --- Setup wizard ---
  /** Scan known Minecraft launcher + CurseForge paths on the current platform. */
  detectMcInstalls(): Promise<{ installs: McInstall[] }>;
  /**
   * Install Fabric Loader (vanilla) and/or drop CustomSkinLoader into each selected install. Emits progress via onWizardProgress.
   * `sessionId` is a renderer-generated opaque id (e.g. crypto.randomUUID()) that lets a subsequent wizardCancel(sessionId) abort THIS install run.
   */
  runWizardInstall(args: { sessionId: string; installIds: string[]; skinServerBaseUrl: string }): Promise<{ results: WizardInstallResult[] }>;
  /**
   * Abort an in-flight runWizardInstall by sessionId. Main holds a Map<sessionId, AbortController>;
   * this resolves immediately after firing .abort() — the in-flight runWizardInstall promise then rejects.
   */
  wizardCancel(sessionId: string): Promise<void>;
  /** Returns the persisted wizard state (which installs are enabled, last setup timestamp, last skin server port). */
  getWizardState(): Promise<WizardState>;
  /**
   * Read ('get') or persist ('set') the one-time "run skin setup" nudge flag.
   * Fired when a user first tries to summon a character: if they have never
   * completed skin setup (WizardState.hasRunOnce === false) AND this flag is
   * unset, the renderer shows a one-time prompt and then sets the flag.
   * Profile-scoped — mirrors migrationShown.
   */
  wizardPromptShown(action: 'get' | 'set'): Promise<{ shown: boolean }>;

  // --- Auth (Phase 10) ---
  signInPassword(args: { email: string; password: string }): Promise<SignInResult>;
  /**
   * F-10 (quick/260525-usc) — COPPA age gate at signup. The renderer collects
   * a date of birth via three dropdowns (month / day / year); main computes
   * age from {dobYear, dobMonth, dobDay} via wall-clock today. If age < 13
   * we return `{ ok:false, code:'under_13' }` BEFORE any Supabase call.
   *
   * The DOB itself is never persisted to Supabase — we only retain the
   * derived boolean fact `age >= 13` (the signup timestamp itself, combined
   * with a successful signUp, is the boolean record).
   */
  signUpPassword(args: {
    email: string;
    password: string;
    dobYear: number;
    dobMonth: number;
    dobDay: number;
  }): Promise<SignUpResult>;
  signInGoogle(): Promise<OAuthResult>;
  cancelGoogle(): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<DeleteAccountResult>;
  exportData(): Promise<ExportDataResult>;
  resendVerification(): Promise<ResendVerificationResult>;
  /**
   * Send a password-reset email. Neutral success (anti-enumeration): returns
   * { ok:true } whether or not the address is registered. The email links to the
   * fixed-port loopback callback (the same server email verification uses), so
   * clicking it lands a recovery session and main pushes onPasswordRecovery.
   */
  sendPasswordReset(args: { email: string }): Promise<PasswordResetResult>;
  /**
   * Set a new password for the recovery-session signed-in user. Reached from
   * SetNewPasswordModal after a reset link lands; the user IS signed in at that
   * point (recovery sessions satisfy signed_in).
   */
  updatePassword(args: { password: string }): Promise<UpdatePasswordResult>;
  /**
   * Fired once after a password-reset link lands a recovery session. App.tsx
   * mounts SetNewPasswordModal so the user can choose a new password.
   */
  onPasswordRecovery(cb: () => void): Unsubscribe;
  /**
   * 260603 anti-abuse — hand a solved Cloudflare Turnstile / hCaptcha token to
   * main, to be forwarded as `options.captchaToken` on the NEXT signup. Tokens
   * are single-use; main read-and-clears. Inert until bot-protection is enabled
   * (operator USER-ACTION). See captcha.ts + ABUSE-GUARD-PLAN.md §4c.
   */
  setCaptchaToken(token: string | null): Promise<void>;
  onAuthState(cb: (state: AuthState) => void): Unsubscribe;

  // --- ToS / Privacy gate (Phase 11 plan 12) ---
  /** Whether the signed-in user has accepted the current TOS_VERSION + PRIVACY_VERSION. */
  tosStatus(): Promise<TosStatus>;
  /** Record ToS + Privacy acceptance for the currently-signed-in user. */
  tosAccept(): Promise<TosAcceptResult>;

  // --- Migration prompt (Phase 11 plan 18, D-20) ---
  /**
   * List local-only characters eligible for one-shot migration to the user's
   * cloud library. `cloudListOk` is false when the underlying Supabase listing
   * call failed (MR-01) — in that case `characters` falls back to every
   * non-default local character (we can't filter by cloud presence), and the
   * modal should surface a "Couldn't verify which of these are already in
   * cloud" banner so the user understands why already-uploaded chars might
   * appear in the list. ok=true means the filter is authoritative.
   */
  migrationListLocal(): Promise<{ characters: Array<{ id: string; name: string; slug: string | null; created: string }>; cloudListOk: boolean }>;
  /** Sequentially upload selected local characters; returns per-uuid result. */
  migrationUpload(uuids: string[]): Promise<{ results: Array<{ id: string; ok: boolean; message?: string }> }>;
  /** Read ('get') or persist ('set') the migration-modal-shown flag. */
  migrationShown(action: 'get' | 'set'): Promise<{ shown: boolean }>;
  /**
   * 260603: inspect the anonymous `local` profile for data importable into the
   * just-signed-in account (user-created characters + onboarding answers).
   */
  profilePeekLocal(): Promise<PeekLocalProfileResult>;
  /**
   * Move the `local` profile's user-created characters (+ memory/skins/portraits)
   * and onboarding answers into the active account profile. Optional id subset.
   */
  profileImportFromLocal(characterIds?: string[]): Promise<ImportLocalProfileResult>;
  /**
   * Open a URL in the user's default browser. Main-side URL allowlists to
   * the configured legal-pages host (sei.gg over https) — anything else is
   * rejected as a throw (T-11-12-01). The renderer treats the throw as a
   * silent no-op.
   */
  openExternal(url: string): Promise<void>;

  // --- Browse + moderation (Phase 12) ---
  /**
   * Paged listing of public, moderation-clean characters. NOT gated on
   * cloud writes — Browse is read-public per LIB-04. Empty array when
   * the RPC fails or there are no rows; `hasMore` is true when the
   * returned page is full (renderer can request the next offset).
   */
  browseList(args: { query: string; limit: number; offset: number }): Promise<{ entries: BrowseEntry[]; hasMore: boolean }>;
  // The legacy publish-with-moderation IPC method was removed in 260525-qy0
  // — moderation now runs inline inside chars.save / chars.setShared so the
  // renderer's existing calls to charsSave + charsSetShared trigger the gate.
  // Renderer error surfaces use the catch-and-toast pattern; the gate's
  // friendlyMessage is thrown as an Error and surfaced via err.message.
  //
  // B4: getCapabilities + the BROWSE_ENABLED capability gate were removed —
  // the World (formerly Browse) tab is always available.

  // --- Phase 13 — Proxy + billing + credits (stub contract) ---
  /**
   * Persist the AI backend kind (D-57). On 'cloud-proxy', the renderer
   * surfaces the pricing icon + credits UI. The main-process setter writes
   * config.json via apiKeyStore.setAiBackendKind. Returns `{ok:true}` on
   * success; the code variants are reserved for Wave 3 (e.g. refusing the
   * 'cloud-proxy' switch when not signed in).
   */
  proxyConfigure: (
    kind: 'local' | 'cloud-proxy',
  ) => Promise<{ ok: true } | { ok: false; code: string }>;
  /**
   * Claim the one-time free trial credits for the signed-in account. The trial
   * is bound to the account UUID (derived server-side from the session JWT);
   * the one-trial-per-account cap is enforced by the `trial-claim` Edge
   * Function via the `ledger_grants_trial_per_user_uidx` partial UNIQUE index.
   * Takes no arguments — the username plays no role.
   */
  trialClaim: () => Promise<
    | { ok: true; credits_micro: number }
    // 'device_claimed' — this machine already used its one free trial (the
    // per-device anti-abuse gate), possibly under a different account; distinct
    // from 'already_claimed' (THIS account already claimed) so the UI can say so.
    | { ok: false; code: 'already_claimed' | 'device_claimed' | 'no_session' | 'network' }
  >;
  /**
   * One-shot snapshot of the user's credits status. Refreshed on the
   * `credits:status:update` push channel after every proxied Anthropic call.
   * Returns the {plan:'trial', remaining_pct:100, trial_claimed:false}
   * placeholder until Wave 3 wires the proxy client.
   */
  creditsGet: () => Promise<CreditsStatus>;
  /**
   * Open the Polar checkout for the requested product. The proxy mints the
   * checkout session server-side (user_id in metadata) and returns the hosted
   * URL, which is dispatched via shell.openExternal after an allowlist check.
   */
  creditsOpenCheckout: (
    kind: 'pack' | 'subscription',
  ) => Promise<{ ok: true } | { ok: false; code: string }>;
  /** Read the user's subscription state (active/cancelled/expired/past_due/none). */
  subscriptionStatus: () => Promise<SubscriptionStatusInfo>;
  /**
   * Open the Polar customer portal so the user can cancel their subscription.
   * The proxy mints a Polar customer session and returns the signed
   * customer_portal_url, dispatched via shell.openExternal.
   */
  subscriptionCancel: () => Promise<{ ok: true; portalUrl: string } | { ok: false; code: string }>;
  /**
   * quick/260525-sbo Task 3 — record an immutable affirmative consent before
   * opening the LS subscription checkout. Required by CA Bus & Prof Code
   * §17602(b) recordkeeping. The renderer passes the active TOS_VERSION as
   * consent_version; main forwards to the record-consent Edge Function.
   *
   * Non-blocking: callers proceed with `creditsOpenCheckout('subscription')`
   * even if this returns `ok: false` — the legal anchor is the user's
   * affirmative checkbox click which the renderer cannot lose. A failed
   * INSERT is logged in main; the operator can backfill from console logs
   * if a dispute requires the audit trail.
   */
  recordSubscriptionConsent: (args: { consent_version: string }) => Promise<
    { ok: true } | { ok: false; code: string }
  >;
  /**
   * Subscribe to `credits:status:update` pushes. Fires after every proxied
   * Anthropic call (the proxy emits the new % via X-Sei-Remaining-Pct).
   * Returns the unsubscribe fn.
   */
  onCreditsStatusUpdate: (cb: (status: CreditsStatus) => void) => Unsubscribe;
  /**
   * Subscribe to `credits:hard-stop` pushes. Fires on 402 from the proxy or
   * when remaining_pct hits 0, OR when the rate-bucket trips (D-51).
   * Returns the unsubscribe fn.
   */
  onCreditsHardStop: (cb: (info: CreditsHardStopEvent) => void) => Unsubscribe;

  // Push subscriptions — return Unsubscribe (renderer cleans up on unmount)
  onStatus(cb: (status: BotStatus) => void): Unsubscribe;
  /** Pull the current per-character bot statuses (snapshot). Used to seed a
   * freshly-(re)subscribed renderer, since onStatus pushes only fire on
   * TRANSITIONS — a subscriber that attaches after 'online' would otherwise
   * never learn a session is live (260703: chat-launched Sui session invisible
   * to the GUI after a dev HMR re-created the store). Mirrors getLanState. */
  getBotStatuses(): Promise<BotStatus[]>;
  /**
   * Phase 15 (D-10/VIS-03): subscribe to `vision:capability` pushes. Fires on
   * summon-ready and on every live backend switch with the active provider's
   * `capabilities.vision`. The renderer feeds it into useUiStore.visionCapable
   * so the 15-05 Settings auto-render toggle can gate its disabled state.
   */
  onVisionCapability(cb: (cap: VisionCapability) => void): Unsubscribe;
  onLog(cb: (batch: LogBatch) => void): Unsubscribe;
  onLan(cb: (state: LanState) => void): Unsubscribe;
  /** Pull the current LAN state (snapshot). Used to seed a freshly-loaded
   * renderer, since the onLan push only fires on change. */
  getLanState(): Promise<LanState>;
  /**
   * Force ONE fresh LAN detection pass right now and return its result (260703).
   * Unlike {@link getLanState} (a cached snapshot that can lag up to ~4s behind
   * reality because the background poll damps open→closed transitions), this
   * reads live ground truth. The summon click awaits it so a world that JUST
   * closed shows the "open your world" modal instead of summoning into a dead
   * port. As a side effect it also refreshes main's cached LAN state (so the
   * getLanPort() the actual summon reads is fresh too).
   */
  lanCheckNow(): Promise<LanState>;
  /** Subscribe to per-install progress events during runWizardInstall. */
  onWizardProgress(cb: (ev: WizardProgressEvent) => void): Unsubscribe;
  /** Subscribe to streaming progress for an in-flight persona expansion
   *  (chars:save). Filter events by the `expansionRequestId` you passed. */
  onExpansionProgress(cb: (ev: ExpansionProgressEvent) => void): Unsubscribe;
  /**
   * Fires when an OPTIONAL update (minor/major bump) is detected — at startup
   * (delayed) or after a manual "Check for updates". The renderer shows the
   * up-front changelog popup; download happens only on consent. Mandatory
   * (patch-only) updates download silently and never push this.
   */
  onUpdateAvailable(cb: (info: UpdateAvailableEvent) => void): Unsubscribe;
  /** Fires when a manual update check starts (Settings → Checking…). */
  onUpdateChecking(cb: () => void): Unsubscribe;
  /** Fires when an update check completes with no newer version (Up to date). */
  onUpdateNotAvailable(cb: () => void): Unsubscribe;
  /** Download-progress ticks while an accepted/mandatory update downloads. */
  onUpdateProgress(cb: (ev: UpdateProgressEvent) => void): Unsubscribe;
  /** Fires when a download completed and the app is ready to install. */
  onUpdateDownloaded(cb: (ev: UpdateDownloadedEvent) => void): Unsubscribe;
  /** Fires when an update check or download errored (best-effort surface). */
  onUpdateError(cb: (message: string) => void): Unsubscribe;
  /** Fires on launch when there's a post-update changelog to show. */
  onWhatsNew(cb: (ev: WhatsNewEvent) => void): Unsubscribe;
  /**
   * Pull any pending post-update changelog on mount. The `onWhatsNew` push
   * fires during early main bootstrap and races the renderer attaching its
   * listener (it has no buffering), so a forced restart could swallow it. The
   * renderer also calls this once on mount; returns the event (and consumes it)
   * or null. Mirrors the `lan:get` snapshot-pull that guards the same race.
   */
  getWhatsNew(): Promise<WhatsNewEvent | null>;
  /** Manually trigger an update check (Settings "Check for updates"). */
  checkForUpdates(): Promise<void>;
  /** Consent to download an available optional update (popup "Update now"). */
  downloadUpdate(): Promise<void>;
  /** Quit and install a downloaded update (optional flow, after "restarting…"). */
  installUpdate(): Promise<void>;
  /** Current app version string (Settings → current version display). */
  getVersion(): Promise<string>;
  /**
   * Host OS platform (`process.platform`), read once in preload and exposed as
   * a plain value so the renderer can branch its window chrome WITHOUT an async
   * round-trip. Used by MacosWindow to render custom min/max/close controls on
   * Windows/Linux (frameless) and keep the native traffic-light layout on macOS.
   * Typed `string` (not `NodeJS.Platform`) because this contract is also compiled
   * in the web/renderer tsconfig where the NodeJS namespace isn't available; the
   * renderer only ever compares it against `'darwin'`.
   */
  platform: string;
  /** Frameless window controls (Windows/Linux custom titlebar). */
  windowMinimize(): Promise<void>;
  /** Toggle maximize/restore for the focused window. */
  windowMaximizeToggle(): Promise<void>;
  /** Close the window (quits the app on the last window). */
  windowClose(): Promise<void>;
  /** Current maximized state — seeds the restore/maximize icon on mount. */
  windowIsMaximized(): Promise<boolean>;
  /** Fires on every maximize/unmaximize so the icon can swap live. */
  onWindowMaximizedChanged(cb: (isMaximized: boolean) => void): Unsubscribe;
  /**
   * Fires when the active account profile scope changes at runtime (sign-in,
   * sign-out, or account swap) once main has torn down the old bot, switched
   * the data scope, and initialized the new profile. The renderer re-bootstraps
   * its stores + routing in response (260603 per-profile partitioning).
   */
  onScopeChanged(cb: (ev: ScopeChangedEvent) => void): Unsubscribe;
  /* ── Unique-companion generation (260703 procgen) ─────────────────────── */
  /**
   * Run the full unique-companion pipeline (cloud mode + signed-in only):
   * soulcaster-1 character sheet → parallel { portrait via proxy image gen →
   * img2skin skin } + persona expansion → save (kind 'unique', shared false).
   * Long-running (~30–90s); subscribe to onGenProgress with the same
   * requestId for stage ticks. Never throws for expected failures — returns
   * the discriminated GenerateUniqueResult instead.
   */
  generateUnique(input: GenerateUniqueInput): Promise<GenerateUniqueResult>;
  /** Subscribe to generation pipeline stage ticks (filter by requestId). */
  onGenProgress(cb: (ev: GenProgressEvent) => void): Unsubscribe;
  /**
   * Read the user-profile questionnaire state: local config.user_profile
   * merged with the cloud user_preferences row (cloud wins). `needed` drives
   * the first-sign-in questionnaire gate.
   */
  prefsGet(): Promise<PrefsGetResult>;
  /** Persist questionnaire answers locally + upsert to cloud user_preferences. */
  prefsSave(profile: UserPreferences): Promise<void>;
}

/** Payload pushed by main when the active profile scope switches. */
export interface ScopeChangedEvent {
  /** The new active scope: `'local'` (signed out) or a Supabase user UUID. */
  scope: string;
  /** Why the scope changed — drives renderer copy/telemetry only. */
  reason: 'sign-in' | 'sign-out' | 'switch';
}

/** Result of inspecting the `local` profile for importable data (260603). */
export interface PeekLocalProfileResult {
  /** Non-default, user-created character ids present in the local profile. */
  migratableCharacterIds: string[];
  mcUsername: string | null;
  preferredName: string | null;
  /** True when there is anything worth offering to import. */
  hasData: boolean;
}

/** Result of importing the `local` profile into the signed-in account (260603). */
export interface ImportLocalProfileResult {
  imported: string[];
  failed: string[];
  /** Whether mc_username / preferred_name were copied into the account profile. */
  copiedOnboarding: boolean;
}

/** Payload pushed by main when an update is detected (quick/260604-uoy). */
export interface UpdateAvailableEvent {
  latestVersion: string;
  currentVersion: string;
  downloadUrl: string;
  /** Legacy field — kept for backward-compat; superseded by `changelog`. */
  notes?: string;
  /**
   * Policy level derived from semver (see main/updatePolicy.deriveLevel).
   * Only `optional` reaches the renderer as `app:update-available` (mandatory
   * downloads silently); included so the popup can render the optional flow.
   */
  level: 'optional' | 'mandatory';
  /** Mandatory-update apply timing from version.json (optional updates omit). */
  apply?: 'on-restart' | 'now';
  /** Human changelog (markdown-ish) for the up-front optional-update popup. */
  changelog?: string;
}

/** Download-progress tick while an update is downloading (Flow C). */
export interface UpdateProgressEvent {
  /** 0..100 download percentage. */
  percent: number;
}

/** Pushed when an update finished downloading and is ready to install. */
export interface UpdateDownloadedEvent {
  /**
   * True for a `apply: 'now'` mandatory update — the renderer shows a
   * non-dismissable "Critical update — restarting…" overlay and main restarts
   * automatically. False for the optional flow — the renderer shows a brief
   * "restarting…" then invokes `app:update-install`.
   */
  forced: boolean;
  /**
   * True for a mandatory `apply: 'on-restart'` (patch-only) update. The renderer
   * shows a DISMISSABLE "Update ready — restart to apply" popup (with a
   * "Restart now" button) instead of leaving the download bar stuck at 100%.
   * The update still installs on the next quit via `autoInstallOnAppQuit`; the
   * button just lets the user restart immediately. Mutually exclusive with
   * `forced`; absent/false on the optional consented flow.
   */
  onRestart?: boolean;
}

/** Post-update "what's new" changelog shown on the next launch (Flow D). */
export interface WhatsNewEvent {
  version: string;
  changelog: string;
}

/* -------------------------------------------------------------------------- */
/*  IPC channel string constants — single source of truth for both sides       */
/* -------------------------------------------------------------------------- */

export const IpcChannel = {
  bot: {
    summon: 'bot:summon',
    stop: 'bot:stop',
    status: 'bot:status',
    // Snapshot pull of the current per-character statuses (see
    // RendererApi.getBotStatuses) — pushes only fire on transitions.
    getStatuses: 'bot:get-statuses',
    logBatch: 'bot:log:batch',
  },
  /**
   * Phase 15 (D-10/VIS-03): dedicated bot→main→renderer push for the active
   * provider's vision capability. A separate top-level namespace (NOT folded
   * into bot.status) so the BotStatus discriminated union the CharacterPage row
   * consumes stays unchanged. Payload: VisionCapability { visionCapable }.
   */
  vision: {
    capability: 'vision:capability',
  },
  lan: {
    state: 'lan:state',
    // Pull the current LAN state on demand. The `state` push only fires on
    // CHANGE, so a freshly-(re)loaded renderer must request the snapshot —
    // relying on a replay-push races the renderer attaching its listener.
    get: 'lan:get',
    // Force ONE fresh detection pass right now and return its result (260703).
    // Unlike `get` (a cached snapshot that can be up to ~4s stale under the
    // poll's open→closed hysteresis), this reads live ground truth — the summon
    // click uses it so a world that just closed doesn't summon into a dead port.
    checkNow: 'lan:check-now',
  },
  chars: {
    list: 'chars:list',
    get: 'chars:get',
    save: 'chars:save',
    // Push channel (main → renderer): streaming persona-expansion progress
    // emitted while chars:save runs the LLM call. Tagged with the caller's
    // expansionRequestId so the renderer can filter to its own save.
    expansionProgress: 'chars:expansion-progress',
    delete: 'chars:delete',
    resetMemory: 'chars:reset-memory',
    // Phase 11 D-28 — portrait pipeline moves from inline base64 to a file
    // keyed by UUID. The renderer canvas-resizes + re-encodes to PNG (≤1024²,
    // ≤500KB) and hands the bytes here; main validatePortrait re-checks +
    // atomic-writes to <userData>/portraits/<uuid>.png.
    applyPortrait: 'chars:apply-portrait',
    removePortrait: 'chars:remove-portrait',
    // Phase 11 D-16 — toggle a character's `shared` flag (public listing
    // visibility). Defaults are rejected by the handler. Triggers the
    // standard cloud-mirror upsert via saveCharacter.
    setShared: 'chars:set-shared',
    // Pre-flight daily character-creation quota check (persona_daily cap).
    // Renderer calls this before entering the new-character flow.
    checkCreateQuota: 'chars:check-create-quota',
    // Phase 11 plan 17 — list the UUIDs of the signed-in user's cloud
    // characters. Drives the renderer's "LOCAL ONLY" chip on legacy local
    // chars (chars present locally but absent from the cloud row set).
    // Signed-out → returns { ids: [] }; failure → returns { ids: [] } so
    // the chip never flickers on transient network issues.
    listCloud: 'chars:list-cloud',
    // Phase 11 plan 19 (D-19, LIB-04) — cache-on-demand sync.
    //   openPrepare — invoked by HomeScreen / CharacterPage just before
    //                 navigating into a character. If the character is not
    //                 yet on local disk, downloads the row + skin + portrait
    //                 and writes them via saveCharacterRaw + atomic-write.
    //                 No-op when the local JSON already exists.
    //   listMerged  — returns local + cloud rows deduped by id with a
    //                 `source: 'local' | 'cloud' | 'both'` annotation so
    //                 HomeScreen can render cloud-only entries with a
    //                 CLOUD chip alongside fully-cached characters.
    openPrepare: 'chars:open-prepare',
    listMerged: 'chars:list-merged',
    // Re-add a bundled default (sui/lyra/clawd) to the user's library after
    // they removed it via the gear menu. Clears the id from
    // UserConfig.removed_default_ids; the on-disk file was never deleted.
    restoreDefault: 'chars:restore-default',
    // Add a non-default foreign-owned character (from the World tab) to
    // the signed-in user's library. Downloads + caches locally and writes
    // the id into UserConfig.added_world_ids so the Home grid surfaces it.
    addToLibrary: 'chars:add-to-library',
    // Remove a foreign-owned World character from the user's library:
    // strip from added_world_ids + wipe the local cache. NEVER touches the
    // cloud row (the user doesn't own it).
    removeFromLibrary: 'chars:remove-from-library',
  },
  config: {
    get: 'config:get',
    save: 'config:save',
    saveApiKey: 'config:save-api-key',
    hasApiKey: 'config:has-api-key',
  },
  // 260703 procgen — unique-companion generation pipeline + user-profile
  // questionnaire (see GenerateUniqueInput / GenProgressEvent / PrefsGetResult).
  gen: {
    start: 'gen:start',
    // Push channel (main → renderer): pipeline stage ticks, tagged with the
    // caller's requestId (same filtering pattern as chars:expansion-progress).
    progress: 'gen:progress',
  },
  prefs: {
    get: 'prefs:get',
    save: 'prefs:save',
  },
  chat: {
    history: 'chat:history',
    send: 'chat:send',
    clear: 'chat:clear',
    /** Push (main → renderer): a companion/system message authored outside a
     * send() round-trip — the live game bot replying to a routed message, or a
     * deterministic "joined/left your world" system line. */
    message: 'chat:message',
  },
  voice: {
    /** Invoke: synthesize a spoken line ({characterId, text} → ArrayBuffer of audio/mpeg). */
    tts: 'voice:tts',
    /** Invoke: open/hang-up a voice call ({characterId, active}). */
    callState: 'voice:call-state',
  },
  user: {
    getProfile: 'user:get-profile',
    applyProfilePicture: 'user:apply-profile-picture',
    removeProfilePicture: 'user:remove-profile-picture',
  },
  app: {
    ready: 'app:ready',
    warnings: 'app:warnings',
    // ── In-app updater (quick/260604-uoy) ────────────────────────────────────
    // Push (main → renderer):
    updateAvailable: 'app:update-available',       // optional update detected
    updateChecking: 'app:update-checking',         // a check started (Settings)
    updateNotAvailable: 'app:update-not-available', // check completed, up to date
    updateProgress: 'app:update-progress',         // download-progress {percent}
    updateDownloaded: 'app:update-downloaded',      // ready to install {forced}
    updateError: 'app:update-error',               // check/download failed
    whatsNew: 'app:whats-new',                     // post-update changelog
    // Invoke (renderer → main):
    updateCheck: 'app:update-check',               // manual "Check for updates"
    updateDownload: 'app:update-download',         // optional-accept download
    updateInstall: 'app:update-install',           // quitAndInstall
    whatsNewGet: 'app:whats-new-get',               // pull pending post-update changelog (race-proof)
    version: 'app:version',                         // app.getVersion()
    // 260603 per-profile partitioning: main pushes this AFTER the active
    // account scope has switched (sign-in / sign-out / account swap) and the
    // new profile is initialized + bot stopped. The renderer re-bootstraps
    // (reloads config + characters, re-routes to onboarding-or-home) on it.
    scopeChanged: 'app:scope-changed',
    // Phase 11 plan 12 — main-side validated launcher of OS browser for
    // ToS / Privacy links from the renderer. The renderer can't call
    // shell.openExternal directly (contextIsolation), and we don't want to
    // let it pass arbitrary URLs through — the handler URL-allowlists to
    // sei.gg before dispatching to shell.openExternal (T-11-12-01).
    openExternal: 'app:open-external',
  },
  // Frameless window controls (custom titlebar on Windows/Linux). macOS keeps
  // its native traffic lights and never calls these, but the channels are
  // platform-agnostic so the renderer can wire them unconditionally.
  window: {
    minimize: 'window:minimize',
    maximizeToggle: 'window:maximize-toggle',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    maximizedChanged: 'window:maximized-changed', // push: main → renderer
  },
  // Skin pipeline.
  skin: {
    apply: 'skin:apply',
    remove: 'skin:remove',
    uploadPng: 'skin:upload-png',
    searchMojang: 'skin:search-mojang',
    getServerUrl: 'skin:get-server-url',
  },
  // Setup wizard. `cancel` crosses the IPC boundary to abort an in-flight
  // install — a renderer-local AbortController cannot reach the main-process
  // child running `java -jar fabric-installer`.
  // `progress` is a push channel (main → renderer) for per-install progress events.
  wizard: {
    detectInstalls: 'wizard:detect-installs',
    install: 'wizard:install',
    cancel: 'wizard:cancel',
    getState: 'wizard:get-state',
    progress: 'wizard:progress',
    // One-time "run skin setup" nudge shown on first summon attempt. Read
    // ('get') / persist ('set') a profile-scoped flag so the prompt fires at
    // most once per account.
    promptShown: 'wizard:prompt-shown',
  },
  auth: {
    state: 'auth:state',
    signinPassword: 'auth:signin-password',
    signupPassword: 'auth:signup-password',
    signinGoogle: 'auth:signin-google',
    cancelGoogle: 'auth:cancel-google',
    signout: 'auth:signout',
    deleteAccount: 'auth:delete-account',
    exportData: 'auth:export-data',
    resendVerification: 'auth:resend-verification',
    sendPasswordReset: 'auth:send-password-reset',
    updatePassword: 'auth:update-password',
    passwordRecovery: 'auth:password-recovery',
    // 260603 anti-abuse — renderer hands a solved Turnstile/hCaptcha token to
    // main before signup (inert until bot-protection is enabled). See captcha.ts.
    setCaptchaToken: 'auth:set-captcha-token',
  },
  // Phase 11 — cloud-sync queue surface. status is request/response; retry is
  // request/response (force-retry a failed op); statusUpdate is a one-way
  // push channel (main → renderer) fired whenever the queue mutates.
  sync: {
    status: 'sync:status',
    retry: 'sync:retry',
    statusUpdate: 'sync:status:update',
  },
  // Phase 11 plan 12 — ToS / Privacy acceptance gate.
  // `status` returns whether the current signed-in user has an accepted row
  // matching the active TOS_VERSION + PRIVACY_VERSION (used by Plan 11-13's
  // launch-time blocking modal); `accept` records acceptance for the current
  // user. Both go through tosGate.{isTosAccepted, recordAcceptance}.
  tos: {
    status: 'tos:status',
    accept: 'tos:accept',
  },
  // Phase 11 plan 18 (D-20) — one-shot local→cloud migration modal IPC.
  //   listLocal — returns the signed-in user's "LOCAL ONLY" character set
  //               (chars present on this machine but not in the cloud row
  //               set). Excludes is_default characters. Returns [] for
  //               signed-out users and on listMyCharacters failure.
  //   upload    — sequentially uploads the selected uuids via
  //               cloudCharacterClient.upsertCharacter + uploadSkin +
  //               uploadPortrait. Gated on isCloudWriteAllowed; partial
  //               failures returned per-uuid so the modal can show row
  //               results.
  //   shown     — read or set the "already-prompted" flag persisted at
  //               <userData>/migration-modal-shown.json. The auto-mount
  //               on sign-in consults this; Settings re-open bypasses it.
  migration: {
    listLocal: 'migration:list-local',
    upload: 'migration:upload',
    shown: 'migration:shown',
  },
  // 260603 per-profile partitioning — on-device anonymous(local)→account import.
  profile: {
    peekLocal: 'profile:peek-local',
    importFromLocal: 'profile:import-from-local',
  },
  // Phase 12 — Browse + moderation + reports.
  //   list                  — paged listing of public moderation-clean
  //                           characters. NOT gated on cloud writes — Browse
  //                           is read-public per LIB-04 (signed-out users see
  //                           the same listing as signed-in users).
  browse: {
    list: 'browse:list',
  },
  // B4: the capabilities channel + BROWSE_ENABLED flag were removed — the
  // World (formerly Browse) tab is always available. If future feature flags
  // are needed, a new channel can be re-introduced here.
  // Phase 13 — proxy + billing + credits (PROXY-11 + D-57).
  //
  // Stub-handler surface registered today; Wave 2/3 swap the placeholder
  // returns for real proxy-client / Edge Function calls without changing
  // the channel names or argument shapes. Renderer plans 13-16+ build
  // against this contract.
  //
  //   proxy:configure        — persist aiBackendKind ('local' | 'cloud-proxy').
  //                             Wave 3: refuses 'cloud-proxy' for signed-out
  //                             users.
  //   trial:claim            — claim the one-time free trial. Wave 3 calls
  //                             the `trial-claim` Edge Function which
  //                             enforces UNIQUE(mc_username) (D-42).
  //   credits:get            — snapshot of CreditsStatus. Refreshed by the
  //                             credits:status:update push channel below.
  //   credits:openCheckout   — open the Polar checkout (proxy-minted session)
  //                             for the requested product.
  //   subscription:status    — read SubscriptionStatusInfo from
  //                             `subscription_status` table (D-46/47).
  //   subscription:cancel    — open the Polar customer portal
  //                             so the user can cancel.
  //   credits:status:update  — PUSH (main → renderer). Fires after every
  //                             proxied Anthropic response carrying a new
  //                             X-Sei-Remaining-Pct header (D-41).
  //   credits:hard-stop      — PUSH (main → renderer). Fires on 402 or
  //                             0% remaining or per-user rate-bucket trip.
  proxy: {
    configure: 'proxy:configure',
  },
  trial: {
    claim: 'trial:claim',
  },
  credits: {
    get: 'credits:get',
    openCheckout: 'credits:openCheckout',
    statusUpdate: 'credits:status:update',
    hardStop: 'credits:hard-stop',
  },
  subscription: {
    status: 'subscription:status',
    cancel: 'subscription:cancel',
    // quick/260525-sbo Task 3 — auto-renewal consent record.
    recordConsent: 'subscription:record-consent',
  },
} as const;

export type IpcChannelName =
  | typeof IpcChannel.bot[keyof typeof IpcChannel.bot]
  | typeof IpcChannel.lan[keyof typeof IpcChannel.lan]
  | typeof IpcChannel.chars[keyof typeof IpcChannel.chars]
  | typeof IpcChannel.config[keyof typeof IpcChannel.config]
  | typeof IpcChannel.app[keyof typeof IpcChannel.app]
  | typeof IpcChannel.skin[keyof typeof IpcChannel.skin]
  | typeof IpcChannel.wizard[keyof typeof IpcChannel.wizard]
  | typeof IpcChannel.auth[keyof typeof IpcChannel.auth]
  | typeof IpcChannel.sync[keyof typeof IpcChannel.sync]
  | typeof IpcChannel.tos[keyof typeof IpcChannel.tos]
  | typeof IpcChannel.migration[keyof typeof IpcChannel.migration]
  | typeof IpcChannel.browse[keyof typeof IpcChannel.browse]
  | typeof IpcChannel.proxy[keyof typeof IpcChannel.proxy]
  | typeof IpcChannel.trial[keyof typeof IpcChannel.trial]
  | typeof IpcChannel.credits[keyof typeof IpcChannel.credits]
  | typeof IpcChannel.subscription[keyof typeof IpcChannel.subscription];
