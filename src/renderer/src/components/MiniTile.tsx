/**
 * MiniTile — the bottom-right picture-in-picture tile (260730).
 *
 * When a game surface (chess or Draw!) or a voice call is live but its screen
 * is not the one on view, a small rectangular tile floats in the bottom-right
 * corner so the session stays visible and one click away:
 *
 *   game — the live game shrunk small (the 2D chess board / a repaint of the
 *          draw canvas), with a "<" button in the top-left that re-opens the
 *          hosting screen. The game area's split-size pref restores its
 *          previous size, so "<" is a true re-expand, not a fresh open.
 *   call — the AI participants' portraits (never the player's own) on the
 *          same tinted background as the chat profile panel (dominant portrait
 *          color washed over --bg2); click returns to the fullscreen call view.
 *
 * A live game tile REPLACES the call tile when both are away: the call
 * already shows its cluster inside the game surface's own chrome row, so the
 * game view is the richer thing to come back through.
 *
 * In chat with the profile panel open, the tile shifts left by the panel's
 * width so it overlays the chat column but never the panel. Every tile
 * darkens toward its edges (inset vignette) so it reads as a window into the
 * other surface rather than a piece of the current one.
 *
 * Minecraft sessions deliberately get NO tile: their "game window" is the
 * player's own Minecraft outside the app; the icon-rail badge stays the
 * ambient indicator there. Chess replays get none either (nothing is live).
 */

import React, { useEffect, useRef } from 'react';
import { CANVAS_W } from '@shared/drawIpc';
import { useUiStore, type View } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChessStore, isChessOpen, isChessReplayOpen } from '../lib/stores/useChessStore';
import { useDrawStore } from '../lib/stores/useDrawStore';
import { useMcDashboardStore } from '../lib/stores/useMcDashboardStore';
import { ChessBoard } from './chess/ChessBoard';
import { paintStrokes } from './draw/drawRender';
import { PixelPortrait } from './PixelPortrait';
import { BackIcon } from './icons';
import { pickPalette } from '../lib/portraitPalettes';
import { portraitSrc } from '../lib/portraitSrc';
import { useDominantColor } from '../lib/useDominantColor';
import { useT } from '../lib/i18n';
import styles from './MiniTile.module.css';

/** Width of the open profile panel (.presOpen .presPanel, ChatScreen.module.css). */
const PANEL_W = 260;
/** Margin from the window edge, and from the panel edge when pushed left. */
const EDGE_PX = 14;

/**
 * Views the tile may float over. The ritual/onboarding surfaces (loading,
 * onboard, skin-setup, profile questions, unique-* reveal flow, receipt) are
 * deliberately excluded: nothing should overlay them.
 */
const TILE_VIEWS = new Set<View['kind']>([
  'home',
  'awaken',
  'add-character',
  'character',
  'chat',
  'voice-call',
  'draw',
  'settings',
  'credits',
  'coming-soon',
]);

type AwayGame = { characterId: string; game: 'chess' | 'draw' };

/** Live draw game worth a tile: a real game in play, not setup or the gallery. */
function isDrawLive(phase: string | undefined): boolean {
  return phase === 'pick' || phase === 'drawing' || phase === 'turn-end';
}

