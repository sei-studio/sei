/**
 * Share-screen picker (260728 as a games-picker panel, remade as a call modal
 * 260803).
 *
 * WHERE THIS IS REACHED FROM is the whole change. Screen sharing used to be a
 * tile in the "Play together" grid, which said it was a game and put it beside
 * chess. It is not a game, it is the thing Discord does: you are already on a
 * call, you press the share button in the call controls, you pick a window.
 * So the tile is gone and this is a modal over the call.
 *
 * One decision is left, WHAT to share. The voice/text mode toggle went with the
 * overlay window: sharing now requires a call, and on a call the companion
 * talks.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import type { BackseatSource } from '../../../../shared/backseatIpc';
import { ModalShell, ModalFooter } from '../ModalShell';
import { Button } from '../Button';
import styles from './ShareScreenModal.module.css';

export interface ShareScreenModalProps {
  characterId: string;
}

export function ShareScreenModal({ characterId }: ShareScreenModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const characters = useDataStore((s) => s.characters);
  const companionName = characters.find((c) => c.id === characterId)?.name ?? 'Your companion';

  const share = useBackseatStore((s) => s.share);
  const starting = useBackseatStore((s) => s.starting);
  const shareError = useBackseatStore((s) => s.error);

  const [sources, setSources] = useState<BackseatSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Two tabs rather than two stacked sections (260804). The window list is as
  // long as the player has windows open, so the one or two screens underneath
  // it were below the fold and effectively hidden. Windows lead because they
  // are the better share: one app, no notifications, no second monitor of
  // nothing.
  const [tab, setTab] = useState<'window' | 'screen'>('window');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await sei.backseatSources();
        if (alive) setSources(list);
      } catch {
        if (alive) {
          setSources([]);
          setListError(
            'Could not read your open windows. Check screen recording permission for Sei.',
          );
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
    // The store owns the failure message, so a refused start leaves this modal
    // open with the reason on it rather than closing over a dead session.
    if (await share(characterId, source)) closeModal();
  };

  const screens = (sources ?? []).filter((s) => s.kind === 'screen');
  const windows = (sources ?? []).filter((s) => s.kind === 'window');
  const shown = tab === 'window' ? windows : screens;
  const error = listError ?? shareError;

  // Switching tabs drops the selection: the Share button must never act on a
  // source the player can no longer see.
  const pickTab = (next: 'window' | 'screen'): void => {
    if (next === tab) return;
    setTab(next);
    setSelected(null);
  };

  return (
    <ModalShell
      title={`Show ${companionName} your screen`}
      width={640}
      scrimClose
      onClose={closeModal}
    >
      <div className={styles.root}>
        <p className={styles.sub}>
          Sound is shared too, so {companionName} can hear it.
        </p>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'window'}
            className={`${styles.tab} ${tab === 'window' ? styles.tabOn : ''}`}
            onClick={() => pickTab('window')}
          >
            Window
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'screen'}
            className={`${styles.tab} ${tab === 'screen' ? styles.tabOn : ''}`}
            onClick={() => pickTab('screen')}
          >
            Entire screen
          </button>
        </div>

        <div className={styles.list}>
          {sources === null ? (
            <p className={styles.empty}>Looking for what you have open...</p>
          ) : shown.length === 0 ? (
            <p className={styles.empty}>
              {tab === 'window'
                ? 'No windows open to share. Open something and come back.'
                : 'No screens available to share.'}
            </p>
          ) : (
            <div className={styles.grid}>
              {shown.map((s) => (
                <SourceTile
                  key={s.id}
                  source={s}
                  selected={selected === s.id}
                  onPick={() => setSelected(s.id)}
                />
              ))}
            </div>
          )}
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}
      </div>

      <ModalFooter>
        <Button kind="quiet" size="md" onClick={closeModal}>
          Cancel
        </Button>
        <Button size="md" onClick={() => void start()} disabled={!selected || starting}>
          {starting ? 'Starting...' : 'Share'}
        </Button>
      </ModalFooter>
    </ModalShell>
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
