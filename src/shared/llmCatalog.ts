/**
 * 260816 (china-compat): the shared LLM provider catalog — single source of
 * truth for which providers the UI OFFERS, their display labels, default
 * base URLs / models, and per-model vision capability.
 *
 * Two lists, deliberately different:
 *   - The Zod enum in characterSchema.ts is the set of values that PARSE —
 *     it keeps every legacy provider so old configs round-trip.
 *   - SHOWN_PROVIDERS here is the set the picker OFFERS. A config already on
 *     a dropped provider keeps working (grandfathered) and the picker shows
 *     it as the current selection, but never offers it to anyone else.
 *
 * Vision is a PER-MODEL property, not per-provider (gpt-5 sees, deepseek-v4
 * does not; qwen3-vl sees, qwen3-max does not). `modelVision()` returns a
 * three-state verdict; consumers gate the image surfaces (Draw!, backseat)
 * OFF only on a confident 'no' and treat 'unknown' as usable-with-caution —
 * a wrong 'no' silently hides features, a wrong 'yes' fails visibly at
 * launch with a recoverable error, so the asymmetry leans toward 'yes'.
 *
 * DeepSeek notes (researched 260816, api-docs.deepseek.com):
 *   - `deepseek-chat` / `deepseek-reasoner` aliases were DISCONTINUED
 *     2026-07-24. Current lineup: deepseek-v4-flash, deepseek-v4-pro.
 *   - V4 ships thinking-mode ON by default, and in thinking mode the API
 *     requires `reasoning_content` passed back on every tool round-trip —
 *     generic OpenAI-compat clients strip it and 400. Both provider layers
 *     therefore send `thinking: {type:'disabled'}` (DEEPSEEK_EXTRA_BODY).
 *   - Under load DeepSeek QUEUES requests on an open connection instead of
 *     429ing (worst 09:00-12:00 / 14:00-18:00 Beijing), so its first-token
 *     timeout gets a higher floor (FIRST_TOKEN_TIMEOUT_FLOOR_MS) and a
 *     stalled request must never be fast-retried (it re-enters the queue).
 */

import type { UserConfig } from './characterSchema';

export type ProviderKind = NonNullable<UserConfig['provider']>;

/** The 8 providers the picker offers (order = display order). */
export const SHOWN_PROVIDERS: readonly ProviderKind[] = [
  'anthropic',
  'openai',
  'deepseek',
  'qwen',
  'gemini',
  'grok',
  'openrouter',
  'ollama',
] as const;

/** Legacy providers that still parse + run but are no longer offered. */
export const GRANDFATHERED_PROVIDERS: readonly ProviderKind[] = [
  'mistral',
  'together',
  'groq',
  'fireworks',
  'cerebras',
  'perplexity',
] as const;

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen (Alibaba)',
  gemini: 'Google Gemini',
  grok: 'Grok (xAI)',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
  mistral: 'Mistral',
  together: 'Together',
  groq: 'Groq',
  fireworks: 'Fireworks',
  cerebras: 'Cerebras',
  perplexity: 'Perplexity',
};

/**
 * Default base URLs for the OpenAI-compatible set (mirrors
 * src/bot/brain/llm/index.js BASE_URLS; keep in sync — the bot cannot import
 * this module). Anthropic/gemini use their SDK defaults and are absent here.
 *
 * qwen: DashScope "compatible mode". The CN endpoint is the default because
 * a Qwen BYOK user is overwhelmingly likely to be on the CN platform;
 * international Model Studio accounts override base_url to the -intl host
 * via provider_config.
 */
export const OPENAI_COMPAT_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  openai: 'https://api.openai.com/v1',
  grok: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  perplexity: 'https://api.perplexity.ai',
};

export const QWEN_INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

/** Default model per provider when the user has not picked one. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen-plus',
  gemini: 'gemini-2.5-flash',
  grok: 'grok-4',
  openrouter: 'anthropic/claude-haiku-4.5',
  ollama: 'llama3.1',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  groq: 'llama-3.3-70b-versatile',
  fireworks: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
  cerebras: 'llama-3.3-70b',
  perplexity: 'sonar',
};

/**
 * DeepSeek V4 request extra: disables thinking mode so tool loops work over
 * plain OpenAI-compat (see header). Spread into the request body by both
 * provider layers whenever kind === 'deepseek'.
 */
export const DEEPSEEK_EXTRA_BODY = { thinking: { type: 'disabled' } } as const;

/**
 * Per-provider floor for the first-token/request timeout, applied on top of
 * whatever the call site asks for (a caller's 20s stays 20s on Anthropic,
 * becomes 60s on DeepSeek). Only providers that need a floor appear.
 */
export const FIRST_TOKEN_TIMEOUT_FLOOR_MS: Partial<Record<ProviderKind, number>> = {
  deepseek: 60_000,
};

export type VisionVerdict = 'yes' | 'no' | 'unknown';

/**
 * Per-model vision capability. Heuristics over model-id substrings, curated
 * from provider docs at 260816 — revise as lineups move. Consumers: gate
 * Draw!/backseat OFF only on 'no'.
 */
export function modelVision(provider: ProviderKind, model: string): VisionVerdict {
  const m = (model || '').toLowerCase();
  switch (provider) {
    case 'anthropic':
      return 'yes'; // every shipping Claude model is multimodal
    case 'openai':
      if (/gpt-5|gpt-4o|gpt-4\.1|^o[34]/.test(m)) return 'yes';
      if (/gpt-3\.5|davinci|babbage/.test(m)) return 'no';
      return 'unknown';
    case 'deepseek':
      return 'no'; // V4 Flash/Pro are text-only (260816)
    case 'qwen':
      if (/-vl|omni/.test(m)) return 'yes';
      return 'no'; // qwen-plus/max/turbo/qwen3-* text models
    case 'gemini':
      return 'yes'; // all Gemini chat models are multimodal
    case 'grok':
      if (/vision/.test(m)) return 'yes';
      if (/grok-[4-9]/.test(m)) return 'yes'; // grok-4+ multimodal
      return 'unknown';
    case 'openrouter': {
      // The slug's suffix names the underlying family.
      if (/gpt-5|gpt-4o|claude|gemini|-vl|vision|pixtral|llama-3\.2-(11|90)b/.test(m)) return 'yes';
      if (/deepseek|mistral-(7b|large)|qwen(?!.*vl)/.test(m)) return 'no';
      return 'unknown';
    }
    case 'ollama':
      if (/llava|vision|-vl|moondream|bakllava|minicpm-v/.test(m)) return 'yes';
      return 'no';
    default:
      // Grandfathered providers: the bot's capability table said no vision
      // for groq/cerebras/perplexity; mistral/together depend on the model.
      return 'unknown';
  }
}

/**
 * Every SHOWN provider supports live model listing with the user's key —
 * Anthropic GET /v1/models, the OpenAI-compat set GET {base}/models, Gemini
 * ListModels, Ollama GET /api/tags. The llm:list-models probe (src/main/llm)
 * owns the per-shape handling; this catalog only records the intent that the
 * model picker is list-driven, with DEFAULT_MODELS as the offline fallback.
 */
