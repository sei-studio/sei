/**
 * Dev-only preview of the WorldLink first-link intro (261105, T337), in a plain
 * browser tab: http://localhost:5173/?seilinkintro=1&pack=<url of a pack dir>
 *
 *   &name=Lyra              her name in the lines
 *   &portrait=<url>         her portrait (the fallback figure)
 *   &faces=<url>&face=<id>  her face set (a dir of facepacks, as DevRoomPreview)
 *   &room=plain|blank|default   end on the plain background (default; black or
 *                           white with the page's prefers-color-scheme, or &tone),
 *                           the old blank room, or the pack's default room
 *   &tone=dark|light        force the plain background's (and the solid's) colour
 *   &hold=1                 end on that picture (the desktop stage's ending)
 *   &reduced=1              the reduced-motion version
 *   &sim=<ms>               a simulated link whose Anima bake is done after <ms>
 *                           (lib/seilink/worldLink.ts simulatedLog; default: all
 *                           ready at once, the lines at the minimum dwell)
 *   &simfail=<ms>&failure=<class>   the simulated link fails there instead
 *                           (default bake_failed)
 *   &host=<ms>              when the simulated host start answers (default 2500)
 *   &manual=1               no clock: window.__firstLinkSeek(ms) draws a frame
 *                           (scripts/seilink-intro-shots.mjs renders the mp4s so)
 *   &time=day|dusk|night    the room's time of day (default day)
 *   &lang=<code>            UI language
 * The room's first draw sets document.body.dataset.roomReady = '1'; the
 * status lines' report (seilink_intro_link) lands on window.__firstLinkReport.
 * Lazy-loaded by main.tsx under import.meta.env.DEV only.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { blankRoomState, defaultRoomState, plainRoomState, type RoomState } from '@shared/seilinkRoom';
import { parseRoomManifest } from '@shared/seilinkValidate';
import { isUiLanguage } from '@shared/uiLanguage';
import { LINK_FAILURES, type LinkFailure } from '@shared/seilinkIntroTelemetry';
import { urlPackSource } from '../../../lib/facepack/facepackSource';
import { useLangStore } from '../../../lib/i18n';
import { introEndFor, plainTone, type PlainTone } from '../../../lib/seilink/plainTone';
import { fixedSource, instantLog, simulatedLog, type LinkLog } from '../../../lib/seilink/worldLink';
import { FirstLinkIntroView, type IntroFinish, type IntroRoom } from './FirstLinkIntroView';

const params = new URLSearchParams(window.location.search);

declare global {
  interface Window {
    __firstLinkReport?: Record<string, string | number>;
  }
}

function num(key: string): number | undefined {
  const v = Number(params.get(key));
  return params.get(key) !== null && Number.isFinite(v) ? v : undefined;
}

/** The simulated link from the URL (a fresh object for every run: the view writes nothing into a fixed log, but a run must not share one). */
function simLog(): LinkLog {
  const done = num('sim');
  const failAt = num('simfail');
  const f = params.get('failure');
  const failure: LinkFailure | undefined = f && (LINK_FAILURES as readonly string[]).includes(f) ? (f as LinkFailure) : undefined;
  if (done === undefined && failAt === undefined) return instantLog();
  return simulatedLog({ doneMs: done ?? 75_000, failAtMs: failAt, failure, hostMs: num('host') });
}

async function loadRoom(base: string): Promise<IntroRoom | null> {
  const root = base.replace(/\/?$/, '/');
  const res = await fetch(`${root}manifest.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  const manifest = parseRoomManifest(await res.json());
  if (!manifest) return null;
  const kind = params.get('room') ?? 'plain';
  const state: RoomState =
    kind === 'plain' ? plainRoomState(manifest) : kind === 'blank' && manifest.id === 'cozy' ? blankRoomState() : defaultRoomState(manifest.id);
  const time = params.get('time') ?? 'day';
  if (['auto', 'day', 'dusk', 'night'].includes(time)) state.time = time as RoomState['time'];
  return { manifest, state, resolve: (rel) => `${rel.startsWith('_shared/') ? `${root}../` : root}${rel}` };
}

export function DevIntroPreview(): React.ReactElement | null {
  const [room, setRoom] = useState<IntroRoom | null | undefined>(params.get('pack') ? undefined : null);
  const [run, setRun] = useState(0);
  const [ended, setEnded] = useState<IntroFinish | null>(null);
  const tone: PlainTone = params.get('tone') === 'light' ? 'light' : params.get('tone') === 'dark' ? 'dark' : plainTone();
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => fixedSource(simLog()), [run]);

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
      end={introEndFor(room?.state ?? null, tone)}
      tone={tone}
      reduced={reduced}
      characterId="dev-preview"
      name={params.get('name') ?? 'Sui'}
      room={room}
      portrait={params.get('portrait')}
      facepack={facepack}
      source={source}
      manual={manual}
      holdEnd={params.get('hold') === '1'}
      onFinish={setEnded}
      onReport={(r) => {
        window.__firstLinkReport = r;
        console.info('[seilink_intro_link]', JSON.stringify(r));
      }}
      onReady={() => {
        document.body.dataset.roomReady = '1';
      }}
    />
  );
}
