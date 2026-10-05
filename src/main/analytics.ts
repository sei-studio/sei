/**
 * PostHog product analytics — main-process owner (260707).
 *
 * Consent model: OPT-OUT (analytics ON by default), disclosed in
 * ../sei-website/privacy.html. `capture()` is a hard no-op when
 * `config.analytics_opt_out` is true OR no ingestion key is baked into the
 * build, so a build with no key (self-hosters / from-source) sends nothing.
 *
 * Privacy invariant: NEVER send PII. Only counts, enums, durations, versions,
 * and platform facts leave the machine — never chat/persona text, world names,
 * Minecraft usernames, or emails. `sanitize()` is a backstop that drops
 * free-form objects and truncates strings on every renderer-supplied payload.
 *
 * Identity: `distinctId` is the Supabase user id when signed in, else a
 * stable per-profile anonymous install UUID (`config.analytics_install_id`,
 * minted here on first init). On sign-in `identifyUser()` alias()es the
 * anonymous id into the account so pre-sign-in activity is not orphaned. Only
 * a signed-up user (who passed the ephemeral COPPA 13+ gate) is ever
 * identified by account id.
 */
import { app } from 'electron';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { loadConfig, updateConfig } from './configStore';
import { getAiBackendKind, onAiBackendKindChanged } from './apiKeyStore';
import { ATTRIBUTION_EVENT, ATTRIBUTION_PERSON_PROP, isAttributionSource } from '../shared/attribution';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/**
 * Public, write-only PostHog project API key. `phc_` keys can only INGEST
 * events (never read data), so they are safe to embed in a distributed client
 * — this is how PostHog is designed to ship. Overridable at build time via a
 * POSTHOG_KEY define (electron.vite.config.ts). Empty / placeholder ⇒ analytics
 * disabled (no-op), keeping .env-less from-source builds silent.
 */
const POSTHOG_KEY = (process.env.POSTHOG_KEY ?? 'phc_srnfn2HQDxcGyadVKFz9qRzEv7Rr2XTtzMpNbgPc2F7R').trim();
const POSTHOG_HOST = (process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com').trim();

/**
 * Tag on every event so the desktop app's events are distinguishable from the
 * marketing site's events in the shared PostHog project (495635). All app
 * dashboards/insights filter on `client == 'desktop-app'`.
 */
const CLIENT_TAG = 'desktop-app';

let client: PostHog | null = null;
let installId = '';
let optedOut = false;
let backendKind: 'local' | 'cloud-proxy' = 'local';
let signedInUserId: string | null = null;
let appVersion = '0.0.0';
/**
 * 261005: whether the active profile has finished onboarding (has a
 * preferred_name). Until it has, `backend` reads 'unset' rather than the
 * schema default 'local': before this, every pre-onboarding event (and every
 * install that never finished onboarding) was counted as a BYOK user.
 */
let profileOnboarded = true;

/**
 * Pre-init queue (261005). initAnalytics runs late in bootstrap (after the
 * IPC handlers and the auth restore, which can wait on a network refresh),
 * and the renderer is already showing onboarding by then, so its first
 * events used to hit a null client and vanish. They are held here, bounded,
 * and replayed with their original timestamps once init knows whether a key
 * is configured and the user has not opted out; otherwise they are dropped.
 */
let initDone = false;
/** The opt-out flag was actually read from config. If that read failed, the
 * user's choice is unknown, so the held events are dropped, never replayed. */
let consentRead = false;
const PRE_INIT_MAX = 200;
const preInitQueue: Array<{ event: string; props?: Record<string, unknown>; at: number }> = [];

/**
 * 261005: the product surface of the most recent activity, for `app_quit`.
 * Fed from event names in capture() plus noteSurface() for activity that has
 * no event of its own (a chat message, a call going live).
 */
let lastSurface: string | null = null;
const sessionStartedAt = Date.now();
/** app_quit already sent this process (captureAppQuit is once-only). */
let appQuitCaptured = false;

/** True once a usable ingestion key is configured (not the placeholder). */
function keyConfigured(): boolean {
  return POSTHOG_KEY.length > 0 && POSTHOG_KEY.startsWith('phc_') && !POSTHOG_KEY.includes('REPLACE_WITH');
}

/**
 * Initialize the client, mint/read the anonymous install id, and cache the
 * opt-out flag + backend kind. Call once from bootstrap() after config is
 * reachable. Never throws — analytics must never block startup.
 */
export async function initAnalytics(): Promise<void> {
  try {
    await initAnalyticsInner();
  } finally {
    initDone = true;
    replayPreInit();
  }
}

async function initAnalyticsInner(): Promise<void> {
  try {
    appVersion = app.getVersion();
  } catch {
    /* app not fully ready — version stays default */
  }
  // Seed the anonymous install id + read the opt-out flag under the file lock.
  try {
    const next = await updateConfig((cfg) => {
      if (!cfg.analytics_install_id) {
        return { ...cfg, analytics_install_id: randomUUID() };
      }
      return cfg;
    });
    installId = next.analytics_install_id ?? '';
    optedOut = next.analytics_opt_out === true;
    consentRead = true;
    setUiLanguage(next.ui_language);
    setProfileOnboarded(next.preferred_name);
  } catch (err) {
    logger.warn(`analytics: config init failed: ${(err as Error).message}`);
  }
  // Subscribe BEFORE the initial read so a config write that lands between
  // the two can't be missed; apiKeyStore fires this for every ai_backend_kind
  // writer (explicit switch, sign-in cloud default, boot self-heal).
  onAiBackendKindChanged((kind) => {
    backendKind = kind;
  });
  try {
    backendKind = await getAiBackendKind();
  } catch {
    /* default 'local' */
  }
  if (!keyConfigured()) {
    logger.info('analytics: no ingestion key configured — analytics disabled');
    return;
  }
  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 20,
      flushInterval: 10_000,
    });
    logger.info(`analytics: initialized (opt_out=${optedOut}, backend=${backendKind})`);
  } catch (err) {
    logger.warn(`analytics: client init failed: ${(err as Error).message}`);
    client = null;
  }
}

