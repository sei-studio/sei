/**
 * ChessPanel — the chess surface that slides into the chat screen (260710).
 *
 * States, in order of precedence:
 *   - no game yet (panel opened from the games picker) → pre-game setup card:
 *     color choice (White / Black / Random) + Start;
 *   - status 'preparing' → one-time engine download progress;
 *   - status 'active' → live board + move list + controls (resign with inline
 *     confirm, offer draw, flip) + draw-offer banner;
 *   - status 'ended' → compact result banner with Rematch + Close.
 *
 * The AI move reveal is paced by useAiMoveReveal (commentary first, then the
 * piece slides). Starting while the companion is summoned in Minecraft rejects
 * with CHESS_MC_SESSION_ACTIVE; a confirm modal offers to disconnect the bot
 * and retry.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChessStore, boardUiFor } from '../../lib/stores/useChessStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { sei } from '../../lib/ipcClient';
import { pickPalette } from '../../lib/portraitPalettes';
import { PixelPortrait } from '../PixelPortrait';
import { Button } from '../Button';
import { Seg } from '../Seg';
import { PercentBar } from '../PercentBar';
import { ModalShell, ModalFooter } from '../ModalShell';
import { RotateIcon } from '../icons';
import { ChessBoard } from './ChessBoard';
import { useAiMoveReveal } from './useAiMoveReveal';
import { capturedMaterial } from './chessUtil';
import { Piece } from './pieces';
import type { ChessGameState, ChessResult } from '@shared/chessIpc';
import styles from './ChessPanel.module.css';

export interface ChessPanelProps {
  characterId: string;
}

type ColorChoice = 'w' | 'b' | 'random';

/** Plain-language result copy (no em dashes in user-visible text). */
function resultCopy(result: ChessResult, game: ChessGameState, name: string): {
  title: string;
  detail: string;
} {
  const playerWon = result.winner !== null && result.winner === game.playerColor;
  const title =
    result.winner === null ? 'Draw' : playerWon ? 'You won' : `${name} won`;
  switch (result.reason) {
    case 'checkmate':
      return { title, detail: 'Checkmate.' };
    case 'stalemate':
      return { title: 'Draw', detail: 'Stalemate. No legal moves left.' };
    case 'draw-agreed':
      return { title: 'Draw', detail: 'You both agreed to a draw.' };
    case 'draw-material':
      return { title: 'Draw', detail: 'Not enough pieces left to checkmate.' };
    case 'draw-repetition':
      return { title: 'Draw', detail: 'The same position repeated three times.' };
    case 'draw-fifty':
      return { title: 'Draw', detail: 'Fifty moves without a capture or pawn move.' };
    case 'resign':
      return { title, detail: `You resigned. ${name} takes the game.` };
    case 'forfeit':
      return { title, detail: `${name} forfeited the game.` };
    case 'abandoned':
      return { title: 'Game closed', detail: 'This game ended without a result.' };
    default:
      return { title, detail: '' };
  }
}

