/**
 * SkinGenerateButton (261027 lazy skins): the profile's "make / regenerate
 * the Minecraft skin" control, shown under the skin preview for characters
 * the player owns that have a picture.
 *
 * Each press is one billed proxy call (Gemini, charged to the player's
 * allowance or credits), and the label says so in plain words. Main owns the
 * call and every check (owner, signed in, portrait, single flight); a failure
 * keeps the skin the character has. See main/skinGeneration.ts.
 */
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { canGenerateSkin } from '../lib/skinGeneration';
import { classifyRendererError } from '../lib/errors';
import { useT } from '../lib/i18n';
import { skinPendingOf, type Character } from '@shared/characterSchema';
import type { SkinGenOutcome } from '@shared/ipc';
import { Button } from './Button';
import styles from './SkinEditor.module.css';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Result line under the button (null = nothing to say). */
export function skinButtonResultLine(outcome: SkinGenOutcome, name: string, t: T): string | null {
  switch (outcome) {
    case 'generated':
      return t('New skin ready. {name} wears it the next time they join.', { name });
    case 'insufficient_credits':
      return t('Not enough credits to make a skin. The current skin stays.');
    case 'daily_limit':
      return t("You've made the most skins allowed today. Try again tomorrow.");
    case 'not_signed_in':
      return t('Sign in to make a Minecraft skin.');
    case 'no_portrait':
      return t('{name} needs a picture before Sei can make their skin.', { name });
    case 'not_allowed':
      return t("Only {name}'s creator can make their skin.", { name });
    default:
      return t("Couldn't make a skin. The current skin stays.");
  }
}

export interface SkinGenerateState {
  /** The player may make this companion's skin (own, has a picture). */
  visible: boolean;
  /** No skin was ever made: "Make" rather than "Regenerate". */
  firstSkin: boolean;
  running: boolean;
  /** The bot is in a world as this companion: the skin cannot change now. */
  botOnline: boolean;
  run: () => Promise<void>;
  /** Result line of the last press (null = nothing to say). */
  line: string | null;
  ok: boolean;
}

/**
 * The make / regenerate state for one companion, shared by this button and
 * the profile's Minecraft skin row (261107).
 */
export function useSkinGenerate(character: Character, onChanged: () => void): SkinGenerateState {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ outcome: SkinGenOutcome } | { error: string } | null>(null);
  const botOnline = useDataStore((s) => s.summons[character.id]?.kind === 'online');
  const currentUserId = useAuthStore((s) => (s.state.kind === 'signed_in' ? s.state.user.id : null));
  // Defaults and other people's characters wear their owner's skin.
  const visible = !!character.portrait_image && canGenerateSkin(character, currentUserId);
  // Never made yet (creation placeholder, or no skin): "Make". Otherwise a
  // new one replaces the current skin.
  const firstSkin = skinPendingOf(character) || character.skin.source === 'none';

  const run = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    try {
      const res = await sei.generateSkin(character.id);
      setResult({ outcome: res.outcome });
      onChanged();
    } catch (err) {
      setResult({ error: classifyRendererError(err).copy });
    } finally {
      setRunning(false);
    }
  };

  const line =
    result == null
      ? null
      : 'error' in result
        ? result.error
        : skinButtonResultLine(result.outcome, character.name, t);
  const ok = result != null && 'outcome' in result && result.outcome === 'generated';
  return { visible, firstSkin, running, botOnline, run, line, ok };
}

export function SkinGenerateButton({
  character,
  onChanged,
}: {
  character: Character;
  onChanged: () => void;
}): React.ReactElement | null {
  const t = useT();
  const gen = useSkinGenerate(character, onChanged);
  if (!gen.visible) return null;

  const label = gen.running
    ? t('Making skin...')
    : gen.firstSkin
      ? t('Generate Minecraft skin')
      : t('Regenerate skin');

  return (
    <div data-slot="skin-generate">
      <Button kind="ghost" size="sm" onClick={() => void gen.run()} disabled={gen.running || gen.botOnline}>
        {label}
      </Button>
      {gen.line ? <p className={gen.ok ? styles.successCopy : styles.errorCopy}>{gen.line}</p> : null}
    </div>
  );
}
