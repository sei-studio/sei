/**
 * Per-call "was the player heard" bookkeeping (261118): the accepted-utterance
 * count, the STT pass count, whether the mic ever reached the speech floor and
 * the STT path, each sliced per companion like the interrupt counts.
 */
import { describe, expect, it } from 'vitest';
import { createCallHearing } from './callHearing';

const stats = (heardFrames: number, sttRequests: number) => ({ heardFrames, sttRequests });

describe('createCallHearing', () => {
  it('player_utterances counts the turns the call accepted', () => {
    const h = createCallHearing();
    h.reset();
    h.setPath('cloud');
    h.join('sui', stats(0, 0));
    h.noteUtterance();
    h.noteUtterance();
    expect(h.take('sui', stats(40, 2))?.player_utterances).toBe(2);
  });

  it('stt_requests is the passes made while the companion was on the call', () => {
    const h = createCallHearing();
    h.reset();
    h.setPath('local');
    h.join('sui', stats(0, 0));
    h.join('lyra', stats(10, 3)); // joined later
    expect(h.take('sui', stats(20, 7))?.stt_requests).toBe(7);
    expect(h.take('lyra', stats(20, 7))?.stt_requests).toBe(4);
  });

  it('input_peak_heard is false when the mic never reached the speech floor', () => {
    const h = createCallHearing();
    h.reset();
    h.setPath('cloud');
    h.join('sui', stats(0, 0));
    expect(h.take('sui', stats(0, 0))).toEqual({
      player_utterances: 0,
      stt_requests: 0,
      input_peak_heard: false,
      stt_path: 'cloud',
    });
    h.join('lyra', stats(5, 1));
    expect(h.take('lyra', stats(6, 1))?.input_peak_heard).toBe(true);
  });

  it('stt_path follows a mid-call change (BYOK with no ElevenLabs key runs local only)', () => {
    const h = createCallHearing();
    h.reset();
    h.setPath('byok');
    h.join('sui', null);
    h.setPath('local');
    expect(h.take('sui', stats(1, 1))?.stt_path).toBe('local');
  });

  it('no report before the STT path is known, and reset starts a fresh call', () => {
    const h = createCallHearing();
    h.reset();
    h.join('sui', null);
    expect(h.take('sui', null)).toBeNull();
    h.setPath('cloud');
    h.noteUtterance();
    h.reset();
    h.setPath('cloud');
    h.join('sui', null);
    expect(h.take('sui', null)?.player_utterances).toBe(0);
  });

  it('a companion with no join (or no dictation at hang-up) reports from zero, never negative', () => {
    const h = createCallHearing();
    h.reset();
    h.setPath('cloud');
    h.noteUtterance();
    expect(h.take('never-joined', stats(3, 2))).toEqual({
      player_utterances: 1,
      stt_requests: 2,
      input_peak_heard: true,
      stt_path: 'cloud',
    });
    h.join('sui', stats(3, 2));
    expect(h.take('sui', null)).toMatchObject({ stt_requests: 0, input_peak_heard: false });
  });
});
