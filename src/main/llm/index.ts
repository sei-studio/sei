/**
 * 260816 (china-compat W1): main-process LLM provider factory. One layer, all
 * main-side call sites (chat, voice one-shots, folds, compactions, chess,
 * Draw!, backseat, persona expansion BYOK).
 *
 * Resolution order:
 *   - cloud-proxy backend → the EXACT current Anthropic SDK path (zero change
 *     for cloud users, cache_control breakpoints included).
 *   - local + provider 'anthropic' (the default) → the exact current BYOK
 *     path (buildChatSdk, LOCAL_NO_API_KEY guard).
 *   - local + anything else → the matching adapter, configured from
 *     UserConfig.provider_config[provider] ({model?, base_url?}) with
 *     llmCatalog defaults. The single BYOK key in apiKeyStore is THE key for
 *     whatever provider is selected (Settings wipes it on provider switch).
 */
import { isProviderRegionRefusal, providerRegionError } from '../../bot/brain/llm/regionRefusal.js';
import {
  COMPANION_MODEL,
  DEFAULT_MODELS,
  OPENAI_COMPAT_BASE_URLS,
  modelVision,
  type ProviderKind,
  type VisionVerdict,
} from '../../shared/llmCatalog';
import type { UserConfig } from '../../shared/characterSchema';
import { getAiBackendKind, hasApiKey, loadApiKey } from '../apiKeyStore';
import { loadConfig } from '../configStore';
import { createAnthropicProvider } from './anthropic';
import { createOpenAICompatProvider, effectiveTimeoutMs as openaiCompatTimeoutMs } from './openaiCompat';
import { createGeminiProvider } from './gemini';
import { createOllamaProvider, effectiveTimeoutMs as ollamaTimeoutMs, OLLAMA_DEFAULT_BASE_URL } from './ollama';
import { ollamaModelVision } from './ollamaCapabilities';
import { createChatgptProvider } from './chatgptResponses';
import { chatgptModelVision, pickDefaultChatgptModel, pickReasoningEffort } from '../../shared/chatgptPlan';
import { chatgptSession } from '../chatgptPlan';
import type { LlmProvider } from './types';

export type { LlmCallParams, LlmProvider, LlmResult, LlmToolUse, LlmUsage } from './types';

/**
 * Same sentinel string sdk.ts exports (redeclared so the layer never depends
 * on a named export test mocks of '../chat/sdk' do not provide): the renderer
 * chat store greps replies for this token to show the actionable no-key line.
 */
const LOCAL_NO_API_KEY = 'LOCAL_NO_API_KEY';

interface ProviderConfigEntry {
  model?: string;
  base_url?: string;
}

function providerConfigEntry(cfg: UserConfig, kind: ProviderKind): ProviderConfigEntry {
  const raw = (cfg.provider_config as Record<string, unknown> | undefined)?.[kind];
  if (!raw || typeof raw !== 'object') return {};
  const e = raw as Record<string, unknown>;
  return {
    ...(typeof e.model === 'string' && e.model.trim() ? { model: e.model.trim() } : {}),
    ...(typeof e.base_url === 'string' && e.base_url.trim() ? { base_url: e.base_url.trim() } : {}),
  };
}

/** The model a local provider kind would run, per config + catalog defaults. */
export function resolveLocalModel(cfg: UserConfig, kind: ProviderKind): string {
  return providerConfigEntry(cfg, kind).model ?? DEFAULT_MODELS[kind] ?? COMPANION_MODEL;
}

/**
 * The selected LOCAL provider kind, read from config. Never throws (config
 * failures degrade to 'anthropic', the historical behavior).
 */
export async function localProviderKind(): Promise<ProviderKind> {
  try {
    const cfg = await loadConfig();
    return (cfg.provider ?? 'anthropic') as ProviderKind;
  } catch {
    return 'anthropic';
  }
}

/**
 * Build a provider for an explicit local kind (+ optional model override, for
 * llm:test). Reads config for provider_config; loads the single BYOK key.
 */
