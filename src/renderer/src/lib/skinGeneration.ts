/**
 * Renderer half of the 261027 lazy Minecraft skins (main/skinGeneration.ts).
 *
 * A new companion starts with a free painted skin; its real (Gemini, billed)
 * skin is made the first time its owner opens the Minecraft launch panel.
 * `useMinecraftSkinPrep` kicks that off and reports progress for the panel's
 * status line; the profile's skin button calls `sei.generateSkin` directly.
 * Both join one in-flight generation in main, so a panel opened while the
 * button's generation runs shows the same progress.
 */
import { useEffect, useRef, useState } from 'react';
import { sei } from './ipcClient';
import { useDataStore } from './stores/useDataStore';
import { useAuthStore } from './stores/useAuthStore';
import { skinPendingOf, type Character } from '@shared/characterSchema';
import type { SkinGenOutcome } from '@shared/ipc';

/**
 * Whether this player may make the character's Minecraft skin: their own
 * companions only (main's rule in skinGeneration.mayGenerate). Defaults and
 * other people's characters (World / shared) reuse the owner's skin.
 */
export function canGenerateSkin(
  c: Pick<Character, 'is_default' | 'owner'>,
  currentUserId: string | null,
): boolean {
  if (c.is_default) return false;
  return c.owner == null || c.owner === currentUserId;
}

export type SkinPrepState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; outcome: SkinGenOutcome };

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Plain line for the launch panel, or null when there is nothing to say.
 * Every failure says the launch still works, with the simple skin.
 */
export function skinPrepLine(state: SkinPrepState, name: string, t: T): string | null {
  if (state.kind === 'running') return t("Making {name}'s Minecraft skin...", { name });
  if (state.kind !== 'done') return null;
  return skinFailureLine(state.outcome, name, t);
}

/** Why a generation did not produce a skin, for the panel and the profile. */
export function skinFailureLine(outcome: SkinGenOutcome, name: string, t: T): string | null {
  switch (outcome) {
    case 'insufficient_credits':
      return t("Not enough credits to make {name}'s Minecraft skin. They will use a simple one for now.", { name });
    case 'daily_limit':
      return t("You've made the most skins allowed today. {name} will use a simple one for now.", { name });
    case 'failed':
      return t("Couldn't make {name}'s Minecraft skin. They will use a simple one for now.", { name });
    case 'not_signed_in':
      return t('Sign in to make a Minecraft skin.');
    case 'no_portrait':
      return t('{name} needs a picture before Sei can make their skin.', { name });
    default:
      return null;
  }
}

/**
 * On mount, make the character's Minecraft skin if it is still the creation
 * placeholder. Main decides (owner only, once per app run); this only shows
 * progress. Launch never waits on it here: a summon started meanwhile waits
 * for the same generation in main, bounded.
 */
export function useMinecraftSkinPrep(characterId: string): SkinPrepState {
  const currentUserId = useAuthStore((s) => (s.state.kind === 'signed_in' ? s.state.user.id : null));
  // A shared character can carry its owner's synced marker; only the owner's
  // device makes the skin, so nobody else shows progress for it.
  const pending = useDataStore((s) => {
    const c = s.characters.find((x) => x.id === characterId);
    return c ? skinPendingOf(c) && canGenerateSkin(c, currentUserId) : false;
  });
  const [prep, setPrep] = useState<{ id: string; state: SkinPrepState }>({ id: characterId, state: { kind: 'idle' } });
  // Started once per character per mount. The marker clears when the skin
  // lands, which must not reset the line reporting it, and a StrictMode
  // double effect must not drop the result (hence a mounted ref, not a
  // per-effect cancel flag).
  const startedFor = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending || startedFor.current === characterId) return;
    startedFor.current = characterId;
    setPrep({ id: characterId, state: { kind: 'running' } });
    const settle = (state: SkinPrepState): void => {
      if (mounted.current) setPrep((cur) => (cur.id === characterId ? { id: characterId, state } : cur));
    };
    void sei
      .ensureSkin(characterId)
      .then((res) => {
        settle(res.outcome === 'skipped' ? { kind: 'idle' } : { kind: 'done', outcome: res.outcome });
        void useDataStore.getState().refreshCharacter(characterId);
      })
      .catch(() => settle({ kind: 'idle' }));
  }, [characterId, pending]);
  return prep.id === characterId ? prep.state : { kind: 'idle' };
}




