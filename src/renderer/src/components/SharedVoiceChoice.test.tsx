/**
 * SharedVoiceChoice / SharedVoiceLabel (261019): first-render markup (SSR,
 * as in ChatgptPlanSettings.test.tsx). Effects do not run under SSR, so this
 * is the state before the pool and the close match load: the line is shown,
 * the default option is unnamed, and nothing can play yet.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipcClient', () => ({ sei: { platform: 'darwin' } }));

const { SharedVoiceChoice, SharedVoiceLabel } = await import('./SharedVoiceChoice');

describe('SharedVoiceChoice', () => {
  it('shows the one line, a default option, and a sample button', () => {
    const html = renderToStaticMarkup(
      React.createElement(SharedVoiceChoice, {
        characterId: '44444444-4444-4444-8444-444444444444',
        value: null,
        onChange: () => {},
      }),
    );
    expect(html).toContain('Your voice is from your ElevenLabs account, so others can&#x27;t play it. Others will hear:');
    expect(html).toContain('aria-label="Voice others will hear"');
    expect(html).toContain('<option value="" selected="">Closest Sei voice</option>');
    expect(html).toContain('aria-label="Play Sei voice sample"');
    // nothing to play until the close match is known
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});

describe('SharedVoiceLabel', () => {
  it('names the fallback and offers Change only when editable', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const editable = renderToStaticMarkup(React.createElement(SharedVoiceLabel, { characterId: id, value: null, onChange: () => {} }));
    expect(editable).toContain('Voice for others: a Sei voice');
    expect(editable).toContain('>Change</button>');
    const readOnly = renderToStaticMarkup(React.createElement(SharedVoiceLabel, { characterId: id, value: null }));
    expect(readOnly).not.toContain('Change');
  });
});




