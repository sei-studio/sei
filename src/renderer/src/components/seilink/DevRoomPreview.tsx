/**
 * Dev-only SeiLink room preview (261104). Mounted by main.tsx when
 * `import.meta.env.DEV` and the URL carries `?seilink=1`:
 *   - in the app: main's dev window (unpackaged + SEI_SEILINK_PACKS; open it
 *     at boot with SEI_SEILINK_PREVIEW=1), packs over sei-room://;
 *   - in a plain browser tab: add `&pack=<http url of a pack dir>` (served
 *     with CORS), e.g. the shot script's static server.
 *
 * Params (for screenshots): time=auto|day|dusk|night, items=1, hud=0,
 * fit=cover|contain, fps=30|15|0, tint.<slot>=<hex without #>.
 *
 * The HUD is tinted by the room (roomOverlay), not by the app theme: that is
 * the rule the editor overlay follows.
 *
 * `&editor=1` opens the room editor (RoomEditor) instead, over an in-memory
 * source (saves last until reload). Every `&pack=<url>` is one preset, so
 * several give the room type picker something to switch to. Editor params:
 * panel=<avatar|room|items|slot id>, selected=<item index>, items=1, time=,
 * tint.<slot>=, lang=<ui language>.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultRoomState, type RoomPresetManifest, type RoomSlotId, type RoomState } from '@shared/seilinkRoom';
import { parseRoomManifest } from '@shared/seilinkValidate';
import type { RoomFit, RoomOverlay } from '@shared/seilinkDraw';
import { seilinkResolver, type RoomUrlResolver, type SeilinkPack } from '@shared/seilinkPack';
import { RoomCanvas, type RoomAvatarSlot } from './RoomCanvas';
import { clearRoomImageCache } from '../../lib/seilink/roomImages';
import { RoomEditor } from './RoomEditor';
import { addItem } from '@shared/seilinkEdit';
import { memoryRoomEditorSource, type EditorPack, type RoomEditorSource } from './roomEditorSource';
import { useLangStore, type UiLanguage } from '../../lib/i18n';

const params = new URLSearchParams(window.location.search);
const TIMES = ['auto', 'day', 'dusk', 'night'] as const;

interface Loaded {
  manifest: RoomPresetManifest;
  resolve: RoomUrlResolver;
  label: string;
}

async function loadFromUrl(base: string): Promise<Loaded> {
  const root = base.replace(/\/?$/, '/');
  const res = await fetch(`${root}manifest.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const manifest = parseRoomManifest(await res.json());
  if (!manifest) throw new Error('manifest failed validation');
  const rev = Date.now();
  return { manifest, resolve: (rel) => `${root}${rel}?v=${rev}`, label: root };
}

function initialState(manifest: RoomPresetManifest): RoomState {
  const s = defaultRoomState(manifest.id);
  const t = params.get('time');
  if (t && (TIMES as readonly string[]).includes(t)) s.time = t as RoomState['time'];
  for (const [k, v] of params) {
    if (!k.startsWith('tint.')) continue;
    const slot = k.slice(5) as RoomSlotId;
    if (manifest.slots[slot] && /^[0-9a-f]{6}$/i.test(v)) s.slots[slot] = { id: manifest.slots[slot]!.options[0], tint: `#${v.toLowerCase()}` };
  }
  if (params.get('items') === '1') s.items = sampleItems(manifest);
  return s;
}

/** A few items at plausible spots, from whatever item components the pack has. */
function sampleItems(manifest: RoomPresetManifest): RoomState['items'] {
  const [w, h] = manifest.canvas;
  const floorY = manifest.floor ? manifest.floor[1] + manifest.floor[3] * 0.55 : h * 0.86;
  const spots = { floor: [[w * 0.62, floorY + h * 0.03], [w * 0.42, floorY + h * 0.06]], wall: [[w * 0.56, h * 0.44]], surface: [[w * 0.5, h * 0.7]] };
  const used = { floor: 0, wall: 0, surface: 0 };
  const out: RoomState['items'] = [];
  for (const c of manifest.components) {
    if (c.slot !== 'item') continue;
    const where = c.placement ?? 'floor';
    const spot = spots[where][used[where]++];
    if (!spot) continue;
    out.push({ id: c.id, x: Math.round(spot[0]), y: Math.round(spot[1]) });
  }
  return out;
}

