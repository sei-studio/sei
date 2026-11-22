// 261017 (issue #46): the bot side of the ChatGPT-plan token hand-off.
//
// Main owns the OAuth session (src/main/chatgptPlan/session.ts): the refresh
// token never leaves main, and refreshes are serialized there because the
// refresh token ROTATES on every use (two processes refreshing at once would
// burn the session). The bot only ever holds a short-lived access token:
//   - the init payload carries the current one (llm.api_key + llm.token_expires_at),
//   - main pushes {type:'chatgpt-token'} whenever it refreshes,
//   - and the provider asks for one with requestChatgptToken() when its token
//     is about to expire or a call came back 401.
//
// src/bot/index.js wires the transport (setChatgptTokenTransport) to the
// MessagePort; the provider never touches the port itself.

let transport = null // (msg) => void, posts to main
const waiters = new Set()
const listeners = new Set()

/** index.js: route token requests to main. Pass null on teardown. */
export function setChatgptTokenTransport(fn) {
  transport = typeof fn === 'function' ? fn : null
}

/**
 * index.js: main answered (or pushed) a token.
 *
 * `token` null with no `code` (or a terminal code: signed out, plan use
 * disabled) means main has no usable session: listeners hear the null and
 * every waiter rejects with that terminal error, so the brain stops instead
 * of retrying. `token` null with a TRANSIENT code (main's refresh hit a
 * network failure) rejects only the waiters, with a plain retryable error;
 * the provider keeps its current token.
 */
export function deliverChatgptToken({ token, expiresAt, error, code } = {}) {
  const t = typeof token === 'string' && token ? token : null
  const exp = Number.isFinite(expiresAt) ? expiresAt : null
  const terminal = !t && (!code || TERMINAL_TOKEN_CODES.has(code))
  if (t || terminal) {
    for (const fn of listeners) {
      try { fn(t, exp) } catch { /* listener errors never break delivery */ }
    }
  }
  for (const w of [...waiters]) {
    waiters.delete(w)
    if (t) w.resolve({ token: t, expiresAt: exp })
    else if (!terminal) w.reject(transientError(code, error))
    else if (code === 'CHATGPT_PLAN_DISABLED') w.reject(planDisabledError(error))
    else w.reject(signedOutError(error))
  }
}

const TERMINAL_TOKEN_CODES = new Set(['CHATGPT_SIGNED_OUT', 'CHATGPT_PLAN_DISABLED'])

function transientError(code, detail) {
  const e = new Error(`CHATGPT_TOKEN_UNAVAILABLE: could not refresh the ChatGPT sign-in right now${detail ? ` (${detail})` : ''}`)
  e.code = 'CHATGPT_TOKEN_UNAVAILABLE'
  e.cause = code
  return e
}

function planDisabledError(detail) {
  const e = new Error(`CHATGPT_PLAN_DISABLED: ChatGPT plan use is not enabled for this sign-in${detail ? ` (${detail})` : ''}. Enable it in Settings.`)
  e.code = 'CHATGPT_PLAN_DISABLED'
  e.terminal = true
  return e
}

/** Providers subscribe to every pushed token (proactive rotation). */
export function onChatgptToken(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function signedOutError(detail) {
  const e = new Error(`CHATGPT_SIGNED_OUT: the ChatGPT sign-in ended${detail ? ` (${detail})` : ''}. Sign in again in Settings.`)
  e.code = 'CHATGPT_SIGNED_OUT'
  e.terminal = true
  return e
}

/**
 * Ask main for a fresh access token. `force` asks main to refresh even when
 * its cached token looks valid (after a 401). Resolves {token, expiresAt};
 * rejects CHATGPT_SIGNED_OUT on a null answer, or a timeout error after
 * `timeoutMs` (main unreachable). Concurrent callers share one request.
 */
export function requestChatgptToken({ force = false, timeoutMs = 15_000 } = {}) {
  if (!transport) return Promise.reject(signedOutError('no token channel'))
  return new Promise((resolve, reject) => {
    const w = {
      resolve: (v) => { clearTimeout(w.timer); resolve(v) },
      reject: (e) => { clearTimeout(w.timer); reject(e) },
      timer: null,
    }
    w.timer = setTimeout(() => {
      waiters.delete(w)
      const e = new Error('CHATGPT_TOKEN_TIMEOUT: main did not answer the token request')
      e.code = 'CHATGPT_TOKEN_TIMEOUT'
      reject(e)
    }, timeoutMs)
    const first = waiters.size === 0
    waiters.add(w)
    if (first || force) {
      try { transport({ type: 'request-chatgpt-token', force: force === true }) }
      catch (err) { waiters.delete(w); w.reject(err) }
    }
  })
}

/** Test-only reset. */
export function _resetChatgptTokenBridgeForTests() {
  transport = null
  for (const w of waiters) clearTimeout(w.timer)
  waiters.clear()
  listeners.clear()
}




