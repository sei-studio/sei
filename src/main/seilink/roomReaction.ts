/**
 * She reacts to your room edits (261105, T335). No setup and no mode: when an
 * editor session for her room ends and the room really changed, she says one
 * short line about it in her desktop bubble.
 *
 *  - Session: the companion editor tells main when it opens and when it
 *    closes (seilink:editor-session, CompanionRoomEditor). Main keeps the
 *    saved room at open and diffs it against the saved room at close
 *    (shared/seilinkRoomDiff.ts), so unsaved edits, a discard and an undo
 *    back to the start are no change. One reaction per session at most.
 *  - Only for the companion who lives on the desktop (SeiLink on, her host
 *    session open, at open AND at close), so the editor before she moves in,
 *    or with SeiLink off, never reacts.
 *  - Pays like a poke (the player did something): free cloud accounts inside
 *    their weekly cap, paid and own-AI as normal. Refused: silent, no UI.
 *  - REACT_COOLDOWN_MS between reactions.
 *  - On a call (or in a game) no bubble: the change waits for her next turn
 *    there (roomChangeNote.ts), and the same goes for any session that did
 *    not get a line, so the next chat or call turn knows the room changed.
 *
 * Analytics (shape only): seilink_room_reaction {outcome shown/skipped,
 * reason, changes (bucket), latency_ms, budget}, and host counters
 * react_shown / react_skip_<reason>. Never the change list or the line.
 */
import { loadAnalytics } from '../lazyAnalytics';
import { budgetInfo, budgetRefusal, desktopLineState, speakRoomReaction, type LineBudget, type PokeOutcome } from './desktopLines';
import { seilinkEnabled, seilinkResident } from './gate';
import { noteSeilinkCount, seilinkLiveCharacter } from './host/seilinkHost';
import { getRoomPayload } from './roomStore';
import { roomChangeBucket, roomChanges } from '../../shared/seilinkRoomDiff';
import { clearUnseenBaseline, keepUnseenBaseline, roomReactionNote, unseenBaseline, type RoomSnapshot } from './roomChangeNote';

/** At most one reaction this often. */
export const REACT_COOLDOWN_MS = 5 * 60_000;
/** StrictMode mounts, unmounts and mounts again: an untouched session this short is that, not a real open. */
export const REACT_THROWAWAY_MS = 250;
/** After a live line or a talk-box reply in the editor, no closing line this soon. */
export const TOGETHER_CLOSE_GAP_MS = 40_000;

/** What she already talked about while the editor was open (editorTogether.ts TogetherSession). */
export interface TogetherSeen {
  seen: RoomSnapshot;
  lastLiveAt: number | null;
}

/** Open sessions kept at most (a renderer that never says close cannot grow this). */
const MAX_SESSIONS = 8;

export const SEILINK_ROOM_REACTION_EVENT = 'seilink_room_reaction';

export type ReactionSkip =
  | 'no_change'
  | 'cooldown'
  | 'budget'
  | 'on_call'
  | 'in_game'
  /** Another desktop line was on its way. */
  | 'busy'
  /** Her host was not drawing (restarting, or she moved out) when the session ended. */
  | 'not_live'
  /** She answered with nothing. */
  | 'silence'
  /** 261105 (T336): she already talked about every change while the editor was open (a live line, a talk turn). */
  | 'seen_live'
  | 'error';

/** Why no reaction now (before the plan read), or null when she may react. Pure. */
export function reactionBlock(s: {
  changes: number;
  live: boolean;
  onCall: boolean;
  inGame: boolean;
  busy: boolean;
  now: number;
  lastAt: number | null;
}): ReactionSkip | null {
  if (s.changes === 0) return 'no_change';
  if (!s.live) return 'not_live';
  if (s.onCall) return 'on_call';
  if (s.inGame) return 'in_game';
  if (s.busy) return 'busy';
  if (s.lastAt !== null && s.now - s.lastAt < REACT_COOLDOWN_MS) return 'cooldown';
  return null;
}

/** A desktop line turn's outcome as a reaction skip. */
export function reactionSkipFor(outcome: PokeOutcome): ReactionSkip {
  switch (outcome) {
    case 'rate_limited':
    case 'depleted':
    case 'free_plan':
    case 'free_cap':
    case 'over_limit':
    case 'no_plan':
      return 'budget';
    case 'silence':
      return 'silence';
    case 'busy':
      return 'busy';
    case 'not_live':
    case 'not_shown':
    case 'no_room':
      return 'not_live';
    case 'occupied':
      return 'in_game';
    default:
      return 'error';
  }
}

export interface RoomReactionReport {
  character_id: string;
  outcome: 'shown' | 'skipped';
  reason?: ReactionSkip;
  changes: ReturnType<typeof roomChangeBucket>;
  latency_ms?: number;
  budget?: LineBudget;
}

export interface RoomReactionDeps {
  /** SeiLink is on and she is the one living on the desktop. */
  resident(characterId: string): boolean;
  /** Her host is drawing right now. */
  live(characterId: string): boolean;
  /** Her saved room and its pack's manifest, or null. */
  room(characterId: string): Promise<RoomSnapshot | null>;
  lines(characterId: string): { running: boolean; onCall: boolean; occupied: boolean };
  budget(): Promise<{ value: LineBudget; credits: { plan: string; over_limit: boolean } | null }>;
  speak(characterId: string, note: string): Promise<PokeOutcome>;
  report(r: RoomReactionReport): void;
  now(): number;
}

