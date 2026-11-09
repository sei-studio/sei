import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmCallParams, LlmProvider } from './llm/types';
import {
  DEDUPE_WINDOW_MS,
  PLAYER_END_MAX_TOKENS,
  PLAYER_END_MIN_MS,
  _resetPlayerEndNextStep,
  buildPlayerEndPrompt,
  isFreeCloudPlan,
  isPlayerEndedGame,
  memoryEntries,
  noteSessionDigest,
  notRunProps,
  parseNextStepReply,
  parseGameAnswer,
  parsePlayerEndReply,
  reportGoodbyePlanSaved,
  reportNextStepNotRun,
  resolvePlanPlace,
  runPlayerEndNextStep,
  startPlayerEndNextStep,
  takeSessionDigest,
  worthChecking,
  yieldToNewSession,
  type PlayerEndDeps,
  type PlayerEndInput,
} from './playerEndNextStep';

function provider(
  reply: string | ((p: LlmCallParams) => Promise<string>),
  kind = 'anthropic',
): LlmProvider & { calls: LlmCallParams[] } {
  const calls: LlmCallParams[] = [];
  return {
    calls,
    backend: 'cloud-proxy',
    kind,
    model: 'claude-haiku-5-5',
    vision: 'yes' as never,
    streaming: false,
    async call(p: LlmCallParams) {
      calls.push(p);
      const text = typeof reply === 'string' ? reply : await reply(p);
      return { text, usage: { input_tokens: 900, output_tokens: 8 } } as never;
    },
  };
}

const GOALS = '# Goals\n\n- [2026-10-11T10:00:00.000Z] finish the cabin roof\n';
const MEMORY = '# Memory\n\n- [2026-10-10T10:00:00.000Z] Alex has a job interview on Monday\n';

function deps(over: Partial<PlayerEndDeps> = {}, llm: LlmProvider = provider('finish the cabin roof')) {
  const saved: Array<[string, string]> = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const d: PlayerEndDeps = {
    buildProvider: async () => llm,
    isOnline: () => true,
    overLimit: async () => false,
    freeCloud: async () => false,
    readText: async (file) => (file.includes('HEARTBEAT') ? GOALS : MEMORY),
    memoryFile: (id) => `/mem/${id}/MEMORY.md`,
    goalsFile: (id, game) => `/mem/${id}/${game === 'minecraft' ? 'HEARTBEAT.md' : `HEARTBEAT.${game}.md`}`,
    characterName: async () => 'Sui',
    save: async (id, line) => {
      saved.push([id, line]);
      return true;
    },
    capture: (e, p) => events.push([e, p]),
    timeoutMs: (_p, ms) => ms,
    scoped: (fn) => fn(),
    now: () => 1_000_000,
    log: () => {},
    ...over,
  };
  return { d, saved, events };
}

const input = (over: Partial<PlayerEndInput> = {}): PlayerEndInput => ({
  characterId: 'char-1',
  surface: 'game',
  game: 'minecraft',
  activity: 'playing Minecraft together',
  durationMs: 25 * 60_000,
  lines: [
    { who: 'player', text: 'can we put a roof on the cabin' },
    { who: 'you', text: 'yes, I need more spruce planks first' },
    { who: 'player', text: 'ok I have to go eat, bye' },
  ],
  playerLines: 9,
  goalsGame: 'minecraft',
  ...over,
});

afterEach(() => {
  _resetPlayerEndNextStep();
  vi.useRealTimers();
});

describe('who counts as the player ending it', () => {
  it('stop, world close and disconnect only', () => {
    for (const r of ['user_stop', 'world_closed', 'disconnected']) expect(isPlayerEndedGame(r)).toBe(true);
    for (const r of ['companion_quit', 'app_quit', 'account_switch', 'kicked', 'crash', 'credits_depleted', undefined]) {
      expect(isPlayerEndedGame(r)).toBe(false);
    }
  });
});

