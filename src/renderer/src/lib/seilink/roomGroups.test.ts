import { describe, expect, it } from 'vitest';
import type { RoomSlotId } from '@shared/seilinkRoom';
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
});
