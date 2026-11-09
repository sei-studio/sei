import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiveCardView } from './LiveCard';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));
vi.mock('../ModalShell', () => ({
  ModalShell: (p: { title: string; children: React.ReactNode }) => <div data-title={p.title}>{p.children}</div>,
  ModalFooter: (p: { children: React.ReactNode }) => <footer>{p.children}</footer>,
}));

const noop = (): void => undefined;

describe('LiveCardView (261110)', () => {
  it('says where she lives, the Windows shortcut and what clicks do, with Minimize', () => {
    const html = renderToStaticMarkup(<LiveCardView name="Sui" os="windows" placement="stage" onMinimize={noop} onDismiss={noop} />);
    expect(html).toContain('Sui lives on your desktop now');
    expect(html).toContain('Win+D');
    expect(html).toContain('Click Sui to open your chat. Double-click for a quick reply.');
    expect(html).toContain('Minimize other windows');
    expect(html).toContain('Got it');
    expect(html).toContain('data-live-card="stage"');
    expect(html).not.toMatch(/<li|<ul/);
  });

  it('on a Mac: F11 (fn+F11 on a laptop) and Hide other apps', () => {
    const html = renderToStaticMarkup(<LiveCardView name="Sui" os="mac" placement="app" onMinimize={noop} onDismiss={noop} />);
    expect(html).toContain('F11');
    expect(html).toContain('fn+F11');
    expect(html).toContain('Hide other apps');
    expect(html).not.toContain('Win+D');
    expect(html).toContain('data-title="Sui lives on your desktop now"');
  });

  it('without a minimize action, only Got it', () => {
    const html = renderToStaticMarkup(<LiveCardView name="Sui" os="linux" placement="stage" onDismiss={noop} />);
    expect(html).not.toContain('Minimize other windows');
    expect(html).toContain('Got it');
  });
});
