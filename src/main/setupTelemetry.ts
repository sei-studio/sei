/**
 * Main-process side of the `game_setup_step` event (261104). The shape and
 * its rules live in src/shared/setupTelemetry.ts; this file only sends it,
 * through the shared lazy analytics import (CLAUDE.md, "Instrumenting a game
 * or timed surface"), so install modules and their tests never depend on
 * analytics being initialized. capture() is a no-op when opted out, keyless,
 * or on a dev build.
 */
import type { McInstall, McScanExtras, StartMinecraftResult, WizardProgressEvent } from '../shared/ipc';
import {
  GAME_SETUP_EVENT,
  classifyFailReason,
  mcScanFound,
  setupStepProps,
  type McSetupStep,
  type SetupStepInput,
} from '../shared/setupTelemetry';
import type { StardewInstallState } from '../shared/stardewIpc';
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

const dedupedScan = createDedupedSink();

/**
 * The Minecraft install scan's answer (wizard:detect-installs). Sent once per
 * distinct answer per process: the launch panel re-scans every 10 s.
 */
export function trackMcScan(
  installs: readonly McInstall[],
  extras: McScanExtras | null | undefined,
  sink: (key: string, signature: string, input: SetupStepInput) => void = dedupedScan,
): void {
  try {
    const found = mcScanFound(installs, extras);
    const launchers = [...installs.map((i) => i.kind), ...(extras?.others ?? []).map((o) => o.launcher)];
    const bedrock = extras?.bedrock === true;
    const input: SetupStepInput = {
      game: 'minecraft',
      step: 'install_scan',
      outcome: found === 'java' ? 'ok' : 'fail',
      error_code: found === 'java' ? null : `MC_SCAN_${found.toUpperCase()}`,
      store: installs[0]?.kind ?? extras?.others[0]?.launcher ?? 'none',
      found,
      launchers,
      bedrock,
    };
    const signature = [found, [...new Set(launchers)].sort().join(','), bedrock, extras?.launcherInstalled === true].join('|');
    sink('install_scan', signature, input);
  } catch {
    /* never disturb the scan */
  }
}

/** Start Minecraft's answer (wizard:start-minecraft): did a launcher open? */
export function trackStartMinecraft(res: StartMinecraftResult, sink: SetupSink = trackSetupStep): void {
  if (res.ok) {
    sink({ game: 'minecraft', step: 'start_minecraft', outcome: 'ok', store: res.launcher });
  } else {
    sink({ game: 'minecraft', step: 'start_minecraft', outcome: 'fail', error_code: `MC_START_${res.reason.toUpperCase()}`, store: 'none' });
  }
}

/**
 * A `game_setup_step` the renderer sent through analytics:track goes back
 * through the same builder, so a renderer bug cannot add a free-text field.
 */
export function sanitizeRendererSetupProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const p = (props ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return setupStepProps({
    game: p.game === 'stardew' ? 'stardew' : 'minecraft',
    step: (str(p.step) ?? 'unknown') as SetupStepInput['step'],
    outcome: (str(p.outcome) ?? 'start') as SetupStepInput['outcome'],
    error_code: str(p.error_code),
    store: str(p.store),
    reason: str(p.reason) as SetupStepInput['reason'],
    found: str(p.found) as SetupStepInput['found'],
    launchers: typeof p.launchers === 'string' ? p.launchers.split(',') : null,
    bedrock: typeof p.bedrock === 'boolean' ? p.bedrock : null,
    ended: str(p.ended) as SetupStepInput['ended'],
    wait_ms: typeof p.wait_ms === 'number' ? p.wait_ms : null,
    version_ok: typeof p.version_ok === 'boolean' ? p.version_ok : null,
  });
}

/**
 * Stardew's game scan (stardew:install-state): found or not, and the store
 * the folder belongs to. Once per distinct answer per process.
 */
export function trackStardewScan(
  state: Pick<StardewInstallState, 'gamePath' | 'store' | 'smapiInstalled' | 'modInstalled' | 'ready'> & { manual?: boolean; versionOk?: boolean | null },
  sink: (key: string, signature: string, input: SetupStepInput) => void = dedupedScan,
): void {
  try {
    const found = state.gamePath != null;
    const store = found ? (state.manual ? 'manual' : state.store) : 'unknown';
    const input: SetupStepInput = {
      game: 'stardew',
      step: 'find_game',
      outcome: found ? 'ok' : 'fail',
      error_code: found ? null : 'GAME_NOT_INSTALLED',
      store,
      ...(found && state.versionOk !== undefined ? { version_ok: state.versionOk } : {}),
    };
    sink('stardew_scan', [found, store, state.versionOk ?? 'na'].join('|'), input);
  } catch {
    /* never disturb the scan */
  }
}

let farmSeen = false;

/** The first open farm this process saw: the end of the Stardew setup. */
export function trackStardewFarmSeen(store: string, sink: SetupSink = trackSetupStep): void {
  if (farmSeen) return;
  farmSeen = true;
  try {
    sink({ game: 'stardew', step: 'farm_seen', outcome: 'ok', store });
  } catch {
    /* ignore */
  }
}