/**
 * Cached UserConfig.ui_language ('en' | 'zh'), the APP UI language — not the
 * per-character conversation language. 260801: before this, the only trace of
 * a non-English user anywhere in the cloud was `characters.metadata.language`,
 * which is stamped at character CREATION, so anyone who only ever used the
 * bundled defaults was invisible. Cached rather than read per event because
 * commonProps() is synchronous and config is a locked file read; refreshed by
 * setUiLanguage() from the config:save IPC handler, which is the only path
 * either UI writes it through.
 */
let uiLanguage = 'en';

/** Refresh the cached ui_language. Called after a renderer config save. */
export function setUiLanguage(lang: string | undefined | null): void {
  uiLanguage = lang === 'zh' ? 'zh' : 'en';
}

/** Refresh the cached onboarded flag from a profile's preferred_name. */
export function setProfileOnboarded(preferredName: string | undefined | null): void {
  profileOnboarded = typeof preferredName === 'string' && preferredName.trim() !== '';
}

/** Re-read it from the active profile's config (after a scope switch). Never throws. */
export async function refreshProfileOnboarded(): Promise<void> {
  try {
    setProfileOnboarded((await loadConfig()).preferred_name);
  } catch {
    /* keep the cached value */
  }
}

/** The `backend` property: 'unset' until the profile is onboarded on the default kind. */
export function backendProp(kind: 'local' | 'cloud-proxy', onboarded: boolean): 'local' | 'cloud-proxy' | 'unset' {
  return !onboarded && kind === 'local' ? 'unset' : kind;
}

/** Properties attached to every event. All non-PII, all enum/scalar. */
function commonProps(): Record<string, unknown> {
  const backend = backendProp(backendKind, profileOnboarded);
  return {
    client: CLIENT_TAG,
    app_version: appVersion,
    os: process.platform,
    arch: process.arch,
    os_release: os.release(),
    backend,
    is_cloud: backendKind === 'cloud-proxy',
    ui_language: uiLanguage,
    // Keep the person profile's latest platform/version/backend/language up to
    // date, so "how many users run the app in Chinese" is one person query
    // rather than a scan over events.
    $set: { client: CLIENT_TAG, app_version: appVersion, os: process.platform, backend, ui_language: uiLanguage },
  };
}

const KEY_RE = /^[a-z0-9_]+$/;

/**
 * Backstop against content leakage in renderer-supplied payloads: keep only
 * snake_case keys with scalar (string/number/boolean/null) values, truncating
 * strings. Objects, arrays, and functions are dropped so no free-form text
 * (chat, persona, world names) can ever ride along.
 */
function sanitize(props?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (!KEY_RE.test(k)) continue;
    if (v === null) {
      out[k] = null;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = v.slice(0, 200);
    }
    // everything else (object/array/function/undefined) is intentionally dropped
  }
  return out;
}

