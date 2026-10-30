/**
 * DevFacepackPreview (261028) — dev-only preview for the desktop companion
 * facepack pilot, NOT part of the app UI. main.tsx lazy-loads it behind
 * `import.meta.env.DEV` when the URL carries `?facepack=1`.
 *
 * Two ways in:
 *  - Electron dev (SEI_FACEPACK_DIR set): main's "facepack:open-preview"
 *    window. Packs come from the dev pack dir over IPC.
 *  - A plain browser tab against a static server:
 *      http://localhost:5173/?facepack=1&base=<url of a dir holding sui/ lyra/ marv/>
 *        &packs=sui,lyra,marv   pack ids (default: the three)
 *        &pack=sui              start on this pack
 *        &clips=<url>           per-expression clips at <clips>/<pack>-<expression>.wav
 *        &auto=1                run the recording script once, then set
 *                               window.__facepackDone = true
 *
 * Live cues (Electron mode): the preview runs the real cue path
 * (initFaceCues + useFaceStore). Chat with Sui, Lyra or Marv in the main
 * window and the preview switches to that character's pack and shows the
 * expression their line led with. This window has no call audio, so cues
 * apply on arrival here (on a call the main window's hold-until-audible
 * timing is what a real host would use).
 *
 * The talk test feeds FacepackView through `bandsRef`, sampled off an
 * AnalyserNode with the SAME settings and code the TTS tap uses
 * (fftSize 512, smoothing 0.5, sampleAnalyser at 25 Hz), so what moves here
 * is what moves on a call. With no clip it plays a synthetic voice: a
 * harmonic buzz shaped by vowel formants, syllable by syllable.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { packPalette, type FacepackManifest } from '@shared/facepack';
import { FACE_EXPRESSION_NAMES } from '../../../bot/brain/faceExpressions.js';
import { sei } from '../lib/ipcClient';
import { FacepackView, type FaceDebugState } from '../lib/facepack/FacepackView';
import { type FacepackSource, ipcPackSource, urlPackSource } from '../lib/facepack/facepackSource';
import type { LevelSample } from '../lib/facepack/animation';
import { sampleAnalyser } from '../lib/facepack/levelBands';
import { posesOf } from '../lib/facepack/compose';
import { initFaceCues, useFaceStore } from '../lib/stores/useFaceStore';

const params = new URLSearchParams(window.location.search);
const BASE = params.get('base');
const CLIPS = params.get('clips');
const AUTO = params.has('auto');
/** &zoom=2&cx=0&cy=0.3: camera framing (zoom on the face for close checks). */
const CAMERA = params.has('zoom')
  ? { zoom: Number(params.get('zoom')) || 1, x: Number(params.get('cx')) || 0, y: Number(params.get('cy')) || 0 }
  : null;

/** Formants (F1, F2 Hz) per vowel for the synthetic voice. */
const VOWELS: Array<[number, number]> = [
  [800, 1200], // aa
  [500, 1900], // ee
  [300, 2300], // ii
  [450, 800], // oo
  [330, 900], // uu
];

function synthVoice(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.floor(seconds * sr), sr);
  const out = buf.getChannelData(0);
  let t = 0;
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  while (t < out.length) {
    const len = Math.floor((0.12 + rnd() * 0.14) * sr);
    const gap = Math.floor((rnd() < 0.2 ? 0.12 : 0.03) * sr);
    const [f1, f2] = VOWELS[Math.floor(rnd() * VOWELS.length)];
    const f0 = 170 + rnd() * 50;
    const hiss = rnd() < 0.15;
    for (let i = 0; i < len && t + i < out.length; i++) {
      const env = Math.sin((Math.PI * i) / len);
      let v = 0;
      if (hiss) v = (rnd() * 2 - 1) * 0.25;
      else {
        for (let k = 1; k <= 24; k++) {
          const f = k * f0;
          const g = Math.exp(-(((f - f1) / 140) ** 2)) + 0.7 * Math.exp(-(((f - f2) / 200) ** 2)) + 0.02;
          v += g * Math.sin((2 * Math.PI * f * (t + i)) / sr);
        }
        v *= 0.18;
      }
      out[t + i] = v * env;
    }
    t += len + gap;
  }
  return buf;
}

