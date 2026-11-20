/**
 * Velopack self-repair on Windows (product call 261120): pure rules, no
 * electron import, so they unit-test on any host. velopackRepair.ts runs them.
 *
 * A Velopack install must never need the user to reinstall by hand to get a
 * fix. When the install's own updater is broken (Update.exe gone or failing,
 * the packages folder unusable, an apply that never takes effect), Sei
 * downloads the newest signed full Setup for its channel (setup.<channel>.json,
 * the same file the NSIS migration uses), checks its sha256 and Authenticode
 * signature, and runs it over the existing install at %LOCALAPPDATA%\Sei.
 * Velopack's Setup, finding the folder in use, stops whatever runs from it,
 * renames it aside, installs fresh and deletes the old copy (or renames it
 * back when the install fails). App data lives in %APPDATA%\Sei and is never
 * touched.
 *
 * Signals (at most ONE counted per launch, so a single bad session cannot
 * trigger a reinstall):
 *
 *   - update-exe-missing: this launch runs from a Velopack layout
 *     (<root>\current\Sei.exe with sq.version) but Update.exe is gone.
 *     Decisive: nothing else can ever update this copy, so the repair is due
 *     at once.
 *   - not-installed: the same layout, but Velopack's module or UpdateManager
 *     would not load. Counted like the rest (it can be a passing lock or an
 *     antivirus scan), so it takes three launches.
 *   - check / download: the update check or the package download threw while
 *     the feed itself answered (velopackRepair.ts probes it first, so being
 *     offline never counts). Network-class errors never count: Velopack's
 *     HTTP client and the probe can take different routes (a proxy, the
 *     GitHub fallback), and a reinstall cannot fix a network path.
 *   - stage-spawn / apply-spawn: Update.exe would not start.
 *   - apply-no-effect: an apply to T was started from version F and the next
 *     launch is still F.
 *
 * FAILURE_THRESHOLD such launches in a row make the repair due. A real check
 * that finds nothing to install, or a version change through a normal
 * update, clears the streak; a check that finds an update clears a check
 * failure, a finished download clears check and download failures (neither
 * says anything about Update.exe applying). A streak older than
 * STREAK_MAX_AGE_MS starts over. Attempts are capped per epoch of the remote
 * rule (MAX_REPAIR_ATTEMPTS); only a later normal update (proof the updater
 * works again) or a raised epoch gives an install fresh attempts, so a
 * machine whose antivirus keeps eating Update.exe is repaired at most three
 * times, never in a loop.
 *
 * Remote control: repair.<channel>.json `{ "percent": 100, "epoch": 0 }`
 * beside the feed. No file (404) = on for everyone. percent 0 = off (the kill
 * switch). Any other answer = not this time. The target respects the update
 * rollout (rollout.<channel>.json): a version held back from this install is
 * never installed by a repair, and the repair never goes below the running
 * version.
 */
import { createHash } from 'node:crypto';
import { compareVersions, rolloutAllows, type RolloutRule } from './velopackFastApply';
import { parseSetupManifest, type SetupManifest } from './velopackMigrationPolicy';

/** <userData>/velopack-repair.json */
export const REPAIR_STATE_FILE = 'velopack-repair.json';
/** Failing launches in a row before a repair is due (decisive signals skip this). */
export const FAILURE_THRESHOLD = 3;
/** A streak whose first failure is older than this starts over (failures weeks apart are not a broken install). */
export const STREAK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Repairs per epoch of repair.<channel>.json. */
export const MAX_REPAIR_ATTEMPTS = 3;
/** A hand-off younger than this with its runner alive is still installing. */
export const HANDOFF_IN_PROGRESS_MS = 20 * 60 * 1000;
/** Analytics events waiting for a normal launch to send them. */
export const MAX_REPORTS = 12;
/** Setup manifests remembered, so a repair can fall back to a version the rollout allows. */
export const MAX_KNOWN_SETUPS = 4;

