/**
 * Chat turn correctness — the tool-use hop loop and the last_chatted stamp.
 *
 * Pins two invariants of sendChatMessage:
 *   - Every tool_use block in an assistant turn gets a matching tool_result in
 *     the next user message. With launch + quit both offered, the model can
 *     call them in parallel ("say bye and log off, then hop back in") — an
 *     unanswered tool_use id makes the follow-up create() 400.
 *   - The last_chatted stamp goes through patchCharacter (260705: fresh read
 *     inside the store's lock), never the turn's opening snapshot — that
 *     snapshot is seconds stale by the time the reply lands; spreading it
 *     would silently revert an edit saved mid-reply (and sync the revert to
 *     the cloud). Mirrors the last_launched stamp in botSupervisor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { drainScopedWrites } from '../profile/scopeBarrier';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';

const { createSpy, streamSpy, getCharacterSpy, patchCharacterSpy, captureSpy } = vi.hoisted(() => ({
  captureSpy: vi.fn(),
  createSpy: vi.fn(),
  streamSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('../analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics')>()),
  capture: captureSpy,
}));
vi.mock('./sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({
    client: { messages: { create: createSpy, stream: streamSpy } },
    model: 'test-model',
  })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
// 260909: search()/visit() ride a per-character web session; stub it so the
// hop loop is exercised with no network.
const { webRuns } = vi.hoisted(() => ({ webRuns: [] as Array<{ name: string; input: unknown }> }));
vi.mock('../llm/webSearchSettings', () => ({
  resolveWebSearchSettings: () => ({ provider: 'auto', api_key: '' }),
  getChatWebSession: () => ({
    lastProvider: 'fake',
    beginTurn() {},
    async runTool(name: string, input: { query?: string; ref?: string }) {
      webRuns.push({ name, input });
      if (name === 'search') return { content: `results for "${input.query}":\na. Netherite Armor (minecraft.wiki) - strongest armor`, is_error: false };
      return { content: `[${input.ref}] minecraft.wiki - Netherite Armor\nMade at a smithing table.`, is_error: false };
    },
  }),
}));

import type { ChatDeps } from './chatService';
import type { LanHost } from '../../shared/ipc';
import { sendChatMessage, sendLaunchFailedTurn, sendVoiceIdleTurn, sendCompanionVoiceTurn, sendVoiceGreetingTurn, cancelInflightTurn, CHAT_ABORTED } from './chatService';
import { setCallActive } from '../voice/callState';
import { readAll as chatStoreRead, appendMessage } from './chatStore';
import { consumeGoodbye, _resetGoodbyeNotes } from '../sessionGoodbye';

const CHAR = '55555555-5555-4555-8555-555555555555';
let dir: string;
let character: { id: string; name: string; persona: { source: string; expanded: string }; metadata: Record<string, unknown> };

const deps = (): ChatDeps => ({
  getLanState: () => ({ kind: 'closed' }),
  summon: vi.fn(async () => undefined),
  leaveGame: vi.fn(),
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-turn-'));
  _setUserDataOverride(dir);
  character = {
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'ORIGINAL PERSONA' },
    metadata: {},
  };
  // Every read returns the CURRENT character — like the store, not a snapshot.
  getCharacterSpy.mockImplementation(async () => structuredClone(character));
  // patchCharacter fake mirrors the real contract: read the CURRENT character,
  // apply the updater, PERSIST the result back to the store (so later reads
  // see it), and hand it back (recorded in mock.results).
  patchCharacterSpy.mockReset();
  patchCharacterSpy.mockImplementation(
    async (_id: string, updater: (c: typeof character) => typeof character) => {
      character = updater(structuredClone(character));
      return structuredClone(character);
    },
  );
  createSpy.mockReset();
  streamSpy.mockReset();
  captureSpy.mockReset();
});
afterEach(async () => {
  // 261110: a finished turn records its tokens in the profile's usage ledger
  // (usage/llmUsageLedger.ts) a moment later; let those writes land before
  // the profile dir is removed (they would race the rm: ENOTEMPTY).
  await drainScopedWrites();
  _setUserDataOverride(null);
  // callState is module-level; clear it so a test that opened a call never
  // leaks the flag into the next one.
  setCallActive(CHAR, false);
  await rm(dir, { recursive: true, force: true });
});

describe('sendChatMessage — parallel tool_use blocks', () => {
  it('answers every tool_use id in one tool_result turn (quit + launch in parallel)', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'logging off — back when you reopen.' },
          { type: 'tool_use', id: 'tu_quit', name: 'quit_game', input: {} },
          { type: 'tool_use', id: 'tu_launch', name: 'launch', input: { game: 'minecraft' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok, gone for real.' }] });

    const d = deps();
    const result = await sendChatMessage({ characterId: CHAR, text: 'say bye and log off, then hop back in' }, d);

    expect(createSpy).toHaveBeenCalledTimes(2);
    // The second hop's request must carry one tool_result per tool_use id —
    // anything less is a guaranteed 400 from the API.
    const secondReq = createSpy.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const resultTurn = secondReq.messages[secondReq.messages.length - 1];
    expect(resultTurn.role).toBe('user');
    const blocks = resultTurn.content as Array<{ type: string; tool_use_id: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['tu_quit', 'tu_launch']);

    expect(d.leaveGame).toHaveBeenCalledTimes(1);
    expect(result.replies.length).toBeGreaterThan(0);
  });

  it('still runs the single-tool loop unchanged', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'launch', input: { game: 'minecraft' } }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'world is closed — open to LAN first.' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'hop in' }, deps());

    const secondReq = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    const blocks = secondReq.messages[secondReq.messages.length - 1].content as Array<{ tool_use_id: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool_use_id).toBe('tu_1');
    expect(result.launch).toEqual({ game: 'minecraft', status: 'lan-not-open' });
  });

  // 260929: the chat launch() path gets the same Forge hard stop as the
  // Summon button (shared forgeHostBlock), as a plain note to relay.
  const openLan = (host: LanHost | undefined): ChatDeps['getLanState'] => () => ({
    kind: 'open',
    port: 55555,
    motd: 'World',
    lastSeenAt: Date.now(),
    host,
  });
  const blockedCalls = () => captureSpy.mock.calls.filter((c) => c[0] === 'summon_blocked');
  const launchOnce = async (d: ChatDeps): Promise<{ note: string; result: Awaited<ReturnType<typeof sendChatMessage>> }> => {
    createSpy
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu_1', name: 'launch', input: { game: 'minecraft' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    const result = await sendChatMessage({ characterId: CHAR, text: 'hop in' }, d);
    const secondReq = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    const blocks = secondReq.messages[secondReq.messages.length - 1].content as Array<{ content: unknown }>;
    return { note: JSON.stringify(blocks[0].content), result };
  };

  it.each([
    ['Forge (status ping)', { client: 'forge', forgeModCount: 2 } as LanHost, 'Forge'],
    ['NeoForge (launch target)', { client: 'neoforge', forgeModCount: null, forgeLaunchTarget: true } as LanHost, 'NeoForge'],
  ])('launch() on a %s host refuses with a plain, relayable reason and never summons', async (_l, host, loader) => {
    const d = { ...deps(), getLanState: openLan(host) };
    const { note, result } = await launchOnce(d);
    expect(note).toContain(`can't join ${loader} worlds`);
    expect(note).toContain('Sei profile');
    expect(note).toContain('do not retry');
    expect(result.launch).toEqual({ game: 'minecraft', status: 'lan-not-open' });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.summon).not.toHaveBeenCalled();
    // Settle the fire-and-forget capture here so it cannot land in a later test.
    await vi.waitFor(() => expect(blockedCalls()).toHaveLength(1));
  });

  it('a Forge refusal fires one summon_blocked (path chat), even if launch() is called twice in the turn', async () => {
    const d = { ...deps(), getLanState: openLan({ client: 'forge', forgeModCount: 2 }) };
    createSpy
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu_1', name: 'launch', input: { game: 'minecraft' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu_2', name: 'launch', input: { game: 'minecraft' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hop in' }, d);
    await vi.waitFor(() => expect(blockedCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(blockedCalls()).toHaveLength(1);
    expect(blockedCalls()[0][1]).toEqual({
      character_id: CHAR,
      game: 'minecraft',
      reason: 'FORGE_HOST_BLOCKED',
      loader: 'Forge',
      host_client: 'forge',
      path: 'chat',
    });
  });

  it('a Forge refusal on a voice turn is tagged path voice', async () => {
    const d = { ...deps(), getLanState: openLan({ client: 'neoforge', forgeModCount: null, forgeLaunchTarget: true }) };
    createSpy
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu_1', name: 'launch', input: { game: 'minecraft' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    await sendChatMessage({ characterId: CHAR, text: 'hop in', voiceCall: true }, d).catch(() => {});
    await vi.waitFor(() => expect(blockedCalls()).toHaveLength(1));
    expect(blockedCalls()[0][1]).toMatchObject({ path: 'voice', loader: 'NeoForge', host_client: 'neoforge' });
  });

  it('a launch that goes ahead fires no summon_blocked', async () => {
    const d = { ...deps(), getLanState: openLan({ client: 'forge', forgeModCount: null }) };
    await launchOnce(d);
    await vi.waitFor(() => expect(d.summon).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(blockedCalls()).toHaveLength(0);
  });

  it.each([
    ['vanilla', { client: 'vanilla', forgeModCount: null } as LanHost],
    ["Sei's own Fabric profile", { client: 'fabric', forgeModCount: null, seiSkinMod: true, otherModCount: 0 } as LanHost],
    ['Forge on weak evidence only', { client: 'forge', forgeModCount: null } as LanHost],
  ])('launch() on a %s host still joins', async (_l, host) => {
    const d = { ...deps(), getLanState: openLan(host) };
    const { note, result } = await launchOnce(d);
    expect(note).not.toContain("can't join");
    expect(result.launch).toEqual({ game: 'minecraft', status: 'summoning' });
    await vi.waitFor(() => expect(d.summon).toHaveBeenCalledTimes(1));
  });

  it('a Forge pre-gate refusal from a voice launch is relayed as the reason, without "try again"', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: "can't get into forge worlds, try the sei profile" }] });
    await sendLaunchFailedTurn(
      CHAR,
      "FORGE_HOST_BLOCKED: Sei can't join Forge worlds. To play together, open the Sei profile in the Minecraft Launcher, open or create a world there, and open it to LAN.",
    );
    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const sent = JSON.stringify(req.messages[req.messages.length - 1].content);
    expect(sent).toContain("Sei can't join Forge worlds");
    expect(sent).toContain('Sei profile');
    expect(sent).toContain('Do not offer to try again');
    expect(sent).not.toContain('FORGE_HOST_BLOCKED');
  });

  it('does NOT run a second hop when quit rides with an already-spoken goodbye (double-goodbye guard)', async () => {
    // The model says its goodbye AND calls quit in one response. The old code ran
    // a second hop whose tool-note said "say goodbye if you have not already",
    // producing a redundant second farewell. The guard stops after the first hop.
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'aight, catch you later.' },
        { type: 'tool_use', id: 'tu_quit', name: 'quit_game', input: {} },
      ],
    });
    // A second resolve is staged but must never be consumed.
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'later, thanks for having me.' }] });

    const d = deps();
    const result = await sendChatMessage({ characterId: CHAR, text: 'you can head off' }, d);

    expect(createSpy).toHaveBeenCalledTimes(1); // no redundant second goodbye hop
    expect(d.leaveGame).toHaveBeenCalledTimes(1);
    // splitReply strips the trailing period under the default casual register.
    expect(result.replies.map((r) => r.text)).toEqual(['aight, catch you later']);
  });

  it('remember() on a voice turn appends to MEMORY.md and ends the turn once the reply is out', async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'oh a big exam, noted.' },
        { type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'player has a big exam on friday' } },
      ],
    });
    // A second response is staged but must never be consumed (261020).
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'good luck friday.' }] });

    const result = await sendChatMessage(
      { characterId: CHAR, text: 'i have a big exam friday', voiceCall: true },
      deps(),
    );

    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('player has a big exam on friday');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.replies.map((r) => r.text)).toEqual(['oh a big exam, noted.']);
  });

  it('typed chat (261008) offers remember() and writes it to MEMORY.md too', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'happy early birthday then.' },
          { type: 'tool_use', id: 'tu_rem2', name: 'remember', input: { text: "ouen's birthday is November 14th" } },
        ],
      })
      .mockResolvedValueOnce({ content: [] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'my birthday is nov 14 btw' }, deps());

    const firstReq = createSpy.mock.calls[0][0] as { tools: Array<{ name: string }>; system: Array<{ text: string }> };
    expect(firstReq.tools.map((t) => t.name)).toContain('remember');
    expect(firstReq.tools.map((t) => t.name)).not.toContain('end_call');
    expect(firstReq.system[firstReq.system.length - 1].text).toContain('Memory check:');
    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain("ouen's birthday is November 14th");
    expect(result.replies.map((r) => r.text).join(' ')).toContain('happy early birthday');
  });
});

describe('search() / visit() hop loop (260909)', () => {
  it('answers search then visit with tool_results and keeps hopping until the model stops', async () => {
    webRuns.length = 0;
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'lemme check.' },
          { type: 'tool_use', id: 'tu_s', name: 'search', input: { query: 'netherite armor' } },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_v', name: 'visit', input: { ref: 'a' } }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'smithing table, diamond gear plus an ingot.' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'how do i make netherite armor' }, deps());

    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(webRuns.map((r) => r.name)).toEqual(['search', 'visit']);
    // The Anthropic path offers the native server search plus our visit.
    const firstReq = createSpy.mock.calls[0][0] as { tools: Array<{ name: string; type?: string }> };
    expect(firstReq.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['web_search', 'visit']));
    expect(firstReq.tools.find((t) => t.name === 'web_search')?.type).toBe('web_search_20250305');
    expect(firstReq.tools.map((t) => t.name)).not.toContain('search');
    // The messages array is shared across hops (pushed in place), so inspect
    // the final transcript: every tool_use was answered, in order, with the
    // web result as the tool_result content.
    const lastReq = createSpy.mock.calls[2][0] as { messages: Array<{ role: string; content: unknown }> };
    const results = lastReq.messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string }>) : []))
      .filter((b) => b.type === 'tool_result');
    expect(results.map((b) => b.tool_use_id)).toEqual(['tu_s', 'tu_v']);
    expect(results[0].content).toContain('results for "netherite armor"');
    expect(results[1].content).toContain('smithing table');
    // The final reply is what reaches the player.
    expect(result.replies.map((r) => r.text).join(' ')).toMatch(/smithing table/);
  });
});

describe('a line beside search() lands before the lookup (260909)', () => {
  it('pushes the same-hop text immediately and returns only the post-result reply', async () => {
    webRuns.length = 0;
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'lemme check.' },
          { type: 'tool_use', id: 'tu_s', name: 'search', input: { query: 'netherite armor' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'smithing table, diamond gear plus an ingot.' }] });

    const pushed: string[] = [];
    const d: ChatDeps = { ...deps(), emitReply: (_id, m) => { pushed.push(m.text); } };
    const result = await sendChatMessage({ characterId: CHAR, text: 'how do i make netherite armor' }, d);

    expect(pushed).toEqual(['lemme check']);
    expect(result.replies.map((r) => r.text)).toEqual(['smithing table, diamond gear plus an ingot']);
    // Both lines are in the transcript, in order.
    const rows = await chatStoreRead(CHAR);
    expect(rows.filter((r) => r.role === 'companion').map((r) => r.text)).toEqual([
      'lemme check',
      'smithing table, diamond gear plus an ingot',
    ]);
  });

  it('a text-only final hop is not doubled by the empty-reply fallback', async () => {
    webRuns.length = 0;
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'one sec, looking.' },
          { type: 'tool_use', id: 'tu_s', name: 'search', input: { query: 'x' } },
        ],
      })
      .mockResolvedValueOnce({ content: [] });
    const pushed: string[] = [];
    const d: ChatDeps = { ...deps(), emitReply: (_id, m) => { pushed.push(m.text); } };
    const result = await sendChatMessage({ characterId: CHAR, text: 'look up x' }, d);
    expect(pushed).toEqual(['one sec, looking']);
    expect(result.replies).toEqual([]);
  });
});

describe('native server-side web_search on the Anthropic path (260909)', () => {
  const serverBlocks = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ucla chancellor' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'UCLA', url: 'https://ucla.edu', encrypted_content: 'x'.repeat(200) }] },
  ];

  it('pushes the pre-search line first and keeps only the post-search text as the reply', async () => {
    createSpy.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'lemme check.' },
        ...serverBlocks,
        { type: 'text', text: "it's julio frenk." },
      ],
    });
    const pushed: string[] = [];
    const d: ChatDeps = { ...deps(), emitReply: (_id, m) => { pushed.push(m.text); } };
    const result = await sendChatMessage({ characterId: CHAR, text: "who is ucla's chancellor" }, d);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(pushed).toEqual(['lemme check']);
    expect(result.replies.map((r) => r.text)).toEqual(["it's julio frenk"]);
  });

  it('resumes a pause_turn by sending the assistant content back verbatim', async () => {
    createSpy
      .mockResolvedValueOnce({ stop_reason: 'pause_turn', content: [{ type: 'text', text: 'one sec.' }, ...serverBlocks] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'found it.' }] });
    const result = await sendChatMessage({ characterId: CHAR, text: 'look it up' }, deps());
    expect(createSpy).toHaveBeenCalledTimes(2);
    const req2 = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    const last = req2.messages[req2.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('web_search_tool_result');
    expect(result.replies.map((r) => r.text)).toEqual(['found it']);
  });
});

describe('server search + client visit in one response (260917)', () => {
  const serverBlocks = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'netherite armor' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'Netherite', url: 'https://minecraft.wiki/w/Netherite', encrypted_content: 'x'.repeat(200) }] },
  ];

  it('emits the pre-search line ONCE and the post-search line once, then answers', async () => {
    webRuns.length = 0;
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'lemme check.' },
          ...serverBlocks,
          { type: 'text', text: 'opening the page.' },
          { type: 'tool_use', id: 'tu_v', name: 'visit', input: { ref: 'a' } },
        ],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'smithing table, ancient debris.' }] });
    const pushed: string[] = [];
    const d: ChatDeps = { ...deps(), emitReply: (_id, m) => { pushed.push(m.text); } };
    const result = await sendChatMessage({ characterId: CHAR, text: 'how do i get netherite' }, d);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(webRuns.map((r) => r.name)).toEqual(['visit']);
    // The pre-search line must not be glued to, or repeated with, the line
    // that followed the server search.
    expect(pushed).toEqual(['lemme check', 'opening the page']);
    expect(result.replies.map((r) => r.text)).toEqual(['smithing table, ancient debris']);
    const rows = await chatStoreRead(CHAR);
    const companion = rows.filter((r) => r.role === 'companion').map((r) => r.text);
    expect(companion.filter((t) => t.startsWith('lemme check')).length).toBe(1);
  });
});

describe('single-shot voice turns run an announced lookup (260917)', () => {
  it('idle nudge: a search() tool_use gets ONE follow-up call and the answer is spoken after the announce', async () => {
    setCallActive(CHAR, true);
    webRuns.length = 0;
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'one sec, let me look that up.' },
          { type: 'tool_use', id: 'tu_s', name: 'search', input: { query: 'netherite armor' } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'netherite is the strongest armor.' },
          // A second lookup is NOT honored: the follow-up is bounded to one hop.
          { type: 'tool_use', id: 'tu_v', name: 'visit', input: { ref: 'a' } },
        ],
      });
    const result = await sendVoiceIdleTurn(CHAR, 60, [], { openWorldDetected: false });
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(webRuns.map((r) => r.name)).toEqual(['search']);
    const req2 = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    const last = req2.messages[req2.messages.length - 1];
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('"tool_use_id":"tu_s"');
    const spoken = result.messages.map((m) => m.text).join(' ');
    expect(spoken).toContain('one sec, let me look that up');
    expect(spoken).toContain('netherite is the strongest armor');
  });

  it('companion reaction: a pause_turn (server search ran long) is resumed once', async () => {
    setCallActive(CHAR, true);
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        content: [
          { type: 'text', text: 'hang on.' },
          { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'x' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: [] },
        ],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'found it, it is julio frenk.' }] });
    const result = await sendCompanionVoiceTurn(CHAR, { speakerName: 'Sui', text: 'who runs ucla', peers: ['Sui'] });
    expect(createSpy).toHaveBeenCalledTimes(2);
    const req2 = createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(req2.messages[req2.messages.length - 1].role).toBe('assistant');
    const spoken = result.map((m) => m.text).join(' ');
    expect(spoken).toContain('hang on');
    expect(spoken).toContain('julio frenk');
  });
});

describe('silence-by-convention + idle nudge (260707)', () => {
  it('a "(silence)" reply ends the turn with no reply persisted', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'brb grabbing water', voiceCall: true }, deps());

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.replies).toEqual([]);
  });

  it('"(staying silent)" and friends are parsed out too', async () => {
    // Includes the embellished forms captured from a real Sui/Marv transcript
    // (260707): trailing clause after the keyword, and bare "(nothing)".
    for (const filler of [
      '(staying silent)',
      '[stays quiet]',
      '*remains silent*',
      '(says nothing)',
      '(staying silent, letting it rest)',
      '(saying nothing, the thread has landed)',
      '(nothing)',
      // 260721 (shared silenceFiller.js): case + trailing punctuation, and the
      // "(no comment)" form the game prompts invite.
      '(Silence).',
      '(SILENCE)',
      '(no comment)',
    ]) {
      createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: filler }] });
      const result = await sendChatMessage({ characterId: CHAR, text: 'ok', voiceCall: true }, deps());
      expect(result.replies, filler).toEqual([]);
    }
  });

  it('typed chat keeps a filler-shaped roleplay beat (the drop is voice-only)', async () => {
    // No voiceCall flag: the "(silence)" convention is never prompted in text
    // chat, so an in-character "*stays silent*" is a real reply and must land
    // as a bubble instead of being silently discarded.
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '*stays silent*' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'say nothing then' }, deps());

    expect(result.replies.map((r) => r.text)).toEqual(['*stays silent*']);
  });

  it('the idle nudge never preempts an in-flight turn', async () => {
    setCallActive(CHAR, true);
    let release: (v: unknown) => void = () => {};
    createSpy.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const pending = sendChatMessage({ characterId: CHAR, text: 'hey', voiceCall: true }, deps());
    // Wait for the real turn to actually reach the LLM (holds the inflight slot).
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    const nudge = await sendVoiceIdleTurn(CHAR, 30, []);
    expect(nudge).toEqual({ messages: [] }); // skipped — a real turn is running
    expect(createSpy).toHaveBeenCalledTimes(1); // the nudge never called the LLM

    release({ content: [{ type: 'text', text: 'yo.' }] });
    const result = await pending;
    expect(result.replies.length).toBeGreaterThan(0); // the real turn was untouched
  });

  it('the idle nudge bails without an LLM call when no call is active (hang-up race)', async () => {
    // No setCallActive: the renderer timer fired just after hang-up. The nudge
    // must not run a paid turn or persist an unheard voice line.
    const nudge = await sendVoiceIdleTurn(CHAR, 30, []);

    expect(nudge).toEqual({ messages: [] });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('idle nudge honors a "(silence)" reply: nothing persisted or returned', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });

    const result = await sendVoiceIdleTurn(CHAR, 42, []);

    expect(result).toEqual({ messages: [] });
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The quiet-duration hint reached the model.
    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(req.messages)).toContain('quiet for about 42 seconds');
  });

  it('idle nudge surfaces end_call: the goodbye is returned AND endCall is flagged', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: "well, i'll let you go!" },
        { type: 'tool_use', id: 'tu_end', name: 'end_call', input: {} },
      ],
    });

    const result = await sendVoiceIdleTurn(CHAR, 90, []);

    expect(result.endCall).toBe(true);
    // The spoken goodbye still comes back so the renderer can speak it first.
    expect(result.messages.map((m) => m.text)).toEqual(["well, i'll let you go!"]);
    expect(createSpy).toHaveBeenCalledTimes(1); // no tool loop on a nudge
  });
});

// 261020 (review): a call's goodbye plan names the game it is for. Without
// it the plan has no game, and a Minecraft plan made at a hang-up became the
// main thing of a Stardew greeting. Named, it is labeled in MEMORY.md and the
// goodbye note carries the game to the Home card's tag.
describe('end_call next_time_game (261020 review)', () => {
  beforeEach(async () => {
    _resetGoodbyeNotes();
    await mkdir(paths.memoryDir(CHAR), { recursive: true });
  });

  it('offers the field on the call tools', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });
    await sendVoiceIdleTurn(CHAR, 42, []);
    const req = createSpy.mock.calls[0][0] as { tools: Array<{ name: string; input_schema: { properties: Record<string, unknown> } }> };
    expect(req.tools.find((t) => t.name === 'end_call')?.input_schema.properties).toHaveProperty('next_time_game');
  });

  it('a named game labels the plan and rides the goodbye note', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'ok bye, copper next time' },
        { type: 'tool_use', id: 'tu_end', name: 'end_call', input: { next_time: 'get copper for the lighthouse', next_time_game: 'Minecraft' } },
      ],
    });
    await sendVoiceIdleTurn(CHAR, 90, []);
    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('Plan for next time in Minecraft: get copper for the lighthouse');
    expect(consumeGoodbye(CHAR, 'call').nextStepGame).toBe('minecraft');
  });

  it('left out, the call plan has no game', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'bye, good luck' },
        { type: 'tool_use', id: 'tu_end', name: 'end_call', input: { next_time: 'ask how the interview went' } },
      ],
    });
    await sendVoiceIdleTurn(CHAR, 90, []);
    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('Plan for next time: ask how the interview went');
    const note = consumeGoodbye(CHAR, 'call');
    expect(note.nextStepHook).toBe(true);
    expect(note.nextStepGame).toBeUndefined();
  });

  // Delta review: main tags a chat quit's plan with the live session's game
  // when the field is left out (goodbyePlanPlace), so the memory line says so too.
  it('a chat quit_game that leaves the field out labels the plan with the live game', async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'ok heading out, parsnips next time' },
        { type: 'tool_use', id: 'tu_quit', name: 'quit_game', input: { next_time: 'plant the parsnips' } },
      ],
    });
    const d: ChatDeps = { ...deps(), isInGame: () => true, liveGame: () => 'stardew' };
    await sendChatMessage({ characterId: CHAR, text: 'you can head off' }, d);
    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('Plan for next time in Stardew Valley: plant the parsnips');
    const note = consumeGoodbye(CHAR, 'game');
    expect(note.nextStepHook).toBe(true);
    expect(note.nextStepGame).toBeUndefined();
    expect(d.leaveGame).toHaveBeenCalledTimes(1);
  });

  it('a chat quit_game with no live game still saves an unlabeled plan', async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'ok bye' },
        { type: 'tool_use', id: 'tu_quit', name: 'quit_game', input: { next_time: 'ask how the interview went', next_time_game: 'none' } },
      ],
    });
    const d: ChatDeps = { ...deps(), isInGame: () => true, liveGame: () => 'stardew' };
    await sendChatMessage({ characterId: CHAR, text: 'you can head off' }, d);
    const mem = await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
    expect(mem).toContain('Plan for next time: ask how the interview went');
    expect(consumeGoodbye(CHAR, 'game').nextStepGame).toBe('none');
  });
});

// 260708: while one companion was in the player's world, a call-only companion
// was told "no world open" (openWorldDetected hardcoded false) and its launch()
// calls were dropped (single-shot turns run no tool loop) — it could only join
// once the in-game sibling disconnected. These pin the fix: live LAN truth in
// the prompt, and launch() honored via the caller's onLaunch.
describe('call-only companion: world truth + single-shot launch honor (260708)', () => {
  it('companion reaction turn tells the model the world IS open and honors launch()', async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'hopping in.' },
        { type: 'tool_use', id: 'tu_l', name: 'launch', input: { game: 'minecraft' } },
      ],
    });
    const onLaunch = vi.fn();

    const replies = await sendCompanionVoiceTurn(CHAR, {
      speakerName: 'Sui',
      text: 'get in here marv',
      peers: ['Sui'],
      openWorldDetected: true,
      onLaunch,
    });

    expect(onLaunch).toHaveBeenCalledTimes(1);
    // A voice reply keeps its terminal period (260729, splitReply `spoken`):
    // it is speech being transcribed, and the mark is the intonation TTS lands.
    expect(replies.map((r) => r.text)).toEqual(['hopping in.']);
    const req = createSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('an open Minecraft world is detected');
    expect(JSON.stringify(req.system)).not.toContain('no open Minecraft world is detected');
  });

  it('companion reaction turn without a launch() call never fires onLaunch', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'lol true' }] });
    const onLaunch = vi.fn();

    await sendCompanionVoiceTurn(CHAR, {
      speakerName: 'Sui',
      text: 'this game is chaos',
      peers: ['Sui'],
      openWorldDetected: true,
      onLaunch,
    });

    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('companion reaction turn defaults to world-closed framing when no state is passed', async () => {
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'yeah' }] });

    await sendCompanionVoiceTurn(CHAR, { speakerName: 'Sui', text: 'hm', peers: ['Sui'] });

    const req = createSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('no open Minecraft world is detected');
  });

  it('idle nudge honors launch() through opts.onLaunch', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: "i'm gonna hop into the world." },
        { type: 'tool_use', id: 'tu_l', name: 'launch', input: { game: 'minecraft' } },
      ],
    });
    const onLaunch = vi.fn();

    const result = await sendVoiceIdleTurn(CHAR, 60, ['Sui'], { openWorldDetected: true, onLaunch });

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(result.messages.length).toBe(1);
    const req = createSpy.mock.calls[0][0] as { system: unknown };
    expect(JSON.stringify(req.system)).toContain('an open Minecraft world is detected');
  });
});

// 260708: on a group call a model sometimes ECHOES the transcript's attribution
// convention and writes a line FOR the other companion inside its own reply
// (live capture: Marv's reply opened with "(Sui, on the call): oh let's go..."
// — spoken in Marv's voice, and a ghost Sui line entered the transcript). The
// prefix is injected only on heard lines, so a reply part carrying it is always
// fabricated dialogue and is dropped on the voice paths.
describe('peer-impersonation drop (260708)', () => {
  it('a voice reply line written in a peer\'s voice is dropped; the real line lands', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: "(Sui, on the call): let's gooo\nalright, heading in" }],
    });

    const result = await sendChatMessage({ characterId: CHAR, text: 'you two ready?', voiceCall: true }, deps());

    expect(result.replies.map((r) => r.text)).toEqual(['alright, heading in']);
  });

  it('a reaction turn consisting ONLY of a fabricated peer line returns nothing', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '(Sui, on the call): i would never say that' }],
    });

    const replies = await sendCompanionVoiceTurn(CHAR, {
      speakerName: 'Sui',
      text: 'marv tell them',
      peers: ['Sui'],
    });

    expect(replies).toEqual([]);
  });

  it('typed chat keeps such a line (the drop is voice-only)', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '(Sui, on the call): hey' }],
    });

    const result = await sendChatMessage({ characterId: CHAR, text: 'what did sui say?' }, deps());

    expect(result.replies.map((r) => r.text)).toEqual(['(Sui, on the call): hey']);
  });
});

// 260725: proactiveness is a runtime-only Minecraft mode now — no per-character
// dial. Every companion gets the take-it-or-leave-it nudge note with silence
// sanctioned, even one whose (now-ignored) legacy metadata carries a dial.
describe('idle nudge — single note, silence sanctioned (260725)', () => {
  it('legacy metadata.proactiveness is ignored; the note sanctions silence', async () => {
    character.metadata = { proactiveness: 2 };
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok so weird thought.' }] });

    const result = await sendVoiceIdleTurn(CHAR, 12, ['Marv']);

    expect(result.messages.length).toBe(1);
    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const body = JSON.stringify(req.messages);
    expect(body).toContain('reply with exactly (silence)');
    expect(body).not.toContain('Keep the call alive');
  });

  it('default (no metadata) gets the same note', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: '(silence)' }] });

    await sendVoiceIdleTurn(CHAR, 12, []);

    const req = createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const body = JSON.stringify(req.messages);
    expect(body).toContain('reply with exactly (silence)');
    expect(body).not.toContain('Keep the call alive');
  });
});

describe('sendChatMessage — last_chatted stamp', () => {
  it('re-reads the character before stamping, so an edit saved mid-reply survives', async () => {
    // The player saves a persona edit WHILE the reply is generating: mutate the
    // store inside the mocked LLM call, i.e. after the turn's opening snapshot.
    createSpy.mockImplementationOnce(async () => {
      character = { ...character, persona: { ...character.persona, expanded: 'EDITED WHILE REPLYING' } };
      return { content: [{ type: 'text', text: 'hey.' }] };
    });

    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());

    expect(patchCharacterSpy).toHaveBeenCalledTimes(1);
    const saved = (await patchCharacterSpy.mock.results[0].value) as {
      persona: { expanded: string };
      last_chatted?: string;
    };
    expect(saved.persona.expanded).toBe('EDITED WHILE REPLYING');
    expect(saved.last_chatted).toBeTruthy();
  });
});

describe('cancelInflightTurn (260705 — reset-memory interrupt)', () => {
  it('aborts the in-flight turn: CHAT_ABORTED surfaces, nothing persists after the wipe', async () => {
    // Park the LLM call on a deferred so the cancel can land mid-turn.
    let release!: (v: { content: Array<{ type: string; text: string }> }) => void;
    createSpy.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const turn = sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    const settled = expect(turn).rejects.toThrow(CHAT_ABORTED);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // Reset memory fires the external interrupt, then the LLM resolves anyway —
    // the reply must be dropped, not appended to the freshly wiped transcript.
    cancelInflightTurn(CHAR);
    release({ content: [{ type: 'text', text: 'too late — the wipe already ran' }] });
    await settled;

    // The success-path tail never ran: no reply persisted, no last_chatted stamp.
    const { readAll } = await import('./chatStore');
    const rows = await readAll(CHAR);
    expect(rows.filter((m) => m.role === 'companion')).toHaveLength(0);
    expect(patchCharacterSpy).not.toHaveBeenCalled();
  });
});

describe('transcript stop sequences (260722 — chess voice-call TTS prompt leak)', () => {
  // Live capture: during a voice-call chess game a reply turn continued the
  // transcript past its own lines (a fabricated "Human: ..." player turn plus
  // an invented "(it is your turn)" direction) and the continuation was
  // persisted and spoken by TTS. The structural guard is request-level
  // stop_sequences on EVERY turn runner that persists or speaks reply text:
  // generation ends the moment the model starts writing the other side's
  // line-start markers, so the leak text is never produced. No output scrub.
  it('sendChatMessage requests carry TRANSCRIPT_STOP_SEQUENCES', async () => {
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'hey' }], usage: {} });
    await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    expect(createSpy).toHaveBeenCalled();
    for (const call of createSpy.mock.calls) {
      const req = call[0] as { stop_sequences?: string[] };
      expect(req.stop_sequences).toEqual(
        expect.arrayContaining(['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)']),
      );
    }
  });

  it('voice idle nudges and companion turns carry them too (spoken paths)', async () => {
    setCallActive(CHAR, true);
    createSpy.mockResolvedValue({ content: [{ type: 'text', text: 'yo' }], usage: {} });
    await sendVoiceIdleTurn(CHAR, 30, []);
    await sendCompanionVoiceTurn(CHAR, { speakerName: 'Sui', text: 'hey marv', peers: ['Sui'], depth: 0 });
    expect(createSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of createSpy.mock.calls) {
      const req = call[0] as { stop_sequences?: string[] };
      expect(req.stop_sequences).toEqual(expect.arrayContaining(['\nHuman:', '\nPlayer:']));
    }
  });
});

/**
 * The STREAMED voice turn's per-sentence emit (260729). A live call always
 * takes this path (isStreaming = isVoice), so it is where a call's spoken text
 * and its prosody context actually come from — the renderer's own prev/more
 * bookkeeping lives in the blocking reveal loop, which a streamed reply skips.
 */
