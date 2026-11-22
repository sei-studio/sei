/**
 * Launch timing marks (261123). Each boot phase stamps the time since the
 * process started (Node's performance clock starts with the process), logs it
 * once, and the first-show event (`app_window_shown`) carries them as flat
 * `<phase>_ms` props so slow launches can be split by phase in the field.
 *
 * Cheap on purpose: no I/O, no imports beyond node:perf_hooks, safe to import
 * from boot.ts (loaded in safe mode too). Only the first stamp of a phase
 * counts; a reopened window (macOS Dock) never moves the launch numbers.
 */
import { performance } from 'node:perf_hooks';

export type StartupPhase =
  /** boot.ts started evaluating (the entry graph is loaded by then). */
  | 'boot_entry'
  /** boot.ts is about to import the app graph (app.js). */
  | 'app_import_start'
  /** The app graph finished loading. */
  | 'app_imported'
  /** Electron's ready event. */
  | 'ready'
  /** The updater was initialised (boot.ts, on ready, before the app's own ready handler). */
  | 'updater_started'
  /** bootstrap() started (after the Windows pending-update check). */
  | 'bootstrap_start'
  /** The data scope is known (stored session read). */
  | 'scope'
  /** The main window was created and its renderer load started. */
  | 'window_created'
  /** One-shot migrations and the other pre-window setup finished. */
  | 'migrations'
  /** Every IPC handler is registered (the renderer's calls are answered from here on). */
  | 'ipc_ready'
  /** Main's auth state is loaded (auth:snapshot answers loaded:true). */
  | 'auth_ready'
  /** bootstrap() returned. */
  | 'bootstrap_done'
  /** The main window's ready-to-show. */
  | 'ready_to_show';

const marks = new Map<StartupPhase, number>();

/** Stamp `phase` (first call only) and log it. Never throws. */
export function markStartup(phase: StartupPhase): void {
  if (marks.has(phase)) return;
  try {
    const ms = Math.round(performance.now());
    marks.set(phase, ms);
    console.log(`[sei] startup: ${phase} +${ms}ms`);
  } catch {
    /* timing never breaks a start */
  }
}

/** The stamp of `phase` in ms since process start, if it happened. */
export function startupMark(phase: StartupPhase): number | undefined {
  return marks.get(phase);
}

/** Every stamp so far as flat analytics props: `{ <phase>_ms: number }`. Shape only. */
export function startupMarkProps(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [phase, ms] of marks) out[`${phase}_ms`] = ms;
  return out;
}

/** The renderer's first-view event (renderer lib/firstView.ts). */
export const FIRST_VIEW_EVENT = 'app_first_view';

const FIRST_VIEW_KINDS = new Set([
  'home',
  'onboard',
  'signin',
  'skin-setup',
  'sui-meet',
  'awaken',
  'auth-choice',
  'onboarding',
  'mc-setup',
  'games-picker',
]);

let firstViewSeen = false;

function boundedMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.min(Math.round(v), 30 * 60_000);
}

/**
 * `app_first_view` props, rebuilt in main (shape only): the view kind from a
 * closed list (anything else is `other`), the renderer's two timings bounded,
 * `ms_since_process_start` stamped here on arrival, and main's phase marks.
 * Only the first one per process counts as the launch's (`first_of_process`);
 * a renderer reload or a reopened window reports again with it false.
 */
export function firstViewProps(raw: unknown, nowMs: number = performance.now()): Record<string, unknown> {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = typeof r.view_kind === 'string' && FIRST_VIEW_KINDS.has(r.view_kind) ? r.view_kind : 'other';
  const out: Record<string, unknown> = {
    view_kind: kind,
    ms_since_process_start: Math.max(0, Math.round(nowMs)),
    first_of_process: !firstViewSeen,
  };
  firstViewSeen = true;
  const waited = boundedMs(r.waited_auth_ms);
  if (waited !== undefined) out.waited_auth_ms = waited;
  const renderer = boundedMs(r.renderer_ms);
  if (renderer !== undefined) out.renderer_ms = renderer;
  return { ...out, ...startupMarkProps() };
}

/** Tests only. */
export function resetStartupMarksForTest(): void {
  marks.clear();
  firstViewSeen = false;
}
