/**
 * CallBackdrop — the character-art call backdrop.
 *
 * This is what backdrop mode falls back to for everyone who has no custom
 * scene, and what group calls always get (a scene stages ONE actor, so there
 * is nothing sensible to do with three). Solo: the character's art fills the
 * window. Group: one equal column per participant, split down the middle.
 *
 * The art is painted `cover` and can be dragged VERTICALLY to change what you
 * are looking at — a portrait cropped to a landscape window loses most of
 * itself, and which part it loses should be the player's choice, not the
 * layout's. Horizontal drag is deliberately absent: cover on a wide pane is
 * width-driven, so there is no horizontal slack to move through. See
 * `lib/callBackdrop.ts` for why one rule covers both pane shapes.
 *
 * Characters with no uploaded art fall back to their procedural portrait,
 * blown up and left pixelated — the same identity the tiles show, just used
 * as wallpaper.
 */

import React, { useRef, useState } from 'react';
import type { Character } from '@shared/characterSchema';
import { portraitSrc } from '../../lib/portraitSrc';
import { pickPalette } from '../../lib/portraitPalettes';
import { PixelPortrait } from '../PixelPortrait';
import { clampPosition, coverOverflowPx, dragToPositionDelta } from '../../lib/callBackdrop';
import styles from './CallBackdrop.module.css';

export interface CallBackdropProps {
  /** Panes, left to right. One character = full bleed. */
  characters: Character[];
  theme: 'light' | 'dark';
  /** Lights the speaker's pane in a split; ignored when there is only one. */
  speakingId: string | null;
}

function BackdropPane({
  character,
  theme,
  dim,
}: {
  character: Character;
  theme: 'light' | 'dark';
  dim: boolean;
}): React.ReactElement {
  const src = portraitSrc(character.portrait_image);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const naturalRef = useRef({ w: 0, h: 0 });
  const dragRef = useRef<{ y: number; pos: number } | null>(null);
  // 50% = centred. The one number the drag moves, and what CSS interpolates
  // across whatever vertical overflow the art actually has.
  const [pos, setPos] = useState(50);
  const [overflow, setOverflow] = useState(0);

  const measure = (): number => {
    const pane = paneRef.current?.getBoundingClientRect();
    if (!pane) return 0;
    return coverOverflowPx(naturalRef.current, { w: pane.width, h: pane.height });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const of = measure();
    setOverflow(of);
    if (of <= 0) return; // nothing to pan to; leave the pointer alone
    dragRef.current = { y: e.clientY, pos };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    setPos(clampPosition(d.pos + dragToPositionDelta(e.clientY - d.y, measure())));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const pal = pickPalette(character.id + character.name, theme);

  return (
    <div
      ref={paneRef}
      className={`${styles.pane} ${dim ? styles.paneDim : ''} ${
        overflow > 0 ? styles.paneDraggable : ''
      }`}
      style={
        src
          ? { backgroundImage: `url("${src}")`, backgroundPosition: `50% ${pos}%` }
          : { background: pal[0] }
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {src ? (
        // Off-screen probe purely for naturalWidth/Height — the drag needs the
        // art's real size to track the cursor 1:1, and a CSS background has no
        // way to report it.
        <img
          className={styles.probe}
          src={src}
          alt=""
          onLoad={(e) => {
            naturalRef.current = {
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            };
            setOverflow(measure());
          }}
        />
      ) : (
        <PixelPortrait
          seed={character.id + character.name}
          palette={pal}
          size={512}
          portraitImage={null}
          className={styles.fallbackSprite}
          style={{ width: '100%', height: '100%' }}
        />
      )}
    </div>
  );
}

export function CallBackdrop({
  characters,
  theme,
  speakingId,
}: CallBackdropProps): React.ReactElement {
  const isSplit = characters.length > 1;
  return (
    <div className={styles.root} aria-hidden="true">
      {characters.map((c) => (
        <BackdropPane
          key={c.id}
          character={c}
          theme={theme}
          // With the portraits gone, dimming the non-speaker is the only thing
          // left saying who is talking.
          dim={isSplit && speakingId !== null && speakingId !== c.id}
        />
      ))}
    </div>
  );
}
