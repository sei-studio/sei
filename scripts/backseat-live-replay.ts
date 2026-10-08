/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scripts/backseat-live-replay.ts — replay real gameplay footage through the
 * REAL Backseat service in real time (261009).
 *
 * Unlike backseat-sim.ts (stub persona, virtual time, own turn runner) this
 * drives src/main/backseat/backseatService.ts itself: startBackseat() and
 * handleTick() with the shipped arbitration (priority ladder, MIN_SPEAK_GAP,
 * preemption), the real system blocks (buildSystemBlocks with the character's
 * persona + MEMORY.md + chat history), tickNote, the cache layout, the prev
 * grid, the anchored history window, stripDashes/spokenParts, remember() and
 * the game-tile web tools. The renderer half (captureController +
 * captureWorker) cannot run outside Chromium, so it is reproduced here from
 * its pure modules:
 *
 *   REAL (imported): signals.ts (gain/colour jolt detectors, blockMaxDelta),
 *   switchDwell.ts, transcriptRing.ts (windowText), pcm.ts (rmsDb), and every
 *   constant in shared/backseatIpc.ts (offsets, tolerance, layout, idle
 *   distribution, START_LOOK_MS, SWITCH_DWELL_MS, TICK_TRANSCRIPT_*).
 *
 *   REPRODUCED (mirrors captureController/captureWorker line for line): the
 *   10 Hz cell ring (602x336 JPEG q0.72, letterboxed), the composite (nearest
 *   sample per offset, duplicate drop, gridLayout, q0.82, half-size copy),
 *   the per-frame signal loop (thumb every 100 ms, gain from 512-sample
 *   windows), idle scheduling + noteSpoke reschedule, the start look, the
 *   switch dwell with its speak-gap deferral, the user grid latch.
 *
 *   APPROXIMATED: Whisper runs in Node (onnxruntime-node, same
 *   whisper-tiny.en q8 model) instead of the renderer's wasm worker; the
 *   bounded flush transcribes the tail since the last 3 s chunk at tick time.
 *   JPEG encoder is libjpeg-turbo (sharp), not Chromium's. Frames come from
 *   the video file at 30 fps rather than a live capture.
 *
 * The model is swapped at the wire: the app always asks for COMPANION_MODEL
 * (Haiku 5.5); a fetch wrapper rewrites `model` for the --model arm and, for
 * Haiku 4.5, drops the `thinking: disabled` field Haiku 5 needs (4.5 never
 * received one in production). The dev key (~/.sei-dev/anthropic-test-key)
 * is injected in the wrapper only; the profile holds a dummy key file.
 *
 *   npx tsx scripts/backseat-live-replay.ts prep <video.mp4> <prepDir>
 *   npx tsx scripts/backseat-live-replay.ts run  <prepDir> <outDir> --model claude-haiku-5-5
 *        [--label "Minecraft"] [--game roblox] [--questions q.json] [--seed 7]
 *        [--persona sui-cloud.json] [--memory memory.txt] [--player Ouen]
 *
 * q.json: [{ "at": 22, "text": "who's that guy?" }]   (seconds into the video;
 * the grid latches at `at`, the user tick is sent 2.5 s later, the time a
 * spoken line takes to finish and transcribe).
 *
 * run writes <outDir>/events.jsonl (every tick sent, every log line from the
 * service, every API call with latency + usage, every spoken line) and
 * <outDir>/lines.json. Render with scripts/backseat-live-report.ts.
 */
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name: string, dflt?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}

const FPS = 30;
const SR = 16_000;

// ── Whisper (same model + noise filter as voice/whisperWorker.ts) ──────────

const NOISE_TRANSCRIPTS = new Set([
  '', 'you', 'thank you.', 'thanks for watching!', 'thank you for watching!', '.', 'bye.', 'so', 'the',
]);
function cleanTranscript(raw: string): string {
  const text = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const norm = text.toLowerCase();
  const bare = norm.replace(/[.。．!！?？、,，\s]+$/u, '');
  return NOISE_TRANSCRIPTS.has(norm) || NOISE_TRANSCRIPTS.has(bare) ? '' : text;
}
async function loadAsr(): Promise<(pcm: Float32Array) => Promise<string>> {
  const { pipeline } = await import('@huggingface/transformers');
  const asr: any = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype: 'q8' });
  return async (pcm) => cleanTranscript(String((await asr(pcm))?.text ?? ''));
}

