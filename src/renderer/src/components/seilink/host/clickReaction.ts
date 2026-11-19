/**
 * Her reaction to a click on the desktop (261119, product call 261119: "clicking
 * her bounces too much, and twice"). The host sends `press` the moment a button
 * goes down on her and `poke` 'click' once the double-click time has passed, and
 * each had its own animation: a 4-5% squash, then a hop of up to 18 px. Now a
 * click gets ONE slight reaction, a character noticing it rather than a button
 * being pressed: about a 1% settle toward her feet and back, 280 ms.
 *
 *  - the press reacts at once (the click feels seen);
 *  - the click that follows a press does not react again;
 *  - a click with no press before it (a bridge without presses) reacts;
 *  - a press or click while a reaction still plays is ignored (no restart, no pile-up).
 *
 * Pure (the caller passes the time), so the rules are tested without a DOM.
 */

/** One reaction's length (ms). */
export const CLICK_REACT_MS = 280;

/** The reaction, about her feet (transform-origin 50% 100%), added onto her figure's own transform. */
export const CLICK_REACT_KEYFRAMES: Keyframe[] = [
  { transform: 'scale(1, 1)' },
  { transform: 'scale(1.005, 0.99)', offset: 0.35 },
  { transform: 'scale(1, 1)' },
];

/** A click this soon after a press is the same click: the press already reacted. */
export const PRESS_COVERS_CLICK_MS = 1_500;

export class ClickReaction {
  private lastAt = -Infinity;
  private pressAt = -Infinity;

  /** A button went down on her. True: play the reaction now. */
  press(now: number): boolean {
    this.pressAt = now;
    return this.fire(now);
  }

  /** The host classified a click. True: play the reaction now (only when no press covered it). */
  click(now: number): boolean {
    if (now - this.pressAt < PRESS_COVERS_CLICK_MS) return false;
    return this.fire(now);
  }

  private fire(now: number): boolean {
    if (now - this.lastAt < CLICK_REACT_MS) return false;
    this.lastAt = now;
    return true;
  }
}
