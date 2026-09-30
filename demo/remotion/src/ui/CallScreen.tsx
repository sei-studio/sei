import React from 'react';
import { staticFile } from 'remotion';
import { T } from '../theme';
import { HangUpIcon, HeadphonesIcon, MicIcon, PlusIcon, ScreenIcon } from './icons';

const MountainIcon: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M2.5 19h19L14 6.5l-3.6 6-2.2-3z" />
    <circle cx="17.5" cy="7" r="1.9" />
  </svg>
);

/**
 * VoiceCallScreen stage (rendered inside ChatScreen's frame): centered
 * cluster of avatar tiles (solo = 176px), Oswald 30px name, pulsing green
 * dot + "Calling…" / duration subtitle, and the CallControls pill row
 * (64x44 r12 pills; hang-up 76px wide, red).
 */
export const CallStage: React.FC<{
  frame: number; // for pulse phases
  status: 'calling' | 'live';
  seconds: number;
  sharing: boolean; // share pill toggled (inverted fill)
  speaking?: boolean;
}> = ({ frame, status, seconds, sharing, speaking }) => {
  const pulse = (period: number): number => 0.5 + 0.5 * Math.sin((frame / period) * Math.PI * 2);
  const dotOpacity = 0.4 + 0.6 * pulse(48); // callPulse 1.6s
  const ring = pulse(36); // speakRing 1.2s
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');

  const pill = (
    icon: React.ReactNode,
    opts?: { toggled?: boolean; hangup?: boolean },
  ): React.ReactNode => (
    <div
      style={{
        width: opts?.hangup ? 76 : 64,
        height: 44,
        borderRadius: 12,
        display: 'grid',
        placeItems: 'center',
        background: opts?.hangup
          ? T.red
          : opts?.toggled
            ? T.text
            : 'rgba(233,231,225,0.09)',
        color: opts?.hangup ? T.accentText : opts?.toggled ? T.bg : T.text,
      }}
    >
      {icon}
    </div>
  );

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 40,
        textAlign: 'center',
      }}
    >
      {/* Tiles */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 176,
              height: 176,
              borderRadius: '50%',
              overflow: 'hidden',
              background: T.surface2,
              border: `1px solid ${speaking ? T.accent : T.borderStrong}`,
              boxShadow: speaking
                ? `0 0 0 4px rgba(127,176,255,${0.55 - 0.41 * ring}), 0 0 ${14 + 8 * ring}px ${2 + 2 * ring}px rgba(127,176,255,${0.4 - 0.12 * ring})`
                : '0 18px 40px -8px rgba(0,0,0,.70)',
            }}
          >
            <img
              src={staticFile('img/portraits/sui.png')}
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 18%' }}
            />
          </div>
          <span style={{ fontSize: 13, color: T.text2 }}>Sui</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 176,
              height: 176,
              borderRadius: '50%',
              border: `1px dashed ${T.borderStrong}`,
              display: 'grid',
              placeItems: 'center',
              color: T.muted,
            }}
          >
            <PlusIcon size={53} />
          </div>
          <span style={{ fontSize: 13, color: T.muted }}>Add</span>
        </div>
      </div>

      {/* Name + subtitle */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <h1
          style={{
            fontFamily: T.display,
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: '0.02em',
            color: T.text,
            margin: 0,
          }}
        >
          Sui
        </h1>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 13,
            color: T.text2,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: T.green,
              opacity: dotOpacity,
            }}
          />
          {status === 'calling' ? 'Calling…' : `${mm}:${ss}`}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {pill(<MicIcon size={22} />)}
        {pill(<HeadphonesIcon size={22} />)}
        {pill(<MountainIcon size={22} />)}
        {pill(<ScreenIcon size={22} />, { toggled: sharing })}
        {pill(<HangUpIcon size={24} />, { hangup: true })}
      </div>
    </div>
  );
};
