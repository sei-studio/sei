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
 * "GOT IT" IS THE ONLY THING THAT RETIRES IT (revised 260803). The first
 * version also retired the tip on any successful share, reasoning that someone
 * who had already found the feature would read the tip as the app not noticing
 * what they just did. Tried live, that was wrong in the one case that matters
 * most: everybody who used backseat in an earlier build had the flag written
 * the first time they shared, and so was never shown the announcement of the
 * thing they had been using. A beta notice is for exactly those people. It
 * costs one click to dismiss and it does not render over a running share, so
 * the cost of showing it to someone who already knows is close to nothing,
 * while the cost of the other error is that the notice reaches nobody.
 *
 * The key carries a version for the same reason. Bumping it re-announces to
 * everyone, including anyone the previous rule had already silenced, without
 * asking them to clear anything by hand.
 */

const KEY = 'sei.backseatTipDone.v2';

/** True once the player has dismissed the tip with "Got it". */
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
