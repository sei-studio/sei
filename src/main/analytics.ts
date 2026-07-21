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
import { getAiBackendKind } from './apiKeyStore';

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
  } catch (err) {
    logger.warn(`analytics: config init failed: ${(err as Error).message}`);
  }
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

/** Properties attached to every event. All non-PII, all enum/scalar. */
function commonProps(): Record<string, unknown> {
  return {
    client: CLIENT_TAG,
    app_version: appVersion,
    os: process.platform,
    arch: process.arch,
    os_release: os.release(),
    backend: backendKind,
    is_cloud: backendKind === 'cloud-proxy',
    // Keep the person profile's latest platform/version/backend up to date.
    $set: { client: CLIENT_TAG, app_version: appVersion, os: process.platform, backend: backendKind },
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
 * Capture an event. No-op when analytics is disabled or opted out. Safe to call
 * from anywhere in main; never throws.
 */
export function capture(event: string, props?: Record<string, unknown>): void {
  if (!client || optedOut) return;
  const id = distinctId();
  if (!id) return;
  try {
    client.capture({
      distinctId: id,
      event,
      properties: { ...commonProps(), ...sanitize(props) },
    });
  } catch (err) {
    logger.warn(`analytics: capture(${event}) failed: ${(err as Error).message}`);
  }
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

/** Keep the cached backend kind in sync when the user switches local↔cloud. */
export function setAnalyticsBackendKind(kind: 'local' | 'cloud-proxy'): void {
  backendKind = kind;
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

/** Flush + close the client. Call from the before-quit teardown chain. */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    logger.warn(`analytics: shutdown flush failed: ${(err as Error).message}`);
  }
  client = null;
}
