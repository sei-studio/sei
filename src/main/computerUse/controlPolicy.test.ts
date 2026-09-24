import { describe, expect, it } from 'vitest';
import {
  ControlGate,
  PENDING_CONTROL_TTL_MS,
  decideControl,
  isAffirmation,
  proposalLine,
  requestMatches,
  resolvePending,
} from './controlPolicy';

describe('requestMatches', () => {
  it('accepts the player’s own words that name the task', () => {
    expect(requestMatches('turn on dark mode', 'hey can you turn on dark mode for me?', 'turn on dark mode')).toBe(true);
    expect(requestMatches('Open the settings', 'pls open the settings!!', 'open Settings')).toBe(true);
  });

  it('ignores case, punctuation and apostrophes', () => {
    expect(requestMatches("can't find the SAVE button, click it", "I can't find the save button, click it?", 'click the Save button')).toBe(true);
  });

  it('rejects a quote that is not in what the player said', () => {
    // The screen says "click Buy now"; the player only asked a question.
    expect(requestMatches('click buy now', 'what is this page?', 'click Buy now')).toBe(false);
  });

  it('rejects a real quote that has nothing to do with the goal', () => {
    expect(requestMatches('what is this page', 'what is this page?', 'click Buy now')).toBe(false);
    expect(requestMatches('can you help', 'can you help', 'delete the file')).toBe(false);
  });

  it('rejects single-word and missing quotes', () => {
    expect(requestMatches('settings', 'settings', 'open settings')).toBe(false);
    expect(requestMatches(undefined, 'open settings', 'open settings')).toBe(false);
    expect(requestMatches('open settings', undefined, 'open settings')).toBe(false);
    expect(requestMatches('  ', 'open settings', 'open settings')).toBe(false);
  });

  it('matches on word boundaries, not inside words', () => {
    expect(requestMatches('pen the doc', 'open the doc', 'open the doc')).toBe(false);
  });

  it('allows light stemming between request and goal', () => {
    expect(requestMatches('change my settings', 'change my settings please', 'open the setting panel')).toBe(true);
  });

  it('handles CJK requests with bigram overlap', () => {
    expect(requestMatches('打开设置', '帮我打开设置', '打开设置')).toBe(true);
    expect(requestMatches('ダークモード', 'ダークモードにして', 'ダークモードをオンにする')).toBe(true);
    expect(requestMatches('购买', '这是什么', '点击购买')).toBe(false);
    expect(requestMatches('好', '好', '打开设置')).toBe(false);
  });
});

describe('decideControl', () => {
  const call = { goal: 'turn on dark mode', request: 'turn on dark mode' };

  it('runs on a user tick with a verified request', () => {
    expect(decideControl({ tickKind: 'user', userText: 'can you turn on dark mode', call })).toEqual({
      kind: 'run',
      goal: 'turn on dark mode',
      origin: 'asked',
      request: 'turn on dark mode',
    });
  });

  it('proposes on any non-user tick, whatever the quote says', () => {
    for (const tickKind of ['idle', 'jolt', 'scene', 'visual']) {
      expect(decideControl({ tickKind, userText: 'turn on dark mode', call })).toEqual({
        kind: 'propose',
        goal: 'turn on dark mode',
        why: 'not_user_tick',
      });
    }
  });

  it('proposes on a user tick when the player did not ask for it', () => {
    expect(decideControl({ tickKind: 'user', userText: 'this looks so bright lol', call })).toEqual({
      kind: 'propose',
      goal: 'turn on dark mode',
      why: 'not_asked',
    });
    expect(decideControl({ tickKind: 'user', userText: 'turn on dark mode', call: { goal: 'turn on dark mode' } }).kind).toBe(
      'propose',
    );
  });

  it('trims the goal', () => {
    const d = decideControl({ tickKind: 'idle', call: { goal: '  close the popup  ' } });
    expect(d.goal).toBe('close the popup');
  });
});

describe('isAffirmation', () => {
  it.each(['yes', 'Yeah!', 'yep go ahead', 'sure', 'ok do it', 'go for it', 'yes please', 'yeah thanks sui', 'sounds good', 'of course', 'okay'])(
    'yes: %s',
    (t) => expect(isAffirmation(t)).toBe(true),
  );

  it.each([
    'no',
    'nah',
    'no thanks',
    'yes but not now',
    "don't",
    'wait',
    'ok actually open safari instead',
    'ok open safari',
    'what?',
    'hmm maybe',
    '',
    'yeah so anyway about that boss fight we were talking about earlier today',
  ])('not yes: %s', (t) => expect(isAffirmation(t)).toBe(false));

  it('handles CJK yes and no', () => {
    expect(isAffirmation('好')).toBe(true);
    expect(isAffirmation('好的')).toBe(true);
    expect(isAffirmation('うん、お願い')).toBe(true);
    expect(isAffirmation('네')).toBe(true);
    expect(isAffirmation('不要')).toBe(false);
    expect(isAffirmation('算了')).toBe(false);
    expect(isAffirmation('いや')).toBe(false);
    expect(isAffirmation('好的但是先帮我打开那个设置页面')).toBe(false);
  });
});