// ── prep ──────────────────────────────────────────────────────────────────

async function prep(video: string, dir: string): Promise<void> {
  const { CELL_W, CELL_H, STT_CHUNK_MS } = await import('../src/shared/backseatIpc');
  const { THUMB_W, THUMB_H } = await import('../src/renderer/src/lib/backseat/signals');
  const { rmsDb } = await import('../src/renderer/src/lib/backseat/pcm');
  const sharp = (await import('sharp')).default;
  mkdirSync(path.join(dir, 'cells'), { recursive: true });
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', video]).toString(),
  );
  const W = probe.streams.find((s: any) => s.width).width;
  const H = probe.streams.find((s: any) => s.width).height;
  const duration = Number(probe.format.duration);
  // drawFitted: aspect-preserving fit into the cell with black bars.
  const scale = Math.min(CELL_W / W, CELL_H / H);
  const fw = Math.round(W * scale);
  const fh = Math.round(H * scale);
  const px = Math.floor((CELL_W - fw) / 2);
  const py = Math.floor((CELL_H - fh) / 2);
  // Frames to lossless PNG first (a raw pipe of ~1700 cells is over a GB),
  // then each one JPEG-encoded at the worker's CELL_QUALITY (0.72).
  const pngDir = path.join(dir, 'png');
  mkdirSync(pngDir, { recursive: true });
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-i', video,
    '-vf', `fps=10,scale=${fw}:${fh}:flags=bilinear,pad=${CELL_W}:${CELL_H}:${px}:${py}:black`,
    '-start_number', '0', path.join(pngDir, '%d.png'),
  ]);
  let nCells = 0;
  while (existsSync(path.join(pngDir, `${nCells}.png`))) {
    const jpg = await sharp(path.join(pngDir, `${nCells}.png`)).jpeg({ quality: 72 }).toBuffer();
    writeFileSync(path.join(dir, 'cells', `${nCells}.jpg`), jpg);
    nCells++;
  }
  execFileSync('rm', ['-rf', pngDir]);
  // 32x18 thumbs at capture rate (the worker's drawImage(frame, 0, 0, 32, 18)).
  const thumbs = execFileSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', video, '-vf', `fps=${FPS},scale=${THUMB_W}:${THUMB_H}:flags=area`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'],
    { maxBuffer: 2 ** 30 },
  );
  writeFileSync(path.join(dir, 'thumbs.rgba'), thumbs);
  // 16 kHz mono PCM, the normalized feed both the gain meter and Whisper read.
  const pcmBuf = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', video, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  writeFileSync(path.join(dir, 'audio.f32'), pcmBuf);
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 4));
  // Steady-state STT: STT_CHUNK_MS chunks from the start of capture, silence
  // below -60 dBFS never reaches Whisper (sttStream ENERGY_FLOOR_DB).
  const asr = await loadAsr();
  const chunk = (STT_CHUNK_MS / 1000) * SR;
  const segments: Array<{ t0: number; t1: number; text: string }> = [];
  for (let s = 0; s + chunk <= pcm.length; s += chunk) {
    const seg = pcm.subarray(s, s + chunk);
    if (rmsDb(seg) < -60) continue;
    const text = await asr(seg);
    if (text) segments.push({ t0: (s / SR) * 1000, t1: ((s + chunk) / SR) * 1000, text });
  }
  writeFileSync(path.join(dir, 'stt.json'), JSON.stringify(segments, null, 1));
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ video: path.resolve(video), duration, W, H, nCells, nThumbs: thumbs.length / (THUMB_W * THUMB_H * 4) }));
  console.log(`prep: ${nCells} cells, ${segments.length} stt segments, ${duration.toFixed(1)}s`);
}

