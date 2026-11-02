/**
 * Main-process side of the system-proxy routing (261103, T303). The routing
 * itself lives in src/bot/net/systemProxy.js so the bot's utilityProcess can
 * share it.
 *
 * Main asks Chromium (`session.defaultSession.resolveProxy`) per origin, so
 * PAC files, bypass lists and the OS proxy settings mean exactly what they
 * mean for the renderer. The bot's utilityProcess has no session, so main
 * resolves the origins the bot talks to at fork time and passes the answers
 * in SEI_SYSTEM_PROXY (`botProxySnapshot`).
 */
import { session } from 'electron';
import { installSystemProxy } from '../bot/net/systemProxy.js';
import { OPENAI_COMPAT_BASE_URLS, QWEN_INTL_BASE_URL } from '../shared/llmCatalog';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
};

const PROXY_BASE = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';

/** Env var the bot reads its proxy snapshot from. */
export const SYSTEM_PROXY_ENV = 'SEI_SYSTEM_PROXY';

/**
 * Route main's Node fetch through the OS proxy. Call once, after app ready
 * (session.resolveProxy needs it). Requests before that go direct as before.
 */
export function installMainSystemProxy(): void {
  installSystemProxy({
    resolve: (url) => session.defaultSession.resolveProxy(url),
    log: logger.info,
  });
}

/** Fixed endpoints the bot's LLM providers call (plus the proxy base). */
const BOT_ORIGINS: readonly string[] = [
  PROXY_BASE,
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',
  'https://chatgpt.com',
  QWEN_INTL_BASE_URL,
  ...Object.values(OPENAI_COMPAT_BASE_URLS).filter((u): u is string => typeof u === 'string'),
];

const SNAPSHOT_TIMEOUT_MS = 1_500;

/**
 * Chromium's proxy answer for each origin the bot may call, as JSON for
 * SEI_SYSTEM_PROXY, or undefined when everything is DIRECT (or the lookups
 * failed), which leaves the bot on plain Node fetch exactly as before.
 * `extra` carries a user-configured base URL (BYOK / Ollama).
 */
export async function botProxySnapshot(
  extra: ReadonlyArray<string | undefined> = [],
  resolve: (url: string) => Promise<string> = (u) => session.defaultSession.resolveProxy(u),
): Promise<string | undefined> {
  const origins = new Set<string>();
  for (const u of [...BOT_ORIGINS, ...extra]) {
    if (!u) continue;
    try {
      origins.add(new URL(u).origin);
    } catch {
      /* junk base URL: the provider falls back to its default */
    }
  }
  const proxyOrigin = new URL(PROXY_BASE).origin;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), SNAPSHOT_TIMEOUT_MS).unref?.());
  const entries = await Promise.all(
    [...origins].map(async (o) => {
      const answer = await Promise.race([resolve(`${o}/`).catch(() => null), timeout]);
      return [o, answer] as const;
    }),
  );
  const map: Record<string, string> = {};
  for (const [o, a] of entries) if (typeof a === 'string') map[o] = a;
  if (!Object.values(map).some((a) => !/^\s*DIRECT\s*$/i.test(a))) return undefined;
  return JSON.stringify({ default: map[proxyOrigin] ?? 'DIRECT', origins: map });
}
