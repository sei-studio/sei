/**
 * 261107: Settings > Appearance "Open on login" (OpenAtLoginRow.tsx). The
 * other place it is offered is the step after the guided room setup
 * (lib/seilink/loginStep.test.ts); the move-in sheet no longer has it.
 *
 * No DOM in this repo's vitest: Toggle is mocked to record its handler and
 * the views are rendered to static markup.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenAtLoginState } from '@shared/openAtLogin';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const h = vi.hoisted(() => ({
  toggle: null as null | { on: boolean; disabled?: boolean; onChange: (next: boolean) => void },
}));

vi.mock('../Toggle', () => ({
  Toggle: (props: { on: boolean; disabled?: boolean; onChange: (next: boolean) => void; 'aria-label': string }) => {
    h.toggle = { on: props.on, disabled: props.disabled, onChange: props.onChange };
    return <button type="button" role="switch" aria-checked={props.on} aria-label={props['aria-label']} />;
  },
}));
vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

const { OpenAtLoginRowView } = await import('./OpenAtLoginRow');
const { DICTIONARIES } = await import('../../lib/i18n');

const on: OpenAtLoginState = { supported: true, enabled: true, needsApproval: false, decided: true };
const off: OpenAtLoginState = { supported: true, enabled: false, needsApproval: false, decided: false };

const row = (p: Partial<React.ComponentProps<typeof OpenAtLoginRowView>> = {}): string =>
  renderToStaticMarkup(<OpenAtLoginRowView state={off} busy={false} failed={false} onToggle={() => {}} {...p} />);

beforeEach(() => {
  h.toggle = null;
});

describe('OpenAtLoginRowView (Settings)', () => {
  it('is not shown where it is not supported (dev, Linux, no WorldLink) or before main answers', () => {
    expect(row({ state: { supported: false, enabled: false, needsApproval: false, decided: false } })).toBe('');
    expect(row({ state: null })).toBe('');
    expect(h.toggle).toBeNull();
  });

  it('shows the label and the switch in its saved state', () => {
    const html = row({ state: on });
    expect(html).toContain('Open on login');
    expect(html).toContain('aria-label="Open on login"');
    expect(html).not.toContain('Open Sei when I log in');
    expect(h.toggle?.on).toBe(true);
    expect(html).not.toContain('role="status"');
  });

  it('flipping it calls onToggle; busy disables it', () => {
    const onToggle = vi.fn();
    row({ onToggle });
    h.toggle?.onChange(true);
    expect(onToggle).toHaveBeenCalledWith(true);
    row({ busy: true });
    expect(h.toggle?.disabled).toBe(true);
  });

  it('says where to allow it on macOS 13+, and when a change did not take', () => {
    expect(row({ state: { ...on, needsApproval: true } })).toContain('Allow Sei in System Settings, under General &gt; Login Items.');
    expect(row({ failed: true })).toContain('Could not change this setting. Try again.');
  });

  it('every line is translated in every UI language', () => {
    const keys = [
      'Open on login',
      '{name} comes back after a restart.',
      'Turn on',
      'About opening Sei at login',
      'Allow Sei in System Settings, under General > Login Items.',
      'Could not change this setting. Try again.',
    ];
    for (const [lang, dict] of Object.entries(DICTIONARIES)) {
      for (const k of keys) expect(dict[k], `${lang}: ${k}`).toBeTruthy();
      // The 261107 move-in sheet copy is gone with the switch.
      expect(dict['Open Sei when I log in'], lang).toBeUndefined();
      expect(dict['{name} comes back to your desktop after a restart.'], lang).toBeUndefined();
    }
  });
});
