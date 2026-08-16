/**
 * 260817 (china-compat W10) — the local-mode API-key guard vs keyless ollama.
 *
 * The 260703 hard guard refuses a local summon when no BYOK key is saved so a
 * keyless config can never silently ride the paid cloud. Ollama is the one
 * KEYLESS local provider (plain local HTTP; the W6 wizard deliberately saves
 * no key for it), so the guard must skip it — before W10 every keyless ollama
 * summon died with INVALID_API_KEY while chat worked fine, because the main
 * llm layer already skipped the key for ollama and the supervisor did not.
 *
 * Everything here stays pre-fork (the attempts fail at the preferred_name
 * gate, which sits AFTER the key guard), mirroring the summon.test harness.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getCharacterSpy, hasApiKeySpy, loadConfigSpy, sendStatusSpy } = vi.hoisted(() => ({
  getCharacterSpy: vi.fn(),
  hasApiKeySpy: vi.fn(),
  loadConfigSpy: vi.fn(),
  sendStatusSpy: vi.fn(),
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
  loadApiKey: vi.fn(async () => {
    throw new Error('loadApiKey must not be called in these cases');
  }),
  hasApiKey: hasApiKeySpy,
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

import { createBotSupervisor } from './botSupervisor';

const A = 'char-aaaa';

function makeSupervisor(): ReturnType<typeof createBotSupervisor> {
  return createBotSupervisor({
    getLanPort: () => 25565,
    sendStatus: sendStatusSpy,
    sendLog: vi.fn(),
    getSkinServerBaseUrl: () => null,
    cloudOverLimit: vi.fn(async () => false),
    emitHardStop: vi.fn(),
  });
}

function mkChar(id: string, username: string): unknown {
  return { id, name: username, username, persona: { source: 's', expanded: 'e' }, metadata: {} };
}

beforeEach(() => {
  getCharacterSpy.mockReset();
  getCharacterSpy.mockResolvedValue(mkChar(A, 'Bot'));
  hasApiKeySpy.mockReset();
  hasApiKeySpy.mockResolvedValue(false);
  loadConfigSpy.mockReset();
  sendStatusSpy.mockClear();
});

describe('local-mode key guard (W10)', () => {
  it('anthropic (default provider) with no key is refused with LOCAL_NO_API_KEY', async () => {
    loadConfigSpy.mockResolvedValue({}); // provider absent → anthropic
    const sup = makeSupervisor();
    await expect(sup.summon(A)).rejects.toThrow(/LOCAL_NO_API_KEY/);
    expect(sendStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', error: 'INVALID_API_KEY', characterId: A }),
    );
  });

  it('ollama with no key passes the guard (fails later at preferred_name, proving it got past)', async () => {
    loadConfigSpy.mockResolvedValue({ provider: 'ollama' });
    const sup = makeSupervisor();
    await expect(sup.summon(A)).rejects.toThrow('PREFERRED_NAME_MISSING');
    // The key guard never fired: no INVALID_API_KEY status, hasApiKey unasked.
    expect(hasApiKeySpy).not.toHaveBeenCalled();
    const errorStatuses = sendStatusSpy.mock.calls
      .map(([s]) => s as { error?: string })
      .filter((s) => s.error === 'INVALID_API_KEY');
    expect(errorStatuses).toEqual([]);
  });

  it('a non-ollama picker choice (deepseek) with no key still refuses', async () => {
    loadConfigSpy.mockResolvedValue({ provider: 'deepseek' });
    const sup = makeSupervisor();
    await expect(sup.summon(A)).rejects.toThrow(/LOCAL_NO_API_KEY/);
    expect(hasApiKeySpy).toHaveBeenCalled();
  });
});
