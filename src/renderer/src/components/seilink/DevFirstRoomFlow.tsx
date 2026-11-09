/**
 * Dev-only picture of the first-room flow (261106; v3: plain spawn and the
 * guided setup) on a simulated desktop, in a plain browser tab:
 * `?seilinkflow=1&pack=<url of the cozy pack dir>/` (the other packs are
 * loaded from beside it). The wallpaper is the real host page
 * (SeilinkHostView over a fake bridge, as in DevHostPreview); generic desktop
 * chrome (a menu bar, icons, a dock bar) sits over it the way the OS draws its
 * own over the wallpaper. She starts on the plain background (black or white
 * with the page's prefers-color-scheme). Params:
 *   phase=desktop   her on the plain background, the usual dock
 *   phase=offer     her line and the offer's two buttons (line=<text>)
 *   phase=prompt    the offer in UI copy (her line did not come)
 *   phase=later     the offer, then "Not now" pressed (pressat=<ms>);
 *                   press=decorate|later presses one in any offer phase
 *   phase=editor    the room editor on the desktop stage, covering everything
 *                   (guided: she is still plain)
 *   phase=decorated the normal editor after decorating (a few items in)
 *   phase=closed    the editor closed: the decorated wallpaper, icons on top
 *   together=<name> 261110: the editor shared with her (RoomTogether: talk box,
 *                   Call button); voicegate=consent makes Call ask for the module
 *   livecard=stage|app  261110: the "lives on your desktop" card over the
 *                   wallpaper (stage: as over the first link's last frame;
 *                   app: the dialog after a move-in without the intro);
 *                   os=windows|mac|linux picks the shortcut line
 *   phase=login     261107: the "Open on login" step the guided setup's Done
 *                   brings up (over the decorated room)
 *   loginitem=off|approval|fail  261107: the login item as a packaged mac/win
 *                   build has it (not answered yet); "Turn on" then works, waits
 *                   for macOS approval, or is refused. Without it only
 *                   phase=login offers the step (as `off`)
 *   live=1          the phases follow the presses: "Set up together" opens the
 *                   guided editor, its Done (or close) goes back to the
 *                   wallpaper with what was saved
 *   portrait=<url>, name=<name>, lang=<code>, time=day|dusk|night
 * Used by scripts/seilink-first-room-flow.mjs. Never in a packaged build
 * (main.tsx imports it only under import.meta.env.DEV).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultRoomState, plainRoomState, ROOM_PRESET_IDS, type RoomPresetManifest, type RoomState } from '@shared/seilinkRoom';
import type { SeilinkDockAction, SeilinkDockOffer, SeilinkHostBridge } from '@shared/seilinkHost';
import { parseRoomManifest } from '@shared/seilinkValidate';
import { desktopLineFace } from '@shared/seilinkExpression';
import type { SeilinkPack } from '@shared/seilinkPack';
import { addItem } from '@shared/seilinkEdit';
import { SeilinkHostView } from './host/SeilinkHostView';
import { RoomEditor, type RoomTogetherCtx } from './RoomEditor';
import { RoomTogether } from './RoomTogether';
import { LiveCardView } from './LiveCard';
import { memoryRoomEditorSource, type RoomEditorSource } from './roomEditorSource';
import { useLangStore, type UiLanguage } from '../../lib/i18n';
import type { OpenAtLoginSource } from '../../lib/seilink/loginStep';

/** 261107: a login item that is supported and not answered yet; `mode` says what "Turn on" gets. */
function fakeLoginSource(mode: string): OpenAtLoginSource {
  let enabled = false;
  return {
    get: async () => ({ supported: true, enabled, needsApproval: false, decided: false }),
    set: async (on) => {
      await new Promise((r) => setTimeout(r, 300));
      enabled = on && mode !== 'fail';
      return { supported: true, enabled, needsApproval: enabled && mode === 'approval', decided: true };
    },
  };
}

type Cb<T> = (v: T) => void;
const PHASES = ['desktop', 'offer', 'prompt', 'later', 'editor', 'decorated', 'closed', 'login'] as const;
type Phase = (typeof PHASES)[number];

