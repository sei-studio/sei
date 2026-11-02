/**
 * 261017 (issue #46): the ChatGPT-plan session manager. Main owns the tokens
 * and the refresh; everything else (main's LLM provider, the bots) asks it
 * for a fresh ACCESS token and never sees the refresh token.
 *
 * State machine per saved registration (one record per issued client_id +
 * verified subject):
 *
 *   (none) --signIn(new)--> signed in --signOut--> signed out (record kept:
 *      ^                       |  ^                  client_id, email, host id)
 *      |                       |  +--signIn(reauth)------+
 *      |                       +--terminal refresh error--> signed out
 *
 * A sign-in attempt never touches stored state until its ID token verified
 * (signature, iss, aud = issued client id, exp, nonce) and, for a returning
 * account, its subject matched. Granted scopes without
 * chatgpt.tokens.use.direct keep the sign-in but mark plan usage disabled.
 *
 * Refresh is SINGLE-FLIGHT per account: the refresh token rotates on every
 * use, so two concurrent refreshes would burn the session. A temporary
 * network failure never erases credentials; only a terminal refresh error
 * code (TERMINAL_REFRESH_ERRORS) clears the token set.
 *
 * Usage-limit handling: a CHATGPT_USAGE_LIMIT answer latches the account
 * (`usageLimited`); every provider checks the latch first and fails fast
 * without a request, so a game brain cannot hammer the plan. The latch is
 * released by the user's "Try again", a sign-in or account switch, or after
 * USAGE_LIMIT_PROBE_MS (one probe request, never a retry storm; no reset time
 * is inferred from the code).
 *
 * Pure: every effect is an injected dep, so session.test.ts drives the whole
 * thing against a mocked auth server. src/main/chatgptPlan/index.ts wires
 * the Electron deps.
 */
import { isProviderRegionRefusal } from '../../bot/brain/llm/regionRefusal.js';
import {
  CHATGPT_MODELS_URL,
  CHATGPT_PLAN_SCOPE,
  chatgptAccountLabels,
  parseChatgptModels,
  type ChatgptModel,
  type ChatgptSignInFailure,
  type ChatgptSignInResult,
  type ChatgptSignOutResult,
  type ChatgptStatus,
} from '../../shared/chatgptPlan';
import {
  IdTokenError,
  OAuthError,
  buildAuthorizeUrl,
  createJwksSource,
  createPkce,
  discoverEndpoints,
  exchangeCode,
  isTerminalRefreshError,
  randomToken,
  redactAuthorizeUrl,
  refreshTokens,
  revokeRefreshToken,
  validateCallback,
  verifyIdToken,
  type FetchLike,
  type JwksSource,
  type OidcEndpoints,
  type TokenResponse,
} from './oauth';
import type { CallbackListener } from './loopback';

// ─── Stored shape ─────────────────────────────────────────────────────────

/** One registration's credential record (the docs' local credential file). */
export interface StoredAccount {
  id: string;
  email: string | null;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string;
  expires_in: number;
  /** Absolute expiry, epoch ms (saved_at + expires_in). */
  expires_at: number | null;
  earliest_refresh_at: number | null;
  scopes: string[];
  saved_at: string;
}

export interface VaultData {
  version: 1;
  accounts: StoredAccount[];
  activeId: string | null;
  welcomeSeen: boolean;
}

export interface ChatgptVault {
  /** Identity of the current backing store (the active profile's path). */
  key(): string;
  load(): Promise<VaultData>;
  save(data: VaultData): Promise<void>;
}

