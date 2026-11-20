/**
 * The app's WorldLink progress source (261106 v6): the status lines follow
 * her Anima face set (main/anima/animaClient.ts, its `stage` on every
 * AnimaStatus) and the desktop host's start.
 *
 *   requesting                  -> sent
 *   queued                      -> sent, answered
 *   running                     -> ... running
 *   downloading                 -> ... baked
 *   ready / unavailable         -> every pipeline milestone (unavailable: no
 *                                  pack will come, her fallback avatar is her
 *                                  look, so the link still works)
 *   offline                     -> failed (offline)
 *   failed                      -> failed (its failure class)
 *   the host start answered ok  -> host; answered not ok -> failed (host)
 *
 * It asks main to prepare her face set (a no-op while a bake already runs,
 * a retry after one failed) and reads the answer as the first status. No
 * bridge, or a main without stages (an older build), counts as unavailable:
 * the lines just play at the minimum dwell. The window going offline for
 * OFFLINE_FAIL_MS also fails it.
 */
import type { AnimaFailure, AnimaStage, AnimaStatus } from '@shared/anima';
import type { LinkAnimaStart, LinkFailure, LinkMilestone } from '@shared/seilinkIntroTelemetry';
import { sei } from '../ipcClient';
import type { LinkEvent, LinkSource } from './worldLink';

/** Offline this long (the window's view) during the link: it failed. */
export const OFFLINE_FAIL_MS = 5000;

const ORDER: readonly LinkMilestone[] = ['sent', 'answered', 'running', 'baked', 'installed'];

/** The pipeline milestones a stage means have arrived. */
export function stageMilestones(stage: AnimaStage | undefined): readonly LinkMilestone[] {
  switch (stage) {
    case 'requesting':
      return ORDER.slice(0, 1);
    case 'queued':
      return ORDER.slice(0, 2);
    case 'running':
      return ORDER.slice(0, 3);
    case 'downloading':
      return ORDER.slice(0, 4);
    case 'ready':
    case 'unavailable':
    case undefined:
      return ORDER;
    default:
      return [];
  }
}

/** A stage that ends the link badly, as its failure class (null: it does not). */
export function stageFailure(stage: AnimaStage | undefined, failure: AnimaFailure | undefined): LinkFailure | null {
  if (stage === 'offline') return 'offline';
  if (stage === 'failed') return failure ?? 'error';
  return null;
}

/** Map an Anima status to link events. */
export function statusEvents(s: Pick<AnimaStatus, 'stage' | 'failure'>): LinkEvent[] {
  const f = stageFailure(s.stage, s.failure);
  if (f) return [{ kind: 'failed', failure: f }];
  return stageMilestones(s.stage).map((milestone) => ({ kind: 'milestone', milestone }));
}

export function animaLinkSource(characterId: string, hostOutcome: Promise<boolean>): LinkSource {
  let start: LinkAnimaStart = 'none';
  let started = false;
  return {
    startStage: () => start,
    subscribe(emit) {
      let dead = false;
      let offTimer = 0;
      const push = (s: AnimaStatus | null | undefined, first: boolean): void => {
        if (dead) return;
        if (!s || s.characterId !== characterId) {
          if (first) statusEvents({ stage: undefined }).forEach(emit);
          return;
        }
        // 'checking' says nothing yet (the answer to prepare or the next push will).
        if (s.stage === 'checking') return;
        if (first && !started) {
          started = true;
          start = s.stage ?? 'none';
        }
        statusEvents(s).forEach(emit);
      };

      let off: (() => void) | undefined;
      try {
        off = sei.onSeilinkAnima?.((s) => push(s, false));
      } catch {
        off = undefined;
      }
      if (!sei.seilinkAnimaPrepare) push(null, true);
      else {
        void Promise.resolve(sei.seilinkAnimaPrepare(characterId, 'host_start')).then(
          (s) => push(s, true),
          () => !dead && emit({ kind: 'failed', failure: 'error' }),
        );
      }

      void hostOutcome.then(
        (ok) => !dead && emit(ok ? { kind: 'milestone', milestone: 'host' } : { kind: 'failed', failure: 'host' }),
        () => !dead && emit({ kind: 'failed', failure: 'host' }),
      );

      const onOffline = (): void => {
        window.clearTimeout(offTimer);
        offTimer = window.setTimeout(() => {
          if (!dead && navigator.onLine === false) emit({ kind: 'failed', failure: 'offline' });
        }, OFFLINE_FAIL_MS);
      };
      const onOnline = (): void => window.clearTimeout(offTimer);
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
      if (navigator.onLine === false) onOffline();

      return () => {
        dead = true;
        off?.();
        window.clearTimeout(offTimer);
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('online', onOnline);
      };
    },
  };
}