const MENU_H = 26;
const DOCK_H = 74;

/** The room after a short decorating pass: the pack's default look plus its first few items. */
function decorated(manifest: RoomPresetManifest): RoomState {
  let s: RoomState = { ...defaultRoomState(manifest.id), items: [] };
  for (const c of manifest.components.filter((x) => x.slot === 'item').slice(0, 4)) s = addItem(manifest, s, c.id).state;
  return s;
}

function fakeBridge(params: URLSearchParams, manifest: RoomPresetManifest, state: RoomState, phase: Phase, onAction?: (a: SeilinkDockAction) => void): SeilinkHostBridge {
  const later = (fn: () => void, ms: number): void => void setTimeout(fn, ms);
  const asks = phase === 'offer' || phase === 'prompt' || phase === 'later';
  let offer: SeilinkDockOffer = 'none';
  let dockState: Cb<{ deafened: boolean; offer?: SeilinkDockOffer }> | null = null;
  const pack: SeilinkPack = { id: manifest.id, manifest, rev: 1, source: 'dev' };
  return {
    onRoom: (cb) => {
      later(
        () =>
          cb({
            characterId: 'dev-preview',
            state,
            pack,
            portrait: params.get('portrait'),
            name: params.get('name') ?? 'Sui',
            uiLanguage: params.get('lang'),
          }),
        0,
      );
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
    firstFrame: () => {
      document.body.dataset.roomReady = '1';
    },
    ready: () => {},
    // The work area leaves the menu bar and the dock bar, as the OS reports it.
    onLayout: (cb) => {
      later(() => cb({ workArea: { x: 0, y: MENU_H, w: window.innerWidth, h: window.innerHeight - MENU_H - DOCK_H } }), 0);
      return () => {};
    },
    onDockState: (cb) => {
      dockState = cb;
      later(() => cb({ deafened: false, offer }), 0);
      // The offer goes up once her line is out (or right away in UI copy), as decorateOffer.ts does.
      if (asks) {
        later(
          () => {
            offer = phase === 'prompt' ? 'prompt' : 'her';
            cb({ deafened: false, offer });
          },
          phase === 'prompt' ? 900 : 1900,
        );
      }
      return () => {};
    },
    onDockPress: (cb: Cb<SeilinkDockAction>) => {
      const p = params.get('press') ?? (phase === 'later' ? 'later' : null);
      if (p === 'later' || p === 'decorate') later(() => cb(p), Number(params.get('pressat') ?? 4200) || 4200);
      return () => {};
    },
    setDock: () => {},
    // "Not now" / "Decorate together": the host clears the offer before main hears the answer.
    dockAction: (a) => {
      if (a !== 'decorate' && a !== 'later') return;
      offer = 'none';
      dockState?.({ deafened: false, offer });
      onAction?.(a);
    },
    onLine: (cb) => {
      const text = params.get('line');
      if (text && (phase === 'offer' || phase === 'later')) later(() => cb({ id: 1, text, kind: 'poke', ...desktopLineFace(text, null) }), 1800);
      return () => {};
    },
  };
}

// ── Simulated desktop chrome (generic, no brands) ───────────────────────────

const ICONS: Array<{ label: string; kind: 'folder' | 'file' | 'image' }> = [
  { label: 'Documents', kind: 'folder' },
  { label: 'Projects', kind: 'folder' },
  { label: 'Photos', kind: 'folder' },
  { label: 'notes.txt', kind: 'file' },
  { label: 'Screenshot.png', kind: 'image' },
  { label: 'budget.xlsx', kind: 'file' },
];

function DesktopIcon({ label, kind }: { label: string; kind: 'folder' | 'file' | 'image' }): React.ReactElement {
  const glyph =
    kind === 'folder' ? (
      <svg width="54" height="44" viewBox="0 0 54 44" aria-hidden>
        <path d="M2 8 a4 4 0 0 1 4-4 h14 l5 5 h23 a4 4 0 0 1 4 4 v25 a4 4 0 0 1-4 4 H6 a4 4 0 0 1-4-4 Z" fill="#6aa8e8" />
        <path d="M2 14 h50 v24 a4 4 0 0 1-4 4 H6 a4 4 0 0 1-4-4 Z" fill="#8cc1f5" />
      </svg>
    ) : (
      <svg width="40" height="50" viewBox="0 0 40 50" aria-hidden>
        <path d="M3 3 h24 l10 10 v34 H3 Z" fill="#fafafa" stroke="#c9c9c9" />
        <path d="M27 3 v10 h10" fill="#e6e6e6" stroke="#c9c9c9" />
        {kind === 'image' ? <rect x="8" y="22" width="24" height="16" fill="#9cc7a4" /> : null}
        {kind === 'file' ? <path d="M9 22 h22 M9 28 h22 M9 34 h16" stroke="#b4b4b4" strokeWidth="2" /> : null}
      </svg>
    );
  return (
    <div style={{ width: 96, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'flex-end', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.35))' }}>{glyph}</div>
      <span
        style={{
          font: '500 12px/1.2 -apple-system, "Segoe UI", sans-serif',
          color: '#fff',
          textAlign: 'center',
          textShadow: '0 1px 2px rgba(0,0,0,0.85), 0 0 4px rgba(0,0,0,0.6)',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function DesktopChrome(): React.ReactElement {
  const dock = ['#e88a6a', '#6aa8e8', '#9ad07a', '#c48ae8', '#e8c46a', '#7FB0FF', '#e86a8f', '#8a9ae8'];
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 10 }} data-desktop-chrome>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: MENU_H,
          background: 'rgba(30,30,34,0.38)',
          backdropFilter: 'blur(18px)',
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '0 14px',
          font: '500 13px -apple-system, "Segoe UI", sans-serif',
          color: '#fff',
        }}
      >
        <span style={{ width: 13, height: 13, borderRadius: '50%', background: 'rgba(255,255,255,0.9)' }} />
        <b>Files</b>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
        <span>Window</span>
        <span>Help</span>
        <span style={{ marginLeft: 'auto' }}>Fri 10:24</span>
      </div>
      <div style={{ position: 'absolute', top: MENU_H + 18, right: 18, display: 'grid', gridAutoFlow: 'row', gap: 18 }}>
        {ICONS.map((i) => (
          <DesktopIcon key={i.label} {...i} />
        ))}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 6,
          left: '50%',
          transform: 'translateX(-50%)',
          height: DOCK_H - 12,
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(255,255,255,0.22)',
          backdropFilter: 'blur(18px)',
          borderRadius: 18,
        }}
      >
        {dock.map((c, i) => (
          <span key={i} style={{ width: 46, height: 46, borderRadius: 11, background: `linear-gradient(160deg, ${c}, rgba(0,0,0,0.25))` }} />
        ))}
      </div>
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

