import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LEDGER_FILE,
  NEXT_STEP_MAX_AGE_MS,
  TAG_WINDOW_MS,
  consumeNextStep,
  goalDisplayText,
  parseLedger,
  pickNextStep,
  planDisplayText,
  planEntries,
  planGame,
  planIsForOtherGame,
  planKey,
  readHomeNextStep,
  readPendingPlan,
  readPendingPlanFor,
  tagLatestPlan,
  type NextStepLedger,
} from './homeNextStep';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const empty: NextStepLedger = { v: 1, tags: [] };

function memory(...lines: Array<[number, string]>): string {
  return ['# Memory', '', '## World 1 - Spawn', ...lines.map(([at, text]) => `- [${iso(at)}] ${text}`)].join('\n') + '\n';
}

function pick(over: Partial<Parameters<typeof pickNextStep>[0]> = {}) {
  return pickNextStep({ characterId: 'c1', memory: '', ledger: empty, goals: [], now: NOW, ...over });
}

describe('plan parsing', () => {
  it('finds only "Plan for next time:" entries, prefix removed', () => {
    const body = memory(
      [NOW - 3 * HOUR, 'Alex likes building near water.'],
      [NOW - 2 * HOUR, 'Plan for next time: finish the roof on the lake house'],
      [NOW - HOUR, 'plan for next time:   find diamonds together.'],
    );
    expect(planEntries(body).map((e) => e.text)).toEqual(['finish the roof on the lake house', 'find diamonds together.']);
  });

  it('261020: reads the game a plan line names, and keeps unlabeled plans game-less', () => {
    const body = memory(
      [NOW - 3 * HOUR, 'Plan for next time in Minecraft: get copper for the lighthouse'],
      [NOW - 2 * HOUR, "Plan for next time in Don't Starve Together: build a crock pot"],
      [NOW - HOUR, 'Plan for next time: ask how the interview went'],
      [NOW - 30_000, 'Plan for next time in Terraria: beat the eye'],
    );
    expect(planEntries(body).map((e) => [e.text, e.game])).toEqual([
      ['get copper for the lighthouse', 'minecraft'],
      ['build a crock pot', 'dontstarve'],
      ['ask how the interview went', null],
      ['beat the eye', null],
    ]);
  });

  it('261020: the tag decides the game, else the line', () => {
    const [plan] = planEntries(memory([NOW, 'Plan for next time in Stardew Valley: plant parsnips']));
    expect(planGame(plan, empty)).toBe('stardew');
    const tagged: NextStepLedger = { v: 1, tags: [{ key: planKey(plan.text), at: iso(NOW), surface: 'game', game: 'minecraft' }] };
    expect(planGame(plan, tagged)).toBe('minecraft');
    expect(planIsForOtherGame(plan, tagged, 'stardew')).toBe(true);
    expect(planIsForOtherGame(plan, tagged, 'minecraft')).toBe(false);
    expect(planIsForOtherGame(plan, tagged, null)).toBe(false);
  });

  it('ignores lines without a readable stamp and empty plans', () => {
    const body = '- [not a date] Plan for next time: x\n- [2026-10-13T10:00:00.000Z] Plan for next time:\nPlan for next time: y\n';
    expect(planEntries(body)).toEqual([]);
  });

  it('display text is one line, capitalized, no trailing period', () => {
    expect(planDisplayText('  finish the\n roof.  ')).toBe('Finish the roof');
    expect(planDisplayText('去挖钻石。')).toBe('去挖钻石');
  });

  it('planKey matches across punctuation and case', () => {
    expect(planKey('Finish the roof!')).toBe(planKey('finish   the roof'));
  });
});

