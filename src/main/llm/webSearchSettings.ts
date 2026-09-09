// src/main/llm/webSearchSettings.ts
//
// 260909: the ONE place main resolves "how should this account search the
// web" for both consumers of src/bot/web/webTools.js:
//   - the forked Minecraft bot (botSupervisor ships the result as init.webSearch)
//   - the in-app chat / voice turns (chatService, via getChatWebSession)
//
// Precedence: env (developer override) > UserConfig.web_search_* > keyless
// 'auto' chain. The keyless chain needs no registration; a keyed provider
// (brave / tavily / serper) is used only when its key is present.
import type { UserConfig } from '../../shared/characterSchema';
import { createWebSession, electronFetchProvider, WEB_PROVIDERS } from '../../bot/web/webTools.js';

export interface WebSearchSettings {
  provider: string;
  api_key: string;
}

export function resolveWebSearchSettings(
  userCfg: Partial<Pick<UserConfig, 'web_search_provider' | 'web_search_api_key'>>,
  env: NodeJS.ProcessEnv = process.env,
): WebSearchSettings {
  const envProvider = env.SEI_SEARCH_PROVIDER?.trim();
  const envKey = env.SEI_SEARCH_API_KEY?.trim();
  const provider = envProvider || userCfg.web_search_provider || 'auto';
  return {
    provider: (WEB_PROVIDERS as readonly string[]).includes(provider) ? provider : 'auto',
    api_key: envKey || userCfg.web_search_api_key || '',
  };
}

export type WebSession = ReturnType<typeof createWebSession>;

// One session per character for the in-app surfaces, so a visit("b") on the
// next chat turn still resolves against the last search. Evicted after an
// hour idle; the lettered table is the only state and it is tiny.
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map<string, { session: WebSession; settingsKey: string; lastUsed: number }>();

export function getChatWebSession(characterId: string, settings: WebSearchSettings): WebSession {
  const settingsKey = `${settings.provider} ${settings.api_key}`;
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(id);
  const hit = sessions.get(characterId);
  if (hit && hit.settingsKey === settingsKey) {
    hit.lastUsed = now;
    return hit.session;
  }
  // Chromium fetch (net.fetch): browser TLS fingerprint + OS proxy, so the
  // Cloudflare-fronted wikis and DuckDuckGo answer where Node's fetch is
  // challenged (measured 260909). Resolved lazily on the first request.
  const session = createWebSession({
    provider: settings.provider,
    apiKey: settings.api_key,
    logger: console,
    fetchProvider: electronFetchProvider,
  });
  sessions.set(characterId, { session, settingsKey, lastUsed: now });
  return session;
}

/** Test hook. */
export function _resetChatWebSessions(): void {
  sessions.clear();
}