export function ChessPanel({ characterId }: ChessPanelProps): React.ReactElement {
  const game = useChessStore((s) => s.games[characterId] ?? null);
  const download = useChessStore((s) => s.downloads[characterId]);
  const starting = useChessStore((s) => s.starting[characterId] ?? false);
  const ui = useChessStore((s) => boardUiFor(s, characterId));
  const start = useChessStore((s) => s.start);
  const resign = useChessStore((s) => s.resign);
  const offerDraw = useChessStore((s) => s.offerDraw);
  const respondDraw = useChessStore((s) => s.respondDraw);
  const rematch = useChessStore((s) => s.rematch);
  const end = useChessStore((s) => s.end);
  const setUi = useChessStore((s) => s.setUi);
  const hydrate = useChessStore((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? 'Companion';

  const [colorChoice, setColorChoice] = useState<ColorChoice>('random');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [mcConflict, setMcConflict] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);

  useAiMoveReveal(characterId);

  // Resume any game main still holds (navigation away and back, relaunch).
  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setStartErr(null);
    setMcConflict(false);
    setConfirmResign(false);
  }, [characterId]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const doStart = async (choice: ColorChoice): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId, choice);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/CHESS_MC_SESSION_ACTIVE/.test(msg)) {
        setMcConflict(true);
      } else if (/CHESS_MODEL_DOWNLOAD_FAILED/.test(msg)) {
        setStartErr('The chess brain failed to download. Check your connection and try again.');
      } else if (/not available in this build/.test(msg)) {
        setStartErr('Chess is not available in this build yet.');
      } else {
        setStartErr("The game couldn't start. Try again in a moment.");
      }
    }
  };

  const onConfirmDisconnect = async (): Promise<void> => {
    setMcConflict(false);
    // Same instant-disconnect path the chat panel uses: flip presence locally,
    // then tear the session down (stop is idempotent).
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    try {
      await sei.stop(characterId);
    } catch {
      /* already stopped */
    }
    await doStart(colorChoice);
  };

  // ── Move list auto-scroll ─────────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement | null>(null);
  const historyLen = game?.history.length ?? 0;
  useEffect(() => {
    if (ui.viewPly !== null) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historyLen, ui.viewPly]);

  const captured = useMemo(
    () => (game ? capturedMaterial(game.fen) : null),
    [game],
  );

  const statusLine = ((): React.ReactElement | null => {
    if (!game) return null;
    if (game.status === 'preparing') return <span className={styles.statusMuted}>Warming up</span>;
    if (game.status === 'ended') return <span className={styles.statusMuted}>Game over</span>;
    if (game.aiThinking) return <span className={styles.thinking}>thinking…</span>;
    if (game.turn === game.playerColor) return <span className={styles.statusYou}>Your move</span>;
    return <span className={styles.statusMuted}>Waiting</span>;
  })();

  const downloadFailed = download?.pct === -1;

  return (
    <div className={styles.panel} aria-label={`Chess with ${name}`}>
      {/* ── Header ── */}
      <header className={styles.head}>
        <div className={styles.headAvatar}>
          {character ? (
            <PixelPortrait
              seed={character.id + character.name}
              palette={palette}
              size={26}
              portraitImage={character.portrait_image}
              style={{ width: '100%', height: '100%' }}
            />
          ) : null}
        </div>
        <span className={styles.headName}>{name}</span>
        {game ? <span className={styles.headElo}>Elo ~{game.aiElo}</span> : null}
        <span className={styles.headStatus}>{statusLine}</span>
        {!game || game.status !== 'active' ? (
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => void end(characterId)}
            aria-label="Close chess"
            title="Close chess"
          >
            ×
          </button>
        ) : null}
      </header>

      {/* ── Body ── */}
      {!game ? (
        <div className={styles.centerCard}>
          <h3 className={styles.cardTitle}>Play chess with {name}</h3>
          <p className={styles.cardHint}>
            An untimed game. {name} will talk while you play, and you can chat back anytime.
          </p>
          <div className={styles.colorRow}>
            <Seg<ColorChoice>
              options={[
                { value: 'w', label: 'White' },
                { value: 'random', label: 'Random' },
                { value: 'b', label: 'Black' },
              ]}
              value={colorChoice}
              onChange={setColorChoice}
              aria-label="Your color"
              disabled={starting}
            />
          </div>
          {startErr ? <p className={styles.errorText}>{startErr}</p> : null}
          <div className={styles.cardActions}>
            <Button kind="quiet" size="md" onClick={() => void end(characterId)}>
              Not now
            </Button>
            <Button kind="accent" size="md" disabled={starting} onClick={() => void doStart(colorChoice)}>
              {starting ? 'Starting…' : 'Start game'}
            </Button>
          </div>
        </div>
      ) : game.status === 'preparing' ? (
        <div className={styles.centerCard}>
          <h3 className={styles.cardTitle}>Getting ready</h3>
          <p className={styles.cardHint}>Setting up the chess brain (one-time download).</p>
          {downloadFailed ? (
            <>
              <p className={styles.errorText}>
                {download?.error ?? 'The download failed. Check your connection and try again.'}
              </p>
              <div className={styles.cardActions}>
                <Button kind="quiet" size="md" onClick={() => void end(characterId)}>
                  Cancel
                </Button>
                <Button kind="accent" size="md" onClick={() => void doStart(colorChoice)}>
                  Try again
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.progressWrap}>
              <PercentBar
                value={Math.max(0, download?.pct ?? 0)}
                label="Chess engine download progress"
                size="md"
              />
            </div>
          )}
        </div>
      ) : (
        <div className={styles.main}>
          <div className={styles.boardArea}>
            <div className={styles.boardBox}>
              <ChessBoard characterId={characterId} />
            </div>
          </div>

          <div className={styles.side}>
            {/* Captured material (pieces each side has taken). */}
            {captured && (captured.w.length || captured.b.length) ? (
              <div className={styles.capturedRows}>
                <CapturedRow
                  pieces={captured.b.map((t) => `b${t}`)}
                  diff={captured.diff > 0 ? `+${captured.diff}` : null}
                  label="Captured by white"
                />
                <CapturedRow
                  pieces={captured.w.map((t) => `w${t}`)}
                  diff={captured.diff < 0 ? `+${-captured.diff}` : null}
                  label="Captured by black"
                />
              </div>
            ) : null}

            {/* Move list */}
            <div className={styles.moves} ref={listRef}>
              {game.history.length === 0 ? (
                <div className={styles.movesEmpty}>No moves yet</div>
              ) : (
                pairs(game.history.length).map(([wi, bi], n) => (
                  <div key={n} className={styles.moveRow}>
                    <span className={styles.moveNum}>{n + 1}.</span>
                    <MoveCell
                      san={game.history[wi]?.san}
                      active={ui.viewPly === wi}
                      onClick={() => setUi(characterId, { viewPly: wi, selected: null })}
                    />
                    <MoveCell
                      san={bi < game.history.length ? game.history[bi]?.san : undefined}
                      active={ui.viewPly === bi}
                      onClick={() => setUi(characterId, { viewPly: bi, selected: null })}
                    />
                  </div>
                ))
              )}
            </div>
            {ui.viewPly !== null ? (
              <button
                type="button"
                className={styles.backToLive}
                onClick={() => setUi(characterId, { viewPly: null })}
              >
                Back to live
              </button>
            ) : null}

            {/* Draw offer banner */}
            {game.status === 'active' && game.drawOffer === 'ai' ? (
              <div className={styles.offerBanner}>
                <span>{name} offers a draw</span>
                <div className={styles.offerActions}>
                  <Button kind="accent" size="sm" onClick={() => void respondDraw(characterId, true)}>
                    Accept
                  </Button>
                  <Button kind="quiet" size="sm" onClick={() => void respondDraw(characterId, false)}>
                    Decline
                  </Button>
                </div>
              </div>
            ) : null}
            {game.status === 'active' && game.drawOffer === 'player' ? (
              <div className={styles.offerNote}>Draw offer sent</div>
            ) : null}

            {/* Result banner */}
            {game.status === 'ended' && game.result ? (
              <ResultBanner result={game.result} game={game} name={name} />
            ) : null}

            {/* Controls */}
            <div className={styles.controls}>
              <button
                type="button"
                className={styles.ctrlBtn}
                onClick={() => setUi(characterId, { flip: !(ui.flip ?? false) })}
                aria-label="Flip board"
                data-tip="Flip board"
              >
                <RotateIcon size={14} />
                <span>Flip</span>
              </button>
              {game.status === 'active' ? (
                <>
                  <button
                    type="button"
                    className={styles.ctrlBtn}
                    disabled={game.drawOffer !== null}
                    onClick={() => void offerDraw(characterId)}
                  >
                    Offer draw
                  </button>
                  {confirmResign ? (
                    <span className={styles.resignConfirm}>
                      <span className={styles.resignLabel}>Resign?</span>
                      <Button
                        kind="danger"
                        size="sm"
                        onClick={() => {
                          setConfirmResign(false);
                          void resign(characterId);
                        }}
                      >
                        Yes
                      </Button>
                      <Button kind="quiet" size="sm" onClick={() => setConfirmResign(false)}>
                        No
                      </Button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.ctrlBtn} ${styles.ctrlDanger}`}
                      onClick={() => setConfirmResign(true)}
                    >
                      Resign
                    </button>
                  )}
                </>
              ) : null}
              {game.status === 'ended' ? (
                <>
                  <Button kind="accent" size="sm" onClick={() => void rematch(characterId)}>
                    Rematch
                  </Button>
                  <Button kind="quiet" size="sm" onClick={() => void end(characterId)}>
                    Close
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ── Minecraft-session conflict confirm ── */}
      {mcConflict ? (
        <ModalShell
          title={`${name} is in Minecraft`}
          onClose={() => setMcConflict(false)}
          scrimClose
          tier="stacked"
        >
          <p className={styles.modalBody}>
            {name} is playing in a Minecraft world right now. Disconnect them from the world to
            start a chess game?
          </p>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={() => setMcConflict(false)}>
              Cancel
            </Button>
            <Button kind="primary" size="md" onClick={() => void onConfirmDisconnect()}>
              Disconnect and play
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </div>
  );
}

/** Half-move index pairs for the numbered move list. */
function pairs(len: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < len; i += 2) out.push([i, i + 1]);
  return out;
}

function MoveCell({
  san,
  active,
  onClick,
}: {
  san: string | undefined;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  if (!san) return <span className={styles.moveCellEmpty} />;
  return (
    <button
      type="button"
      className={active ? `${styles.moveCell} ${styles.moveCellActive}` : styles.moveCell}
      onClick={onClick}
    >
      {san}
    </button>
  );
}

function CapturedRow({
  pieces,
  diff,
  label,
}: {
  pieces: string[];
  diff: string | null;
  label: string;
}): React.ReactElement {
  return (
    <div className={styles.capturedRow} aria-label={label}>
      {pieces.map((code, i) => (
        <span key={`${code}-${i}`} className={styles.capturedPiece}>
          <Piece code={code} />
        </span>
      ))}
      {diff ? <span className={styles.capturedDiff}>{diff}</span> : null}
    </div>
  );
}

function ResultBanner({
  result,
  game,
  name,
}: {
  result: ChessResult;
  game: ChessGameState;
  name: string;
}): React.ReactElement {
  const { title, detail } = resultCopy(result, game, name);
  const playerWon = result.winner !== null && result.winner === game.playerColor;
  return (
    <div
      className={[
        styles.result,
        result.winner === null ? styles.resultDraw : playerWon ? styles.resultWin : styles.resultLoss,
      ].join(' ')}
    >
      <div className={styles.resultTitle}>{title}</div>
      <div className={styles.resultDetail}>{detail}</div>
    </div>
  );
}