describe('pickNextStep', () => {
  it('no plan and no goal is no card', () => {
    expect(pick()).toBeNull();
    expect(pick({ memory: memory([NOW - HOUR, 'Alex is in school.']) })).toBeNull();
  });

  it('shows the newest fresh plan', () => {
    const step = pick({
      memory: memory([NOW - 5 * HOUR, 'Plan for next time: old plan'], [NOW - HOUR, 'Plan for next time: build a boat']),
    });
    expect(step).toEqual({ characterId: 'c1', source: 'plan', text: 'Build a boat', at: NOW - HOUR, surface: null, game: null });
  });

  it('an expired newest plan is no plan (never falls back to an older one)', () => {
    const old = NOW - NEXT_STEP_MAX_AGE_MS - HOUR;
    expect(pick({ memory: memory([old - HOUR, 'Plan for next time: a'], [old, 'Plan for next time: b']) })).toBeNull();
    // Just inside the window still shows.
    expect(pick({ memory: memory([NOW - NEXT_STEP_MAX_AGE_MS + HOUR, 'Plan for next time: c']) })?.text).toBe('C');
  });

  it('a consumed plan is gone; a plan written after the watermark shows', () => {
    const body = memory([NOW - 2 * HOUR, 'Plan for next time: build a boat']);
    expect(pick({ memory: body, ledger: { v: 1, tags: [], consumedAt: iso(NOW - HOUR) } })).toBeNull();
    expect(pick({ memory: body, ledger: { v: 1, tags: [], consumedAt: iso(NOW - 3 * HOUR) } })?.text).toBe('Build a boat');
  });

  it('a consumed newest plan does not resurrect an older unconsumed one', () => {
    const body = memory([NOW - 3 * HOUR, 'Plan for next time: a'], [NOW - HOUR, 'Plan for next time: b']);
    expect(pick({ memory: body, ledger: { v: 1, tags: [], consumedAt: iso(NOW - 30 * 60_000) } })).toBeNull();
  });

  it('reads the surface and game from the newest matching tag', () => {
    const at = NOW - HOUR;
    const ledger: NextStepLedger = {
      v: 1,
      tags: [
        { key: planKey('build a boat'), at: iso(at - HOUR), surface: 'call' },
        { key: planKey('Build a boat.'), at: iso(at), surface: 'game', game: 'stardew' },
        { key: planKey('something else'), at: iso(at), surface: 'backseat', game: 'roblox' },
      ],
    };
    const step = pick({ memory: memory([at, 'Plan for next time: build a boat']), ledger });
    expect(step?.surface).toBe('game');
    expect(step?.game).toBe('stardew');
  });

  it('falls back to the newest fresh goal across games', () => {
    const step = pick({
      goals: [
        { game: 'minecraft', body: `# Heartbeat\n\n- [${iso(NOW - 4 * HOUR)}] Reach iron tier. Finish when an iron pickaxe exists.\n` },
        { game: 'stardew', body: `# Heartbeat\n\n- [${iso(NOW - 2 * HOUR)}] Plant the parsnip seeds: till 15 tiles by the house\n` },
      ],
    });
    expect(step).toEqual({ characterId: 'c1', source: 'goal', text: 'Plant the parsnip seeds', at: NOW - 2 * HOUR, surface: 'game', game: 'stardew' });
  });

  it('falls back to a goal when the plan is consumed or expired, and stale goals are ignored', () => {
    const goals = [{ game: 'minecraft', body: `- [${iso(NOW - HOUR)}] Build a wheat farm with Alex\n` }];
    const consumed = pick({
      memory: memory([NOW - 2 * HOUR, 'Plan for next time: x']),
      ledger: { v: 1, tags: [], consumedAt: iso(NOW - HOUR) },
      goals,
    });
    expect(consumed?.source).toBe('goal');
    expect(consumed?.game).toBe('minecraft');
    const staleGoal = [{ game: 'minecraft', body: `- [${iso(NOW - NEXT_STEP_MAX_AGE_MS - HOUR)}] Old goal\n` }];
    expect(pick({ goals: staleGoal })).toBeNull();
  });

  it('a fresh plan wins over a newer goal', () => {
    const step = pick({
      memory: memory([NOW - 3 * HOUR, 'Plan for next time: tame a fox']),
      goals: [{ game: 'minecraft', body: `- [${iso(NOW - HOUR)}] Gather 20 oak logs\n` }],
    });
    expect(step?.source).toBe('plan');
  });
});

