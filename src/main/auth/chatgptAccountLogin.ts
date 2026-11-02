/**
 * 261023 "Continue with ChatGPT" as a Sei ACCOUNT login (main side).
 *
 * Flow:
 *   1. POST <proxy>/auth/chatgpt/nonce. The proxy's nonce rides the OpenAI
 *      authorize request, so the proxy can tell this sign-in was started for
 *      Sei and refuse a replayed ID token.
 *   2. The ChatGPT-plan session runs the same open-source Sign in with
 *      ChatGPT browser flow it uses for plan usage (src/main/chatgptPlan),
 *      verifies the ID token locally, and saves NOTHING yet.
 *   3. POST <proxy>/auth/chatgpt/session with ONLY {id_token, client_id}. The
 *      ChatGPT access/refresh tokens never leave the device.
 *   4. The proxy answers a Supabase session (one step) or an email-code
 *      ticket (the account-takeover guard: an address that matches an
 *      existing account, a new install for a known identity, or an
 *      unverified email). The code is redeemed via /auth/chatgpt/verify.
 *   5. With a session: supabase.auth.setSession, wait for the profile scope
 *      to move to the account (authState drives the switch), then store the
 *      ChatGPT registration in THAT account's vault and remember the
 *      registration device-wide so the next login here is one step.
 *
 * Two more entry points reuse the same browser trip:
 *   - connectPlan (Playtime / Settings "Use your ChatGPT plan", every
 *     chatgpt:sign-in): with a live Sei session the plan sign-in also LINKS
 *     the ChatGPT identity to the account (POST /auth/chatgpt/link), so the
 *     next "Continue with ChatGPT" lands here with no code. The plan always
 *     connects: no Sei session, or a proxy that cannot be reached for the
 *     nonce, runs the plain plan sign-in; a refused or failed link keeps the
 *     grant it already has for the plan alone. No second browser trip.
 *   - unlink (Settings): POST /auth/chatgpt/unlink, then forget this
 *     device's registration for the account.
 *
 * The ticket and the pending ChatGPT tokens live only in this module's
 * memory between steps 4 and 5; nothing here crosses IPC except the result
 * shapes in shared/ipc.ts (no tokens, no ticket). Never logs token, code or
 * ticket values.
 */
import { safeStorage } from 'electron';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChatgptLinkResult,
  ChatgptLoginCodeReason,
  ChatgptLoginFailure,
  ChatgptLoginResult,
  ChatgptLoginStatus,
  ChatgptUnlinkResult,
} from '../../shared/ipc';
import type { PendingLoginAccount, LoginSignInResult } from '../chatgptPlan/session';
import { chatgptSession } from '../chatgptPlan';
import type { ChatgptSignInFailure, ChatgptSignInResult } from '../../shared/chatgptPlan';

const logger = {
  info: (m: string) => console.log(`[sei] chatgpt-login: ${m}`),
  warn: (m: string) => console.warn(`[sei] chatgpt-login: ${m}`),
};

/** What the device remembers between logins. No access or refresh token. */
export interface LoginRegistration {
  client_id: string;
  subject: string;
  email: string | null;
  /** Last ID token, used only as the authorize id_token_hint. */
  id_token: string | null;
  /** The Sei account this registration last signed into. */
  user_id: string | null;
}

export interface SupabaseSessionShape {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
}

export interface ChatgptAccountLoginDeps {
  fetchImpl: typeof fetch;
  proxyBase: () => string;
  chatgpt: () => {
    /** The plain plan sign-in (local nonce, no proxy). connectPlan's fallback. */
    signIn(opts?: { accountId?: string | null; enablePlan?: boolean }): Promise<ChatgptSignInResult>;
    signInForLogin(opts: {
      nonce: string;
      target?: { client_id: string; id_token: string | null; email: string | null } | null;
      forceConsent?: boolean;
    }): Promise<LoginSignInResult>;
    loginTargetFor(accountId: string): Promise<{ client_id: string; id_token: string | null; email: string | null; subject: string } | null>;
    adoptLoginAccount(p: PendingLoginAccount): Promise<ChatgptSignInResult>;
    discardLoginAccount(p: PendingLoginAccount): Promise<void>;
    cancelSignIn(): void;
  };
  /** supabase.auth.setSession; resolves the signed-in user id. */
  setSupabaseSession: (s: SupabaseSessionShape) => Promise<{ userId: string } | { error: string }>;
  /** The live Sei session's access token + user id, or null when signed out. */
  currentSession: () => Promise<{ accessToken: string; userId: string } | null>;
  /** Resolves once the active profile scope is this user's. */
  waitForAccountScope: (userId: string) => Promise<void>;
  registration: {
    load(): Promise<LoginRegistration | null>;
    save(r: LoginRegistration): Promise<void>;
    clear(): Promise<void>;
  };
  /** Refresh main's LLM capability after a new ChatGPT account (models). */
  onPlanAccountAdded?: () => void;
  timeoutMs?: number;
}

