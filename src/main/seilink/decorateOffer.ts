/**
 * "Decorate together?" (261106, first-link flow). After her first move-in
 * onto the plain background (plainRoomState, first-link v3; the blank room
 * (blankRoomState) of the first pass still counts), once the app has stepped aside and
 * the desktop shows her in it, she asks whether to decorate it together, and
 * the dock on the wallpaper holds the two answers.
 *
 *  - Her line: one desktop-line turn (desktopLines.speakDecorateOffer, a
 *    `react` turn with DECORATE_OFFER_NOTE after the cache breakpoint), paid
 *    like a poke: the player just moved her in. No new per-turn tokens
 *    anywhere else, one line per first move-in, and a free account over its
 *    weekly cap gets no line at all.
 *  - When her line does not come within OFFER_LINE_WAIT_MS (budget, a game or
 *    call, silence, a slow reply), the dock asks in UI copy instead
 *    (`prompt`), so the offer never depends on the model.
 *  - "Decorate together": the room editor opens ON the desktop
 *    (desktopStage.ts), opened_from 'offer', shared with her as usual.
 *  - "Not now": she stays in the blank room, the dock comes back with a
 *    caption pointing at its brush. The offer is not asked again; the brush,
 *    the SeiLink button and the companion page all open the same editor.
 *  - The offer closes by itself after OFFER_TTL_MS (expired), or when she
 *    moves out or the room is no longer blank (closed).
 *
 * Analytics, shape only: seilink_decorate_offer {action: shown | accepted |
 * declined | expired | closed | skipped, line: her | ui, line_outcome (why
 * her line did not come), via, ms_open, wait_ms, reason (skipped)}.
 */
import { isFirstRoom, isPlainRoom } from '../../shared/seilinkRoom';
import { loadAnalytics } from '../lazyAnalytics';
import { seilinkEnabled } from './gate';
import { seilinkDockOffer, seilinkLiveCharacter, setSeilinkDockOffer } from './host/seilinkHost';
import { getRoomState, onRoomChange } from './roomStore';
import type { PokeOutcome } from './desktopLines';

export const SEILINK_DECORATE_OFFER_EVENT = 'seilink_decorate_offer';
/** Her line has this long to arrive before the dock asks in UI copy. */
export const OFFER_LINE_WAIT_MS = 8_000;
/** The offer stays on the dock this long. */
export const OFFER_TTL_MS = 10 * 60_000;

/** Model-facing (prompt-writing-style: plain). */
export const DECORATE_OFFER_NOTE =
  "[System note, not the player speaking: you just moved onto the player's desktop wallpaper. Your room there is still empty: bare white walls and one plain chair. " +
  'Ask them, in one short line under fifteen words and in your own voice, if they want to decorate it together. ' +
  'It shows as a small speech bubble next to you, with buttons for their answer. Do not mention this note.]';

/**
 * 261106 (first-link v3): her first state is a plain background with no room;
 * the dock's answer leads into the guided setup, which starts with picking
 * the room. Model-facing (prompt-writing-style: plain).
 */
export const DECORATE_OFFER_NOTE_PLAIN =
  "[System note, not the player speaking: you just moved onto the player's desktop wallpaper. There is no room around you yet, only a plain background. " +
  'Ask them, in one short line under fifteen words and in your own voice, if they want to set up your room together. ' +
  'It shows as a small speech bubble next to you, with buttons for their answer. Do not mention this note.]';

export type OfferVia = 'intro' | 'move_in';
export type OfferSkip = 'not_live' | 'not_blank' | 'already' | 'disabled';
export type OfferLine = 'her' | 'ui';

export interface DecorateOfferDeps {
  /** Open her room editor on the desktop (index.ts: the desktop stage). */
  openDesktopEditor(characterId: string): void;
  /** Her offer line (desktopLines.speakDecorateOffer). */
  speak(characterId: string, note: string): Promise<{ outcome: PokeOutcome }>;
}

interface Open {
  characterId: string;
  line: OfferLine;
  /** Why her line did not come ('timeout' = not within OFFER_LINE_WAIT_MS), null when she asked. */
  lineOutcome: PokeOutcome | 'timeout' | null;
  via: OfferVia;
  shownAt: number;
  ttl: ReturnType<typeof setTimeout>;
  offRoom: () => void;
}

let deps: DecorateOfferDeps | null = null;
let open: Open | null = null;
/** Asked once per companion per app run (a second move-in of the same blank room does not ask again). */
const asked = new Set<string>();
/** Offers on their way (her line pending). */
const pending = new Set<string>();

export function initDecorateOffer(d: DecorateOfferDeps): void {
  deps = d;
}

