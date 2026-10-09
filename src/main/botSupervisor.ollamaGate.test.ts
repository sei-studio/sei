/**
 * 261010 — summon gate for a local Ollama backend. A model with no tool
 * support (gemma3, llava, qwen2.5vl ...), a model never pulled, or Ollama not
 * running used to join the world and then stay mute all session. The summon
 * is now refused before fork with an error class the launch panel explains.
 * Harness mirrors botSupervisor.keyGuard.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getCharacterSpy, loadConfigSpy, sendStatusSpy, checkSpy } = vi.hoisted(() => ({
  getCharacterSpy: vi.fn(),
  loadConfigSpy: vi.fn(),
  sendStatusSpy: vi.fn(),
  checkSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
  MessageChannelMain: vi.fn(),
  app: { getPath: (_n: string) => '/tmp/sei-default' },
}));
vi.mock('./characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: vi.fn(async () => null),
}));
vi.mock('./apiKeyStore', () => ({
  loadApiKey: vi.fn(async () => ''),
  hasApiKey: vi.fn(async () => true),
  getAiBackendKind: vi.fn(async () => 'local'),
}));
vi.mock('./chat/continuity', () => ({
  buildLaunchContinuity: vi.fn(async () => null),
}));
vi.mock('./configStore', () => ({
  loadConfig: loadConfigSpy,
  saveConfig: vi.fn(async () => {}),
  addPlaytimeMs: vi.fn(async () => {}),
}));
vi.mock('./logRouter', () => ({
  createLogRouter: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
}));
vi.mock('./llm/ollamaCapabilities', async (orig) => ({
  ...(await orig<typeof import('./llm/ollamaCapabilities')>()),
  checkOllamaForGame: checkSpy,
}));

import { createBotSupervisor } from './botSupervisor';

const A = 'char-aaaa';

function makeSupervisor(): ReturnType<typeof createBotSupervisor> {
  return createBotSupervisor({
    getLanPort: () => null,
    sendStatus: sendStatusSpy,
    sendLog: vi.fn(),
    getSkinServerBaseUrl: () => null,
    cloudOverLimit: vi.fn(async () => false),
    emitHardStop: vi.fn(),
  });
}

beforeEach(() => {
  getCharacterSpy.mockReset();
  getCharacterSpy.mockResolvedValue({ id: A, name: 'Bot', username: 'Bot', persona: { source: 's', expanded: 'e' }, metadata: {} });
  loadConfigSpy.mockReset();
  sendStatusSpy.mockClear();
  checkSpy.mockReset();
});

describe('Ollama summon gate', () => {
  it('refuses a model without tool support before fork, with OLLAMA_MODEL_NO_TOOLS', async () => {
    loadConfigSpy.mockResolvedValue({
      provider: 'ollama',
      preferred_name: 'Ouen',
      provider_config: { ollama: { model: 'gemma3:12b', base_url: 'http://127.0.0.1:11434' } },
    });
    checkSpy.mockResolvedValue({ error: 'OLLAMA_MODEL_NO_TOOLS', message: 'gemma3:12b does not support tools' });
    await expect(makeSupervisor().summon(A)).rejects.toThrow(/^OLLAMA_MODEL_NO_TOOLS: /);
    expect(checkSpy).toHaveBeenCalledWith('http://127.0.0.1:11434', 'gemma3:12b');
    expect(sendStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', error: 'OLLAMA_MODEL_NO_TOOLS', characterId: A }),
    );
  });

  it('a usable model passes the gate (fails later, at the missing LAN world)', async () => {
    loadConfigSpy.mockResolvedValue({ provider: 'ollama', preferred_name: 'Ouen' });
    checkSpy.mockResolvedValue(null);
    await expect(makeSupervisor().summon(A)).rejects.toThrow(/LAN_NOT_OPEN/);
    // Default base URL and default model when the picker left them empty.
    expect(checkSpy).toHaveBeenCalledWith('http://localhost:11434', 'llama3.1');
  });

  it('is not consulted for other providers', async () => {
    loadConfigSpy.mockResolvedValue({ provider: 'deepseek', preferred_name: 'Ouen' });
    await expect(makeSupervisor().summon(A)).rejects.toThrow(/LAN_NOT_OPEN/);
    expect(checkSpy).not.toHaveBeenCalled();
  });
});
