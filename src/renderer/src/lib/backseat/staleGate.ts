/**
 * 261010 backseat staleness gate, renderer side. A line the companion said on
 * her own carries the capture time of the frame it was written from
 * (SpokenLineContext.ambientCapturedAt). Asked when the line arrives and again
 * as its clip reaches the playhead, this drops it when it is both old and the
 * screen has moved on (staleLineVerdict). It never looks at the words, and a
 * reply to the player never carries the field, so it is never asked about one.
 * Every drop is logged.
 */
import { staleLineVerdict } from '../../../../shared/backseatIpc';

export function createStaleGate(
  text: string,
  capturedAt: number,
  deps: {
    sceneChangeSince: (at: number) => number | null;
    now?: () => number;
    log?: (line: string) => void;
  },
): (when: 'arrival' | 'playhead') => boolean {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  return (when) => {
    const age = now() - capturedAt;
    const delta = deps.sceneChangeSince(capturedAt);
    if (!staleLineVerdict(age, delta)) return false;
    log(
      `[backseat] stale line dropped at ${when}: ${(age / 1000).toFixed(1)}s after its frame, ` +
        `scene change ${delta === null ? 'unknown' : delta.toFixed(2)}: "${text.slice(0, 60)}"`,
    );
    return true;
  };
}
