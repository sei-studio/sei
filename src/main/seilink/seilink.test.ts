import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setUserDataOverride, paths } from '../paths';
import type { RoomPresetManifest } from '../../shared/seilinkRoom';
import { seilinkFileUrl } from '../../shared/seilinkPack';
import { __setPackRootsForTest, listPacks, loadPack, resolveSeilinkUrl } from './packs';
import { getRoomPayload, onRoomChange, roomSource, setRoomState } from './roomStore';

const CHAR = '0b9e7a62-3c1f-4d7e-9a55-2f4c8d1e6b10';

const manifest: RoomPresetManifest = {
  format: 'sei-room',
  version: 1,
  id: 'cozy',
  place: 'your bedroom',
  canvas: [640, 360],
  avatar: { x: 320, y: 360, height: 280 },
  slots: {
    shell: { z: 10, options: ['shell'] },
    curtains: { z: 20, options: ['curtains'] },
    rug: { z: 40, options: ['rug'], optional: true },
  },
  components: [
    { id: 'shell', slot: 'shell', name: 'room', frames: { day: { src: 'shell/day.webp' } } },
    { id: 'curtains', slot: 'curtains', name: 'curtains', tintable: true, frames: { day: { src: 'curtains/day.webp', mask: 'curtains/mask.webp' } } },
    { id: 'rug', slot: 'rug', name: 'round rug', frames: { day: { src: 'rug.webp' } } },
    { id: 'plant', slot: 'item', name: 'plant', placement: 'floor', frames: { day: { src: 'items/plant.webp' } } },
  ],
};

let tmp: string;
let root: string;

async function writePack(dir: string, m: RoomPresetManifest = manifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
  for (const rel of ['shell/day.webp', 'curtains/day.webp', 'curtains/mask.webp', 'rug.webp', 'items/plant.webp']) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), 'RIFF....WEBP');
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'seilink-'));
  root = path.join(tmp, 'packs');
  __setPackRootsForTest([{ dir: root, source: 'dev' }]);
  _setUserDataOverride(path.join(tmp, 'userData'));
});

afterEach(async () => {
  __setPackRootsForTest(null);
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('seilink packs', () => {
  it('loads a valid pack and serves only the files its manifest names', async () => {
    await writePack(path.join(root, 'cozy'));
    await writeFile(path.join(root, 'cozy', 'secret.webp'), 'x');
    const pack = await loadPack('cozy');
    expect(pack?.files.size).toBe(5);
    expect((await listPacks()).map((p) => p.id)).toEqual(['cozy']);
    const hit = await resolveSeilinkUrl(seilinkFileUrl(pack!, 'curtains/mask.webp'));
    expect(hit?.type).toBe('image/webp');
    expect(hit?.file.endsWith(path.join('curtains', 'mask.webp'))).toBe(true);
    expect(await resolveSeilinkUrl('sei-room://cozy/secret.webp')).toBeNull();
    expect(await resolveSeilinkUrl('sei-room://cozy/manifest.json')).toBeNull();
    expect(await resolveSeilinkUrl('sei-room://cozy/../../etc/passwd')).toBeNull();
    expect(await resolveSeilinkUrl('sei-room://gamer/shell/day.webp')).toBeNull();
    expect(await loadPack('../cozy')).toBeNull();
  });

  it('refuses a pack whose file is a symlink out of the pack dir', async () => {
    const dir = path.join(root, 'cozy');
    await writePack(dir);
    const outside = path.join(tmp, 'outside.webp');
    await writeFile(outside, 'x');
    await rm(path.join(dir, 'rug.webp'));
    await symlink(outside, path.join(dir, 'rug.webp'));
    expect(await loadPack('cozy')).toBeNull();
  });

  it('refuses a missing file, a mismatched id and a bad manifest', async () => {
    await writePack(path.join(root, 'cozy'));
    await rm(path.join(root, 'cozy', 'rug.webp'));
    expect(await loadPack('cozy')).toBeNull();
    await writePack(path.join(root, 'gamer'));
    expect(await loadPack('gamer')).toBeNull();
    await writePack(path.join(root, 'forest'), { ...manifest, id: 'forest', canvas: [0, 0] });
    expect(await loadPack('forest')).toBeNull();
  });

  it('re-checks containment per request after a file is swapped for a symlink', async () => {
    const dir = path.join(root, 'cozy');
    await writePack(dir);
    const pack = await loadPack('cozy');
    const outside = path.join(tmp, 'outside.webp');
    await writeFile(outside, 'x');
    await rm(path.join(dir, 'rug.webp'));
    await symlink(outside, path.join(dir, 'rug.webp'));
    expect(await resolveSeilinkUrl(seilinkFileUrl(pack!, 'rug.webp'))).toBeNull();
  });
});

describe('seilink room store', () => {
  it('gives the default room when there is no file, saves sanitized state, and notifies', async () => {
    await writePack(path.join(root, 'cozy'));
    const first = await getRoomPayload(CHAR);
    expect(first.state).toEqual({ version: 1, preset: 'cozy', time: 'auto', slots: {}, items: [], avatar: { kind: 'sei' } });
    expect(first.pack?.id).toBe('cozy');
    const seen: string[] = [];
    const off = onRoomChange((id) => seen.push(id));
    const saved = await setRoomState(CHAR, {
      version: 1,
      preset: 'cozy',
      time: 'night',
      slots: { curtains: { id: 'curtains', tint: '#AA3355' }, rug: { id: null }, shell: { id: 'nope' } },
      items: [{ id: 'plant', x: 100, y: 300 }, { id: 'shell', x: 1, y: 1 }],
      avatar: { kind: 'sei' },
    });
    off();
    expect(seen).toEqual([CHAR]);
    expect(saved.slots).toEqual({ curtains: { id: 'curtains', tint: '#aa3355' }, rug: { id: null } });
    expect(saved.items).toEqual([{ id: 'plant', x: 100, y: 300 }]);
    const onDisk = JSON.parse(await readFile(paths.seilinkRoomPath(CHAR), 'utf8'));
    expect(onDisk.time).toBe('night');
    const ctx = await roomSource.getRoom(CHAR);
    expect(ctx?.state.time).toBe('night');
    expect(ctx?.packDir.endsWith(path.join('packs', 'cozy'))).toBe(true);
  });

  it('has no room for the AI while the pack is missing, and refuses bad ids', async () => {
    expect(await roomSource.getRoom(CHAR)).toBeNull();
    expect((await getRoomPayload(CHAR)).pack).toBeNull();
    await expect(setRoomState(CHAR, { preset: 'cozy' })).rejects.toThrow(/SEILINK_PACK_MISSING/);
    await expect(setRoomState('../x', {})).rejects.toThrow(/SEILINK_BAD_ID/);
    expect(await roomSource.getRoom('../x')).toBeNull();
  });
});
