/**
 * actionVerb — maps a bot tool call ({ name, args }) to a short present
 * progressive phrase for the roster/presence "now" line.
 *
 * Vocabulary mirrors the registered world actions in
 * src/bot/adapter/minecraft/registry.js; anything unrecognized falls back to
 * "adventuring…" so a new tool never breaks the UI. Returning null means
 * "show nothing" (momentary or invisible actions).
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §2.
 */

import { t } from './i18n';

export interface BotAction {
  name: string | null;
  args?: Record<string, unknown>;
  ts: number;
}

function argString(args: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!args) return null;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase().replace(/_/g, ' ');
  }
  return null;
}

/**
 * Game adapters (M0, 260908): for a NON-Minecraft game the verb is the
 * dashboard `activity` line the bot already ships (lowercase, ends in "...");
 * the table below is Minecraft's vocabulary and stays the Minecraft path.
 */
export interface ActionVerbOpts {
  /** The session's game ('minecraft' when absent). */
  game?: string | null;
  /** The latest dashboard activity line for that character, if any. */
  activity?: string | null;
}

/** Phrase for a live action, or null when there is nothing to show. */
export function actionVerb(action: BotAction | undefined | null, opts?: ActionVerbOpts): string | null {
  if (!action || !action.name) return null;
  if (opts?.game && opts.game !== 'minecraft') {
    const line = (opts.activity ?? '').trim();
    if (!line || /^idl(e|ing)\b/i.test(line)) return null;
    // The bot's contract is a lowercase line ending in "..."; the presence
    // line uses the ellipsis glyph like every Minecraft verb.
    return line.replace(/\.{3}$/, '…');
  }
  const a = action.args;
  switch (action.name) {
    case 'follow':
      return t('following you…');
    case 'goTo':
      return t('heading somewhere…');
    case 'explore':
      return t('exploring…');
    case 'gather': {
      const item = argString(a, ['item', 'block', 'resource', 'name']);
      return item ? t('gathering {item}…', { item }) : t('gathering…');
    }
    case 'dig':
    case 'digIn':
      return t('digging…');
    case 'build':
      return t('building…');
    case 'shelter':
      return t('building a shelter…');
    case 'placeBlock':
      return t('placing blocks…');
    case 'find': {
      const thing = argString(a, ['target', 'block', 'item', 'name', 'entity']);
      return thing ? t('looking for {thing}…', { thing }) : t('looking around…');
    }
    case 'look':
      return t('looking around…');
    case 'equip':
      return t('gearing up…');
    case 'consumeItem':
      return t('having a snack…');
    case 'sleep':
      return t('sleeping…');
    case 'attackEntity': {
      const target = argString(a, ['entity', 'target', 'name']);
      return target ? t('fighting {target}…', { target }) : t('fighting…');
    }
    case 'craft': {
      const item = argString(a, ['item', 'recipe', 'name']);
      return item ? t('crafting {item}…', { item }) : t('crafting…');
    }
    case 'openFurnace':
    case 'smeltInput':
    case 'addFuel':
    case 'takeSmelted':
      return t('smelting…');
    case 'openContainer':
    case 'depositItem':
    case 'withdrawItem':
      return t('rummaging through chests…');
    case 'dropItem':
      return t('dropping items…');
    case 'readSign':
      return t('reading a sign…');
    case 'activateItem':
    case 'activateBlock':
      return t('fiddling with something…');
    case 'unfollow':
    case 'setPvp':
      return null;
    // 260725: synthetic status-window verb (a player-message turn is being
    // processed). The MC dashboard's status window renders it; the roster
    // presence line stays quiet — "thinking" next to a chat avatar reads as
    // typing, which the typing indicator already covers.
    case 'thinking':
      return null;
    default:
      return t('adventuring…');
  }
}
