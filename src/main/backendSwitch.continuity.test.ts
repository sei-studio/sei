/**
 * Backend switch data continuity (261023, product feedback: "make sure that signin to
 * chatgpt doesnt make them lose their current companion/memories").
 *
 * "Use your ChatGPT plan" on a signed-in Sei account does what Settings'
 * confirmSwitch does: save `provider: 'chatgpt'`, then proxy:configure
 * ('local') -> setAiBackendKind('local'). Switching back is
 * setAiBackendKind('cloud-proxy'). Everything a player keeps per companion
 * lives under the PROFILE root, which is keyed by the signed-in account
 * (paths.ts), never by the backend, and ChatGPT sign-in never touches the
 * Sei session or the scope. These tests pin that a round trip through the
 * ChatGPT plan leaves the same companion, memories, chat history and goals in
 * place, at the same paths, so nothing hides, disappears or forks into a
 * second copy. They also pin that the explicit choice survives a later
 * sign-in default (otherwise a re-sign-in would flip the player back to
 * cloud credits without asking).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    getSelectedStorageBackend: () => 'basic_text',
  },
}));

// saveCharacter fires an un-awaited cloud mirror enqueue; keep it inert.
vi.mock('./cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
}));

import { _setUserDataOverride, getActiveScope, paths, setActiveScope } from './paths';
import { applyCloudDefaultForSignIn, getAiBackendKind, setAiBackendKind } from './apiKeyStore';
import { getCharacter, listCharacters, saveCharacter } from './characterStore';
import { loadConfig, updateConfig } from './configStore';
import { appendMessage, readAll } from './chat/chatStore';
import type { Character } from '../shared/characterSchema';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const COMPANION = '550e8400-e29b-41d4-a716-446655440123';

function companion(): Character {
  return {
    id: COMPANION,
    kind: 'custom',
    public_id: null,
    name: 'Marv',
    persona: { source: 'a grumpy companion', expanded: 'long persona text' },
    is_default: false,
    shared: false,
    slug: null,
    owner: ACCOUNT,
    metadata: {},
    created: '2026-10-01T00:00:00.000Z',
    last_launched: '2026-10-20T12:00:00.000Z',
    playtime_ms: 3_600_000,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
  } as Character;
}

/** What the player would lose: every file the companion keeps, by content. */
async function snapshot(): Promise<Record<string, string>> {
  const dir = paths.memoryDir(COMPANION);
  const out: Record<string, string> = {};
  for (const f of (await readdir(dir)).sort()) out[f] = await readFile(path.join(dir, f), 'utf8');
  return out;
}

/** Settings' confirmSwitch for "Use your ChatGPT plan", main-side effects. */
async function switchToChatgptPlan(): Promise<void> {
  await updateConfig((cfg) => ({ ...cfg, provider: 'chatgpt', provider_config: cfg.provider_config ?? {} }));
  await setAiBackendKind('local');
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-backend-continuity-'));
  _setUserDataOverride(tmp);
  // A signed-in Sei account on the cloud backend, with one companion that has
  // a history: memories, the player file, goals for two games, chat.
  setActiveScope(ACCOUNT);
  await setAiBackendKind('cloud-proxy', 'default');
  await saveCharacter(companion());
  const mem = paths.memoryDir(COMPANION);
  await mkdir(mem, { recursive: true });
  await writeFile(path.join(mem, 'MEMORY.md'), '## World 1 — Home (Minecraft)\n- [2026-10-20] Sei likes building lighthouses\n');
  await writeFile(path.join(mem, 'PLAYER.md'), 'Sei, plays after work\n');
  await writeFile(path.join(mem, 'HEARTBEAT.md'), '- Build the copper lighthouse\n');
  await writeFile(path.join(mem, 'HEARTBEAT.stardew.md'), '- Plant parsnips\n');
  await appendMessage(COMPANION, { id: 'm1', role: 'user', text: 'hey marv', ts: 1 } as never);
  await appendMessage(COMPANION, { id: 'm2', role: 'assistant', text: 'oh. it is you.', ts: 2 } as never);
});

afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  try {
    await rm(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('cloud -> ChatGPT plan -> cloud keeps the same companions and memories', () => {
  it('switching to the ChatGPT plan moves nothing: same account scope, roster, memory dir and files', async () => {
    const root = paths.profileRoot();
    const memDir = paths.memoryDir(COMPANION);
    const before = await snapshot();
    const chatBefore = await readAll(COMPANION);

    await switchToChatgptPlan();

    expect(await getAiBackendKind()).toBe('local');
    expect((await loadConfig()).provider).toBe('chatgpt');
    // Same account, same profile root: the player is still signed in to Sei.
    expect(getActiveScope()).toBe(ACCOUNT);
    expect(paths.profileRoot()).toBe(root);
    // The companion is still in the roster, unchanged and still theirs.
    expect((await listCharacters()).map((c) => c.id)).toContain(COMPANION);
    expect((await getCharacter(COMPANION))?.owner).toBe(ACCOUNT);
    expect((await getCharacter(COMPANION))?.playtime_ms).toBe(3_600_000);
    // Memories, goals and chat at the SAME path (no fork into a new copy).
    expect(paths.memoryDir(COMPANION)).toBe(memDir);
    expect(await snapshot()).toEqual(before);
    expect(await readAll(COMPANION)).toEqual(chatBefore);
    // No second profile tree appeared for the "local" backend.
    expect((await readdir(path.join(tmp, 'profiles'))).sort()).toEqual([ACCOUNT]);
  });

  it('what is written while on the ChatGPT plan is still there after switching back to cloud', async () => {
    await switchToChatgptPlan();
    // A session on the ChatGPT plan: a new memory and a chat line.
    await writeFile(
      path.join(paths.memoryDir(COMPANION), 'MEMORY.md'),
      (await readFile(path.join(paths.memoryDir(COMPANION), 'MEMORY.md'), 'utf8')) +
        '- [2026-10-23] Sei switched to their ChatGPT plan\n',
    );
    await appendMessage(COMPANION, { id: 'm3', role: 'user', text: 'still me', ts: 3 } as never);
    const onPlan = await snapshot();

    await setAiBackendKind('cloud-proxy');

    expect(getActiveScope()).toBe(ACCOUNT);
    expect((await listCharacters()).map((c) => c.id)).toContain(COMPANION);
    expect(await snapshot()).toEqual(onPlan);
    expect((await readAll(COMPANION)).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('the ChatGPT plan choice survives a later sign-in default (no silent flip back to Sei credits)', async () => {
    await switchToChatgptPlan();
    await applyCloudDefaultForSignIn();
    expect(await getAiBackendKind()).toBe('local');
    expect((await loadConfig()).provider).toBe('chatgpt');
  });
});
