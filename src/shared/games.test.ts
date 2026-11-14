import { describe, it, expect } from 'vitest';
import { GAME_CATALOG, renderGamesDirective } from './games';

describe('game catalog', () => {
  it('names every playable game and marks who opens it', () => {
    const text = renderGamesDirective();
    for (const g of GAME_CATALOG.filter((x) => x.available)) {
      expect(text).toContain(g.promptName ?? g.name);
    }
    // The failure this whole block exists to fix: the character believed
    // Minecraft was the only thing it could play.
    expect(text).toContain('Chess');
    expect(text).toContain('Draw!');
    // The player opens ALL of them from the picker, Minecraft included; the
    // split the prompt draws is only about what she can start unprompted.
    expect(text).toMatch(/The player starts any of them/);
    expect(text).toMatch(/Minecraft you can also start yourself/);
  });

  it('names coming-soon games but marks them unavailable', () => {
    const text = renderGamesDirective();
    const soon = GAME_CATALOG.filter((x) => !x.available);
    expect(soon.length).toBeGreaterThan(0);
    for (const g of soon) expect(text).toContain(g.name);
    expect(text).toMatch(/Not out yet/);
  });

  it('previews Factorio and Terraria as coming soon, and has no Focus tile (261115)', () => {
    const soon = GAME_CATALOG.filter((x) => !x.available).map((g) => g.id);
    expect(soon).toEqual(['factorio', 'terraria']);
    expect(GAME_CATALOG.find((g) => g.id === 'focus')).toBeUndefined();
    const text = renderGamesDirective();
    expect(text).toContain('Not out yet, mention only if asked: Factorio, Terraria.');
    // Only the "not out yet" line names them: never the playable lists.
    const playable = text.split('\n').filter((l) => !l.startsWith('Not out yet'));
    expect(playable.join('\n')).not.toMatch(/Factorio|Terraria/);
  });

  it('names a backseat game as watched, not joined (260929)', () => {
    const roblox = GAME_CATALOG.find((g) => g.id === 'roblox');
    expect(roblox).toMatchObject({ name: 'Roblox (Backseat)', available: true, backseat: true });
    expect(roblox?.selfLaunch).toBeUndefined();
    // The tile says "Backseat", which means nothing to the model; the prompt
    // says how the two of them actually play it, once, on its own line (261115).
    const line = renderGamesDirective()
      .split('\n')
      .find((l) => l.startsWith('By screen share'));
    expect(line).toBe(
      'By screen share, where they play and you watch: Roblox, Elden Ring, Hollow Knight: Silksong, ' +
        'Valheim, Genshin Impact, Escape the Backrooms.',
    );
    expect(renderGamesDirective()).not.toContain('(Backseat)');
  });

  it('only Minecraft is self-launchable — the launch tool takes nothing else', () => {
    expect(GAME_CATALOG.filter((g) => g.selfLaunch).map((g) => g.id)).toEqual(['minecraft']);
  });

  it('is titles only, and stays small enough to sit in every cached prompt', () => {
    // Six lines, no descriptions: the character knows what chess is, and
    // explaining it would be paid for on every cached turn of every chat and
    // call. If this grows, it is because someone started describing games.
    // (261115: 400 -> 560 for the line of six screen-share titles.)
    const text = renderGamesDirective();
    expect(text.split('\n')).toHaveLength(6);
    expect(text.length).toBeLessThan(560);
  });
});
