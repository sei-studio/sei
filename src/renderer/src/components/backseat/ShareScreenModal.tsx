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
 *
 * 260803: TWO entry points now. The call controls still open this with a call
 * already running, and that path is unchanged: pick a window, press Share, the
 * capture starts on the call you are on. The chat header's Backseat button
 * opens the same picker COLD, with no call at all, and there "Share" has to
 * produce both. It cannot do that inline (the voice module's install/consent
 * gate can hold the dial for minutes, or refuse it), so it arms a pending share
 * in useBackseatStore and routes into the call; CallMiniBar starts the capture
 * when the call goes live. See the store's header for the arm's lifetime.
 *
 * The cold path navigates to the call view directly rather than going through
 * startOrOpenCall. startOrOpenCall starts the call IN PLACE when a game surface
 * is open, and the shared picture is drawn by VoiceCallScreen only, so an
 * in-place start would leave the share running with nowhere to see it. This is
 * the same reasoning callLaunch gives for not counting a share as a game
 * surface.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { isGameSurfaceOpen } from '../../lib/callLaunch';
import type { BackseatSource } from '../../../../shared/backseatIpc';
import { ModalShell, ModalFooter } from '../ModalShell';
import { Button } from '../Button';
import styles from './ShareScreenModal.module.css';

export interface ShareScreenModalProps {
  characterId: string;
}

export function ShareScreenModal({ characterId }: ShareScreenModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const navigate = useUiStore((s) => s.navigate);
  const characters = useDataStore((s) => s.characters);
  const companionName = characters.find((c) => c.id === characterId)?.name ?? 'Your companion';

  const share = useBackseatStore((s) => s.share);
  const armPendingShare = useBackseatStore((s) => s.armPendingShare);
  const starting = useBackseatStore((s) => s.starting);
  const shareError = useBackseatStore((s) => s.error);

  // "Is this companion on a call right now": membership, not status, so a call
  // still ringing behaves exactly as it does today (the call controls' share
  // button is live during 'connecting' too). An errored call is not a call.
  const onCall = useVoiceStore(
    (s) => s.participants.includes(characterId) && s.status !== 'error',
  );

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
    if (!onCall) {
      // Cold start: there is nothing to attach the capture to yet. Arm it and
      // go dial. Closing first keeps the picker from sitting over the call
      // view's install gate.
      armPendingShare(characterId, source);
      closeModal();
      navigate({ kind: 'voice-call', characterId });
      return;
    }
    // The store owns the failure message, so a refused start leaves this modal
    // open with the reason on it rather than closing over a dead session.
    if (!(await share(characterId, source))) return;
    closeModal();
    // A live call can be reached from three places, and only one of them can
    // draw the shared picture. The rule is the same one callLaunch uses: go to
    // the call view unless the player is somewhere the call already belongs.
    //   - the fullscreen call controls: view is already 'voice-call', so this
    //     is a no-op and that path is untouched;
    //   - the docked in-game controls: a game surface is open, and yanking the
    //     player out of their game to look at a preview would be wrong, so it
    //     is a no-op there too;
    //   - the chat header (the new entry point): nothing on the chat screen
    //     renders the share, so without this the player pressed Share and
    //     watched nothing happen.
    const ui = useUiStore.getState();
    if (ui.view.kind !== 'voice-call' && !isGameSurfaceOpen(characterId)) {
      ui.navigate({ kind: 'voice-call', characterId });
    }
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
        {/* The second sentence appears only when there is no call yet: telling
            someone they are about to start a call they are already on is
            noise. One paragraph, not two, because .root's flex gap would put a
            full row between them. */}
        <p className={styles.sub}>
          {`Sound is shared too, so ${companionName} can hear it.`}
          {!onCall ? ' Sharing starts a voice call.' : ''}
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
