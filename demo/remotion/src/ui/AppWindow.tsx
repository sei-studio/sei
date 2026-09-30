import React from 'react';
import { staticFile } from 'remotion';
import { T } from '../theme';
import { GlobeIcon, GridIcon, PlusIcon, SlidersIcon, SparkleIcon } from './icons';

/**
 * The Sei app window recreated at 1180x760 (the app's logical size in the
 * demo screenshots). Faithful to MacosWindow + IconRail:
 *  - sharp corners, --shadow-window, 34px drag strip with "Sei v0.6.0"
 *  - 74px rail: home (active bar), world, divider, avatar sockets, "+",
 *    spacer, star, settings
 *  - content panel with a 12px rounded top-left corner and a hairline border
 */
export const WIN_W = 1180;
export const WIN_H = 760;
export const RAIL_W = 74;
export const STRIP_H = 34;

export type RailActive = 'home' | 'sui';

const RailButton: React.FC<{ active?: boolean; children: React.ReactNode }> = ({
  active,
  children,
}) => (
  <div
    style={{
      position: 'relative',
      width: 42,
      height: 42,
      display: 'grid',
      placeItems: 'center',
      color: active ? T.text : T.muted,
    }}
  >
    {active && (
      <div
        style={{
          position: 'absolute',
          left: -15,
          top: 9,
          bottom: 9,
          width: 3,
          background: T.accent,
        }}
      />
    )}
    {children}
  </div>
);

export const AppWindow: React.FC<{
  active: RailActive;
  children: React.ReactNode;
}> = ({ active, children }) => {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: WIN_W,
        height: WIN_H,
        background: T.bg,
        boxShadow:
          '0 0 0 1px rgba(0,0,0,.5), 0 24px 60px rgba(0,0,0,.55), 0 4px 16px rgba(0,0,0,.35)',
        overflow: 'hidden',
        fontFamily: T.sans,
        color: T.text,
      }}
    >
      {/* Drag strip */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          height: STRIP_H,
          background: T.bg,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {/* macOS traffic lights */}
        <div style={{ display: 'flex', gap: 8, marginLeft: 19 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
          ))}
        </div>
        <span
          style={{
            marginLeft: RAIL_W + 40 - 19 - 12 * 3 - 8 * 2,
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: '0.04em',
            color: T.muted,
          }}
        >
          Sei
        </span>
        <span
          style={{
            marginLeft: 4,
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: '0.04em',
            color: T.muted,
            opacity: 0.7,
          }}
        >
          v0.6.0
        </span>
      </div>

      {/* Icon rail */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: STRIP_H,
          bottom: 0,
          width: RAIL_W,
          background: T.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '14px 0',
          gap: 6,
        }}
      >
        <RailButton active={active === 'home'}>
          <GridIcon size={22} />
        </RailButton>
        <RailButton>
          <GlobeIcon size={22} />
        </RailButton>
        <div style={{ width: 30, height: 1, background: T.borderStrong, margin: '10px 0' }} />
        {(['sui', 'marv', 'lyra'] as const).map((c) => {
          const isActive = active === 'sui' && c === 'sui';
          return (
            <div
              key={c}
              style={{
                width: 46,
                height: 46,
                display: 'grid',
                placeItems: 'center',
                marginBottom: 2,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  overflow: 'hidden',
                  background: T.surface2,
                  border: `1px solid ${T.borderStrong}`,
                  boxShadow: isActive ? `0 0 0 2px ${T.bg}, 0 0 0 4px ${T.accent}` : undefined,
                }}
              >
                <img
                  src={staticFile(`img/portraits/${c}.png`)}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: '50% 18%',
                    filter: 'saturate(.9)',
                  }}
                />
              </div>
            </div>
          );
        })}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: '1px solid rgba(127,176,255,0.4)',
            display: 'grid',
            placeItems: 'center',
            color: 'rgba(127,176,255,0.55)',
            marginTop: 4,
          }}
        >
          <PlusIcon size={18} />
        </div>
        <div style={{ flex: 1 }} />
        <RailButton>
          <SparkleIcon size={22} />
        </RailButton>
        <RailButton>
          <SlidersIcon size={22} />
        </RailButton>
      </div>

      {/* Content panel: rounded top-left corner over the chrome */}
      <div
        style={{
          position: 'absolute',
          left: RAIL_W,
          top: STRIP_H,
          right: 0,
          bottom: 0,
          background: T.bg,
          borderTopLeftRadius: 12,
          borderTop: `1px solid ${T.border}`,
          borderLeft: `1px solid ${T.border}`,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>

      {/* Grain overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0.04,
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />
    </div>
  );
};
