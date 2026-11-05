/**
 * Dev-only preview of the SeiLink wallpaper page with its dock and bubble
 * (261104, M4), in a plain browser tab: `?seilinkhost=1&pack=<url to a pack
 * dir>/`. A fake bridge plays the host's part. Params:
 *   time=day|dusk|night   the room's time (default day)
 *   taskbar=<px>          space the work area leaves at the bottom (default 48)
 *   deafened=1            the dock shows her idle lines muted
 *   confirm=1             move out already asking
 *   line=<text>           a line of hers in a bubble (shown once her box is measured)
 *   lineat=<ms>           when the line shows (default 1800)
 *   face=<word>           her face for the line as if it led with a [word] tag (default: read off
 *                         its words, as main does: shared/seilinkExpression.ts)
 *   portrait=<url>        her portrait (else her silhouette)
 *   name=<name>           her name (default Sui)
 *   lang=<code>           UI language
 *   press=edit|deafen     simulate a dock press after the line shows (the caption)
 * Used by scripts/seilink-host-shots.mjs. Never in a packaged build (main.tsx
 * imports it only under import.meta.env.DEV).
 */
import React, { useMemo } from 'react';
import { defaultRoomState, type RoomState } from '@shared/seilinkRoom';
import type { SeilinkDockAction, SeilinkHostBridge, SeilinkHostRoom } from '@shared/seilinkHost';
import { parseRoomManifest } from '@shared/seilinkValidate';
import { desktopLineFace } from '@shared/seilinkExpression';
import type { SeilinkPack } from '@shared/seilinkPack';
import { SeilinkHostView } from './SeilinkHostView';

type Cb<T> = (v: T) => void;

function fakeBridge(params: URLSearchParams): SeilinkHostBridge {
  const packUrl = (params.get('pack') ?? '').replace(/\/?$/, '/');
  const later = (fn: () => void, ms: number): void => void setTimeout(fn, ms);
  // Deafen flips like the real host's answer (seilinkHost.onDockAction).
  let deafened = params.get('deafened') === '1';
  let dockState: Cb<{ deafened: boolean }> | null = null;
  return {
    onRoom: (cb: Cb<SeilinkHostRoom>) => {
      void fetch(`${packUrl}manifest.json`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((raw: unknown) => {
          const manifest = parseRoomManifest(raw);
          if (!manifest) throw new Error('bad manifest');
          const t = params.get('time');
          const state: RoomState = { ...defaultRoomState(manifest.id), time: t === 'dusk' || t === 'night' ? t : 'day' };
          const pack: SeilinkPack = { id: manifest.id, manifest, rev: 1, source: 'dev' };
          cb({
            characterId: 'dev-preview',
            state,
            pack,
            portrait: params.get('portrait'),
            name: params.get('name') ?? 'Sui',
            uiLanguage: params.get('lang'),
          });
        })
        .catch((err: unknown) => console.error('[dev host] pack', err));
      return () => {};
    },
    onBusy: () => () => {},
    onFps: (cb) => {
      later(() => cb(30), 0);
      return () => {};
    },
    onPoke: () => () => {},
    setBox: () => {},
    frames: () => {},
    // The shot script waits for [data-room-ready="1"], like the room preview's.
    firstFrame: () => {
      document.body.dataset.roomReady = '1';
    },
    ready: () => {},
    onLayout: (cb) => {
      const tb = Number(params.get('taskbar') ?? 48) || 0;
      later(() => cb({ workArea: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight - tb } }), 0);
      return () => {};
    },
    onDockState: (cb) => {
      dockState = cb;
      later(() => cb({ deafened }), 0);
      return () => {};
    },
    onDockPress: (cb: Cb<SeilinkDockAction>) => {
      const p = params.get('press');
      if (p === 'edit' || p === 'deafen') later(() => cb(p), 2600);
      return () => {};
    },
    setDock: () => {},
    dockAction: (a) => {
      console.log(`[dev host] dock action ${a}`);
      if (a !== 'deafen') return;
      deafened = !deafened;
      dockState?.({ deafened });
    },
    onLine: (cb) => {
      const text = params.get('line');
      const look = text ? desktopLineFace(text, params.get('face')) : null;
      if (text) later(() => cb({ id: 1, text, kind: 'poke', ...look }), Number(params.get('lineat') ?? 1800) || 1800);
      return () => {};
    },
  };
}

export function DevHostPreview(): React.ReactElement {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const bridge = useMemo(() => fakeBridge(params), [params]);
  const packUrl = (params.get('pack') ?? '').replace(/\/?$/, '/');
  // `_shared/...` (views, pattern tiles) sits beside the pack dirs, as in the real resolver.
  const resolveFor = useMemo(() => () => (rel: string) => (rel.startsWith('_shared/') ? new URL(`../${rel}`, packUrl).href : `${packUrl}${rel}`), [packUrl]);
  return <SeilinkHostView bridge={bridge} resolveFor={resolveFor} initialConfirm={params.get('confirm') === '1'} />;
}