describe('content gate', () => {
  it('needs two minutes and either real talk or a goal', () => {
    expect(worthChecking({ durationMs: PLAYER_END_MIN_MS - 1, playerLines: 20, goals: 3 })).toBe(false);
    expect(worthChecking({ durationMs: PLAYER_END_MIN_MS, playerLines: 1, goals: 0 })).toBe(false);
    expect(worthChecking({ durationMs: PLAYER_END_MIN_MS, playerLines: 2, goals: 0 })).toBe(true);
    expect(worthChecking({ durationMs: PLAYER_END_MIN_MS, playerLines: 0, goals: 1 })).toBe(true);
  });

  it('skips a trivial session without building a provider, and says so (261107)', async () => {
    const build = vi.fn();
    const { d, saved, events } = deps({ buildProvider: build, readText: async () => '' });
    expect(await runPlayerEndNextStep(input({ durationMs: 60_000 }), d)).toBe('trivial');
    expect(await runPlayerEndNextStep(input({ playerLines: 1, goalsGame: null }), d)).toBe('trivial');
    expect(build).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    const base = { character_id: 'char-1', source: 'player_end', surface: 'game', game: 'minecraft', saved: false, outcome: 'trivial', reached_model: false };
    expect(events).toEqual([
      ['next_step_checked', { ...base, duration_s: 60 }],
      ['next_step_checked', { ...base, duration_s: 1500 }],
    ]);
  });
});

describe('261107: text chat and the free cloud gate', () => {
  const chat = (over: Partial<PlayerEndInput> = {}) =>
    input({ surface: 'chat', game: undefined, goalsGame: undefined, activity: 'a text chat', skipOnFreeCloud: true, minPlayerLines: 4, ...over });

  it('a free cloud chat never builds a provider and reports not_covered with free_cloud', async () => {
    const build = vi.fn();
    const { d, saved, events } = deps({ buildProvider: build, freeCloud: async () => true });
    expect(await runPlayerEndNextStep(chat(), d)).toBe('free_cloud');
    expect(build).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(events).toEqual([
      [
        'next_step_checked',
        {
          character_id: 'char-1',
          source: 'player_end',
          surface: 'chat',
          saved: false,
          outcome: 'not_covered',
          skip_reason: 'free_cloud',
          reached_model: false,
          duration_s: 1500,
        },
      ],
    ]);
  });

  it('a trivial chat is reported trivial before the plan read', async () => {
    const free = vi.fn(async () => true);
    const { d } = deps({ freeCloud: free });
    expect(await runPlayerEndNextStep(chat({ playerLines: 3 }), d)).toBe('trivial');
    expect(free).not.toHaveBeenCalled();
  });

  it('BYOK, local or paid: the chat check runs, saves under the app section and tags chat', async () => {
    const tags: unknown[] = [];
    const inGame: unknown[] = [];
    const llm = provider('note: ask how the interview went\nplayer: Tell Sui how the interview went\ngame: none');
    const { d, events } = deps(
      {
        save: async (_id, _line, opts) => {
          inGame.push(opts?.inGame);
          return true;
        },
        tagPlan: async (_id, surface, game, line) => {
          tags.push([surface, game, line]);
        },
      },
      llm,
    );
    expect(await runPlayerEndNextStep(chat(), d)).toBe('saved');
    expect(inGame).toEqual([false]);
    expect(tags).toEqual([['chat', undefined, 'Tell Sui how the interview went']]);
    expect(llm.calls[0].messages[0].content).toContain('Session: a text chat');
    expect(events.map((e) => e[0])).toEqual(['next_step_checked', 'next_step_saved']);
    expect(events[1][1]).toEqual({ character_id: 'char-1', source: 'player_end', surface: 'chat' });
  });

  it('other inputs never consult the gate', async () => {
    const free = vi.fn(async () => true);
    const { d } = deps({ freeCloud: free });
    expect(await runPlayerEndNextStep(input(), d)).toBe('saved');
    expect(free).not.toHaveBeenCalled();
  });

  it('only quest and party leave the cost with the account', () => {
    expect(isFreeCloudPlan('quest')).toBe(false);
    expect(isFreeCloudPlan('party')).toBe(false);
    for (const p of ['free', '', null, undefined, 'unknown']) expect(isFreeCloudPlan(p)).toBe(true);
  });
});

