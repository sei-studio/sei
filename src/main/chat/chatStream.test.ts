/**
 * Voice-streaming helpers (260706) — the pure pieces of the streamed voice turn:
 *   - takeSentences: incremental sentence extraction that must NOT split inside a
 *     decimal ("1.618") but MUST flush on real sentence boundaries, so TTS can
 *     speak sentence 1 while the model still writes sentence 2.
 *   - markLastMessageCached: the transcript cache breakpoint (string → text-block
 *     array with cache_control), so the growing call transcript is a cache hit.
 */
import { describe, it, expect } from 'vitest';
import { takeSentences } from './chatService';
import { markLastMessageCached } from './chatPrompts';

describe('takeSentences', () => {
  it('flushes complete sentences and buffers the trailing partial', () => {
    const r = takeSentences('hey there. what is up? i was thinking');
    expect(r.sentences).toEqual(['hey there.', 'what is up?']);
    expect(r.rest).toBe('i was thinking');
  });

  it('never splits inside a decimal number', () => {
    const r = takeSentences('the ratio is 1.618 which is wild. see');
    expect(r.sentences).toEqual(['the ratio is 1.618 which is wild.']);
    expect(r.rest).toBe('see');
  });

  it('keeps ellipses and multi-mark endings intact as one boundary', () => {
    const r = takeSentences('wait... really?! ok');
    expect(r.sentences).toEqual(['wait...', 'really?!']);
    expect(r.rest).toBe('ok');
  });

  it('returns no sentences when nothing is terminated yet', () => {
    const r = takeSentences('still going with no end');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('still going with no end');
  });
});

describe('markLastMessageCached', () => {
  it('converts a trailing string message into a cached text block', () => {
    const msgs = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'latest' },
    ];
    markLastMessageCached(msgs);
    expect(msgs[2].content).toEqual([
      { type: 'text', text: 'latest', cache_control: { type: 'ephemeral' } },
    ]);
    // Earlier messages are untouched (their cache breakpoint is implicit prefix).
    expect(msgs[0].content).toBe('first');
  });

  it('is a no-op on an empty messages array', () => {
    const msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    expect(() => markLastMessageCached(msgs)).not.toThrow();
  });
});
