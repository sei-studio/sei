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

/** Phrase for a live action, or null when there is nothing to show. */
export function actionVerb(action: BotAction | undefined | null): string | null {
  if (!action || !action.name) return null;
  const a = action.args;
  switch (action.name) {
    case 'follow':
      return 'following you…';
    case 'goTo':
      return 'heading somewhere…';
    case 'explore':
      return 'exploring…';
    case 'gather': {
      const item = argString(a, ['item', 'block', 'resource', 'name']);
      return item ? `gathering ${item}…` : 'gathering…';
    }
    case 'dig':
    case 'digIn':
      return 'digging…';
    case 'build':
      return 'building…';
    case 'shelter':
      return 'building a shelter…';
    case 'placeBlock':
      return 'placing blocks…';
    case 'find': {
      const thing = argString(a, ['target', 'block', 'item', 'name', 'entity']);
      return thing ? `looking for ${thing}…` : 'looking around…';
    }
    case 'look':
      return 'looking around…';
    case 'equip':
      return 'gearing up…';
    case 'consumeItem':
      return 'having a snack…';
    case 'sleep':
      return 'sleeping…';
    case 'attackEntity': {
      const target = argString(a, ['entity', 'target', 'name']);
      return target ? `fighting ${target}…` : 'fighting…';
    }
    case 'craft': {
      const item = argString(a, ['item', 'recipe', 'name']);
      return item ? `crafting ${item}…` : 'crafting…';
    }
    case 'openFurnace':
    case 'smeltInput':
    case 'addFuel':
    case 'takeSmelted':
      return 'smelting…';
    case 'openContainer':
    case 'depositItem':
    case 'withdrawItem':
      return 'rummaging through chests…';
    case 'dropItem':
      return 'dropping items…';
    case 'readSign':
      return 'reading a sign…';
    case 'activateItem':
    case 'activateBlock':
      return 'fiddling with something…';
    case 'unfollow':
    case 'setPvp':
      return null;
    default:
      return 'adventuring…';
  }
}