interface Loaded {
  /** The packs found beside `pack` (cozy first). */
  packs: Array<{ manifest: RoomPresetManifest; resolve: (rel: string) => string }>;
}

async function loadPack(url: string): Promise<{ manifest: RoomPresetManifest; resolve: (rel: string) => string } | null> {
  const r = await fetch(`${url}manifest.json`, { cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return null;
  const manifest = parseRoomManifest(await r.json());
  return manifest ? { manifest, resolve: (rel) => (rel.startsWith('_shared/') ? new URL(`../${rel}`, url).href : `${url}${rel}`) } : null;
}

export function DevFirstRoomFlow(): React.ReactElement {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const raw = params.get('phase') ?? 'desktop';
  const live = params.get('live') === '1';
  const [phase, setPhase] = useState<Phase>((PHASES as readonly string[]).includes(raw) ? (raw as Phase) : 'desktop');
  const packUrl = (params.get('pack') ?? '').replace(/\/?$/, '/');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the editor saved (live): the wallpaper after it closes. */
  const [saved, setSaved] = useState<RoomState | null>(null);

  useEffect(() => {
    const lang = params.get('lang');
    if (lang) useLangStore.getState().setLang(lang as UiLanguage);
    const first = packUrl.replace(/[^/]+\/$/, '');
    const others = ROOM_PRESET_IDS.filter((id) => !packUrl.endsWith(`/${id}/`)).map((id) => `${first}${id}/`);
    void Promise.all([packUrl, ...others].map(loadPack))
      .then((list) => {
        const packs = list.filter((x): x is NonNullable<typeof x> => x !== null);
        if (!packs.length) throw new Error('bad manifest');
        setLoaded({ packs });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [packUrl, params]);

  const main = loaded?.packs[0] ?? null;
  const state = useMemo<RoomState | null>(() => {
    if (!loaded || !main) return null;
    const t = params.get('time');
    const time = t === 'dusk' || t === 'night' ? t : 'day';
    if (saved) return saved;
    const base = phase === 'closed' || phase === 'decorated' || phase === 'login' ? decorated(main.manifest) : plainRoomState(main.manifest);
    return { ...base, time };
    // The phase only picks the starting room; a live run keeps its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, main, params, saved, live ? null : phase]);

  const onDock = useCallback(
    (a: SeilinkDockAction) => {
      if (live && a === 'decorate') window.setTimeout(() => setPhase('editor'), 700);
    },
    [live],
  );
  const wallPack = useMemo(() => (loaded && state ? (loaded.packs.find((p) => p.manifest.id === state.preset) ?? main) : null), [loaded, state, main]);
  const bridge = useMemo(
    () => (wallPack && state ? fakeBridge(params, wallPack.manifest, state, phase, onDock) : null),
    // A new bridge per wallpaper visit (the host page mounts once per bridge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallPack, state, params, phase === 'editor' || phase === 'decorated' ? 'editor' : phase, onDock],
  );
  const source = useMemo<RoomEditorSource | null>(
    () => (loaded && state ? memoryRoomEditorSource(loaded.packs.map((p) => ({ id: p.manifest.id, manifest: p.manifest, resolve: p.resolve, rev: 1 })), state) : null),
    // One source per editor visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, phase === 'editor' || phase === 'decorated' || phase === 'login'],
  );
  const loginMode = params.get('loginitem') ?? (phase === 'login' ? 'off' : null);
  const loginSource = useMemo(() => (loginMode ? fakeLoginSource(loginMode) : null), [loginMode]);

  if (error) return <div style={{ padding: 24, color: '#fff', background: '#111' }}>first-room flow: {error}</div>;
  if (!loaded || !bridge || !source || !wallPack) return <div style={{ height: '100vh', background: '#111' }} />;

  // On the desktop stage the editor covers the display: the menu bar, the icons and the dock bar are under it.
  if (phase === 'editor' || phase === 'decorated' || phase === 'login') {
    return (
      <RoomEditor
        source={source}
        characterId="dev-preview"
        portrait={params.get('portrait')}
        name={params.get('name') ?? 'Sui'}
        onClose={() => {
          if (!live) return;
          void source.load().then((s) => {
            setSaved(s);
            setPhase('closed');
          });
        }}
        fps={30}
        initial={phase === 'decorated' ? { panel: 'items', selected: null } : phase === 'login' ? { loginStep: true } : undefined}
        openAtLogin={loginSource}
        together={params.has('together') ? (ctx: RoomTogetherCtx) => <RoomTogether ctx={ctx} token="dev" characterId="dev-preview" name={params.get('together') || 'Sui'} /> : undefined}
      />
    );
  }
  return (
    <>
      <SeilinkHostView key={`${phase}:${state?.preset}`} bridge={bridge} resolveFor={() => wallPack.resolve} />
      {params.get('livecard') === 'stage' ? null : <DesktopChrome />}
      {params.has('livecard') ? (
        <LiveCardView
          name={params.get('name') ?? 'Sui'}
          os={params.get('os') === 'mac' ? 'mac' : params.get('os') === 'linux' ? 'linux' : 'windows'}
          placement={params.get('livecard') === 'app' ? 'app' : 'stage'}
          onMinimize={params.get('os') === 'linux' ? undefined : () => undefined}
          onDismiss={() => undefined}
        />
      ) : null}
    </>
  );
}
