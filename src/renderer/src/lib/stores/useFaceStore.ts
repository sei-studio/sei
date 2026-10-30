/**
 * Face cues -> the expression each companion's FacepackView should show
 * (261028, facepack pilot).
 *
 * Main pushes a FaceCue for every companion line that led with an
 * `[expression]` tag (chat and voice) and for every in-game say() that set
 * `expression`. The cue must land when the LINE does, not when main decided
 * it: on a call a reply is generated well before its clip is audible, and a
 * typed reply is revealed with typing pacing. So:
 *
 *  - not on a call with that companion: apply on arrival (an `end` cue, a
 *    tag after the line, a moment later);
 *  - on a call: hold the cue until `useVoiceStore` reports the matching line
 *    audible (`lastSpoken` / `lastSpokenId` are set at the clip's first
 *    audible sample). A cue with no text (say() expression, tag-only line)
 *    goes with the companion's next audible line, or now if they are
 *    speaking already. Held cues expire after PENDING_TTL_MS.
 *
 * Nothing subscribes unless the facepack dev flag is on (`initFaceCues` is
 * only called by a mounted FacepackView host), so with the flag off this
 * store stays empty and costs nothing.
 */
import { create } from 'zustand';
import type { FaceCue } from '@shared/facepack';
import { sei } from '../ipcClient';
import { useVoiceStore } from './useVoiceStore';

export interface FaceEntry {
  expression: string;
  /** Bumped on every applied cue, so a repeat re-triggers decay timing. */
  seq: number;
}

interface FaceState {
  faces: Record<string, FaceEntry>;
  apply: (characterId: string, expression: string) => void;
  reset: () => void;
}

export const useFaceStore = create<FaceState>((set) => ({
  faces: {},
  apply: (characterId, expression) =>
    set((s) => ({
      faces: {
        ...s.faces,
        [characterId]: { expression, seq: (s.faces[characterId]?.seq ?? 0) + 1 },
      },
    })),
  reset: () => set({ faces: {} }),
}));

export const PENDING_TTL_MS = 30_000;
/** Off a call, a trailing tag lands this long after its line. */
export const END_CUE_DELAY_MS = 1_200;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether an audible line is the one a cue was emitted for. The audio side
 * may hold the whole line or one sentence of it, and both sides strip tags
 * slightly differently (spoken-register cleanup), so compare normalized
 * letters and accept containment either way or a shared 16-char opening.
 */
export function cueTextMatches(cueText: string, spoken: string): boolean {
  const a = norm(cueText);
  const b = norm(spoken);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const n = Math.min(16, a.length, b.length);
  return n >= 8 && a.slice(0, n) === b.slice(0, n);
}

interface Pending {
  cue: FaceCue;
  receivedAt: number;
  /** An `end` cue whose line is playing now: fires when the line stops. */
  armed?: boolean;
}

const pending = new Map<string, Pending[]>();
let started = false;
let offCue: (() => void) | undefined;
let offVoice: (() => void) | undefined;

function onCallWith(characterId: string): boolean {
  const v = useVoiceStore.getState();
  return v.participants.includes(characterId) && (v.status === 'live' || v.status === 'connecting');
}

function applyCue(cue: FaceCue): void {
  useFaceStore.getState().apply(cue.characterId, cue.expression);
}

function prune(list: Pending[], now: number): Pending[] {
  return list.filter((p) => now - p.receivedAt < PENDING_TTL_MS);
}

/** Exported for tests: route one cue. */
export function handleFaceCue(cue: FaceCue, now = Date.now()): void {
  if (!onCallWith(cue.characterId)) {
    if (cue.at === 'end') setTimeout(() => applyCue(cue), END_CUE_DELAY_MS);
    else applyCue(cue);
    return;
  }
  const v = useVoiceStore.getState();
  const speakingNow = v.speakingId === cue.characterId;
  if (cue.at === 'start' && speakingNow) {
    if (cue.text === null || (v.lastSpokenId === cue.characterId && cueTextMatches(cue.text, v.lastSpoken))) {
      applyCue(cue);
      return;
    }
  }
  const list = prune(pending.get(cue.characterId) ?? [], now);
  const entry: Pending = { cue, receivedAt: now };
  if (
    cue.at === 'end' &&
    speakingNow &&
    (cue.text === null || (v.lastSpokenId === cue.characterId && cueTextMatches(cue.text, v.lastSpoken)))
  ) {
    entry.armed = true;
  }
  list.push(entry);
  pending.set(cue.characterId, list);
}

/** Exported for tests: react to a voice-store change. */
export function onVoiceChange(
  next: { speakingId: string | null; lastSpoken: string; lastSpokenId: string | null },
  prev: { speakingId: string | null; lastSpoken: string; lastSpokenId: string | null },
  now = Date.now(),
): void {
  // Armed end cues fire when their speaker stops or moves to another line.
  for (const [id, list] of pending) {
    const stopped = prev.speakingId === id && next.speakingId !== id;
    const newLine = next.lastSpokenId === id && next.lastSpoken !== prev.lastSpoken;
    if (!stopped && !newLine) continue;
    const keep: Pending[] = [];
    for (const p of list) {
      if (p.armed) applyCue(p.cue);
      else keep.push(p);
    }
    pending.set(id, keep);
  }
  const id = next.speakingId;
  if (!id || next.lastSpokenId !== id) return;
  if (next.lastSpoken === prev.lastSpoken && prev.speakingId === id) return;
  const list = prune(pending.get(id) ?? [], now);
  // The first held cue that belongs to this line, starting cues first.
  const idx = list.findIndex(
    (p) => !p.armed && (p.cue.text === null || cueTextMatches(p.cue.text, next.lastSpoken)),
  );
  if (idx < 0) {
    pending.set(id, list);
    return;
  }
  // Cues queued before the match belong to lines that were never heard
  // (barged, dropped): skip them, they would flash for nothing.
  const rest = list.slice(idx);
  const hit = rest[0];
  const after = rest.slice(1);
  if (hit.cue.at === 'start') applyCue(hit.cue);
  else after.unshift({ ...hit, armed: true });
  // A trailing tag for the same line arms right away.
  for (const p of after) {
    if (!p.armed && p.cue.at === 'end' && p.cue.text !== null && cueTextMatches(p.cue.text, next.lastSpoken)) {
      p.armed = true;
    }
  }
  pending.set(id, after);
}

/** Subscribe to main's cue push. Idempotent; a no-op without the bridge. */
export function initFaceCues(): () => void {
  if (!started) {
    started = true;
    offCue = sei.onFaceCue?.((cue) => handleFaceCue(cue));
    offVoice = useVoiceStore.subscribe((s, p) => {
      if (s.speakingId === p.speakingId && s.lastSpoken === p.lastSpoken && s.lastSpokenId === p.lastSpokenId) return;
      onVoiceChange(s, p);
    });
  }
  return () => {
    // Stays subscribed for the window's life: several views may share it.
  };
}

/** Test seam. */
export function __resetFaceCues(): void {
  offCue?.();
  offVoice?.();
  offCue = undefined;
  offVoice = undefined;
  started = false;
  pending.clear();
  useFaceStore.getState().reset();
}
