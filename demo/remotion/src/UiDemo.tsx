import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Camera, CamKey } from './camera';
import { Cursor, CursorKey } from './Cursor';
import { AppWindow } from './ui/AppWindow';
import { CallStage } from './ui/CallScreen';
import { ChatScreen } from './ui/ChatScreen';
import { HomeScreen } from './ui/HomeScreen';

/** Window placement inside the 1920x1080 comp. */
export const WK = 1.28;
export const WOX = (1920 - 1180 * WK) / 2; // 204.8
export const WOY = (1080 - 760 * WK) / 2; // 53.6
export const wp = (x: number, y: number): { x: number; y: number } => ({
  x: WOX + x * WK,
  y: WOY + y * WK,
});

export const DESKTOP_BG = 'radial-gradient(85% 85% at 50% 38%, #0e1c38 0%, #071129 55%, #040a1c 100%)';

const MSG = 'wanna game?';

// ── Timeline (frames) ────────────────────────────────────────────────────
const CLICK_SUI = 50;
const CHAT_IN = 56;
const CLICK_COMPOSER = 88;
const TYPE_START = 92;
const TYPE_PER_CHAR = 4;
const TYPE_END = TYPE_START + MSG.length * TYPE_PER_CHAR; // 136
const CLICK_SEND = 142;
const TYPING_ON = 154;
const REPLY = 188;
const CLICK_CALL = 234;
const CALL_IN = 238;
const CALL_LIVE = 284;
const CLICK_SHARE = 308;
export const UI_DEMO_LEN = 332;

