/**
 * The guided first moment (260926), main side: chat:opened can carry
 * `firstMoment: {primary}`, which adds ONE thought to the ordinary
 * first-meeting greeting so it ends on an offer to play. Everything else about
 * the greeting (eligibility, one per companion, the LLM path every backend
 * shares) is unchanged, so these tests pin only the delta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';

const { callSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  callSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('../llm', () => ({
  activeLlmVision: async () => 'yes',
  buildLlmProvider: async () => ({ kind: 'anthropic', backend: 'cloud', model: 'test', call: callSpy }),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Robin' })),
}));
vi.mock('../llm/webSearchSettings', () => ({
  resolveWebSearchSettings: () => ({ provider: 'auto', api_key: '' }),
  getChatWebSession: () => ({ lastProvider: 'fake', beginTurn() {}, async runTool() { return { content: '', is_error: false }; } }),
}));

import { sendFirstMeetingTurn } from './chatService';
import { thoughtFirstMoment } from './thoughts';

const CHAR = '66666666-6666-4666-8666-666666666666';
let dir: string;
let character: Record<string, unknown>;

/** The single user note the greeting call was sent. */
function sentNote(): string {
  const req = callSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
  return JSON.stringify(req.messages);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-first-moment-'));
  _setUserDataOverride(dir);
  character = {
    id: CHAR,
    name: 'Nova',
    persona: { source: 'bright and curious', expanded: 'PERSONA' },
    metadata: {},
  };
  getCharacterSpy.mockImplementation(async () => structuredClone(character));
  patchCharacterSpy.mockReset();
  patchCharacterSpy.mockImplementation(async (_id: string, updater: (c: typeof character) => typeof character) => {
    character = updater(structuredClone(character));
    return structuredClone(character);
  });
  callSpy.mockReset();
  callSpy.mockResolvedValue({ content: [{ type: 'text', text: 'hey Robin! wanna play chess?' }], stopReason: 'end_turn' });
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('sendFirstMeetingTurn with firstMoment', () => {
  it('without options the note is the plain first-meeting greeting', async () => {
    const out = await sendFirstMeetingTurn(CHAR, { getLanState: () => ({ kind: 'closed' }) });
    expect(out.length).toBeGreaterThan(0);
    expect(callSpy).toHaveBeenCalledTimes(1);
    const note = sentNote();
    expect(note).toContain('World Zero');
    expect(note).not.toContain('finished setting up Sei');
  });

  it('chess: the note asks for a short greeting that ends on a chess invitation', async () => {
    await sendFirstMeetingTurn(CHAR, { getLanState: () => ({ kind: 'closed' }) }, { firstMoment: { primary: 'chess' } });
    const note = sentNote();
    expect(note).toContain('World Zero');
    expect(note).toContain('finished setting up Sei');
    expect(note).toContain('chess');
    expect(note).not.toContain('Minecraft world');
  });

  it('minecraft: the note invites them to have the companion join their open world', async () => {
    await sendFirstMeetingTurn(CHAR, { getLanState: () => ({ kind: 'open', port: 1, motd: 'w', lastSeenAt: 0 }) }, {
      firstMoment: { primary: 'minecraft' },
    });
    const note = sentNote();
    expect(note).toContain('Minecraft world they have open');
  });

  it('the player name reaches the greeting call', async () => {
    await sendFirstMeetingTurn(CHAR, undefined, { firstMoment: { primary: 'chess' } });
    const req = callSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('Robin');
  });

  it('a companion that has already chatted gets no greeting, first moment or not', async () => {
    character.last_chatted = Date.now();
    const out = await sendFirstMeetingTurn(CHAR, undefined, { firstMoment: { primary: 'chess' } });
    expect(out).toEqual([]);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('an LLM failure propagates so the renderer can fall back', async () => {
    callSpy.mockRejectedValue(new Error('401 bad key'));
    await expect(sendFirstMeetingTurn(CHAR, undefined, { firstMoment: { primary: 'chess' } })).rejects.toThrow('401');
  });
});

describe('thoughtFirstMoment copy', () => {
  it('is plain model-facing text with no em or en dashes', () => {
    for (const p of ['chess', 'minecraft'] as const) {
      const t = thoughtFirstMoment(p);
      expect(t).not.toMatch(/[—–]/);
      expect(t).toContain('button');
    }
  });
});
