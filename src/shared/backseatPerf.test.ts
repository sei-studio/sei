import { describe, expect, it } from 'vitest';
import { backseatPerfProps, cpuProps, sanitizeBackseatPerf, type CpuSnapshot } from './backseatPerf';

describe('sanitizeBackseatPerf', () => {
  it('keeps numbers and closed enums, drops everything else', () => {
    const s = sanitizeBackseatPerf({
      phase: 'end',
      window_s: 600,
      analysed_per_min: 1800,
      samples_per_min: 600,
      stream_fps: 30,
      track_fps: 30,
      track_height: 720,
      clip_that: false,
      clip_fps: 60,
      audio_source: 'track',
      window_title: 'Some private window',
    });
    expect(s).toMatchObject({ phase: 'end', analysed_per_min: 1800, clip_that: false, clip_fps: null, audio_source: 'track' });
    expect(s).not.toHaveProperty('window_title');
  });

  it('rejects an unknown phase and clamps bad numbers', () => {
    expect(sanitizeBackseatPerf({ phase: 'later' })).toBeNull();
    expect(sanitizeBackseatPerf(null)).toBeNull();
    const s = sanitizeBackseatPerf({ phase: 'first_minute', analysed_per_min: -5, stream_fps: 1e9, audio_source: 'mic' })!;
    expect(s.analysed_per_min).toBe(0);
    expect(s.stream_fps).toBe(1000);
    expect(s.audio_source).toBe('none');
  });
});

describe('cpuProps', () => {
  const snap = (at: number, r: number, g: number, t: number): CpuSnapshot => ({
    at,
    rendererCpuS: r,
    gpuCpuS: g,
    totalCpuS: t,
    rendererMemMb: 300,
    gpuMemMb: 200,
    totalMemMb: 900,
  });
  it('is CPU seconds over wall seconds, as percent of one core', () => {
    const p = cpuProps(snap(0, 10, 5, 30), snap(60_000, 40, 11, 120), 8);
    expect(p).toMatchObject({ cores: 8, renderer_cpu_pct: 50, gpu_cpu_pct: 10, sei_cpu_pct: 150, renderer_mem_mb: 300 });
  });
  it('without a baseline only memory is reported', () => {
    const p = cpuProps(null, snap(60_000, 40, 11, 120), 4);
    expect(p).not.toHaveProperty('renderer_cpu_pct');
    expect(p.sei_mem_mb).toBe(900);
  });
  it('merges into the event props with the phase first', () => {
    const s = sanitizeBackseatPerf({ phase: 'end' })!;
    expect(backseatPerfProps(s, { cores: 4 })).toMatchObject({ phase: 'end', cores: 4, clip_that: false });
  });
});
