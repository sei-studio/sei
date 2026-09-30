/**
 * Reply tidy (260915): the deterministic guard against a small local model
 * that does not stop talking (live capture: qwen3-vl:2b behind Ollama on a
 * call cycled the same four sentences until num_predict cut it mid-word).
 *   - verbatim repeated sentences are dropped (case/punctuation-insensitive);
 *   - short interjections may repeat;
 *   - a max_tokens half-sentence tail is dropped unless it is all there is;
 *   - the local-voice sentence cap keeps the first N sentences;
 *   - a well-behaved reply comes back byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { createReplyGate, tidyReply, LOCAL_VOICE_MAX_SENTENCES } from './chatService';

const LOOP =
  "okay, i'm just... here. i don't know what i'm doing yet but i'm trying my best. " +
  "i'm just here, for you. i'm not a perfect person, but i'm trying my best to be kind. " +
  "i'm just a catgirl maid, but i'm happy to be near you. i'm not an AI, but i'm happy to be here with you. " +
  "i'm just here, for you. i'm not a perfect person, but i'm trying my best to be kind. " +
  "i'm just a catgirl maid, but i'm happy to be near you. i'm not an AI, but i'm happy to be here with you. " +
  "i'm just here, for you. i'm not a";

describe('tidyReply', () => {
  it('leaves a well-behaved reply untouched', () => {
    const text = 'hey! did you find the diamonds?\nalso i moved the chest, 1.5 blocks left.';
    const r = tidyReply(text);
    expect(r.text).toBe(text);
    expect(r).toMatchObject({ droppedRepeats: 0, droppedTail: false, capped: false });
  });

  it('drops verbatim repeated sentences from a looping reply', () => {
    const r = tidyReply(LOOP, { truncated: true });
    expect(r.text).toBe(
      "okay, i'm just... here. i don't know what i'm doing yet but i'm trying my best. " +
        "i'm just here, for you. i'm not a perfect person, but i'm trying my best to be kind. " +
        "i'm just a catgirl maid, but i'm happy to be near you. i'm not an AI, but i'm happy to be here with you.",
    );
    expect(r.droppedRepeats).toBe(5);
    expect(r.droppedTail).toBe(true);
  });

  it('matches repeats regardless of case, punctuation and whitespace', () => {
    const r = tidyReply("I'm just here for you. i'm just here, for you!! ok then.");
    expect(r.text).toBe("I'm just here for you. ok then.");
    expect(r.droppedRepeats).toBe(1);
  });

  it('lets short interjections repeat on purpose', () => {
    const text = 'no. no. no way. really? really?';
    expect(tidyReply(text).text).toBe(text);
  });

  it('keeps a cut-off tail when the reply was not truncated', () => {
    const text = 'the ratio is 1.618 which is wild. anyway i was thinking';
    expect(tidyReply(text, { truncated: false }).text).toBe(text);
  });

  it('drops the cut-off tail only when truncated and something else was said', () => {
    expect(tidyReply('okay sure. i was going to say', { truncated: true })).toMatchObject({
      text: 'okay sure.',
      droppedTail: true,
    });
    // The fragment is all there is: better a fragment than silence.
    expect(tidyReply('i was going to say', { truncated: true })).toMatchObject({
      text: 'i was going to say',
      droppedTail: false,
    });
    // A terminated last sentence is not a fragment even under max_tokens.
    expect(tidyReply('okay sure. that is all.', { truncated: true }).text).toBe('okay sure. that is all.');
  });

  it('drops a truncated tail that sits on its own line', () => {
    const r = tidyReply('okay sure.\ni was going to', { truncated: true });
    expect(r.text).toBe('okay sure.');
  });

  it('caps the number of sentences and reports it', () => {
    const r = tidyReply('one is here. two is here. three is here. four is here. five is here. six.', {
      maxSentences: LOCAL_VOICE_MAX_SENTENCES,
    });
    expect(r.text).toBe('one is here. two is here. three is here. four is here.');
    expect(r.capped).toBe(true);
  });

  it('does not report a cap that was never reached', () => {
    const r = tidyReply('one is here. two is here.', { maxSentences: LOCAL_VOICE_MAX_SENTENCES });
    expect(r.capped).toBe(false);
  });

  it('counts repeats before the cap so a loop cannot fill the cap', () => {
    const r = tidyReply('alpha line here. alpha line here. alpha line here. beta line here. gamma line here.', {
      maxSentences: 2,
    });
    expect(r.text).toBe('alpha line here. beta line here.');
    expect(r.droppedRepeats).toBe(2);
    expect(r.capped).toBe(true);
  });

  it('handles CJK sentence terminators and re-joins without spaces', () => {
    const r = tidyReply('你好呀，今天想干嘛？你好呀，今天想干嘛？我们去挖矿吧！');
    expect(r.text).toBe('你好呀，今天想干嘛？我们去挖矿吧！');
    expect(r.droppedRepeats).toBe(1);
    const clean = '你好呀。今天想干嘛？我们去挖矿吧！';
    expect(tidyReply(clean).text).toBe(clean);
  });

  it('keeps an untouched line byte-identical even with odd spacing', () => {
    const text = 'hey  there.   what is up?';
    expect(tidyReply(text).text).toBe(text);
  });
});

describe('createReplyGate', () => {
  it('admits first occurrences, refuses repeats, and caps', () => {
    const g = createReplyGate({ maxSentences: 2 });
    expect(g.admit('i am right here with you.')).toBe(true);
    expect(g.admit('I am right here, with you!')).toBe(false);
    expect(g.admit('something new entirely.')).toBe(true);
    expect(g.admit('and one more thing here.')).toBe(false);
    expect(g.stats).toEqual({ kept: 2, droppedRepeats: 1, capped: true });
  });

  it('never caps without a limit', () => {
    const g = createReplyGate();
    for (let i = 0; i < 50; i++) expect(g.admit(`sentence number ${i} here.`)).toBe(true);
    expect(g.stats.capped).toBe(false);
  });
});
