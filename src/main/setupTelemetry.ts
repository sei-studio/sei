/**
 * Main-process side of the `game_setup_step` event (261104). The shape and
 * its rules live in src/shared/setupTelemetry.ts; this file only sends it,
 * through the shared lazy analytics import (CLAUDE.md, "Instrumenting a game
 * or timed surface"), so install modules and their tests never depend on
 * analytics being initialized. capture() is a no-op when opted out, keyless,
 * or on a dev build.
 */
import type { WizardProgressEvent } from '../shared/ipc';
import {
  GAME_SETUP_EVENT,
  classifyFailReason,
  setupStepProps,
  type McSetupStep,
  type SetupStepInput,
} from '../shared/setupTelemetry';
import { loadAnalytics } from './lazyAnalytics';

export type SetupSink = (input: SetupStepInput) => void;

/** Fire-and-forget; never throws, never awaits. */
export const trackSetupStep: SetupSink = (input) => {
  let props: Record<string, string | number | boolean>;
  try {
    props = setupStepProps(input);
  } catch {
    return;
  }
  void loadAnalytics()
    .then((a) => a.capture(GAME_SETUP_EVENT, props))
    .catch(() => {
      /* analytics is never load-bearing */
    });
};

/**
 * Sends a step only when its signature changed since the last send in this
 * process. The setup panels poll their scans (Minecraft every 10 s, Stardew
 * on every Check again), and one result per distinct answer is the useful
 * number, not one per poll.
 */
export function createDedupedSink(sink: SetupSink = trackSetupStep): (key: string, signature: string, input: SetupStepInput) => void {
  const last = new Map<string, string>();
  return (key, signature, input) => {
    if (last.get(key) === signature) return;
    last.set(key, signature);
    sink(input);
  };
}

/** Wizard progress stage -> the telemetry step it belongs to. */
function stepForStage(stage: WizardProgressEvent['stage']): McSetupStep | null {
  switch (stage) {
    case 'fabric-downloading':
    case 'fabric-installing':
      return 'fabric';
    case 'mods-linking':
      return 'mods_link';
    case 'mod-downloading':
    case 'mod-placing':
      return 'skin_mod';
    case 'config-writing':
      return 'config';
    default:
      return null;
  }
}

/**
 * Wraps the wizard's progress callback: every event passes through
 * unchanged, and the stage stream is folded into `game_setup_step` events,
 * one start + ok|fail per wizard stage and one for the whole run, per
 * install. `kindOf` names the launcher (vanilla / curseforge / lunar).
 */
export function observeWizardProgress(
  onProgress: (ev: WizardProgressEvent) => void,
  kindOf: (installId: string) => string | undefined,
  sink: SetupSink = trackSetupStep,
  now: () => number = Date.now,
): (ev: WizardProgressEvent) => void {
  const current = new Map<string, McSetupStep | null>();
  const startedAt = new Map<string, number>();
  const send = (installId: string, input: Omit<SetupStepInput, 'game' | 'store'>): void => {
    try {
      sink({ game: 'minecraft', store: kindOf(installId) ?? 'unknown', ...input });
    } catch {
      /* never disturb the wizard */
    }
  };
  return (ev) => {
    try {
      const id = ev.installId;
      if (ev.stage === 'queued') {
        if (!startedAt.has(id)) {
          startedAt.set(id, now());
          current.set(id, null);
          send(id, { step: 'wizard', outcome: 'start' });
        }
      } else if (ev.stage === 'done' || ev.stage === 'failed' || ev.stage === 'cancelled') {
        const step = current.get(id) ?? null;
        const began = startedAt.get(id);
        const wait_ms = began != null ? now() - began : null;
        if (ev.stage === 'done') {
          if (step) send(id, { step, outcome: 'ok' });
          send(id, { step: 'wizard', outcome: 'ok', wait_ms });
        } else {
          const error_code = ev.stage === 'failed' ? ev.error : 'CANCELLED';
          const reason = ev.stage === 'failed' ? classifyFailReason(ev.message) : 'cancelled';
          if (step) send(id, { step, outcome: 'fail', error_code, reason });
          send(id, { step: 'wizard', outcome: 'fail', error_code, reason, wait_ms });
        }
        current.delete(id);
        startedAt.delete(id);
      } else {
        const next = stepForStage(ev.stage);
        const prev = current.get(id) ?? null;
        if (next && next !== prev) {
          if (!startedAt.has(id)) {
            startedAt.set(id, now());
            send(id, { step: 'wizard', outcome: 'start' });
          }
          if (prev) send(id, { step: prev, outcome: 'ok' });
          send(id, { step: next, outcome: 'start' });
          current.set(id, next);
        }
      }
    } catch {
      /* telemetry must never break the progress stream */
    }
    onProgress(ev);
  };
}