describe('goalDisplayText', () => {
  it('keeps the headline of a working note', () => {
    expect(goalDisplayText('Get iron tools with Alex: gather wood, make a wooden pickaxe. Finish when an iron pickaxe exists.')).toBe(
      'Get iron tools with Alex',
    );
    expect(goalDisplayText('reach stone tier. Finish when a stone pickaxe is crafted')).toBe('Reach stone tier');
    expect(goalDisplayText('Protect the player: stay close')).toBe('Protect the player');
    expect(goalDisplayText('Note: build a house')).toBe('Note: build a house');
    expect(goalDisplayText('   ')).toBe('');
  });

  // 261013 (pass 6b): a player's task carries a tag (heartbeat.js) and is
  // usually written as "Alex asked: ...". The card shows the task itself.
  it('drops the player-task tag and the "who asked" head', () => {
    expect(goalDisplayText('(player task) Bring Alex 10 logs. Finish when he has them')).toBe('Bring Alex 10 logs');
    expect(goalDisplayText('(player task) Alex asked: grab coal from the ore, then come back. Done when Alex has it.')).toBe(
      'Grab coal from the ore, then come back',
    );
    expect(goalDisplayText('(player task) Alex asked me to mine coal near the river. Done when I hand it over')).toBe(
      'Mine coal near the river',
    );
    expect(goalDisplayText('(player task) For Alex: chop 5 oak logs, then meet Alex at the house')).toBe(
      'Chop 5 oak logs, then meet Alex at the house',
    );
    expect(goalDisplayText('(player task)')).toBe('');
  });
});

describe('parseLedger', () => {
  it('261014: keeps a string line and drops a malformed one, keeping the tag', () => {
    const l = parseLedger(
      JSON.stringify({ v: 1, tags: [{ key: 'a', at: iso(NOW), surface: 'call', line: 'Tell Sui' }, { key: 'b', at: iso(NOW), surface: 'call', line: 7 }] }),
    );
    expect(l.tags[0].line).toBe('Tell Sui');
    expect(l.tags[1].key).toBe('b');
    expect(l.tags[1].line).toBeUndefined();
  });

  it('drops malformed parts and reads good ones', () => {
    expect(parseLedger(null)).toEqual(empty);
    expect(parseLedger('{oops')).toEqual(empty);
    const raw = JSON.stringify({
      v: 1,
      consumedAt: 'nope',
      tags: [{ key: 'a', at: iso(NOW), surface: 'game', game: 'minecraft' }, { key: 'b', at: iso(NOW), surface: 'tv' }, null],
    });
    expect(parseLedger(raw)).toEqual({ v: 1, tags: [{ key: 'a', at: iso(NOW), surface: 'game', game: 'minecraft' }] });
  });
});

