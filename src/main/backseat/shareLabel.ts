/**
 * What is on the shared surface, in one short line (260804).
 *
 * The companion was reading six frames and a transcript and having to infer,
 * every single look, whether it was watching a game, a film or someone
 * scrolling. It guessed wrong often enough to be worth fixing, and the fix is
 * almost free: the operating system already knows the title of the window, and
 * a title is the single highest-information string available about what a
 * screen is for. "Valorant" and "Dune: Part Two (2024) - Plex" need no
 * inference at all.
 *
 * Two cases, one answer:
 *
 *   a window share    that window's CURRENT title, re-read rather than the one
 *                     captured at pick time. Titles move: a browser tab switch
 *                     changes what is on screen completely while the source id
 *                     stays the same, which is exactly the case where a stale
 *                     label is worse than none.
 *   a screen share    the title of whatever is frontmost, for the same reason.
 *
 * On the frontmost window. There is no Electron API for it, and the platform
 * ones (NSWorkspace, System Events) are either unreachable from the main
 * process or gated behind an Automation permission prompt this feature has not
 * earned. desktopCapturer is neither: it is already how the picker works, so it
 * costs no new permission, and on macOS it is backed by
 * CGWindowListCopyWindowInfo with kCGWindowListOptionOnScreenOnly, which
 * returns windows front to back. The first entry that is not one of ours is
 * therefore the frontmost window. That is a documented ordering of the
 * underlying API rather than of Electron's wrapper, so it is a heuristic — but
 * a wrong answer here costs one slightly-off line, and the alternative was no
 * answer at all.
 *
 * Thumbnails are requested at zero size. Enumerating windows is cheap;
 * capturing a bitmap of every one of them is not, and this runs on a timer.
 */

/** What the prompt will carry. Long enough for a film title with a year on it,
 *  short enough that it can never crowd the note it rides in. */
const MAX_LABEL_CHARS = 70;

/** Our own windows are never the answer: on a whole-screen share Sei is often
 *  frontmost (the player just clicked the share button), and naming ourselves
 *  would tell the companion it is watching itself. */
const OURS = /^Sei($| [-—|])/;

function tidy(name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length <= MAX_LABEL_CHARS ? clean : `${clean.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

export async function readShareLabel(sourceId: string): Promise<string | null> {
  try {
    const { desktopCapturer } = await import('electron');
    const windows = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (!sourceId.startsWith('screen:')) {
      const hit = windows.find((s) => s.id === sourceId);
      // A shared window that has since closed: the session is about to end
      // anyway, and no label is better than the last one it had.
      return hit ? tidy(hit.name) : null;
    }
    const front = windows.find((s) => !OURS.test(s.name) && s.name.trim());
    return front ? tidy(front.name) : null;
  } catch {
    return null;
  }
}
