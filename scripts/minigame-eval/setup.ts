/**
 * Vitest setup for the minigame eval: the only shims around the REAL game
 * services (battleshipService / connect4Service, boardTurn, chatPrompts,
 * chatStore, fsm.js queue, llm/anthropic provider).
 *
 * Shimmed, and nothing else:
 *   - characterStore.getCharacter: returns the character the eval registered
 *     (a cloud `characters` row mapped like cloudCharacterClient.rowToCharacter);
 *   - configStore.loadConfig: a fixed player name and English UI;
 *   - chat/sdk.buildChatSdk: the BYOK branch's exact client
 *     (new Anthropic({ apiKey, maxRetries: 1 }), model COMPANION_MODEL) with the
 *     dev key, instead of the cloud proxy (which needs a user JWT);
 *   - analytics: capture() is recorded in memory, never sent;
 *   - chat/usageLimit popup and continuity.foldIfDue: no-ops (no UI, no fold).
 * Everything else (paths, chat store, memory files) runs for real in a temp
 * userData dir set by the eval.
 */
import { vi } from 'vitest';

type Glob = typeof globalThis & {
  __mgEval?: {
    getCharacter: (id: string) => unknown;
    playerName: string;
    apiKey: string;
    capture: (event: string, props: Record<string, unknown>) => void;
  };
};
const g = globalThis as Glob;

vi.mock('../../src/main/characterStore', async (orig) => ({
  ...(await orig<typeof import('../../src/main/characterStore')>()),
  getCharacter: vi.fn(async (id: string) => g.__mgEval?.getCharacter(id) ?? null),
}));

vi.mock('../../src/main/configStore', async (orig) => ({
  ...(await orig<typeof import('../../src/main/configStore')>()),
  loadConfig: vi.fn(async () => ({ preferred_name: g.__mgEval?.playerName ?? 'Ren', ui_language: 'en' })),
}));

vi.mock('../../src/main/chat/sdk', async (orig) => {
  const real = await orig<typeof import('../../src/main/chat/sdk')>();
  return {
    ...real,
    buildChatSdk: vi.fn(async () => {
      const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
      const apiKey = g.__mgEval?.apiKey;
      if (!apiKey) throw new Error('mg-eval: no api key registered');
      return { client: new AnthropicSdk({ apiKey, maxRetries: 1 }), model: real.CHAT_MODEL };
    }),
  };
});

vi.mock('../../src/main/analytics', async () => {
  const { surfaceErrorClass } = await import('../../src/main/surfaceErrorClass');
  return {
    capture: (event: string, props: Record<string, unknown>) => g.__mgEval?.capture(event, props),
    captureSurfaceError: (surface: string, cls: string) =>
      g.__mgEval?.capture('surface_error', { surface, cls }),
    surfaceErrorClass,
  };
});

vi.mock('../../src/main/chat/usageLimit', () => ({ raiseUsageLimitPopup: vi.fn(async () => null) }));

vi.mock('../../src/main/chat/continuity', async (orig) => ({
  ...(await orig<typeof import('../../src/main/chat/continuity')>()),
  foldIfDue: vi.fn(async () => {}),
}));