/** Stand-in for her: a flat silhouette at the avatar slot. The real avatar plugs in here. */
function PlaceholderAvatar({ slot }: { slot: RoomAvatarSlot }): React.ReactElement {
  const h = slot.height;
  const fill = slot.time === 'night' ? '#3a3f63' : slot.time === 'dusk' ? '#7d5a73' : '#9fb4e6';
  return (
    <svg width={h * 0.62} height={h} viewBox="0 0 62 100" aria-label="avatar placeholder">
      <path d="M8 100 C8 74 16 62 31 62 C46 62 54 74 54 100 Z" fill={fill} />
      <circle cx="31" cy="40" r="17" fill={fill} />
      <path d="M13 42 C13 18 49 18 49 42 L52 64 L44 52 L18 52 L10 64 Z" fill={fill} opacity="0.85" />
    </svg>
  );
}

/** The editor over URL packs (browser tab) or main's dev packs (the dev window), saving in memory. */
function DevRoomEditor({ onClose }: { onClose(): void }): React.ReactElement {
  const [source, setSource] = useState<RoomEditorSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const lang = params.get('lang');
    if (lang) useLangStore.getState().setLang(lang as UiLanguage);
    void (async () => {
      try {
        const urls = params.getAll('pack');
        const packs: EditorPack[] = urls.length
          ? await Promise.all(
              urls.map(async (u) => {
                const l = await loadFromUrl(u);
                return { id: l.manifest.id, manifest: l.manifest, resolve: l.resolve, rev: u };
              }),
            )
          : ((await window.sei?.seilinkPacks?.()) ?? []).map((p) => ({ id: p.id, manifest: p.manifest, resolve: seilinkResolver(p), rev: p.rev }));
        const first = packs[0];
        let start = first ? initialState(first.manifest) : null;
        if (first && start && params.get('items') === '1') {
          // The pack's own spots for each item (addItem), not the canvas preview's sample spots.
          start = { ...start, items: [] };
          for (const c of first.manifest.components) if (c.slot === 'item') start = addItem(first.manifest, start, c.id).state;
        }
        setSource(memoryRoomEditorSource(packs, start));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);
  if (error) return <div style={{ padding: 24, color: '#f4f1ee', background: '#14161c', height: '100vh', font: '14px var(--sans)' }}>SeiLink editor: {error}</div>;
  if (!source) return <div style={{ height: '100vh', background: '#14161c' }} />;
  const sel = params.get('selected');
  return (
    <RoomEditor
      source={source}
      onClose={onClose}
      fps={Number(params.get('fps') ?? 30) || 0}
      initial={{ panel: (params.get('panel') as never) ?? null, selected: sel !== null ? Number(sel) : null }}
    />
  );
}

export function DevRoomPreview(): React.ReactElement {
  const [editing, setEditing] = useState(params.has('editor'));
  if (editing) return <DevRoomEditor onClose={() => setEditing(false)} />;
  return <DevRoomPreviewCanvas onEdit={() => setEditing(true)} />;
}

function DevRoomPreviewCanvas({ onEdit }: { onEdit(): void }): React.ReactElement {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [packs, setPacks] = useState<SeilinkPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [fit, setFit] = useState<RoomFit>((params.get('fit') as RoomFit) === 'contain' ? 'contain' : 'cover');
  const [fps, setFps] = useState<number>(Number(params.get('fps') ?? 30) || 0);
  const [overlay, setOverlay] = useState<RoomOverlay | null>(null);
  const [ready, setReady] = useState(false);
  const hud = params.get('hud') !== '0';

  const pickPack = useCallback((p: SeilinkPack) => {
    setLoaded({ manifest: p.manifest, resolve: seilinkResolver(p), label: `${p.id} (${p.source})` });
    setState(initialState(p.manifest));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setReady(false);
    clearRoomImageCache();
    try {
      const url = params.getAll('pack')[0];
      if (url) {
        const l = await loadFromUrl(url);
        setLoaded(l);
        setState(initialState(l.manifest));
        return;
      }
      const list = (await window.sei?.seilinkPacks?.()) ?? [];
      setPacks(list);
      if (list.length === 0) throw new Error('No SeiLink packs. Set SEI_SEILINK_PACKS (see scripts/seilink-dev-pack.mjs) or pass ?pack=<url>.');
      pickPack(list[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pickPack]);

  useEffect(() => {
    void load();
  }, [load]);

  const tintables = useMemo(() => {
    if (!loaded || !state) return [];
    const byId = new Map(loaded.manifest.components.map((c) => [c.id, c]));
    return (Object.keys(loaded.manifest.slots) as RoomSlotId[])
      .map((slot) => {
        const def = loaded.manifest.slots[slot]!;
        const chosen = state.slots[slot]?.id;
        const c = byId.get(chosen ?? def.options[0]);
        return c?.tintable ? { slot, value: state.slots[slot]?.tint ?? c.defaultTint ?? '#ffffff' } : null;
      })
      .filter((x): x is { slot: RoomSlotId; value: string } => x !== null);
  }, [loaded, state]);

  const panel: React.CSSProperties = {
    position: 'absolute',
    top: 12,
    left: 12,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    maxWidth: 'calc(100% - 24px)',
    padding: '8px 12px',
    borderRadius: 'var(--radius)',
    background: overlay ? `${overlay.color}cc` : 'rgba(20,22,28,0.8)',
    color: overlay?.ink ?? '#f4f1ee',
    backdropFilter: 'blur(10px)',
    font: '13px var(--sans)',
  };
  const btn = (on: boolean): React.CSSProperties => ({
    font: 'inherit',
    color: 'inherit',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    cursor: 'pointer',
    background: on ? (overlay?.light ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.22)') : 'transparent',
  });

  if (error) {
    return <div style={{ padding: 24, color: '#f4f1ee', background: '#14161c', height: '100vh', font: '14px var(--sans)' }}>SeiLink preview: {error}</div>;
  }
  if (!loaded || !state) return <div style={{ height: '100vh', background: '#14161c' }} />;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }} data-room-ready={ready ? '1' : '0'}>
      <RoomCanvas
        manifest={loaded.manifest}
        state={state}
        resolveUrl={loaded.resolve}
        fit={fit}
        fps={fps}
        avatar={(slot) => <PlaceholderAvatar slot={slot} />}
        onOverlay={setOverlay}
        onReady={() => setReady(true)}
        onError={(e) => console.warn(`[seilink preview] ${e.file}: ${e.message}`)}
      >
        {hud && (
          <div style={panel}>
            <strong style={{ marginRight: 4 }}>{loaded.label}</strong>
            {packs.length > 1 &&
              packs.map((p) => (
                <button key={p.id} type="button" style={btn(loaded.manifest.id === p.id)} onClick={() => pickPack(p)}>
                  {p.id}
                </button>
              ))}
            {TIMES.map((t) => (
              <button key={t} type="button" style={btn(state.time === t)} onClick={() => setState({ ...state, time: t })}>
                {t}
              </button>
            ))}
            {tintables.map(({ slot, value }) => (
              <label key={slot} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                {slot}
                <input
                  type="color"
                  value={value}
                  onChange={(e) => setState({ ...state, slots: { ...state.slots, [slot]: { id: state.slots[slot]?.id ?? loaded.manifest.slots[slot]!.options[0], tint: e.target.value } } })}
                />
              </label>
            ))}
            <button type="button" style={btn(state.items.length > 0)} onClick={() => setState({ ...state, items: state.items.length ? [] : sampleItems(loaded.manifest) })}>
              items
            </button>
            <button type="button" style={btn(fit === 'contain')} onClick={() => setFit(fit === 'cover' ? 'contain' : 'cover')}>
              {fit}
            </button>
            {[30, 15, 0].map((f) => (
              <button key={f} type="button" style={btn(fps === f)} onClick={() => setFps(f)}>
                {f} fps
              </button>
            ))}
            <button type="button" style={btn(false)} onClick={() => void load()}>
              reload
            </button>
            <button type="button" style={btn(false)} onClick={onEdit}>
              edit
            </button>
          </div>
        )}
      </RoomCanvas>
    </div>
  );
}
