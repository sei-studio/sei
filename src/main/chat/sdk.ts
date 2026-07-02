/**
 * Chat SDK wiring — mirrors src/bot/brain/anthropicClient.js buildSdkOptions and
 * src/main/personaExpansion.ts: the in-app chat LLM call runs in the MAIN process
 * (the only side holding the decrypted BYOK key / cloud JWT). This is the
 * "placeholder" chat brain the user asked for — self-contained, no forked bot,
 * no mineflayer — wired to the real decoupled brain in a later phase.
 *
 *   - local (BYOK)  → { apiKey: <decrypted> }
 *   - cloud-proxy   → { baseURL: api.sei.gg, authToken: <Supabase JWT>, apiKey: null }
 *     (api.sei.gg main /v1/messages route — meters credits exactly like gameplay;
 *      NOT the /free expansion route). apiKey:null suppresses the X-Api-Key header.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getAiBackendKind, loadApiKey } from '../apiKeyStore';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';

/** Family alias → latest Haiku 4.5 snapshot. Matches the bot + persona expander. */
export const CHAT_MODEL = 'claude-haiku-4-5';
export const CHAT_TIMEOUT_MS = 30_000;

export interface ChatSdk {
  client: Anthropic;
  model: string;
}

/**
 * Build a one-shot Anthropic client for a chat turn. Reads the backend kind +
 * credentials fresh each call so a cloud↔local switch or JWT rotation is picked
 * up without any long-lived state.
 */
export async function buildChatSdk(): Promise<ChatSdk> {
  const kind = await getAiBackendKind();
  if (kind === 'cloud-proxy') {
    const { getClient } = await import('../auth/supabaseClient');
    const { data } = await getClient().auth.getSession();
    const authToken = data.session?.access_token ?? '';
    // apiKey:null → no X-Api-Key header, only Authorization: Bearer <jwt>.
    const client = new Anthropic({ baseURL: PROXY_BASE_URL, authToken, apiKey: null, maxRetries: 1 });
    return { client, model: CHAT_MODEL };
  }
  const apiKey = await loadApiKey();
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  return { client, model: CHAT_MODEL };
}
