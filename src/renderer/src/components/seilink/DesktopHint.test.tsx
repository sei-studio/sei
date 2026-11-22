import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopHintView } from './DesktopHint';
import { sanitizeSeilinkSetupTrack, SEILINK_DESKTOP_HINT_EVENT, isSeilinkSetupEvent } from '@shared/seilinkSetupTelemetry';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

describe('DesktopHintView (product call (261116))', () => {
  it('one line and Hide windows, no bullets', () => {
    const html = renderToStaticMarkup(<DesktopHintView leaving={false} busy={false} onHide={() => undefined} />);
    expect(html).toContain('Your desktop was updated.');
    expect(html).toContain('Hide windows');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/<li|<ul/);
  });
  it('no Hide windows where there is nothing to hide (Linux)', () => {
    expect(renderToStaticMarkup(<DesktopHintView leaving={false} busy={false} />)).not.toContain('Hide windows');
  });
  it('its analytics keep the closed shape', () => {
    expect(isSeilinkSetupEvent(SEILINK_DESKTOP_HINT_EVENT)).toBe(true);
    expect(sanitizeSeilinkSetupTrack(SEILINK_DESKTOP_HINT_EVENT, { action: 'hide_windows', kind: 'updated', os: 'mac', text: 'x' })).toEqual({
      character_id: null,
      action: 'hide_windows',
      kind: 'updated',
      os: 'mac',
    });
    expect(sanitizeSeilinkSetupTrack(SEILINK_DESKTOP_HINT_EVENT, { action: 'nope', kind: 'nope' })).toMatchObject({ action: 'shown', kind: 'opened' });
  });
});