function distinctId(): string {
  return signedInUserId ?? installId;
}

/**
 * Person properties derived from a (sanitized) event, 261001. Renderer props
 * can never carry `$set` themselves (sanitize drops objects and `$` keys), so
 * the few answers that should segment every later event are mapped here from
 * a closed enum. Today that is only the onboarding attribution answer:
 * `$set_once`, so the first answer on a person wins, and a skip sets nothing.
 */
export function personPropsFor(event: string, props: Record<string, unknown>): Record<string, unknown> {
  if (event === ATTRIBUTION_EVENT && isAttributionSource(props.source)) {
    return { $set_once: { [ATTRIBUTION_PERSON_PROP]: props.source } };
  }
  return {};
}

/**
 * Capture an event. No-op when analytics is disabled or opted out. Safe to call
 * from anywhere in main; never throws.
 */
export function capture(event: string, props?: Record<string, unknown>): void {
  noteSurface(surfaceForEvent(event));
  if (!initDone) {
    // Opt-out is not known yet: hold, never send. Dropped if init finds the
    // user opted out or no key (replayPreInit).
    if (preInitQueue.length < PRE_INIT_MAX) {
      preInitQueue.push({ event, props: props ? { ...props } : undefined, at: Date.now() });
    }
    return;
  }
  send(event, props);
}

function send(event: string, props: Record<string, unknown> | undefined, at?: number): void {
  if (!client || optedOut) return;
  const id = distinctId();
  if (!id) return;
  try {
    const clean = sanitize(props);
    client.capture({
      distinctId: id,
      event,
      properties: { ...commonProps(), ...clean, ...personPropsFor(event, clean) },
      ...(at !== undefined ? { timestamp: new Date(at) } : {}),
    });
  } catch (err) {
    logger.warn(`analytics: capture(${event}) failed: ${(err as Error).message}`);
  }
}

function replayPreInit(): void {
  const held = preInitQueue.splice(0);
  if (!consentRead) return;
  for (const e of held) send(e.event, e.props, e.at);
}

/** Test seam: the pre-init state back to a fresh process. */
export function _resetPreInitForTests(done = false): void {
  initDone = done;
  consentRead = false;
  preInitQueue.length = 0;
  lastSurface = null;
  appQuitCaptured = false;
}

/** Event name → product surface, for app_quit.last_surface. null = not a surface event. */
export function surfaceForEvent(event: string): string | null {
  if (event.startsWith('chat_') || event.startsWith('first_moment_')) return 'chat';
  if (event.startsWith('voice_call_')) return 'voice';
  if (event.startsWith('chess_')) return 'chess';
  if (event.startsWith('draw_')) return 'draw';
  if (event.startsWith('backseat_')) return 'backseat';
  if (event === 'character_summoned' || event.startsWith('bot_session_') || event.startsWith('summon_')) return 'game';
  if (event.startsWith('onboarding_')) return 'onboarding';
  if (event === 'pricing_viewed' || event === 'checkout_opened' || event === 'credit_wall_action') return 'credits';
  return null;
}

/** Record activity on a surface that has no event of its own. */
export function noteSurface(surface: string | null): void {
  if (surface) lastSurface = surface;
}

/**
 * `app_quit {session_ms, last_surface}` (261005). Captured first thing in
 * before-quit, ahead of the flush. `session_ms` counts from this process's
 * start, so an update relaunch is its own session.
 */
export function captureAppQuit(now: number = Date.now()): void {
  // Once per process: before-quit can fire again while the async teardown is
  // still running (a second Cmd+Q, quitAndInstall's own quit after the
  // window-all-closed one), and each run would send another app_quit.
  if (appQuitCaptured) return;
  appQuitCaptured = true;
  capture('app_quit', { session_ms: Math.max(0, now - sessionStartedAt), last_surface: lastSurface ?? 'none' });
}

/**
 * Diagnostic long-text allowlist (260720): the ONLY keys allowed past
 * sanitize()'s 200-char truncation, and only via captureDiagnostic(). Callers
 * MUST pre-redact these fields (diagnostics.redact strips home paths, API
 * keys, JWTs, and chat/prompt log content) — this layer only enforces length.
 */
const DIAG_LONG_TEXT_KEYS: readonly string[] = ['stderr_tail', 'stdout_tail', 'error_message'];
const DIAG_LONG_TEXT_CAP = 8192;

