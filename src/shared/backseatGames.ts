/**
 * Backseat games (260929): games Sei supports by WATCHING, not by joining.
 *
 * Some games are asked for far more often than we can build a real adapter
 * for (Roblox first; 261115 added the games sei.gg has Backseat pages for). Backseat already works with any window,
 * but a player looking at the games picker has no way to know that, so a
 * backseat game is a picker tile that leads into the ordinary screen share
 * with three extras:
 *
 *   1. a one-time popup saying how it works (per account, backseatGamePref);
 *   2. an optional "which game are you playing?" step, when the game has a
 *      lookup provider (Roblox: its public game APIs, main-side);
 *   3. a knowledge block (plus the picked game's details) appended to the
 *      backseat contract, inside the cached prompt prefix.
 *
 * Adding a game is ONE entry in BACKSEAT_GAMES plus its tile image under
 * src/renderer/public/img/ (and zh strings for its copy). The catalog row,
 * the picker tile, the popup, the share-picker preselection and the prompt
 * block all derive from the entry. A lookup provider is optional: without one
 * the flow goes popup -> share and the prompt carries only the knowledge.
 *
 * Copy fields are the ENGLISH strings; the renderer passes them through t(),
 * so their zh translations live in the i18n dictionary keyed by the same
 * text. The knowledge block is model-facing and stays English (the language
 * directive already tells the companion what to SPEAK).
 */

/** Which main-side lookup provider backs a game's "pick your game" step. */
export type BackseatGameLookupKind = 'roblox';

export interface BackseatGameDef {
  /** Catalog + analytics id ('roblox'). Never shown. */
  id: string;
  /** Proper name ("Roblox"): popup title, share hint, prompt. */
  name: string;
  /** Picker tile label ("Roblox (Backseat)"). */
  tileName: string;
  /** Other names players type for it (see GameCatalogEntry.aliases). */
  aliases?: readonly string[];
  /** Tile + info popup art, renderer-relative (served from public/). */
  image: string;
  /** Info popup body (English, `{name}` = the companion). */
  tileDescription: string;
  /** The one-time popup's copy (English). */
  introCopy: string;
  /**
   * Window titles of the game's own app, for preselecting it in the share
   * picker. Matched case-insensitively; see pickHintedSource.
   */
  windowNames: readonly string[];
  /** Model-facing knowledge block, appended to the backseat contract. */
  knowledge: string;
  /** Optional provider for the "pick your game" step. */
  lookup?: BackseatGameLookupKind;
  /**
   * 261004: skip the share picker. Opening this game assumes the player is
   * sharing the game itself, so the session waits for its window (see
   * windowNames) and starts capturing it on its own, pausing again whenever
   * the window closes. The picker stays one tap away for anything else.
   */
  autoShare?: boolean;
}

/**
 * What the player picked, as it crosses IPC into backseatStart. Only ids: main
 * fetches (or reads from its cache) the game's details itself, so nothing the
 * renderer sends is ever pasted into the prompt.
 */
export interface BackseatGameSelection {
  gameId: string;
  /** Roblox universe id of the picked experience, when one was picked. */
  universeId?: number;
}

/** One experience as the pick step shows it (and main's prompt reads it). */
export interface BackseatGameInfo {
  universeId: number;
  /** The place the link opens (rootPlaceId). */
  placeId?: number;
  name: string;
  creator?: string;
  /** Players online right now, when the source reported it. */
  playing?: number;
  /** Icon URL on Roblox's CDN (rbxcdn), when one resolved. */
  iconUrl?: string;
  /** A 16:9 screenshot on Roblox's CDN (rbxcdn), when one resolved. The pick
   *  step's cards lead with it; the icon is the fallback. */
  thumbnailUrl?: string;
  /** Present once full details were fetched (link paste, or on select). */
  genre?: string;
  description?: string;
  maxPlayers?: number;
  visits?: number;
  creatorType?: 'User' | 'Group';
}

/** How the pick step resolved what the player typed. */
export type BackseatGameResolveResult =
  | { kind: 'game'; game: BackseatGameInfo }
  | {
      kind: 'results';
      results: BackseatGameInfo[];
      /** Roblox search was unavailable (rate limit, network) and these are
       *  matches from the popular list instead, possibly none. */
      fallback?: 'rate_limited' | 'unavailable';
    }
  | { kind: 'error'; code: 'bad_link' | 'not_found' | 'network' };