describe('a player-ended session', () => {
  it('saves the plan the way T80 does and reports it, without transcript text', async () => {
    const llm = provider('"Finish the cabin roof."');
    const { d, saved, events } = deps({}, llm);
    expect(await runPlayerEndNextStep(input(), d)).toBe('saved');
    expect(saved).toEqual([['char-1', 'Plan for next time in Minecraft: Finish the cabin roof']]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].maxTokens).toBe(PLAYER_END_MAX_TOKENS);
    expect(llm.calls[0].system).toContain('You are Sui');
    const user = String(llm.calls[0].messages[0].content);
    expect(user).toContain('finish the cabin roof');
    expect(user).toContain('player: ok I have to go eat, bye');
    expect(user).toContain('job interview');
    expect(events).toEqual([
      [
        'next_step_checked',
        { character_id: 'char-1', source: 'player_end', surface: 'game', game: 'minecraft', saved: true, outcome: 'saved', reached_model: true, duration_s: 1500 },
      ],
      ['next_step_saved', { character_id: 'char-1', source: 'player_end', surface: 'game', game: 'minecraft' }],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/cabin|eat/);
  });

  it('a "none" reply saves nothing but still reports the check', async () => {
    const { d, saved, events } = deps({}, provider('none'));
    expect(await runPlayerEndNextStep(input(), d)).toBe('none');
    expect(saved).toEqual([]);
    expect(events).toEqual([
      [
        'next_step_checked',
        { character_id: 'char-1', source: 'player_end', surface: 'game', game: 'minecraft', saved: false, outcome: 'none', reached_model: true, duration_s: 1500 },
      ],
    ]);
  });

  it('a call without goals still runs on the conversation alone', async () => {
    const llm = provider('ask how the job interview went');
    const { d, saved, events } = deps({}, llm);
    const out = await runPlayerEndNextStep(
      input({ surface: 'call', game: undefined, goalsGame: undefined, activity: 'a voice call', playerLines: 6 }),
      d,
    );
    expect(out).toBe('saved');
    expect(saved[0][1]).toBe('Plan for next time: ask how the job interview went');
    expect(String(llm.calls[0].messages[0].content)).toContain('Your goals when it ended: none.');
    expect(events[1]).toEqual(['next_step_saved', { character_id: 'char-1', source: 'player_end', surface: 'call' }]);
  });
});

