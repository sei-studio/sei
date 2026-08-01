/**
 * MiniTile — the bottom-right return tile (260730).
 *
 * When a game surface (chess or Draw!) or a voice call is live but its screen
 * is not the one on view, a small fixed-size tile floats in the bottom-right
 * corner so the session stays one click away. Discord-activity style: it is a
 * static card, not a live preview.
 *
 *   game — the game's own picker art (lib/games.ts tile image).
 *   call — the AI participants' portraits (never the player's own).
 *
 * The ONLY interactive element is the labeled back button in the top-left
 * ("‹ Chess", "‹ Call"); the rest of the tile is inert. A live game tile
 * replaces the call tile when both are away: the call already shows its
 * cluster inside the game surface's own chrome row.
 *
 * In chat with the profile panel open, the tile shifts left by the panel's
 * width so it overlays the chat column but never the panel. In chat it also
 * measures the floating composer dock ([data-chat-composer]) and floats just
 * above it, so it never covers the message box (260730).
 *
 * Suppressed entirely while a game surface is in in-app fullscreen: the game
 * owns every pixel there and its chrome row already carries the call cluster.
 * Likewise the CALL tile never shows on a screen whose live game surface is on
 * view (chess/MC dashboard in the viewed chat, the live Draw! route): those
 * surfaces show the call cluster in their own chrome row, and the tile was
 * landing on top of their chat column (260730).
 *
 * Minecraft sessions deliberately get NO tile: their "game window" is the
 * player's own Minecraft outside the app; the icon-rail badge stays the
 * ambient indicator there. Chess replays get none either (nothing is live).
 */

import React from 'react';
import { useUiStore, type View } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChessStore, isChessOpen, isChessReplayOpen } from '../lib/stores/useChessStore';
import { useDrawStore } from '../lib/stores/useDrawStore';
import { useMcDashboardStore } from '../lib/stores/useMcDashboardStore';
import { GAMES } from '../lib/games';
import { PixelPortrait } from './PixelPortrait';
import { BackIcon } from './icons';
import { pickPalette } from '../lib/portraitPalettes';
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

/**
 * Bottom offset that clears the chat composer. When the chat screen is on
 * view its floating composer dock spans the column bottom, exactly where the
 * tile sits; measure it ([data-chat-composer]) and float the tile just above.
 * ResizeObserver tracks the dock growing (multiline draft, reply bar, typing
 * line) so the tile rides up with it. `key` is the viewed chat's characterId,
 * null when no composer is on screen.
 */
function useComposerClearance(key: string | null): number {
  const [bottom, setBottom] = React.useState(EDGE_PX);
  React.useLayoutEffect(() => {
    if (key === null) {
      setBottom(EDGE_PX);
      return;
    }
    const el = document.querySelector('[data-chat-composer]');
    if (!(el instanceof HTMLElement)) {
      setBottom(EDGE_PX);
      return;
    }
    const update = (): void => {
      const top = el.getBoundingClientRect().top;
      setBottom(Math.max(EDGE_PX, window.innerHeight - top + 10));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [key]);
  return bottom;
}

export function MiniTile(): React.ReactElement | null {
  const view = useUiStore((s) => s.view);
  const chatPanelHidden = useUiStore((s) => s.chatPanelHidden);
  const gameFullscreen = useUiStore((s) => s.gameFullscreen);
  const participants = useVoiceStore((s) => s.participants);
  const callStatus = useVoiceStore((s) => s.status);
  const characters = useDataStore((s) => s.characters);
  const summons = useDataStore((s) => s.summons);
  const chessState = useChessStore((s) => s);
  const drawGames = useDrawStore((s) => s.games);
  const mcLaunch = useMcDashboardStore((s) => s.launch);
  const bottom = useComposerClearance(
    view.kind === 'chat' && !gameFullscreen ? view.characterId : null,
  );

  if (!TILE_VIEWS.has(view.kind)) return null;
  // In-app fullscreen: the game surface owns every pixel (rail, chat and top
  // bar are gone) and its chrome row already carries the call cluster.
  if (gameFullscreen) return null;

  // The first roster character with a live game surface whose hosting screen
  // is not on view. Chess (and the MC dashboard) live in the chat screen; the
  // Draw! game is its own route.
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

  const viewedId = view.kind === 'chat' ? view.characterId : null;
  const viewedHostsGame =
    viewedId !== null &&
    (isChessOpen(chessState, viewedId) ||
      isChessReplayOpen(chessState, viewedId) ||
      summons[viewedId]?.kind === 'online' ||
      mcLaunch[viewedId] === true);
  // A game surface on view already shows the call cluster in its own chrome
  // row (GameSurface in chat, GameChromeRow on the Draw! route), so the call
  // tile would only duplicate it on top of the game's chat column.
  const onViewGameSurface =
    viewedHostsGame ||
    (view.kind === 'draw' && isDrawLive(drawGames[view.characterId]?.phase));

  const callExists =
    participants.length > 0 && (callStatus === 'live' || callStatus === 'connecting');
  const showCall = !away && callExists && view.kind !== 'voice-call' && !onViewGameSurface;

  if (!away && !showCall) return null;

  // In chat with the profile panel showing, sit left of the panel instead of
  // on top of it. The panel force-collapses to 0 while the viewed chat hosts
  // its own game surface, so no push is needed there.
  const pushed = viewedId !== null && !chatPanelHidden && !viewedHostsGame;
  const right = pushed ? PANEL_W + EDGE_PX : EDGE_PX;

  return away ? (
    <GameTile characterId={away.characterId} game={away.game} right={right} bottom={bottom} />
  ) : (
    <CallTile right={right} bottom={bottom} />
  );
}

function BackChip({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <button type="button" className={styles.backBtn} onClick={onClick}>
      <BackIcon size={12} />
      <span>{label}</span>
    </button>
  );
}

function GameTile({
  characterId,
  game,
  right,
  bottom,
}: AwayGame & { right: number; bottom: number }): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const def = GAMES.find((g) => g.id === game);
  const open = (): void => {
    navigate(game === 'draw' ? { kind: 'draw', characterId } : { kind: 'chat', characterId });
  };

  return (
    <div className={styles.tile} style={{ right, bottom }}>
      {def?.image ? (
        <img src={def.image} alt="" aria-hidden="true" className={styles.art} />
      ) : null}
      <BackChip label={t(def?.name ?? 'Back to game')} onClick={open} />
    </div>
  );
}

function CallTile({ right, bottom }: { right: number; bottom: number }): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const participants = useVoiceStore((s) => s.participants);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const characters = useDataStore((s) => s.characters);
  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const open = (): void => {
    if (participants[0]) navigate({ kind: 'voice-call', characterId: participants[0] });
  };

  return (
    <div className={styles.tile} style={{ right, bottom }}>
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
      <BackChip label={t('Call')} onClick={open} />
    </div>
  );
}