type ProxyAnswer = { status: number; body: Record<string, unknown> };

const PROXY_TIMEOUT_MS = 20_000;
/**
 * connectPlan's nonce fetch. Short: when the proxy hangs, the plain plan
 * sign-in (which needs no proxy) should open the browser without a long wait.
 */
const PLAN_NONCE_TIMEOUT_MS = 5_000;

/** Reauth failures that mean "this saved registration no longer works here". */
const STALE_REGISTRATION: ReadonlySet<ChatgptSignInFailure> = new Set([
  'exchange_failed',
  'client_mismatch',
  'registration_incomplete',
]);

const fail = (reason: ChatgptLoginFailure, message: string): { ok: false; reason: ChatgptLoginFailure; message: string } => ({
  ok: false,
  reason,
  message,
});

function mapSignInFailure(reason: ChatgptSignInFailure, message?: string): ChatgptLoginResult {
  switch (reason) {
    case 'cancelled':
      return fail('cancelled', 'Cancelled');
    case 'denied':
      return fail('denied', 'ChatGPT sign-in was declined');
    case 'timeout':
      return fail('timeout', 'ChatGPT sign-in timed out');
    case 'browser_failed':
      return fail('browser_failed', message ?? 'Could not open the browser');
    case 'network':
      return fail('network', 'Network error');
    case 'region_unsupported':
      return fail('provider_region', 'OpenAI does not support your region');
    case 'port_unavailable':
      return fail('sign_in_failed', 'Could not start the sign-in listener');
    default:
      return fail('sign_in_failed', `ChatGPT sign-in failed (${reason})`);
  }
}