describe('streamed voice turn: spoken text keeps its punctuation and carries reply context', () => {
  /** Minimal stand-in for the SDK's MessageStream: async-iterable + finalMessage. */
  function fakeStream(deltas: string[]) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const text of deltas) {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
        }
      },
      finalMessage: async () => ({ content: [{ type: 'text', text: deltas.join('') }], usage: {} }),
    };
  }

  it('emits each sentence with its place in the reply, period intact', async () => {
    setCallActive(CHAR, true);
    // Two sentences land in ONE delta (so the first KNOWS another follows), then
    // an unterminated tail that flushes after finalMessage.
    streamSpy.mockReturnValue(fakeStream(['thanks for that. i got the iron. ', 'want me to smelt it?']));
    const emitReply = vi.fn();
    const d: ChatDeps = { ...deps(), emitReply };

    const result = await sendChatMessage({ characterId: CHAR, text: 'you there', voiceCall: true }, d);

    expect(result.streamed).toBe(true); // the renderer must not re-speak these
    const emitted = emitReply.mock.calls.map(([, msg, speech]) => [msg.text, speech]);
    expect(emitted).toEqual([
      // The trailing period SURVIVES on a call (splitReply `spoken`): it is the
      // terminal intonation, not texting formality.
      ['thanks for that.', { prev: undefined, more: true }],
      ['i got the iron.', { prev: 'thanks for that.', more: false }],
      ['want me to smelt it?', { prev: 'i got the iron.', more: false }],
    ]);
  });

  it('merges a short lead-in into the sentence it introduces, in one clip', async () => {
    setCallActive(CHAR, true);
    // Live 260729: "oh." went out as its own clip. Split off it is a separate
    // synthesis request that lands as a complete little statement, unrelated to
    // the sentence it opens (and too short to carry any conditioning).
    streamSpy.mockReturnValue(fakeStream(['oh. ', "so you're still tweaking me."]));
    const emitReply = vi.fn();

    await sendChatMessage({ characterId: CHAR, text: "i'm the developer", voiceCall: true }, { ...deps(), emitReply });

    expect(emitReply.mock.calls.map(([, msg]) => msg.text)).toEqual(["oh. so you're still tweaking me."]);
  });

  it('speaks a short line that has nothing after it, rather than holding it', async () => {
    setCallActive(CHAR, true);
    streamSpy.mockReturnValue(fakeStream(['ok.']));
    const emitReply = vi.fn();

    await sendChatMessage({ characterId: CHAR, text: 'later', voiceCall: true }, { ...deps(), emitReply });

    expect(emitReply.mock.calls.map(([, msg]) => msg.text)).toEqual(['ok.']);
  });

  it('never asserts `more` from text it does not have yet', async () => {
    setCallActive(CHAR, true);
    // One sentence per delta: at the moment each is emitted, nothing further is
    // known, and a false `more` would send next_text on what turns out to be the
    // last line and take its terminal fall away. Unknown means false.
    // Both are over MERGE_SHORT_SENTENCE_CHARS, so each is its own clip.
    streamSpy.mockReturnValue(fakeStream(['sure thing man. ', 'give me a sec. ']));
    const emitReply = vi.fn();

    await sendChatMessage({ characterId: CHAR, text: 'can you help', voiceCall: true }, { ...deps(), emitReply });

    expect(emitReply.mock.calls.map(([, , speech]) => speech.more)).toEqual([false, false]);
  });
});

