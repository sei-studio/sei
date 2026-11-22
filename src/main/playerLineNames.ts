/**
 * 261014 (review): the names the Home card's player line is checked against
 * before it is stored (nextStep.js playerLineProblem): the companion's name,
 * which the line may use, and the player's names, which it must not (a line
 * that names the player in the third person is the companion's own note).
 * Never throws: a name that cannot be read is left out, which only makes the
 * check more lenient.
 */
export interface PlayerLineNames {
  character: string | null;
  players: string[];
}

export async function readPlayerLineNames(characterId: string): Promise<PlayerLineNames> {
  const [character, players] = await Promise.all([
    import('./characterStore')
      .then(({ getCharacter }) => getCharacter(characterId))
      .then((c) => c?.name ?? null)
      .catch(() => null),
    import('./configStore')
      .then(({ loadConfig }) => loadConfig())
      .then((cfg) => [cfg.preferred_name, cfg.mc_username].filter((n): n is string => typeof n === 'string' && !!n.trim()))
      .catch(() => [] as string[]),
  ]);
  return { character, players };
}