export async function buildLocalProviderFor(
  kind: ProviderKind,
  modelOverride?: string,
): Promise<LlmProvider> {
  return withRegionRefusal(kind, await buildLocalProviderRaw(kind, modelOverride));
}

/**
 * 261103 (T303): local / BYOK mode never pre-blocks by region, so a provider
 * that refuses the caller's region answers for itself. Its refusal is
 * rethrown as one tagged error (PROVIDER_REGION_UNSUPPORTED[<name>]) that
 * every surface turns into "<Provider> does not support your region." instead
 * of "your key was rejected" or a generic failure. Every other error passes
 * through untouched. The cloud provider is never wrapped.
 */
export function withRegionRefusal(kind: ProviderKind, provider: LlmProvider): LlmProvider {
  const call = provider.call.bind(provider);
  return {
    ...provider,
    async call(params) {
      try {
        return await call(params);
      } catch (err) {
        if (isProviderRegionRefusal(err)) throw providerRegionError(kind, err);
        throw err;
      }
    },
  };
}

async function buildLocalProviderRaw(kind: ProviderKind, modelOverride?: string): Promise<LlmProvider> {
  if (kind === 'anthropic') {
    // The exact current BYOK path (or cloud, if that is what the backend says
    // — buildChatSdk reads it fresh; callers on this branch are local).
    return createAnthropicProvider('local');
  }
  const cfg = await loadConfig();
  const entry = providerConfigEntry(cfg, kind);
  const model = modelOverride ?? entry.model ?? DEFAULT_MODELS[kind];
  if (kind === 'ollama') {
    return createOllamaProvider({ model, baseUrl: entry.base_url ?? OLLAMA_DEFAULT_BASE_URL });
  }
  if (kind === 'chatgpt') {
    // 261017 (issue #46): ChatGPT plan. The credential is main's OAuth
    // session (tokens never leave main); no api_key.bin involved.
    const r = await resolveChatgptModel(modelOverride ?? entry.model);
    return createChatgptProvider({
      model: r.model,
      reasoningEffort: r.reasoningEffort,
      vision: r.vision,
      session: chatgptSession(),
    });
  }
  // Every remaining provider needs the BYOK key. Missing → the same visible
  // failure class as Anthropic BYOK (never a silent cloud fallback).
  if (!(await hasApiKey())) {
    throw new Error(
      `${LOCAL_NO_API_KEY}: Local mode is on but no API key is saved. Add your API key in Settings, or switch to managed billing.`,
    );
  }
  const apiKey = await loadApiKey();
  if (kind === 'gemini') {
    return createGeminiProvider({ apiKey, model, ...(entry.base_url ? { baseUrl: entry.base_url } : {}) });
  }
  const baseUrl = entry.base_url ?? OPENAI_COMPAT_BASE_URLS[kind];
  if (!baseUrl) throw new Error(`LLM provider '${kind}' has no base URL configured.`);
  return createOpenAICompatProvider({ kind, apiKey, baseUrl, model });
}

/**
 * 261017 (issue #46): the ChatGPT-plan model to run, plus its reasoning
 * effort and vision verdict. A stored pick wins; otherwise the account
 * catalog's default (pickDefaultChatgptModel), read from the cache or, when
 * the cache is empty, from /v1/models (bounded; any failure falls back to
 * the static catalog default). Never throws.
 */
