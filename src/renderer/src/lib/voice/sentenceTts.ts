import type { AudioQueue, TtsStreamHandle } from './audioQueue';

export type SentenceRequest = { characterId: string; text: string; more?: boolean; prev?: string };
type Request = SentenceRequest;
type Options = {
  rate: number;
  turn?: string;
  stale?: () => boolean;
  onDone?: (completed: boolean) => void;
  onError: (error: unknown) => void;
  /** 261128 (T571): the first sentence's clip, already requested (a call's
   * opener synthesizes during the pickup beat). Used instead of synthesizing
   * sentence one; it must be the clip for `sentenceRequests(request)[0]`. */
  first?: Promise<ArrayBuffer>;
};

/** The per-sentence synthesis requests a line is spoken as, in order: each
 * sentence carries the one before it as `prev`, and every one but the last
 * says `more` (the last keeps the line's own). */
export function sentenceRequests(request: Request): Request[] {
  const sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' })
    .segment(request.text)].map((s) => s.segment.trim()).filter(Boolean);
  return sentences.map((text, i) => ({
    ...request,
    text,
    prev: i ? sentences[i - 1] : request.prev,
    more: i < sentences.length - 1 || request.more === true,
  }));
}

/** Full WAV per sentence, never concatenated WAVs in an MPEG stream. Reserve
 * every slot before async work so later lines cannot overtake this one. */
export function createSentenceTts(
  queue: Pick<AudioQueue, 'enqueueStream'>,
  synthesize: (request: Request) => Promise<ArrayBuffer>,
  isCurrent: () => boolean,
) {
  // One native inference at a time per call, including across companion lines.
  let tail = Promise.resolve();
  return (request: Request, options: Options): Promise<void> => {
    const requests = sentenceRequests(request);
    const sentences = requests.map((r) => r.text);
    const slots: TtsStreamHandle[] = [];
    let cancelled = false;
    let remaining = sentences.length;
    let notified = false;
    const notify = (completed: boolean) => {
      if (notified) return;
      notified = true;
      options.onDone?.(completed);
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      notify(false);
      // Queue clear/supersession can call onDone while walking its slots.
      // Drain the remaining reservations outside that walk.
      queueMicrotask(() => slots.forEach((slot) => slot.fail()));
    };
    for (const text of sentences) {
      if (cancelled) break;
      slots.push(queue.enqueueStream(request.characterId, text, options.rate, {
        blob: true,
        turn: options.turn,
        stale: options.stale,
        onDone: (completed) => {
          if (!completed) cancel();
          else if (--remaining === 0) notify(true);
        },
      }));
    }
    if (!sentences.length) notify(false);
    const run = async () => {
      try {
        for (let i = 0; i < slots.length; i++) {
          if (cancelled || !isCurrent()) { cancel(); break; }
          const buf = await (i === 0 && options.first ? options.first : synthesize(requests[i]));
          // Native inference cannot be preempted; discard a late completion
          // and never start the next sentence after an interrupt or hang-up.
          if (cancelled || !isCurrent()) { cancel(); break; }
          slots[i].push(buf);
          slots[i].end();
        }
      } catch (error) {
        if (!cancelled && isCurrent()) options.onError(error);
        cancel();
      }
    };
    tail = tail.then(run);
    return tail;
  };
}
