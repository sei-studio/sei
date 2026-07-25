/**
 * WatchPanel — the screen-share surface that slides into the chat screen
 * (260720). Follows the ChessPanel shell (header / center card / live
 * surface), with a consent-first flow instead of a board:
 *
 * States, in order of precedence:
 *   - macOS Screen Recording permission missing (or main reports all-black
 *     captures) → walkthrough card: open System Settings deep-link, explain
 *     the relaunch requirement, re-check button;
 *   - no session yet → source picker: windows first (encouraged), screens in
 *     a subdued section below, live thumbnail previews, explicit Start;
 *   - session active → live preview snapshot (~3s), session timer, the
 *     "Watching" status and Stop.
 *
 * Nothing ever auto-starts: a session begins only on the Start click here.
 */

import React, { useEffect, useState } from 'react';
import { useWatchStore } from '../../lib/stores/useWatchStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import {
  WATCH_ERR_GAME_ACTIVE,
  WATCH_ERR_MC_ACTIVE,
  WATCH_ERR_CREDITS,
  type WatchSource,
} from '@shared/watchIpc';
import { Button } from '../Button';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { RefreshIcon, StopIcon } from '../icons';
import styles from './WatchPanel.module.css';

export interface WatchPanelProps {
  characterId: string;
}

function fmtTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function WatchPanel({ characterId }: WatchPanelProps): React.ReactElement {
  const session = useWatchStore((s) => s.sessions[characterId] ?? null);
  const preview = useWatchStore((s) => s.previews[characterId] ?? null);
  const sources = useWatchStore((s) => s.sources);
  const sourcesLoading = useWatchStore((s) => s.sourcesLoading);
  const permission = useWatchStore((s) => s.permission);
  const starting = useWatchStore((s) => s.starting[characterId] ?? false);
  const refreshSources = useWatchStore((s) => s.refreshSources);
  const start = useWatchStore((s) => s.start);
  const stop = useWatchStore((s) => s.stop);
  const closePanel = useWatchStore((s) => s.closePanel);
  const hydrate = useWatchStore((s) => s.hydrate);
  const openPermissionSettings = useWatchStore((s) => s.openPermissionSettings);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? 'Companion';

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Resume any session main still holds + load the picker list.
  useEffect(() => {
    void hydrate(characterId);
    void refreshSources();
  }, [characterId, hydrate, refreshSources]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setSelectedId(null);
    setStartErr(null);
  }, [characterId]);

  const active = session?.status === 'active';

  // Session timer tick (1s) while active.
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  const doStart = async (sourceId: string): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, sourceId);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (msg.includes(WATCH_ERR_MC_ACTIVE)) {
        setStartErr(`${name} is playing in a Minecraft world right now. Disconnect them first.`);
      } else if (msg.includes(WATCH_ERR_GAME_ACTIVE)) {
        setStartErr(`${name} is in the middle of a game. Close it first.`);
      } else if (msg.includes(WATCH_ERR_CREDITS)) {
        setStartErr('You are out of playtime. Add playtime to start watching.');
      } else if (/no longer available/.test(msg)) {
        setStartErr('That window is no longer available. Pick another one.');
        void refreshSources();
      } else if (/not available in this build/.test(msg)) {
        setStartErr('Screen share is not available in this build yet.');
      } else {
        setStartErr("Watching couldn't start. Try again in a moment.");
      }
    }
  };

  // Permission walkthrough shows when the OS refuses (macOS) or when main
  // reports all-black captures mid-session (permission revoked or missing).
  const needsPermission =
    (permission != null && permission !== 'granted') || (active && session?.blank === true);

  const windows = (sources ?? []).filter((s) => s.kind === 'window');
  const screens = (sources ?? []).filter((s) => s.kind === 'screen');

  return (
    <div className={styles.panel} aria-label={`Screen share with ${name}`}>
      {/* ── Header ── */}
      <header className={styles.head}>
        <span className={styles.headName}>Screen share</span>
        {active ? (
          <span className={styles.headWatching}>
            <span className={styles.liveDot} aria-hidden="true" />
            Watching: {session?.sourceName}
          </span>
        ) : (
          <span className={styles.headMuted}>Not sharing</span>
        )}
        {/* 260721: closing/ending moved to the unified GameSurface "x". */}
      </header>

      {/* ── Body ── */}
      {needsPermission ? (
        <div className={styles.centerCard}>
          <h3 className={styles.cardTitle}>Allow screen recording</h3>
          <p className={styles.cardHint}>
            macOS needs your permission before Sei can see the screen.
            {active && session?.blank
              ? ' The current capture is coming back black, which usually means the permission is off.'
              : ''}
          </p>
          <ol className={styles.permSteps}>
            <li>Click Open System Settings below.</li>
            <li>Turn on Sei under Screen &amp; System Audio Recording.</li>
            <li>Quit and reopen Sei. macOS applies the permission only after a relaunch.</li>
          </ol>
          <div className={styles.cardActions}>
            <Button kind="accent" size="md" onClick={() => openPermissionSettings()}>
              Open System Settings
            </Button>
            <Button kind="quiet" size="md" onClick={() => void refreshSources()}>
              Check again
            </Button>
          </div>
        </div>
      ) : active && session ? (
        <div className={styles.live}>
          <div className={styles.previewBox}>
            {preview ? (
              <img className={styles.previewImg} src={preview.url} alt="Shared screen preview" />
            ) : (
              <div className={styles.previewEmpty}>Waiting for the first frame…</div>
            )}
          </div>
          <div className={styles.liveMeta}>
            <span className={styles.liveName}>
              {name} is watching {session.sourceName}
            </span>
            <span className={styles.liveTimer}>{fmtTimer(now - session.startedAt)}</span>
            <Button
              kind="danger"
              size="sm"
              icon={<StopIcon size={12} />}
              onClick={() => void stop(characterId)}
            >
              Stop
            </Button>
          </div>
          <p className={styles.liveHint}>
            Only the window you picked is shared. {name} sees snapshots of it and reacts in the
            chat. Chat back anytime.
          </p>
        </div>
      ) : (
        <div className={styles.picker}>
          <div className={styles.pickerIntro}>
            <h3 className={styles.cardTitle}>Share your screen with {name}</h3>
            <p className={styles.cardHint}>
              Pick exactly what {name} can see. A single window is the best pick; nothing outside
              it is ever captured. {name} watches along and reacts in the chat.
            </p>
          </div>

          <div className={styles.sectionRow}>
            <span className={styles.sectionTitle}>Windows</span>
            <span className={styles.sectionNote}>recommended</span>
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => void refreshSources()}
              aria-label="Refresh window list"
              title="Refresh"
            >
              <RefreshIcon size={14} />
            </button>
          </div>
          {sourcesLoading && !sources ? (
            <p className={styles.pickerEmpty}>Looking for windows…</p>
          ) : windows.length === 0 ? (
            <p className={styles.pickerEmpty}>No capturable windows found. Open the game first.</p>
          ) : (
            <div className={styles.grid}>
              {windows.map((s) => (
                <SourceTile
                  key={s.id}
                  source={s}
                  selected={selectedId === s.id}
                  onSelect={() => setSelectedId(s.id)}
                />
              ))}
            </div>
          )}

          {screens.length > 0 ? (
            <>
              <div className={styles.sectionRow}>
                <span className={styles.sectionTitle}>Entire screens</span>
                <span className={styles.sectionNote}>shares everything on the display</span>
              </div>
              <div className={`${styles.grid} ${styles.gridScreens}`}>
                {screens.map((s) => (
                  <SourceTile
                    key={s.id}
                    source={s}
                    selected={selectedId === s.id}
                    onSelect={() => setSelectedId(s.id)}
                  />
                ))}
              </div>
            </>
          ) : null}

          {startErr ? <p className={styles.errorText}>{startErr}</p> : null}
          <div className={styles.cardActions}>
            <Button kind="quiet" size="md" onClick={() => closePanel(characterId)}>
              Not now
            </Button>
            <Button
              kind="accent"
              size="md"
              disabled={!selectedId || starting}
              onClick={() => {
                // 260721: shared cross-launch gate — another live game (a
                // chess game, a summoned bot) confirms before this starts.
                if (!selectedId) return;
                const sourceId = selectedId;
                requestGameLaunch(characterId, { id: 'watch', name: 'Screen share' }, () =>
                  void doStart(sourceId),
                );
              }}
            >
              {starting ? 'Starting…' : 'Start watching'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceTile({
  source,
  selected,
  onSelect,
}: {
  source: WatchSource;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={selected ? `${styles.tile} ${styles.tileSelected}` : styles.tile}
      onClick={onSelect}
      aria-pressed={selected}
      title={source.name}
    >
      <span className={styles.tileThumb}>
        <img src={source.thumbnailDataUrl} alt="" />
      </span>
      <span className={styles.tileName}>
        {source.appIconDataUrl ? (
          <img className={styles.tileIcon} src={source.appIconDataUrl} alt="" />
        ) : null}
        <span className={styles.tileLabel}>{source.name}</span>
      </span>
    </button>
  );
}
