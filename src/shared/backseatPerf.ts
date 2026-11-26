/**
 * backseat_perf (261123): what a Backseat session costs the machine, by shape.
 *
 * Why: Backseat is the most used surface, and Windows players reported the
 * whole PC lagging or freezing while sharing (playing and talking without the
 * share was fine). Nothing measured it. Two samples per session, so the event
 * volume stays at two per share:
 *   'first_minute'  the first 60 s of capture (early health; most sessions
 *                   that lag do it from the start)
 *   'end'           the whole session, sent when capture stops
 * plus a 'start' marker that main uses only to take the CPU baseline (never
 * sent to analytics).
 *
 * The renderer reports what it knows (frame counters from the capture worker,
 * the settings it ran with); main adds CPU and memory from app.getAppMetrics()
 * for that renderer's process, the GPU process and all of Sei, measured as
 * CPU seconds over the window, so a busy machine shows as a high number and
 * not as a missing one. Numbers and closed enums only.
 */

export const BACKSEAT_PERF_EVENT = 'backseat_perf';

export type BackseatPerfPhase = 'start' | 'first_minute' | 'end';

/** Renderer-side numbers, validated (numbers clamped, enums closed). */
export interface BackseatPerfSample {
  phase: BackseatPerfPhase;
  /** Seconds the window covers. */
  window_s: number;
  /** Frames the source delivered / analysed / closed unanalysed, per minute. */
  source_frames_per_min: number;
  analysed_per_min: number;
  skipped_per_min: number;
  /** Grid samples encoded per minute (target 600 = 10 Hz), and samples
   *  skipped because the previous encode was still running. */
  samples_per_min: number;
  sample_busy_per_min: number;
  /** What the stream asked for and what the track reports it got. */
  stream_fps: number;
  track_fps: number | null;
  track_height: number | null;
  clip_that: boolean;
  clip_fps: number | null;
  /** How many clip recorders were running when sampled (0 when Clip That is off). */
  clip_recorders: number;
  audio_source: 'track' | 'tap' | 'none';
}

const PHASES = new Set<BackseatPerfPhase>(['start', 'first_minute', 'end']);
const AUDIO = new Set(['track', 'tap', 'none']);

function num(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.min(max, Math.round(v * 10) / 10);
}

export function sanitizeBackseatPerf(raw: unknown): BackseatPerfSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.phase !== 'string' || !PHASES.has(r.phase as BackseatPerfPhase)) return null;
  const n = (k: string, max = 1_000_000): number => num(r[k], max) ?? 0;
  return {
    phase: r.phase as BackseatPerfPhase,
    window_s: n('window_s', 86_400),
    source_frames_per_min: n('source_frames_per_min'),
    analysed_per_min: n('analysed_per_min'),
    skipped_per_min: n('skipped_per_min'),
    samples_per_min: n('samples_per_min'),
    sample_busy_per_min: n('sample_busy_per_min'),
    stream_fps: n('stream_fps', 1000),
    track_fps: num(r.track_fps, 1000),
    track_height: num(r.track_height, 10_000),
    clip_that: r.clip_that === true,
    clip_fps: r.clip_that === true ? num(r.clip_fps, 1000) : null,
    clip_recorders: n('clip_recorders', 4),
    audio_source: typeof r.audio_source === 'string' && AUDIO.has(r.audio_source) ? (r.audio_source as 'track') : 'none',
  };
}

/** One process sample as main reads it (CPU seconds since process start). */
export interface CpuSnapshot {
  at: number;
  rendererCpuS: number | null;
  gpuCpuS: number | null;
  totalCpuS: number | null;
  rendererMemMb: number | null;
  gpuMemMb: number | null;
  totalMemMb: number | null;
}

/**
 * CPU over a window as percent of ONE core (100 = one core busy), plus memory
 * at the end of it. `cores` rides along so percent-of-machine is derivable.
 */
export function cpuProps(from: CpuSnapshot | null, to: CpuSnapshot, cores: number): Record<string, number> {
  const out: Record<string, number> = { cores };
  const secs = from ? (to.at - from.at) / 1000 : 0;
  const pct = (a: number | null | undefined, b: number | null): number | null =>
    a == null || b == null || secs <= 0 ? null : Math.max(0, Math.round(((b - a) / secs) * 1000) / 10);
  const set = (k: string, v: number | null): void => {
    if (v !== null) out[k] = v;
  };
  set('renderer_cpu_pct', pct(from?.rendererCpuS, to.rendererCpuS));
  set('gpu_cpu_pct', pct(from?.gpuCpuS, to.gpuCpuS));
  set('sei_cpu_pct', pct(from?.totalCpuS, to.totalCpuS));
  set('renderer_mem_mb', to.rendererMemMb);
  set('gpu_mem_mb', to.gpuMemMb);
  set('sei_mem_mb', to.totalMemMb);
  return out;
}

/** The analytics props for a sample (the 'start' marker is never sent). */
export function backseatPerfProps(
  s: BackseatPerfSample,
  cpu: Record<string, number>,
): Record<string, string | number | boolean | null> {
  const { phase, ...rest } = s;
  return { phase, ...rest, ...cpu };
}