describe('one player message gets one reply round (261020)', () => {
  /** A streamed response: text deltas, then the final message with any tool_use. */
  function streamedResponse(text: string, toolUses: Array<{ id: string; name: string; input: unknown }> = []) {
    const content = [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolUses.map((t) => ({ type: 'tool_use', ...t })),
    ];
    return {
      async *[Symbol.asyncIterator]() {
        if (text) yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      },
      finalMessage: async () => ({ content, usage: {}, stop_reason: toolUses.length ? 'tool_use' : 'end_turn' }),
    };
  }
  const memoryFile = () => readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');

  it('a typed line on a call answered with text + remember() is spoken once, not reworded in a second hop', async () => {
    // Live 261020 (v0.6.9-beta.3, 1:1 call, typed "remind me next time, we
    // need to get copper first"): hop 0 spoke three lines and called
    // remember(); the loop re-called the model with "Saved to your memory.
    // Continue your reply" and hop 1 said the same thing again in new words.
    setCallActive(CHAR, true);
    streamSpy
      .mockReturnValueOnce(
        streamedResponse("Yeah, copper first, got it. I'll bring it up next time, don't you worry.", [
          { id: 'tu_rem', name: 'remember', input: { text: 'next session: get copper before the lighthouse base' } },
        ]),
      )
      .mockReturnValueOnce(streamedResponse("I'll bring it up next time so we don't skip it."));
    const emitReply = vi.fn();

    const result = await sendChatMessage(
      { characterId: CHAR, text: 'remind me next time, we need to get copper first', voiceCall: true },
      { ...deps(), emitReply },
    );

    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(emitReply.mock.calls.map(([, msg]) => msg.text)).toEqual([
      'Yeah, copper first, got it.',
      "I'll bring it up next time, don't you worry.",
    ]);
    expect(result.streamed).toBe(true);
    expect(await memoryFile()).toContain('get copper before the lighthouse base');
  });

  it('typed chat keeps the reply written beside remember() instead of swapping it for a second one', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'copper bulb lighthouse, that is going to look so good at night' },
          { type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'favorite block is the copper bulb' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'wait i gotta ask, you building it solo?' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'remember this: my favorite block is copper bulb' }, deps());

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.replies.map((r) => r.text)).toEqual(['copper bulb lighthouse, that is going to look so good at night']);
    expect(await memoryFile()).toContain('favorite block is the copper bulb');
  });

  it('remember() with no reply text yet still gets the hop that answers', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'player has a dog named Pepper' } }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'pepper is such a good name' }] });

    const result = await sendChatMessage({ characterId: CHAR, text: 'my dog is called pepper' }, deps());

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(result.replies.map((r) => r.text)).toEqual(['pepper is such a good name']);
  });

  it('on a call, a lead line + search, then a remember()-only hop, still continues to the answer', async () => {
    // The guard is per hop: the lead line spoken before the lookup does not
    // count as the answer.
    setCallActive(CHAR, true);
    webRuns.length = 0;
    streamSpy
      .mockReturnValueOnce(streamedResponse('one sec, let me check.', [{ id: 'tu_s', name: 'search', input: { query: 'minecraft snapshot' } }]))
      .mockReturnValueOnce(streamedResponse('', [{ id: 'tu_rem', name: 'remember', input: { text: 'player follows snapshots' } }]))
      .mockReturnValueOnce(streamedResponse('yeah there is a new snapshot with brittle ice.'));
    const emitReply = vi.fn();

    await sendChatMessage({ characterId: CHAR, text: 'anything new for minecraft this week', voiceCall: true }, { ...deps(), emitReply });

    expect(streamSpy).toHaveBeenCalledTimes(3);
    expect(emitReply.mock.calls.map(([, msg]) => msg.text)).toEqual([
      'one sec, let me check.',
      'yeah there is a new snapshot with brittle ice.',
    ]);
  });

  it('an answer that arrives after a search and also calls remember() ends the turn there', async () => {
    webRuns.length = 0;
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'lemme check.' },
          { type: 'tool_use', id: 'tu_s', name: 'search', input: { query: 'netherite armor' } },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'smithing table, diamond gear plus an ingot.' },
          { type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'player is going for netherite' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'so yeah, smithing table.' }] });
    const pushed: string[] = [];
    const d: ChatDeps = { ...deps(), emitReply: (_id, m) => { pushed.push(m.text); } };

    const result = await sendChatMessage({ characterId: CHAR, text: 'how do i make netherite armor' }, d);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(pushed).toEqual(['lemme check']);
    expect(result.replies.map((r) => r.text)).toEqual(['smithing table, diamond gear plus an ingot']);
  });
});

