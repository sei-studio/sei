/**
 * voice_tts_failed (261121, T507): error classes and the throttled capture.
 * Shape only: phase, provider, error_class; never text or a raw message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDiag } = vi.hoisted(() => ({ mockDiag: vi.fn() }));
vi.mock('../lazyAnalytics', () => ({
  loadAnalytics: async () => ({ captureDiagnosticThrottled: mockDiag }),
}));

import { reportTtsFailure, ttsFailureClass } from './ttsFailure';

function fetchFailed(code: string): Error {
  // What openTtsStream throws: the undici message, wrapped in our sentinel.
  return Object.assign(new Error('VOICE_TTS_FAILED: fetch failed'), { cause: { code } });
}

describe('ttsFailureClass', () => {
  it('maps our sentinels to stable tokens', () => {
    expect(ttsFailureClass(new Error('VOICE_NO_CREDITS: playtime balance exhausted'), false)).toBe('no_credits');
    expect(ttsFailureClass(new Error('VOICE_RATE_LIMITED: daily usage cap reached'), false)).toBe('rate_limited');
    expect(ttsFailureClass(new Error('VOICE_NO_SESSION: sign in'), false)).toBe('no_session');
    expect(ttsFailureClass(new Error('VOICE_NOT_CONFIGURED: voice service unavailable'), false)).toBe('not_configured');
    expect(ttsFailureClass(new Error('VOICE_PACK_MISSING:tts-en'), false)).toBe('pack_missing');
    expect(ttsFailureClass(new Error('SPEECH_RUNTIME_FAILED: no binding'), false)).toBe('speech_runtime');
  });

  it('reads an upstream status out of VOICE_TTS_FAILED', () => {
    expect(ttsFailureClass(new Error('VOICE_TTS_FAILED: status 502'), false)).toBe('server_error');
    expect(ttsFailureClass(new Error('VOICE_TTS_FAILED: status 404'), false)).toBe('http_4xx');
    expect(ttsFailureClass(new Error('VOICE_TTS_FAILED: status 401'), false)).toBe('auth');
  });

  it('classifies transport failures', () => {
    expect(ttsFailureClass(new Error('VOICE_TTS_FAILED: fetch failed'), false)).toBe('network');
    expect(ttsFailureClass(fetchFailed('ECONNRESET'), false)).toBe('network');
  });

  it('an abort is the connect deadline before a body and the stall watchdog inside one', () => {
    const abort = new Error('VOICE_TTS_FAILED: This operation was aborted');
    expect(ttsFailureClass(abort, false)).toBe('timeout');
    expect(ttsFailureClass(new Error('This operation was aborted'), true)).toBe('stall');
  });

  it('a companion with no voice is not a failure', () => {
    expect(ttsFailureClass(new Error('VOICE_DISABLED: this companion has no voice'), false)).toBeNull();
  });
});

describe('reportTtsFailure', () => {
  beforeEach(() => mockDiag.mockReset());

  it('captures shape only, throttled per phase + provider + class', async () => {
    reportTtsFailure('pre_audio', 'sei_cloud', new Error('VOICE_TTS_FAILED: fetch failed: secret line text'));
    await vi.waitFor(() => expect(mockDiag).toHaveBeenCalledTimes(1));
    const [event, key, props, windowMs] = mockDiag.mock.calls[0];
    expect(event).toBe('voice_tts_failed');
    expect(key).toBe('pre_audio|sei_cloud|network');
    expect(props).toEqual({ phase: 'pre_audio', provider: 'sei_cloud', error_class: 'network' });
    expect(windowMs).toBeGreaterThan(0);
    expect(JSON.stringify(props)).not.toContain('secret');
  });

  it('sends nothing for a companion with no voice', async () => {
    reportTtsFailure('clip', 'sei_cloud', new Error('VOICE_DISABLED: this companion has no voice'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockDiag).not.toHaveBeenCalled();
  });
});




