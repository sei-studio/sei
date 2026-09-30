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

const { FeedbackModal } = await import('./FeedbackModal');
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