// 261024: a single-shot voice turn's own system note rides AFTER the last cache
// breakpoint, with the clock. Folded in before it, the cached prefix ended on
// text no later turn sends, so the cache write was never read back.
describe('single-shot voice turns keep their note after the cache breakpoint (261024)', () => {
  type Block = { type: string; text?: string; cache_control?: unknown };
  type Msg = { role: string; content: string | Block[] };

  /** Text of every block after the last cache_control block, and of the marked block itself. */
  function split(messages: Msg[]): { marked: string; tail: string; tailRole: string } {
    let mi = -1;
    let bi = -1;
    messages.forEach((m, i) => {
      if (Array.isArray(m.content)) m.content.forEach((b, j) => { if (b.cache_control) { mi = i; bi = j; } });
    });
    expect(mi).toBeGreaterThanOrEqual(0);
    const after: string[] = [];
    messages.forEach((m, i) => {
      const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      blocks.forEach((b, j) => { if (i > mi || (i === mi && j > bi)) after.push(b.text ?? ''); });
    });
    const markedBlock = (messages[mi].content as Block[])[bi];
    return { marked: markedBlock.text ?? '', tail: after.join('\n'), tailRole: messages[messages.length - 1].role };
  }

  async function seed(rows: Array<['user' | 'companion', string]>): Promise<void> {
    let t = Date.now() - rows.length * 1000;
    for (const [role, text] of rows) {
      await appendMessage(CHAR, { id: `r${t}`, role, text, ts: t++, voice: true } as never);
    }
  }

  it('idle nudge: the breakpoint is on the last transcript line and the note follows it', async () => {
    await seed([['user', 'hey marv'], ['companion', 'hey.']]);
    setCallActive(CHAR, true);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'so, about that robot arm.' }] });

    await sendVoiceIdleTurn(CHAR, 30, []);

    const req = createSpy.mock.calls[0][0] as { messages: Msg[] };
    const { marked, tail, tailRole } = split(req.messages);
    expect(marked).toBe('hey.');
    expect(tail).toContain('quiet for about 30 seconds');
    expect(tail).toMatch(/\[now: \w{3} \d{1,2} \w{3} \d{4}, \d{2}:\d{2}\]/);
    expect(tail).not.toContain('System note, not the player speaking: the current');
    expect(tail.indexOf('quiet for about')).toBeLessThan(tail.indexOf('[now: '));
    expect(tailRole).toBe('user');
  });

  it('companion reaction: the breakpoint is on the heard line, which later turns resend unchanged', async () => {
    await seed([['user', 'hey both']]);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'lol true' }] });

    await sendCompanionVoiceTurn(CHAR, { speakerName: 'Sui', text: 'this game is chaos', peers: ['Sui'] });

    const req = createSpy.mock.calls[0][0] as { messages: Msg[] };
    const { marked, tail } = split(req.messages);
    expect(marked).toContain('(Sui, on the call): this game is chaos');
    expect(marked).not.toContain('System note');
    expect(tail).toContain('Sui just said the line above on the call');
    expect(tail).toMatch(/\[now: \w{3} \d{1,2} \w{3} \d{4}, \d{2}:\d{2}\]/);
    expect(tail).not.toContain('System note, not the player speaking: the current');
  });

  it('greeting: the note follows the breakpoint', async () => {
    await seed([['user', 'bye for now'], ['companion', 'later.']]);
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'oh hey.' }] });

    await sendVoiceGreetingTurn(CHAR, [], { plan: null });

    const req = createSpy.mock.calls[0][0] as { messages: Msg[] };
    const { marked, tail } = split(req.messages);
    expect(marked).toBe('later.');
    expect(tail).toMatch(/System note/);
    expect(tail).toMatch(/\[now: \w{3} \d{1,2} \w{3} \d{4}, \d{2}:\d{2}\]/);
    expect(tail).not.toContain('System note, not the player speaking: the current');
  });
});