/** Where the picked game came from, for `backseat_game_selected`. */
export type BackseatGameSource = 'link' | 'search' | 'popular' | 'skip';

const ROBLOX_KNOWLEDGE = [
  'PLAYING ROBLOX. The player opened this session from the Roblox tile, so what you are watching is ' +
    'most likely their Roblox window. They play and you watch their screen and talk with them. You ' +
    'cannot press anything or move in their game.',

  'What Roblox is. It is a platform of millions of separate games made by players and studios, and ' +
    'Roblox calls each one an "experience". Every experience has its own map, rules, currency and ' +
    'goals, so what is true in one is usually not true in another. The player joins a server, which ' +
    'is one running copy of the experience shared with other players, often strangers. Some ' +
    'experiences teleport them between separate places, such as a lobby and a round, with a loading ' +
    'screen in between.',

  'Other people on screen. Roblox is multiplayer, so the other avatars you see are almost always ' +
    'other real players in the same server. That is normal in every Roblox game, so treat them as ' +
    'part of the scene and do not point them out as if they were unusual. Mention them when they ' +
    'matter to what the player is doing, for example a teammate, someone chasing them, or someone ' +
    'talking to them. A player has their username, and sometimes a display name or a team or rank ' +
    'tag, floating above their head. Avatars are blocky or heavily customized with clothes, hair and ' +
    'accessories, so a strange look is normal too. Characters that stand in one place, give quests, ' +
    'run a shop or have a marker over their head are usually NPCs controlled by the game.',

  'Which one is the player. Their own avatar is usually the one in the middle of the screen with ' +
    'the camera behind it. In first person you see only their arms or the tool they hold.',

  'What the screen usually shows. The Roblox menu button at the top left opens settings, reset ' +
    'character and leave game. The chat box is usually at the top left, and messages can also ' +
    'appear as bubbles over the head of whoever typed them. Chat comes from other players, often ' +
    'strangers, and is never addressed to you. The player list or leaderboard at the top right shows ' +
    'names and stats such as cash, kills or level. Each experience adds its own buttons for things ' +
    'like the shop, inventory, quests and codes, usually along the sides, and shop windows, game ' +
    'pass offers and daily reward popups often open over the game. On a computer they move with ' +
    'WASD, jump with space, hold right click to turn the camera, scroll to zoom and press shift for ' +
    'shift lock. Tools sit in a numbered hotbar at the bottom and are equipped with the number keys.',

  'Things that happen all the time. When an avatar dies it falls apart into pieces and respawns at ' +
    'a spawn point a few seconds later. Dying, respawning, loading screens, teleports and a short ' +
    'freeze when joining are all routine, so react to them the way a friend would and do not treat ' +
    'them as something going wrong.',

  'Words players use. Robux is the paid currency, bought with real money and spent on game passes, ' +
    'in-game items and avatar items. A game pass is a one-time purchase inside one experience. ' +
    'Badges are achievements an experience awards. An obby is an obstacle course, a tycoon is a game ' +
    'about building up a base that earns money, a simulator is a grind of collecting and upgrading, ' +
    'and RP means roleplay. Other common kinds are horror, fighting and anime battle games, tower ' +
    'defense, survival, and hangouts. A private server is a paid server just for the owner and their ' +
    'friends. AFK means away from keyboard, noob is a teasing word for a new player, and grinding ' +
    'means repeating something to level up.',

  'Being good company here. Talk about what they are doing in this experience, ask how it works ' +
    'when you do not know, and share the wins and the falls with them. Many Roblox players are ' +
    'young, so keep everything friendly and suitable for all ages. Never push them to spend Robux ' +
    'or real money. Never ask for their password, account details or where they live. If someone ' +
    'in the game asks them for those, or offers free Robux, tell them it is a scam.',
].join('\n\n');

/** The opening every backseat game's knowledge shares: who plays, who watches. */
function watching(name: string): string {
  return (
    `PLAYING ${name.toUpperCase()}. The player opened this session from the ${name} tile, so what ` +
    `you are watching is most likely their ${name} window. They play and you watch their screen ` +
    'and talk with them. You cannot press anything or move in their game.'
  );
}

