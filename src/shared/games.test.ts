import { describe, it, expect } from 'vitest';
import { GAME_CATALOG, renderGamesDirective } from './games';

describe('game catalog', () => {
  it('names every playable game and marks who opens it', () => {
    const text = renderGamesDirective();
    for (const g of GAME_CATALOG.filter((x) => x.available)) {
      expect(text).toContain(g.name);
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

  it('only Minecraft is self-launchable — the launch tool takes nothing else', () => {
    expect(GAME_CATALOG.filter((g) => g.selfLaunch).map((g) => g.id)).toEqual(['minecraft']);
  });

  it('is titles only, and stays small enough to sit in every cached prompt', () => {
    // Five lines, no descriptions: the character knows what chess is, and
    // explaining it would be paid for on every cached turn of every chat and
    // call. If this grows, it is because someone started describing games.
    const text = renderGamesDirective();
    expect(text.split('\n')).toHaveLength(5);
    expect(text.length).toBeLessThan(400);
  });
});
