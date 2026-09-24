import { describe, expect, it, vi } from 'vitest';
import { ActRun, limitsFromEnv, statusFor, thumbDiff, type ActEnv, type ActEvent } from './actLoop';
import type { HelperCommand } from './actions';
import type { Choice, ChooseState, Chooser, HistoryEntry } from './chooser';
import type { InputExecutor, UserInputEvent } from './inputHelper';
import { perceive, type ActOption } from './perception';
import type { AxNode, Frame } from './types';

const RECT = { x: 0, y: 0, w: 1000, h: 800 };
const T_A = '00'.repeat(576);
const T_B = 'ff'.repeat(576);

class FakeExecutor implements InputExecutor {
  acts: HelperCommand[] = [];
  cancels = 0;
  releases = 0;
  watching: boolean[] = [];
  private listeners = new Set<(e: UserInputEvent) => void>();
  actImpl: (c: HelperCommand, signal?: AbortSignal) => Promise<{ ms: number }> = async () => ({ ms: 1 });
  async act(c: HelperCommand, signal?: AbortSignal) {
    this.acts.push(c);
    return this.actImpl(c, signal);
  }
  async cancel() {
    this.cancels += 1;
  }
  async releaseAll() {
    this.releases += 1;
  }
  async screenshot(): Promise<never> {
    throw new Error('unused');
  }
  async windows() {
    return [];
  }
  async displays() {
    return [];
  }
  async frontmost() {
    return {};
  }
  async app() {
    return null;
  }
  async permissions() {
    return { axTrusted: true, postEventAccess: true, screenCaptureAccess: true };
  }
  async axDump(): Promise<AxNode[]> {
    return [];
  }
  async axFocused() {
    return null;
  }
  async watch(on: boolean) {
    this.watching.push(on);
  }
  onUserInput(cb: (e: UserInputEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emitUserInput(kind: 'mouse' | 'key' = 'mouse') {
    for (const l of this.listeners) l({ kind, source: 'test', ago: 0 });
  }
  dispose() {}
}

/** A chooser that replays a script of choices (the last one repeats). */
function scripted(name: string, script: Array<Partial<Choice> | ((s: ChooseState, o: ActOption[], h: HistoryEntry[]) => Partial<Choice>)>, textOnly = false) {
  let i = 0;
  const calls: Array<{ state: ChooseState; options: ActOption[] }> = [];
  const chooser: Chooser & { calls: typeof calls } = {
    name,
    model: name,
    textOnly,
    calls,
    async choose(state, options, history) {
      calls.push({ state: { ...state, notes: [...state.notes] }, options });
      const s = script[Math.min(i++, script.length - 1)]!;
      return { latencyMs: 1, ...(typeof s === 'function' ? s(state, options, history) : s) };
    },
  };
  return chooser;
}

let thumbs: string[] = [];
function frameSeq(): (withOcr: boolean) => Promise<Frame> {
  let n = 0;
  return async () => ({
    data: 'AAAA',
    mime: 'image/jpeg',
    width: 1000,
    height: 800,
    rect: RECT,
    capturedAt: n,
    thumb: thumbs.length ? thumbs[Math.min(n++, thumbs.length - 1)] : (n++ % 2 ? T_A : T_B),
  });
}

function makeEnv(over: Partial<ActEnv> = {}): { env: ActEnv; ex: FakeExecutor; events: ActEvent[] } {
  const ex = new FakeExecutor();
  const events: ActEvent[] = [];
  const env: ActEnv = {
    goal: 'do the thing',
    executor: ex,
    vision: scripted('vision', [{ action: { name: 'give_up', input: { reason: 'default' } } }]),
    verify: async () => ({ achieved: true, why: 'looks done', latencyMs: 1 }),
    capture: (w) => frameSeq()(w),
    scope: async () => ({ ok: true }),
    onEvent: (e) => events.push(e),
    ...over,
  };
  if (!over.capture) {
    const seq = frameSeq();
    env.capture = (w) => seq(w);
  }
  return { env, ex, events };
}

const click = { action: { name: 'click' as const, input: { x: 10, y: 10, button: 'left' as const } } };
const done = { action: { name: 'done' as const, input: { summary: 'all set' } } };

describe('statusFor / thumbDiff / limitsFromEnv', () => {
  it('maps stop reasons to control statuses', () => {
    expect(statusFor('done')).toBe('done');
    expect(statusFor('stalled')).toBe('gave_up');
    expect(statusFor('scope')).toBe('gave_up');
    expect(statusFor('step_cap')).toBe('timeout');
    expect(statusFor('time_cap')).toBe('timeout');
    expect(statusFor('user_input')).toBe('aborted');
    expect(statusFor('replaced')).toBe('aborted');
  });
  it('diffs thumbnails', () => {
    expect(thumbDiff(T_A, T_A)).toBe(0);
    expect(thumbDiff(T_A, T_B)).toBe(255);
    expect(thumbDiff(undefined, T_A)).toBe(Infinity);
  });
  it('reads caps from env', () => {
    expect(limitsFromEnv({ SEI_ACT_MAX_STEPS: '10', SEI_ACT_MAX_SECONDS: '30' })).toEqual({ maxSteps: 10, maxMs: 30000 });
    expect(limitsFromEnv({ SEI_ACT_MAX_STEPS: 'x' })).toEqual({});
  });
});

describe('ActRun', () => {
  it('runs actions, verifies done, and lets go of everything', async () => {
    const { env, ex, events } = makeEnv({ vision: scripted('vision', [{ ...click, say: 'on it' }, done]) });
    const out = await new ActRun(env, { settleMs: 0 }).run();
    expect(out).toMatchObject({ reason: 'done', status: 'done', steps: 2, summary: 'all set' });
    expect(ex.acts).toHaveLength(1);
    expect(ex.acts[0]).toMatchObject({ cmd: 'click' });
    expect(events.some((e) => e.type === 'say' && e.text === 'on it')).toBe(true);
    expect(events.filter((e) => e.type === 'action')).toHaveLength(2);
    expect(ex.releases).toBeGreaterThan(0);
    expect(ex.watching).toEqual([true, false]);
    expect(out.lastFrame).toBeDefined();
    expect(out.timings[0]).toMatchObject({ chooser: 'vision', pick: 'no_text_chooser' });
  });

  it('does not trust DONE: a failed check continues on vision with the reason', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ achieved: false, why: 'the dialog is still open.', latencyMs: 1 })
      .mockResolvedValue({ achieved: true, why: 'closed', latencyMs: 1 });
    const vision = scripted('vision', [done, click, done]);
    const { env } = makeEnv({ vision, verify });
    const out = await new ActRun(env, { settleMs: 0 }).run();
    expect(out.reason).toBe('done');
    expect(out.steps).toBe(3);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(vision.calls[1]!.state.notes.join(' ')).toMatch(/not achieved yet: the dialog is still open/);
    expect(out.history[0]).toMatchObject({ ok: false });
  });

