import React from 'react';
import { staticFile } from 'remotion';
import { T } from '../theme';
import {
  ChevronLeftIcon,
  GamepadIcon,
  PersonIcon,
  PhoneIcon,
  ScreenIcon,
} from './icons';

/**
 * ChatScreen, faithful to the app: Discord-style rows (no bubbles), a 50px
 * top bar (back / 22px avatar / Oswald name / gamepad+backseat+phone), a
 * floating composer dock, and the "{Name} is typing…" line above it.
 *
 * Sized for the 1180x760 window's content area (left 74, top 34).
 */
export const SendIcon: React.FC<{ size?: number; color?: string }> = ({ size = 18, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
);

const BackseatIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <rect x="2" y="6" width="17" height="11" rx="1.5" />
    <path d="M10.5 17v2.5M7.5 19.5h6M10.5 13.5V8M8.5 10 10.5 8l2 2" />
    <path d="M19.2 0.8 20.2 3.3 22.7 4.3 20.2 5.3 19.2 7.8 18.2 5.3 15.7 4.3 18.2 3.3Z" fill="currentColor" stroke="none" />
  </svg>
);

const Row: React.FC<{
  author?: 'sui' | 'you';
  name?: string;
  time?: string;
  children: React.ReactNode;
  opacity?: number;
  lift?: number;
}> = ({ author, name, time, children, opacity = 1, lift = 0 }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '40px 1fr',
      columnGap: 12,
      padding: author ? '4px 0 1px' : '1px 0',
      opacity,
      transform: `translateY(${lift}px)`,
    }}
  >
    <div>
      {author === 'sui' && (
        <div style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', background: T.surface2 }}>
          <img
            src={staticFile('img/portraits/sui.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 18%' }}
          />
        </div>
      )}
      {author === 'you' && (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: T.surface2,
            display: 'grid',
            placeItems: 'center',
            color: T.text2,
          }}
        >
          <PersonIcon size={22} />
        </div>
      )}
    </div>
    <div>
      {author && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{name}</span>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.06em', color: T.muted2 }}>
            {time}
          </span>
        </div>
      )}
      <div style={{ fontSize: 15, lineHeight: 1.5, color: T.text, whiteSpace: 'pre-wrap' }}>
        {children}
      </div>
    </div>
  </div>
);

export interface ChatState {
  draft: string; // current composer text
  caretOn: boolean;
  sent: boolean; // "wanna game?" row visible
  sentPop: number; // 0..1 entrance of the sent row
  typing: boolean; // "Sui is typing…" line
  reply: boolean; // Sui's reply rows visible
  replyPop: number;
  onCall?: boolean; // phone button accent (call view open)
}

export const ChatScreen: React.FC<ChatState & { children?: React.ReactNode }> = ({
  draft,
  caretOn,
  sent,
  sentPop,
  typing,
  reply,
  replyPop,
  onCall,
  children,
}) => {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: T.bg }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flex: 'none' }}>
        <div style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', color: T.text2 }}>
          <ChevronLeftIcon size={20} />
        </div>
        <div style={{ width: 22, height: 22, borderRadius: '50%', overflow: 'hidden', background: T.surface2 }}>
          <img
            src={staticFile('img/portraits/sui.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 18%' }}
          />
        </div>
        <div style={{ flex: 1, position: 'relative', top: -2 }}>
          <span style={{ fontFamily: T.display, fontSize: 17, fontWeight: 600, letterSpacing: '0.02em', color: T.text }}>
            Sui
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4, position: 'relative', top: -1 }}>
          <div style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', color: T.text2 }}>
            <GamepadIcon size={18} />
          </div>
          <div style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', color: T.text2 }}>
            <BackseatIcon size={18} />
          </div>
          <div style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', color: onCall ? T.accent : T.text2 }}>
            <PhoneIcon size={18} />
          </div>
        </div>
      </div>

      {children ?? (
        <>
          {/* Message list */}
          <div style={{ flex: 1, padding: '24px 24px 0', overflow: 'hidden' }}>
            {/* Day separator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ flex: 1, height: 1, background: T.borderStrong }} />
              <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.04em', color: T.muted }}>
                7 Aug 2026
              </span>
              <div style={{ flex: 1, height: 1, background: T.borderStrong }} />
            </div>
            <Row author="sui" name="Sui" time="21:12">
              yo you&apos;re on!
            </Row>
            <Row>i&apos;m bored lol, entertain me</Row>
            {sent && (
              <Row author="you" name="You" time="21:13" opacity={sentPop} lift={(1 - sentPop) * 10}>
                wanna game?
              </Row>
            )}
            {reply && (
              <>
                <Row author="sui" name="Sui" time="21:13" opacity={replyPop} lift={(1 - replyPop) * 10}>
                  FINALLY. yes.
                </Row>
                <Row opacity={replyPop} lift={(1 - replyPop) * 10}>
                  get in here, i call dibs on winning
                </Row>
              </>
            )}
          </div>

          {/* Composer dock */}
          <div style={{ flex: 'none', padding: '8px 12px 12px', background: T.bg }}>
            {typing && (
              <div style={{ fontSize: 12, color: T.muted, padding: '2px 4px', marginBottom: 4 }}>
                Sui is typing…
              </div>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '11px 14px',
                background: T.bg2,
              }}
            >
              <div style={{ flex: 1, padding: '6px 8px', fontSize: 15, lineHeight: 1.4, minHeight: 26, display: 'flex', alignItems: 'center' }}>
                {draft ? (
                  <span style={{ color: T.text }}>
                    {draft}
                    {caretOn && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 1.5,
                          height: 16,
                          background: T.text,
                          marginLeft: 1,
                          verticalAlign: 'text-bottom',
                        }}
                      />
                    )}
                  </span>
                ) : (
                  <span style={{ color: T.muted2 }}>
                    {caretOn && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 1.5,
                          height: 16,
                          background: T.text,
                          marginRight: 3,
                          verticalAlign: 'text-bottom',
                        }}
                      />
                    )}
                    Message Sui…
                  </span>
                )}
              </div>
              {draft.length > 0 && (
                <div style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', color: T.accent }}>
                  <SendIcon size={18} />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export { ScreenIcon };
