/**
 * 261030: the forced (apply:'now') restart popup carries the Windows-only
 * "takes about a minute" line; main waits FORCED_RESTART_DELAY_MS before
 * quitAndInstall, so it paints first.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipcClient', () => ({ sei: {} }));

const { UpdatePopup } = await import('./UpdatePopup');

const WIN_NOTE = 'Updating takes about a minute on Windows. Sei reopens by itself.';

describe('UpdatePopup forced restart', () => {
  it('adds the Windows note on Windows', () => {
    const html = renderToStaticMarkup(<UpdatePopup state={{ kind: 'forced' }} platform="win32" />);
    expect(html).toContain('Applying the update');
    expect(html).toContain(WIN_NOTE);
  });

  it('leaves macOS unchanged', () => {
    const html = renderToStaticMarkup(<UpdatePopup state={{ kind: 'forced' }} platform="darwin" />);
    expect(html).toContain('Applying the update');
    expect(html).not.toContain(WIN_NOTE);
  });

  it('never shows the note on the other states', () => {
    const html = renderToStaticMarkup(
      <UpdatePopup state={{ kind: 'whats-new', version: '0.7.0', changelog: '- x' }} platform="win32" />,
    );
    expect(html).not.toContain(WIN_NOTE);
  });
});
