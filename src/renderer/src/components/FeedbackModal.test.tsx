/**
 * 260926: a failed feedback send must not cost the player their text. The
 * draft outlives the modal (closing after an error used to drop it) and is
 * cleared only by a successful send.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { FeedbackModal, FeedbackSent } = await import('./FeedbackModal');
const { clearFeedbackDraft, getFeedbackDraft, setFeedbackDraft } = await import('../lib/feedbackDraft');
const { ZH } = await import('../lib/i18n/zh');

describe('feedback drafts', () => {
  it('stores, restores and clears per form', () => {
    setFeedbackDraft('a', 'hello');
    setFeedbackDraft('b', 'other');
    expect(getFeedbackDraft('a')).toBe('hello');
    clearFeedbackDraft('a');
    expect(getFeedbackDraft('a')).toBe('');
    expect(getFeedbackDraft('b')).toBe('other');
    setFeedbackDraft('b', '');
    expect(getFeedbackDraft('b')).toBe('');
  });

  it('a reopened FeedbackModal shows the unsent draft', () => {
    setFeedbackDraft('modal:Submit feedback', 'the chess bot froze');
    const html = renderToStaticMarkup(React.createElement(FeedbackModal, { onClose: () => undefined }));
    expect(html).toContain('the chess bot froze');
    clearFeedbackDraft('modal:Submit feedback');
  });

  it('the failure copy says the text is kept, in both languages', () => {
    const msg = 'Feedback could not be sent. Your message is still here. Check your connection and press Submit to try again.';
    expect(ZH[msg]).toBeTruthy();
    expect(msg).not.toContain('—');
    expect(ZH[msg]).not.toContain('—');
  });
});

describe('feedback sent confirmation', () => {
  const NOTE = 'In the meantime, Backseat already works with any game on your screen.';

  it('the suggest-a-game confirmation points at Backseat', () => {
    const html = renderToStaticMarkup(React.createElement(FeedbackSent, { onClose: () => undefined, note: NOTE }));
    expect(html).toContain('Thank you. We read all comments within 24 hrs.');
    expect(html).toContain(NOTE);
  });

  it('the plain feedback confirmation has no extra line', () => {
    const html = renderToStaticMarkup(React.createElement(FeedbackSent, { onClose: () => undefined }));
    expect(html).not.toContain('Backseat');
  });

  it('the Backseat line has Chinese copy and no dashes', () => {
    expect(ZH[NOTE]).toBeTruthy();
    expect(NOTE).not.toMatch(/[—–]/);
    expect(ZH[NOTE]).not.toMatch(/[—–]/);
  });
});

// 261109 (T379): "roblox" kept arriving as a game suggestion. The suggest
// form says when the typed game already works, with a button into it.
describe('suggest-a-game "already works" hint', () => {
  const SUGGEST = 'modal:Suggest a game';
  const render = (text: string, withHint = true): string => {
    setFeedbackDraft(SUGGEST, text);
    const html = renderToStaticMarkup(
      React.createElement(FeedbackModal, {
        onClose: () => undefined,
        title: 'Suggest a game',
        form: 'suggest_game',
        ...(withHint ? { onKnownGame: () => undefined } : {}),
      }),
    );
    clearFeedbackDraft(SUGGEST);
    return html;
  };

  it('names the game and offers to play it, and submit stays on', () => {
    const html = render('Roblox Forsaken');
    expect(html).toContain('Roblox already works in Sei');
    expect(html).toContain('Play Roblox');
    expect(html).toMatch(/<button[^>]*type="submit"(?![^>]*disabled)/);
  });

  it('says nothing for a game we do not have, or without the opener', () => {
    expect(render('Rainbow six seige')).not.toContain('already works');
    expect(render('roblox', false)).not.toContain('already works');
  });

  it('is translated, with no em dash', () => {
    const k = '{game} already works in Sei';
    expect(ZH[k]).toContain('{game}');
    expect(ZH[k]).not.toContain('—');
  });
});

