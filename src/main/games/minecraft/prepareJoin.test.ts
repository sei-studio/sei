/**
 * 261027 lazy skins: a Minecraft launch waits for the character's first
 * Gemini skin, bounded, and never fails or blocks on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../lanWatcher', () => ({ watchLan: vi.fn() }));
vi.mock('../../skinGeneration', () => ({ ensureMinecraftSkin: h.ensure }));

import { createMinecraftGameModule, SKIN_PREPARE_WAIT_MS } from './index';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const ctx = { characterId: ID, character: {} as never };

beforeEach(() => {
  h.ensure.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('minecraft prepareJoin', () => {
  it('runs the skin step for the launching character and adds nothing to the join target', async () => {
    h.ensure.mockResolvedValue({ outcome: 'generated', skin: null });
    const mod = createMinecraftGameModule();
    await expect(mod.prepareJoin!(ctx)).resolves.toBeNull();
    expect(h.ensure).toHaveBeenCalledWith(ID);
  });

  it('gives up waiting after SKIN_PREPARE_WAIT_MS (the launch goes ahead)', async () => {
    vi.useFakeTimers();
    h.ensure.mockReturnValue(new Promise(() => {}));
    const mod = createMinecraftGameModule();
    let settled = false;
    const p = mod.prepareJoin!(ctx).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(SKIN_PREPARE_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeNull();
  });

  it('never throws when the skin step does', async () => {
    h.ensure.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = createMinecraftGameModule();
    await expect(mod.prepareJoin!(ctx)).resolves.toBeNull();
    warn.mockRestore();
  });
});




