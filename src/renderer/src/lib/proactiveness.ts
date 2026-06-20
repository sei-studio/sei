/**
 * Proactiveness — the author-set dial (0–3) that governs how much a character
 * INITIATES its own work, surfaced as a segmented bar on the character card and
 * detail page and editable in EditCharacterModal.
 *
 * Stored on `character.metadata.proactiveness` (the CharacterSchema forward-
 * compat escape hatch — no Zod migration). The bot reads the same value off
 * metadata in src/bot/index.js and selects the matching directive in
 * src/bot/brain/prompts.js PROACTIVENESS_DIRECTIVES, so the bar and the
 * behavior are the same number. Default 1 (Reactive) matches the bot config
 * default.
 *
 * NOTE: this is initiation, NOT goal-completion. Even a Passive character runs
 * a standing order you give it to completion (via its heartbeat) — the dial
 * only decides whether it starts things unprompted.
 */
import type { Character } from '@shared/characterSchema';

export interface ProactivenessLevel {
  value: number;
  label: string;
  /** Tooltip copy: what to expect from a character at this level. */
  blurb: string;
}

export const PROACTIVENESS_LEVELS: ProactivenessLevel[] = [
  {
    value: 0,
    label: 'Passive',
    blurb: 'Acts only when interacted with. Stays silent and comments occasionally.',
  },
  {
    value: 1,
    label: 'Reactive',
    blurb: 'Follows and responds to you. Capable of suggesting longer activities.',
  },
  {
    value: 2,
    label: 'Agentic',
    blurb: '(Beta) Fully agentic. Initiates activities and can play independently. May use more playtime.',
  },
];

export const PROACTIVENESS_COUNT = PROACTIVENESS_LEVELS.length;
export const PROACTIVENESS_DEFAULT = 1;
export const PROACTIVENESS_MAX = PROACTIVENESS_COUNT - 1; // 2 (Agentic)

/**
 * Read the dial off a character's metadata, clamped to a valid level.
 *
 * Legacy remap: the dial used to be 0–3 (Passive/Reactive/Active/Driven).
 * Old "Driven" (3) and old "Active" (2) both fold into the new "Agentic" (2),
 * so a value of 3 maps to 2 rather than falling back to the default.
 */
export function getProactiveness(character: Pick<Character, 'metadata'>): number {
  const raw = (character.metadata as Record<string, unknown> | undefined)?.proactiveness;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return Math.min(raw, PROACTIVENESS_MAX); // 3 (legacy Driven) → 2 (Agentic)
  }
  return PROACTIVENESS_DEFAULT;
}

export function proactivenessLevel(value: number): ProactivenessLevel {
  return PROACTIVENESS_LEVELS[value] ?? PROACTIVENESS_LEVELS[PROACTIVENESS_DEFAULT];
}
