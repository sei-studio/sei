/**
 * A character file was written (261105). Dependency-free so characterStore
 * can announce saves without importing the features that care (the anima
 * client re-checks her face set when her portrait changed).
 */
type Listener = (characterId: string) => void;

const listeners = new Set<Listener>();

export function noteCharacterSaved(characterId: string): void {
  for (const l of listeners) {
    try {
      l(characterId);
    } catch {
      // A listener's failure is its own; the save went through.
    }
  }
}

export function onCharacterSaved(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