/**
 * sanitize() plus the diagnostic long-text allowlist. Exported for tests.
 * `*_tail` keys keep the END of the string (the crash is at the bottom);
 * everything else keeps the head. All other keys get standard sanitize()
 * treatment (snake_case scalars only, 200-char strings, objects dropped).
 */
export function sanitizeDiagnostic(props?: Record<string, unknown>): Record<string, unknown> {
  const out = sanitize(props);
  if (!props) return out;
  for (const k of DIAG_LONG_TEXT_KEYS) {
    const v = props[k];
    if (typeof v === 'string') {
      out[k] = k.endsWith('_tail') ? v.slice(-DIAG_LONG_TEXT_CAP) : v.slice(0, DIAG_LONG_TEXT_CAP);
    }
  }
  return out;
}

/**
 * Capture a diagnostic event carrying pre-redacted long text (failed-summon
 * stderr/stdout tails + error message, 260720). Identical opt-out and
 * missing-key gating to capture(); the only difference is the allowlisted
 * per-field 8KB cap above. Never throws.
 */
export function captureDiagnostic(event: string, props?: Record<string, unknown>): void {
  if (!client || optedOut) return;
  const id = distinctId();
  if (!id) return;
  try {
    client.capture({
      distinctId: id,
      event,
      properties: { ...commonProps(), ...sanitizeDiagnostic(props) },
    });
  } catch (err) {
    logger.warn(`analytics: captureDiagnostic(${event}) failed: ${(err as Error).message}`);
  }
}

/**
 * Dedupe window for captureDiagnosticThrottled (260828): identical consecutive
 * diagnostics (same event + caller-supplied key) collapse to at most one
 * shipped event per window.
 */
export const DIAG_THROTTLE_WINDOW_MS = 5 * 60_000;
/** Bound on the throttle map so a long session can never grow it unbounded. */
const DIAG_THROTTLE_MAX_KEYS = 200;

const diagThrottle = new Map<string, { at: number; suppressed: number }>();

/**
 * captureDiagnostic with per-key throttling (260828). Motivated by a
 * production retry loop that shipped 56 identical `summon_failed` events
 * (same character + error_class) in 13 minutes. Within `windowMs` of the last
 * SHIPPED event for `key`, repeats are counted but not sent; the next shipped
 * event carries `repeat_count` = itself plus everything suppressed since the
 * previous ship, so the dashboard keeps the true occurrence count. A distinct
 * key (different character / class / phase) is never delayed by another key's
 * window. Same no-op gating as captureDiagnostic; never throws.
 */
export function captureDiagnosticThrottled(
  event: string,
  key: string,
  props?: Record<string, unknown>,
  windowMs: number = DIAG_THROTTLE_WINDOW_MS,
): void {
  const fullKey = `${event}|${key}`;
  const now = Date.now();
  const entry = diagThrottle.get(fullKey);
  if (entry && now - entry.at < windowMs) {
    entry.suppressed += 1;
    return;
  }
  // Prune: drop expired entries first; if still at the cap, drop the oldest.
  if (!diagThrottle.has(fullKey) && diagThrottle.size >= DIAG_THROTTLE_MAX_KEYS) {
    for (const [k, v] of diagThrottle) {
      if (now - v.at >= windowMs) diagThrottle.delete(k);
    }
    if (diagThrottle.size >= DIAG_THROTTLE_MAX_KEYS) {
      const oldest = diagThrottle.keys().next();
      if (!oldest.done) diagThrottle.delete(oldest.value);
    }
  }
  const repeatCount = (entry?.suppressed ?? 0) + 1;
  diagThrottle.set(fullKey, { at: now, suppressed: 0 });
  captureDiagnostic(event, { ...props, repeat_count: repeatCount });
}

/** Test seam: drop all throttle state. */
export function resetDiagThrottleForTest(): void {
  diagThrottle.clear();
}

// ── Surface errors (260828) ─────────────────────────────────────────────────

/**
 * The non-Minecraft AI surfaces. Until 260828 only the summon path emitted a
 * failure event — chat, voice calls, chess, Draw!, and backseat failures were
 * invisible in analytics.
 */
export type ErrorSurface = 'chat' | 'voice' | 'chess' | 'draw' | 'backseat';

/** error_class must be a short stable snake token — never a raw message. */
const ERROR_CLASS_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Capture a `surface_error` event: which surface failed and a SHORT STABLE
 * error class token. Shape-never-content: a value that does not look like a
 * snake token (someone passed a raw error message) ships as 'invalid_class'
 * rather than the string. Same no-op gating as capture(); never throws.
 * Emit only on genuine failures — never on user-initiated ends or aborts.
 */
