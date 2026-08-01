/**
 * 260728: the identity constants moved to src/shared/defaultCharacters.ts so
 * the renderer can reference Sui's UUID (the fresh-onboarding party seed).
 * This re-export keeps every existing main-process import path working.
 */
export {
  DEFAULT_CHARACTER_UUIDS,
  DEFAULT_CHARACTERS_OWNER,
  type DefaultCharacterSlug,
} from '../shared/defaultCharacters';
