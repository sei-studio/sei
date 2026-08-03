/**
 * GamesPickerModal — "Play together" tiled game grid (Phase 18/19).
 *
 * Opened from the chat header's Games button, the CharacterCard "Play" CTA, and
 * the CharacterPage "Play together" deploy button. Clicking an available game
 * tile opens that game's surface: chess slides its panel into the chat aside;
 * Minecraft opens its launch panel there too (the launch panel owns the summon
 * flow). Each available tile carries a bottom-right (i) affordance that shows a
 * hover-only info popup (title, art, brief description; nothing clickable).
 * Coming-soon tiles are dimmed placeholders; the "Suggest a game" tile opens
 * the feedback form (same submit path as the Playtime screen's form).
 * Scrim-click / ESC closes (ESC hides the popup first when one is showing).
 *
 * Source: .planning/design/app-chat-and-memory.md §5 (GamesPickerModal) + R7.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { attemptSummon } from '../lib/summonFlow';
import { openGame, requestGameLaunch, type LaunchGameId } from '../lib/gameLaunch';
import { GAMES, type GameDef } from '../lib/games';
import { MCBlock, GamepadIcon, InfoIcon, PlusIcon } from './icons';
import { FeedbackModal } from './FeedbackModal';
import styles from './GamesPickerModal.module.css';

export interface GamesPickerModalProps {
  characterId: string;
}

/** Hover popup metrics — width fixed for placement math; height is estimated
 * generously for the vertical clamp (the card is shorter in practice). */
const POPUP_W = 250;
const POPUP_EST_H = 260;
const POPUP_GAP = 10;
const POPUP_DELAY_MS = 250;

interface InfoPopup {
  game: GameDef;
  x: number;
  y: number;
}

export function GamesPickerModal({ characterId }: GamesPickerModalProps): React.ReactElement {
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const companionName = character?.name ?? 'your companion';

  // ── Hover-only info popup ─────────────────────────────────────────────
  const [popup, setPopup] = useState<InfoPopup | null>(null);
  const popupRef = useRef<InfoPopup | null>(null);
  popupRef.current = popup;
  const showTimer = useRef<number | null>(null);

  // "Suggest a game" (260725): the feedback form rides on top of the picker;
  // its submit path is the same proxy feedback table as the Playtime form.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestOpenRef = useRef(false);
  suggestOpenRef.current = suggestOpen;

  const cancelShow = (): void => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };

  const hideInfo = (): void => {
    cancelShow();
    setPopup(null);
  };

  /** Schedule the popup after a short hover delay, anchored to the tile.
   * Renders as a sibling of the modal panel (position: fixed) so the modal's
   * overflow never clips it; placement prefers the tile's right side and flips
   * left when that would leave the viewport. */
  const scheduleInfo = (g: GameDef, affordance: HTMLElement): void => {
    const tile = affordance.parentElement ?? affordance;
    const rect = tile.getBoundingClientRect();
    cancelShow();
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      let x = rect.right + POPUP_GAP;
      if (x + POPUP_W > window.innerWidth - 12) x = rect.left - POPUP_W - POPUP_GAP;
      const y = Math.max(12, Math.min(rect.top, window.innerHeight - POPUP_EST_H));
      setPopup({ game: g, x, y });
    }, POPUP_DELAY_MS);
  };

  useEffect(() => cancelShow, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // The open feedback form owns ESC (ModalShell closes itself).
      if (suggestOpenRef.current) return;
      // ESC dismisses the info popup first; a second ESC closes the picker.
      if (popupRef.current) {
        setPopup(null);
        return;
      }
      closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeModal]);

  const onPlay = (g: GameDef): void => {
    if (!g.available) return;
    if (g.id === 'suggest') {
      hideInfo();
      setSuggestOpen(true);
      return;
    }
    // 260721: every tile routes through the SHARED launch gate
    // (lib/gameLaunch). With another game active for this companion it shows
    // the cross-launch confirm first; otherwise openGame mounts the picked
    // surface in the chat's game area (chess card / Minecraft launch panel,
    // or the live dashboard when the bot is already online).
    if (g.id === 'chess' || g.id === 'minecraft' || g.id === 'draw') {
      const id = g.id as LaunchGameId;
      closeModal();
      requestGameLaunch(characterId, { id, name: g.name }, () => openGame(characterId, id));
      return;
    }
    // Fallback for any future summon-launched game.
    void attemptSummon(characterId);
    closeModal();
  };

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby="games-picker-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div className={styles.modal} data-tutorial="games-modal">
        <div className={styles.header}>
          <h2 id="games-picker-title" className={styles.title}>
            Play together
          </h2>
        </div>
        <div className={styles.grid}>
          {GAMES.map((g) => (
            <div
              key={g.id}
              className={`${styles.tile} ${g.available ? '' : styles.tileLocked} ${
                g.image ? styles.tileImage : ''
              }`}
              style={g.image ? { backgroundImage: `url(${g.image})` } : undefined}
              onMouseLeave={hideInfo}
            >
              <button
                type="button"
                className={styles.tileMain}
                disabled={!g.available}
                aria-disabled={!g.available}
                onClick={() => onPlay(g)}
              >
                {g.image ? null : (
                  <span className={styles.tileIcon}>
                    {g.id === 'minecraft' ? (
                      <MCBlock size={40} />
                    ) : g.id === 'suggest' ? (
                      <PlusIcon size={30} />
                    ) : (
                      <GamepadIcon size={30} />
                    )}
                  </span>
                )}
                <span className={styles.tileName}>{g.name}</span>
              </button>
              {g.soon ? <span className={styles.soonTag}>SOON</span> : null}
              {g.available ? (
                <span
                  className={styles.infoHint}
                  tabIndex={0}
                  aria-label={`About ${g.name}`}
                  onMouseEnter={(e) => scheduleInfo(g, e.currentTarget)}
                  onMouseLeave={hideInfo}
                  onFocus={(e) => scheduleInfo(g, e.currentTarget)}
                  onBlur={hideInfo}
                >
                  <InfoIcon size={16} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {popup ? (
        <div
          className={styles.infoPop}
          style={{ left: popup.x, top: popup.y, width: POPUP_W }}
          aria-hidden="true"
        >
          {popup.game.image ? (
            <div
              className={styles.infoPopArt}
              style={{ backgroundImage: `url(${popup.game.image})` }}
            />
          ) : null}
          <div className={styles.infoPopBody}>
            <span className={styles.infoPopTitle}>{popup.game.name}</span>
            <p className={styles.infoPopText}>{popup.game.description(companionName)}</p>
          </div>
        </div>
      ) : null}
      {suggestOpen ? (
        <FeedbackModal
          title="Suggest a game"
          framing=""
          fieldLabel="Game"
          placeholder="What game should we add?"
          onClose={() => setSuggestOpen(false)}
        />
      ) : null}
    </div>
  );
}
