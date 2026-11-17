/**
 * The voice_call_ended "was the player heard" props (261118): the IPC schema
 * main parses the renderer's report with, and the props it sends.
 */
import { describe, expect, it } from 'vitest';
import { CallHearingSchema, callHearingProps, type CallHearing } from './callHearing';

const H: CallHearing = { player_utterances: 3, stt_requests: 5, input_peak_heard: true, stt_path: 'byok' };

describe('CallHearingSchema', () => {
  it('accepts the four fields on every path', () => {
    for (const stt_path of ['cloud', 'byok', 'local'] as const) {
      expect(CallHearingSchema.parse({ ...H, stt_path })).toEqual({ ...H, stt_path });
    }
  });

  it('drops anything else, so no transcript text or device label can ride along', () => {
    const parsed = CallHearingSchema.parse({ ...H, text: 'hello there', device_label: "Ana's AirPods" });
    expect(Object.keys(parsed).sort()).toEqual(['input_peak_heard', 'player_utterances', 'stt_path', 'stt_requests']);
  });

  it('rejects an unknown path and negative or fractional counts', () => {
    expect(() => CallHearingSchema.parse({ ...H, stt_path: 'openai' })).toThrow();
    expect(() => CallHearingSchema.parse({ ...H, player_utterances: -1 })).toThrow();
    expect(() => CallHearingSchema.parse({ ...H, stt_requests: 1.5 })).toThrow();
  });
});

describe('callHearingProps', () => {
  it('passes the four props through flat', () => {
    expect(callHearingProps(H)).toEqual({
      player_utterances: 3,
      stt_requests: 5,
      input_peak_heard: true,
      stt_path: 'byok',
    });
  });

  it('a call main closed itself has no report and sends no props (not zeros)', () => {
    expect(callHearingProps(undefined)).toEqual({});
  });
});