  it('gives up after repeated failed checks', async () => {
    const { env } = makeEnv({
      vision: scripted('vision', [done]),
      verify: async () => ({ achieved: false, why: 'nope', latencyMs: 1 }),
    });
    const out = await new ActRun(env, { settleMs: 0, maxVerifyFails: 2 }).run();
    expect(out).toMatchObject({ reason: 'gave_up', status: 'gave_up', steps: 2 });
  });

  it('stops at the step cap with status timeout', async () => {
    const { env, ex } = makeEnv({ vision: scripted('vision', [click]) });
    const out = await new ActRun(env, { settleMs: 0, maxSteps: 5 }).run();
    expect(out).toMatchObject({ reason: 'step_cap', status: 'timeout', steps: 5 });
    expect(ex.acts).toHaveLength(5);
  });

  it('stops at the time cap mid-call with status timeout', async () => {
    const slow: Chooser = { name: 'vision', model: 'v', textOnly: false, choose: () => new Promise(() => {}) };
    const { env } = makeEnv({ vision: slow });
    const t0 = Date.now();
    const out = await new ActRun(env, { maxMs: 80 }).run();
    expect(out).toMatchObject({ reason: 'time_cap', status: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('stall: re-perceives on vision once, then gives up', async () => {
    thumbs = [T_A];
    try {
      const vision = scripted('vision', [click]);
      const text = scripted('jev', [{ index: 0, probs: [0.9] }], true);
      const { env } = makeEnv({
        vision,
        text,
        perceive: async (f) => perceive({ frame: f, targetRect: RECT, ax: richAx }),
      });
      const out = await new ActRun(env, { settleMs: 0, stallActions: 3 }).run();
      expect(out).toMatchObject({ reason: 'stalled', status: 'gave_up' });
      // Steps 1-3 act with no change -> strike 1 before step 4 (forced
      // vision); steps 4-6 act with no change -> strike 2 before step 7.
      expect(out.steps).toBe(6);
      expect(out.timings[3]).toMatchObject({ pick: 'forced', chooser: 'vision' });
      const forced = out.timings.find((t) => t.pick === 'forced');
      expect(forced).toBeDefined();
      expect(vision.calls[0]!.state.notes.join(' ')).toMatch(/did not change the screen/);
    } finally {
      thumbs = [];
    }
  });

  it('player mouse or keyboard input aborts immediately, even mid-action', async () => {
    const { env, ex } = makeEnv({ vision: scripted('vision', [click]) });
    ex.actImpl = (_c, signal) =>
      new Promise((_r, j) => {
        signal?.addEventListener('abort', () => j(new Error('aborted')));
      });
    const run = new ActRun(env, { settleMs: 0 });
    const p = run.run();
    await vi.waitFor(() => expect(ex.acts).toHaveLength(1));
    ex.emitUserInput('key');
    const out = await p;
    expect(out).toMatchObject({ reason: 'user_input', status: 'aborted' });
    expect(out.summary).toMatch(/took over the mouse or keyboard \(keyboard\)/);
    expect(ex.cancels).toBeGreaterThan(0);
    expect(ex.releases).toBeGreaterThan(0);
  });

  it('stop() during the model call ends the run as aborted', async () => {
    const hang: Chooser = { name: 'vision', model: 'v', textOnly: false, choose: () => new Promise(() => {}) };
    const { env } = makeEnv({ vision: hang });
    const run = new ActRun(env);
    const p = run.run();
    await new Promise((r) => setTimeout(r, 10));
    run.stop('replaced');
    expect(await p).toMatchObject({ reason: 'replaced', status: 'aborted' });
  });

  it('never types into a password field', async () => {
    const { env, ex } = makeEnv({
      vision: scripted('vision', [{ action: { name: 'type', input: { text: 'hunter2' } } }]),
      focused: async () => ({ depth: 0, parent: -1, role: 'AXTextField', subrole: 'AXSecureTextField' }),
    });
    const out = await new ActRun(env, { settleMs: 0 }).run();
    expect(out).toMatchObject({ reason: 'gave_up' });
    expect(out.summary).toMatch(/password/);
    expect(ex.acts).toHaveLength(0);
  });

  it('refuses blocked combos without sending them and keeps going', async () => {
    const { env, ex } = makeEnv({ vision: scripted('vision', [{ action: { name: 'key', input: { keys: 'cmd+q' } } }, done]) });
    const out = await new ActRun(env, { settleMs: 0 }).run();
    expect(out.reason).toBe('done');
    expect(ex.acts).toHaveLength(0);
    expect(out.history[0]).toMatchObject({ ok: false });
    expect(out.history[0]!.result).toMatch(/refused/);
  });

  it('scope refusals are counted and end the run', async () => {
    const { env, ex } = makeEnv({ vision: scripted('vision', [click]), scope: async () => ({ ok: false, reason: 'outside' }) });
    const out = await new ActRun(env, { settleMs: 0, maxScopeRefusals: 2 }).run();
    expect(out).toMatchObject({ reason: 'scope', status: 'gave_up', steps: 2 });
    expect(ex.acts).toHaveLength(0);
  });

  it('gives up after repeated unusable chooser answers', async () => {
    const { env } = makeEnv({ vision: scripted('vision', [{ error: 'no action was called' }]) });
    const out = await new ActRun(env, { settleMs: 0, maxChooserErrors: 2 }).run();
    expect(out).toMatchObject({ reason: 'error', steps: 2 });
  });

  it('runs rich steps on the text chooser and maps the index to the option action', async () => {
    const vision = scripted('vision', [done]);
    const text = scripted('jev', [{ index: 1, probs: [0.1, 0.8] }, { index: 0, probs: [0.2] }], true);
    const { env, ex } = makeEnv({ vision, text, perceive: async (f) => perceive({ frame: f, targetRect: RECT, ax: richAx }) });
    const out = await new ActRun(env, { settleMs: 0, maxSteps: 2 }).run();
    expect(out.timings[0]).toMatchObject({ chooser: 'jev', pick: 'text' });
    expect(ex.acts[0]).toMatchObject({ cmd: 'click' });
    // Step 2: jev's top prob 0.2 < 0.35, so vision redoes it and says done.
    expect(out.timings[1]).toMatchObject({ chooser: 'vision', pick: 'fallback' });
    expect(out.reason).toBe('done');
  });

  it('hands a thin screen (game) to vision', async () => {
    const vision = scripted('vision', [done]);
    const text = scripted('jev', [{ index: 0 }], true);
    const { env } = makeEnv({ vision, text, perceive: async (f) => perceive({ frame: f, targetRect: RECT }) });
    const out = await new ActRun(env, { settleMs: 0 }).run();
    expect(out.timings[0]).toMatchObject({ chooser: 'vision', pick: 'thin' });
    expect(text.calls).toHaveLength(0);
  });

  it('passes player lines to the next step', async () => {
    const vision = scripted('vision', [click, done]);
    const { env, ex } = makeEnv({ vision });
    const run = new ActRun(env, { settleMs: 0 });
    ex.actImpl = async () => {
      run.addPlayerLine('the other one');
      return { ms: 1 };
    };
    await run.run();
    expect(vision.calls[1]!.state.playerLines).toEqual(['the other one']);
  });
});

const richAx: AxNode[] = ['One', 'Two', 'Three', 'Four'].map((t, i) => ({
  depth: 1,
  parent: -1,
  role: 'AXButton',
  title: t,
  enabled: true,
  frame: { x: 100, y: 100 + i * 50, w: 80, h: 30 },
}));