// 261112: a voice line that cut the companion off mid-line reaches the live
// game session marked, so the bot frames it as a cut-in, not a stop order.
describe('in-game route carries the barge-in mark (261112)', () => {
  it('a voice line passes interrupted to the bot', async () => {
    const routeToBot = vi.fn(() => true);
    const d: ChatDeps = { ...deps(), isInGame: () => true, routeToBot };
    const r = await sendChatMessage(
      { characterId: CHAR, text: 'wait', voiceCall: true, interrupted: { line: 'ok so the cave is right' } },
      d,
    );
    expect(r).toEqual({ replies: [], routed: true });
    expect(routeToBot).toHaveBeenCalledWith(CHAR, {
      from: 'Player',
      text: 'wait',
      voice: true,
      interrupted: { line: 'ok so the cave is right' },
    });
  });

  it('a plain voice line and a typed line carry no mark', async () => {
    const routeToBot = vi.fn(() => true);
    const d: ChatDeps = { ...deps(), isInGame: () => true, routeToBot };
    await sendChatMessage({ characterId: CHAR, text: 'stop', voiceCall: true }, d);
    await sendChatMessage({ characterId: CHAR, text: 'stop', interrupted: { line: 'x' } }, d);
    expect(routeToBot).toHaveBeenNthCalledWith(1, CHAR, { from: 'Player', text: 'stop', voice: true });
    expect(routeToBot).toHaveBeenNthCalledWith(2, CHAR, { from: 'Player', text: 'stop', voice: false });
  });
});
