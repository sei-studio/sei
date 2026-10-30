/**
 * Face cue emission (261028, facepack pilot). chatService and the bot
 * supervisor call these; index.ts installs the sink that pushes
 * `facepack:cue` to every window. Everything here is a no-op while the dev
 * flag is off (facesEnabled), so production sends no new IPC.
 */
import type { FaceCue } from '../../shared/facepack';
import { facesEnabled } from './facepackDev';

type Sink = (cue: FaceCue) => void;
let sink: Sink | null = null;

export function setFaceCueSink(fn: Sink | null): void {
  sink = fn;
}

export function emitFaceCue(cue: FaceCue): void {
  if (!facesEnabled() || !sink) return;
  try {
    sink(cue);
  } catch (err) {
    console.warn(`[sei/face] cue push failed: ${(err as Error).message}`);
  }
}

/** The cues parsed off one reply part (splitReplyParts), keyed to its bubble. */
export function emitReplyFaces(
  characterId: string,
  message: { id: string; text: string },
  face: { lead: string | null; trail: string | null } | null | undefined,
): void {
  if (!face) return;
  if (face.lead) emitFaceCue({ characterId, expression: face.lead, at: 'start', text: message.text, messageId: message.id });
  if (face.trail) emitFaceCue({ characterId, expression: face.trail, at: 'end', text: message.text, messageId: message.id });
}
