import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RoomSlotId } from '@shared/seilinkRoom';
import { parseRoomManifest } from '@shared/seilinkValidate';
import { groupSlots, slotGroup } from './roomGroups';

describe('room editor slot groups', () => {
  it('puts surfaces and textiles apart from standalone pieces', () => {
    expect(slotGroup('view')).toBe('room');
    expect(['shell', 'curtains', 'rug'].map((s) => slotGroup(s as RoomSlotId))).toEqual(['fabrics', 'fabrics', 'fabrics']);
    expect(['bed', 'shelf', 'chair', 'campfire', 'lamp'].map((s) => slotGroup(s as RoomSlotId))).toEqual(Array(5).fill('furniture'));
  });

  it('treats a slot it does not know as furniture, listed last', () => {
    const unknown = 'wardrobe' as RoomSlotId;
    expect(slotGroup(unknown)).toBe('furniture');
    expect(groupSlots(['lamp', unknown, 'bed'], 'furniture')).toEqual(['bed', 'lamp', unknown]);
  });

  it('lists each group big pieces first, whatever the draw order', () => {
    // The cozy pack's draw order (z).
    const drawn: RoomSlotId[] = ['view', 'shell', 'rug', 'curtains', 'shelf', 'bed', 'lamp', 'chair'];
    expect(groupSlots(drawn, 'room')).toEqual(['view']);
    expect(groupSlots(drawn, 'fabrics')).toEqual(['shell', 'curtains', 'rug']);
    expect(groupSlots(drawn, 'furniture')).toEqual(['bed', 'shelf', 'chair', 'lamp']);
  });

  it('lets a pack move a slot: forest lists its tent and log blanket under fabrics, cozy and gamer keep theirs', () => {
    const load = (id: string) =>
      parseRoomManifest(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../../resources/seilink-packs/${id}/manifest.json`), 'utf8')))!;
    const forest = load('forest');
    expect(slotGroup('bed', forest)).toBe('fabrics');
    expect(slotGroup('chair', forest)).toBe('fabrics');
    const drawn = Object.keys(forest.slots) as RoomSlotId[];
    expect(groupSlots(drawn, 'fabrics', forest)).toEqual(['shell', 'bed', 'chair']);
    // 261105: the optional Lights slot (fireflies) sits with the furniture.
    expect(groupSlots(drawn, 'furniture', forest)).toEqual(['shelf', 'campfire', 'lamp', 'lights']);
    for (const id of ['cozy', 'gamer']) {
      const m = load(id);
      expect(Object.values(m.slots).some((d) => d?.group), id).toBe(false);
      expect(slotGroup('bed', m)).toBe('furniture');
      expect(slotGroup('chair', m)).toBe('furniture');
    }
  });

  it('drops a group a pack names that the editor does not have (the slot keeps its default)', () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../../resources/seilink-packs/forest/manifest.json'), 'utf8'));
    raw.slots.bed.group = 'attic';
    const m = parseRoomManifest(raw)!;
    expect(m.slots.bed!.group).toBeUndefined();
    expect(slotGroup('bed', m)).toBe('furniture');
  });
});