export type FailureKind =
  | 'update-exe-missing'
  | 'not-installed'
  | 'check'
  | 'download'
  | 'stage-spawn'
  | 'apply-spawn'
  | 'apply-no-effect';

const KINDS: readonly FailureKind[] = [
  'update-exe-missing',
  'not-installed',
  'check',
  'download',
  'stage-spawn',
  'apply-spawn',
  'apply-no-effect',
];

/** Signals that mean nothing but a reinstall can update this copy. */
export const DECISIVE: readonly FailureKind[] = ['update-exe-missing'];

/** What a working check proves: the check itself works. */
export const CHECK_OK_CLEARS: readonly FailureKind[] = ['check'];
/** What a finished download proves: check and download work (not the apply). */
export const DOWNLOAD_OK_CLEARS: readonly FailureKind[] = ['check', 'download'];

/**
 * A check or download error that is about the network path (timeouts, DNS,
 * refused or reset connections, TLS, proxies, HTTP statuses). Never counted:
 * a reinstall cannot fix it. Velopack's messages come from reqwest/ureq and
 * the OS; IO errors on the install (os error 183, access denied) do not match.
 */
export function networkFailure(detail: string | undefined): boolean {
  if (!detail) return false;
  return /network|https?\b|request|timed? ?out|timeout|\bdns\b|resolve|lookup|connect|connection|tls|ssl|certificate|handshake|socket|reset by peer|refused|unreachable|proxy|status code|\bstatus\b\D{0,12}\b[45]\d\d\b|os error (10050|10051|10053|10054|10060|10061|10064|10065|11001|11002|11004|12002|12007|12029|12030|12157|12175)\b/i.test(
    detail,
  );
}

export interface KnownSetup extends SetupManifest {
  channel: string;
}

export interface RepairHandoff {
  attempt: number;
  from: string;
  target: string;
  channel: string;
  at: number;
  /** %TEMP% folder holding the Setup, the runner and its result. */
  dir: string;
  /** The signal that made the repair due. */
  trigger: FailureKind;
  /** 'safe' | 'normal' | 'launch' (handed off at the start of a launch). */
  mode: string;
}

/** A Setup downloaded and verified, waiting for its hand-off. */
export interface RepairReady {
  attempt: number;
  dir: string;
  file: string;
  manifest: KnownSetup;
  at: number;
  /** The channel whose repair.<channel>.json allowed it (re-read before the install). */
  ruleChannel?: string;
}

export interface RepairReport {
  phase: 'triggered' | 'failed' | 'repaired' | 'gave_up' | 'held';
  [key: string]: string | number | boolean | undefined;
}

