/**
 * Backseat panel 1 (260728) — the share picker.
 *
 * Clicking the Backseat tile does NOT close the games popup and open something
 * else; the popup keeps its frame and swaps its body to this. That is the whole
 * reason it lives here rather than in a modal of its own: choosing what to
 * share is part of starting the game, not a separate step, and a second window
 * appearing over the first reads as an error dialog.
 *
 * Two decisions are made here and nowhere else: WHAT to share, and whether the
 * companion talks (voice) or types (text). Both are fixed for the session, so
 * getting them in one screen keeps the overlay free of settings.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import type { BackseatMode, BackseatSource } from '../../../../shared/backseatIpc';
import { Button } from '../Button';
import styles from './BackseatSourcePicker.module.css';

export interface BackseatSourcePickerProps {
  characterId: string;
  companionName: string;
  /** Back to the tile grid. */
  onBack: () => void;
  /** The session started; the caller closes the popup. */
  onStarted: () => void;
}

export function BackseatSourcePicker({
  characterId,
  companionName,
  onBack,
  onStarted,
}: BackseatSourcePickerProps): React.ReactElement {
  const [sources, setSources] = useState<BackseatSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<BackseatMode>('voice');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await sei.backseatSources();
        if (alive) setSources(list);
      } catch {
        if (alive) {
          setSources([]);
          setError('Could not read your open windows. Check screen recording permission for Sei.');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const start = async (): Promise<void> => {
    const source = sources?.find((s) => s.id === selected);
    if (!source || starting) return;
    setStarting(true);
    setError(null);
    try {
      await sei.backseatStart(characterId, source.id, source.name, mode);
      onStarted();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      setError(
        msg.includes('BACKSEAT_MC_SESSION_ACTIVE')
          ? `${companionName} is in your Minecraft world right now. End that first.`
          : 'Could not start watching. Try picking a different window.',
      );
      setStarting(false);
    }
  };

  const screens = (sources ?? []).filter((s) => s.kind === 'screen');
  const windows = (sources ?? []).filter((s) => s.kind === 'window');

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack} aria-label="Back to games">
          &lsaquo;
        </button>
        <div className={styles.headings}>
          <h2 className={styles.title}>Show {companionName} your screen</h2>
          <p className={styles.sub}>
            Pick a window or a whole screen. Sound is shared too, so {companionName} can hear it.
          </p>
        </div>
      </div>

      <div className={styles.list}>
        {sources === null ? (
          <p className={styles.empty}>Looking for what you have open...</p>
        ) : sources.length === 0 ? (
          <p className={styles.empty}>Nothing to share yet. Open a game and come back.</p>
        ) : (
          <>
            {windows.length > 0 ? (
              <>
                <span className={styles.groupLabel}>Windows</span>
                <div className={styles.grid}>
                  {windows.map((s) => (
                    <SourceTile
                      key={s.id}
                      source={s}
                      selected={selected === s.id}
                      onPick={() => setSelected(s.id)}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {screens.length > 0 ? (
              <>
                <span className={styles.groupLabel}>Screens</span>
                <div className={styles.grid}>
                  {screens.map((s) => (
                    <SourceTile
                      key={s.id}
                      source={s}
                      selected={selected === s.id}
                      onPick={() => setSelected(s.id)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.modes} role="radiogroup" aria-label="How your companion replies">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'voice'}
            className={`${styles.mode} ${mode === 'voice' ? styles.modeOn : ''}`}
            onClick={() => setMode('voice')}
          >
            <span className={styles.modeName}>Voice</span>
            <span className={styles.modeHint}>{companionName} talks out loud</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'text'}
            className={`${styles.mode} ${mode === 'text' ? styles.modeOn : ''}`}
            onClick={() => setMode('text')}
          >
            <span className={styles.modeName}>Text</span>
            <span className={styles.modeHint}>Replies show in a small window</span>
          </button>
        </div>
        {error ? <p className={styles.error}>{error}</p> : null}
        <Button onClick={() => void start()} disabled={!selected || starting}>
          {starting ? 'Starting...' : 'Start watching'}
        </Button>
      </div>
    </div>
  );
}

function SourceTile({
  source,
  selected,
  onPick,
}: {
  source: BackseatSource;
  selected: boolean;
  onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`${styles.tile} ${selected ? styles.tileOn : ''}`}
      aria-pressed={selected}
      onClick={onPick}
    >
      <span className={styles.thumbWrap}>
        {source.thumbnail ? (
          <img className={styles.thumb} src={source.thumbnail} alt="" draggable={false} />
        ) : (
          <span className={styles.thumbBlank} />
        )}
      </span>
      <span className={styles.tileName}>
        {source.appIcon ? <img className={styles.appIcon} src={source.appIcon} alt="" /> : null}
        <span className={styles.tileText}>{source.name}</span>
      </span>
    </button>
  );
}
