/**
 * ContinueWithChatGPTButton (261104): the label follows the UI language like
 * the Google button, "ChatGPT" stays verbatim, English is OpenAI's wording.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_LANGUAGES } from '@shared/uiLanguage';

// Server rendering reads a zustand store's INITIAL state (getServerSnapshot),
// so the subscribed useT() would always say 'en' here. Route it through the
// bare t(), which reads the current language, to exercise the real lookup.
vi.mock('../lib/i18n', async (orig) => {
  const real = await orig<typeof import('../lib/i18n')>();
  return { ...real, useT: () => real.t };
});

const { useLangStore } = await import('../lib/i18n');
const { ContinueWithChatGPTButton } = await import('./ContinueWithChatGPTButton');

const label = (): string =>
  renderToStaticMarkup(<ContinueWithChatGPTButton />).match(/<span>([^<]*)<\/span>/)?.[1] ?? '';

describe('ContinueWithChatGPTButton label', () => {
  afterEach(() => useLangStore.getState().setLang('en'));

  it('reads "Continue with ChatGPT" in English', () => {
    expect(label()).toBe('Continue with ChatGPT');
  });

  it('is translated in every other UI language and keeps "ChatGPT" verbatim', () => {
    for (const lang of UI_LANGUAGES.filter((c) => c !== 'en')) {
      useLangStore.getState().setLang(lang);
      const text = label();
      expect(text, lang).not.toBe('Continue with ChatGPT');
      expect(text, lang).toContain('ChatGPT');
    }
  });
});
