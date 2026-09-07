// 260828: the ONE builder for the `llm` section main ships to the bot —
// used by BOTH bot-facing credential paths in botSupervisor.ts:
//   - the summon init payload (`llm: llmInit`), and
//   - the mid-session cloud→local `{type:'backend-switch'}` message.
//
// It existed inline in _summon only, which is exactly why the backend-switch
// path shipped no llm section at all: a live bot switched cloud→local kept
// running Anthropic with stale defaults regardless of the configured
// provider (fixed 260828). The bot folds the section into config.llm via
// src/bot/llmInit.js (applyLlmInit at init, applyLlmSwitch on a switch).
//
// The model falls back to the SHARED catalog default (DEFAULT_MODELS) rather
// than being omitted (260817, W10): the bot's own Zod defaults predate the
// catalog and had diverged (gpt-4o-mini vs gpt-5-mini, grok-2 vs grok-4), so
// omitting the model ran a DIFFERENT model in Minecraft than every other
// surface. (The bot defaults are aligned + drift-tested now — see
// src/bot/llmCatalogSync.test.js — but shipping the resolved model keeps the
// wire self-describing.) base_url ships only when the user configured an
// override. api_key duplicates the top-level `apiKey` field, which is KEPT
// for back-compat and for the Anthropic path.

import { DEFAULT_MODELS } from '../shared/llmCatalog';
import type { UserConfig } from '../shared/characterSchema';

export interface LlmInitSection {
  provider: string;
  model?: string;
  base_url?: string;
  api_key: string;
}

/**
 * Build the `llm` section for a LOCAL (BYOK) bot session from the user's
 * Settings picker state. Cloud-proxy sessions never call this — they stay on
 * the anthropic+cloudMode path with no llm section.
 */
export function buildLlmInitSection(
  userCfg: Partial<Pick<UserConfig, 'provider' | 'provider_config'>>,
  apiKey: string,
): LlmInitSection {
  const provider = userCfg.provider ?? 'anthropic';
  const pcRaw = (userCfg.provider_config as Record<string, unknown> | undefined)?.[provider];
  const pc = (pcRaw && typeof pcRaw === 'object' ? pcRaw : {}) as { model?: unknown; base_url?: unknown };
  const model =
    typeof pc.model === 'string' && pc.model.trim()
      ? pc.model.trim()
      : DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS];
  const baseUrl = typeof pc.base_url === 'string' && pc.base_url.trim() ? pc.base_url.trim() : undefined;
  return {
    provider,
    api_key: apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  };
}