export function createChatgptAccountLogin(deps: ChatgptAccountLoginDeps) {
  const timeoutMs = deps.timeoutMs ?? PROXY_TIMEOUT_MS;
  /** Waiting for an email code. Main-memory only. */
  let pendingCode: { ticket: string; account: PendingLoginAccount; reason: ChatgptLoginCodeReason } | null = null;
  let planOffer = false;
  let generation = 0;

  async function proxyPost(p: string, body: unknown, bearer?: string, timeout = timeoutMs): Promise<ProxyAnswer> {
    try {
      const res = await deps.fetchImpl(`${deps.proxyBase().replace(/\/+$/, '')}${p}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeout),
      });
      let json: Record<string, unknown> = {};
      try {
        const v = (await res.json()) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>;
      } catch {
        /* non-JSON error page */
      }
      return { status: res.status, body: json };
    } catch {
      return { status: 0, body: { error: 'network' } };
    }
  }

  async function fetchNonce(timeout?: number): Promise<string | ChatgptLoginResult> {
    const r = await proxyPost('/auth/chatgpt/nonce', {}, undefined, timeout);
    if (r.status === 0) return fail('network', 'Could not reach Sei');
    if (r.status === 429) return fail('rate_limited', 'Too many attempts. Try again in a minute');
    const nonce = r.body.nonce;
    if (r.status !== 200 || typeof nonce !== 'string' || nonce.length === 0) {
      return fail('unavailable', 'ChatGPT sign-in is not available right now');
    }
    return nonce;
  }

  type SignedIn =
    | { ok: true; account: PendingLoginAccount }
    | {
        ok: false;
        result: ChatgptLoginResult;
        /** The browser flow's own failure, when it got that far. */
        signIn?: { reason: ChatgptSignInFailure; message?: string };
        /** False when it stopped before any browser sign-in (nonce step). */
        browserOpened: boolean;
      };

  /**
   * Nonce + browser sign-in, reusing this device's registration. When the
   * saved registration no longer works (revoked client, OpenAI rejected the
   * reauth), forget it and register fresh once. An explicit `target` (a
   * saved plan account to renew) is tried alone, like signIn({accountId}).
   */
  async function chatgptSignIn(
    opts: {
      target?: { client_id: string; id_token: string | null; email: string | null } | null;
      forceConsent?: boolean;
      nonceTimeoutMs?: number;
    } = {},
  ): Promise<SignedIn> {
    const targets =
      opts.target !== undefined ? [opts.target] : await deps.registration.load().then((r) => (r ? [r, null] : [null]), () => [null]);
    let browserOpened = false;
    for (const target of targets) {
      const nonce = await fetchNonce(opts.nonceTimeoutMs);
      if (typeof nonce !== 'string') return { ok: false, result: nonce, browserOpened };
      browserOpened = true;
      const r = await deps.chatgpt().signInForLogin({
        nonce,
        target: target ? { client_id: target.client_id, id_token: target.id_token, email: target.email } : null,
        ...(opts.forceConsent ? { forceConsent: true } : {}),
      });
      if (r.ok) return { ok: true, account: r.pending };
      if (target && opts.target === undefined && STALE_REGISTRATION.has(r.reason)) {
        logger.warn(`saved registration failed (${r.reason}); registering this install again`);
        await deps.registration.clear().catch(() => undefined);
        continue;
      }
      return { ok: false, result: mapSignInFailure(r.reason, r.message), signIn: { reason: r.reason, message: r.message }, browserOpened };
    }
    return { ok: false, result: fail('sign_in_failed', 'ChatGPT sign-in failed'), browserOpened };
  }

  function discard(account: PendingLoginAccount): void {
    void deps.chatgpt().discardLoginAccount(account);
  }

  function clearPending(opts: { revoke: boolean }): void {
    if (pendingCode && opts.revoke) discard(pendingCode.account);
    pendingCode = null;
  }

  function mapProxyError(r: ProxyAnswer): ChatgptLoginResult {
    const err = typeof r.body.error === 'string' ? r.body.error : '';
    const why = typeof (r.body as { reason?: unknown }).reason === 'string' ? String((r.body as { reason?: unknown }).reason) : '';
    if (r.status === 0) return fail('network', 'Could not reach Sei');
    if (r.status === 429) return fail('rate_limited', 'Too many attempts. Try again later');
    if (r.status === 409) {
      return why === 'linked_elsewhere'
        ? fail('linked_elsewhere', 'This ChatGPT account is linked to a different Sei account')
        : fail('account_conflict', 'That Sei account is linked to a different ChatGPT account');
    }
    if (r.status === 422 && err === 'chatgpt_no_email') return fail('no_email', 'Your ChatGPT account has no email address');
    if (r.status === 401 && err === 'chatgpt_token_invalid') {
      logger.warn(`proxy refused the ChatGPT ID token (${why || 'no reason'})`);
      return fail('token_rejected', 'Sei could not verify the ChatGPT sign-in. Try again');
    }
    if (r.status === 401 && err === 'missing_jwt') return fail('not_signed_in', 'Sign in to Sei first');
    if (r.status === 401 && (err === 'invalid_jwt' || err === 'expired_jwt')) return fail('not_signed_in', 'Your Sei session expired. Sign in again');
    if (r.status === 404) return fail('unavailable', 'ChatGPT sign-in is not available yet');
    logger.warn(`proxy answered ${r.status} ${err || ''}`.trim());
    return fail('unavailable', 'ChatGPT sign-in is not available right now');
  }

  async function finish(session: SupabaseSessionShape, account: PendingLoginAccount, created: boolean, gen: number): Promise<ChatgptLoginResult> {
    if (gen !== generation) {
      discard(account);
      return fail('cancelled', 'Cancelled');
    }
    const set = await deps.setSupabaseSession(session);
    if ('error' in set) {
      logger.warn(`setSession failed: ${set.error}`);
      discard(account);
      return fail('sign_in_failed', 'Could not start the Sei session');
    }
    try {
      await deps.waitForAccountScope(set.userId);
    } catch (err) {
      logger.warn(`profile switch did not complete: ${(err as Error).message}`);
    }
    let planEnabled = false;
    const adopted = await deps.chatgpt().adoptLoginAccount(account);
    if (adopted.ok) {
      planEnabled = adopted.planEnabled;
      // Before any further await: the renderer asks for the offer as soon as
      // the plan status push (sent from adopt) lands.
      if (planEnabled) planOffer = true;
      deps.onPlanAccountAdded?.();
    } else {
      // Signed in to Sei regardless; the plan can be connected in Settings.
      logger.warn(`could not save the ChatGPT plan sign-in (${adopted.reason})`);
      discard(account);
    }
    await deps.registration
      .save({ client_id: account.clientId, subject: account.subject, email: account.email, id_token: account.idToken, user_id: set.userId })
      .catch((err) => logger.warn(`could not remember the registration: ${(err as Error).message}`));
    logger.info(`signed in (${created ? 'new account' : 'existing account'}, plan ${planEnabled ? 'enabled' : 'not enabled'})`);
    return { ok: true, kind: 'signed_in', created, planEnabled };
  }

  async function handleSessionAnswer(r: ProxyAnswer, account: PendingLoginAccount, gen: number): Promise<ChatgptLoginResult> {
    if (r.status === 200 && r.body.status === 'session') {
      const s = r.body.session as Partial<SupabaseSessionShape> | undefined;
      if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') {
        discard(account);
        return fail('unavailable', 'Sei sent an incomplete session');
      }
      return finish(s as SupabaseSessionShape, account, r.body.created === true, gen);
    }
    if (r.status === 200 && r.body.status === 'email_code' && typeof r.body.ticket === 'string') {
      const reason = (['existing_account', 'new_device', 'unverified_email'] as const).find((x) => x === r.body.reason) ?? 'new_device';
      clearPending({ revoke: true });
      pendingCode = { ticket: r.body.ticket, account, reason };
      return {
        ok: true,
        kind: 'email_code',
        emailHint: typeof r.body.email_hint === 'string' ? r.body.email_hint : '',
        reason,
      };
    }
    discard(account);
    return mapProxyError(r);
  }

  return {
    async login(): Promise<ChatgptLoginResult> {
      // 261103 (T303): no Sei region pre-check. OpenAI decides whether the
      // caller's region may sign in; its refusal comes back as provider_region.
      const gen = ++generation;
      clearPending({ revoke: true });
      const signed = await chatgptSignIn();
      if (!signed.ok) return signed.result;
      if (gen !== generation) {
        discard(signed.account);
        return fail('cancelled', 'Cancelled');
      }
      const r = await proxyPost('/auth/chatgpt/session', {
        id_token: signed.account.idToken,
        client_id: signed.account.clientId,
      });
      return handleSessionAnswer(r, signed.account, gen);
    },

    async verifyCode(code: string): Promise<ChatgptLoginResult> {
      const p = pendingCode;
      if (!p) return fail('code_expired', 'That code expired. Start again');
      const gen = generation;
      const r = await proxyPost('/auth/chatgpt/verify', { ticket: p.ticket, code: code.replace(/\s+/g, '') });
      if (pendingCode !== p) return fail('cancelled', 'Cancelled');
      if (r.status === 401 && r.body.error === 'invalid_code') return fail('invalid_code', 'That code is not right');
      if (r.status === 401 && r.body.error === 'ticket_invalid') {
        clearPending({ revoke: true });
        return fail('code_expired', 'That code expired or had too many tries. Start again');
      }
      if (r.status === 200 && r.body.status === 'session') {
        pendingCode = null;
        return handleSessionAnswer(r, p.account, gen);
      }
      if (r.status === 0 || r.status === 429 || r.status >= 500) return mapProxyError(r); // keep the ticket: retryable
      clearPending({ revoke: true });
      return mapProxyError(r);
    },

    async resendCode(): Promise<{ ok: true } | { ok: false; reason: ChatgptLoginFailure; message: string }> {
      const p = pendingCode;
      if (!p) return fail('code_expired', 'That code expired. Start again');
      const r = await proxyPost('/auth/chatgpt/resend', { ticket: p.ticket });
      if (r.status === 200) return { ok: true };
      if (r.status === 401) {
        clearPending({ revoke: true });
        return fail('code_expired', 'That code expired. Start again');
      }
      const m = mapProxyError(r);
      return m.ok ? fail('unavailable', 'Could not resend') : m;
    },

    cancel(): void {
      generation += 1;
      deps.chatgpt().cancelSignIn();
      clearPending({ revoke: true });
    },

    /** Settings "Link ChatGPT": attach a ChatGPT identity to the signed-in account. */
    async link(): Promise<ChatgptLinkResult> {
      const current = await deps.currentSession();
      if (!current) return fail('not_signed_in', 'Sign in to Sei first');
      const gen = ++generation;
      clearPending({ revoke: true });
      const signed = await chatgptSignIn();
      if (!signed.ok) return signed.result.ok ? fail('sign_in_failed', 'ChatGPT sign-in failed') : signed.result;
      if (gen !== generation) {
        discard(signed.account);
        return fail('cancelled', 'Cancelled');
      }
      const fresh = (await deps.currentSession()) ?? current;
      const r = await proxyPost(
        '/auth/chatgpt/link',
        { id_token: signed.account.idToken, client_id: signed.account.clientId },
        fresh.accessToken,
      );
      if (r.status !== 200 || r.body.status !== 'linked') {
        discard(signed.account);
        const m = mapProxyError(r);
        return m.ok ? fail('unavailable', 'Could not link') : m;
      }
      const adopted = await deps.chatgpt().adoptLoginAccount(signed.account);
      const planEnabled = adopted.ok && adopted.planEnabled;
      if (planEnabled) planOffer = true;
      if (adopted.ok) deps.onPlanAccountAdded?.();
      else discard(signed.account);
      await deps.registration
        .save({
          client_id: signed.account.clientId,
          subject: signed.account.subject,
          email: signed.account.email,
          id_token: signed.account.idToken,
          user_id: fresh.userId,
        })
        .catch(() => undefined);
      return { ok: true, planEnabled, email: signed.account.email };
    },

    /**
     * The ChatGPT PLAN sign-in (renderer chatgpt:sign-in: Playtime, Settings,
     * onboarding, the re-sign-in dialog). With a live Sei session it also
     * links the ChatGPT identity to that account, silently, on the same
     * browser trip; the plan connects either way. Returns the plain
     * sign-in's result shape. "Add account" (accountId null) asks for a
     * DIFFERENT ChatGPT account, so it stays the plain sign-in.
     */
    async connectPlan(opts: { accountId?: string | null; enablePlan?: boolean } = {}): Promise<ChatgptSignInResult> {
      const plain = (why: string): Promise<ChatgptSignInResult> => {
        logger.info(`plan sign-in without account link (${why})`);
        return deps.chatgpt().signIn(opts);
      };
      if (opts.accountId === null) return deps.chatgpt().signIn(opts);
      const current = await deps.currentSession().catch(() => null);
      if (!current) return deps.chatgpt().signIn(opts);
      let target: { client_id: string; id_token: string | null; email: string | null; subject: string } | null | undefined;
      if (opts.accountId) {
        target = await deps.chatgpt().loginTargetFor(opts.accountId).catch(() => null);
        if (!target) return plain('unknown account');
      }
      const gen = ++generation;
      clearPending({ revoke: true });
      const signed = await chatgptSignIn({
        ...(target ? { target } : {}),
        forceConsent: opts.enablePlan === true,
        nonceTimeoutMs: PLAN_NONCE_TIMEOUT_MS,
      });
      if (!signed.ok) {
        // Nothing reached the browser (the proxy is unreachable or refused
        // the nonce): the plain sign-in needs no proxy.
        if (!signed.browserOpened) return plain(signed.result.ok ? 'nonce' : signed.result.reason);
        if (signed.signIn) return { ok: false, reason: signed.signIn.reason, ...(signed.signIn.message ? { message: signed.signIn.message } : {}) };
        return { ok: false, reason: 'exchange_failed' };
      }
      if (gen !== generation) {
        discard(signed.account);
        return { ok: false, reason: 'cancelled' };
      }
      if (target && signed.account.subject !== target.subject) {
        // A different ChatGPT account answered a renewal: never overwrite.
        discard(signed.account);
        return { ok: false, reason: 'account_mismatch' };
      }
      const fresh = (await deps.currentSession().catch(() => null)) ?? current;
      const r = await proxyPost(
        '/auth/chatgpt/link',
        { id_token: signed.account.idToken, client_id: signed.account.clientId },
        fresh.accessToken,
      );
      const linked = r.status === 200 && r.body.status === 'linked';
      if (!linked) {
        // linked_elsewhere / account_conflict / an expired Sei session / an
        // older or unreachable proxy: keep the grant for the plan alone.
        const m = mapProxyError(r);
        logger.info(`plan sign-in: ChatGPT identity not linked (${m.ok ? r.status : m.reason}); connecting the plan only`);
      }
      const adopted = await deps.chatgpt().adoptLoginAccount(signed.account);
      if (!adopted.ok) {
        discard(signed.account);
        return adopted;
      }
      // No plan offer: the plan surface that started this switches itself.
      deps.onPlanAccountAdded?.();
      if (linked) {
        await deps.registration
          .save({
            client_id: signed.account.clientId,
            subject: signed.account.subject,
            email: signed.account.email,
            id_token: signed.account.idToken,
            user_id: fresh.userId,
          })
          .catch(() => undefined);
      }
      return adopted;
    },

    /**
     * Settings "Unlink": drop the account's ChatGPT link on the proxy, then
     * forget this device's registration for it, so the next "Continue with
     * ChatGPT" is a fresh identity (an email code when the address has an
     * account). The plan sign-in, if any, stays connected. An older proxy
     * without the route answers 404: reported as unavailable, nothing changed.
     */
    async unlink(): Promise<ChatgptUnlinkResult> {
      const current = await deps.currentSession().catch(() => null);
      if (!current) return fail('not_signed_in', 'Sign in to Sei first');
      const r = await proxyPost('/auth/chatgpt/unlink', {}, current.accessToken);
      if (r.status !== 200 || r.body.status !== 'unlinked') {
        if (r.status === 404) return fail('unavailable', 'Unlinking is not available yet');
        const m = mapProxyError(r);
        return m.ok ? fail('unavailable', 'Could not unlink') : m;
      }
      const reg = await deps.registration.load().catch(() => null);
      if (reg && reg.user_id === current.userId) {
        await deps.registration.clear().catch((err) => logger.warn(`could not forget the registration: ${(err as Error).message}`));
      }
      logger.info(`unlinked (${r.body.removed === true ? 'link removed' : 'no link on the server'})`);
      return { ok: true, removed: r.body.removed === true };
    },

    /** Linked state as far as this device knows (the proxy holds the truth). */
    async status(): Promise<ChatgptLoginStatus> {
      const current = await deps.currentSession().catch(() => null);
      const reg = await deps.registration.load().catch(() => null);
      const linked = !!current && !!reg && reg.user_id === current.userId;
      return { linked, email: linked ? reg!.email : null, awaitingCode: pendingCode !== null };
    },

    /** One-shot: true once after a login/link that granted plan usage. */
    takePlanOffer(): boolean {
      const v = planOffer;
      planOffer = false;
      return v;
    },
  };
}

export type ChatgptAccountLogin = ReturnType<typeof createChatgptAccountLogin>;

// ─── Electron wiring ─────────────────────────────────────────────────────────

async function atomicWrite(target: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

async function electronRegistrationPath(): Promise<string> {
  const { paths } = await import('../paths');
  return paths.chatgptLoginRegistrationPath();
}

export const electronRegistrationStore: ChatgptAccountLoginDeps['registration'] = {
  async load() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const raw = JSON.parse(safeStorage.decryptString(await readFile(await electronRegistrationPath()))) as Record<string, unknown>;
      const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
      const client_id = s(raw.client_id);
      const subject = s(raw.subject);
      if (!client_id || !subject) return null;
      return { client_id, subject, email: s(raw.email), id_token: s(raw.id_token), user_id: s(raw.user_id) };
    } catch {
      return null;
    }
  },
  async save(r) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('KEYCHAIN_UNAVAILABLE');
    await atomicWrite(await electronRegistrationPath(), safeStorage.encryptString(JSON.stringify(r)));
  },
  async clear() {
    try {
      await unlink(await electronRegistrationPath());
    } catch {
      /* already gone */
    }
  },
};

let singleton: ChatgptAccountLogin | null = null;

export function chatgptAccountLogin(): ChatgptAccountLogin {
  if (singleton) return singleton;
  singleton = createChatgptAccountLogin({
    fetchImpl: (...a) => globalThis.fetch(...a),
    proxyBase: () => process.env.SEI_PROXY_URL ?? 'https://api.sei.gg',
    chatgpt: () => chatgptSession(),
    setSupabaseSession: async (s) => {
      const { getClient } = await import('./supabaseClient');
      try {
        const { data, error } = await getClient().auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
        if (error || !data.user) return { error: error?.message ?? 'no user' };
        return { userId: data.user.id };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    currentSession: async () => {
      const { getClient } = await import('./supabaseClient');
      const { data } = await getClient().auth.getSession();
      const s = data.session;
      return s?.access_token && s.user?.id ? { accessToken: s.access_token, userId: s.user.id } : null;
    },
    waitForAccountScope: async (userId) => {
      // Serialized behind the switch authState started on SIGNED_IN; a no-op
      // when that one already moved the scope.
      const { switchScopeForAuth } = await import('../profile/profileScope');
      await switchScopeForAuth(userId);
    },
    registration: electronRegistrationStore,
    onPlanAccountAdded: () => {
      void import('../llm/capability').then((m) => m.pushLlmCapability()).catch(() => undefined);
    },
  });
  return singleton;
}

/** Tests only. */
export function _resetChatgptAccountLoginForTests(): void {
  singleton = null;
}
