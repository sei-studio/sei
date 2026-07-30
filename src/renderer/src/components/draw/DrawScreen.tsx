/**
 * DrawScreen — the whole Draw! surface.
 *
 * Deliberately outside the app's Summoning Terminal theme: a white page in a
 * handdrawn register, with as few elements as the game needs. It is a route of
 * its own rather than a panel in the chat screen, because the chat screen
 * splits top/bottom and this game wants canvas-beside-chat.
 *
 * Four phases map to four layouts:
 *   setup    title, how many rounds, start
 *   pick     three words to choose between, before each of the player's turns
 *   drawing  header (word or who is drawing, and the clock) + canvas + chat,
 *   turn-end same layout, revealed answer, input still live
 *   gallery  the sheet
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ROUNDS, type DrawStroke } from '@shared/drawIpc';
import { useDrawStore } from '../../lib/stores/useDrawStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { DrawCanvas, type DrawCanvasControl } from './DrawCanvas';
import { DrawChat } from './DrawChat';
import { DrawGallery } from './DrawGallery';
import { GameChromeRow, CHROME_PROXIMITY_PX } from '../GameSurface';
import { ChatTopBar } from '../ChatTopBar';
import { SquiggleFrame, SquiggleHighlight, SquiggleRule } from './Squiggle';
import { Doodle } from './Doodle';
import { crown, horse, shrimp } from './doodles';
import styles from './draw.module.css';

/**
 * The three doodles on the start page. Real drawings from real games rather
 * than illustration: the point of the screen is to show what the game produces.
 * The middle one is small and sits higher, and flips out of phase with the
 * other two, so the row reads as three separate scraps of paper rather than one
 * shaking block.
 */
const DOODLES = [
  { data: shrimp, label: 'A hand-drawn shrimp', cls: styles.doodleLeft, wash: undefined },
  // Only the crown is coloured in, and roughly: one spot of colour is a
  // highlight, three would just be a palette.
  { data: crown, label: 'A hand-drawn crown', cls: styles.doodleMid, wash: 'var(--accent)' },
  { data: horse, label: 'A hand-drawn horse', cls: styles.doodleRight, wash: undefined },
] as const;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The route wrapper: the same ChatTopBar every companion surface carries
 * (chess gets it from ChatScreen), above the game page. Fullscreen hides it,
 * exactly as ChatScreen does for the chat-hosted games; the bar's buttons
 * (call, games) stay reachable through the bottom chrome row's fullscreen
 * affordances. The bar sits OUTSIDE .root on purpose: it keeps the app's own
 * theme, not the game's white paper palette.
 */
export function DrawScreen({ characterId }: { characterId: string }): React.ReactElement {
  const fullscreen = useUiStore((s) => s.gameFullscreen);
  return (
    <div className={styles.page}>
      {!fullscreen ? <ChatTopBar characterId={characterId} /> : null}
      <DrawScreenBody characterId={characterId} />
    </div>
  );
}

