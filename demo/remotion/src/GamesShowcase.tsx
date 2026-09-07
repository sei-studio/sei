import React from 'react';
import { Easing, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { Camera, CamKey } from './camera';
import { Cursor, CursorKey } from './Cursor';
import { T } from './theme';
import { AppWindow } from './ui/AppWindow';
import { ChatScreen } from './ui/ChatScreen';
import { GamesPicker, TILES } from './ui/GamesPicker';
import { DESKTOP_BG, WK, WOX, WOY, wp } from './UiDemo';

const pop = Easing.bezier(0.2, 0.7, 0.2, 1);

// ── Timeline ─────────────────────────────────────────────────────────────
const CLICK_GAMEPAD = 28;
const MODAL_IN = 32;
const TAKEOVER = 70; // full-frame tile showcase begins
const PER_TILE = 30;
const SOON_IN = TAKEOVER + PER_TILE * 3; // 160
const FADE_OUT = SOON_IN + 22; // 182
export const SHOWCASE_LEN = 196;

const LIVE = TILES.filter((t) => !t.soon && t.image); // minecraft, chess, draw
const SOON = TILES.filter((t) => t.soon);

/** Full-frame one-by-one tile takeover with slam-in titles. */
const Takeover: React.FC<{ frame: number }> = ({ frame }) => {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {LIVE.map((t, i) => {
        const start = TAKEOVER + i * PER_TILE;
        const end = start + PER_TILE;
        // Keep the outgoing slide mounted under the incoming one.
        if (frame < start || frame > end + 10) return null;
        const inT = interpolate(frame, [start, start + 9], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: pop,
        });
        const local = frame - start;
        const drift = 1.06 + 0.002 * local; // slow push-in
        const titleT = interpolate(frame, [start + 4, start + 13], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: pop,
        });
        return (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              inset: 0,
              transform: `translateX(${(1 - inT) * 100}%)`,
              zIndex: i + 1,
              overflow: 'hidden',
              background: '#000',
            }}
          >
            <img
              src={staticFile(t.image!)}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: `scale(${drift})`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background:
                  'linear-gradient(180deg, rgba(4,7,15,0.15) 0%, transparent 40%, rgba(4,7,15,0.82) 100%)',
              }}
            />
            <div style={{ position: 'absolute', left: 110, bottom: 96, overflow: 'hidden' }}>
              <div
                style={{
                  fontFamily: T.display,
                  fontWeight: 600,
                  fontSize: 118,
                  lineHeight: 1,
                  letterSpacing: '0.01em',
                  color: '#fff',
                  textShadow: '0 2px 18px rgba(0,0,0,.55)',
                  transform: `translateY(${(1 - titleT) * 110}%)`,
                }}
              >
                {t.name}
              </div>
            </div>
            <div
              style={{
                position: 'absolute',
                left: 112,
                bottom: 74,
                height: 6,
                width: 320 * titleT,
                background: T.accent,
              }}
            />
          </div>
        );
      })}

      {/* Coming-soon triptych */}
      {frame >= SOON_IN && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', zIndex: 10, background: '#04070f' }}>
          {SOON.map((t, i) => {
            const inT = interpolate(frame, [SOON_IN + i * 3, SOON_IN + i * 3 + 8], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: pop,
            });
            return (
              <div
                key={t.id}
                style={{
                  flex: 1,
                  position: 'relative',
                  overflow: 'hidden',
                  borderRight: i < 2 ? '2px solid #04070f' : undefined,
                  transform: `translateY(${(1 - inT) * 100}%)`,
                }}
              >
                <img
                  src={staticFile(t.image!)}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    filter: 'saturate(.8) brightness(.8)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(180deg, transparent 45%, rgba(4,7,15,0.85) 100%)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: 36,
                    bottom: 92,
                    fontFamily: T.display,
                    fontWeight: 600,
                    fontSize: 44,
                    color: '#fff',
                    textShadow: '0 2px 12px rgba(0,0,0,.6)',
                  }}
                >
                  {t.name}
                </div>
                <div
                  style={{
                    position: 'absolute',
                    left: 38,
                    bottom: 60,
                    fontFamily: T.display,
                    fontWeight: 600,
                    fontSize: 16,
                    letterSpacing: '0.14em',
                    color: T.accent,
                  }}
                >
                  SOON
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const GamesShowcase: React.FC = () => {
  const frame = useCurrentFrame();

  const appear = interpolate(frame, [MODAL_IN, MODAL_IN + 9], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: pop,
  });
  const tileIn = (i: number): number =>
    interpolate(frame, [MODAL_IN + 4 + i * 3, MODAL_IN + 12 + i * 3], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: pop,
    });

  const keys: CamKey[] = [
    { f: 0, ...wp(620, 400), s: 1.25 },
    { f: 8, ...wp(620, 400), s: 1.25 },
    { f: 26, ...wp(1030, 130), s: 2.2 },
    { f: MODAL_IN + 14, ...wp(627, 397), s: 1.24 },
    { f: TAKEOVER - 8, ...wp(627, 397), s: 1.3 },
    { f: TAKEOVER + 2, ...wp(627, 397), s: 1.3 },
  ];

  const cw = (x: number, y: number, f: number): CursorKey => ({ f, ...wp(x, y) });
  const cursorKeys: CursorKey[] = [
    cw(800, 500, 0),
    cw(800, 500, 8),
    cw(1075, 59, CLICK_GAMEPAD - 2),
    cw(1075, 59, CLICK_GAMEPAD + 8),
    cw(480, 300, MODAL_IN + 20), // over the Minecraft tile
    cw(480, 300, TAKEOVER),
  ];

  const fadeOut = interpolate(frame, [FADE_OUT, FADE_OUT + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ position: 'absolute', inset: 0, background: DESKTOP_BG }}>
      {frame < TAKEOVER + 10 && (
        <Camera keys={keys} frame={frame}>
          <div
            style={{
              position: 'absolute',
              left: WOX,
              top: WOY,
              width: 1180 * WK,
              height: 760 * WK,
            }}
          >
            <div style={{ transform: `scale(${WK})`, transformOrigin: '0 0' }}>
              <AppWindow active="sui">
                <ChatScreen
                  draft=""
                  caretOn={false}
                  sent
                  sentPop={1}
                  typing={false}
                  reply
                  replyPop={1}
                />
                <GamesPicker appear={appear} tileIn={tileIn} />
              </AppWindow>
            </div>
          </div>
          <Cursor keys={cursorKeys} frame={frame} clicks={[CLICK_GAMEPAD]} />
        </Camera>
      )}
      {frame >= TAKEOVER && <Takeover frame={frame} />}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: '#000',
          opacity: fadeOut,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};
