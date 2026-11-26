/**
 * 261123: Settings "Clip That" (ClipThatRow.tsx). Off by default; the frame
 * rate row only shows while it is on. No DOM in this repo's vitest: rendered
 * to static markup, Toggle and Seg mocked to record their handlers.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const h = vi.hoisted(() => ({
  toggle: null as null | ((next: boolean) => void),
  seg: null as null | ((next: string) => void),
}));

vi.mock('../Toggle', () => ({
  Toggle: (props: { on: boolean; onChange: (next: boolean) => void; 'aria-label': string }) => {
    h.toggle = props.onChange;
    return <button type="button" role="switch" aria-checked={props.on} aria-label={props['aria-label']} />;
  },
}));
vi.mock('../Seg', () => ({
  Seg: (props: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) => {
    h.seg = props.onChange;
    return (
      <div data-seg={props.value}>
        {props.options.map((o) => (
          <span key={o.value}>{o.label}</span>
        ))}
      </div>
    );
  },
}));
vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

const { ClipThatRow, CLIP_THAT_TIP } = await import('./ClipThatRow');
const { DICTIONARIES } = await import('../../lib/i18n');

describe('ClipThatRow', () => {
  it('off: the toggle and its tip, no frame rate row', () => {
    const html = renderToStaticMarkup(<ClipThatRow on={false} fps={30} onToggle={() => {}} onFps={() => {}} />);
    expect(html).toContain('Clip That');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('Clip frame rate');
    expect(html).not.toContain('fps');
  });

  it('on: 30, 60 and 120 fps, the current one selected, and the handlers wired', () => {
    let toggled: boolean | null = null;
    let picked: number | null = null;
    const html = renderToStaticMarkup(
      <ClipThatRow on fps={60} onToggle={(v) => (toggled = v)} onFps={(v) => (picked = v)} />,
    );
    expect(html).toContain('Clip frame rate');
    for (const n of [30, 60, 120]) expect(html).toContain(`${n} fps`);
    expect(html).toContain('data-seg="60"');
    h.toggle?.(false);
    h.seg?.('120');
    expect(toggled).toBe(false);
    expect(picked).toBe(120);
  });

  it('the tip is one or two plain lines and every language has it', () => {
    expect(CLIP_THAT_TIP).not.toMatch(/[—•]/);
    expect(CLIP_THAT_TIP.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
    for (const [lang, dict] of Object.entries(DICTIONARIES)) {
      if (!dict) continue;
      const d = dict as Record<string, string>;
      expect(d[CLIP_THAT_TIP], lang).toBeTruthy();
      expect(d['Clip That'], lang).toBe('Clip That');
    }
  });
});