export async function resolveChatgptModel(
  stored?: string,
): Promise<{ model: string; reasoningEffort: string | null; vision: VisionVerdict }> {
  const s = chatgptSession();
  let catalog = s.cachedModels();
  if (catalog.length === 0) {
    try {
      catalog = await Promise.race([
        s.listModels(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
    } catch {
      catalog = [];
    }
  }
  const pick = stored?.trim();
  // A stored pick the account no longer lists (plan change, retired model)
  // falls back to the catalog default instead of failing every call.
  const model =
    pick && (catalog.length === 0 || catalog.some((m) => m.slug === pick))
      ? pick
      : catalog.length
        ? pickDefaultChatgptModel(catalog)
        : DEFAULT_MODELS.chatgpt;
  const entry = catalog.find((m) => m.slug === model);
  return {
    model,
    reasoningEffort: entry ? pickReasoningEffort(entry.reasoning_levels) : null,
    vision: chatgptModelVision(model, catalog),
  };
}

/**
 * Build the active provider for the current backend + config. Read fresh per
 * call (like buildChatSdk always was), so a cloud<->local switch, provider
 * change, or JWT rotation is picked up with no long-lived state.
 */
export async function buildLlmProvider(): Promise<LlmProvider> {
  const backend = await getAiBackendKind();
  if (backend === 'cloud-proxy') return createAnthropicProvider('cloud-proxy');
  const kind = await localProviderKind();
  // 261110 Playtime: count own-key / ChatGPT-plan requests (usage ledger).
  const { withUsageMeter } = await import('../usage/llmUsageLedger');
  return withUsageMeter(await buildLocalProviderFor(kind));
}

/**
 * Vision capability of the ACTIVE chat backend, computed from config (plus,
 * for Ollama, a local /api/show probe) — no key required, never throws. cloud-proxy → 'yes' (Haiku sees). Feeds the
 * llm:capability push and the backseat session-start hard gate.
 */
export async function activeLlmVision(): Promise<VisionVerdict> {
  try {
    const backend = await getAiBackendKind();
    if (backend === 'cloud-proxy') return 'yes';
    const cfg = await loadConfig();
    const kind = (cfg.provider ?? 'anthropic') as ProviderKind;
    if (kind === 'anthropic') return 'yes';
    const model = resolveLocalModel(cfg, kind);
    // Ollama can tell us itself (/api/show capabilities); a name heuristic
    // judged qwen2.5vl/gemma3/llama4 blind and locked Draw!/backseat (261010).
    if (kind === 'ollama') {
      return await ollamaModelVision(providerConfigEntry(cfg, kind).base_url ?? OLLAMA_DEFAULT_BASE_URL, model);
    }
    if (kind === 'chatgpt') {
      // Catalog-aware, and the default model comes from the catalog too.
      const stored = providerConfigEntry(cfg, kind).model;
      const catalog = chatgptSession().cachedModels();
      return chatgptModelVision(stored ?? (catalog.length ? pickDefaultChatgptModel(catalog) : model), catalog);
    }
    return modelVision(kind, model);
  } catch {
    return 'unknown';
  }
}

/**
 * The ACTIVE local model's id, for the W9 gate copy ("Your current model
 * ({model}) does not support vision."). null for cloud-proxy and Anthropic
 * BYOK: both are always vision-capable, so no gate copy ever names them.
 * Never throws (mirrors activeLlmVision).
 */
export async function activeLlmModelLabel(): Promise<string | null> {
  try {
    const backend = await getAiBackendKind();
    if (backend === 'cloud-proxy') return null;
    const cfg = await loadConfig();
    const kind = (cfg.provider ?? 'anthropic') as ProviderKind;
    if (kind === 'anthropic') return null;
    return resolveLocalModel(cfg, kind);
  } catch {
    return null;
  }
}

/**
 * The deadline a caller should put on its OWN abort timer for one `provider`
 * request (261011). Providers apply a floor to `timeoutMs` (Ollama 120s for a
 * cold local load + full prompt eval, DeepSeek's first-token floor), but a
 * caller that aborts through its own AbortController after a fixed delay
 * (Draw! guessed at 30s and drew at 60s) bypassed those floors, so on local
 * hardware every Draw! call was cut off before the model answered. Cloud and
 * Anthropic BYOK keep `ms` unchanged.
 */
export function providerTimeoutMs(provider: Pick<LlmProvider, 'kind'>, ms: number): number {
  if (provider.kind === 'ollama') return ollamaTimeoutMs(ms);
  if (provider.kind === 'anthropic' || provider.kind === 'gemini' || provider.kind === 'chatgpt') return ms;
  return openaiCompatTimeoutMs(provider.kind as ProviderKind, ms);
}