export function captureSurfaceError(
  surface: ErrorSurface,
  errorClass: string,
  characterId?: string,
): void {
  const cls = ERROR_CLASS_RE.test(errorClass) ? errorClass : 'invalid_class';
  capture('surface_error', {
    surface,
    error_class: cls,
    ...(characterId ? { character_id: characterId } : {}),
  });
}

/**
 * Classify an arbitrary caught error into a stable shape token for
 * surface_error's error_class. Message-sniffing only: the MESSAGE never
 * leaves the machine through this path. Lives in ./surfaceErrorClass (pure,
 * no electron) since 260926, which added the local/BYOK provider classes
 * (connection_refused, model_not_found, context_length, ...).
 */
export { surfaceErrorClass } from './surfaceErrorClass';

/**
 * True while events are attributed to a signed-in account (260720): the
 * failed-summon diagnostic stamps this as `signed_in` so cloud-auth failure
 * modes (expired JWT and friends) separate from anonymous/BYOK ones.
 */
export function isSignedInAnalytics(): boolean {
  return signedInUserId !== null;
}

/**
 * Attach subsequent events to a signed-in cloud account. Aliases the
 * pre-sign-in anonymous install id into the account so its activity is not
 * orphaned, then identifies. Idempotent-ish (PostHog dedupes aliases).
 */
export function identifyUser(userId: string): void {
  signedInUserId = userId;
  if (!client || optedOut) return;
  try {
    if (installId && installId !== userId) {
      client.alias({ distinctId: userId, alias: installId });
    }
    client.identify({
      distinctId: userId,
      properties: { backend: backendKind, is_cloud: backendKind === 'cloud-proxy', app_version: appVersion },
    });
  } catch (err) {
    logger.warn(`analytics: identify failed: ${(err as Error).message}`);
  }
}

/** Detach from the signed-in account (sign-out) — revert to anonymous id. */
export function resetUser(): void {
  signedInUserId = null;
}

/** Read the persisted opt-out flag (source of truth for the Settings toggle). */
export async function getAnalyticsOptOut(): Promise<boolean> {
  try {
    const cfg = await loadConfig();
    optedOut = cfg.analytics_opt_out === true;
  } catch {
    /* fall back to cached */
  }
  return optedOut;
}

/** Persist + apply the opt-out flag. When opting out, capture() stops at once. */
export async function setAnalyticsOptOut(optOut: boolean): Promise<void> {
  optedOut = optOut;
  try {
    await updateConfig((cfg) => ({ ...cfg, analytics_opt_out: optOut }));
  } catch (err) {
    logger.warn(`analytics: persist opt-out failed: ${(err as Error).message}`);
  }
}

/**
 * Privacy re-consent (260720): the user just ACCEPTED the current Terms +
 * Privacy versions (AcceptToSModal → tos:accept). The current privacy.html
 * discloses product analytics + crash diagnostics, so an explicit acceptance
 * re-baselines consent: clear any prior opt-out in the same profile-scoped
 * config.json that capture() reads. The Settings "Usage analytics" toggle
 * remains the ongoing opt-out after this point. Must be called ONLY from an
 * actual acceptance event (the tos:accept IPC handler after recordAcceptance
 * succeeds), never at launch. Never throws.
 */
export async function reenableAnalyticsOnConsent(): Promise<void> {
  await setAnalyticsOptOut(false);
}

/** True while a live client exists (used to keep before-quit teardown alive to flush). */
export function isAnalyticsActive(): boolean {
  return client !== null;
}

/**
 * Upper bound on the quit-time flush (260929). posthog-node's own default is
 * 30s, and before-quit awaits this BEFORE the supervisor drains the bots, so
 * with PostHog unreachable (blocked network, dead proxy) quitting hung for
 * 30s with the companion still standing in the world. A healthy batch POST
 * takes well under a second.
 */
export const ANALYTICS_SHUTDOWN_TIMEOUT_MS = 2500;

/** Flush + close the client. Call from the before-quit teardown chain. */
export async function shutdownAnalytics(timeoutMs: number = ANALYTICS_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown(timeoutMs);
  } catch (err) {
    // posthog-node rejects its timeout with a bare string, not an Error.
    logger.warn(`analytics: shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  client = null;
}
