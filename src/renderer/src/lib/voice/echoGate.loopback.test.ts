/**
 * Windows loopback share (261030): the screen reference records the whole
 * system mix, so her own TTS is in the screen transcript. stripOwnWords takes
 * her words back out before the screen overlap is judged.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyScreenEcho,
  finalScreenEcho,
  normalizeTokens,
  SELF_ECHO_OVERLAP,
  stripOwnWords,
  textOverlap,
} from './echoGate';

const HER_LINE = 'is the castle open';
const GAME_LINE = 'no one may pass the door';
// What the loopback ring transcribed: her line and the game's dialogue.
const LOOPBACK = `${HER_LINE} ${GAME_LINE}`;
// The player talking back over her with words from both.
const PLAYER = 'no the castle door';

const noCorr = { r: 0, lagMs: 0, valid: false, refActive: 1 };

function screenVerdict(mic: string, screen: string): boolean {
  const overlap = textOverlap(mic, screen);
  const micTokens = normalizeTokens(mic).length;
  const first = classifyScreenEcho({ corr: noCorr, overlap, micTokens, minTokens: 2, refHasText: true });
  if (first !== 'ambiguous') return first === 'echo';
  return finalScreenEcho({ corr: noCorr, overlap, micTokens, refHasText: true });
}

describe('stripOwnWords', () => {
  it('removes every token of her lines and keeps the rest in order', () => {
    expect(stripOwnWords(LOOPBACK, [HER_LINE])).toBe('no one may pass door');
  });

  it('is the identity with no lines of hers, or an empty reference', () => {
    expect(stripOwnWords(LOOPBACK, [])).toBe(LOOPBACK);
    expect(stripOwnWords('', [HER_LINE])).toBe('');
    expect(stripOwnWords(LOOPBACK, ['(music)'])).toBe(LOOPBACK);
  });

  it('matches case and punctuation like the overlap does', () => {
    expect(stripOwnWords('Is THE castle, open? Run!', ['is the castle open'])).toBe('run');
  });
});

describe('loopback share: her voice in the screen reference', () => {
  it('the player is not her echo by the self check', () => {
    expect(textOverlap(PLAYER, HER_LINE)).toBeLessThan(SELF_ECHO_OVERLAP);
  });

  it('before stripping, her words in the loopback condemned the player', () => {
    expect(screenVerdict(PLAYER, LOOPBACK)).toBe(true);
  });

  it('after stripping, the player keeps their words', () => {
    expect(screenVerdict(PLAYER, stripOwnWords(LOOPBACK, [HER_LINE]))).toBe(false);
  });

  it('real game dialogue at the mic is still condemned', () => {
    expect(screenVerdict(GAME_LINE, stripOwnWords(LOOPBACK, [HER_LINE]))).toBe(true);
  });
});
