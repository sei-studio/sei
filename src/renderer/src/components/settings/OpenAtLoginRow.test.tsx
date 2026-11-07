/**
 * 261107: Settings > Appearance "Open Sei when I log in" (OpenAtLoginRow.tsx)
 * and the same switch on the WorldLink move-in sheet (MoveInSheet.tsx).
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
vi.mock('../ModalShell', () => ({
  ModalShell: (p: { title: string; children: React.ReactNode }) => (
    <div data-title={p.title}>{p.children}</div>
  ),
  ModalFooter: (p: { children: React.ReactNode }) => <footer>{p.children}</footer>,
}));
vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

const { OpenAtLoginRowView } = await import('./OpenAtLoginRow');
const { MoveInSheetView, loginChangeOnMoveIn } = await import('../seilink/MoveInSheet');
const { DICTIONARIES } = await import('../../lib/i18n');

const on: OpenAtLoginState = { supported: true, enabled: true, needsApproval: false };
const off: OpenAtLoginState = { supported: true, enabled: false, needsApproval: false };

const row = (p: Partial<React.ComponentProps<typeof OpenAtLoginRowView>> = {}): string =>
  renderToStaticMarkup(<OpenAtLoginRowView state={off} busy={false} failed={false} onToggle={() => {}} {...p} />);

beforeEach(() => {
  h.toggle = null;
});

describe('OpenAtLoginRowView (Settings)', () => {
  it('is not shown where it is not supported (dev, Linux, no WorldLink) or before main answers', () => {
    expect(row({ state: { supported: false, enabled: false, needsApproval: false } })).toBe('');
    expect(row({ state: null })).toBe('');
    expect(h.toggle).toBeNull();
  });

  it('shows the label and the switch in its saved state', () => {
    const html = row({ state: on });
    expect(html).toContain('Open Sei when I log in');
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
      'Open Sei when I log in',
      '{name} comes back to your desktop after a restart.',
      'About opening Sei at login',
      'Allow Sei in System Settings, under General > Login Items.',
      'Could not change this setting. Try again.',
    ];
    for (const [lang, dict] of Object.entries(DICTIONARIES)) {
      for (const k of keys) expect(dict[k], `${lang}: ${k}`).toBeTruthy();
    }
  });
});

describe('MoveInSheetView open-at-login row', () => {
  const sheet = (openAtLogin: React.ComponentProps<typeof MoveInSheetView>['openAtLogin'], busy = false): string =>
    renderToStaticMarkup(
      <MoveInSheetView
        name="Sui"
        otherName={null}
        firstRoom
        busy={busy}
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
        openAtLogin={openAtLogin}
      />,
    );

  it('is absent where it is not supported', () => {
    expect(sheet(null)).not.toContain('Open Sei when I log in');
    expect(h.toggle).toBeNull();
  });

  it('starts off and names her in the sub-line', () => {
    const onChange = vi.fn();
    const html = sheet({ on: false, onChange });
    expect(html).toContain('Open Sei when I log in');
    expect(html).toContain('Sui comes back to your desktop after a restart.');
    expect(h.toggle?.on).toBe(false);
    h.toggle?.onChange(true);
    expect(onChange).toHaveBeenCalledWith(true);
    sheet({ on: true, onChange }, true);
    expect(h.toggle?.disabled).toBe(true);
  });

  it('Move in applies the switch only when the user changed it', () => {
    expect(loginChangeOnMoveIn(null)).toBeNull();
    expect(loginChangeOnMoveIn({ saved: false, want: false })).toBeNull();
    expect(loginChangeOnMoveIn({ saved: true, want: true })).toBeNull();
    expect(loginChangeOnMoveIn({ saved: false, want: true })).toBe(true);
    expect(loginChangeOnMoveIn({ saved: true, want: false })).toBe(false);
  });
});