describe('never a wall, never a block', () => {
  it('out of allowance: no call, and the skip is reported (261107)', async () => {
    const llm = provider('finish the cabin roof');
    const { d, saved, events } = deps({ overLimit: async () => true }, llm);
    expect(await runPlayerEndNextStep(input(), d)).toBe('over_limit');
    expect(llm.calls).toHaveLength(0);
    expect(saved).toEqual([]);
    expect(events).toEqual([['next_step_checked', expect.objectContaining({ saved: false, outcome: 'over_limit', reached_model: false })]]);
  });

  it('offline: skipped for a remote model, allowed for Ollama', async () => {
    const remote = provider('finish the cabin roof');
    expect(await runPlayerEndNextStep(input(), deps({ isOnline: () => false }, remote).d)).toBe('offline');
    expect(remote.calls).toHaveLength(0);
    const local = provider('finish the cabin roof', 'ollama');
    expect(await runPlayerEndNextStep(input(), deps({ isOnline: () => false }, local).d)).toBe('saved');
  });

  it('a hung model is cut off at the time box and nothing is written', async () => {
    let sawAbort = false;
    const hung = provider(
      (p) =>
        new Promise<string>((_, reject) => {
          p.signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const { d, saved, events } = deps({ timeoutMs: () => 40 }, hung);
    const t0 = Date.now();
    expect(await runPlayerEndNextStep(input(), d)).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sawAbort).toBe(true);
    expect(saved).toEqual([]);
    expect(events[0][1]).toMatchObject({ saved: false, outcome: 'timeout' });
  });

  it('start returns at once and its promise never rejects', async () => {
    const { d } = deps({ buildProvider: async () => Promise.reject(new Error('no key')) });
    let settled = false;
    const p = startPlayerEndNextStep(input(), d).then((o) => {
      settled = true;
      return o;
    });
    expect(settled).toBe(false);
    expect(await p).toBe('error');
    const { d: d2 } = deps({ scoped: () => Promise.reject(new Error('ACCOUNT_SWITCHING')) });
    expect(await startPlayerEndNextStep(input({ characterId: 'char-2' }), d2)).toBe('cancelled');
  });

  it('a new session aborts a check running on a local model', async () => {
    let release: (() => void) | null = null;
    const slow = provider(
      (p) =>
        new Promise<string>((resolve, reject) => {
          release = () => resolve('finish the cabin roof');
          p.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      'ollama',
    );
    const { d, saved, events } = deps({}, slow);
    const p = startPlayerEndNextStep(input(), d);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    yieldToNewSession('char-1');
    expect(await p).toBe('cancelled');
    expect(release).not.toBeNull();
    expect(saved).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a new session leaves a remote check to finish', async () => {
    let release: (() => void) | null = null;
    const slow = provider((_p) => new Promise<string>((resolve) => (release = () => resolve('finish the cabin roof'))));
    const { d, saved } = deps({}, slow);
    const p = startPlayerEndNextStep(input(), d);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    yieldToNewSession('char-1');
    release!();
    expect(await p).toBe('saved');
    expect(saved).toHaveLength(1);
  });

  it('a deferred app-quit check (yieldAlways) is aborted by a new session even on a remote model', async () => {
    const slow = provider(
      (p) =>
        new Promise<string>((_resolve, reject) => {
          p.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { d, saved, events } = deps({}, slow);
    const p = startPlayerEndNextStep(input({ source: 'app_quit' }), d, { yieldAlways: true });
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    yieldToNewSession('char-1');
    expect(await p).toBe('cancelled');
    expect(saved).toEqual([]);
    expect(events).toEqual([]);
  });

  it('an app-quit check reports its source and how late it ran', async () => {
    const { d, events } = deps();
    expect(await runPlayerEndNextStep(input({ source: 'app_quit', eventProps: { late_hours: 14.5 } }), d)).toBe('saved');
    const base = { character_id: 'char-1', source: 'app_quit', surface: 'game', game: 'minecraft', late_hours: 14.5 };
    expect(events).toEqual([
      ['next_step_checked', { ...base, saved: true, outcome: 'saved', reached_model: true, duration_s: 1500 }],
      ['next_step_saved', base],
    ]);
  });

  it('one check per character inside the dedupe window', async () => {
    let now = 1_000_000;
    const llm = provider('finish the cabin roof');
    const { d } = deps({ now: () => now }, llm);
    expect(await startPlayerEndNextStep(input(), d)).toBe('saved');
    now += DEDUPE_WINDOW_MS - 1;
    expect(await startPlayerEndNextStep(input({ surface: 'call' }), d)).toBe('busy');
    expect(await startPlayerEndNextStep(input({ characterId: 'char-2' }), d)).toBe('saved');
    now += 2;
    expect(await startPlayerEndNextStep(input(), d)).toBe('saved');
    expect(llm.calls).toHaveLength(3);
  });

  it('a deduped check is reported as busy, without a call (261107)', async () => {
    const llm = provider('finish the cabin roof');
    const { d, events } = deps({}, llm);
    expect(await startPlayerEndNextStep(input(), d)).toBe('saved');
    events.length = 0;
    expect(await startPlayerEndNextStep(input({ surface: 'backseat', game: undefined }), d)).toBe('busy');
    expect(llm.calls).toHaveLength(1);
    expect(events).toEqual([
      [
        'next_step_checked',
        { character_id: 'char-1', source: 'player_end', surface: 'backseat', saved: false, outcome: 'busy', reached_model: false, duration_s: 1500 },
      ],
    ]);
  });

  it('a plan whose write lost its scope (account switch) is not reported as saved', async () => {
    const { d, events } = deps({ save: async () => false });
    expect(await runPlayerEndNextStep(input(), d)).toBe('none');
    expect(events.map((e) => e[0])).toEqual(['next_step_checked']);
  });

  it('tags a saved plan with where it came from (Home card), and only a saved one', async () => {
    const tags: Array<[string, string, string | undefined]> = [];
    const tagPlan = async (id: string, surface: string, game: string | undefined) => {
      tags.push([id, surface, game]);
    };
    expect(await runPlayerEndNextStep(input({ game: 'stardew', goalsGame: 'stardew' }), deps({ tagPlan }).d)).toBe('saved');
    expect(tags).toEqual([['char-1', 'game', 'stardew']]);
    expect(await runPlayerEndNextStep(input({ characterId: 'char-2' }), deps({ tagPlan }, provider('none')).d)).toBe('none');
    expect(await runPlayerEndNextStep(input({ characterId: 'char-3' }), deps({ tagPlan, save: async () => false }).d)).toBe('none');
    expect(tags).toHaveLength(1);
  });

  it('a failing tag never fails the save', async () => {
    const { d, saved } = deps({ tagPlan: async () => Promise.reject(new Error('disk')) });
    expect(await runPlayerEndNextStep(input(), d)).toBe('saved');
    expect(saved).toHaveLength(1);
  });
});

describe('two-line reply parsing (261014)', () => {
  it('reads the note and the player line', () => {
    expect(parsePlayerEndReply("note: ask Alex what the vet says about Pepper's leg on Thursday\nplayer: Tell Roger what the vet said about Pepper")).toEqual({
      step: "ask Alex what the vet says about Pepper's leg on Thursday",
      line: 'Tell Roger what the vet said about Pepper',
      game: null,
    });
    expect(parsePlayerEndReply('**Note:** finish the roof.\n**Player:** "finish the cabin roof tomorrow"')).toEqual({
      step: 'finish the roof',
      line: 'Finish the cabin roof',
      game: null,
    });
  });

  it('none, an unlabeled reply, and a missing player line', () => {
    expect(parsePlayerEndReply('none')).toBeNull();
    expect(parsePlayerEndReply('note: none\nplayer: none')).toBeNull();
    expect(parsePlayerEndReply('finish the roof')).toEqual({ step: 'finish the roof', line: null , game: null });
    expect(parsePlayerEndReply('note: finish the roof')).toEqual({ step: 'finish the roof', line: null , game: null });
    expect(parsePlayerEndReply('player: Finish the roof')).toEqual({ step: 'Finish the roof', line: 'Finish the roof' , game: null });
    expect(parseNextStepReply('note: finish the roof\nplayer: Finish the roof')).toBe('finish the roof');
  });

  it('a label with its text on the next line (review 261014)', () => {
    expect(parsePlayerEndReply('note:\nfinish the roof\nplayer:\nFinish the roof with Sui')).toEqual({
      step: 'finish the roof',
      line: 'Finish the roof with Sui',
      game: null,
    });
    // An empty label followed by the other label is not given that label's text.
    expect(parsePlayerEndReply('note:\nplayer: Finish the roof')).toEqual({ step: 'Finish the roof', line: 'Finish the roof' , game: null });
  });

  it('strips markdown left after the value', () => {
    expect(parsePlayerEndReply('**note:** finish roof**\n**player:** Finish the roof**')).toEqual({
      step: 'finish roof',
      line: 'Finish the roof',
      game: null,
    });
  });

  it('splits both labels written on one line', () => {
    expect(parsePlayerEndReply('note: finish roof player: Finish the roof with Sui')).toEqual({
      step: 'finish roof',
      line: 'Finish the roof with Sui',
      game: null,
    });
    expect(parsePlayerEndReply('**note:** finish roof **player:** Finish the roof')).toEqual({
      step: 'finish roof',
      line: 'Finish the roof',
      game: null,
    });
  });

  it('the system text names the companion as the card shows it', () => {
    const { system } = buildPlayerEndPrompt({ name: 'red', activity: 'playing Minecraft together', durationMs: 600_000, lines: [], goals: [], memories: [] });
    expect(system).toContain('You are red,');
    expect(system).toContain('"Up next with Red"');
    expect(system).not.toContain('{name}');
    expect(system).not.toContain('{card_name}');
  });

  it('passes the player line to the tag', async () => {
    const tags: Array<[string, string, string | undefined, string | null | undefined]> = [];
    const tagPlan = async (id: string, surface: string, game: string | undefined, line?: string | null) => {
      tags.push([id, surface, game, line]);
    };
    const reply = 'note: ask how the move went\nplayer: Tell Lyra how the move went';
    expect(await runPlayerEndNextStep(input({ characterId: 'char-9' }), deps({ tagPlan }, provider(reply)).d)).toBe('saved');
    expect(tags).toEqual([['char-9', 'game', 'minecraft', 'Tell Lyra how the move went']]);
  });
});

describe('reply parsing', () => {
  it('takes the first line and strips wrappers', () => {
    expect(parseNextStepReply('Plan for next time: finish the roof.')).toBe('finish the roof');
    expect(parseNextStepReply('"ask how the interview went"\nbecause it matters')).toBe('ask how the interview went');
    expect(parseNextStepReply('  None.  ')).toBeNull();
    expect(parseNextStepReply('nothing')).toBeNull();
    expect(parseNextStepReply('')).toBeNull();
    expect(parseNextStepReply('没有')).toBeNull();
    expect(parseNextStepReply('no more iron, mine some next time')).toBe('no more iron, mine some next time');
  });
});

describe('digest store', () => {
  it('validates, keeps one per character and is taken once', () => {
    noteSessionDigest('a', { lines: [{ who: 'player', text: ' hi ' }, { who: 'bogus', text: 'x' }, { text: 3 }], playerLines: 4, selfLines: -1 });
    noteSessionDigest('b', 'garbage');
    expect(takeSessionDigest('a')).toEqual({
      lines: [
        { who: 'player', text: 'hi' },
        { who: 'player', text: 'x' },
      ],
      playerLines: 4,
      selfLines: 0,
    });
    expect(takeSessionDigest('a')).toBeNull();
    expect(takeSessionDigest('b')).toBeNull();
  });
});

describe('prompt', () => {
  it('stays compact', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ who: 'player' as const, text: `line ${i} `.repeat(30) }));
    const memories = Array.from({ length: 30 }, (_, i) => `memory ${i} `.repeat(40));
    const { user } = buildPlayerEndPrompt({
      name: 'Sui',
      activity: 'a voice call',
      durationMs: 600_000,
      lines: lines.map((l) => ({ ...l, text: l.text.slice(0, 200) })),
      goals: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      memories,
    });
    expect(user.length).toBeLessThan(6_000);
    expect(user).not.toContain('- a\n');
    expect(user).toContain('about 10 minutes');
  });
});

// 261020: the plan's game comes from its content (the reply's game: line),
// not from the session it was checked after. Live: a Stardew session whose
// goals and memories held a Minecraft build saved it as a Stardew plan, and
// Home offered "Play Stardew Valley" for a copper bulb lighthouse.
describe('261020: the game a plan is for', () => {
  it('reads the game: line in any of the shapes the other labels allow', () => {
    expect(parsePlayerEndReply('note: get copper for the lighthouse\nplayer: Get copper for your lighthouse\ngame: Minecraft')).toEqual({
      step: 'get copper for the lighthouse',
      line: 'Get copper for your lighthouse',
      game: 'minecraft',
    });
    expect(parsePlayerEndReply('note: plant parsnips player: Plant parsnips with Sui game: Stardew Valley.')?.game).toBe('stardew');
    expect(parsePlayerEndReply("**note:** build a crock pot\n**player:** Build a crock pot\n**game:** Don't Starve Together")?.game).toBe('dontstarve');
    expect(parsePlayerEndReply('note: ask how the interview went\nplayer: Tell Sui how the interview went\ngame: none')?.game).toBe('none');
    expect(parsePlayerEndReply('note: x\nplayer: X\ngame:\nMinecraft')?.game).toBe('minecraft');
    expect(parsePlayerEndReply('none\ngame: none')).toBeNull();
  });

  it('a game answer is a known game, none, or nothing usable', () => {
    expect(parseGameAnswer('Minecraft')).toBe('minecraft');
    expect(parseGameAnswer('"stardew valley"')).toBe('stardew');
    expect(parseGameAnswer('dont starve together')).toBe('dontstarve');
    expect(parseGameAnswer('None.')).toBe('none');
    expect(parseGameAnswer('Terraria')).toBeNull();
    expect(parseGameAnswer('Minecraft or Stardew Valley')).toBeNull();
    expect(parseGameAnswer('')).toBeNull();
    expect(parseGameAnswer(null)).toBeNull();
  });

  it('resolvePlanPlace: a named game wins over the session, none keeps the session without a game label', () => {
    const stardew = { surface: 'game' as const, game: 'stardew' };
    expect(resolvePlanPlace(stardew, 'minecraft')).toEqual({ surface: 'game', game: 'minecraft', memoryGame: 'minecraft' });
    expect(resolvePlanPlace(stardew, 'stardew')).toEqual({ surface: 'game', game: 'stardew', memoryGame: 'stardew' });
    // Review 261020: 'none' drops the session's game (picker card, any game may raise it).
    expect(resolvePlanPlace(stardew, 'none')).toEqual({ surface: 'game', memoryGame: null });
    expect(resolvePlanPlace({ surface: 'backseat', game: 'roblox' }, 'none')).toEqual({ surface: 'backseat', memoryGame: null });
    expect(resolvePlanPlace(stardew, null)).toEqual({ surface: 'game', game: 'stardew', memoryGame: 'stardew' });
    expect(resolvePlanPlace({ surface: 'call' }, 'minecraft')).toEqual({ surface: 'game', game: 'minecraft', memoryGame: 'minecraft' });
    expect(resolvePlanPlace({ surface: 'call' }, 'none')).toEqual({ surface: 'call', memoryGame: null });
    expect(resolvePlanPlace({ surface: 'call' }, null)).toEqual({ surface: 'call', memoryGame: null });
    expect(resolvePlanPlace({ surface: 'backseat', game: 'roblox' }, null)).toEqual({ surface: 'backseat', game: 'roblox', memoryGame: null });
  });

  it('a Stardew session that left a Minecraft plan saves and tags it as Minecraft', async () => {
    const llm = provider('note: get copper for the copper bulb lighthouse\nplayer: Get copper for your copper bulb lighthouse\ngame: Minecraft');
    const tags: unknown[][] = [];
    const saveOpts: unknown[] = [];
    const { d, saved } = deps(
      {
        tagPlan: async (...a) => {
          tags.push(a);
        },
      },
      llm,
    );
    const save = d.save;
    d.save = async (id, line, opts) => {
      saveOpts.push(opts);
      return save(id, line, opts);
    };
    const out = await runPlayerEndNextStep(
      input({ game: 'stardew', goalsGame: 'stardew', activity: 'playing Stardew Valley with the player' }),
      d,
    );
    expect(out).toBe('saved');
    expect(saved[0][1]).toBe('Plan for next time in Minecraft: get copper for the copper bulb lighthouse');
    expect(saveOpts[0]).toEqual({ inGame: true });
    expect(tags).toEqual([['char-1', 'game', 'minecraft', 'Get copper for your copper bulb lighthouse']]);
    // The prompt lists the games and asks for the line.
    expect(llm.calls[0].system).toContain("one of Minecraft, Stardew Valley or Don't Starve Together, or none");
    expect(llm.calls[0].system).not.toContain('{games}');
    expect(String(llm.calls[0].messages[0].content)).toContain('(note:, player: and game:)');
  });

  it('a call plan about no game stays a call plan, filed under the app section', async () => {
    const llm = provider('note: ask how the job interview went\nplayer: Tell Sui how the interview went\ngame: none');
    const tags: unknown[][] = [];
    const saveOpts: unknown[] = [];
    const { d, saved } = deps({ tagPlan: async (...a) => void tags.push(a) }, llm);
    const save = d.save;
    d.save = async (id, line, opts) => {
      saveOpts.push(opts);
      return save(id, line, opts);
    };
    await runPlayerEndNextStep(input({ surface: 'call', game: undefined, goalsGame: undefined, activity: 'a voice call', playerLines: 6 }), d);
    expect(saved[0][1]).toBe('Plan for next time: ask how the job interview went');
    expect(saveOpts[0]).toEqual({ inGame: false });
    expect(tags).toEqual([['char-1', 'call', undefined, 'Tell Sui how the interview went']]);
  });
});

// 261020: the check sees which section each memory sits under. Without the
// headers a Minecraft copper bulb build read as Stardew work (Stardew has
// copper too), and the plan was labeled Stardew.
describe('261020: memories keep the section they are from', () => {
  const body = [
    '# Memory',
    '',
    '- [2026-10-18] ouen likes cats',
    '',
    "## World 1 — ouen's world (Minecraft)",
    "- [2026-10-19 21:00] ouen's favorite block is copper bulb, building a lighthouse",
    '',
    '## In the app (texting, calls and minigames, outside any game world)',
    '- [2026-10-20 10:00] ouen still needs 40 copper bulbs',
    '- [2026-10-20 10:05] ouen quit chess fast again',
    '',
    '## World 2 — Sui Farm (Stardew Valley)',
    '- [2026-10-20 11:00] ouen named the farm Sui Farm',
  ].join('\n');

  it('memoryEntries pairs each entry with its section header', () => {
    expect(memoryEntries(body)).toEqual([
      { text: 'ouen likes cats', place: null },
      { text: "ouen's favorite block is copper bulb, building a lighthouse", place: "World 1 — ouen's world (Minecraft)" },
      { text: 'ouen still needs 40 copper bulbs', place: 'In the app (texting, calls and minigames, outside any game world)' },
      { text: 'ouen quit chess fast again', place: 'In the app (texting, calls and minigames, outside any game world)' },
      { text: 'ouen named the farm Sui Farm', place: 'World 2 — Sui Farm (Stardew Valley)' },
    ]);
  });

  it('the prompt groups memories under where they are from, once per run', () => {
    const { user } = buildPlayerEndPrompt({
      name: 'Sui',
      activity: 'playing Stardew Valley with the player',
      durationMs: 600_000,
      lines: [],
      goals: [],
      memories: memoryEntries(body),
    });
    expect(user).toContain(
      [
        'Some of your recent memories, under the heading of where each is from:',
        'Earlier:',
        '- ouen likes cats',
        "World 1 — ouen's world (Minecraft):",
        "- ouen's favorite block is copper bulb, building a lighthouse",
        'In the app (texting, calls and minigames, outside any game world):',
        '- ouen still needs 40 copper bulbs',
        '- ouen quit chess fast again',
        'World 2 — Sui Farm (Stardew Valley):',
        '- ouen named the farm Sui Farm',
      ].join('\n'),
    );
  });

  it('a file with no sections keeps the plain list', () => {
    const { user } = buildPlayerEndPrompt({
      name: 'Sui',
      activity: 'a voice call',
      durationMs: 600_000,
      lines: [],
      goals: [],
      memories: memoryEntries('# Memory\n\n- [2026-10-18] ouen likes cats\n'),
    });
    expect(user).toContain('Some of your recent memories:\n- ouen likes cats');
  });
});

// 261020 (review): two follow-ups to the game: line.
describe('261020 review: none answers and the game: split', () => {
  it('a plan about no game after a Minecraft session is tagged with no game', async () => {
    const llm = provider('note: ask how the job interview went\nplayer: Tell Sui how the interview went\ngame: none');
    const tags: unknown[][] = [];
    const { d, saved } = deps({ tagPlan: async (...a) => void tags.push(a) }, llm);
    await runPlayerEndNextStep(input({}), d);
    expect(saved[0][1]).toBe('Plan for next time: ask how the job interview went');
    expect(tags).toEqual([['char-1', 'game', undefined, 'Tell Sui how the interview went']]);
  });

  it('"game:" inside the note does not cut it', () => {
    expect(parsePlayerEndReply('note: finish the board game: monopoly\nplayer: Finish Monopoly with Sui\ngame: none')).toEqual({
      step: 'finish the board game: monopoly',
      line: 'Finish Monopoly with Sui',
      game: 'none',
    });
    expect(parsePlayerEndReply('note: finish the board game: monopoly player: Finish Monopoly with Sui game: none')).toEqual({
      step: 'finish the board game: monopoly',
      line: 'Finish Monopoly with Sui',
      game: 'none',
    });
    // A label earlier in the order does not split a later one's text.
    expect(parsePlayerEndReply('note: x\nplayer: Write a note: thank Sui\ngame: Minecraft')?.line).toBe('Write a note: thank Sui');
    // A label that has its own line is not also split out mid-line.
    expect(parsePlayerEndReply('note: ask the player: how the interview went\nplayer: Tell Sui how the interview went\ngame: none')).toEqual({
      step: 'ask the player: how the interview went',
      line: 'Tell Sui how the interview went',
      game: 'none',
    });
    expect(parsePlayerEndReply('note: get copper player: Get copper with Sui\ngame: Minecraft')).toEqual({
      step: 'get copper',
      line: 'Get copper with Sui',
      game: 'minecraft',
    });
    // The real inline labels still split.
    expect(parsePlayerEndReply('note: plant parsnips player: Plant parsnips with Sui game: Stardew Valley.')).toEqual({
      step: 'plant parsnips',
      line: 'Plant parsnips with Sui',
      game: 'stardew',
    });
  });
});

describe('session ends that run no check (261107)', () => {
  it('one next_step_checked with why, shape only', () => {
    expect(notRunProps({ characterId: 'c', surface: 'game', game: 'stardew', outcome: 'not_covered', endReason: 'kicked', durationMs: 754_400 })).toEqual({
      character_id: 'c',
      source: 'player_end',
      surface: 'game',
      game: 'stardew',
      saved: false,
      outcome: 'not_covered',
      reached_model: false,
      end_reason: 'kicked',
      duration_s: 754,
    });
    expect(notRunProps({ characterId: 'c', surface: 'chat', outcome: 'not_covered' })).toEqual({
      character_id: 'c',
      source: 'player_end',
      surface: 'chat',
      saved: false,
      outcome: 'not_covered',
      reached_model: false,
    });
  });

  it('only a goodbye can count as saved', () => {
    expect(notRunProps({ characterId: 'c', surface: 'call', outcome: 'goodbye', saved: true }).saved).toBe(true);
    expect(notRunProps({ characterId: 'c', surface: 'call', outcome: 'goodbye', saved: false }).saved).toBe(false);
    expect(notRunProps({ characterId: 'c', surface: 'call', outcome: 'deferred', saved: true }).saved).toBe(false);
  });

  it('reports through the given capture and never throws', () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    reportNextStepNotRun({ characterId: 'c', surface: 'draw', outcome: 'not_covered', endReason: 'completed' }, (e, p) => events.push([e, p]));
    reportGoodbyePlanSaved({ characterId: 'c', surface: 'game', game: 'minecraft' }, (e, p) => events.push([e, p]));
    expect(events).toEqual([
      ['next_step_checked', expect.objectContaining({ surface: 'draw', outcome: 'not_covered', end_reason: 'completed' })],
      ['next_step_saved', { character_id: 'c', source: 'companion', surface: 'game', game: 'minecraft' }],
    ]);
    const boom = () => {
      throw new Error('analytics down');
    };
    expect(() => reportNextStepNotRun({ characterId: 'c', surface: 'chat', outcome: 'not_covered' }, boom)).not.toThrow();
    expect(() => reportGoodbyePlanSaved({ characterId: 'c', surface: 'call' }, boom)).not.toThrow();
  });
});