describe('files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sei-next-step-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeMemory = (...lines: Array<[number, string]>) => writeFile(path.join(dir, 'MEMORY.md'), memory(...lines));
  const ledger = async () => parseLedger(await readFile(path.join(dir, LEDGER_FILE), 'utf8').catch(() => null));

  it('a missing memory dir is no card', async () => {
    expect(await readHomeNextStep(path.join(dir, 'nope'), 'c1', NOW)).toBeNull();
  });

  it('tags a just-written plan and the card carries its surface', async () => {
    await writeMemory([NOW - 60_000, 'Plan for next time: plant parsnips']);
    expect(await tagLatestPlan(dir, { surface: 'game', game: 'stardew' }, NOW)).toBe(true);
    const step = await readHomeNextStep(dir, 'c1', NOW);
    expect(step).toMatchObject({ source: 'plan', text: 'Plant parsnips', surface: 'game', game: 'stardew' });
  });

  it('does not tag a plan older than the tag window, or when there is none', async () => {
    expect(await tagLatestPlan(dir, { surface: 'call' }, NOW)).toBe(false);
    await writeMemory([NOW - TAG_WINDOW_MS - 60_000, 'Plan for next time: old']);
    expect(await tagLatestPlan(dir, { surface: 'call' }, NOW)).toBe(false);
    expect((await ledger()).tags).toEqual([]);
  });

  it('261014: a tag with a player line shows that line instead of the note', async () => {
    await writeMemory([NOW - 60_000, "Plan for next time: ask Alex what the vet says about Pepper's leg on Thursday"]);
    expect(await tagLatestPlan(dir, { surface: 'call', line: 'tell Roger what the vet said about Pepper.' }, NOW)).toBe(true);
    expect((await ledger()).tags[0].line).toBe('Tell Roger what the vet said about Pepper');
    expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ text: 'Tell Roger what the vet said about Pepper', surface: 'call' });
  });

  it('261014: an old tag without a line (or an empty line) keeps the note text', async () => {
    await writeMemory([NOW - 60_000, 'Plan for next time: raid the east village for beds tomorrow']);
    await tagLatestPlan(dir, { surface: 'game', game: 'minecraft', line: '  ' }, NOW);
    expect((await ledger()).tags[0]).not.toHaveProperty('line');
    expect((await readHomeNextStep(dir, 'c1', NOW))?.text).toBe('Raid the east village for beds tomorrow');
  });

  it('261014: a line that reads as the companion note is not stored, so the card shows the note', async () => {
    await writeMemory([NOW - 60_000, 'Plan for next time: ask how the move on Saturday went']);
    const names = { character: 'Lyra', players: ['Alex'] };
    expect(await tagLatestPlan(dir, { surface: 'call', line: 'Ask how the move went', names }, NOW)).toBe(true);
    expect((await ledger()).tags[0]).not.toHaveProperty('line');
    expect((await readHomeNextStep(dir, 'c1', NOW))?.text).toBe('Ask how the move on Saturday went');
    await tagLatestPlan(dir, { surface: 'call', line: 'Tell Alex about the move', names }, NOW);
    expect((await ledger()).tags[0]).not.toHaveProperty('line');
    await tagLatestPlan(dir, { surface: 'call', line: 'Tell Lyra how the move went', names }, NOW);
    expect((await ledger()).tags[0].line).toBe('Tell Lyra how the move went');
  });

  it('261014: readPendingPlan peeks the open plan until it is consumed', async () => {
    expect(await readPendingPlan(dir, NOW)).toBeNull();
    await writeMemory([NOW - 2 * HOUR, 'Plan for next time: plant parsnips']);
    expect(await readPendingPlan(dir, NOW)).toBe('plant parsnips');
    expect(await readPendingPlan(dir, NOW)).toBe('plant parsnips'); // a peek writes nothing
    await consumeNextStep(dir, NOW);
    expect(await readPendingPlan(dir, NOW + 1)).toBeNull();
    expect(await readPendingPlan(path.join(dir, 'nope'), NOW)).toBeNull();
  });

  it('re-tagging the same plan replaces its tag', async () => {
    await writeMemory([NOW - 60_000, 'Plan for next time: plant parsnips']);
    await tagLatestPlan(dir, { surface: 'call' }, NOW);
    await tagLatestPlan(dir, { surface: 'backseat', game: 'roblox' }, NOW);
    expect((await ledger()).tags).toEqual([{ key: 'plant parsnips', at: iso(NOW - 60_000), surface: 'backseat', game: 'roblox' }]);
  });

  it('consume marks the plan used once; later calls write nothing', async () => {
    await writeMemory([NOW - HOUR, 'Plan for next time: plant parsnips']);
    expect(await consumeNextStep(dir, NOW)).toBe(true);
    expect((await ledger()).consumedAt).toBe(iso(NOW));
    expect(await readHomeNextStep(dir, 'c1', NOW)).toBeNull();
    expect(await consumeNextStep(dir, NOW + 1000)).toBe(false);
    expect((await ledger()).consumedAt).toBe(iso(NOW));
  });

  it('consume with no plan writes nothing', async () => {
    await writeMemory([NOW - HOUR, 'Alex likes boats.']);
    expect(await consumeNextStep(dir, NOW)).toBe(false);
    await expect(readFile(path.join(dir, LEDGER_FILE), 'utf8')).rejects.toThrow();
  });

  it('a new plan after a consumed one shows again', async () => {
    await writeMemory([NOW - 2 * HOUR, 'Plan for next time: a']);
    await consumeNextStep(dir, NOW - HOUR);
    await writeMemory([NOW - 2 * HOUR, 'Plan for next time: a'], [NOW - 60_000, 'Plan for next time: b']);
    expect((await readHomeNextStep(dir, 'c1', NOW))?.text).toBe('B');
  });

  // 261020: a plan belongs to a game, and only that game's greeting raises
  // and uses it up (live: a Minecraft build was offered as "Play Stardew").
  describe('261020: plans scoped to their game', () => {
    it('a game session greeting skips a plan tagged for another game and leaves it open', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time in Minecraft: get copper for the copper bulb lighthouse']);
      await tagLatestPlan(dir, { surface: 'game', game: 'minecraft', line: 'Get copper for your copper bulb lighthouse' }, NOW);
      expect(await readPendingPlan(dir, NOW, { game: 'stardew' })).toBeNull();
      expect(await consumeNextStep(dir, NOW, { game: 'stardew' })).toBe(false);
      expect(await readHomeNextStep(dir, 'c1', NOW + 1)).toMatchObject({
        source: 'plan',
        text: 'Get copper for your copper bulb lighthouse',
        surface: 'game',
        game: 'minecraft',
      });
      // Its own game raises it and uses it up.
      expect(await readPendingPlan(dir, NOW, { game: 'minecraft' })).toBe('get copper for the copper bulb lighthouse');
      expect(await consumeNextStep(dir, NOW + 2, { game: 'minecraft' })).toBe(true);
      expect(await readHomeNextStep(dir, 'c1', NOW + 3)).toBeNull();
    });

    it('the game the memory line names counts when there is no tag', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time in Stardew Valley: plant the strawberry seeds']);
      expect(await readPendingPlan(dir, NOW, { game: 'minecraft' })).toBeNull();
      expect(await readPendingPlan(dir, NOW, { game: 'stardew' })).toBe('plant the strawberry seeds');
      expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ surface: 'game', game: 'stardew', text: 'Plant the strawberry seeds' });
    });

    it('a plan with no game (a call plan, an untagged note) is raised by any game and by a call', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time: ask how the job interview went']);
      await tagLatestPlan(dir, { surface: 'call' }, NOW);
      expect(await readPendingPlan(dir, NOW, { game: 'stardew' })).toBe('ask how the job interview went');
      expect(await readPendingPlan(dir, NOW)).toBe('ask how the job interview went');
      expect(await consumeNextStep(dir, NOW, { game: 'dontstarve' })).toBe(true);
    });

    // 261020 (review): the greeting raises a plan with no game as talk.
    it('readPendingPlanFor says when an open plan is not tied to the game', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time: ask how the job interview went']);
      await tagLatestPlan(dir, { surface: 'call' }, NOW);
      expect(await readPendingPlanFor(dir, NOW, { game: 'stardew' })).toEqual({ text: 'ask how the job interview went', notForGame: true });
      expect(await readPendingPlanFor(dir, NOW)).toEqual({ text: 'ask how the job interview went', notForGame: false });
    });

    it('readPendingPlanFor: a plan for this game is tied to it, a none plan (game dropped) is not', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time in Stardew Valley: plant parsnips']);
      expect(await readPendingPlanFor(dir, NOW, { game: 'stardew' })).toEqual({ text: 'plant parsnips', notForGame: false });
      await writeMemory([NOW - 30_000, 'Plan for next time: ask how the job interview went']);
      await tagLatestPlan(dir, { surface: 'game' }, NOW);
      expect(await readPendingPlanFor(dir, NOW, { game: 'minecraft' })).toEqual({ text: 'ask how the job interview went', notForGame: true });
      expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ surface: 'game', game: null });
    });

    it('a call greeting (no game) raises and uses up any plan', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time in Minecraft: dig copper']);
      expect(await readPendingPlan(dir, NOW)).toBe('dig copper');
      expect(await consumeNextStep(dir, NOW)).toBe(true);
    });
  });

  // 261107: the next text chat uses up the plan the last text chat left, and
  // nothing else (a game or call plan waits for its own surface).
  describe('261107: a text chat start uses only a chat plan', () => {
    const chat = { onlySurface: 'chat' as const };

    it('uses up a plan tagged from a text chat', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time: ask how the driving test went']);
      await tagLatestPlan(dir, { surface: 'chat', line: 'Tell Lyra how the driving test went' }, NOW);
      expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ source: 'plan', surface: 'chat' });
      expect(await consumeNextStep(dir, NOW + 1000, chat)).toBe(true);
      expect((await ledger()).consumedAt).toBe(iso(NOW + 1000));
      expect(await readHomeNextStep(dir, 'c1', NOW + 2000)).toBeNull();
      // Once used, a later chat start writes nothing.
      expect(await consumeNextStep(dir, NOW + 3000, chat)).toBe(false);
      expect((await ledger()).consumedAt).toBe(iso(NOW + 1000));
    });

    it('leaves a game plan open (also one a chat check placed in a game)', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time in Minecraft: dig copper for the lighthouse']);
      await tagLatestPlan(dir, { surface: 'game', game: 'minecraft' }, NOW);
      expect(await consumeNextStep(dir, NOW + 1000, chat)).toBe(false);
      expect(await readHomeNextStep(dir, 'c1', NOW + 2000)).toMatchObject({ surface: 'game', game: 'minecraft' });
      // Minecraft starting still uses it.
      expect(await consumeNextStep(dir, NOW + 3000, { game: 'minecraft' })).toBe(true);
    });

    it('leaves a call plan, a backseat plan and an untagged plan open', async () => {
      await writeMemory([NOW - 60_000, 'Plan for next time: plant parsnips']);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false); // untagged
      await tagLatestPlan(dir, { surface: 'call' }, NOW);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false);
      await tagLatestPlan(dir, { surface: 'backseat', game: 'roblox' }, NOW);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false);
      expect((await ledger()).consumedAt).toBeUndefined();
      expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ source: 'plan', text: 'Plant parsnips' });
    });

    it('a newer game plan over an older chat plan stays open', async () => {
      await writeMemory([NOW - 2 * HOUR, 'Plan for next time: ask about the trip']);
      await tagLatestPlan(dir, { surface: 'chat' }, NOW - 2 * HOUR + 1000);
      await writeMemory([NOW - 2 * HOUR, 'Plan for next time: ask about the trip'], [NOW - 60_000, 'Plan for next time in Stardew Valley: water the crops']);
      await tagLatestPlan(dir, { surface: 'game', game: 'stardew' }, NOW);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false);
      expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ surface: 'game', game: 'stardew' });
    });

    it('no memory dir, no plan, or no ledger: nothing written, no throw', async () => {
      expect(await consumeNextStep(path.join(dir, 'nope'), NOW, chat)).toBe(false);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false);
      await writeMemory([NOW - HOUR, 'Alex likes boats.']);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false);
      await writeMemory([NOW - HOUR, 'Plan for next time: plant parsnips']);
      expect(await consumeNextStep(dir, NOW, chat)).toBe(false);
      await expect(readFile(path.join(dir, LEDGER_FILE), 'utf8')).rejects.toThrow();
    });
  });

  it('reads goals from the per-game HEARTBEAT files', async () => {
    await writeFile(path.join(dir, 'HEARTBEAT.dontstarve.md'), `# Heartbeat\n\n- [${iso(NOW - HOUR)}] Build a science machine\n`);
    expect(await readHomeNextStep(dir, 'c1', NOW)).toMatchObject({ source: 'goal', game: 'dontstarve', surface: 'game' });
  });
});
