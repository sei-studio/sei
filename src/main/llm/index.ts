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
import {
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
import { createOpenAICompatProvider } from './openaiCompat';
import { createGeminiProvider } from './gemini';
import { createOllamaProvider, OLLAMA_DEFAULT_BASE_URL } from './ollama';
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
  return providerConfigEntry(cfg, kind).model ?? DEFAULT_MODELS[kind] ?? 'claude-haiku-4-5';
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
 * Build the active provider for the current backend + config. Read fresh per
 * call (like buildChatSdk always was), so a cloud<->local switch, provider
 * change, or JWT rotation is picked up with no long-lived state.
 */
export async function buildLlmProvider(): Promise<LlmProvider> {
  const backend = await getAiBackendKind();
  if (backend === 'cloud-proxy') return createAnthropicProvider('cloud-proxy');
  const kind = await localProviderKind();
  return buildLocalProviderFor(kind);
}

/**
 * Vision capability of the ACTIVE chat backend, computed from config alone —
 * no key required, never throws. cloud-proxy → 'yes' (Haiku sees). Feeds the
 * llm:capability push and the backseat session-start hard gate.
 */
export async function activeLlmVision(): Promise<VisionVerdict> {
  try {
    const backend = await getAiBackendKind();
    if (backend === 'cloud-proxy') return 'yes';
    const cfg = await loadConfig();
    const kind = (cfg.provider ?? 'anthropic') as ProviderKind;
    if (kind === 'anthropic') return 'yes';
    return modelVision(kind, resolveLocalModel(cfg, kind));
  } catch {
    return 'unknown';
  }
}
