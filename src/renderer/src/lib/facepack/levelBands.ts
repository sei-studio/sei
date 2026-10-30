/**
 * Level + two-band analysis of a playing clip (261028, facepack mouth
 * picker). Pure over the analyser's arrays so it is testable and shared by
 * the TTS level tap (avatarLevelTap) and the dev preview's talk test.
 */
import type { LevelSample } from './animation';

export const LOW_BAND_HZ: [number, number] = [200, 1000];
export const HIGH_BAND_HZ: [number, number] = [1500, 4500];

/** Same envelope as avatarLevelTap: sqrt(meanSquare * 20), clamped to 1. */
export function levelFromTimeDomain(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.min(1, Math.sqrt((sum / Math.max(1, data.length)) * 20));
}

/** Linear band powers from getFloatFrequencyData (dB per bin). */
export function bandsFromSpectrum(db: Float32Array, sampleRate: number, fftSize: number): { low: number; high: number } {
  const binHz = sampleRate / fftSize;
  const sumBand = ([lo, hi]: [number, number]): number => {
    let p = 0;
    const a = Math.max(0, Math.floor(lo / binHz));
    const b = Math.min(db.length - 1, Math.ceil(hi / binHz));
    for (let i = a; i <= b; i++) {
      const v = db[i];
      if (Number.isFinite(v)) p += Math.pow(10, v / 10);
    }
    return p;
  };
  return { low: sumBand(LOW_BAND_HZ), high: sumBand(HIGH_BAND_HZ) };
}

/** One sample off a live AnalyserNode (reuses the caller's buffers). */
export function sampleAnalyser(
  analyser: AnalyserNode,
  buf: { time: Float32Array; freq: Float32Array },
): LevelSample {
  analyser.getFloatTimeDomainData(buf.time as Float32Array<ArrayBuffer>);
  analyser.getFloatFrequencyData(buf.freq as Float32Array<ArrayBuffer>);
  const level = levelFromTimeDomain(buf.time);
  const { low, high } = bandsFromSpectrum(buf.freq, analyser.context.sampleRate, analyser.fftSize);
  return { level, low, high };
}