/** What every story-heavy single-player game needs said once. */
const NO_SPOILERS =
  'Do not spoil story, bosses or places they have not reached unless they ask. When they are ' +
  'stuck, ask whether they want a tip before giving one. What you know about exact item ' +
  'locations and numbers can be wrong, so say when you are not sure.';

// 261115: the five games sei.gg has Backseat landing pages for. Kept short on
// purpose: the model already knows these games; the blocks say what the
// screen shows and how to be good company, which it cannot work out alone.

const ELDEN_RING_KNOWLEDGE = [
  watching('Elden Ring'),
  'What Elden Ring is. A single-player open-world action RPG by FromSoftware, set in the Lands ' +
    'Between. Fights are hard and dying is routine. When they die they drop the runes they carried ' +
    'and can win them back by reaching the spot where they fell. Sites of Grace are the checkpoints ' +
    'where they rest, level up and travel. A boss often takes many tries.',
  'What the screen usually shows. Health, focus and stamina bars at the top left, the rune count ' +
    'at the bottom right, equipped weapons and items at the bottom left, and a boss name and health ' +
    'bar along the bottom during a boss fight. Glowing messages on the ground were left by other ' +
    'players, and red bloodstains show where other players died. A golden or blue ghostly figure ' +
    'is a summon or a co-op player; a red one is an invader.',
  'Being good company here. React to close calls and deaths the way someone on the call would, ' +
    'notice when they keep dying to the same thing, and celebrate a boss going down. ' +
    NO_SPOILERS,
].join('\n\n');

const SILKSONG_KNOWLEDGE = [
  watching('Hollow Knight: Silksong'),
  'What Silksong is. A hard 2D action platformer by Team Cherry, the sequel to Hollow Knight. ' +
    'They play Hornet, climbing through the kingdom of Pharloom. Benches are where she rests and ' +
    'the game saves. Rosaries are the money; when she dies she leaves them behind and can get them ' +
    'back by returning to that spot. Silk fills as she hits enemies and is spent to heal. Characters ' +
    'speak in made-up sounds, so what they say is the text box on screen. Bosses and tricky jumps ' +
    'often take many tries.',
  'Being good company here. Notice the jump that keeps going wrong, react to the close calls, and ' +
    'cheer when a boss finally falls. What you know about this game may be thin, so go by the ' +
    'screen and say when you are unsure. ' +
    NO_SPOILERS,
].join('\n\n');

const VALHEIM_KNOWLEDGE = [
  watching('Valheim'),
  'What Valheim is. A survival and building game by Iron Gate, set in a Viking afterlife. They ' +
    'gather wood, stone and metal, build a base and boats, eat food to raise their health and ' +
    'stamina, and call up each boss at its altar with an offering. The world is made of biomes that ' +
    'get more dangerous as they go, from the Meadows and Black Forest to the Swamp, Mountains, Plains ' +
    'and beyond. Night is more dangerous than day. When they die they drop everything in a tombstone ' +
    'and have to go back for it. Up to ten players can share a world, so other Vikings on screen may ' +
    'be their friends.',
  'What the screen usually shows. The hotbar at the top left, health and the food they have eaten ' +
    'at the bottom left, and the minimap at the top right.',
  'Being good company here. Notice when it is getting dark or the weather turns, have opinions ' +
    'about what they build, and keep them company on the walk back to a tombstone. Version 1.0 is ' +
    'recent, so newer content may be thin in what you know: go by the screen and say when you are ' +
    'unsure.',
].join('\n\n');

const GENSHIN_KNOWLEDGE = [
  watching('Genshin Impact'),
  'What Genshin Impact is. A free-to-play open-world action RPG by HoYoverse, set in Teyvat. They ' +
    'control a party of four characters, switching between them in a fight and mixing elements into ' +
    'reactions. Wishes are the gacha: they spend Primogems on banners for characters and weapons, and ' +
    'pity guarantees a 5-star after enough pulls. Resin limits the rewards from domains and bosses. ' +
    'Daily commissions, events and the Archon Quest story are the usual things to do. Up to four ' +
    'players can share a world in co-op.',
  'What the screen usually shows. The minimap at the top left, the party list on the right, and ' +
    'the active character with their health along the bottom. Small numbers such as artifact stats ' +
    'are often too small for you to read, so ask them when it matters.',
  'Being good company here. Cheer or wince with them on a wish, notice the chest on the cliff they ' +
    'flew past, and talk about the story when they want to. Never push them to spend money on ' +
    'wishes. The game updates often, so new characters, regions and events may be newer than what ' +
    'you know: say when you are unsure.',
].join('\n\n');

