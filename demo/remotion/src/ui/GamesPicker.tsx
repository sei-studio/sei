import React from 'react';
import { staticFile } from 'remotion';
import { T } from '../theme';
import { PlusIcon } from './icons';

/** The games catalog, in picker order (src/shared/games.ts + lib/games.ts). */
export interface Tile {
  id: string;
  name: string;
  image?: string;
  soon?: boolean;
}

export const TILES: Tile[] = [
  { id: 'minecraft', name: 'Minecraft', image: 'img/game-minecraft.webp' },
  { id: 'chess', name: 'Chess', image: 'img/chess-launch.png' },
  { id: 'draw', name: 'Draw!', image: 'img/game-draw.png' },
  { id: 'stardew', name: 'Stardew Valley', image: 'img/game-stardew.jpg', soon: true },
  { id: 'dontstarve', name: "Don't Starve Together", image: 'img/game-dontstarve.jpg', soon: true },
  { id: 'focus', name: 'Focus', image: 'img/game-focus.jpg', soon: true },
  { id: 'suggest', name: 'Suggest a game' },
];

export const MODAL_W = 560;

/**
 * "Play together" picker: rgba(0,0,0,.62) scrim, 560px sharp surface modal,
 * Oswald 22px title, 2-col grid of 128px-tall cover tiles with a bottom
 * scrim and bottom-left Oswald labels; SOON tags; "Suggest a game" tile.
 *
 * `appear` 0..1 drives the fade-up; `tileIn` gives each tile a staggered
 * entrance (index -> 0..1).
 */
export const GamesPicker: React.FC<{
  appear: number;
  tileIn: (i: number) => number;
}> = ({ appear, tileIn }) => {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `rgba(0,0,0,${0.62 * appear})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: MODAL_W,
          background: T.surface,
          boxShadow: '0 18px 40px -8px rgba(0,0,0,.70)',
          opacity: appear,
          transform: `translateY(${(1 - appear) * 16}px)`,
        }}
      >
        <div style={{ padding: '24px 24px 8px' }}>
          <h2
            style={{
              fontFamily: T.display,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '0.02em',
              color: T.text,
              margin: 0,
            }}
          >
            Play together
          </h2>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            padding: '12px 24px 24px',
          }}
        >
          {TILES.map((t, i) => {
            const p = tileIn(i);
            return (
              <div
                key={t.id}
                style={{
                  position: 'relative',
                  minHeight: 128,
                  overflow: 'hidden',
                  background: t.image ? undefined : T.surface2,
                  opacity: p * (t.soon ? 0.82 : 1),
                  transform: `translateY(${(1 - p) * 12}px) scale(${0.96 + 0.04 * p})`,
                  display: 'flex',
                }}
              >
                {t.image ? (
                  <>
                    <img
                      src={staticFile(t.image)}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background:
                          'linear-gradient(180deg, rgba(8,8,10,0.2) 0%, transparent 38%, rgba(6,6,8,0.88) 100%)',
                      }}
                    />
                    <div
                      style={{
                        position: 'relative',
                        alignSelf: 'flex-end',
                        padding: 12,
                        fontFamily: T.display,
                        fontSize: 18,
                        fontWeight: 600,
                        letterSpacing: '0.01em',
                        color: '#fff',
                        textShadow: '0 1px 4px rgba(0,0,0,.6)',
                      }}
                    >
                      {t.name}
                    </div>
                    {t.soon && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: 12,
                          right: 10,
                          fontFamily: T.display,
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: '0.08em',
                          color: '#fff',
                          textShadow: '0 1px 4px rgba(0,0,0,.6)',
                        }}
                      >
                        SOON
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      color: T.text,
                    }}
                  >
                    <div style={{ color: T.accent }}>
                      <PlusIcon size={30} />
                    </div>
                    <span style={{ fontFamily: T.display, fontSize: 16, fontWeight: 600 }}>
                      {t.name}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
