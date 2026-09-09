/**
 * PortraitVersionsModal — card-image versions + Regenerate (260909).
 *
 * Opened from the companion settings gear ("Card image") and from the Edit
 * modal's Appearance section, for characters the user OWNS (the CharacterPage
 * `canShare` predicate: not a bundled default, not foreign-owned). Awakened
 * ('unique') companions are owned and are the ones with AI portraits, so they
 * get this even though the rest of the editor is view-only for them.
 *
 * Shows the active image large, a row of stored versions ("Original", "v2",
 * ...; click = make it the displayed image), and a Regenerate button that
 * runs the KusArt round trip (~10-60s, single-flight in main) and stores the
 * result as the next version. Each character has MAX_PORTRAIT_REGENS lifetime
 * regenerations; every version stays on disk so switching back is free. Only
 * the selected version is mirrored to the cloud.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { bumpPortraitRef, portraitSrc } from '../lib/portraitSrc';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import type { PortraitVersionsState } from '@shared/ipc';
import { portraitVersionIndex, type PortraitVersion } from '@shared/characterSchema';
import styles from './PortraitVersionsModal.module.css';

export interface PortraitVersionsModalProps {
  characterId: string;
  characterName: string;
  onClose: () => void;
  /** Stack above another modal (the Edit modal opens this on top of itself). */
  tier?: 'base' | 'stacked';
}

/** Strip Electron's IPC wrapper so main's user-facing copy shows clean. */
function cleanError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
}

export function PortraitVersionsModal({
  characterId,
  characterName,
  onClose,
  tier = 'base',
}: PortraitVersionsModalProps): React.ReactElement {
  const t = useT();
  const authState = useAuthStore((s) => s.state);
  const signedIn = authState.kind === 'signed_in';
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);

  const [state, setState] = useState<PortraitVersionsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  // Local cache-buster for the big preview + thumbnails: the canonical URL
  // never changes when its bytes do, so bump after every swap.
  const [bust, setBust] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await sei.charsPortraitVersions(characterId);
      if (mounted.current) setState(next);
    } catch (err) {
      if (mounted.current) setError(cleanError(err));
    }
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** After the canonical bytes changed: repaint everywhere + refresh the row. */
  const afterSwap = async (next: PortraitVersionsState): Promise<void> => {
    bumpPortraitRef(`${characterId}.png`);
    setBust((b) => b + 1);
    setState(next);
    await refreshCharacter(characterId);
  };

  const select = async (file: string): Promise<void> => {
    if (!state || regenerating || selecting) return;
    if (state.active === file) return;
    setSelecting(file);
    setError(null);
    try {
      const next = await sei.charsPortraitSelect({ characterId, file });
      await afterSwap(next);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      if (mounted.current) setSelecting(null);
    }
  };

  const regenerate = async (): Promise<void> => {
    if (!state || regenerating || selecting || !signedIn) return;
    setRegenerating(true);
    setError(null);
    try {
      const res = await sei.charsPortraitRegenerate(characterId);
      if (!res.ok) {
        setError(res.code === 'not_signed_in' ? t('Sign in to regenerate.') : res.message);
        // The cap may have been hit by another device; re-read the state.
        await load();
        return;
      }
      await afterSwap(res.state);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      if (mounted.current) setRegenerating(false);
    }
  };

  const regensLeft = state ? Math.max(0, state.regenLimit - state.regenCount) : 0;
  const canRegenerate = !!state && signedIn && regensLeft > 0 && !regenerating && !selecting;
  const activeSrc = state?.active ? withBust(portraitSrc(state.active), bust) : null;
  const busy = regenerating || selecting !== null;

  const label = (v: PortraitVersion, i: number): string => {
    if (v.source === 'original') return t('Original');
    // Number by the sidecar index (stable across evictions), not list position.
    const n = portraitVersionIndex(characterId, v.file) ?? i + 1;
    return t('v{n}', { n });
  };

  let hint: string;
  if (!signedIn) hint = t('Sign in to regenerate.');
  else if (regenerating) hint = t('Drawing a new image. This can take up to a minute.');
  else if (regensLeft === 0) hint = t('No regenerations left');
  else if (regensLeft === 1) hint = t('1 regeneration left');
  else hint = t('{n} regenerations left', { n: regensLeft });

  return (
    <ModalShell
      title={t('Card image')}
      width={520}
      tier={tier}
      onClose={onClose}
      escClose={!busy}
      aria-label={t("{name}'s card image", { name: characterName })}
    >
      <p className={styles.lede}>
        {t('Every version is kept on this device. Only the one you pick is shown to others.')}
      </p>

      <div className={styles.preview} aria-busy={regenerating}>
        {activeSrc ? (
          <img src={activeSrc} alt={t('Current card image')} className={styles.previewImg} />
        ) : (
          <div className={styles.previewEmpty}>{t('No card image yet')}</div>
        )}
        {regenerating ? <div className={styles.previewVeil}>{t('Regenerating…')}</div> : null}
      </div>

      {state && state.versions.length > 0 ? (
        <div className={styles.versions} role="listbox" aria-label={t('Stored versions')}>
          {state.versions.map((v, i) => {
            const isActive = state.active === v.file;
            const src = withBust(portraitSrc(v.file), bust);
            return (
              <button
                key={v.file}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`${styles.thumb} ${isActive ? styles.thumbActive : ''}`}
                disabled={busy}
                onClick={() => void select(v.file)}
                title={new Date(v.created_at).toLocaleString()}
              >
                {src ? <img src={src} alt="" className={styles.thumbImg} /> : null}
                <span className={styles.thumbLabel}>
                  {selecting === v.file ? t('Applying…') : label(v, i)}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={styles.regenRow}>
        <Button kind="accent" size="md" onClick={() => void regenerate()} disabled={!canRegenerate}>
          {regenerating ? t('Regenerating…') : t('Regenerate')}
        </Button>
        <span className={styles.hint}>{hint}</span>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <ModalFooter>
        <Button kind="quiet" onClick={onClose} disabled={regenerating}>
          {t('Done')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

function withBust(src: string | null, bust: number): string | null {
  if (!src || bust === 0) return src;
  return `${src}${src.includes('?') ? '&' : '?'}m=${bust}`;
}