const BACKROOMS_KNOWLEDGE = [
  watching('Escape the Backrooms'),
  'What Escape the Backrooms is. A co-op horror exploration game for one to four players, based on ' +
    'the internet legend of the Backrooms: endless empty rooms with yellow walls, damp carpet and ' +
    'buzzing lights. Each level has its own look, puzzle and way out, and in many of them entities ' +
    'hunt the players. There is no fighting back: hiding, running and listening are how they survive. ' +
    'Other players on screen are their teammates. The game has proximity voice chat, and some ' +
    'entities can hear voices.',
  'Being good company here. Help them keep track of where they have been, since every hallway ' +
    'looks the same, think through codes and notes with them, and react with them when something ' +
    'shows up. What you know about the newer levels can be wrong, so say when you are unsure.',
].join('\n\n');

/** Order is the picker's tile order (after the native games). */
export const BACKSEAT_GAMES: readonly BackseatGameDef[] = [
  {
    id: 'roblox',
    name: 'Roblox',
    tileName: 'Roblox (Backseat)',
    aliases: ['罗布乐思', 'ロブロックス', 'Роблокс'],
    // Original Sei art (261003): Sui watching a generic obby on a monitor,
    // generated from her own sprites. It replaced the Roblox press-kit render,
    // which Roblox's brand guidelines do not allow in a commercial product.
    // Keep it free of Roblox marks, avatars and experience art. The intro
    // popup reuses it.
    image: './img/game-roblox.jpg',
    tileDescription:
      'Play any Roblox game while {name} watches your screen and talks with you on a voice call.',
    introCopy:
      'Roblox is available via Backseat: your companion can watch you play through your screen.',
    windowNames: ['Roblox', 'Roblox Player'],
    knowledge: ROBLOX_KNOWLEDGE,
    lookup: 'roblox',
    autoShare: true,
  },
  // 261115: original Sei art for each (a scene in the sei.gg Backseat
  // illustration style), never the game's own key art or logo.
  {
    id: 'eldenring',
    name: 'Elden Ring',
    tileName: 'Elden Ring (Backseat)',
    aliases: ['艾尔登法环', '老头环', 'エルデンリング', 'Элден Ринг'],
    image: './img/game-eldenring.jpg',
    tileDescription:
      'Fight through the Lands Between while {name} watches your screen and talks with you on a voice call.',
    introCopy:
      'Elden Ring is available via Backseat: your companion can watch you play through your screen.',
    windowNames: ['ELDEN RING™', 'ELDEN RING'],
    knowledge: ELDEN_RING_KNOWLEDGE,
  },
  {
    id: 'silksong',
    name: 'Hollow Knight: Silksong',
    tileName: 'Silksong (Backseat)',
    aliases: ['Silksong', 'Hollow Knight Silksong', '丝之歌', '空洞骑士：丝之歌', 'シルクソング'],
    image: './img/game-silksong.jpg',
    tileDescription:
      'Climb through Pharloom as Hornet while {name} watches your screen and talks with you on a voice call.',
    introCopy:
      'Silksong is available via Backseat: your companion can watch you play through your screen.',
    windowNames: ['Hollow Knight Silksong', 'Hollow Knight: Silksong', 'Silksong'],
    knowledge: SILKSONG_KNOWLEDGE,
  },
  {
    id: 'valheim',
    name: 'Valheim',
    tileName: 'Valheim (Backseat)',
    aliases: ['英灵神殿', 'ヴァルヘイム', 'Вальхейм'],
    image: './img/game-valheim.jpg',
    tileDescription:
      'Build, sail and survive while {name} watches your screen and talks with you on a voice call.',
    introCopy:
      'Valheim is available via Backseat: your companion can watch you play through your screen.',
    windowNames: ['Valheim'],
    knowledge: VALHEIM_KNOWLEDGE,
  },
  {
    id: 'genshin',
    name: 'Genshin Impact',
    tileName: 'Genshin Impact (Backseat)',
    aliases: ['Genshin', '原神', 'Геншин'],
    image: './img/game-genshin.jpg',
    tileDescription:
      'Explore Teyvat and open your wishes while {name} watches your screen and talks with you on a voice call.',
    introCopy:
      'Genshin Impact is available via Backseat: your companion can watch you play through your screen.',
    windowNames: ['Genshin Impact', '原神'],
    knowledge: GENSHIN_KNOWLEDGE,
  },
  {
    id: 'backrooms',
    name: 'Escape the Backrooms',
    tileName: 'Escape the Backrooms (Backseat)',
    image: './img/game-backrooms.jpg',
    tileDescription:
      'Search for the way out while {name} watches your screen and talks with you on a voice call.',
    introCopy:
      'Escape the Backrooms is available via Backseat: your companion can watch you play through your screen.',
    windowNames: ['Escape the Backrooms', 'EscapeTheBackrooms'],
    knowledge: BACKROOMS_KNOWLEDGE,
  },
];

