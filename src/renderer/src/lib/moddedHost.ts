/**
 * Reads the bot's humanized MODDED_HOST_REJECTED message for ModdedHostModal
 * (261007). Pure, so it is tested without React.
 */

/**
 * The mods a Fabric registry-sync kick named, read back from the bot's
 * humanized message (connect.js humanizeReason: "The mods it names: a, b").
 * Ids only (the bot already filtered them), capped like the bot's list.
 */
export function namedMods(message: string | undefined): string[] {
  const m = /The mods it names: (.*?)\.?\s*$/.exec(message ?? '');
  if (!m) return [];
  return m[1]
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^[a-z0-9_.-]{2,64}$/.test(x))
    .slice(0, 6);
}

/** Did the bot's message say the host is Fabric (or Quilt)? */
export function messageSaysFabric(message: string | undefined): boolean {
  const m = message ?? '';
  return /\b(fabric|quilt)\b/i.test(m) && !/\b(forge|neoforge|fml)\b/i.test(m);
}
