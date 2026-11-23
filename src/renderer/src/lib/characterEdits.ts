/**
 * Character edits made inline on your own companion's profile tabs
 * (261119: the tabs are the edit surface; the Edit companion popup is gone).
 *
 * Pure helpers shared by the inline editors in
 * components/profile/ProfileEditors.tsx: what each editor shows when it has
 * no draft (read from the character), whether a draft differs from what is
 * saved, and the metadata a save writes. The save rules are the ones the
 * popup used, unchanged:
 *
 *  - Voice: the picked voice, the own-voice marker, the voice others hear,
 *    and the pitch / calmness playground, written in ONE save (never while
 *    the player is still trying voices). A slider left on neutral for a
 *    companion with a baked non-neutral default (Sui) writes the neutral
 *    value explicitly, so the baked default cannot come back.
 *  - Name and description: name must not be empty; an empty description is
 *    stored as null.
 *  - Chess: Custom writes {elo, styleNote, source: 'user'}; Auto removes the
 *    key so it is derived again on the next game.
 *
 * No React, no IPC.
 */
import type { Character } from '@shared/characterSchema';
import {
  applySharedVoicePick,
  applyVoicePick,
  sharedVoiceIdOf,
  storedVoicePickOf,
  type OwnVoicePick,
} from '@shared/voiceIds';
import { voicePitchRate, voiceStabilityFor } from '@shared/voicePitch';
import type { VoiceParams } from './voicePicker';

type Meta = Record<string, unknown> | undefined | null;

// ── Voice ─────────────────────────────────────────────────────────────────

export interface VoiceDraft {
  /** null = Auto, NO_VOICE_ID = silent, else a pinned voice. */
  voiceId: string | null;
  /** The own-ElevenLabs-voice or Voice Library marker that rides with voiceId
   *  (null otherwise; a library pick carries source: 'library'). */
  voiceOwn: OwnVoicePick | null;
  /** The Sei voice others hear while the voice is the author's own (null = the close match). */
  voiceShared: string | null;
  params: VoiceParams;
}

/**
 * The saved voice settings, as the picker shows them. The sliders start at
 * the EFFECTIVE values (a baked code default included), rounded to the
 * slider's 0.01 step so the readout matches the thumb.
 */
export function voiceFromCharacter(character: Pick<Character, 'id' | 'metadata'>): VoiceDraft {
  const meta = character.metadata;
  const params: VoiceParams = {};
  const pitch = Math.round(voicePitchRate(character) * 100) / 100;
  if (pitch !== 1) params.pitch = pitch;
  const calm = voiceStabilityFor(character);
  if (calm !== undefined) params.calmness = calm;
  return {
    voiceId: typeof meta?.voiceId === 'string' ? (meta.voiceId as string) : null,
    voiceOwn: storedVoicePickOf(meta),
    voiceShared: sharedVoiceIdOf(meta),
    params,
  };
}

/** A voice draft differs from what is saved (the popup's voiceDirty). */
export function voiceDiffers(a: VoiceDraft, b: VoiceDraft): boolean {
  return (
    a.voiceId !== b.voiceId ||
    a.voiceShared !== b.voiceShared ||
    a.params.pitch !== b.params.pitch ||
    a.params.calmness !== b.params.calmness
  );
}

/** The metadata one voice save writes, on top of the LATEST stored metadata. */
export function voiceMetadataToSave(characterId: string, latest: Meta, draft: VoiceDraft): Record<string, unknown> {
  // A pool pick clears voiceShared (applyVoicePick); an own pick keeps the
  // "Others will hear" choice. A library voice is a Sei voice everyone hears,
  // so it never carries one.
  const metadata = draft.voiceOwn && draft.voiceOwn.source !== 'library'
    ? applySharedVoicePick(applyVoicePick(latest, draft.voiceId, draft.voiceOwn), draft.voiceShared)
    : applyVoicePick(latest, draft.voiceId, draft.voiceOwn);
  const baked = { id: characterId, metadata: {} };
  if (draft.params.pitch !== undefined) metadata.voicePitch = draft.params.pitch;
  else if (voicePitchRate(baked) !== 1) metadata.voicePitch = 1;
  else delete metadata.voicePitch;
  if (draft.params.calmness !== undefined) metadata.voiceStability = draft.params.calmness;
  else if (voiceStabilityFor(baked) !== undefined) metadata.voiceStability = 0.5; // slider shows 0.50; the baked default must not override it
  else delete metadata.voiceStability;
  return metadata;
}

// ── Name and description ──────────────────────────────────────────────────

export interface AboutDraft {
  name: string;
  description: string;
}

export function aboutFromCharacter(character: Pick<Character, 'name' | 'description'>): AboutDraft {
  return { name: character.name ?? '', description: character.description ?? '' };
}

export function aboutDiffers(a: AboutDraft, b: AboutDraft): boolean {
  return a.name.trim() !== b.name.trim() || a.description.trim() !== b.description.trim();
}

/** The fields one save writes, or 'empty_name' (the save is refused). */
export function aboutToSave(draft: AboutDraft): { name: string; description: string | null } | 'empty_name' {
  const name = draft.name.trim();
  if (!name) return 'empty_name';
  const description = draft.description.trim();
  return { name, description: description === '' ? null : description };
}

// ── Chess ─────────────────────────────────────────────────────────────────

export interface ChessDraft {
  custom: boolean;
  elo: number;
  style: string;
}

/** Elo the slider starts on when nothing is stored. */
export const CHESS_DEFAULT_ELO = 900;

export function chessFromCharacter(character: Pick<Character, 'metadata'>): ChessDraft {
  const stored = (character.metadata?.chess ?? null) as { elo?: number; styleNote?: string } | null;
  return {
    custom: !!stored,
    elo: typeof stored?.elo === 'number' ? stored.elo : CHESS_DEFAULT_ELO,
    style: stored?.styleNote ?? '',
  };
}

export function chessDiffers(a: ChessDraft, b: ChessDraft): boolean {
  return a.custom !== b.custom || a.elo !== b.elo || a.style !== b.style;
}

export function chessMetadataToSave(latest: Meta, draft: ChessDraft): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(latest ?? {}) };
  if (draft.custom) metadata.chess = { elo: draft.elo, styleNote: draft.style.trim(), source: 'user' };
  else delete metadata.chess; // back to auto: derived again on the next game
  return metadata;
}

// ── Persona ───────────────────────────────────────────────────────────────

export type PersonaMode = 'standard' | 'advanced';

/** Characters created with "Expand my prompt" off (or last saved raw) open in Advanced. */
export function personaModeOf(character: Pick<Character, 'metadata'>): PersonaMode {
  return character.metadata?.prompt_mode === 'advanced' ? 'advanced' : 'standard';
}