interface Session {
  characterId: string;
  openedAt: number;
  before: Promise<RoomSnapshot | null>;
}

/** Editor sessions and the cooldown; one per main process (`roomReactions` below). */
export class RoomReactions {
  private sessions = new Map<string, Session>();
  private lastAt: number | null = null;

  constructor(private readonly deps: RoomReactionDeps) {}

  opened(token: string, characterId: string): void {
    if (this.sessions.has(token)) return;
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    const before = this.deps.resident(characterId) ? this.deps.room(characterId).catch(() => null) : Promise.resolve(null);
    this.sessions.set(token, { characterId, openedAt: this.deps.now(), before });
  }

  /**
   * The session ended. Resolves when the reaction (or the skip) is done.
   * `together` (261105, T336): what she already said something about while
   * the editor was open (decorateTogether.ts); the closing line only covers
   * what changed since, and is skipped when that is nothing.
   */
  async closed(token: string, together?: TogetherSeen | null): Promise<void> {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    const id = s.characterId;
    const before = await s.before;
    // Not her desktop room at open or at close (SeiLink off, not moved in yet): no reaction, nothing to say.
    if (!before || !this.deps.resident(id)) return;
    const after = await this.deps.room(id).catch(() => null);
    if (!after) return;
    const now = this.deps.now();
    const session = roomChanges(before.manifest, before.state, after.manifest, after.state);
    if (session.length === 0 && now - s.openedAt < REACT_THROWAWAY_MS) return;
    // Everything she has not heard about yet: this session, plus earlier ones that got no line.
    // With the editor shared live, that is what changed since she last talked about it.
    const base = together ? together.seen : unseenBaseline(id, now);
    const all = base ? roomChanges(base.manifest, base.state, after.manifest, after.state) : session;
    const changes = together ? all : all.length ? all : session;
    const bucket = roomChangeBucket(changes.length);
    const skip = (reason: ReactionSkip, budget?: LineBudget): void => {
      if (reason !== 'no_change' && reason !== 'seen_live') keepUnseenBaseline(id, base ?? before, now);
      this.deps.report({ character_id: id, outcome: 'skipped', reason, changes: roomChangeBucket(reason === 'no_change' || reason === 'seen_live' ? 0 : changes.length), ...(budget ? { budget } : {}) });
    };
    if (together && session.length > 0 && changes.length === 0) {
      clearUnseenBaseline(id);
      return skip('seen_live');
    }
    const lines = this.deps.lines(id);
    const block = reactionBlock({
      changes: session.length,
      live: this.deps.live(id),
      onCall: lines.onCall,
      inGame: lines.occupied && !lines.onCall,
      busy: lines.running,
      now,
      lastAt: this.lastAt,
    });
    if (block) return skip(block);
    // No doubling up: right after a live line (or a talk-box reply), the rest waits for her next turn.
    if (together?.lastLiveAt != null && now - together.lastLiveAt < TOGETHER_CLOSE_GAP_MS) return skip('cooldown');
    const budget = await this.deps.budget().catch(() => ({ value: 'none' as LineBudget, credits: null }));
    if (budgetRefusal('poke', budget.value, budget.credits)) return skip('budget', budget.value);
    this.lastAt = now;
    const outcome = await this.deps.speak(id, roomReactionNote(changes)).catch((): PokeOutcome => 'error');
    if (outcome !== 'ok') return skip(reactionSkipFor(outcome), budget.value);
    clearUnseenBaseline(id);
    this.deps.report({ character_id: id, outcome: 'shown', changes: bucket, latency_ms: Math.max(0, this.deps.now() - now), budget: budget.value });
  }

  /** Tests. */
  get cooldownFrom(): number | null {
    return this.lastAt;
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isEditorSessionToken(t: unknown): t is string {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

let instance: RoomReactions | null = null;

function live(): RoomReactions {
  if (instance) return instance;
  instance = new RoomReactions({
    resident: (id) => seilinkEnabled() && seilinkResident() === id,
    live: (id) => seilinkLiveCharacter() === id,
    room: async (id) => {
      const p = await getRoomPayload(id);
      return p.pack ? { manifest: p.pack.manifest, state: p.state } : null;
    },
    lines: (id) => desktopLineState(id),
    budget: () => budgetInfo(Date.now()),
    speak: (id, note) => speakRoomReaction(id, note),
    report: (r) => {
      noteSeilinkCount(r.outcome === 'shown' ? 'react_shown' : `react_skip_${r.reason ?? 'error'}`);
      void loadAnalytics()
        .then((a) => a.capture(SEILINK_ROOM_REACTION_EVENT, { ...r }))
        .catch(() => {});
    },
    now: () => Date.now(),
  });
  return instance;
}

/** seilink:editor-session {phase: 'open'} from the companion editor. */
export function onRoomEditorOpened(token: string, characterId: string): void {
  live().opened(token, characterId);
}

/** seilink:editor-session {phase: 'close'}: the editor closed or its window went away. */
export function onRoomEditorClosed(token: string, together?: TogetherSeen | null): void {
  void live()
    .closed(token, together)
    .catch((err) => console.warn(`[seilink] room reaction failed: ${(err as Error).message}`));
}
