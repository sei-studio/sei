/**
 * Decorating her room together (261105, T336): the live side. The state lives
 * in editorTogether.ts (no electron there, chatService reads it); this file
 * opens and closes sessions from the editor's IPC, takes the editor's unsaved
 * room (seilink:editor-sync), and says her live lines.
 *
 * Live lines (off a call): the editor's edits are batched. After LIVE_PAUSE_MS
 * with no edit she may say ONE short line about what changed since she last
 * said something about the room, at most LIVE_MAX_PER_SESSION per session and
 * LIVE_GAP_MS apart. It is a desktop-line turn (sendDesktopLineTurn 'react')
 * with the live note, so persona, memory and her chat history are the usual
 * ones, and the line lands in her chat (the editor's bubble shows it from
 * there). It pays like a poke (the player did something): free cloud accounts
 * inside their weekly cap; over it she stays quiet (budget skip, no UI).
 * On a call or in a game there is no live line: on a call her turns get the
 * change list and the picture instead (chatService, editorTogether.ts).
 *
 * Analytics (shape only): seilink_live_line {outcome shown/skipped, reason,
 * changes (bucket), latency_ms, budget}, each skip reason once per session;
 * host counters live_shown / live_skip_<reason>; the session counters go to
 * the editor (seilink_editor_session). Never the change list or the line.
 */
import { loadAnalytics } from '../lazyAnalytics';
import { roomChangeBucket } from '../../shared/seilinkRoomDiff';
import { isRoomPresetId, sanitizeRoomState } from '../../shared/seilinkValidate';
import type { RoomState } from '../../shared/seilinkRoom';
import { budgetInfo, budgetRefusal, desktopLineState, speakEditorLine, type LineBudget, type PokeOutcome } from './desktopLines';
import { seilinkEnabled, seilinkResident } from './gate';
import { noteSeilinkCount } from './host/seilinkHost';
import { loadPack } from './packs';
import { roomSource } from './roomStore';
import { reactionSkipFor } from './roomReaction';
import {
  closeTogether,
  countTogether,
  LIVE_PAUSE_MS,
  liveLineBlock,
  liveLineNote,
  openTogether,
  syncTogether,
  takeUndoneHers,
  togetherByToken,
  unseenChanges,
  type LiveSkip,
  type TogetherSession,
} from './editorTogether';
import type { RoomContext } from './types';
import type { RoomSnapshot } from './roomChangeNote';

export const SEILINK_LIVE_LINE_EVENT = 'seilink_live_line';

export interface LiveLineReport {
  character_id: string;
  outcome: 'shown' | 'skipped';
  reason?: LiveSkip;
  changes: ReturnType<typeof roomChangeBucket>;
  latency_ms?: number;
  budget?: LineBudget;
}

export interface TogetherLiveDeps {
  resident(characterId: string): boolean;
  lines(characterId: string): { running: boolean; onCall: boolean; occupied: boolean };
  budget(): Promise<{ value: LineBudget; credits: { plan: string; over_limit: boolean } | null }>;
  speak(characterId: string, note: string): Promise<PokeOutcome>;
  report(r: LiveLineReport): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/** A budget refusal or a failed turn as a live-line skip. */
export function liveSkipFor(outcome: PokeOutcome): LiveSkip {
  const r = reactionSkipFor(outcome);
  if (r === 'budget' || r === 'silence' || r === 'busy' || r === 'in_game') return r;
  if (r === 'not_live') return 'not_resident';
  return 'error';
}

/** The live-line scheduler, one per main process (`live()` below). */
export class TogetherLive {
  private timers = new Map<string, unknown>();
  private speaking = new Set<string>();

  constructor(private readonly deps: TogetherLiveDeps) {}

  /** The editor's room changed: (re)start the pause timer. */
  edited(s: TogetherSession): void {
    this.arm(s, LIVE_PAUSE_MS);
  }

  closed(token: string): void {
    const t = this.timers.get(token);
    if (t !== undefined) this.deps.clearTimer(t);
    this.timers.delete(token);
  }

  private arm(s: TogetherSession, ms: number): void {
    this.closed(s.token);
    this.timers.set(
      s.token,
      this.deps.setTimer(() => {
        this.timers.delete(s.token);
        void this.fire(s.token).catch((err) => console.warn(`[seilink] live line failed: ${(err as Error).message}`));
      }, ms),
    );
  }

  private skip(s: TogetherSession, reason: LiveSkip, changes: number, budget?: LineBudget): void {
    noteSeilinkCount(`live_skip_${reason}`);
    // One event per reason per session: a busy editor re-checks often.
    if (s.reportedSkips.has(reason)) return;
    s.reportedSkips.add(reason);
    this.deps.report({ character_id: s.characterId, outcome: 'skipped', reason, changes: roomChangeBucket(changes), ...(budget ? { budget } : {}) });
  }

