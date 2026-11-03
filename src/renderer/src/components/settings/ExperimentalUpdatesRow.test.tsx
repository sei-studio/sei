/**
 * 261103: Settings → About "Experimental updates" (config key
 * advanced_updates). Turning it ON opens an inline confirm and saves only on
 * Continue; Cancel saves nothing; turning it OFF saves at once.
 *
 * No DOM in this repo's vitest, so the row is driven the way a click would:
 * Toggle and Button are mocked to record their handlers, the recorded
 * handler is invoked, and the view is re-rendered with the state the real
 * component's useState would hold.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const h = vi.hoisted(() => ({
  toggle: null as null | { on: boolean; onChange: (next: boolean) => void },
  buttons: [] as { label: string; kind?: string; onClick?: () => void }[],
}));

vi.mock('../Toggle', () => ({
  Toggle: (props: { on: boolean; onChange: (next: boolean) => void; 'aria-label': string }) => {
    h.toggle = { on: props.on, onChange: props.onChange };
    return <button type="button" role="switch" aria-checked={props.on} aria-label={props['aria-label']} />;
  },
}));

vi.mock('../Button', () => ({
  Button: (props: { children: React.ReactNode; kind?: string; onClick?: () => void }) => {
    h.buttons.push({ label: renderToStaticMarkup(<>{props.children}</>), kind: props.kind, onClick: props.onClick });
    return <button type="button">{props.children}</button>;
  },
}));

const { ExperimentalUpdatesRowView, experimentalUpdatesHandlers } = await import('./ExperimentalUpdatesRow');
const { ZH } = await import('../../lib/i18n/zh');

const CONFIRM = "You'll get new features early, but they can be buggy. Continue?";
/** As renderToStaticMarkup escapes it. */
const CONFIRM_HTML = CONFIRM.replace("'", '&#x27;');

/** The row with its confirm state held here, as the real component's useState would. */
function harness(on: boolean) {
  const state = { on, confirming: false };
  const onSave = vi.fn((next: boolean) => {
    state.on = next;
  });
  const handlers = experimentalUpdatesHandlers((v) => {
    state.confirming = v;
  }, onSave);
  const render = (): string => {
    h.toggle = null;
    h.buttons = [];
    return renderToStaticMarkup(<ExperimentalUpdatesRowView on={state.on} confirming={state.confirming} {...handlers} />);
  };
  const click = (label: string): void => {
    const b = h.buttons.find((x) => x.label === label);
    if (!b?.onClick) throw new Error(`no ${label} button`);
    b.onClick();
  };
  const flip = (): void => {
    if (!h.toggle) throw new Error('no toggle');
    h.toggle.onChange(!h.toggle.on); // what Toggle does on click
  };
  return { state, onSave, render, click, flip };
}

beforeEach(() => {
  h.toggle = null;
  h.buttons = [];
});

describe('ExperimentalUpdatesRow', () => {
  it('shows the Experimental updates label and no confirm at rest', () => {
    const r = harness(false);
    const html = r.render();
    expect(html).toContain('Experimental updates');
    expect(html).not.toContain('Advanced updates');
    expect(html).not.toContain(CONFIRM_HTML);
    expect(h.buttons).toHaveLength(0);
  });

  it('turning it on shows the inline confirm and does not save', () => {
    const r = harness(false);
    r.render();
    r.flip();
    expect(r.onSave).not.toHaveBeenCalled();
    const html = r.render();
    expect(html).toContain(CONFIRM_HTML);
    expect(h.toggle?.on).toBe(false);
    expect(h.buttons.map((b) => [b.label, b.kind])).toEqual([
      ['Cancel', 'secondary'],
      ['Continue', 'primary'],
    ]);
  });

  it('Continue saves on and closes the confirm', () => {
    const r = harness(false);
    r.render();
    r.flip();
    r.render();
    r.click('Continue');
    expect(r.onSave).toHaveBeenCalledTimes(1);
    expect(r.onSave).toHaveBeenCalledWith(true);
    const html = r.render();
    expect(html).not.toContain(CONFIRM_HTML);
    expect(h.toggle?.on).toBe(true);
  });

  it('Cancel saves nothing and leaves the toggle off', () => {
    const r = harness(false);
    r.render();
    r.flip();
    r.render();
    r.click('Cancel');
    expect(r.onSave).not.toHaveBeenCalled();
    const html = r.render();
    expect(html).not.toContain(CONFIRM_HTML);
    expect(h.toggle?.on).toBe(false);
  });

  it('turning it off saves at once, with no confirm', () => {
    const r = harness(true);
    r.render();
    r.flip();
    expect(r.onSave).toHaveBeenCalledTimes(1);
    expect(r.onSave).toHaveBeenCalledWith(false);
    const html = r.render();
    expect(html).not.toContain(CONFIRM_HTML);
    expect(h.toggle?.on).toBe(false);
  });

  it('has zh translations for every new string, and no em dash in the copy', () => {
    const copy = [
      'Experimental updates',
      'About experimental updates',
      'Try new features early. These builds can be buggy, and not every experimental feature makes it into the stable version.',
      CONFIRM,
      'Cancel',
      'Continue',
    ];
    for (const en of copy) {
      expect(ZH[en], en).toBeTruthy();
      expect(en).not.toContain('—');
      expect(ZH[en]).not.toContain('—');
    }
  });
});
