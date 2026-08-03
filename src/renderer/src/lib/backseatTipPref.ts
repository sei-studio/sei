/**
 * backseatTipPref (260803) : the one-time "Backseat is here" tip's memory.
 *
 * Backseat is in beta and effectively undiscoverable: it is one more button in
 * a row of call controls that already has three. The tip points at that button
 * once, and then never again.
 *
 * WHY localStorage and not config.json. This is the established shape for a
 * one-time renderer UI flag (see gameLayoutPref, voice/modelPrefetch): reads
 * are defensive, writes are best effort, and a private-mode or quota failure
 * costs nothing worse than the tip showing again. config.json was rejected on
 * purpose: it carries a known stale-wholesale-save hazard (a screen that
 * writes back a whole config it read earlier can revert unrelated fields), and
 * a cosmetic tip is not worth exposing every other setting to that.
 *
 * ONE flag covers two ways of being done with the tip:
 *   - the player pressed "Got it";
 *   - the player shared a screen, by any route, at any time.
 * The second is the important one. The tip's only job is to say the feature
 * exists; someone who has already used it does not need to be told, and would
 * read the tip as the app not noticing what they just did. useBackseatStore's
 * share() sets the flag on every successful start, so this holds for the call
 * controls and the chat header alike.
 */

const KEY = 'sei.backseatTipDone';

/** True once the tip has been dismissed or the player has ever shared. */
export function backseatTipDone(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // No storage (private mode): treat it as not-done. The tip is dismissable
    // in-session either way, so the worst case is that it returns next launch.
    return false;
  }
}

/** Record that the tip is finished with. Idempotent, best effort. */
function setDone(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* private mode / quota: the tip just won't stay dismissed */
  }
}

/** "Got it" was pressed. */
export function dismissBackseatTip(): void {
  setDone();
}

/** A share started successfully, so the feature has been found. */
export function markBackseatShared(): void {
  setDone();
}

/**
 * Whether to render the tip right now. Pure so the predicate can be tested
 * without a DOM; CallControls passes its live values.
 *
 * `size` is here because CallControls renders at two sizes and only the
 * fullscreen one (lg) gets the tip. See the popover's comment in
 * CallControls.tsx.
 */
export function shouldShowBackseatTip(input: {
  /** backseatTipDone() at mount, or true once dismissed this session. */
  done: boolean;
  /** A share is already running. */
  sharing: boolean;
  /** The share button has a companion to share with (it is disabled without). */
  hasTarget: boolean;
  size: 'lg' | 'sm';
}): boolean {
  if (input.done) return false;
  if (input.sharing) return false;
  if (!input.hasTarget) return false;
  return input.size === 'lg';
}