  /** The pause passed: say a line if she may. Exported for tests through `fireNow`. */
  async fire(token: string): Promise<void> {
    const s = togetherByToken(token);
    if (!s || this.speaking.has(token)) return;
    const id = s.characterId;
    const now = this.deps.now();
    const changes = unseenChanges(s);
    const lines = this.deps.lines(id);
    const block = liveLineBlock({
      changes: changes.length,
      resident: this.deps.resident(id),
      onCall: lines.onCall,
      inGame: lines.occupied && !lines.onCall,
      busy: lines.running,
      shown: s.liveShown,
      lastAt: s.lastLiveAt,
      lastEditAt: s.lastEditAt,
      now,
    });
    if (block) {
      if (block.skip === 'no_change') return;
      if (block.retryInMs !== undefined) {
        // Still editing, or too soon after her last line: look again when it is time.
        if (block.skip === 'cooldown') this.skip(s, 'cooldown', changes.length);
        this.arm(s, Math.max(250, block.retryInMs));
        return;
      }
      return this.skip(s, block.skip, changes.length);
    }
    const budget = await this.deps.budget().catch(() => ({ value: 'none' as LineBudget, credits: null }));
    if (budgetRefusal('poke', budget.value, budget.credits)) return this.skip(s, 'budget', changes.length, budget.value);
    const asked: RoomSnapshot = { manifest: s.live.manifest, state: s.live.state };
    this.speaking.add(token);
    let outcome: PokeOutcome;
    try {
      outcome = await this.deps.speak(id, liveLineNote(changes, takeUndoneHers(s))).catch((): PokeOutcome => 'error');
    } finally {
      this.speaking.delete(token);
    }
    const done = this.deps.now();
    // Silence is an answer too: she watched and let it pass, so the same changes do not come round again.
    if (outcome === 'ok' || outcome === 'silence') {
      s.seen = asked;
      s.turnSeen = asked;
      s.lastLiveAt = done;
    }
    if (outcome !== 'ok') {
      const reason = liveSkipFor(outcome);
      // Another turn for her was running (she was answering the talk box): try once more after the gap.
      if (reason === 'busy') this.arm(s, LIVE_PAUSE_MS);
      return this.skip(s, reason, changes.length, budget.value);
    }
    s.liveShown += 1;
    noteSeilinkCount('live_shown');
    countTogether(s, 'live_lines');
    this.deps.report({ character_id: id, outcome: 'shown', changes: roomChangeBucket(changes.length), latency_ms: Math.max(0, done - now), budget: budget.value });
    // Edits that came in while she was talking get their own turn later.
    if (unseenChanges(s).length) this.arm(s, LIVE_PAUSE_MS);
  }
}

let instance: TogetherLive | null = null;

function live(): TogetherLive {
  if (instance) return instance;
  instance = new TogetherLive({
    resident: (id) => seilinkEnabled() && seilinkResident() === id,
    lines: (id) => desktopLineState(id),
    budget: () => budgetInfo(Date.now()),
    speak: async (id, note) => (await speakEditorLine(id, note)).outcome,
    report: (r) => {
      void loadAnalytics()
        .then((a) => a.capture(SEILINK_LIVE_LINE_EVENT, { ...r }))
        .catch(() => {});
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  return instance;
}

/** Tests: swap the scheduler's deps. */
export function __setTogetherLiveForTest(next: TogetherLive | null): void {
  instance = next;
}

/** The companion editor opened (seilink:editor-session 'open'). Only for the companion who lives on the desktop. */
export async function onTogetherOpened(token: string, characterId: string): Promise<void> {
  if (!(seilinkEnabled() && seilinkResident() === characterId)) return;
  const room = await roomSource.getRoom(characterId);
  if (!room) return;
  openTogether(token, characterId, room, { now: Date.now(), onCall: desktopLineState(characterId).onCall });
}

/** The editor closed. Returns the session (the closing reaction reads what she already saw), or null. */
export function onTogetherClosed(token: string): TogetherSession | null {
  live().closed(token);
  return closeTogether(token);
}

/** Builds the RoomContext for the editor's unsaved room (its preset's pack, validated like a save). */
export async function editorRoomContext(raw: unknown): Promise<RoomContext | null> {
  const r = raw && typeof raw === 'object' ? (raw as { preset?: unknown }) : null;
  if (!r || !isRoomPresetId(r.preset)) return null;
  const pack = await loadPack(r.preset);
  if (!pack) return null;
  const state: RoomState = sanitizeRoomState(pack.manifest, raw);
  return { manifest: pack.manifest, state, packDir: pack.dir, files: pack.files };
}

/** seilink:editor-sync: the editor's room right now. */
export async function onTogetherSync(token: string, characterId: string, raw: unknown): Promise<void> {
  const s = togetherByToken(token);
  if (!s || s.characterId !== characterId) return;
  const room = await editorRoomContext(raw);
  if (!room) return;
  const next = syncTogether(token, room, Date.now());
  if (next) live().edited(next);
}
