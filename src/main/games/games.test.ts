/** Game adapters (M0, 260908): the GameModule registry + the Minecraft module. */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { watchLanSpy } = vi.hoisted(() => ({ watchLanSpy: vi.fn() }));
vi.mock('../lanWatcher', () => ({ watchLan: watchLanSpy }));

import { registerGameModule, getGameModule, listGameModules, clearGameModulesForTests } from './index';
import { createMinecraftGameModule } from './minecraft';

beforeEach(() => {
  clearGameModulesForTests();
  watchLanSpy.mockReset();
});

describe('registry', () => {
  it('registers and lists modules by id', () => {
    const mod = createMinecraftGameModule();
    expect(getGameModule('minecraft')).toBeNull();
    registerGameModule(mod);
    expect(getGameModule('minecraft')).toBe(mod);
    expect(listGameModules().map((m) => m.id)).toEqual(['minecraft']);
    expect(getGameModule('stardew')).toBeNull();
  });
});

describe('minecraft module', () => {
  it('wraps lanWatcher: tags states with game, exposes the join target, names collisions case-insensitively', async () => {
    let onUpdate: ((s: unknown) => void) | null = null;
    const stop = vi.fn();
    const checkNow = vi.fn(async () => ({ kind: 'open', port: 1234, motd: 'Fresh', lastSeenAt: 2 }));
    watchLanSpy.mockImplementation((opts: { onUpdate: (s: unknown) => void }) => {
      onUpdate = opts.onUpdate;
      return { stop, checkNow };
    });
    const mod = createMinecraftGameModule();
    expect(mod.displayName).toBe('Minecraft');
    expect(mod.getWorldState()).toEqual({ game: 'minecraft', kind: 'closed' });
    const ctx = { userConfig: { mc_username: ' steve ' } as never, skinServerBaseUrl: 'http://x' };
    expect(mod.getJoinTarget(ctx)).toBeNull();

    const pushed: unknown[] = [];
    mod.watcher.start({ onUpdate: (s) => pushed.push(s) });
    expect(watchLanSpy).toHaveBeenCalledTimes(1);
    mod.watcher.start({ onUpdate: (s) => pushed.push(s) }); // idempotent
    expect(watchLanSpy).toHaveBeenCalledTimes(1);
    onUpdate!({ kind: 'open', port: 25565, motd: 'A Minecraft Server', lastSeenAt: 1 });
    expect(pushed).toEqual([{ game: 'minecraft', kind: 'open', port: 25565, motd: 'A Minecraft Server', lastSeenAt: 1 }]);
    expect(mod.getJoinTarget(ctx)).toEqual({ port: 25565, motd: 'A Minecraft Server', mc_username: 'steve', skinServerBaseUrl: 'http://x' });

    expect(await mod.watcher.checkNow()).toEqual({ game: 'minecraft', kind: 'open', port: 1234, motd: 'Fresh', lastSeenAt: 2 });
    expect(mod.getWorldState().kind).toBe('open');
    mod.watcher.stop();
    expect(stop).toHaveBeenCalled();

    expect(mod.collides('Sui', 'sui')).toBe(true);
    expect(mod.collides('Sui', 'Marv')).toBe(false);
    expect(mod.effectiveUsername({ name: 'Sui!', username: null } as never)).toBe('Sui');
    expect(mod.joinTargetMissingError.error).toBe('LAN_NOT_OPEN');
    expect(mod.install).toBeUndefined();
  });
});
