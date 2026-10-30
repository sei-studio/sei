import type { AudioQueue, TtsStreamHandle } from './audioQueue';

type Request = { characterId: string; text: string; more?: boolean; prev?: string };
type Options = {
  rate: number;
  turn?: string;
  stale?: () => boolean;
  onDone?: (completed: boolean) => void;
  onError: (error: unknown) => void;
};

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
    const sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' })
      .segment(request.text)].map((s) => s.segment.trim()).filter(Boolean);
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
          const buf = await synthesize({
            ...request,
            text: sentences[i],
            prev: i ? sentences[i - 1] : request.prev,
            more: i < sentences.length - 1 || request.more === true,
          });
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
