/**
 * Backseat panels 2 and 3 (260728) — the in-game overlay.
 *
 * This is the ONLY Sei surface visible for the whole session: the player is in
 * a game, and the main window is behind it. It is mounted in its own
 * always-on-top window (src/main/backseatOverlay.ts) by main.tsx's `?backseat=1`
 * branch, and it owns the capture pipeline for that reason.
 *
 * Panel 2 (voice mode) is the bare control cluster: a status dot, and pause and
 * stop, which appear on hover. Idle it is nearly nothing, because it is sitting
 * on top of a game and anything permanent is in the way.
 *
 * Panel 3 (text mode) is the same cluster with a small translucent chat panel
 * above it, always shown. It is NOT a separate conversation: the lines in it
 * are the same messages that land in the character's normal chat thread, and
 * anything typed here goes to the same place.
 *
 * The whole surface is draggable except the controls (see `-webkit-app-region`
 * in the stylesheet), so the player can move it out of their crosshair.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { startCapture, stopCapture, type CaptureHandle } from '../../lib/backseat/captureController';
import type { BackseatLine, BackseatMode, BackseatState } from '../../../../shared/backseatIpc';
import styles from './BackseatOverlay.module.css';

/** Lines shown in the mini chat. Older ones scroll off; the real transcript
 *  keeps everything. */
const VISIBLE_LINES = 12;

function params(): { characterId: string; sourceId: string; mode: BackseatMode } {
  const q = new URLSearchParams(window.location.search);
  return {
    characterId: q.get('characterId') ?? '',
    sourceId: q.get('sourceId') ?? '',
    mode: q.get('mode') === 'text' ? 'text' : 'voice',
  };
}

export function BackseatOverlay(): React.ReactElement | null {
  const { characterId, sourceId, mode } = params();
  const [state, setState] = useState<BackseatState | null>(null);
  const [lines, setLines] = useState<BackseatLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const capture = useRef<CaptureHandle | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  // ── Capture lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    if (!characterId || !sourceId) return;
    let alive = true;
    void (async () => {
      try {
        const handle = await startCapture(characterId, sourceId);
        if (!alive) {
          handle.stop();
          return;
        }
        capture.current = handle;
      } catch (err) {
        if (alive) setFailure((err as Error).message || 'Could not read that window.');
      }
    })();
    return () => {
      alive = false;
      stopCapture();
      capture.current = null;
    };
  }, [characterId, sourceId]);

  // ── State and line pushes ───────────────────────────────────────────────
  useEffect(() => {
    const offState = sei.onBackseatState((s) => {
      if (s.characterId !== characterId) return;
      setState(s);
      setPaused(s.phase === 'paused');
      // Main's state carries the authoritative tail; adopting it on every push
      // keeps the overlay correct across a reload without a separate fetch.
      setLines(s.lines.slice(-VISIBLE_LINES));
    });
    const offLine = sei.onBackseatLine((l) => {
      if (l.characterId !== characterId) return;
      setLines((prev) => [...prev, l].slice(-VISIBLE_LINES));
    });
    void sei.backseatGetState(characterId).then((s) => {
      if (s) {
        setState(s);
        setPaused(s.phase === 'paused');
        setLines(s.lines.slice(-VISIBLE_LINES));
      }
    });
    return () => {
      offState();
      offLine();
    };
  }, [characterId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const togglePause = useCallback(() => {
    const next = !paused;
    setPaused(next);
    capture.current?.setPaused(next);
    void sei.backseatSetPaused(characterId, next).catch(() => {});
  }, [paused, characterId]);

  const stop = useCallback(() => {
    capture.current?.stop();
    capture.current = null;
    void sei.backseatEnd(characterId).catch(() => {});
  }, [characterId]);

  // ── The player's own line ───────────────────────────────────────────────
  // Typing ARMS a grid capture on the first keystroke, so the companion sees
  // what was on screen when the player reacted rather than what is there when
  // they finish typing. armUserGrid is idempotent and single-flighted, so
  // holding down a key does not composite once per character.
  const onDraft = (value: string): void => {
    setDraft(value);
    if (value.length > 0 && !paused) capture.current?.armUserGrid();
  };

  const send = (): void => {
    const text = draft.trim();
    if (!text || paused) return;
    setDraft('');
    void capture.current?.sendUserTick(text).catch(() => {});
  };

  if (!characterId) return null;

  const name = state?.aiName ?? '';
  const isText = mode === 'text';

  return (
    <div className={`${styles.root} ${isText ? styles.rootText : ''}`}>
      {isText ? (
        <div className={styles.chat}>
          <div className={styles.chatHead}>
            <span className={styles.chatName}>{name}</span>
            {state?.sourceName ? (
              <span className={styles.chatSource} title={state.sourceName}>
                {state.sourceName}
              </span>
            ) : null}
          </div>
          <div className={styles.lines} ref={scroller}>
            {lines.length === 0 ? (
              <p className={styles.placeholder}>
                {paused ? 'Paused.' : `${name || 'Watching'} is watching.`}
              </p>
            ) : (
              lines.map((l) => (
                <div key={l.id} className={styles.line}>
                  <span className={styles.lineText}>{l.text}</span>
                  {l.clipPath ? (
                    <button
                      type="button"
                      className={styles.clip}
                      onClick={() => void sei.backseatRevealClip(l.clipPath as string).catch(() => {})}
                    >
                      Clip saved
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
          <input
            className={styles.input}
            value={draft}
            disabled={paused}
            placeholder={paused ? 'Paused' : 'Say something...'}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
      ) : null}

      <div className={styles.bar}>
        <span
          className={`${styles.dot} ${paused ? styles.dotPaused : ''} ${failure ? styles.dotError : ''}`}
          aria-hidden="true"
        />
        <span className={styles.label}>
          {failure ? 'Cannot see the screen' : paused ? 'Paused' : `${name} is watching`}
        </span>
        {/* Controls reveal on hover of the whole bar: permanently visible
            buttons on top of a game are clutter, and this is on screen for
            hours at a time. */}
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.control}
            onClick={togglePause}
            title={paused ? 'Resume' : 'Pause'}
            aria-label={paused ? 'Resume watching' : 'Pause watching'}
          >
            {paused ? (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className={`${styles.control} ${styles.stop}`}
            onClick={stop}
            title="Stop watching"
            aria-label="Stop watching"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