function DrawScreenBody({ characterId }: { characterId: string }): React.ReactElement {
  const state = useDrawStore((s) => s.games[characterId]);
  const starting = useDrawStore((s) => s.starting[characterId]);
  const error = useDrawStore((s) => s.error[characterId]);
  const savedTo = useDrawStore((s) => s.savedTo[characterId]);
  const open = useDrawStore((s) => s.open);
  const start = useDrawStore((s) => s.start);
  const newGame = useDrawStore((s) => s.newGame);
  const pickWord = useDrawStore((s) => s.pickWord);
  const sendStroke = useDrawStore((s) => s.sendStroke);
  const erase = useDrawStore((s) => s.erase);
  const sendChat = useDrawStore((s) => s.sendChat);
  const saveGallery = useDrawStore((s) => s.saveGallery);
  const resume = useDrawStore((s) => s.resume);
  const end = useDrawStore((s) => s.end);
  const navigate = useUiStore((s) => s.navigate);
  // Draw! is a route of its own, so it already covers the chat screen; the
  // IconRail is the only chrome left to give up, and it stays by default.
  // Fullscreen here means "and the rail too". Cleared on unmount, so leaving
  // the game can never strand the app without its rail. The toggle itself
  // lives in the universal bottom chrome row (GameChromeRow, 260729).
  const setFullscreen = useUiStore((s) => s.setGameFullscreen);
  useEffect(() => () => setFullscreen(false), [setFullscreen]);

  // Hover-reveal for the bottom chrome row, same proximity band as the
  // chat-hosted game surfaces.
  const [nearBottom, setNearBottom] = useState(false);

  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [now, setNow] = useState(() => Date.now());

  // The character's chat lines held back until the strokes it drew BEFORE
  // saying them have finished their on-screen playback (260729, from the web
  // version). Main pushes chat the moment the model emits it, but stroke
  // reveal runs at hand speed, so "you've got all the parts there" used to
  // land while the canvas was two strokes in. Pushes preserve order (strokes
  // leave main before the state push that carries the line), so a playback
  // barrier queued on arrival releases the line at the right moment.
  const canvasCtl = useRef<DrawCanvasControl | null>(null);
  const seenChatIds = useRef<Set<string>>(new Set());
  const [heldChatIds, setHeldChatIds] = useState<ReadonlySet<string>>(() => new Set());
  const chat = state?.chat;
  const aiTurn = state?.phase === 'drawing' && state?.drawer === 'ai';
  useEffect(() => {
    if (!chat) return;
    for (const m of chat) {
      if (seenChatIds.current.has(m.id)) continue;
      seenChatIds.current.add(m.id);
      if (!aiTurn || m.system || m.from !== 'ai') continue;
      const ctl = canvasCtl.current;
      if (!ctl) continue;
      setHeldChatIds((prev) => new Set(prev).add(m.id));
      ctl.queueBarrier(() => {
        setHeldChatIds((prev) => {
          if (!prev.has(m.id)) return prev;
          const next = new Set(prev);
          next.delete(m.id);
          return next;
        });
      });
    }
    // Leaving the character's drawing turn releases anything still held (belt
    // and braces: the canvas fires dropped barriers on every turn change too).
    if (!aiTurn) setHeldChatIds((prev) => (prev.size > 0 ? new Set() : prev));
  }, [chat, aiTurn]);
  const visibleChat = useMemo(
    () => (chat ?? []).filter((m) => !heldChatIds.has(m.id)),
    [chat, heldChatIds],
  );

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
          onSave={(png) => saveGallery(characterId, png)}
          onPlayAgain={() => void newGame(characterId)}
          onClose={close}
        />
      </div>
    );
  }

  if (state.phase === 'setup') {
    return (
      <div className={styles.root}>
        <div className={styles.setup}>
          <h1 className={`${styles.title} ${styles.titleBig}`}>DRAW!</h1>

          <div className={styles.doodles}>
            {DOODLES.map((d) => (
              <Doodle
                key={d.label}
                doodle={d.data}
                label={d.label}
                wash={d.wash}
                className={d.cls}
              />
            ))}
          </div>

          <p className={styles.tagline}>Take turns drawing and guessing. Three rounds.</p>

          <button
            type="button"
            className={styles.handBtn}
            data-on="true"
            onClick={() => void start(characterId, ROUNDS)}
            disabled={starting}
          >
            <SquiggleHighlight seed="start-hl" />
            <SquiggleFrame seed="start-btn" />
            <span className={styles.btnLabel}>{starting ? 'Starting...' : 'Start!'}</span>
          </button>
          {error ? <p className={styles.error}>{error}</p> : null}
          <button
            type="button"
            className={styles.handBtnQuiet}
            onClick={close}
            aria-label="Leave Draw!"
            title="Leave"
          >
            <SquiggleHighlight seed="setup-x-hl" />
            <span className={styles.btnLabel}>x</span>
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === 'pick') {
    return (
      <div className={styles.root}>
        <div className={styles.pick}>
          <h1 className={styles.title}>Pick a word</h1>
          <div className={styles.pickWords}>
            {state.wordChoices.map((w) => (
              <button
                key={w}
                type="button"
                className={styles.pickWord}
                onClick={() => pickWord(characterId, w)}
              >
                <SquiggleHighlight seed={`pick-hl-${w}`} />
                <SquiggleFrame seed={`pick-${w}`} />
                <span className={styles.btnLabel}>{w}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.handBtnQuiet}
            onClick={close}
            aria-label="Leave Draw!"
            title="Leave"
          >
            <SquiggleHighlight seed="pick-x-hl" />
            <span className={styles.btnLabel}>x</span>
          </button>
        </div>
      </div>
    );
  }

  // drawing / turn-end
  const iAmDrawing = state.drawer === 'player';
  const live = state.phase === 'drawing';
  const paused = state.paused === true;
  // While usage-limit paused the clock holds at the latched remainder (main
  // stopped its timers; turnEndsAt is stale by design until resume).
  const remaining = paused
    ? state.pausedRemainingMs ?? 0
    : state.turnEndsAt
      ? state.turnEndsAt - now
      : 0;

  const header = !live
    ? state.word
      ? `It was "${state.word}"`
      : 'Turn over'
    : iAmDrawing
      ? state.word ?? ''
      : `${state.aiName} is drawing`;

  return (
    <div
      className={styles.root}
      style={{ position: 'relative' }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setNearBottom(r.bottom - e.clientY <= CHROME_PROXIMITY_PX);
      }}
      onPointerLeave={() => setNearBottom(false)}
    >
      <div className={styles.game}>
        <div className={styles.stage}>
          <header className={styles.header}>
            <span className={styles.round}>
              Round {state.round}/{state.rounds}
            </span>
            <span className={iAmDrawing && live ? styles.word : styles.headerNote}>{header}</span>
            <span className={styles.clock}>{live ? formatClock(remaining) : ''}</span>
          </header>

          {/* The paper is ONE drawn box holding the drawing area and the tools.
              Its bottom edge is the bottom of the stage column, which is the
              bottom of the chat input on the right, so the two columns finish
              on the same line. The tools live in the space that buys, rather
              than hanging off the outside of the box (260728). */}
          <div className={styles.canvasBox}>
            <SquiggleFrame seed="canvas-frame" />
            {paused ? (
              <div className={styles.pausedOverlay}>
                <p className={styles.pausedTitle}>game paused</p>
                <p className={`${styles.pausedNote} ${styles.typed}`}>
                  usage limit reached. top up or wait, then resume: the turn picks
                  up right where it stopped.
                </p>
                <button
                  type="button"
                  className={styles.handBtn}
                  data-on="true"
                  onClick={() => resume(characterId)}
                >
                  <SquiggleHighlight seed="resume-hl" />
                  <SquiggleFrame seed="resume-btn" />
                  <span className={styles.btnLabel}>Resume</span>
                </button>
              </div>
            ) : null}
            <div className={styles.canvasFrame}>
              <DrawCanvas
                characterId={characterId}
                strokes={state.strokes}
                mode={live ? (iAmDrawing ? 'player-draw' : 'ai-draw') : 'view'}
                tool={tool}
                turnToken={state.turnKey}
                clearToken={state.clearSeq}
                onStroke={(stroke: DrawStroke) => sendStroke(characterId, stroke)}
                onErase={(id) => erase(characterId, id)}
                controlRef={canvasCtl}
              />
            </div>

            {/* Toolbar only exists on the player's own drawing turn. Both tools
                are always drawn in full: the ring is the tool's outline, not its
                selected state, so neither of them appears only on hover. */}
            {live && iAmDrawing ? (
              <div className={styles.toolbar}>
                {(['pen', 'eraser'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={styles.tool}
                    data-on={tool === t ? 'true' : 'false'}
                    onClick={() => setTool(t)}
                    aria-pressed={tool === t}
                    aria-label={t === 'pen' ? 'Pen' : 'Stroke eraser'}
                    title={t === 'pen' ? 'Pen' : 'Eraser (removes a whole stroke)'}
                  >
                    <SquiggleHighlight seed={`tool-hl-${t}`} shape="ellipse" />
                    <SquiggleFrame seed={`tool-${t}`} shape="ellipse" />
                    <span className={styles.toolGlyph}>{t === 'pen' ? '/' : 'x'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className={styles.toolbarSpacer} />
            )}
          </div>
        </div>

        <aside className={styles.side}>
          <div className={styles.sideHead}>
            <span className={styles.score}>
              {state.playerName} {state.scores.player} - {state.scores.ai} {state.aiName}
            </span>
          </div>
          <SquiggleRule seed="side-rule" />
          <DrawChat
            messages={visibleChat}
            playerName={state.playerName}
            aiName={state.aiName}
            placeholder={chatPlaceholder}
            disabled={!live}
            onSend={(t) => sendChat(characterId, t)}
          />
        </aside>
      </div>

      {/* The universal bottom button row (260729): fullscreen, the call
          cluster (or the phone that starts one), and the end "x". Same
          component, same reveal band, as the chat-hosted game surfaces. */}
      <GameChromeRow
        characterId={characterId}
        revealed={nearBottom}
        onEnd={close}
        confirmEnd
      />
    </div>
  );
}