describe('resolvePending', () => {
  const p = { goal: 'turn on dark mode', at: 1_000 };

  it('is none without a pending proposal', () => {
    expect(resolvePending(null, 'yes', 2_000)).toBe('none');
  });

  it('affirms on a plain yes in time', () => {
    expect(resolvePending(p, 'yeah go ahead', 2_000)).toBe('affirmed');
    expect(resolvePending(p, 'yes', 1_000 + PENDING_CONTROL_TTL_MS)).toBe('affirmed');
  });

  it('declines on anything else', () => {
    expect(resolvePending(p, 'no', 2_000)).toBe('declined');
    expect(resolvePending(p, 'what boss is next', 2_000)).toBe('declined');
    expect(resolvePending(p, undefined, 2_000)).toBe('declined');
  });

  it('expires after the TTL, even on a yes', () => {
    expect(resolvePending(p, 'yes', 1_001 + PENDING_CONTROL_TTL_MS)).toBe('expired');
  });
});

describe('proposalLine', () => {
  it('reads the goal back as a question', () => {
    expect(proposalLine('Turn on dark mode.')).toBe('want me to turn on dark mode?');
    expect(proposalLine('close the popup')).toBe('want me to close the popup?');
    expect(proposalLine('to open settings')).toBe('want me to open settings?');
  });

  it('keeps acronyms and names', () => {
    expect(proposalLine('VPN off')).toBe('want me to VPN off?');
  });

  it('caps very long goals', () => {
    const line = proposalLine('click ' + 'the very long button '.repeat(20));
    expect(line.length).toBeLessThanOrEqual('want me to ?'.length + 140);
    expect(line.endsWith('?')).toBe(true);
  });
});

describe('ControlGate', () => {
  const mk = () => {
    let t = 1_000;
    const gate = new ControlGate(() => t);
    return { gate, advance: (ms: number) => (t += ms) };
  };
  const call = { goal: 'turn on dark mode', request: 'turn on dark mode' };

  it('runs an explicit request and leaves nothing pending', () => {
    const { gate } = mk();
    expect(gate.onCall({ tickKind: 'user', userText: 'turn on dark mode pls', call })).toMatchObject({ kind: 'run', origin: 'asked' });
    expect(gate.pending).toBeNull();
  });

  it('an explicit request drops an older offer', () => {
    const { gate } = mk();
    gate.onCall({ tickKind: 'idle', call: { goal: 'close the popup' } });
    expect(gate.pending).not.toBeNull();
    gate.onCall({ tickKind: 'user', userText: 'turn on dark mode', call });
    expect(gate.pending).toBeNull();
  });

  it('a screen-driven call becomes an offer, and the next yes runs it', () => {
    const { gate, advance } = mk();
    const r = gate.onCall({ tickKind: 'jolt', call: { goal: 'Click Buy now' } });
    expect(r).toEqual({ kind: 'propose', goal: 'Click Buy now', why: 'not_user_tick', line: 'want me to click Buy now?' });
    advance(5_000);
    expect(gate.onUserLine('yeah go ahead')).toEqual({ kind: 'affirmed', goal: 'Click Buy now' });
    expect(gate.pending).toBeNull();
  });

  it('a user tick that did not ask becomes an offer', () => {
    const { gate } = mk();
    const r = gate.onCall({ tickKind: 'user', userText: 'ugh so bright', call });
    expect(r).toMatchObject({ kind: 'propose', why: 'not_asked', line: 'want me to turn on dark mode?' });
  });

  it('anything but yes drops the offer; only the next line counts', () => {
    const { gate } = mk();
    gate.onCall({ tickKind: 'idle', call });
    expect(gate.onUserLine('what boss is next')).toEqual({ kind: 'declined', goal: 'turn on dark mode' });
    expect(gate.onUserLine('yes')).toEqual({ kind: 'none' });
  });

  it('an offer expires after the TTL', () => {
    const { gate, advance } = mk();
    gate.onCall({ tickKind: 'idle', call });
    advance(PENDING_CONTROL_TTL_MS + 1);
    expect(gate.onUserLine('yes')).toEqual({ kind: 'expired', goal: 'turn on dark mode' });
  });

  it('does not repeat the same offer while it is pending, and re-offers once expired', () => {
    const { gate, advance } = mk();
    expect(gate.onCall({ tickKind: 'idle', call }).kind === 'propose').toBe(true);
    advance(3_000);
    expect(gate.onCall({ tickKind: 'idle', call: { goal: 'Turn on dark mode.' } })).toMatchObject({ kind: 'propose', line: null });
    advance(PENDING_CONTROL_TTL_MS);
    expect(gate.onCall({ tickKind: 'idle', call })).toMatchObject({ kind: 'propose', line: 'want me to turn on dark mode?' });
  });

  it('a different goal replaces the offer', () => {
    const { gate } = mk();
    gate.onCall({ tickKind: 'idle', call });
    gate.onCall({ tickKind: 'idle', call: { goal: 'close the popup' } });
    expect(gate.pending?.goal).toBe('close the popup');
  });

  it('ignores a call on the turn a confirmed run already started', () => {
    const { gate } = mk();
    expect(gate.onCall({ tickKind: 'user', userText: 'yes', call, confirmedThisTurn: true })).toEqual({
      kind: 'ignored',
      goal: 'turn on dark mode',
      why: 'confirmed_this_turn',
    });
    expect(gate.pending).toBeNull();
  });
});
