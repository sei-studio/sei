/**
 * The guided room setup (261106, first-link v3, Shawn: set her room up step
 * by step, starting with the room). Pure helpers for RoomEditor's guided
 * mode; the editor owns the state and the UI.
 *
 * She first moves in on a plain background (RoomState.plain). The room
 * editor opens guided while she is still plain, or while a setup run was left
 * unfinished (RoomState.setup, saved on every Next and Skip), and resumes at
 * the first step not done. Steps, all optional:
 *   1. room       the kind of room (the room type cards, the window view)
 *   2. colours    walls and fabrics (the "Walls & fabrics" panel)
 *   3. furniture  the furniture pieces
 *   4. extras     little extras (the items library)
 * A step the room has nothing for is left out (a pack with no fabrics). Done
 * (the last step) saves the room without the setup marker, so the next open
 * is the normal editor.
 */
import { ROOM_SETUP_STEPS, type RoomSetupStep, type RoomState } from '@shared/seilinkRoom';

/** Which panel each step shows (RoomEditor's rail groups). */
export const SETUP_PANEL = { room: 'room', colours: 'fabrics', furniture: 'furniture', extras: 'items' } as const satisfies Record<RoomSetupStep, string>;

/** Each step's title and one line under it (keys are the English strings; see i18n). */
export const SETUP_COPY: Readonly<Record<RoomSetupStep, { title: string; hint: string }>> = {
  room: { title: 'Pick a room', hint: 'Start with the kind of room. You can change anything later.' },
  colours: { title: 'Choose colours', hint: 'Recolour the walls and fabrics, or try a pattern.' },
  furniture: { title: 'Add furniture', hint: 'Pick the pieces you like, or leave a spot empty.' },
  extras: { title: 'Little extras', hint: 'Add a few small things, then drag them where you like.' },
};

/** The steps this room has something for, in order (the room step always). */
export function setupSteps(has: { fabrics: boolean; furniture: boolean; items: boolean }): RoomSetupStep[] {
  return ROOM_SETUP_STEPS.filter((s) => s === 'room' || (s === 'colours' ? has.fabrics : s === 'furniture' ? has.furniture : has.items));
}

/** Whether the editor opens guided for this saved room: she is still plain, or a run was left unfinished. */
export function opensGuided(saved: Pick<RoomState, 'plain' | 'setup'> | null | undefined): boolean {
  return Boolean(saved && (saved.plain === true || saved.setup));
}

/** Where a run starts: the first available step not done (the room step again while she is still plain). */
export function resumeStep(steps: readonly RoomSetupStep[], done: readonly RoomSetupStep[], plain: boolean): RoomSetupStep {
  if (plain) return 'room';
  return steps.find((s) => !done.includes(s)) ?? steps[steps.length - 1] ?? 'room';
}

export function nextStep(steps: readonly RoomSetupStep[], step: RoomSetupStep): RoomSetupStep | null {
  const i = steps.indexOf(step);
  return i >= 0 && i + 1 < steps.length ? steps[i + 1] : null;
}

export function prevStep(steps: readonly RoomSetupStep[], step: RoomSetupStep): RoomSetupStep | null {
  const i = steps.indexOf(step);
  return i > 0 ? steps[i - 1] : null;
}

/** `done` with `step` added, in step order. */
export function markDone(done: readonly RoomSetupStep[], step: RoomSetupStep): RoomSetupStep[] {
  return ROOM_SETUP_STEPS.filter((s) => s === step || done.includes(s));
}

/** The room without the setup marker (the editor's history never holds it; it is added on save). */
export function withoutSetup(state: RoomState): RoomState {
  if (!state.setup) return state;
  const { setup: _drop, ...rest } = state;
  return rest;
}