interface Pack {
  id: string;
  source: FacepackSource;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function DevFacepackPreview(): React.ReactElement {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [packId, setPackId] = useState<string | null>(params.get('pack'));
  const [manifest, setManifest] = useState<FacepackManifest | null>(null);
  const [expression, setExpression] = useState('neutral');
  const [seq, setSeq] = useState(0);
  const [pose, setPose] = useState<string | null>(null);
  const [overlays, setOverlays] = useState(true);
  const [decay, setDecay] = useState(false);
  const [status, setStatus] = useState('loading');
  const [talking, setTalking] = useState(false);
  const [follow, setFollow] = useState(!BASE);
  const [lastCue, setLastCue] = useState<string | null>(null);
  const bandsRef = useRef<LevelSample | null>(null);
  const debugRef = useRef<FaceDebugState | null>(null);
  const [debug, setDebug] = useState<FaceDebugState | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const fileRef = useRef<AudioBuffer | null>(null);

  // Pack list.
  useEffect(() => {
    void (async () => {
      if (BASE) {
        const ids = (params.get('packs') ?? 'sui,lyra,marv').split(',').filter(Boolean);
        setPacks(ids.map((id) => ({ id, source: urlPackSource(id, BASE) })));
        return;
      }
      const info = await sei.facepackInfo?.();
      if (!info?.enabled) {
        setStatus('facepack dev flag is off (set SEI_FACEPACK_DIR, unpackaged only)');
        return;
      }
      setPacks(
        info.packs.map((p) => ({
          id: p.id,
          source: info.baseUrl ? urlPackSource(p.id, info.baseUrl) : ipcPackSource(p.id),
        })),
      );
    })();
  }, []);
  useEffect(() => {
    if (!packId && packs.length) setPackId(packs[0].id);
  }, [packs, packId]);
  const pack = packs.find((p) => p.id === packId) ?? null;

  useEffect(() => {
    setManifest(null);
    if (pack) void pack.source.manifest().then(setManifest);
  }, [pack]);

  useEffect(() => {
    const t = setInterval(() => setDebug(debugRef.current ? { ...debugRef.current } : null), 100);
    // The recording script keeps a per-frame log for frame-by-frame review.
    let raf = 0;
    const log: Array<FaceDebugState & { t: number }> = [];
    if (AUTO) (window as unknown as { __faceLog?: unknown }).__faceLog = log;
    const tick = (): void => {
      if (debugRef.current) log.push({ t: performance.now(), ...debugRef.current });
      raf = requestAnimationFrame(tick);
    };
    if (AUTO) raf = requestAnimationFrame(tick);
    return () => {
      clearInterval(t);
      cancelAnimationFrame(raf);
    };
  }, []);

  const pick = useCallback((name: string) => {
    setExpression(name);
    setSeq((n) => n + 1);
  }, []);

  // Live cues from the main window's chat / call / in-game say().
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    if (BASE || !sei.onFaceCue) return;
    initFaceCues();
    const packFor = new Map<string, Promise<string | null>>();
    return useFaceStore.subscribe((s, prev) => {
      for (const [characterId, entry] of Object.entries(s.faces)) {
        if (prev.faces[characterId]?.seq === entry.seq) continue;
        setLastCue(`${entry.expression} (${characterId.slice(0, 8)})`);
        if (!followRef.current) continue;
        if (!packFor.has(characterId)) packFor.set(characterId, sei.facepackForCharacter?.(characterId) ?? Promise.resolve(null));
        void packFor.get(characterId)!.then((id) => {
          if (!followRef.current) return;
          if (id) setPackId(id);
          setExpression(entry.expression);
          setSeq((n) => n + 1);
        });
      }
    });
  }, []);

  /** Play a buffer through an analyser and feed bandsRef while it plays. */
  const talk = useCallback(async (buffer?: AudioBuffer | null): Promise<void> => {
    const ctx = audioRef.current ?? new AudioContext();
    audioRef.current = ctx;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const buf = buffer ?? synthVoice(ctx, 2.4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    const time = new Float32Array(analyser.fftSize);
    const freq = new Float32Array(analyser.frequencyBinCount);
    setTalking(true);
    const timer = setInterval(() => {
      bandsRef.current = sampleAnalyser(analyser, { time, freq });
      if (AUTO) {
        const w = window as unknown as { __bandLog?: LevelSample[] };
        (w.__bandLog ??= []).push(bandsRef.current);
      }
    }, 40);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    clearInterval(timer);
    bandsRef.current = null;
    src.disconnect();
    analyser.disconnect();
    setTalking(false);
  }, []);

  const loadClip = useCallback(async (url: string): Promise<AudioBuffer | null> => {
    try {
      const ctx = audioRef.current ?? new AudioContext();
      audioRef.current = ctx;
      const r = await fetch(url);
      if (!r.ok) return null;
      return await ctx.decodeAudioData(await r.arrayBuffer());
    } catch {
      return null;
    }
  }, []);

  // The faces this pack offers (its palette), else the base 12.
  const names = useMemo(() => (manifest ? (packPalette(manifest)?.expressions ?? [...FACE_EXPRESSION_NAMES]) : [...FACE_EXPRESSION_NAMES]), [manifest]);

  // The recording script: every expression with a line, then a pose sweep.
  const ranAuto = useRef(false);
  useEffect(() => {
    if (!AUTO || ranAuto.current || status !== 'ready' || !manifest || !packId) return;
    ranAuto.current = true;
    void (async () => {
      await sleep(1_800);
      for (const name of names) {
        pick(name);
        await sleep(350);
        const clip = CLIPS ? await loadClip(`${CLIPS}/${packId}-${name}.wav`) : null;
        await talk(clip);
        await sleep(900);
      }
      pick('neutral');
      await sleep(600);
      for (const p of posesOf(manifest, 'neutral')) {
        setPose(p);
        await sleep(800);
      }
      setPose(null);
      await sleep(1_200);
      (window as unknown as { __facepackDone?: boolean }).__facepackDone = true;
    })();
  }, [status, manifest, packId, pick, talk, loadClip, names]);

  const poses = useMemo(() => (manifest ? posesOf(manifest, expression) : []), [manifest, expression]);

  const btn: React.CSSProperties = {
    background: '#2a2e39',
    color: '#e8ecf4',
    border: 'none',
    borderRadius: 6,
    padding: '6px 10px',
    font: '13px system-ui, sans-serif',
    cursor: 'pointer',
  };
  const on: React.CSSProperties = { ...btn, background: '#7FB0FF', color: '#0d1018' };

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        background: '#14161c',
        color: '#e8ecf4',
        font: '13px system-ui, sans-serif',
      }}
    >
      <div style={{ flex: 1, position: 'relative', background: '#dfe6ef' }}>
        {pack && (
          <FacepackView
            key={pack.id}
            characterId={`dev-${pack.id}`}
            source={pack.source}
            expression={expression}
            expressionSeq={seq}
            pose={pose}
            overlays={overlays}
            decay={decay}
            bandsRef={bandsRef}
            debugRef={debugRef}
            camera={CAMERA}
            onStatus={setStatus}
            style={{ position: 'absolute', inset: 0 }}
          />
        )}
        <div
          style={{
            position: 'absolute',
            left: 10,
            bottom: 10,
            background: 'rgba(0,0,0,.65)',
            padding: '6px 10px',
            borderRadius: 6,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
          }}
        >
          {pack?.id ?? '-'} | {status} | expr {debug?.expression ?? '-'} | pose {debug?.pose ?? '-'} | eyes{' '}
          {debug?.eye ?? '-'} | mouth {debug?.viseme ?? '-'} | lvl {(debug?.level ?? 0).toFixed(2)}
          {debug?.fading ? ' | fade' : ''}
        </div>
      </div>
      <div style={{ width: 300, padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ opacity: 0.7, marginBottom: 6 }}>Pack</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {packs.map((p) => (
              <button key={p.id} style={p.id === packId ? on : btn} onClick={() => setPackId(p.id)}>
                {p.id}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ opacity: 0.7, marginBottom: 6 }}>Expression</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {names.map((n) => (
              <button key={n} style={n === expression ? on : btn} onClick={() => pick(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ opacity: 0.7, marginBottom: 6 }}>Pose</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={pose === null ? on : btn} onClick={() => setPose(null)}>
              idle
            </button>
            {poses.map((p) => (
              <button key={p} style={pose === p ? on : btn} onClick={() => setPose(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
        {!BASE && (
          <div>
            <div style={{ opacity: 0.7, marginBottom: 6 }}>Live cues</div>
            <button style={follow ? on : btn} onClick={() => setFollow((v) => !v)}>
              follow chat
            </button>
            <div style={{ opacity: 0.7, marginTop: 6, fontSize: 12 }}>last: {lastCue ?? 'none yet'}</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={overlays ? on : btn} onClick={() => setOverlays((v) => !v)}>
            overlays
          </button>
          <button style={decay ? on : btn} onClick={() => setDecay((v) => !v)}>
            decay
          </button>
        </div>
        <div>
          <div style={{ opacity: 0.7, marginBottom: 6 }}>Talk test</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={btn} disabled={talking} onClick={() => void talk(null)}>
              synthetic
            </button>
            <button
              style={btn}
              disabled={talking || !CLIPS || !packId}
              onClick={() => void loadClip(`${CLIPS}/${packId}-${expression}.wav`).then((b) => talk(b))}
            >
              clip
            </button>
            <button style={btn} disabled={talking || !fileRef.current} onClick={() => void talk(fileRef.current)}>
              file
            </button>
          </div>
          <input
            type="file"
            accept="audio/*"
            style={{ marginTop: 8, fontSize: 12 }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const ctx = audioRef.current ?? new AudioContext();
              audioRef.current = ctx;
              void f
                .arrayBuffer()
                .then((b) => ctx.decodeAudioData(b))
                .then((b) => {
                  fileRef.current = b;
                  void talk(b);
                });
            }}
          />
        </div>
      </div>
    </div>
  );
}