// ── run ───────────────────────────────────────────────────────────────────

const PRICES: Record<string, { in: number; cw: number; cr: number; out: number }> = {
  'claude-haiku-4-5-20251001': { in: 1.0, cw: 1.25, cr: 0.1, out: 5.0 },
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(prepDir: string, outDir: string): Promise<void> {
  const model = flag('model', 'claude-haiku-5-5')!;
  const label = flag('label', 'Game')!;
  const game = flag('game');
  const seed = Number(flag('seed', '7'));
  const player = flag('player', 'Ouen')!;
  const questions: Array<{ at: number; text: string }> = flag('questions')
    ? JSON.parse(readFileSync(flag('questions')!, 'utf8'))
    : [];
  mkdirSync(outDir, { recursive: true });
  const eventsPath = path.join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, '');

  process.env.SEI_PROBE_USERDATA = mkdtempSync(path.join(tmpdir(), 'sei-bslive-ud-'));
  register('./lib/electronStubHooks.mjs', import.meta.url);

  const keyPath = path.join(homedir(), '.sei-dev', 'anthropic-test-key');
  const realKey = (process.env.ANTHROPIC_API_KEY ?? readFileSync(keyPath, 'utf8')).trim();

  let t0 = 0; // wall ms of video t=0
  const vt = (wall = Date.now()): number => Math.round(wall - t0) / 1000;
  const ev = (o: Record<string, unknown>): void => appendFileSync(eventsPath, JSON.stringify({ vt: vt(), ...o }) + '\n');

  // ── wire: key injection, model arm, latency + usage ──
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (!/api\.anthropic\.com\/v1\/messages/.test(url)) return origFetch(input, init);
    const headers = new Headers(init.headers ?? {});
    headers.set('x-api-key', realKey);
    headers.delete('authorization');
    let body = init.body;
    let streamed = false;
    try {
      const b = JSON.parse(String(body));
      b.model = model;
      if (!/haiku-5/.test(model)) delete b.thinking;
      streamed = b.stream === true;
      body = JSON.stringify(b);
    } catch {
      /* not JSON, pass through */
    }
    const start = Date.now();
    const res = await origFetch(url, { ...init, headers, body });
    const headersAt = Date.now();
    void (async () => {
      try {
        const text = await res.clone().text();
        const usage: any = {};
        let webSearches = 0;
        if (streamed) {
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const d = JSON.parse(line.slice(6));
            if (d.type === 'message_start') Object.assign(usage, d.message?.usage ?? {});
            if (d.type === 'message_delta' && d.usage) Object.assign(usage, d.usage);
          }
        } else {
          const j = JSON.parse(text);
          Object.assign(usage, j.usage ?? {});
        }
        webSearches = usage.server_tool_use?.web_search_requests ?? 0;
        const p = PRICES[model];
        const cost = p
          ? ((usage.input_tokens ?? 0) * p.in +
              (usage.cache_creation_input_tokens ?? 0) * p.cw +
              (usage.cache_read_input_tokens ?? 0) * p.cr +
              (usage.output_tokens ?? 0) * p.out) /
              1e6 +
            webSearches * 0.01
          : 0;
        ev({ type: 'api', status: res.status, ms: Date.now() - start, ttfbMs: headersAt - start, streamed, usage, cost, ...(res.status !== 200 ? { error: text.slice(0, 300) } : {}) });
      } catch (err) {
        ev({ type: 'api', status: res.status, ms: Date.now() - start, parseError: String(err) });
      }
    })();
    return res;
  }) as typeof fetch;

  // ── main-process modules (after the stub + fetch are in place) ──
  const { paths } = await import('../src/main/paths');
  const { saveConfig, loadConfig } = await import('../src/main/configStore');
  const { CharacterSchema } = await import('../src/shared/characterSchema');
  const { appendMemory } = await import('../src/bot/brain/memory/memoryLog.js');
  const svc = await import('../src/main/backseat/backseatService');
  const ipc = await import('../src/shared/backseatIpc');
  const sig = await import('../src/renderer/src/lib/backseat/signals');
  const { createSwitchDwell } = await import('../src/renderer/src/lib/backseat/switchDwell');
  const { windowText } = await import('../src/renderer/src/lib/backseat/transcriptRing');
  const { rmsDb } = await import('../src/renderer/src/lib/backseat/pcm');
  const sharp = (await import('sharp')).default;

  // ── profile: config, Sui from her cloud row, a small memory, dummy key ──
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, preferred_name: player, ai_backend_kind: 'local', provider: 'anthropic', chat_language: 'en' } as any);
  mkdirSync(path.dirname(paths.apiKeyPath()), { recursive: true });
  writeFileSync(paths.apiKeyPath(), 'sk-ant-dummy-replaced-on-the-wire');
  const rowRaw = JSON.parse(readFileSync(flag('persona')!, 'utf8'));
  const row = Array.isArray(rowRaw) ? rowRaw[0] : rowRaw;
  const { description: _d, ...metadata } = (row.metadata ?? {}) as Record<string, unknown>;
  void _d;
  const character = CharacterSchema.parse({
    id: row.id,
    kind: row.kind ?? 'custom',
    public_id: row.public_id ?? null,
    name: row.name,
    slug: row.slug ?? null,
    persona: { source: row.persona_source ?? '', expanded: row.persona_expanded ?? '' },
    is_default: false,
    shared: true,
    created: row.created_at,
    metadata,
    username: row.username ?? null,
  });
  mkdirSync(paths.charactersDir(), { recursive: true });
  writeFileSync(paths.characterPath(character.id), JSON.stringify(character, null, 2));
  const memFile = flag('memory');
  if (memFile) {
    const memPath = path.join(paths.memoryDir(character.id), 'MEMORY.md');
    mkdirSync(path.dirname(memPath), { recursive: true });
    for (const line of readFileSync(memFile, 'utf8').split('\n')) {
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (m) await appendMemory(memPath, m[2], m[1]);
    }
  }

  // ── footage ──
  const meta = JSON.parse(readFileSync(path.join(prepDir, 'meta.json'), 'utf8'));
  const thumbsBuf = readFileSync(path.join(prepDir, 'thumbs.rgba'));
  const TB = sig.THUMB_W * sig.THUMB_H * 4;
  const thumbAt = (i: number): Uint8ClampedArray => new Uint8ClampedArray(thumbsBuf.buffer, thumbsBuf.byteOffset + i * TB, TB);
  const pcmBuf = readFileSync(path.join(prepDir, 'audio.f32'));
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 4));
  const GAIN_WIN = 512;
  const gains: number[] = [];
  for (let i = 0; i + GAIN_WIN <= pcm.length; i += GAIN_WIN) gains.push(rmsDb(pcm.subarray(i, i + GAIN_WIN)));
  const gainAt = (sec: number): number => {
    const k = Math.floor((sec * SR) / GAIN_WIN) - 1;
    return k >= 0 && k < gains.length ? gains[k] : -100;
  };
  const sttSegs: Array<{ t0: number; t1: number; text: string }> = JSON.parse(readFileSync(path.join(prepDir, 'stt.json'), 'utf8'));
  const asr = await loadAsr();
  const cellJpeg = (i: number): Buffer => readFileSync(path.join(prepDir, 'cells', `${Math.min(i, meta.nCells - 1)}.jpg`));

  // ── capture-worker reproduction ──
  interface Sample { at: number; cell: number; thumb: Uint8ClampedArray }
  const ring: Sample[] = [];
  const jolt = sig.createJoltState();
  const TH = { gainDb: ipc.JOLT_GAIN_DB, colorMad: ipc.JOLT_COLOR_MAD, colorFloor: ipc.JOLT_COLOR_FLOOR, refractoryMs: ipc.JOLT_REFRACTORY_MS };
  let frame = 0;
  let lastSampleAt = 0;
  let stopped = false;
  let maxLagMs = 0;

  async function composite(): Promise<null | { dataUrl: string; smallUrl: string; capturedAt: number; ages: number[]; dropped: number }> {
    if (!ring.length) return null;
    const now = Date.now();
    const nearest = (target: number): Sample | null => {
      let best: Sample | null = null;
      let bestGap = Infinity;
      for (const s of ring) {
        const gap = Math.abs(s.at - target);
        if (gap > bestGap) break;
        best = s;
        bestGap = gap;
      }
      return best;
    };
    const picked: Sample[] = [];
    for (const off of ipc.GRID_OFFSETS_S) {
      const target = now - off * 1000;
      const hit = nearest(target);
      if (!hit || Math.abs(hit.at - target) > ipc.SAMPLE_TOLERANCE_MS) continue;
      if (picked.length && picked[picked.length - 1].at === hit.at) continue;
      if (picked.length && sig.blockMaxDelta(picked[picked.length - 1].thumb, hit.thumb) <= ipc.GRID_DUPLICATE_DELTA) continue;
      picked.push(hit);
    }
    if (!picked.length) return null;
    const { cols, w, h } = ipc.gridLayout(picked.length);
    const grid = await sharp({ create: { width: w, height: h, channels: 3, background: '#000' } })
      .composite(picked.map((s, i) => ({ input: cellJpeg(s.cell), left: (i % cols) * ipc.CELL_W, top: Math.floor(i / cols) * ipc.CELL_H })))
      .jpeg({ quality: 82 })
      .toBuffer();
    const small = await sharp(grid).resize(Math.round(w * ipc.PREV_GRID_SCALE), Math.round(h * ipc.PREV_GRID_SCALE)).jpeg({ quality: 82 }).toBuffer();
    const newestAt = picked[picked.length - 1].at;
    return {
      dataUrl: `data:image/jpeg;base64,${grid.toString('base64')}`,
      smallUrl: `data:image/jpeg;base64,${small.toString('base64')}`,
      capturedAt: newestAt,
      ages: picked.map((s) => Math.round(newestAt - s.at) / 1000),
      dropped: ipc.GRID_OFFSETS_S.length - picked.length,
      // for the report: which video seconds the cells came from
      ...( { cellsVt: picked.map((s) => s.cell / 10) } as any),
    };
  }

  // sttStream.tickTranscript: bounded flush of the tail, then the window.
  async function tickTranscript(): Promise<string | undefined> {
    const nowV = (Date.now() - t0);
    const segs = sttSegs.filter((s) => s.t1 <= nowV).slice();
    const chunkMs = ipc.STT_CHUNK_MS;
    const tailFrom = Math.floor(nowV / chunkMs) * chunkMs;
    if (nowV - tailFrom >= ipc.STT_MIN_FLUSH_MS) {
      const tail = pcm.subarray(Math.floor((tailFrom / 1000) * SR), Math.floor((nowV / 1000) * SR));
      if (tail.length && rmsDb(tail) >= -60) {
        const text = await Promise.race([asr(tail), new Promise<string>((r) => setTimeout(() => r(''), ipc.STT_FLUSH_WAIT_MS))]);
        if (text) segs.push({ t0: tailFrom, t1: nowV, text });
      }
    }
    const text = windowText(segs, nowV, ipc.TICK_TRANSCRIPT_MS, ipc.TICK_TRANSCRIPT_MAX_CHARS);
    return text || undefined;
  }

  const characterId = character.id;
  const shareLabel = label;
  async function sendTick(kind: 'start' | 'idle' | 'jolt' | 'user', grid: any, extra: Record<string, unknown> = {}): Promise<void> {
    if (stopped || !grid) return;
    const sentAt = Date.now();
    ev({ type: 'tick', kind, ages: grid.ages, cellsVt: grid.cellsVt, joltReason: extra.joltReason, transcript: extra.transcript, text: extra.text });
    const tickId = `${kind}@${vt(sentAt)}`;
    currentTicks.set(tickId, sentAt);
    try {
      await svc.handleTick({
        characterId,
        kind,
        grid: grid.dataUrl,
        gridSmall: grid.smallUrl,
        capturedAt: grid.capturedAt,
        frameAges: grid.ages,
        shareLabel,
        ...extra,
      } as any);
    } catch (err) {
      ev({ type: 'tickError', kind, error: String(err) });
    }
    ev({ type: 'tickDone', kind, sentVt: vt(sentAt), ms: Date.now() - sentAt });
  }
  const currentTicks = new Map<string, number>();

  // idle scheduling (captureController.scheduleIdle) with a seeded draw
  const rand = mulberry32(seed);
  let idleTimer: NodeJS.Timeout | undefined;
  let idleBusy = false;
  const scheduleIdle = (): void => {
    if (stopped) return;
    clearTimeout(idleTimer);
    const delay = ipc.nextIdleDelayMs(rand);
    idleTimer = setTimeout(() => {
      scheduleIdle();
      if (stopped || idleBusy) return;
      idleBusy = true;
      void (async () => {
        try {
          const grid = await composite();
          if (!grid) return;
          const transcript = await tickTranscript();
          await sendTick('idle', grid, { transcript });
        } finally {
          idleBusy = false;
        }
      })();
    }, delay);
  };

  // switch dwell with the speak-gap deferral (captureController.fireSwitch)
  let lastSpokeLocalAt = 0;
  let switchDeferTimer: NodeJS.Timeout | undefined;
  async function fireSwitch(sinceChangeMs: number): Promise<void> {
    if (stopped) return;
    const gapLeft = ipc.MIN_SPEAK_GAP_MS - (Date.now() - lastSpokeLocalAt);
    if (gapLeft > 0) {
      clearTimeout(switchDeferTimer);
      switchDeferTimer = setTimeout(() => void fireSwitch(sinceChangeMs + gapLeft), gapLeft + 250);
      return;
    }
    const grid = await composite();
    if (!grid) return;
    const transcript = await tickTranscript();
    await sendTick('jolt', grid, { joltReason: 'switch', sinceSwitchS: Math.round(sinceChangeMs / 100) / 10, transcript });
  }
  const switchDwell = createSwitchDwell({ dwellMs: ipc.SWITCH_DWELL_MS, onFire: (ms) => void fireSwitch(ms) });

  const noteSpoke = (): void => {
    lastSpokeLocalAt = Date.now();
    scheduleIdle();
  };

  // ── service deps (the IPC bridge in the app) ──
  const lines: Array<Record<string, unknown>> = [];
  let lastTurn: { kind: string; at: number } | null = null;
  // Start time of the latest turn per tick kind. Two turns can overlap (a
  // screen tick can slip in while a user turn awaits its chat-row write, before
  // it claims s.inflight), so the speaker is the turn whose "turn <kind>:" log
  // came right before the line, not simply the most recently started one.
  const turnStart = new Map<string, number>();
  svc.initBackseatService({
    pushChatMessage: (_id, message) => {
      if (message.role === 'user') return;
      // Attributed to the turn whose result was just logged (see turnStart).
      const rec = {
        vt: vt(),
        text: message.text,
        kind: lastTurn?.kind ?? '?',
        tickVt: lastTurn ? vt(lastTurn.at) : null,
        latencyMs: lastTurn ? Date.now() - lastTurn.at : null,
      };
      lines.push(rec);
      ev({ type: 'line', ...rec });
    },
    pushState: () => {},
    pushLine: (_id, line) => {
      if (line.who === 'player') ev({ type: 'playerLine', text: line.text });
      noteSpoke();
    },
    requestClip: (id, requestId) => setTimeout(() => svc.receiveClip(id, requestId, null), 50),
    isCallActive: () => true,
    pushLog: () => {},
  });
  const origLog = console.log;
  const origWarn = console.warn;
  const tap = (orig: typeof console.log) => (...a: unknown[]): void => {
    const s = a.map(String).join(' ');
    if (s.startsWith('[sei/backseat]')) {
      const msg = s.slice(15);
      const m = msg.match(/^tick (\w+)(?::\w+)? (?:-> turn|preempts)/);
      if (m) {
        lastTurn = { kind: m[1], at: Date.now() };
        turnStart.set(m[1], lastTurn.at);
      }
      const done = msg.match(/^turn (\w+): /);
      if (done && turnStart.has(done[1])) lastTurn = { kind: done[1], at: turnStart.get(done[1])! };
      ev({ type: 'log', msg });
    }
    else orig(...a);
  };
  console.log = tap(origLog);
  console.warn = tap(origWarn);

  await svc.startBackseat(characterId, 'window:1:0', label, 'voice', game ? ({ gameId: game } as any) : undefined);
  ev({ type: 'meta', model, label, game: game ?? null, seed, questions, player });

  // ── go: real time ──
  t0 = Date.now();
  const total = meta.nThumbs;
  const frameLoop = setInterval(() => {
    const nowV = Date.now() - t0;
    maxLagMs = Math.max(maxLagMs, nowV - (frame * 1000) / FPS);
    while (frame < total && (frame * 1000) / FPS <= nowV) {
      const fwall = t0 + (frame * 1000) / FPS;
      const thumb = thumbAt(frame);
      sig.pushGain(jolt, fwall, gainAt(frame / FPS));
      const lastThumbAt = jolt.thumbTrace.length ? jolt.thumbTrace[jolt.thumbTrace.length - 1][0] : 0;
      if (fwall - lastThumbAt >= 100) sig.pushThumb(jolt, fwall, thumb);
      if (fwall - lastSampleAt >= ipc.SAMPLE_INTERVAL_MS) {
        lastSampleAt = fwall;
        ring.push({ at: fwall, cell: Math.round((frame / FPS) * 10), thumb: new Uint8ClampedArray(thumb) });
        while (ring.length && fwall - ring[0].at > ipc.BUFFER_MS) ring.shift();
      }
      const fired = sig.decideJolt(jolt, fwall, thumb, TH);
      if (fired) {
        ev({ type: 'jolt', reason: fired, gainDb: Math.round(gainAt(frame / FPS) * 10) / 10 });
        if (fired === 'color') {
          clearTimeout(switchDeferTimer);
          switchDwell.change();
        } else {
          void (async () => {
            const grid = await composite();
            if (!grid) return;
            const transcript = await tickTranscript();
            await sendTick('jolt', grid, { joltReason: fired, transcript });
          })();
        }
      }
      frame++;
    }
  }, 15);

  scheduleIdle();
  setTimeout(() => {
    void (async () => {
      const grid = await composite();
      if (grid) await sendTick('start', grid, { transcript: await tickTranscript() });
    })();
  }, ipc.START_LOOK_MS);

  for (const q of questions) {
    let held: any = null;
    setTimeout(() => {
      void composite().then((g) => {
        held = g;
        ev({ type: 'arm', text: q.text });
      });
    }, q.at * 1000);
    setTimeout(() => {
      void (async () => {
        let grid = held;
        if (!grid || Date.now() - grid.capturedAt > 30_000) grid = await composite();
        const transcript = await tickTranscript();
        await sendTick('user', grid, { text: q.text, transcript });
      })();
    }, q.at * 1000 + 2500);
  }

  await new Promise((r) => setTimeout(r, (meta.duration + 0.5) * 1000));
  stopped = true;
  clearInterval(frameLoop);
  clearTimeout(idleTimer);
  switchDwell.cancel();
  clearTimeout(switchDeferTimer);
  ev({ type: 'end', maxLagMs });
  // let in-flight turns finish (the video has ended; their lines still count)
  await new Promise((r) => setTimeout(r, 8000));
  writeFileSync(path.join(outDir, 'lines.json'), JSON.stringify(lines, null, 1));
  console.log = origLog;
  console.log(`run done: ${lines.length} lines, max frame lag ${maxLagMs}ms -> ${outDir}`);
  process.exit(0);
}

if (cmd === 'prep') {
  await prep(argv[1], argv[2]);
} else if (cmd === 'run') {
  if (!existsSync(argv[1])) throw new Error(`no prep dir ${argv[1]}`);
  await run(argv[1], argv[2]);
} else {
  console.log('usage: prep <video> <dir> | run <prepDir> <outDir> --model ... --persona sui.json');
}
