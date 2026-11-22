/**
 * The call_setup_failed sub-reason (261023). These props are the only way to
 * tell a refused mic from a busy one from a speech model that never loaded,
 * and they leave the machine, so the tests pin both the mapping and the
 * guarantee that no free text gets through.
 */

import { describe, it, expect } from 'vitest';
import { callSetupFailureProps, tagCallSetupStage, taggedStage } from './callSetupFailure';

/** A getUserMedia-style failure: a DOMException-like with a name. */
function domErr(name: string, message = ''): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('callSetupFailureProps', () => {
  it('splits getUserMedia failures into a refusal and everything else', () => {
    const tag = (e: Error) => callSetupFailureProps(tagCallSetupStage(e, 'mic_capture'));
    expect(tag(domErr('NotAllowedError', 'Permission denied by system'))).toEqual({
      stage: 'mic_permission',
      error_name: 'NotAllowedError',
    });
    expect(tag(domErr('SecurityError'))).toEqual({ stage: 'mic_permission', error_name: 'SecurityError' });
    expect(tag(domErr('NotReadableError', 'Could not start audio source'))).toEqual({
      stage: 'mic_capture',
      error_name: 'NotReadableError',
    });
    expect(tag(domErr('NotFoundError', 'Requested device not found'))).toEqual({
      stage: 'mic_capture',
      error_name: 'NotFoundError',
    });
    expect(tag(domErr('AbortError'))).toEqual({ stage: 'mic_capture', error_name: 'AbortError' });
  });

  it('treats a permission message as a refusal even with an odd name, like the mic card does', () => {
    expect(callSetupFailureProps(tagCallSetupStage(domErr('Error', 'Permission dismissed'), 'mic_capture'))).toEqual({
      stage: 'mic_permission',
      error_name: 'Error',
    });
  });

  it('keeps the stage the pipeline tagged for the speech model and the audio graph', () => {
    expect(callSetupFailureProps(tagCallSetupStage(domErr('TimeoutError', 'took too long'), 'stt_boot'))).toEqual({
      stage: 'stt_boot',
      error_name: 'TimeoutError',
    });
    expect(callSetupFailureProps(tagCallSetupStage(domErr('ModelLoadError', 'fetch failed'), 'stt_boot'))).toEqual({
      stage: 'stt_boot',
      error_name: 'ModelLoadError',
    });
    expect(callSetupFailureProps(tagCallSetupStage(domErr('NotSupportedError'), 'audio_graph'))).toEqual({
      stage: 'audio_graph',
      error_name: 'NotSupportedError',
    });
  });

  it('never reports a refusal as stt_boot just because the message mentions permission', () => {
    // Only a mic_capture tag is re-read as a refusal; a model error whose text
    // happens to say "permission" stays the model's.
    expect(
      callSetupFailureProps(tagCallSetupStage(domErr('ModelLoadError', 'permission denied on cache'), 'stt_boot')),
    ).toEqual({ stage: 'stt_boot', error_name: 'ModelLoadError' });
  });

  it('classifies untagged errors by the voice sentinels, then by name', () => {
    expect(callSetupFailureProps(new Error('VOICE_NO_SESSION'))).toEqual({ stage: 'proxy_session', error_name: 'Error' });
    expect(callSetupFailureProps(new Error('VOICE_NO_CREDITS: 402'))).toEqual({
      stage: 'proxy_session',
      error_name: 'Error',
    });
    expect(callSetupFailureProps(new Error('VOICE_ELEVEN_KEY_INVALID'))).toEqual({
      stage: 'tts_or_voice_connect',
      error_name: 'Error',
    });
    expect(callSetupFailureProps(domErr('NotAllowedError'))).toEqual({
      stage: 'mic_permission',
      error_name: 'NotAllowedError',
    });
    expect(callSetupFailureProps(domErr('NotReadableError'))).toEqual({
      stage: 'mic_capture',
      error_name: 'NotReadableError',
    });
    expect(callSetupFailureProps(new TypeError('x is undefined'))).toEqual({ stage: 'other', error_name: 'TypeError' });
  });

  it('sends no free text: unknown names, messages and non-errors collapse to fixed tokens', () => {
    const odd = domErr('C:\\Users\\alice\\mic driver failed');
    const props = callSetupFailureProps(tagCallSetupStage(odd, 'mic_capture'));
    expect(props).toEqual({ stage: 'mic_capture', error_name: 'other' });
    expect(JSON.stringify(props)).not.toMatch(/alice|driver/);
    expect(callSetupFailureProps('boom')).toEqual({ stage: 'other', error_name: 'other' });
    expect(callSetupFailureProps(null)).toEqual({ stage: 'other', error_name: 'other' });
    expect(callSetupFailureProps(undefined)).toEqual({ stage: 'other', error_name: 'other' });
    expect(Object.keys(callSetupFailureProps(new Error('anything'))).sort()).toEqual(['error_name', 'stage']);
  });
});

describe('tagCallSetupStage', () => {
  it('keeps the original error, so its name and message still drive the copy and the mic card', () => {
    const e = domErr('NotAllowedError', 'Permission denied');
    const tagged = tagCallSetupStage(e, 'mic_capture');
    expect(tagged).toBe(e);
    expect((tagged as Error).name).toBe('NotAllowedError');
    expect((tagged as Error).message).toBe('Permission denied');
    // Non-enumerable: nothing changes for code that spreads or serializes it.
    expect(Object.keys(e)).not.toContain('__seiCallSetupStage');
  });

  it('first tag wins, so an outer catch cannot overwrite the inner stage', () => {
    const e = tagCallSetupStage(domErr('TimeoutError'), 'stt_boot');
    tagCallSetupStage(e, 'other');
    expect(taggedStage(e)).toBe('stt_boot');
  });

  it('wraps a thrown non-object', () => {
    const tagged = tagCallSetupStage('nope', 'audio_graph');
    expect(tagged).toBeInstanceOf(Error);
    expect(taggedStage(tagged)).toBe('audio_graph');
  });

  it('works on a real DOMException', () => {
    const e = new DOMException('Could not start audio source', 'NotReadableError');
    expect(callSetupFailureProps(tagCallSetupStage(e, 'mic_capture'))).toEqual({
      stage: 'mic_capture',
      error_name: 'NotReadableError',
    });
  });
});




