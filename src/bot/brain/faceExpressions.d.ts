// Types for src/bot/brain/faceExpressions.js (imported by main and the renderer).
export interface FaceExpressionDef {
  name: string;
  description: string;
  aliases: string[];
  blink: boolean;
}
export interface FaceExtraExpressionDef extends FaceExpressionDef {
  /** The base face this lands on when a pack does not have it. */
  fallback: string;
}
/** A pack's offered expressions plus its own aliases (normalizePalette). */
export interface FacePalette {
  expressions: string[];
  aliases: Record<string, string>;
}
export const FACE_EXPRESSIONS: ReadonlyArray<FaceExpressionDef>;
export const FACE_EXPRESSION_NAMES: ReadonlyArray<string>;
export const FACE_EXTRA_EXPRESSIONS: ReadonlyArray<FaceExtraExpressionDef>;
export const FACE_ALL_EXPRESSIONS: ReadonlyArray<FaceExpressionDef>;
export const FACE_NEUTRAL: 'neutral';
export const FACE_DECAY_MS: Readonly<Record<string, number>>;
export const FACE_IDLE_NEUTRAL_MS: number;
export function normalizePalette(expressions: unknown, aliases?: unknown, drawable?: Iterable<string>): FacePalette | null;
export function resolveExpression(word: unknown, palette?: FacePalette | null): string | null;
export function readFaceTags(line: unknown, palette?: FacePalette | null): { lead: string | null; trail: string | null };
export const FACE_OFFERED_NAMES: ReadonlyArray<string>;
export const FACE_PROMPT: string;
export const FACE_EXPRESSION_ENUM: ReadonlyArray<string>;
export const SAY_EXPRESSION_DESCRIPTION: string;