export function backseatGame(id: string | null | undefined): BackseatGameDef | undefined {
  return id ? BACKSEAT_GAMES.find((g) => g.id === id) : undefined;
}

export function isBackseatGameId(id: string | null | undefined): boolean {
  return !!backseatGame(id);
}

/** Browser names in a window title: a game's web page is not the game. */
const BROWSER_TITLE = /\b(chrome|chromium|safari|firefox|edge|opera|brave|arc|vivaldi)\b/i;

/**
 * The share-picker preselection: the source whose window title is the game's
 * app. An exact title (case-insensitive) wins; otherwise a title that contains
 * one of the names as a word, unless it looks like a browser tab (the game's
 * store page in Chrome is titled "... - Roblox - Google Chrome"). Windows
 * only: an entire-screen share is the player's call, never ours.
 */
export function pickHintedSource<T extends { id: string; name: string; kind: 'screen' | 'window' }>(
  sources: readonly T[],
  windowNames: readonly string[],
): T | null {
  if (!windowNames.length) return null;
  const windows = sources.filter((s) => s.kind === 'window');
  const norm = (s: string): string => s.trim().toLowerCase();
  const names = windowNames.map(norm);
  const exact = windows.find((s) => names.includes(norm(s.name)));
  if (exact) return exact;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`\\b(${names.map(escape).join('|')})\\b`, 'i');
  return windows.find((s) => word.test(s.name) && !BROWSER_TITLE.test(s.name)) ?? null;
}

// ── Roblox links ─────────────────────────────────────────────────────────

const ROBLOX_HOST = /^(?:www\.|web\.|m\.)?roblox\.com$/i;

/**
 * The place id in a Roblox game link, or null when the text is not one.
 *
 * Accepted: `roblox.com/games/<placeId>/<slug>` (with or without scheme,
 * www/web/m subdomain, a locale segment like `/de/games/...`, query or
 * fragment) and the launcher form `roblox.com/games/start?placeId=<id>`.
 * Not accepted: share links (`roblox.com/share?code=...`), which need an
 * authenticated call to resolve, and bare numbers, which are ambiguous with a
 * search for a game whose name is a number.
 */
export function parseRobloxLink(input: string): { placeId: number } | null {
  const raw = input.trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ROBLOX_HOST.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // Optional locale segment ("de", "pt-br") before /games/.
  const at = parts[0]?.toLowerCase() === 'games' ? 0 : parts[1]?.toLowerCase() === 'games' ? 1 : -1;
  if (at < 0) return null;
  const seg = parts[at + 1];
  const fromQuery = url.searchParams.get('placeId') ?? url.searchParams.get('placeid');
  const idText = seg && /^\d+$/.test(seg) ? seg : seg?.toLowerCase() === 'start' ? fromQuery : null;
  if (!idText || !/^\d{1,19}$/.test(idText)) return null;
  const placeId = Number(idText);
  if (!Number.isSafeInteger(placeId) || placeId <= 0) return null;
  return { placeId };
}

/** True when the text looks like an attempt at a link, for the pick step's
 *  error copy ("that is not a game link" rather than "no results"). */
export function looksLikeLink(input: string): boolean {
  return /^(https?:\/\/|www\.)|\.(com|gg|net|org)(\/|$)/i.test(input.trim());
}
