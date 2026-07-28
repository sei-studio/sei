/**
 * DrawScreen — the whole Draw! surface.
 *
 * Deliberately outside the app's Summoning Terminal theme: a white page in a
 * handdrawn register, with as few elements as the game needs. It is a route of
 * its own rather than a panel in the chat screen, because the chat screen
 * splits top/bottom and this game wants canvas-beside-chat.
 *
 * Three phases map to three layouts:
 *   setup    title, a rounds slider, start
 *   drawing  header (word or who is drawing, and the clock) + canvas + chat,
 *   turn-end same layout, revealed answer, input still live
 *   gallery  the sheet
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_ROUNDS, MIN_ROUNDS, type DrawStroke } from '@shared/drawIpc';
import { useDrawStore } from '../../lib/stores/useDrawStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { DrawCanvas } from './DrawCanvas';
import { DrawChat } from './DrawChat';
import { DrawGallery } from './DrawGallery';
import { SquiggleFrame, SquiggleRule } from './Squiggle';
import { FullscreenIcon, ExitFullscreenIcon } from '../icons';
import styles from './draw.module.css';

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function DrawScreen({ characterId }: { characterId: string }): React.ReactElement {
  const state = useDrawStore((s) => s.games[characterId]);
  const starting = useDrawStore((s) => s.starting[characterId]);
  const error = useDrawStore((s) => s.error[characterId]);
  const savedTo = useDrawStore((s) => s.savedTo[characterId]);
  const open = useDrawStore((s) => s.open);
  const start = useDrawStore((s) => s.start);
  const sendStroke = useDrawStore((s) => s.sendStroke);
  const erase = useDrawStore((s) => s.erase);
  const sendChat = useDrawStore((s) => s.sendChat);
  const saveGallery = useDrawStore((s) => s.saveGallery);
  const end = useDrawStore((s) => s.end);
  const navigate = useUiStore((s) => s.navigate);
  // Draw! is a route of its own, so it already covers the chat screen; the
  // IconRail is the only chrome left to give up, and it stays by default.
  // Fullscreen here means "and the rail too". Cleared on unmount, so leaving
  // the game can never strand the app without its rail.
  const fullscreen = useUiStore((s) => s.gameFullscreen);
  const setFullscreen = useUiStore((s) => s.setGameFullscreen);
  useEffect(() => () => setFullscreen(false), [setFullscreen]);

  const [rounds, setRounds] = useState(3);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [now, setNow] = useState(() => Date.now());

  // Open the surface (setup phase) on first mount.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void open(characterId);
  }, [characterId, open]);

  // Turn clock. One interval for the whole screen; the countdown is the only
  // thing that needs wall-clock re-renders.
  const running = state?.phase === 'drawing';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  // The pen is the sensible default at the start of every drawing turn.
  useEffect(() => {
    if (state?.phase === 'drawing' && state.drawer === 'player') setTool('pen');
  }, [state?.turnKey, state?.phase, state?.drawer]);

  const close = (): void => {
    void end(characterId);
    navigate({ kind: 'chat', characterId });
  };

  const chatPlaceholder = useMemo(() => {
    if (!state) return 'Say something';
    if (state.phase === 'drawing' && state.drawer === 'ai') return 'Type your guess';
    if (state.phase === 'drawing') return 'Talk while you draw';
    return 'Say something';
  }, [state?.phase, state?.drawer]);

  if (!state) {
    return (
      <div className={styles.root}>
        <p className={styles.loading}>{error ?? 'Loading...'}</p>
      </div>
    );
  }

  if (state.phase === 'gallery') {
    return (
      <div className={styles.root}>
        <DrawGallery
          state={state}
          savedTo={savedTo ?? ''}
          onSave={(png) => void saveGallery(characterId, png)}
          onPlayAgain={() => void start(characterId, state.rounds)}
          onClose={close}
        />
      </div>
    );
  }

  if (state.phase === 'setup') {
    return (
      <div className={styles.root}>
        <div className={styles.setup}>
          <h1 className={styles.title}>Draw!</h1>
          <p className={styles.tagline}>
            Take turns drawing. Whoever is guessing types in the chat, and any sentence with the
            word in it counts.
          </p>
          <SquiggleRule seed="setup-rule" />

          <label className={styles.roundsLabel} htmlFor="draw-rounds">
            {rounds} round{rounds === 1 ? '' : 's'}
          </label>
          <input
            id="draw-rounds"
            className={styles.slider}
            type="range"
            min={MIN_ROUNDS}
            max={MAX_ROUNDS}
            step={1}
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
          />
          <p className={styles.roundsHint}>
            You draw {rounds} and {state.aiName} draws {rounds}. Three minutes a turn.
          </p>

          <button
            type="button"
            className={styles.handBtn}
            onClick={() => void start(characterId, rounds)}
            disabled={starting}
          >
            <SquiggleFrame seed="start-btn" />
            {starting ? 'Starting...' : 'Start'}
          </button>
          {error ? <p className={styles.error}>{error}</p> : null}
          <button type="button" className={styles.handBtnQuiet} onClick={close}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // drawing / turn-end
  const iAmDrawing = state.drawer === 'player';
  const live = state.phase === 'drawing';
  const remaining = state.turnEndsAt ? state.turnEndsAt - now : 0;

  const header = !live
    ? state.word
      ? `It was "${state.word}"`
      : 'Turn over'
    : iAmDrawing
      ? state.word ?? ''
      : `${state.aiName} is drawing`;

  return (
    <div className={styles.root}>
      <div className={styles.game}>
        <div className={styles.stage}>
          <header className={styles.header}>
            <span className={styles.round}>
              Round {state.round}/{state.rounds}
            </span>
            <span className={iAmDrawing && live ? styles.word : styles.headerNote}>{header}</span>
            <span className={styles.clock}>{live ? formatClock(remaining) : ''}</span>
          </header>

          <div className={styles.canvasFrame}>
            <SquiggleFrame seed="canvas-frame" strokeWidth={2.5} />
            <DrawCanvas
              characterId={characterId}
              strokes={state.strokes}
              mode={live ? (iAmDrawing ? 'player-draw' : 'ai-draw') : 'view'}
              tool={tool}
              turnToken={state.turnKey}
              onStroke={(stroke: DrawStroke) => sendStroke(characterId, stroke)}
              onErase={(id) => erase(characterId, id)}
            />
          </div>

          {/* Toolbar only exists on the player's own drawing turn. */}
          {live && iAmDrawing ? (
            <div className={styles.toolbar}>
              {(['pen', 'eraser'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tool === t ? `${styles.tool} ${styles.toolOn}` : styles.tool}
                  onClick={() => setTool(t)}
                  aria-pressed={tool === t}
                  aria-label={t === 'pen' ? 'Pen' : 'Stroke eraser'}
                  title={t === 'pen' ? 'Pen' : 'Eraser (removes a whole stroke)'}
                >
                  {tool === t ? <SquiggleFrame seed={`tool-${t}`} shape="ellipse" /> : null}
                  <span className={styles.toolGlyph}>{t === 'pen' ? '/' : 'x'}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.toolbarSpacer} />
          )}
        </div>

        <aside className={styles.side}>
          <div className={styles.sideHead}>
            <span className={styles.score}>
              {state.playerName} {state.scores.player} - {state.scores.ai} {state.aiName}
            </span>
            <div className={styles.sideActions}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setFullscreen(!fullscreen)}
                aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {fullscreen ? <ExitFullscreenIcon size={16} /> : <FullscreenIcon size={16} />}
              </button>
              <button type="button" className={styles.handBtnQuiet} onClick={close}>
                End
              </button>
            </div>
          </div>
          <SquiggleRule seed="side-rule" />
          <DrawChat
            messages={state.chat}
            playerName={state.playerName}
            aiName={state.aiName}
            placeholder={chatPlaceholder}
            disabled={!live}
            onSend={(t) => sendChat(characterId, t)}
          />
        </aside>
      </div>
    </div>
  );
}