export interface RepairState {
  v: 1;
  /** Failing launches in a row. */
  streak: number;
  /** The launch that counted last (one count per launch). */
  lastCountedLaunch?: string;
  firstFailureAt?: number;
  lastFailure?: { kind: FailureKind; at: number; version: string; target?: string; detail?: string };
  /** The version the last apply was started for, from which version. */
  apply?: { from: string; target: string; at: number };
  /** The version the last launch ran (a newer one = a normal update worked). */
  lastVersion?: string;
  /** repair.<channel>.json epoch the attempts count against. */
  epoch: number;
  attempts: number;
  handoff?: RepairHandoff;
  ready?: RepairReady;
  reports: RepairReport[];
  setups: KnownSetup[];
  /** packages\.betaId, kept because a reinstall writes a new one (rollout buckets stay put). */
  betaId?: string;
  /** setup.<channel>.json was looked at once for this version (healthy runs cache it once). */
  setupProbedFor?: string;
  /** What was last reported as held / given up, so each is sent once. */
  heldReported?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function kind(v: unknown): FailureKind | undefined {
  return KINDS.includes(v as FailureKind) ? (v as FailureKind) : undefined;
}

export function emptyRepairState(): RepairState {
  return { v: 1, streak: 0, epoch: 0, attempts: 0, reports: [], setups: [] };
}

function parseKnownSetup(v: unknown): KnownSetup | null {
  const o = obj(v);
  const channel = str(o?.channel);
  if (!o || !channel || !/^[a-z0-9-]+$/i.test(channel)) return null;
  const m = parseSetupManifest(o);
  return m ? { ...m, channel } : null;
}

/** Whatever is on disk, made safe to use. Never throws; junk reads as a fresh state. */
export function parseRepairState(json: unknown): RepairState {
  const s = obj(json);
  if (!s) return emptyRepairState();
  const out = emptyRepairState();
  out.streak = Math.max(0, Math.floor(num(s.streak) ?? 0));
  out.lastCountedLaunch = str(s.lastCountedLaunch);
  out.firstFailureAt = num(s.firstFailureAt);
  const lf = obj(s.lastFailure);
  const lfKind = kind(lf?.kind);
  if (lf && lfKind) {
    out.lastFailure = {
      kind: lfKind,
      at: num(lf.at) ?? 0,
      version: str(lf.version) ?? '',
      target: str(lf.target),
      detail: str(lf.detail)?.slice(0, 120),
    };
  }
  const ap = obj(s.apply);
  if (ap && str(ap.from) && str(ap.target)) out.apply = { from: str(ap.from)!, target: str(ap.target)!, at: num(ap.at) ?? 0 };
  out.lastVersion = str(s.lastVersion);
  out.epoch = Math.max(0, Math.floor(num(s.epoch) ?? 0));
  out.attempts = Math.max(0, Math.floor(num(s.attempts) ?? 0));
  const h = obj(s.handoff);
  if (h && str(h.from) && str(h.target) && str(h.dir)) {
    out.handoff = {
      attempt: num(h.attempt) ?? 0,
      from: str(h.from)!,
      target: str(h.target)!,
      channel: str(h.channel) ?? 'win',
      at: num(h.at) ?? 0,
      dir: str(h.dir)!,
      trigger: kind(h.trigger) ?? 'check',
      mode: str(h.mode) ?? 'normal',
    };
  }
  const r = obj(s.ready);
  const rm = parseKnownSetup(r?.manifest);
  if (r && rm && str(r.dir) && str(r.file)) {
    out.ready = {
      attempt: num(r.attempt) ?? 0,
      dir: str(r.dir)!,
      file: str(r.file)!,
      manifest: rm,
      at: num(r.at) ?? 0,
      ruleChannel: str(r.ruleChannel),
    };
  }
  if (Array.isArray(s.reports)) {
    out.reports = s.reports
      .map(obj)
      .filter((x): x is Record<string, unknown> => !!x && typeof x.phase === 'string')
      .slice(-MAX_REPORTS) as RepairReport[];
  }
  if (Array.isArray(s.setups)) {
    out.setups = s.setups.map(parseKnownSetup).filter((x): x is KnownSetup => !!x).slice(0, MAX_KNOWN_SETUPS);
  }
  out.betaId = str(s.betaId);
  out.setupProbedFor = str(s.setupProbedFor);
  out.heldReported = str(s.heldReported);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Signals                                                                    */
/* -------------------------------------------------------------------------- */

export interface FailureContext {
  /** Unique per process. */
  launch: string;
  version: string;
  now: number;
  target?: string;
  detail?: string;
}

/**
 * Counts a failure, once per launch. `counted` is false when this launch
 * already counted one (the details still update).
 */
export function noteFailure(s: RepairState, k: FailureKind, c: FailureContext): { state: RepairState; counted: boolean } {
  const next: RepairState = {
    ...s,
    lastFailure: { kind: k, at: c.now, version: c.version, target: c.target, detail: c.detail?.slice(0, 120) },
  };
  if (s.lastCountedLaunch === c.launch) return { state: next, counted: false };
  const fresh = s.streak === 0 || s.firstFailureAt === undefined || streakExpired(s, c.now);
  next.streak = fresh ? 1 : s.streak + 1;
  next.lastCountedLaunch = c.launch;
  next.firstFailureAt = fresh ? c.now : s.firstFailureAt;
  return { state: next, counted: true };
}

export function streakExpired(s: RepairState, now: number): boolean {
  return s.streak > 0 && s.firstFailureAt !== undefined && now - s.firstFailureAt > STREAK_MAX_AGE_MS;
}

/**
 * The updater worked for what it was asked. With no `clears`, everything it
 * was asked worked (a check that found nothing to install). With `clears`,
 * only a streak whose last failure is one of those kinds is cleared (a check
 * that found an update says nothing about a failing apply). Never the attempts.
 */
export function noteHealthy(s: RepairState, clears?: readonly FailureKind[]): RepairState {
  if (s.streak === 0 && !s.lastFailure && s.firstFailureAt === undefined) return s;
  if (clears && s.lastFailure && !clears.includes(s.lastFailure.kind)) return s;
  return { ...s, streak: 0, firstFailureAt: undefined, lastFailure: undefined, lastCountedLaunch: undefined };
}

/** Update.exe was started to apply `target` (restart, quit or launch apply). */
export function noteApplyLaunched(s: RepairState, from: string, target: string, now: number): RepairState {
  return { ...s, apply: { from, target, at: now } };
}

export function pushReport(s: RepairState, r: RepairReport): RepairState {
  return { ...s, reports: [...s.reports, r].slice(-MAX_REPORTS) };
}

/** Remembers a Setup manifest (newest first, one per channel+version). */
export function rememberSetup(s: RepairState, m: SetupManifest, channel: string): RepairState {
  const entry: KnownSetup = { ...m, channel };
  const rest = s.setups.filter((x) => !(x.channel === channel && x.version === m.version));
  const setups = [entry, ...rest].sort((a, b) => compareVersions(b.version, a.version)).slice(0, MAX_KNOWN_SETUPS);
  return { ...s, setups };
}

/* -------------------------------------------------------------------------- */
/*  Launch evaluation                                                          */
/* -------------------------------------------------------------------------- */

export type BrokenLayout = 'update-exe-missing' | 'not-installed' | null;

export interface LaunchFacts {
  launch: string;
  version: string;
  now: number;
  /** This launch runs from a Velopack layout that Velopack cannot update. */
  broken: BrokenLayout;
  /** result.txt of the last hand-off's runner, null when it wrote none. */
  handoffResult: string | null;
  /** The last hand-off's runner process is still alive. */
  handoffRunnerAlive: boolean;
}

export interface LaunchOutcome {
  state: RepairState;
  /** Another launch is mid-repair: this one should leave at once. */
  leave: boolean;
  /** The hand-off folder to delete (its result has been read). */
  removeDir: string | null;
  /** What happened, for the log. */
  notes: string[];
}

/** 'setup-exit 0' -> 'ok'; 'setup-exit 5' -> 'setup-exit-5'; anything else as a short class. */
export function handoffResultClass(result: string | null): string {
  if (result === null) return 'no-result';
  const t = result.trim().toLowerCase();
  const m = /^setup-exit (-?\d+)$/.exec(t);
  if (m) return m[1] === '0' ? 'ok' : `setup-exit-${m[1]}`;
  return t.replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'no-result';
}

export function evaluateLaunch(prev: RepairState, f: LaunchFacts): LaunchOutcome {
  let s: RepairState = { ...prev };
  const notes: string[] = [];
  let removeDir: string | null = null;
  let repairedNow = false;

  if (s.handoff) {
    const h = s.handoff;
    if (f.handoffResult === null && f.handoffRunnerAlive && f.now - h.at < HANDOFF_IN_PROGRESS_MS) {
      notes.push(`repair ${h.attempt} to ${h.target} is still running`);
      return { state: s, leave: true, removeDir: null, notes };
    }
    const cls = handoffResultClass(f.handoffResult);
    const upgraded = compareVersions(f.version, h.from) > 0;
    const ok = upgraded || (cls === 'ok' && f.broken === null);
    removeDir = h.dir;
    s.handoff = undefined;
    s.ready = undefined;
    if (ok) {
      repairedNow = true;
      notes.push(`repair ${h.attempt} worked: ${h.from} -> ${f.version} (${cls})`);
      s = pushReport(s, {
        phase: 'repaired',
        attempt: h.attempt,
        recover_ms: Math.max(0, f.now - (s.firstFailureAt ?? h.at)),
        trigger: h.trigger,
        mode: h.mode,
        same_version: f.version === h.from,
        from: h.from,
        to: f.version,
      });
      s = { ...s, streak: 0, firstFailureAt: undefined, lastFailure: undefined, lastCountedLaunch: f.launch, apply: undefined };
    } else {
      notes.push(`repair ${h.attempt} failed: ${cls} (still ${f.version})`);
      s = pushReport(s, { phase: 'failed', stage: 'setup', class: cls, attempt: h.attempt, mode: h.mode });
    }
  }

  // A newer version than the last launch, not from a repair: a normal update
  // worked, so the updater is healthy and the install gets fresh attempts.
  if (!repairedNow && s.lastVersion && compareVersions(f.version, s.lastVersion) > 0) {
    notes.push(`updated ${s.lastVersion} -> ${f.version}; updater healthy`);
    s = {
      ...s,
      streak: 0,
      firstFailureAt: undefined,
      lastFailure: undefined,
      lastCountedLaunch: undefined,
      attempts: 0,
      ready: undefined,
      apply: undefined,
      heldReported: undefined,
    };
  }
  s.lastVersion = f.version;

  if (streakExpired(s, f.now)) {
    notes.push(`a streak of ${s.streak} from ${new Date(s.firstFailureAt ?? 0).toISOString()} expired`);
    s = noteHealthy(s);
  }

  if (s.apply) {
    const a = s.apply;
    s.apply = undefined;
    if (compareVersions(f.version, a.target) < 0 && compareVersions(f.version, a.from) <= 0) {
      const r = noteFailure(s, 'apply-no-effect', { launch: f.launch, version: f.version, now: f.now, target: a.target });
      s = r.state;
      notes.push(`the apply to ${a.target} did not take (still ${f.version}); streak ${s.streak}`);
    }
  }

  if (f.broken) {
    const r = noteFailure(s, f.broken, { launch: f.launch, version: f.version, now: f.now });
    s = r.state;
    notes.push(`${f.broken}: this copy cannot update itself`);
  }
  return { state: s, leave: false, removeDir, notes };
}

/* -------------------------------------------------------------------------- */
/*  Decision                                                                   */
/* -------------------------------------------------------------------------- */

/** repair.<channel>.json */
export interface RepairRule {
  percent: number;
  epoch: number;
}

/** No file (404) means on for everyone. */
export const DEFAULT_REPAIR_RULE: RepairRule = { percent: 100, epoch: 0 };

export function parseRepairRule(json: unknown): RepairRule | null {
  const r = obj(json);
  const percent = num(r?.percent);
  if (!r || percent === undefined) return null;
  return { percent: Math.max(0, Math.min(100, percent)), epoch: Math.max(0, Math.floor(num(r.epoch) ?? 0)) };
}

/** Stable 0..99 bucket per install, independent of the update and migration buckets. */
export function repairBucket(installId: string): number {
  return createHash('sha256').update(`${installId}:velopack-repair`).digest().readUInt32BE(0) % 100;
}

export function repairAllowed(rule: RepairRule, installId: string): boolean {
  if (rule.percent <= 0) return false;
  if (rule.percent >= 100) return true;
  return repairBucket(installId) < rule.percent;
}

/**
 * The updater should stand still from the start of a launch: a Setup is
 * downloaded, or a repair is due and nothing refused it yet in this epoch
 * (a refusal is re-decided by runRepair, and the startup check goes ahead
 * meanwhile).
 */
export function holdsAtLaunch(s: RepairState): boolean {
  return !!s.ready || (repairDue(s) && !s.heldReported);
}

/** The repair is due: a decisive signal, or enough failing launches in a row. */
export function repairDue(s: RepairState): boolean {
  if (s.handoff) return false;
  if (s.lastFailure && DECISIVE.includes(s.lastFailure.kind) && s.streak > 0) return true;
  return s.streak >= FAILURE_THRESHOLD;
}

/** rollout.<channel>.json as read: a rule, null (no file), or 'unreadable' (hold). */
export type RolloutRead = RolloutRule | null | 'unreadable';

export interface DecisionInputs {
  state: RepairState;
  /** null = repair.<channel>.json could not be read (not a 404). */
  rule: RepairRule | null;
  installId: string;
  appVersion: string;
  /** Fresh setup.<channel>.json manifests plus the remembered ones. */
  candidates: KnownSetup[];
  rollouts: Record<string, RolloutRead>;
}

export type RepairDecision =
  | { ok: true; attempt: number; epoch: number; target: KnownSetup }
  | { ok: false; reason: string; epoch?: number };

/** The newest Setup this install may get: not below the running version, not held by the rollout. */
export function pickRepairTarget(
  candidates: KnownSetup[],
  appVersion: string,
  installId: string,
  rollouts: Record<string, RolloutRead>,
): { target: KnownSetup | null; reason: string } {
  let reason = 'no-target';
  const sorted = [...candidates].sort((a, b) => compareVersions(b.version, a.version));
  for (const c of sorted) {
    if (compareVersions(c.version, appVersion) < 0) continue; // never a downgrade
    if (compareVersions(c.version, appVersion) === 0) return { target: c, reason: '' }; // what we run already
    const rule = rollouts[c.channel];
    if (rule === undefined || rule === 'unreadable') {
      reason = 'rollout-unreadable';
      continue;
    }
    if (rolloutAllows(rule, c.version, installId)) return { target: c, reason: '' };
    reason = 'rollout-held';
  }
  return { target: null, reason };
}

export function repairDecision(i: DecisionInputs): RepairDecision {
  const s = i.state;
  if (!repairDue(s)) return { ok: false, reason: 'not-due' };
  if (!i.rule) return { ok: false, reason: 'rule-unreachable' };
  const epoch = i.rule.epoch;
  const attempts = epoch > s.epoch ? 0 : s.attempts;
  if (!repairAllowed(i.rule, i.installId)) return { ok: false, reason: 'disabled', epoch };
  if (attempts >= MAX_REPAIR_ATTEMPTS) return { ok: false, reason: 'cap', epoch };
  const pick = pickRepairTarget(i.candidates, i.appVersion, i.installId, i.rollouts);
  if (!pick.target) return { ok: false, reason: pick.reason, epoch };
  return { ok: true, attempt: attempts + 1, epoch: Math.max(epoch, s.epoch), target: pick.target };
}

/**
 * Applies a decision's bookkeeping: an ok decision counts its attempt (at the
 * download start, so a Sei killed mid-download still used it up); a refusal
 * is reported once per reason.
 */
export function recordDecision(s: RepairState, d: RepairDecision, mode: string): RepairState {
  if (d.ok) {
    let next: RepairState = { ...s, epoch: d.epoch, attempts: d.attempt, heldReported: undefined };
    next = pushReport(next, {
      phase: 'triggered',
      attempt: d.attempt,
      trigger: s.lastFailure?.kind ?? 'check',
      streak: s.streak,
      mode,
      to: d.target.version,
    });
    return next;
  }
  if (d.reason === 'not-due') return s;
  let next = s;
  if (d.epoch !== undefined && d.epoch > s.epoch) next = { ...next, epoch: d.epoch, attempts: 0 };
  if (next.heldReported === d.reason) return next;
  next = { ...next, heldReported: d.reason };
  return pushReport(
    next,
    d.reason === 'cap' ? { phase: 'gave_up', attempts: next.attempts } : { phase: 'held', reason: d.reason },
  );
}