export const UiDemo: React.FC = () => {
  const frame = useCurrentFrame();

  // Window pop-in.
  const pop = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const popScale = 0.96 + 0.04 * pop;

  // Sui panel hover progress + click flash.
  const hover = interpolate(frame, [24, 38], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const flash =
    frame >= CLICK_SUI && frame <= CLICK_SUI + 6 ? 1 - (frame - CLICK_SUI) / 6 : 0;

  // Screen switching.
  const screen: 'home' | 'chat' | 'call' = frame < CHAT_IN ? 'home' : frame < CALL_IN ? 'chat' : 'call';
  const chatFade = interpolate(frame, [CHAT_IN, CHAT_IN + 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const callFade = interpolate(frame, [CALL_IN, CALL_IN + 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Composer typing.
  const chars = Math.max(
    0,
    Math.min(MSG.length, Math.floor((frame - TYPE_START) / TYPE_PER_CHAR)),
  );
  const draft = frame >= CLICK_SEND ? '' : MSG.slice(0, chars);
  const caretOn = frame >= CLICK_COMPOSER && frame < CLICK_SEND && Math.floor(frame / 14) % 2 === 0;

  const sentPop = interpolate(frame, [CLICK_SEND, CLICK_SEND + 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const replyPop = interpolate(frame, [REPLY, REPLY + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ── Camera ─────────────────────────────────────────────────────────────
  const keys: CamKey[] = [
    { f: 0, x: 960, y: 540, s: 1 },
    { f: 18, x: 960, y: 540, s: 1 },
    // zoom onto Sui's panel (name + buttons in frame), drift while zoomed
    { f: 42, ...wp(310, 470), s: 1.35 },
    { f: CHAT_IN, ...wp(308, 482), s: 1.42 },
    // chat opens: settle on the conversation column
    { f: CHAT_IN + 10, ...wp(620, 400), s: 1.3 },
    // down to the composer, tight
    { f: CLICK_COMPOSER, ...wp(360, 591), s: 2.5 },
    { f: TYPE_END + 4, ...wp(365, 594), s: 2.55 },
    // pull up: messages + typing line both visible
    { f: TYPING_ON + 2, ...wp(500, 440), s: 1.45 },
    // punch to the reply
    { f: REPLY + 8, ...wp(430, 320), s: 1.95 },
    { f: 216, ...wp(430, 320), s: 2.0 },
    // to the call button, top right
    { f: CLICK_CALL - 2, ...wp(1050, 130), s: 2.4 },
    // call opens: pull wide
    { f: CALL_IN + 14, ...wp(630, 420), s: 1.15 },
    { f: CALL_LIVE, ...wp(630, 420), s: 1.18 },
    // to the control pills
    { f: CLICK_SHARE - 6, ...wp(627, 562), s: 2.0 },
    // punch into the share pill
    { f: UI_DEMO_LEN - 8, ...wp(700, 562), s: 2.55 },
  ];

  // ── Cursor (window coords → comp coords) ───────────────────────────────
  const cw = (x: number, y: number, f: number): CursorKey => ({ f, ...wp(x, y) });
  const cursorKeys: CursorKey[] = [
    cw(1250, 800, 0),
    cw(1250, 800, 16),
    cw(300, 430, 34), // over Sui panel
    cw(295, 445, CLICK_SUI), // click Sui
    cw(295, 445, CHAT_IN + 6),
    cw(320, 722, CLICK_COMPOSER), // composer input
    cw(320, 722, TYPE_END + 2),
    cw(1146, 722, CLICK_SEND - 1), // send button
    cw(1146, 722, CLICK_SEND + 10),
    cw(900, 400, TYPING_ON + 10), // drift while reading
    cw(900, 400, 214),
    cw(1151, 59, CLICK_CALL - 2), // phone button
    cw(1151, 59, CLICK_CALL + 8),
    cw(900, 300, CALL_IN + 20),
    cw(900, 300, CALL_LIVE - 6),
    cw(700, 562, CLICK_SHARE - 4), // share pill
    cw(700, 562, UI_DEMO_LEN),
  ];
  const clicks = [CLICK_SUI, CLICK_COMPOSER, CLICK_SEND, CLICK_CALL, CLICK_SHARE];

  const callSeconds = Math.max(0, Math.floor((frame - CALL_LIVE) / 30));

  // End fade (cut point for the screenshare clip).
  const endFade = interpolate(frame, [UI_DEMO_LEN - 6, UI_DEMO_LEN - 1], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ position: 'absolute', inset: 0, background: DESKTOP_BG }}>
      <Camera keys={keys} frame={frame}>
        <div
          style={{
            position: 'absolute',
            left: WOX,
            top: WOY,
            width: 1180 * WK,
            height: 760 * WK,
            opacity: pop,
            transform: `scale(${popScale})`,
            transformOrigin: '50% 50%',
          }}
        >
          <div style={{ transform: `scale(${WK})`, transformOrigin: '0 0' }}>
            <AppWindow active={screen === 'home' ? 'home' : 'sui'}>
              {screen === 'home' && <HomeScreen hover={hover} flash={flash} />}
              {screen === 'chat' && (
                <div style={{ position: 'absolute', inset: 0, opacity: chatFade }}>
                  <ChatScreen
                    draft={draft}
                    caretOn={caretOn}
                    sent={frame >= CLICK_SEND}
                    sentPop={sentPop}
                    typing={frame >= TYPING_ON && frame < REPLY}
                    reply={frame >= REPLY}
                    replyPop={replyPop}
                  />
                </div>
              )}
              {screen === 'call' && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    opacity: callFade,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <ChatScreen
                    draft=""
                    caretOn={false}
                    sent
                    sentPop={1}
                    typing={false}
                    reply
                    replyPop={1}
                    onCall
                  >
                    <CallStage
                      frame={frame}
                      status={frame < CALL_LIVE ? 'calling' : 'live'}
                      seconds={callSeconds}
                      sharing={frame >= CLICK_SHARE + 2}
                      speaking={frame >= CALL_LIVE + 10}
                    />
                  </ChatScreen>
                </div>
              )}
            </AppWindow>
          </div>
        </div>
        <Cursor keys={cursorKeys} frame={frame} clicks={clicks} opacity={pop} />
      </Camera>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: '#000',
          opacity: endFade,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};
