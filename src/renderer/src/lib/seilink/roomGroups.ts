/**
 * Which room editor panel holds each slot (261105, msgs 1576 + 1580).
 * The rail has five tiles: Avatar, Room, Walls & fabrics, Furniture, Items.
 * The three middle ones list slots as sections:
 *  - room: the room itself beside the room type (the window view);
 *  - fabrics: surfaces and textiles she only recolours or repatterns;
 *  - furniture: standalone pieces, each with its own parts and colours.
 */
import type { RoomEditorGroup, RoomPresetManifest, RoomSlotId } from '@shared/seilinkRoom';

export type SlotGroup = RoomEditorGroup;

/**
 * Which panel holds each slot (261105): the room itself (window view),
 * surfaces and textiles she only recolours or repatterns, and standalone
 * pieces. A slot missing here is furniture. A pack can move one of its slots
 * (RoomSlotDef.group): forest's tent and log blanket sit in the bed and
 * chair slots but are fabrics.
 */
const SLOT_GROUP: Partial<Record<RoomSlotId, SlotGroup>> = {
  view: 'room',
  shell: 'fabrics',
  curtains: 'fabrics',
  rug: 'fabrics',
  bed: 'furniture',
  shelf: 'furniture',
  chair: 'furniture',
  campfire: 'furniture',
  lamp: 'furniture',
  lights: 'furniture',
  tree: 'furniture',
};
export const slotGroup = (slot: RoomSlotId, manifest?: Pick<RoomPresetManifest, 'slots'> | null): SlotGroup =>
  manifest?.slots[slot]?.group ?? SLOT_GROUP[slot] ?? 'furniture';

/** Section order inside a panel: big pieces first (a slot not listed goes last, in draw order). */
const SECTION_ORDER: readonly RoomSlotId[] = ['view', 'shell', 'curtains', 'rug', 'bed', 'shelf', 'chair', 'campfire', 'lamp', 'lights', 'tree'];

/** The slots of `slots` (draw order) that `group` lists in this pack, in its section order. */
export function groupSlots(slots: readonly RoomSlotId[], group: SlotGroup, manifest?: Pick<RoomPresetManifest, 'slots'> | null): RoomSlotId[] {
  const rank = (s: RoomSlotId): number => {
    const i = SECTION_ORDER.indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return slots.filter((s) => slotGroup(s, manifest) === group).sort((a, b) => rank(a) - rank(b) || slots.indexOf(a) - slots.indexOf(b));
}
