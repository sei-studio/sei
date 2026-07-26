/**
 * languageAutoSwitch (260725) — the streak policy that turns per-utterance
 * Scribe detections into UserConfig.chat_language.
 *
 * Pins: a switch needs two consecutive confident detections of the same
 * supported language; short transcripts and low-confidence passes neither
 * advance nor reset the streak; unsupported/missing codes reset it; the
 * current language never triggers a write; ISO 639-3 codes map onto the
 * supported set; a failed config write is swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadConfig, mockUpdateConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));
vi.mock('../configStore', () => ({
  loadConfig: mockLoadConfig,
  updateConfig: mockUpdateConfig,
}));

import { noteDetectedLanguage, resetLanguageAutoSwitch } from './languageAutoSwitch';

function detection(languageCode: string, languageProbability = 0.95, text = 'una frase suficientemente larga') {
  return { text, languageCode, languageProbability };
}

beforeEach(() => {
  resetLanguageAutoSwitch();
  mockLoadConfig.mockReset();
  mockUpdateConfig.mockReset();
  mockLoadConfig.mockResolvedValue({ chat_language: 'en' });
  mockUpdateConfig.mockImplementation(async (mutate: (c: object) => object) =>
    mutate({ chat_language: 'en' }),
  );
});

describe('noteDetectedLanguage', () => {
  it('switches after two consecutive confident detections of a new language', async () => {
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const next = mockUpdateConfig.mock.calls[0][0]({ chat_language: 'en' });
    expect(next).toEqual({ chat_language: 'es' });
  });

  it('a single detection never switches', async () => {
    await noteDetectedLanguage(detection('fr'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('a different language between detections restarts the streak', async () => {
    await noteDetectedLanguage(detection('es'));
    await noteDetectedLanguage(detection('fr'));
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
  });

  it('an unsupported code resets the streak', async () => {
    await noteDetectedLanguage(detection('es'));
    await noteDetectedLanguage(detection('de'));
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('a missing code (proxy without detection) resets the streak', async () => {
    await noteDetectedLanguage(detection('es'));
    await noteDetectedLanguage({ text: 'plenty long enough' });
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('low-confidence passes never accumulate', async () => {
    await noteDetectedLanguage(detection('es', 0.5));
    await noteDetectedLanguage(detection('es', 0.5));
    await noteDetectedLanguage(detection('es', 0.5));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('a short transcript neither advances nor resets the streak', async () => {
    await noteDetectedLanguage(detection('es'));
    await noteDetectedLanguage(detection('en', 0.99, 'ok'));
    await noteDetectedLanguage(detection('es'));
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
  });

  it('detections of the current language never write', async () => {
    await noteDetectedLanguage(detection('en'));
    await noteDetectedLanguage(detection('en'));
    await noteDetectedLanguage(detection('en'));
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('maps ISO 639-3 codes (spa -> es) and treats absent probability as confident', async () => {
    await noteDetectedLanguage({ text: 'una frase suficientemente larga', languageCode: 'spa' });
    await noteDetectedLanguage({ text: 'una frase suficientemente larga', languageCode: 'spa' });
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const next = mockUpdateConfig.mock.calls[0][0]({ chat_language: 'en' });
    expect(next).toEqual({ chat_language: 'es' });
  });

  it('swallows a failed config write', async () => {
    mockUpdateConfig.mockRejectedValue(new Error('disk full'));
    await noteDetectedLanguage(detection('ja'));
    await expect(noteDetectedLanguage(detection('ja'))).resolves.toBeUndefined();
  });
});
