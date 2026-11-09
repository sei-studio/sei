/**
 * Which layout the companion profile page uses (profile v2, product call
 * 261110: "the layout is ugly"). Two options were built side by side so they
 * can be compared on the same branch:
 *
 *   'a' (backdrop): the portrait bleeds off the right edge behind a scrim,
 *       one column on the left: name, byline, description, the actions,
 *       then the section menu and one tab.
 *   'b' (framed): the portrait is a framed panel on the left, a wide sheet
 *       on the right with the actions beside the name and the tabs below.
 *
 * DEFAULT_PROFILE_LAYOUT is what ships. In a dev build `?profilelayout=a|b`
 * overrides it (the screenshot harnesses, scripts/profile-shots.mjs).
 */
export type ProfileLayout = 'a' | 'b';

export const DEFAULT_PROFILE_LAYOUT: ProfileLayout = 'a';

export function profileLayout(): ProfileLayout {
  if (import.meta.env.DEV && typeof window !== 'undefined' && window.location) {
    try {
      const asked = new URLSearchParams(window.location.search).get('profilelayout');
      if (asked === 'a' || asked === 'b') return asked;
    } catch {
      /* no URL: the default */
    }
  }
  return DEFAULT_PROFILE_LAYOUT;
}