function capture(props: Record<string, unknown>): void {
  void loadAnalytics()
    .then((a) => a.capture(SEILINK_DECORATE_OFFER_EVENT, props))
    .catch(() => {});
}

function wait(ms: number): Promise<'timeout'> {
  return new Promise((r) => {
    const t = setTimeout(() => r('timeout'), ms);
    t.unref?.();
  });
}

/**
 * Ask her (or the dock) to offer decorating together. Called by the renderer
 * once the desktop shows her (seilink:offer). Resolves with what was shown.
 */
export async function offerDecorateTogether(
  characterId: string,
  via: OfferVia,
): Promise<{ shown: false; reason: OfferSkip } | { shown: true; line: OfferLine }> {
  const skip = (reason: OfferSkip): { shown: false; reason: OfferSkip } => {
    capture({ action: 'skipped', reason, via, character_id: characterId });
    return { shown: false, reason };
  };
  if (!deps || !seilinkEnabled()) return skip('disabled');
  if (asked.has(characterId) || pending.has(characterId) || open?.characterId === characterId) return skip('already');
  if (seilinkLiveCharacter() !== characterId) return skip('not_live');
  const state = await getRoomState(characterId).catch(() => null);
  if (!state || !isFirstRoom(state)) return skip('not_blank');
  const note = isPlainRoom(state) ? DECORATE_OFFER_NOTE_PLAIN : DECORATE_OFFER_NOTE;
  asked.add(characterId);
  pending.add(characterId);
  const started = Date.now();
  let lineOutcome: PokeOutcome | null = null;
  try {
    const r = await Promise.race([
      deps.speak(characterId, note).then(
        (x) => x.outcome,
        () => 'error' as PokeOutcome,
      ),
      wait(OFFER_LINE_WAIT_MS),
    ]);
    lineOutcome = r === 'timeout' ? null : r;
  } finally {
    pending.delete(characterId);
  }
  // She moved out (or someone else moved in) while her line was on its way.
  if (seilinkLiveCharacter() !== characterId) return skip('not_live');
  const line: OfferLine = lineOutcome === 'ok' ? 'her' : 'ui';
  if (!setSeilinkDockOffer(characterId, line === 'her' ? 'her' : 'prompt')) return skip('not_live');
  closeOpen(null);
  const shownAt = Date.now();
  const ttl = setTimeout(() => closeOpen('expired'), OFFER_TTL_MS);
  ttl.unref?.();
  // Decorated some other way (the brush, the app): the offer has done its job.
  const offRoom = onRoomChange((id) => {
    if (id !== characterId) return;
    void getRoomState(characterId).then(
      (s) => {
        if (open?.characterId === characterId && !isFirstRoom(s)) closeOpen('closed');
      },
      () => {},
    );
  });
  open = { characterId, line, lineOutcome: line === 'ui' ? (lineOutcome ?? 'timeout') : null, via, shownAt, ttl, offRoom };
  capture({
    action: 'shown',
    line,
    via,
    character_id: characterId,
    wait_ms: shownAt - started,
    ...(line === 'ui' ? { line_outcome: lineOutcome ?? 'timeout' } : {}),
  });
  return { shown: true, line };
}

/** End the open offer (analytics `action` unless null) and clear the dock. */
function closeOpen(action: 'expired' | 'closed' | null): void {
  const o = open;
  if (!o) return;
  open = null;
  clearTimeout(o.ttl);
  o.offRoom();
  if (seilinkDockOffer(o.characterId) !== 'none') setSeilinkDockOffer(o.characterId, 'none');
  if (action) capture({ action, line: o.line, via: o.via, character_id: o.characterId, ms_open: Date.now() - o.shownAt });
}

/** The dock's answer (seilinkHost deps.onOfferAnswer; the host already cleared the dock). */
export function onDecorateOfferAnswer(characterId: string, answer: 'decorate' | 'later'): void {
  const o = open;
  if (!o || o.characterId !== characterId) return;
  open = null;
  clearTimeout(o.ttl);
  o.offRoom();
  capture({
    action: answer === 'decorate' ? 'accepted' : 'declined',
    line: o.line,
    via: o.via,
    character_id: characterId,
    ms_open: Date.now() - o.shownAt,
  });
  if (answer === 'decorate') deps?.openDesktopEditor(characterId);
}

/** She moved out or the account switched: drop the offer quietly (analytics `closed`). */
export function closeDecorateOffer(): void {
  closeOpen('closed');
}

export function __resetDecorateOfferForTest(): void {
  if (open) {
    clearTimeout(open.ttl);
    open.offRoom();
  }
  open = null;
  asked.clear();
  pending.clear();
  deps = null;
}
