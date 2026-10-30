/**
 * Face cues land when their line does (261028, facepack pilot).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  (globalThis as unknown as { window: unknown }).window = { sei: { onChatMessage: () => () => {} } };
});
afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  const face = await import('./useFaceStore');
  const { useVoiceStore } = await import('./useVoiceStore');
  face.__resetFaceCues();
  return { ...face, useVoiceStore };
}

const cue = (o: Partial<import('@shared/facepack').FaceCue>) => ({
  characterId: 'sui',
  expression: 'happy',
  at: 'start' as const,
  text: 'oh hey what are you up to',
  ...o,
});

describe('cueTextMatches', () => {
  it('matches containment either way, ignoring case and punctuation', async () => {
    const { cueTextMatches } = await load();
    expect(cueTextMatches('Oh hey, what are you up to?', 'oh hey what are you up to')).toBe(true);
    expect(cueTextMatches('oh hey. what are you up to', 'oh hey')).toBe(true);
    expect(cueTextMatches('hi', 'oh hey what are you up to, hi')).toBe(true);
    expect(cueTextMatches('totally different line here', 'oh hey what are you up to')).toBe(false);
    expect(cueTextMatches('', 'x')).toBe(false);
  });
});

describe('handleFaceCue', () => {
  it('off a call, a start cue applies at once and an end cue a moment later', async () => {
    const { handleFaceCue, useFaceStore, END_CUE_DELAY_MS } = await load();
    handleFaceCue(cue({}));
    expect(useFaceStore.getState().faces.sui).toEqual({ expression: 'happy', seq: 1 });
    handleFaceCue(cue({ expression: 'smug', at: 'end' }));
    expect(useFaceStore.getState().faces.sui.expression).toBe('happy');
    vi.advanceTimersByTime(END_CUE_DELAY_MS);
    expect(useFaceStore.getState().faces.sui).toEqual({ expression: 'smug', seq: 2 });
  });

  it('on a call, a cue waits for its line to become audible', async () => {
    const { handleFaceCue, onVoiceChange, useFaceStore, useVoiceStore } = await load();
    useVoiceStore.setState({ status: 'live', participants: ['sui'] } as never);
    handleFaceCue(cue({}), 0);
    expect(useFaceStore.getState().faces.sui).toBeUndefined();
    const prev = { speakingId: null, lastSpoken: '', lastSpokenId: null };
    // A different line plays first: nothing applies.
    onVoiceChange({ speakingId: 'sui', lastSpoken: 'unrelated earlier sentence', lastSpokenId: 'sui' }, prev, 10);
    expect(useFaceStore.getState().faces.sui).toBeUndefined();
    onVoiceChange(
      { speakingId: 'sui', lastSpoken: 'Oh hey, what are you up to?', lastSpokenId: 'sui' },
      { speakingId: 'sui', lastSpoken: 'unrelated earlier sentence', lastSpokenId: 'sui' },
      20,
    );
    expect(useFaceStore.getState().faces.sui?.expression).toBe('happy');
  });

  it('on a call, an end cue fires when the line stops', async () => {
    const { handleFaceCue, onVoiceChange, useFaceStore, useVoiceStore } = await load();
    useVoiceStore.setState({ status: 'live', participants: ['sui'] } as never);
    handleFaceCue(cue({ expression: 'pout', at: 'end', text: 'fine whatever' }), 0);
    const playing = { speakingId: 'sui', lastSpoken: 'fine whatever', lastSpokenId: 'sui' };
    onVoiceChange(playing, { speakingId: null, lastSpoken: '', lastSpokenId: null }, 5);
    expect(useFaceStore.getState().faces.sui).toBeUndefined();
    onVoiceChange({ ...playing, speakingId: null }, playing, 900);
    expect(useFaceStore.getState().faces.sui?.expression).toBe('pout');
  });

  it('a text-less cue applies now when the companion is already speaking', async () => {
    const { handleFaceCue, useFaceStore, useVoiceStore } = await load();
    useVoiceStore.setState({ status: 'live', participants: ['sui'], speakingId: 'sui' } as never);
    handleFaceCue(cue({ text: null, expression: 'excited' }), 0);
    expect(useFaceStore.getState().faces.sui?.expression).toBe('excited');
  });

  it('a cue for someone not on the call applies at once', async () => {
    const { handleFaceCue, useFaceStore, useVoiceStore } = await load();
    useVoiceStore.setState({ status: 'live', participants: ['lyra'] } as never);
    handleFaceCue(cue({}), 0);
    expect(useFaceStore.getState().faces.sui?.expression).toBe('happy');
  });
});