export function MiniTile(): React.ReactElement | null {
  const view = useUiStore((s) => s.view);
  const chatPanelHidden = useUiStore((s) => s.chatPanelHidden);
  const participants = useVoiceStore((s) => s.participants);
  const callStatus = useVoiceStore((s) => s.status);
  const characters = useDataStore((s) => s.characters);
  const summons = useDataStore((s) => s.summons);
  const chessState = useChessStore((s) => s);
  const drawGames = useDrawStore((s) => s.games);
  const mcLaunch = useMcDashboardStore((s) => s.launch);

  if (!TILE_VIEWS.has(view.kind)) return null;

  // The first roster character with a live game surface whose hosting screen
  // is not on view. Chess (and the MC dashboard) live in the chat screen; the
  // Draw! game is its own route. A real game object is required (not just
  // isChessOpen's panel intent): without one the board renders null and the
  // tile would collapse to an empty sliver.
  let away: AwayGame | null = null;
  for (const c of characters) {
    if (chessState.games[c.id]) {
      if (!(view.kind === 'chat' && view.characterId === c.id)) {
        away = { characterId: c.id, game: 'chess' };
        break;
      }
    } else if (isDrawLive(drawGames[c.id]?.phase)) {
      if (!(view.kind === 'draw' && view.characterId === c.id)) {
        away = { characterId: c.id, game: 'draw' };
        break;
      }
    }
  }

  const callExists =
    participants.length > 0 && (callStatus === 'live' || callStatus === 'connecting');
  const showCall = !away && callExists && view.kind !== 'voice-call';

  if (!away && !showCall) return null;

  // In chat with the profile panel showing, sit left of the panel instead of
  // on top of it. The panel force-collapses to 0 while the viewed chat hosts
  // its own game surface, so no push is needed there.
  const viewedId = view.kind === 'chat' ? view.characterId : null;
  const viewedHostsGame =
    viewedId !== null &&
    (isChessOpen(chessState, viewedId) ||
      isChessReplayOpen(chessState, viewedId) ||
      summons[viewedId]?.kind === 'online' ||
      mcLaunch[viewedId] === true);
  const pushed = viewedId !== null && !chatPanelHidden && !viewedHostsGame;
  const right = pushed ? PANEL_W + EDGE_PX : EDGE_PX;

  return away ? (
    <GameTile characterId={away.characterId} game={away.game} right={right} />
  ) : (
    <CallTile right={right} />
  );
}

function GameTile({
  characterId,
  game,
  right,
}: AwayGame & { right: number }): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const open = (): void => {
    navigate(game === 'draw' ? { kind: 'draw', characterId } : { kind: 'chat', characterId });
  };

  return (
    <div
      className={styles.tile}
      style={{ right }}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      aria-label={t('Back to game')}
      title={t('Back to game')}
    >
      <div className={game === 'chess' ? styles.chessBox : styles.drawBox}>
        {game === 'chess' ? <ChessBoard characterId={characterId} /> : <DrawMini characterId={characterId} />}
      </div>
      <div className={styles.vignette} aria-hidden="true" />
      <button
        type="button"
        className={styles.backBtn}
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        aria-label={t('Back to game')}
        title={t('Back to game')}
      >
        <BackIcon size={12} />
      </button>
    </div>
  );
}

/**
 * Static repaint of the draw canvas from the last pushed state. During the
 * character's drawing turn `strokes` may run ahead of the hand-speed playback
 * the full screen shows; for a glanceable thumbnail, current-and-complete
 * beats faithfully-paced.
 */
function DrawMini({ characterId }: { characterId: string }): React.ReactElement {
  const state = useDrawStore((s) => s.games[characterId]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintStrokes(ctx, state?.strokes ?? [], {
      background: '#ffffff',
      scale: (w * dpr) / CANVAS_W,
    });
  }, [state]);

  return <canvas ref={canvasRef} className={styles.drawCanvas} />;
}

function CallTile({ right }: { right: number }): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const participants = useVoiceStore((s) => s.participants);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const characters = useDataStore((s) => s.characters);
  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  // Same wash as the chat profile panel: the primary participant's dominant
  // portrait color at 20% over --bg2 (ChatScreen §4.5).
  const primary = characters.find((c) => c.id === participants[0]);
  const tint = useDominantColor(
    portraitSrc(primary?.portrait_image ?? null),
    primary?.cloud_updated_at ?? null,
  );
  const background = tint ? `color-mix(in srgb, ${tint} 20%, var(--bg2))` : 'var(--bg2)';

  const open = (): void => {
    if (participants[0]) navigate({ kind: 'voice-call', characterId: participants[0] });
  };

  return (
    <div
      className={styles.tile}
      style={{ right, background }}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      aria-label={t('Return to call')}
      title={t('Return to call')}
    >
      <div className={styles.callRow}>
        {participants.map((id) => {
          const c = characters.find((x) => x.id === id);
          if (!c) return null;
          const pal = pickPalette(c.id + c.name, theme);
          return (
            <span
              key={id}
              className={
                speakingId === id ? `${styles.portrait} ${styles.speaking}` : styles.portrait
              }
            >
              <PixelPortrait
                seed={c.id + c.name}
                palette={pal}
                size={44}
                portraitImage={c.portrait_image}
                style={{ width: '100%', height: '100%' }}
              />
            </span>
          );
        })}
      </div>
      <div className={styles.vignette} aria-hidden="true" />
    </div>
  );
}
