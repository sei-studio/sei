/**
 * The games catalog — one list, read by both sides (260730).
 *
 * It used to exist only in the renderer (lib/games.ts, the "Play together"
 * picker tiles), so the character had no idea any of it existed: the only game
 * named anywhere in a chat/voice prompt was Minecraft, via the launch tool and
 * the world-status line. Live, a companion asked to play something else would
 * say Minecraft was all it could do, months after chess and Draw! shipped.
 *
 * So the FACTS live here (id, name, whether it is playable yet, who can start
 * it) and both consumers derive from them: the picker adds tile art plus its
 * localized description, and `renderGamesDirective()` turns the same rows into
 * the prompt block. Adding a game to this list is all it takes for the
 * companion to know about it.
 *
 * The prompt block is TITLES ONLY, deliberately. What a character needs is to
 * know a game exists and who opens it; it knows what chess is, and a sentence
 * describing Draw! to it would be paid for on every cached turn for no gain.
 */

export interface GameCatalogEntry {
  id: string;
  /** Proper name, shown in the picker and spoken by the companion. */
  name: string;
  /** Playable today. False = a coming-soon tile / a game to mention, not offer. */
  available: boolean;
  /**
   * The companion can start this one ITSELF (the `launch` tool). The player
   * can open every game from the picker regardless; this is only about what
   * she can do unprompted, and the prompt has to say it or she offers to open
   * a chess board she has no tool for.
   */
  selfLaunch?: boolean;
}

/** Order is the picker's tile order. */
export const GAME_CATALOG: GameCatalogEntry[] = [
  { id: 'minecraft', name: 'Minecraft', available: true, selfLaunch: true },
  { id: 'chess', name: 'Chess', available: true },
  { id: 'draw', name: 'Draw!', available: true },
  // 260803: no "Backseat" entry. Sharing your screen is not a game and it does
  // not belong in a grid beside chess, so it lives on the call controls' share
  // button instead. The companion still knows it can be shown a screen: that is
  // in the voice primer, where it can say something useful about it.
  { id: 'stardew', name: 'Stardew Valley', available: false },
  { id: 'dontstarve', name: "Don't Starve Together", available: false },
  { id: 'focus', name: 'Focus', available: false },
];

/**
 * The # GAMES lines (chat + voice), appended to the static surface block.
 *
 * Coming-soon games are named too, deliberately: asked "what else could we
 * do", a companion that knows what is coming can answer the question it is
 * actually being asked. They are marked as not out so it never offers one.
 */
export function renderGamesDirective(): string {
  const named = (list: GameCatalogEntry[]): string => list.map((g) => g.name).join(', ');
  const live = GAME_CATALOG.filter((g) => g.available);
  const soon = GAME_CATALOG.filter((g) => !g.available);
  const mine = live.filter((g) => g.selfLaunch);
  const theirs = live.filter((g) => !g.selfLaunch);
  const lines = ['# GAMES', `Games you and the player can play in this app: ${named(live)}.`];
  if (theirs.length) {
    lines.push(
      'The player starts any of them from the games menu beside the chat box. ' +
        (mine.length
          ? `${named(mine)} you can also start yourself; ${named(theirs)} you cannot, so suggest ` +
            'rather than offering to open one.'
          : `You cannot open ${named(theirs)} yourself, so suggest rather than offering to.`),
    );
  }
  if (soon.length) lines.push(`Not out yet, mention only if asked: ${named(soon)}.`);
  lines.push('Never invent a game beyond these.');
  return lines.join('\n');
}
