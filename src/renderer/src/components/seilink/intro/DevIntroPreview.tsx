/**
 * Dev-only preview of the SeiLink first-link intro (261105, T337), in a plain
 * browser tab: http://localhost:5173/?seilinkintro=1&pack=<url of a pack dir>
 *
 *   &name=Lyra              her name in the lines
 *   &portrait=<url>         her portrait (the fallback figure)
 *   &faces=<url>&face=<id>  her face set (a dir of facepacks, as DevRoomPreview)
 *   &style=aurora|bloom|tide   the treatment (default: the shipping one)
 *   &room=blank|default     her blank first room (default) or the pack's default room
 *   &hold=1                 end on her room (the desktop stage's ending)
 *   &reduced=1              the reduced-motion version
 *   &answer=ok|fail|pending the host start's answer (default ok, after 1.5 s)
 *   &manual=1               no clock: window.__firstLinkSeek(ms) draws a frame
 *                           (scripts/seilink-intro-shots.mjs renders the mp4s so)
 *   &time=day|dusk|night    the room's time of day (default day)
 *   &lang=<code>            UI language
 * The room's first draw sets document.body.dataset.roomReady = '1'.
 * Lazy-loaded by main.tsx under import.meta.env.DEV only.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { INTRO_STYLES, type IntroStyle } from '@shared/seilinkIntroTelemetry';
import { blankRoomState, defaultRoomState, type RoomState } from '@shared/seilinkRoom';
import { parseRoomManifest } from '@shared/seilinkValidate';
import { isUiLanguage } from '@shared/uiLanguage';
import { urlPackSource } from '../../../lib/facepack/facepackSource';
import { useLangStore } from '../../../lib/i18n';
import { DEFAULT_INTRO_STYLE } from '../../../lib/seilink/introPref';
import { FirstLinkIntroView, type IntroFinish, type IntroRoom } from './FirstLinkIntroView';

const params = new URLSearchParams(window.location.search);

async function loadRoom(base: string): Promise<IntroRoom | null> {
  const root = base.replace(/\/?$/, '/');
  const res = await fetch(`${root}manifest.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  const manifest = parseRoomManifest(await res.json());
  if (!manifest) return null;
  const blank = params.get('room') !== 'default' && manifest.id === 'cozy';
  const state: RoomState = blank ? blankRoomState() : defaultRoomState(manifest.id);
  const time = params.get('time') ?? 'day';
  if (['auto', 'day', 'dusk', 'night'].includes(time)) state.time = time as RoomState['time'];
  return { manifest, state, resolve: (rel) => `${rel.startsWith('_shared/') ? `${root}../` : root}${rel}` };
}

export function DevIntroPreview(): React.ReactElement | null {
  const [room, setRoom] = useState<IntroRoom | null | undefined>(params.get('pack') ? undefined : null);
  const [answer, setAnswer] = useState<boolean | null>(null);
  const [run, setRun] = useState(0);
  const [ended, setEnded] = useState<IntroFinish | null>(null);
  const style = (INTRO_STYLES as readonly string[]).includes(params.get('style') ?? '') ? (params.get('style') as IntroStyle) : DEFAULT_INTRO_STYLE;
  const reduced = params.get('reduced') === '1';
  const manual = params.get('manual') === '1';
  const facepack = useMemo(() => (params.get('faces') ? urlPackSource(params.get('face') ?? 'sui', params.get('faces')!) : undefined), []);

  useEffect(() => {
    const lang = params.get('lang');
    if (isUiLanguage(lang)) useLangStore.getState().setLang(lang);
    document.documentElement.style.background = '#000';
    document.body.style.background = '#000';
    const pack = params.get('pack');
    if (pack) void loadRoom(pack).then(setRoom, () => setRoom(null));
  }, []);

  useEffect(() => {
    if (manual) return;
    setAnswer(null);
    const mode = params.get('answer') ?? 'ok';
    if (mode === 'pending') return;
    const t = window.setTimeout(() => setAnswer(mode !== 'fail'), 1500);
    return () => window.clearTimeout(t);
  }, [run, manual]);

  if (room === undefined) return null;
  if (ended) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', color: '#cfe0ff', fontFamily: 'monospace' }}>
        <button
          type="button"
          style={{ border: 'none', background: 'rgba(255,255,255,0.1)', color: 'inherit', padding: '10px 16px', borderRadius: 2, cursor: 'pointer' }}
          onClick={() => {
            setEnded(null);
            setRun((n) => n + 1);
          }}
        >
          {`${ended.action} at ${ended.beat} after ${Math.round(ended.elapsedMs)} ms. Play again`}
        </button>
      </div>
    );
  }
  return (
    <FirstLinkIntroView
      key={run}
      style={style}
      reduced={reduced}
      characterId="dev-preview"
      name={params.get('name') ?? 'Sui'}
      room={room}
      portrait={params.get('portrait')}
      facepack={facepack}
      answer={manual ? true : answer}
      manual={manual}
      holdEnd={params.get('hold') === '1'}
      onFinish={setEnded}
      onReady={() => {
        document.body.dataset.roomReady = '1';
      }}
    />
  );
}
