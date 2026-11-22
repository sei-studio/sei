/**
 * actionVerb â€” maps a bot tool call ({ name, args }) to a short present
 * progressive phrase for the roster/presence "now" line.
 *
 * Vocabulary mirrors the registered world actions in
 * src/bot/adapter/minecraft/registry.js; anything unrecognized falls back to
 * "adventuringâ€¦" so a new tool never breaks the UI. Returning null means
 * "show nothing" (momentary or invisible actions).
 *
 * Source: docs/design/UI-REDESIGN-PARTY.md Â§2.
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
    return line.replace(/\.{3}$/, 'â€¦');
  }
  const a = action.args;
  switch (action.name) {
    case 'follow':
      return t('following youâ€¦');
    case 'goTo':
      return t('heading somewhereâ€¦');
    case 'explore':
      return t('exploringâ€¦');
    case 'gather': {
      const item = argString(a, ['item', 'block', 'resource', 'name']);
      return item ? t('gathering {item}â€¦', { item }) : t('gatheringâ€¦');
    }
    case 'dig':
    case 'digIn':
      return t('diggingâ€¦');
    case 'build':
      return t('buildingâ€¦');
    case 'shelter':
      return t('building a shelterâ€¦');
    case 'placeBlock':
      return t('placing blocksâ€¦');
    case 'find': {
      const thing = argString(a, ['target', 'block', 'item', 'name', 'entity']);
      return thing ? t('looking for {thing}â€¦', { thing }) : t('looking aroundâ€¦');
    }
    case 'look':
      return t('looking aroundâ€¦');
    case 'equip':
      return t('gearing upâ€¦');
    case 'consumeItem':
      return t('having a snackâ€¦');
    case 'sleep':
      return t('sleepingâ€¦');
    case 'attackEntity': {
      const target = argString(a, ['entity', 'target', 'name']);
      return target ? t('fighting {target}â€¦', { target }) : t('fightingâ€¦');
    }
    case 'craft': {
      const item = argString(a, ['item', 'recipe', 'name']);
      return item ? t('crafting {item}â€¦', { item }) : t('craftingâ€¦');
    }
    case 'openFurnace':
    case 'smeltInput':
    case 'addFuel':
    case 'takeSmelted':
      return t('smeltingâ€¦');
    case 'openContainer':
    case 'depositItem':
    case 'withdrawItem':
      return t('rummaging through chestsâ€¦');
    case 'dropItem':
      return t('dropping itemsâ€¦');
    case 'pickup':
      return t('picking up itemsâ€¦');
    case 'readSign':
      return t('reading a signâ€¦');
    case 'activateItem':
    case 'activateBlock':
      return t('fiddling with somethingâ€¦');
    case 'unfollow':
    case 'setPvp':
      return null;
    // 260725: synthetic status-window verb (a player-message turn is being
    // processed). The MC dashboard's status window renders it; the roster
    // presence line stays quiet â€” "thinking" next to a chat avatar reads as
    // typing, which the typing indicator already covers.
    case 'thinking':
      return null;
    default:
      return t('adventuringâ€¦');
  }
}




