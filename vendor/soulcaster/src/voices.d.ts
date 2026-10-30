// Types for voices.js, added in the Sei vendor copy (261024) so Sei's shared
// code (src/shared/poolVoiceIds.ts) can import the voice table directly, in
// both the main and the renderer TypeScript programs. Only the voice table is
// declared: it is the only export Sei imports from this file.
export declare const VOICES: ReadonlyArray<{
  id: string;
  owner: string | null;
  label: string;
  gender: 'female' | 'male' | 'neutral';
  age: 'young' | 'adult' | 'elder';
  tags: string[];
  vibe: string;
}>;
