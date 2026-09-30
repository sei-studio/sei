import React from 'react';
import { staticFile } from 'remotion';
import { T } from '../theme';

/**
 * The Home party wall: a full-height flex row of 4 panels (Sui, Marv, Lyra,
 * one dormant "Awaken" slot). Hover choreography from HomeScreen.module.css:
 * hovered panel flex 1.65, the others 0.84; art desaturated at rest,
 * scale(1.045) + full color on hover; name Oswald 600 30px on a bottom scrim;
 * presence dot + label; hover reveals last line + Message/Play buttons.
 *
 * `hover` is the hover progress on the Sui panel (0..1); `flash` briefly
 * brightens it on click.
 */
const CONTENT_W = 1180 - 74;
const H = 760 - 34;

interface Panel {
  id: 'sui' | 'marv' | 'lyra' | 'dormant';
  name?: string;
  presence?: { label: string; color: string; textColor?: string };
}

const PANELS: Panel[] = [
  { id: 'sui', name: 'Sui', presence: { label: 'Online', color: T.green } },
  { id: 'marv', name: 'Marv', presence: { label: 'Idle', color: '#e0be5c' } },
  { id: 'lyra', name: 'Lyra', presence: { label: 'Idle', color: '#e0be5c' } },
  { id: 'dormant' },
];

// Star positions for the dormant slot's constellation (fractions of the panel).
const STARS: Array<[number, number, number]> = [
  [0.22, 0.18, 2.2], [0.55, 0.12, 1.6], [0.78, 0.26, 2.6], [0.38, 0.34, 1.8],
  [0.64, 0.44, 2.2], [0.25, 0.55, 1.5], [0.8, 0.62, 1.8], [0.5, 0.7, 2.4],
  [0.3, 0.82, 1.6], [0.68, 0.88, 2.0], [0.14, 0.4, 1.4], [0.9, 0.45, 1.3],
];

export const HomeScreen: React.FC<{ hover: number; flash?: number }> = ({ hover, flash = 0 }) => {
  // Widths: rest = equal quarters; hover = Sui 1.65, others 0.84.
  const total = 1.65 + 0.84 * 3;
  const suiW = (CONTENT_W / 4) * (1 - hover) + (CONTENT_W * 1.65) / total * hover;
  const otherW = (CONTENT_W - suiW) / 3;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
      {PANELS.map((p, i) => {
        const w = p.id === 'sui' ? suiW : otherW;
        const isSui = p.id === 'sui';
        const hp = isSui ? hover : 0;
        return (
          <div
            key={p.id}
            style={{
              width: w,
              height: H,
              position: 'relative',
              overflow: 'hidden',
              borderRight: i < 3 ? `1px solid ${T.border}` : undefined,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
            }}
          >
            {p.id === 'dormant' ? (
              <>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background:
                      'linear-gradient(180deg, rgba(8,15,29,0.5), rgba(4,7,15,0.9))',
                  }}
                />
                <svg
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                  preserveAspectRatio="none"
                >
                  {STARS.map(([x, y, r], k) => (
                    <circle
                      key={k}
                      cx={`${x * 100}%`}
                      cy={`${y * 100}%`}
                      r={r}
                      fill={`rgba(127,176,255,${0.17 - (k % 4) * 0.04})`}
                    />
                  ))}
                  <polyline
                    points={STARS.slice(0, 7)
                      .map(([x, y]) => `${x * w},${y * H}`)
                      .join(' ')}
                    fill="none"
                    stroke="rgba(127,176,255,0.045)"
                    strokeWidth={1}
                  />
                </svg>
                {/* Halo */}
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 320,
                    height: 320,
                    transform: 'translate(-50%, -50%)',
                    background:
                      'radial-gradient(50% 50% at 50% 50%, rgba(127,176,255,0.06), transparent 78%)',
                  }}
                />
              </>
            ) : (
              <>
                <img
                  src={staticFile(`img/portraits/${p.id}.png`)}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: '50% 18%',
                    imageRendering: 'auto',
                    transform: `scale(${1 + 0.045 * hp})`,
                    filter: `saturate(${0.72 + 0.28 * hp}) brightness(${
                      0.88 + 0.12 * hp + flash * 0.18
                    })`,
                  }}
                />
                {/* Scrim */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: `linear-gradient(180deg, rgba(4,7,15,0.22) 0%, transparent 28%, transparent calc(100% - 140px), rgba(4,7,15,0.76) 100%)`,
                  }}
                />
                <div
                  style={{
                    position: 'relative',
                    padding: '0 18px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      fontFamily: T.display,
                      fontWeight: 600,
                      fontSize: 30,
                      lineHeight: 1.05,
                      color: '#e9e7e1',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.name}
                  </div>
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      fontSize: 13,
                      color: 'rgba(233,231,225,0.86)',
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: p.presence!.color,
                        boxShadow:
                          p.presence!.label === 'Online' ? `0 0 8px ${T.green}` : undefined,
                      }}
                    />
                    {p.presence!.label}
                  </div>
                  {/* Hover reveal */}
                  {isSui && (
                    <div
                      style={{
                        overflow: 'hidden',
                        maxHeight: 70 * hp,
                        opacity: hp,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          fontStyle: 'italic',
                          color: 'rgba(233,231,225,0.8)',
                          paddingTop: 4,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        <b style={{ fontStyle: 'normal', fontWeight: 600, color: '#e9e7e1' }}>
                          Sui:
                        </b>{' '}
                        get on i&apos;m boredddd
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div
                          style={{
                            padding: '7px 14px',
                            fontSize: 13,
                            fontWeight: 600,
                            background: T.accent,
                            border: `1px solid ${T.accent}`,
                            color: T.accentText,
                          }}
                        >
                          Message
                        </div>
                        <div
                          style={{
                            padding: '7px 14px',
                            fontSize: 13,
                            fontWeight: 600,
                            background: 'transparent',
                            border: `1px solid ${T.borderStrong}`,
                            color: 'rgba(233,231,225,0.86)',
                          }}
                        >
                          Play
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};
