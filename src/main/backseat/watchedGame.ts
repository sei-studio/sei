/**
 * Which game a Watch-together share is showing, as a CLOSED id (261031, T278,
 * PostHog audit fix 5).
 *
 * 93% of Watch-together hours carried no `game`: only a share started from a
 * game tile (Roblox) knew one. The OS already knows the shared window's title
 * (the picked source's name, and the renderer's shareLabel re-read on every
 * tick), so the title is matched against a fixed list of well-known games.
 * The title itself never leaves the machine: analytics gets an id from the
 * list below or a coarse kind (`video`, `browser`, `other`).
 *
 * Pure, no electron: watchedGame.test.ts.
 */

export type WatchedKind = 'game' | 'video' | 'browser' | 'other' | 'unknown';

export interface WatchedClass {
  kind: WatchedKind;
  /** Set when kind is 'game'. */
  game?: string;
}

/**
 * id → title pattern, matched against the normalized title (lower case, ™ ®
 * stripped, whitespace collapsed). Word-bounded so a game's name inside an
 * unrelated title ("rust - visual studio code") needs the anchored forms.
 * Order matters only where one name contains another (minecraft dungeons
 * before minecraft).
 */
const GAMES: ReadonlyArray<[string, RegExp]> = [
  ['minecraft_dungeons', /\bminecraft dungeons\b/],
  ['minecraft', /^minecraft\b|\bminecraft\* ?\d|\bminecraft (java|bedrock|launcher)\b/],
  ['roblox', /^roblox\b/],
  ['fortnite', /^fortnite\b/],
  ['valorant', /^valorant\b/],
  ['league_of_legends', /\bleague of legends\b/],
  ['counter_strike', /\bcounter-strike\b|^cs2$/],
  ['dota_2', /^dota 2\b/],
  ['apex_legends', /^apex legends\b/],
  ['overwatch', /^overwatch\b/],
  ['marvel_rivals', /^marvel rivals\b/],
  ['genshin_impact', /^genshin impact\b|^原神$/],
  ['honkai_star_rail', /^honkai: star rail\b|^崩坏：星穹铁道$/],
  ['zenless_zone_zero', /^zenless zone zero\b|^绝区零$/],
  ['wuthering_waves', /^wuthering waves\b|^鸣潮$/],
  ['rocket_league', /^rocket league\b/],
  ['pubg', /^pubg\b|\bplayerunknown's battlegrounds\b/],
  ['call_of_duty', /^call of duty\b/],
  ['rainbow_six_siege', /\brainbow six\b/],
  ['destiny_2', /^destiny 2\b/],
  ['the_finals', /^the finals\b/],
  ['deadlock', /^deadlock$/],
  ['helldivers_2', /^helldivers 2\b|^helldivers™ 2/],
  ['elden_ring', /^elden ring\b/],
  ['baldurs_gate_3', /^baldur's gate 3\b/],
  ['cyberpunk_2077', /^cyberpunk 2077\b/],
  ['gta_v', /^grand theft auto v\b/],
  ['red_dead_redemption_2', /^red dead redemption 2\b/],
  ['the_sims_4', /^the sims 4\b/],
  ['stardew_valley', /^stardew valley\b/],
  ['dont_starve_together', /^don't starve together\b/],
  ['terraria', /^terraria\b/],
  ['valheim', /^valheim\b/],
  ['palworld', /^palworld\b/],
  ['rust', /^rust$/],
  ['ark', /^ark: survival (ascended|evolved)\b/],
  ['satisfactory', /^satisfactory\b/],
  ['factorio', /^factorio\b/],
  ['rimworld', /^rimworld\b/],
  ['subnautica', /^subnautica\b/],
  ['lethal_company', /^lethal company\b/],
  ['repo', /^r\.e\.p\.o\.?$/],
  ['phasmophobia', /^phasmophobia\b/],
  ['content_warning', /^content warning\b/],
  ['among_us', /^among us\b/],
  ['dead_by_daylight', /^dead ?by ?daylight\b/],
  ['fall_guys', /^fall guys\b/],
  ['sea_of_thieves', /^sea of thieves\b/],
  ['warframe', /^warframe\b/],
  ['escape_from_tarkov', /^escape ?from ?tarkov\b/],
  ['world_of_warcraft', /^world of warcraft\b/],
  ['final_fantasy_xiv', /^final fantasy xiv\b/],
  ['path_of_exile', /^path of exile\b/],
  ['diablo', /^diablo (iv|iii|immortal)\b/],
  ['hearthstone', /^hearthstone\b/],
  ['monster_hunter', /^monster hunter\b/],
  ['hollow_knight', /^hollow knight\b/],
  ['hades', /^hades( ii)?$/],
  ['hogwarts_legacy', /^hogwarts legacy\b/],
  ['black_myth_wukong', /^black myth: wukong\b/],
  ['geometry_dash', /^geometry dash\b/],
  ['osu', /^osu!/],
  ['the_binding_of_isaac', /\bbinding of isaac\b/],
  ['cult_of_the_lamb', /^cult of the lamb\b/],
  ['slay_the_spire', /^slay the spire\b/],
  ['balatro', /^balatro\b/],
  ['euro_truck_simulator_2', /^euro truck simulator 2\b/],
  ['pokemon', /\bpok[eé]mon\b/],
];

/** Video services: a film or a stream, whatever app or tab plays it. */
const VIDEO = /\b(youtube|netflix|twitch|disney\+|prime video|crunchyroll|plex|hulu|hbo max|vlc media player|bilibili)\b/;

/** Browser names in a title (same list as shared/backseatGames BROWSER_TITLE). */
const BROWSER = /\b(chrome|chromium|safari|firefox|edge|opera|brave|arc|vivaldi)\b/;

/** Generic whole-screen source names: not a title at all. */
const SCREEN_SOURCE = /^(entire screen|screen \d+|display \d+|built-in.*display|整个屏幕|屏幕 ?\d+)$/;

export function normalizeTitle(title: string): string {
  return title
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Classify one window title. null / empty / a bare screen name → 'unknown'. */
export function classifyWatched(title: string | null | undefined): WatchedClass {
  const t = normalizeTitle(title ?? '');
  if (!t || SCREEN_SOURCE.test(t)) return { kind: 'unknown' };
  if (VIDEO.test(t)) return { kind: 'video' };
  const browser = BROWSER.test(t);
  if (!browser) {
    for (const [id, re] of GAMES) if (re.test(t)) return { kind: 'game', game: id };
  }
  return { kind: browser ? 'browser' : 'other' };
}

/** Every id the classifier can return, for tests and dashboards. */
export const WATCHED_GAME_IDS: readonly string[] = GAMES.map(([id]) => id);

/**
 * What one session watched: counts per class across its labels, so the
 * session-level answer is the most frequent one (a share that sat on the
 * launcher for ten seconds and on the game for an hour is the game).
 */
export class WatchedTally {
  private readonly counts = new Map<string, number>();

  note(title: string | null | undefined): void {
    const c = classifyWatched(title);
    if (c.kind === 'unknown') return;
    const key = c.kind === 'game' ? `game:${c.game}` : c.kind;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** The most frequent class; a game beats a tie. 'unknown' when nothing was seen. */
  top(): WatchedClass {
    let best: string | null = null;
    let bestN = 0;
    for (const [key, n] of this.counts) {
      if (n > bestN || (n === bestN && key.startsWith('game:') && !best?.startsWith('game:'))) {
        best = key;
        bestN = n;
      }
    }
    if (!best) return { kind: 'unknown' };
    if (best.startsWith('game:')) return { kind: 'game', game: best.slice(5) };
    return { kind: best as WatchedKind };
  }
}

/** Analytics props: `game` (tile id wins, else the detected id) + `watched_kind` + `game_source`. */
export function watchedProps(tileGameId: string | null, watched: WatchedClass): Record<string, string> {
  if (tileGameId) return { game: tileGameId, game_source: 'tile', watched_kind: 'game' };
  if (watched.kind === 'game' && watched.game) return { game: watched.game, game_source: 'title', watched_kind: 'game' };
  return { watched_kind: watched.kind };
}