export function emptyVault(): VaultData {
  return { version: 1, accounts: [], activeId: null, welcomeSeen: false };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseVault(raw: unknown): VaultData {
  const r = (raw ?? {}) as Record<string, unknown>;
  const accounts: StoredAccount[] = [];
  for (const a of Array.isArray(r.accounts) ? r.accounts : []) {
    const x = (a ?? {}) as Record<string, unknown>;
    const subject = str(x.subject);
    const clientId = str(x.client_id);
    if (!subject || !clientId) continue;
    accounts.push({
      id: str(x.id) ?? accountIdOf(clientId, subject),
      email: str(x.email),
      issuer: str(x.issuer) ?? 'https://auth.openai.com',
      subject,
      client_id: clientId,
      ext_agent_host_id: str(x.ext_agent_host_id) ?? '',
      id_token: str(x.id_token),
      access_token: str(x.access_token),
      refresh_token: str(x.refresh_token),
      token_type: str(x.token_type) ?? 'Bearer',
      expires_in: num(x.expires_in) ?? 3600,
      expires_at: num(x.expires_at),
      earliest_refresh_at: num(x.earliest_refresh_at),
      scopes: Array.isArray(x.scopes) ? (x.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : [],
      saved_at: str(x.saved_at) ?? new Date(0).toISOString(),
    });
  }
  const activeId = str(r.activeId);
  return {
    version: 1,
    accounts,
    activeId: activeId && accounts.some((a) => a.id === activeId) ? activeId : null,
    welcomeSeen: r.welcomeSeen === true,
  };
}

export function accountIdOf(clientId: string, subject: string): string {
  return `${clientId}:${subject}`;
}

const isSignedIn = (a: StoredAccount): boolean => !!a.access_token && !!a.refresh_token;
const planEnabled = (a: StoredAccount): boolean => a.scopes.includes(CHATGPT_PLAN_SCOPE);

// ─── Errors handed to providers ───────────────────────────────────────────

export function chatgptError(code: string, detail: string, terminal: boolean): Error & { code: string; terminal: boolean } {
  const e = new Error(`${code}: ${detail}`) as Error & { code: string; terminal: boolean; retryable?: boolean };
  e.code = code;
  e.terminal = terminal;
  if (!terminal) e.retryable = true;
  return e;
}

/**
 * Terminal answers latched per account until a sign-in, an account switch or
 * clearBlock(): asking again would only fail the same way (or, for a
 * rejected sign-in, loop a refresh + 401 on every turn).
 */
const LATCHED_BLOCKS = new Set([
  'CHATGPT_NOT_ELIGIBLE',
  'CHATGPT_FORBIDDEN',
  'CHATGPT_AUTH_REJECTED',
  'CHATGPT_REQUEST_REJECTED',
]);

const BLOCKED_DETAIL: Record<string, string> = {
  CHATGPT_AUTH_REJECTED: 'ChatGPT did not accept the sign-in. Sign in with ChatGPT again in Settings',
  CHATGPT_REQUEST_REJECTED: "ChatGPT rejected Sei's request. Try again, or pick another AI option",
  default: 'ChatGPT plan usage is not available for this account right now',
};

// ─── Deps + tuning ────────────────────────────────────────────────────────

export interface ChatgptSessionDeps {
  vault: ChatgptVault;
  hostId: () => Promise<string>;
  fetchImpl: FetchLike;
  openExternal: (url: string) => Promise<void>;
  /** Bound to this attempt's state: other callbacks are ignored. */
  startListener: (expectedState: string) => Promise<CallbackListener>;
  now?: () => number;
  log?: (line: string) => void;
  /** Override the JWKS source (tests sign with their own key). */
  jwks?: JwksSource;
  /** Override discovery (tests); default reads the well-known document. */
  discover?: () => Promise<OidcEndpoints>;
  signInTimeoutMs?: number;
  revokeBackoffMs?: number;
}

/** How long sign-out waits for a refresh already on the wire. */
const SIGN_OUT_SETTLE_MS = 5_000;

/** Refresh this long before expiry. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** The usage-limit pause, after which ONE request may probe again. */
export const USAGE_LIMIT_PROBE_MS = 15 * 60_000;

export interface AccessToken {
  token: string;
  expiresAt: number | null;
  accountId: string;
}

export type TokenListener = (t: AccessToken | null) => void;
export type StatusListener = (s: ChatgptStatus) => void;

/**
 * A verified "Continue with ChatGPT" account-login sign-in that is not saved
 * yet (261023). Lives only in main's memory between the browser round trip
 * and the Sei session; never crosses IPC.
 */
export interface PendingLoginAccount {
  idToken: string;
  clientId: string;
  subject: string;
  issuer: string;
  email: string | null;
  hostId: string;
  tokens: TokenResponse & { refresh_token: string };
  /** Epoch ms the token response arrived (expiry is relative to it). */
  receivedAt: number;
  planEnabled: boolean;
}

export type LoginSignInResult =
  | { ok: true; pending: PendingLoginAccount }
  | { ok: false; reason: ChatgptSignInFailure; message?: string };

export interface ChatgptSession {
  status(): Promise<ChatgptStatus>;
  signIn(opts?: { accountId?: string | null; enablePlan?: boolean }): Promise<ChatgptSignInResult>;
  /**
   * Account login: browser sign-in with the proxy's nonce; saves nothing.
   * forceConsent asks OpenAI to show the consent screen again (plan usage
   * after a decline), as signIn's enablePlan does.
   */
  signInForLogin(opts: {
    nonce: string;
    target?: { client_id: string; id_token: string | null; email: string | null } | null;
    forceConsent?: boolean;
  }): Promise<LoginSignInResult>;
  /**
   * The reauth target of a saved plan account (its issued client, last ID
   * token as the hint, and its subject), so a login-path sign-in can renew
   * THAT account like signIn({accountId}) does. Null for an unknown id.
   */
  loginTargetFor(accountId: string): Promise<{ client_id: string; id_token: string | null; email: string | null; subject: string } | null>;
  /** Save a login's registration into the CURRENT profile's vault, active. */
  adoptLoginAccount(p: PendingLoginAccount): Promise<ChatgptSignInResult>;
  /** Revoke a login's grant that will not be kept. Best effort. */
  discardLoginAccount(p: PendingLoginAccount): Promise<void>;
  cancelSignIn(): void;
  signOut(accountId?: string): Promise<ChatgptSignOutResult>;
  switchAccount(accountId: string): Promise<ChatgptStatus>;
  getAccessToken(opts?: { force?: boolean }): Promise<AccessToken>;
  /** Fail fast when a latch says requests are paused (no network). */
  assertUsable(): void;
  /** Record a terminal plan answer from a provider (latches + status push). */
  reportError(err: unknown): void;
  clearBlock(): Promise<ChatgptStatus>;
  dismissWelcome(): Promise<ChatgptStatus>;
  listModels(opts?: { force?: boolean }): Promise<ChatgptModel[]>;
  cachedModels(): ChatgptModel[];
  hasActiveSession(): Promise<boolean>;
  onToken(fn: TokenListener): () => void;
  onStatus(fn: StatusListener): () => void;
}

export function createChatgptSession(deps: ChatgptSessionDeps): ChatgptSession {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const jwks = deps.jwks ?? createJwksSource(deps.fetchImpl);
  const discover = deps.discover ?? (() => discoverEndpoints(deps.fetchImpl));
  const signInTimeoutMs = deps.signInTimeoutMs ?? 5 * 60_000;

  let cache: { key: string; data: VaultData } | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  const refreshing = new Map<string, Promise<AccessToken>>();
  // Per-account token generation. Sign-in and sign-out bump it; a refresh
  // that started under an older generation never commits its result (the
  // sign-out/refresh race would otherwise write tokens back after sign-out).
  const epochs = new Map<string, number>();
  const epochOf = (id: string): number => epochs.get(id) ?? 0;
  const bump = (id: string): void => {
    epochs.set(id, epochOf(id) + 1);
  };
  let attempt: AbortController | null = null;
  let usageLimitedUntil = 0;
  let usageLimitedAccount: string | null = null;
  let blocked: { code: string; accountId: string | null } | null = null;
  const models = new Map<string, ChatgptModel[]>();
  const tokenListeners = new Set<TokenListener>();
  const statusListeners = new Set<StatusListener>();

  async function data(): Promise<VaultData> {
    const key = deps.vault.key();
    if (!cache || cache.key !== key) {
      const loaded = await deps.vault.load();
      // Profile switched: drop every in-memory latch tied to the old accounts.
      if (cache && cache.key !== key) {
        usageLimitedUntil = 0;
        usageLimitedAccount = null;
        blocked = null;
        models.clear();
      }
      cache = { key, data: loaded };
    }
    return cache.data;
  }

  /**
   * Serialized read-modify-write of the vault. `fn` edits a COPY, which
   * becomes the cached state only once it is saved: a failed save (keychain
   * unavailable) leaves memory exactly as it was on disk.
   */
  function mutate<T>(fn: (d: VaultData) => T): Promise<T> {
    const run = writeChain.then(async () => {
      const d = await data();
      const key = cache!.key;
      const next = structuredClone(d);
      const out = fn(next);
      await deps.vault.save(next);
      if (cache && cache.key === key) cache.data = next;
      return out;
    });
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const activeOf = (d: VaultData): StoredAccount | null => d.accounts.find((a) => a.id === d.activeId) ?? null;

  function usageLimitedNow(accountId: string | null): boolean {
    return !!accountId && usageLimitedAccount === accountId && now() < usageLimitedUntil;
  }

  async function status(): Promise<ChatgptStatus> {
    const d = await data();
    const labels = chatgptAccountLabels(d.accounts);
    return {
      accounts: d.accounts.map((a) => ({
        id: a.id,
        email: a.email,
        label: labels.get(a.id) ?? a.email ?? 'ChatGPT account',
        signedIn: isSignedIn(a),
        planEnabled: planEnabled(a),
      })),
      activeId: d.activeId,
      signingIn: attempt !== null,
      usageLimited: usageLimitedNow(d.activeId),
      blockedCode: blocked && blocked.accountId === d.activeId ? blocked.code : null,
      welcomeSeen: d.welcomeSeen,
      models: d.activeId ? (models.get(d.activeId) ?? []) : [],
    };
  }

  async function emitStatus(): Promise<void> {
    if (statusListeners.size === 0) return;
    const s = await status();
    for (const fn of statusListeners) {
      try { fn(s); } catch { /* listener errors never break the session */ }
    }
  }

  function emitToken(t: AccessToken | null): void {
    for (const fn of tokenListeners) {
      try { fn(t); } catch { /* ignore */ }
    }
  }

  function applyTokens(rec: StoredAccount, t: TokenResponse, receivedAt: number = now()): void {
    // Access token, expiry, scopes and the rotating refresh token are
    // replaced TOGETHER (docs, "Store credentials").
    rec.access_token = t.access_token;
    if (t.refresh_token) rec.refresh_token = t.refresh_token;
    if (t.id_token) rec.id_token = t.id_token;
    rec.token_type = t.token_type;
    rec.expires_in = t.expires_in;
    rec.expires_at = receivedAt + t.expires_in * 1000;
    rec.earliest_refresh_at = t.earliest_refresh_at;
    if (t.scopes.length) rec.scopes = t.scopes;
    rec.saved_at = new Date(now()).toISOString();
  }

  const tokenOf = (r: StoredAccount): AccessToken => ({ token: r.access_token!, expiresAt: r.expires_at, accountId: r.id });

  function clearTokens(rec: StoredAccount, { keepIdToken }: { keepIdToken: boolean }): void {
    rec.access_token = null;
    rec.refresh_token = null;
    rec.expires_at = null;
    rec.earliest_refresh_at = null;
    if (!keepIdToken) rec.id_token = null;
  }

  // ── Sign-in ────────────────────────────────────────────────────────────

  function fail(reason: ChatgptSignInFailure, message?: string): ChatgptSignInResult {
    return { ok: false, reason, ...(message ? { message } : {}) };
  }

  interface AuthorizeTarget {
    client_id: string;
    id_token: string | null;
    email: string | null;
  }

  type Authorized =
    | {
        ok: true;
        clientId: string;
        hostId: string;
        tokens: TokenResponse & { id_token: string; refresh_token: string };
        claims: Awaited<ReturnType<typeof verifyIdToken>>;
        receivedAt: number;
      }
    | { ok: false; result: ChatgptSignInResult };

  /**
   * One browser round trip: authorize, callback, code exchange, ID-token
   * verification. Touches no stored state. `attempt` must already be this
   * call's controller.
   */
  async function authorize(
    ctrl: AbortController,
    p: { target: AuthorizeTarget | null; nonce: string; forceConsent: boolean; label: string },
    onListener: (l: CallbackListener) => void,
  ): Promise<Authorized> {
    const no = (reason: ChatgptSignInFailure, message?: string): Authorized => ({ ok: false, result: fail(reason, message) });
    const hostId = await deps.hostId();
    const endpoints = await discover();
    const state = randomToken();
    let listener: CallbackListener;
    try {
      listener = await deps.startListener(state);
    } catch (err) {
      return no('port_unavailable', (err as Error).message);
    }
    onListener(listener);
    const pkce = createPkce();
    const pending = {
      state,
      nonce: p.nonce,
      verifier: pkce.verifier,
      redirectUri: listener.redirectUri,
      issuedClientId: p.target?.client_id ?? null,
    };
    const url = buildAuthorizeUrl({
      endpoint: endpoints.authorization_endpoint,
      issuedClientId: pending.issuedClientId,
      hostId,
      redirectUri: pending.redirectUri,
      state,
      nonce: p.nonce,
      codeChallenge: pkce.challenge,
      idTokenHint: p.target?.id_token ?? null,
      loginHint: p.target?.email ?? null,
      forceConsent: p.forceConsent,
    });
    log(`[chatgpt] ${p.label} ${p.target ? 'reauth' : 'new registration'} via ${redactAuthorizeUrl(url)}`);
    try {
      await deps.openExternal(url);
    } catch (err) {
      return no('browser_failed', (err as Error).message);
    }
    let q: URLSearchParams;
    try {
      q = await listener.wait(signInTimeoutMs, ctrl.signal);
    } catch (err) {
      return no((err as Error).message === 'timeout' ? 'timeout' : 'cancelled');
    }
    const outcome = validateCallback(q, pending);
    if (outcome.kind === 'invalid') return no(outcome.reason === 'no_code' ? 'exchange_failed' : outcome.reason);
    if (outcome.kind === 'denied') {
      log(`[chatgpt] ${p.label} declined (${outcome.error})`);
      if (isProviderRegionRefusal(`${outcome.error} ${outcome.description ?? ''}`)) return no('region_unsupported', outcome.error);
      return no(outcome.error === 'access_denied' ? 'denied' : 'exchange_failed', outcome.error);
    }

    let tokens: TokenResponse;
    try {
      tokens = await exchangeCode(deps.fetchImpl, {
        tokenEndpoint: endpoints.token_endpoint,
        clientId: outcome.clientId,
        code: outcome.code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
      });
    } catch (err) {
      if (err instanceof OAuthError && err.network) return no('network');
      // 261103 (T303): OpenAI refuses the token exchange from an unsupported
      // region (403 unsupported_country_region_territory).
      if (isProviderRegionRefusal(err)) return no('region_unsupported');
      // invalid_grant: the code is discarded; the user starts a fresh attempt.
      return no('exchange_failed', err instanceof OAuthError ? (err.oauthError ?? undefined) : undefined);
    }
    const receivedAt = now();
    if (!tokens.id_token || !tokens.refresh_token) {
      return no('exchange_failed', !tokens.id_token ? 'no id_token' : 'no refresh_token');
    }
    let claims;
    try {
      claims = await verifyIdToken(tokens.id_token, { jwks, clientId: outcome.clientId, nonce: p.nonce, now: now() });
    } catch (err) {
      return no('id_token_invalid', err instanceof IdTokenError ? err.reason : 'verification failed');
    }
    return {
      ok: true,
      clientId: outcome.clientId,
      hostId,
      tokens: tokens as TokenResponse & { id_token: string; refresh_token: string },
      claims,
      receivedAt,
    };
  }

  /** Save (insert or replace tokens of) one registration and make it active. */
  async function commitAccount(a: {
    id: string;
    email: string | null;
    issuer: string;
    subject: string;
    clientId: string;
    hostId: string;
    tokens: TokenResponse;
    receivedAt: number;
  }): Promise<{ ok: true; enabled: boolean } | { ok: false; result: ChatgptSignInResult }> {
    let enabled = false;
    // A refresh still in flight for this account must not overwrite the
    // tokens this sign-in is about to store.
    bump(a.id);
    try {
      await mutate((v) => {
        let rec = v.accounts.find((x) => x.id === a.id);
        if (!rec) {
          rec = {
            id: a.id,
            email: a.email,
            issuer: a.issuer,
            subject: a.subject,
            client_id: a.clientId,
            ext_agent_host_id: a.hostId,
            id_token: null,
            access_token: null,
            refresh_token: null,
            token_type: 'Bearer',
            expires_in: 3600,
            expires_at: null,
            earliest_refresh_at: null,
            scopes: [],
            saved_at: new Date(now()).toISOString(),
          };
          v.accounts.push(rec);
        }
        if (a.email) rec.email = a.email;
        rec.ext_agent_host_id = a.hostId;
        applyTokens(rec, a.tokens, a.receivedAt);
        // Build scopes from the token response (an empty scope string
        // means "none granted", never "keep the old ones" here).
        rec.scopes = a.tokens.scopes;
        v.activeId = a.id;
        enabled = planEnabled(rec);
      });
    } catch (err) {
      return {
        ok: false,
        result: fail(
          (err as Error).message === 'KEYCHAIN_UNAVAILABLE' ? 'keychain_unavailable' : 'exchange_failed',
          (err as Error).message,
        ),
      };
    }
    usageLimitedUntil = 0;
    usageLimitedAccount = null;
    blocked = null;
    models.delete(a.id);
    log(`[chatgpt] signed in (${enabled ? 'plan usage enabled' : 'plan usage NOT granted'})`);
    if (enabled) {
      emitToken({ token: a.tokens.access_token, expiresAt: a.receivedAt + a.tokens.expires_in * 1000, accountId: a.id });
    }
    return { ok: true, enabled };
  }

  async function signIn(opts: { accountId?: string | null; enablePlan?: boolean } = {}): Promise<ChatgptSignInResult> {
    attempt?.abort();
    const ctrl = new AbortController();
    attempt = ctrl;
    void emitStatus();
    let listener: CallbackListener | null = null;
    try {
      const d = await data();
      const target = opts.accountId ? (d.accounts.find((a) => a.id === opts.accountId) ?? null) : null;
      if (opts.accountId && !target) return fail('exchange_failed', 'unknown account');
      const nonce = randomToken();
      const got = await authorize(
        ctrl,
        { target, nonce, forceConsent: opts.enablePlan === true, label: 'sign-in' },
        (l) => (listener = l),
      );
      if (!got.ok) return got.result;
      const { claims } = got;
      if (target && claims.sub !== target.subject) {
        // A different ChatGPT account answered a reauth: never overwrite.
        return fail('account_mismatch');
      }
      if (ctrl.signal.aborted) return fail('cancelled');

      const email = typeof claims.email === 'string' && claims.email ? claims.email : null;
      const saved = await commitAccount({
        id: accountIdOf(got.clientId, claims.sub),
        email,
        issuer: claims.iss,
        subject: claims.sub,
        clientId: got.clientId,
        hostId: got.hostId,
        tokens: got.tokens,
        receivedAt: got.receivedAt,
      });
      if (!saved.ok) return saved.result;
      return { ok: true, status: await status(), planEnabled: saved.enabled };
    } finally {
      (listener as CallbackListener | null)?.close();
      if (attempt === ctrl) attempt = null;
      void emitStatus();
    }
  }

  /**
   * 261023 "Continue with ChatGPT" as a SEI ACCOUNT login. Same browser flow,
   * but with the nonce Sei's proxy issued (so the proxy can check it) and
   * nothing saved: the caller sends the ID token to the proxy, and only once
   * a Sei session exists (and the profile scope moved to that account) hands
   * the result back to adoptLoginAccount, which stores it in THAT account's
   * vault. A reauth target here only reuses the install's issued client id;
   * a different ChatGPT account answering it is fine (the proxy decides).
   */
  async function signInForLogin(opts: { nonce: string; target?: AuthorizeTarget | null; forceConsent?: boolean }): Promise<LoginSignInResult> {
    attempt?.abort();
    const ctrl = new AbortController();
    attempt = ctrl;
    void emitStatus();
    let listener: CallbackListener | null = null;
    try {
      const got = await authorize(
        ctrl,
        { target: opts.target ?? null, nonce: opts.nonce, forceConsent: opts.forceConsent === true, label: 'account login' },
        (l) => (listener = l),
      );
      if (!got.ok) return got.result as LoginSignInResult;
      if (ctrl.signal.aborted) return { ok: false, reason: 'cancelled' };
      const { claims } = got;
      // Diagnostics for the account policy: claim NAMES and the
      // email_verified value only. Never a token or a claim value.
      const ev = claims.email_verified;
      log(
        `[chatgpt] account login id_token claims: ${Object.keys(claims).sort().join(',')}; ` +
          `email_verified=${ev === undefined ? 'absent' : JSON.stringify(ev)}`,
      );
      return {
        ok: true,
        pending: {
          idToken: got.tokens.id_token,
          clientId: got.clientId,
          subject: claims.sub,
          issuer: claims.iss,
          email: typeof claims.email === 'string' && claims.email ? claims.email : null,
          hostId: got.hostId,
          tokens: got.tokens,
          receivedAt: got.receivedAt,
          planEnabled: got.tokens.scopes.includes(CHATGPT_PLAN_SCOPE),
        },
      };
    } finally {
      (listener as CallbackListener | null)?.close();
      if (attempt === ctrl) attempt = null;
      void emitStatus();
    }
  }

  async function loginTargetFor(accountId: string): Promise<(AuthorizeTarget & { subject: string }) | null> {
    const d = await data();
    const a = d.accounts.find((x) => x.id === accountId);
    return a ? { client_id: a.client_id, id_token: a.id_token, email: a.email, subject: a.subject } : null;
  }

  /** Store a login's ChatGPT registration in the CURRENT profile's vault and activate it. */
  async function adoptLoginAccount(p: PendingLoginAccount): Promise<ChatgptSignInResult> {
    const saved = await commitAccount({
      id: accountIdOf(p.clientId, p.subject),
      email: p.email,
      issuer: p.issuer,
      subject: p.subject,
      clientId: p.clientId,
      hostId: p.hostId,
      tokens: p.tokens,
      receivedAt: p.receivedAt,
    });
    if (!saved.ok) return saved.result;
    void emitStatus();
    return { ok: true, status: await status(), planEnabled: saved.enabled };
  }

  /** Drop a login's tokens that will never be stored (cancelled or refused). */
  async function discardLoginAccount(p: PendingLoginAccount): Promise<void> {
    try {
      const endpoints = await discover();
      await revokeRefreshToken(deps.fetchImpl, {
        revocationEndpoint: endpoints.revocation_endpoint,
        clientId: p.clientId,
        refreshToken: p.tokens.refresh_token,
        attempts: 1,
      });
    } catch {
      /* best effort: the grant simply goes unused */
    }
  }

  function cancelSignIn(): void {
    attempt?.abort();
  }

  // ── Sign-out / switch ──────────────────────────────────────────────────

  async function signOut(accountId?: string): Promise<ChatgptSignOutResult> {
    const d = await data();
    const id = accountId ?? d.activeId;
    const rec = id ? d.accounts.find((a) => a.id === id) : undefined;
    if (!rec) return { ok: true, revoked: true, status: await status() };
    // New generation first: a refresh already on the wire can no longer
    // commit, and it revokes the token it was handed (doRefresh).
    bump(rec.id);
    const clientId = rec.client_id;
    // Stop requests first: drop the token everywhere before the network call.
    // The token to revoke is read inside the serialized write, so it is the
    // NEWEST one even if a refresh committed a rotation a moment ago.
    const refreshToken = await mutate((v) => {
      const r = v.accounts.find((a) => a.id === rec.id);
      const newest = r?.refresh_token ?? null;
      // Account/client mapping, email and host id are KEPT for a later sign-in.
      if (r) clearTokens(r, { keepIdToken: false });
      return newest;
    });
    if (d.activeId === rec.id) emitToken(null);
    // Give an in-flight refresh a moment to settle (it discards its result
    // and revokes its rotated token itself). Correctness does not depend on
    // this wait (the generation bump does that), so it is bounded.
    const inflight = refreshing.get(rec.id);
    if (inflight) {
      await Promise.race([inflight.catch(() => undefined), new Promise((r) => setTimeout(r, SIGN_OUT_SETTLE_MS))]);
    }
    let revoked = true;
    if (refreshToken) {
      const endpoints = await discover();
      revoked = await revokeRefreshToken(deps.fetchImpl, {
        revocationEndpoint: endpoints.revocation_endpoint,
        clientId,
        refreshToken,
        backoffMs: deps.revokeBackoffMs,
      });
      log(`[chatgpt] signed out (${revoked ? 'revoked' : 'revocation not confirmed'})`);
    }
    models.delete(rec.id);
    void emitStatus();
    return { ok: true, revoked, status: await status() };
  }

  async function switchAccount(accountId: string): Promise<ChatgptStatus> {
    await mutate((v) => {
      if (v.accounts.some((a) => a.id === accountId)) v.activeId = accountId;
    });
    usageLimitedUntil = 0;
    usageLimitedAccount = null;
    blocked = null;
    const d = await data();
    const rec = activeOf(d);
    if (rec && isSignedIn(rec) && planEnabled(rec)) {
      emitToken({ token: rec.access_token!, expiresAt: rec.expires_at, accountId: rec.id });
    } else {
      emitToken(null);
    }
    void emitStatus();
    return status();
  }

  // ── Tokens ─────────────────────────────────────────────────────────────

  function signedOut(detail: string): Error {
    return chatgptError('CHATGPT_SIGNED_OUT', `${detail}. Sign in with ChatGPT again in Settings.`, true);
  }

  function assertUsable(): void {
    const d = cache?.data;
    const id = d?.activeId ?? null;
    if (usageLimitedNow(id)) {
      throw chatgptError(
        'CHATGPT_USAGE_LIMIT',
        'ChatGPT plan usage limit reached. Requests are paused; manage usage in ChatGPT settings',
        true,
      );
    }
    if (blocked && blocked.accountId === id) {
      throw chatgptError(blocked.code, BLOCKED_DETAIL[blocked.code] ?? BLOCKED_DETAIL.default, true);
    }
  }

  async function doRefresh(rec: StoredAccount): Promise<AccessToken> {
    const epoch = epochOf(rec.id);
    const used = rec.refresh_token!;
    const endpoints = await discover();
    let t: TokenResponse;
    try {
      t = await refreshTokens(deps.fetchImpl, {
        tokenEndpoint: endpoints.token_endpoint,
        clientId: rec.client_id,
        refreshToken: used,
      });
    } catch (err) {
      if (isTerminalRefreshError(err)) {
        // Clear only the token set this refresh was about: a sign-in that
        // landed meanwhile stored a new, good one.
        const out = await mutate((v): { cleared: boolean; current: AccessToken | null } => {
          const r = v.accounts.find((a) => a.id === rec.id);
          if (!r) return { cleared: false, current: null };
          if (r.refresh_token !== used) {
            // A re-sign-in replaced the rejected set meanwhile: its token is
            // the answer, not "signed out".
            return { cleared: false, current: isSignedIn(r) ? tokenOf(r) : null };
          }
          // Keep the id_token: it is the id_token_hint for the re-auth.
          clearTokens(r, { keepIdToken: true });
          return { cleared: true, current: null };
        });
        log(`[chatgpt] refresh rejected (${(err as OAuthError).oauthError})${out.cleared ? '; token set cleared' : ''}`);
        if (out.cleared) {
          emitToken(null);
          void emitStatus();
        }
        if (out.current) return out.current;
        throw signedOut('the ChatGPT session expired');
      }
      if (err instanceof OAuthError && err.oauthError === 'invalid_client') {
        throw signedOut('the ChatGPT app registration was not accepted (invalid_client)');
      }
      // Temporary failure: credentials stay; an unexpired token still works.
      if (epochOf(rec.id) === epoch && rec.access_token && rec.expires_at && rec.expires_at > now()) {
        return { token: rec.access_token, expiresAt: rec.expires_at, accountId: rec.id };
      }
      throw chatgptError('CHATGPT_UNAVAILABLE', 'could not refresh the ChatGPT sign-in, try again shortly', false);
    }
    // Commit only if nothing replaced or cleared this token set while the
    // request was on the wire (sign-out, a re-sign-in).
    const result = await mutate((v): { kind: 'ok'; tok: AccessToken } | { kind: 'stale'; current: AccessToken | null } | null => {
      const r = v.accounts.find((a) => a.id === rec.id);
      if (!r) return null;
      if (epochOf(rec.id) !== epoch || r.refresh_token !== used) {
        return { kind: 'stale', current: isSignedIn(r) ? tokenOf(r) : null };
      }
      applyTokens(r, t);
      return { kind: 'ok', tok: tokenOf(r) };
    });
    if (!result || result.kind === 'stale') {
      // Signed out meanwhile: the rotated token is live at the server but
      // belongs to nobody, so revoke it (in the background: a dead network
      // must not hold this caller or a sign-out for the revoke backoff).
      // A re-sign-in meanwhile is left alone: if the server revokes per
      // grant, revoking the old family's token could end the NEW sign-in.
      if (t.refresh_token && !result?.current) {
        void revokeRefreshToken(deps.fetchImpl, {
          revocationEndpoint: endpoints.revocation_endpoint,
          clientId: rec.client_id,
          refreshToken: t.refresh_token,
          backoffMs: deps.revokeBackoffMs,
        }).catch(() => false);
      }
      log('[chatgpt] refresh result discarded (signed out or re-signed in meanwhile)');
      if (result?.current) return result.current;
      throw signedOut(result ? 'the ChatGPT sign-in ended' : 'the ChatGPT account was removed');
    }
    const fresh = result.tok;
    // Same tick as the generation check: a sign-out cannot slip in between.
    if (epochOf(rec.id) === epoch && cache?.data.activeId === rec.id) emitToken(fresh);
    return fresh;
  }

  async function getAccessToken(opts: { force?: boolean } = {}): Promise<AccessToken> {
    const d = await data();
    const rec = activeOf(d);
    if (!rec) throw signedOut('not signed in with ChatGPT');
    if (!isSignedIn(rec)) throw signedOut('the ChatGPT sign-in ended');
    if (!planEnabled(rec)) {
      throw chatgptError(
        'CHATGPT_PLAN_DISABLED',
        'ChatGPT plan usage was not allowed at sign-in. Enable it in Settings, or use an API key',
        true,
      );
    }
    const t = now();
    const expiresAt = rec.expires_at ?? 0;
    const expired = expiresAt <= t;
    const nearExpiry = expiresAt - t < REFRESH_MARGIN_MS;
    const tooEarly = rec.earliest_refresh_at !== null && t < rec.earliest_refresh_at;
    const want = expired || (opts.force === true && !tooEarly) || (nearExpiry && !tooEarly);
    if (!want) return { token: rec.access_token!, expiresAt: rec.expires_at, accountId: rec.id };
    let p = refreshing.get(rec.id);
    if (!p) {
      p = doRefresh(rec).finally(() => refreshing.delete(rec.id));
      refreshing.set(rec.id, p);
    }
    return p;
  }

  async function hasActiveSession(): Promise<boolean> {
    try {
      const rec = activeOf(await data());
      return !!rec && isSignedIn(rec) && planEnabled(rec);
    } catch {
      return false;
    }
  }

  function reportError(err: unknown): void {
    const code = (err as { code?: unknown })?.code;
    const id = cache?.data.activeId ?? null;
    if (code === 'CHATGPT_USAGE_LIMIT') {
      if (!usageLimitedNow(id)) {
        usageLimitedAccount = id;
        usageLimitedUntil = now() + USAGE_LIMIT_PROBE_MS;
        log('[chatgpt] usage limit reached; plan requests paused');
        void emitStatus();
      }
    } else if (typeof code === 'string' && LATCHED_BLOCKS.has(code)) {
      if (!blocked || blocked.code !== code || blocked.accountId !== id) {
        blocked = { code, accountId: id };
        void emitStatus();
      }
    }
  }

  async function clearBlock(): Promise<ChatgptStatus> {
    usageLimitedUntil = 0;
    usageLimitedAccount = null;
    blocked = null;
    void emitStatus();
    return status();
  }

  async function dismissWelcome(): Promise<ChatgptStatus> {
    await mutate((v) => {
      v.welcomeSeen = true;
    });
    void emitStatus();
    return status();
  }

  // ── Models ─────────────────────────────────────────────────────────────

  async function fetchModels(token: string): Promise<Response> {
    return deps.fetchImpl(CHATGPT_MODELS_URL, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  }

  async function listModels(opts: { force?: boolean } = {}): Promise<ChatgptModel[]> {
    const tok = await getAccessToken();
    const cached = models.get(tok.accountId);
    if (cached && !opts.force) return cached;
    let resp = await fetchModels(tok.token);
    if (resp.status === 401) {
      const again = await getAccessToken({ force: true });
      resp = await fetchModels(again.token);
    }
    if (!resp.ok) {
      const e = new Error(`http_${resp.status}`) as Error & { status?: number };
      e.status = resp.status;
      throw e;
    }
    const list = parseChatgptModels(await resp.json());
    models.set(tok.accountId, list);
    void emitStatus();
    return list;
  }

  return {
    status,
    signIn,
    signInForLogin,
    loginTargetFor,
    adoptLoginAccount,
    discardLoginAccount,
    cancelSignIn,
    signOut,
    switchAccount,
    getAccessToken,
    assertUsable,
    reportError,
    clearBlock,
    dismissWelcome,
    listModels,
    cachedModels: () => {
      const id = cache?.data.activeId;
      return id ? (models.get(id) ?? []) : [];
    },
    hasActiveSession,
    onToken(fn) {
      tokenListeners.add(fn);
      return () => tokenListeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
  };
}
