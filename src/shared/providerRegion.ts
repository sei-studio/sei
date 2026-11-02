/**
 * Renderer side of the provider region refusal (261103, T303). Main and the
 * bot classify the refusal (src/bot/brain/llm/regionRefusal.js) and rethrow
 * it tagged `PROVIDER_REGION_UNSUPPORTED[<name>]: <name> does not support
 * your region.`; the renderer reads the name back and shows the one line,
 * translated. The renderer must not import bot code, so the name map is
 * mirrored here from PROVIDER_LABELS (regionRefusal.test.js keeps both in
 * step).
 */
import { PROVIDER_LABELS, type ProviderKind } from './llmCatalog';

/** Error code / ErrorClass / llm:test token family for a region refusal. */
export const PROVIDER_REGION_CODE = 'PROVIDER_REGION_UNSUPPORTED';

/** llm:test / llm:list-models token for a region refusal. */
export const PROVIDER_REGION_TOKEN = 'region_unsupported';

/** i18n key of the line. `{provider}` is a company name, never translated. */
export const PROVIDER_REGION_COPY = '{provider} does not support your region.';

/** Used when the tag carries no name (an older bot, a bare code). */
export const PROVIDER_REGION_FALLBACK_NAME = 'Your AI provider';

/**
 * The provider name inside a tagged message, or null when the message is not
 * a region refusal. A tag with no name yields the fallback name.
 */
export function providerFromRegionMessage(message: unknown): string | null {
  const msg = typeof message === 'string' ? message : String((message as { message?: unknown })?.message ?? message ?? '');
  const tagged = /PROVIDER_REGION_UNSUPPORTED(?:\[([^\]\n]{1,60})\])?/.exec(msg);
  if (tagged) return tagged[1]?.trim() || PROVIDER_REGION_FALLBACK_NAME;
  const plain = /^([^\n.]{1,60}) does not support your region\./.exec(msg.trim());
  return plain ? plain[1].trim() : null;
}

/** Company name for the region line, for a provider kind. */
export function regionProviderLabel(kind: string | null | undefined): string {
  if (kind === 'chatgpt') return 'OpenAI';
  if (kind === 'ollama') return 'Ollama';
  return (kind && PROVIDER_LABELS[kind as ProviderKind]) || PROVIDER_REGION_FALLBACK_NAME;
}
