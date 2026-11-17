import { describe, expect, it } from 'vitest';
import {
  classifyInputHealth,
  inputCheckProps,
  looksVirtualInput,
  peakDbBucket,
  type DictationInputHealth,
} from './inputHealth';

const base: DictationInputHealth = {
  frames: 350,
  unmutedFrames: 350,
  zeroFrames: 0,
  peakRms: 0.08,
  speechOpens: 4,
  trackState: 'live',
  trackMuted: false,
  ctxState: 'running',
  sampleRate: 16000,
  trackLabel: 'Microphone (Realtek(R) Audio)',
};

describe('classifyInputHealth', () => {
  it('names why a call heard nothing', () => {
    expect(classifyInputHealth(base, 2)).toBe('heard');
    expect(classifyInputHealth({ ...base, frames: 0, unmutedFrames: 0 }, 0)).toBe('no_frames');
    expect(classifyInputHealth({ ...base, unmutedFrames: 0 }, 0)).toBe('muted');
    expect(classifyInputHealth({ ...base, zeroFrames: 349, peakRms: 0, speechOpens: 0 }, 0)).toBe('digital_silence');
    expect(classifyInputHealth({ ...base, peakRms: 0.004, speechOpens: 0 }, 0)).toBe('quiet');
    expect(classifyInputHealth(base, 0)).toBe('speech_no_utterance');
  });
});

describe('props', () => {
  it('buckets the level and never carries the label', () => {
    expect(peakDbBucket(0)).toBe(-100);
    expect(peakDbBucket(1)).toBe(0);
    expect(peakDbBucket(0.012)).toBe(-40);
    const p = inputCheckProps({
      health: { ...base, trackLabel: 'Microphone (Steam Streaming Microphone)' },
      utterances: 0,
      liveMs: 45_000,
      inputDevices: 3,
      cloudSttOff: null,
    });
    expect(p).toMatchObject({
      input_state: 'speech_no_utterance',
      live_s: 45,
      frames_per_s: 7.8,
      virtual_input: true,
      input_devices: 3,
      cloud_stt_off: 'none',
    });
    expect(JSON.stringify(p)).not.toMatch(/Steam/);
  });

  it('spots common virtual inputs', () => {
    expect(looksVirtualInput('CABLE Output (VB-Audio Virtual Cable)')).toBe(true);
    expect(looksVirtualInput('Voicemeeter Out B1')).toBe(true);
    expect(looksVirtualInput('Microphone (Realtek(R) Audio)')).toBe(false);
    expect(looksVirtualInput(undefined)).toBe(false);
  });
});
