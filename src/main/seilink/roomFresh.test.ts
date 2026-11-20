/**
 * 261105 (T335): the room a chat or call turn reads is the room as saved now,
 * never a copy cached from before an edit, and room edits she did not react
 * to reach that turn once.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setUserDataOverride } from '../paths';
import type { RoomPresetManifest } from '../../shared/seilinkRoom';
import { __setPackRootsForTest } from './packs';
import { getRoomPayload, roomSource, setRoomState } from './roomStore';
import { __setSeilinkEnabledForTest, setSeilinkResident } from './gate';
import { roomForSurface, roomPromptLine, setRoomSource } from './roomContext';
import { __resetUnseenForTest, keepUnseenBaseline, roomChangeTurnNote } from './roomChangeNote';

const CHAR = '0b9e7a62-3c1f-4d7e-9a55-2f4c8d1e6b10';

function manifest(id: 'cozy' | 'gamer', place: string): RoomPresetManifest {
  return {
    format: 'sei-room',
    version: 1,
    id,
    place,
    canvas: [640, 360],
    avatar: { x: 320, y: 360, height: 280 },
    slots: { shell: { z: 10, options: ['shell'] }, curtains: { z: 20, options: ['curtains'] } },
    components: [
      { id: 'shell', slot: 'shell', name: 'room', frames: { day: { src: 'shell/day.webp' } } },
      { id: 'curtains', slot: 'curtains', name: 'curtains', tintable: true, frames: { day: { src: 'curtains/day.webp', mask: 'curtains/mask.webp' } } },
    ],
  };
}

let tmp: string;

async function writePack(dir: string, m: RoomPresetManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
  for (const rel of ['shell/day.webp', 'curtains/day.webp', 'curtains/mask.webp']) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), 'RIFF....WEBP');
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'seilink-fresh-'));
  const root = path.join(tmp, 'packs');
  await writePack(path.join(root, 'cozy'), manifest('cozy', 'your bedroom'));
  await writePack(path.join(root, 'gamer'), manifest('gamer', 'your gaming room'));
  __setPackRootsForTest([{ dir: root, source: 'dev' }]);
  _setUserDataOverride(path.join(tmp, 'userData'));
  __setSeilinkEnabledForTest(true);
  setSeilinkResident(CHAR);
  setRoomSource(roomSource);
  __resetUnseenForTest();
});

afterEach(async () => {
  setRoomSource(null);
  __setSeilinkEnabledForTest(null);
  setSeilinkResident(null);
  __setPackRootsForTest(null);
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('room context after an edit', () => {
  it('the next turn reads the saved room, and hears once about edits she did not react to', async () => {
    const first = await roomForSurface(CHAR, { inGame: false });
    expect(roomPromptLine(first!, { includeTime: false })).toBe("You're in your bedroom.");
    // An editor session she did not react to (a call): the room before it is kept.
    const before = await getRoomPayload(CHAR);
    keepUnseenBaseline(CHAR, { manifest: before.pack!.manifest, state: before.state });
    await setRoomState(CHAR, { version: 1, preset: 'cozy', time: 'auto', slots: { curtains: { id: 'curtains', tint: '#3050d0' } }, items: [], avatar: { kind: 'sei' } });
    const next = await roomForSurface(CHAR, { inGame: false });
    expect(next!.state.slots.curtains?.tint).toBe('#3050d0');
    expect(roomChangeTurnNote(CHAR, next)).toContain('What they changed: changed the curtains to a different shade of blue');
    expect(roomChangeTurnNote(CHAR, next)).toBe('');
    // A new preset shows in the room line itself, at once.
    await setRoomState(CHAR, { version: 1, preset: 'gamer', time: 'auto', slots: {}, items: [], avatar: { kind: 'sei' } });
    const moved = await roomForSurface(CHAR, { inGame: false });
    expect(roomPromptLine(moved!, { includeTime: false })).toBe("You're in your gaming room.");
    // In a game: no room on the turn, so the note waits for her next turn at home.
    keepUnseenBaseline(CHAR, { manifest: next!.manifest, state: next!.state });
    expect(await roomForSurface(CHAR, { inGame: true })).toBeNull();
    expect(roomChangeTurnNote(CHAR, null)).toBe('');
    expect(roomChangeTurnNote(CHAR, moved)).toContain('moved you to your gaming room');
  });
});
