import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RoomPresetManifest } from '@shared/seilinkRoom';
import type { SeilinkPack } from '@shared/seilinkPack';
import { firstRoomState, MoveInSheetView } from './MoveInSheet';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));
vi.mock('../ModalShell', () => ({
  ModalShell: (p: { title: string; children: React.ReactNode }) => <div data-title={p.title}>{p.children}</div>,
  ModalFooter: (p: { children: React.ReactNode }) => <footer>{p.children}</footer>,
}));

const pack = (id: string): SeilinkPack =>
  ({ id, manifest: { id, slots: { rug: { z: 30, options: ['r'], optional: true }, bed: { z: 40, options: ['b'] } } } as unknown as RoomPresetManifest }) as unknown as SeilinkPack;

describe('firstRoomState (261106, first-link v3)', () => {
  it('starts her on the plain background in the cozy frame when it is there', () => {
    const r = firstRoomState([pack('forest'), pack('cozy')]);
    expect(r?.plain).toBe(true);
    expect(r?.state).toMatchObject({ preset: 'cozy', plain: true, items: [], slots: { rug: { id: null } } });
  });
  it('falls back to the first pack, and to nothing with no packs', () => {
    expect(firstRoomState([pack('forest')])?.state.preset).toBe('forest');
    expect(firstRoomState([])).toBeNull();
  });
});

describe('MoveInSheetView (261107: no open-at-login switch)', () => {
  it('does not ask about opening on login: that is the step after the guided room setup', () => {
    const html = renderToStaticMarkup(
      <MoveInSheetView name="Sui" otherName={null} firstRoom busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(html).not.toContain('role="switch"');
    expect(html).not.toMatch(/log ?in/i);
  });
});

describe('MoveInSheetView (261110: one short beta notice)', () => {
  it('shows one line with a Beta tag and no bullets', () => {
    const html = renderToStaticMarkup(
      <MoveInSheetView name="Sui" otherName={null} firstRoom busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(html).toContain('data-movein-notice="beta_v1"');
    expect(html).toContain('WorldLink is a beta feature that puts Sui in a virtual space on your desktop.');
    expect(html).not.toMatch(/<ul|<li/);
    expect(html).not.toContain('â€”');
  });
  it('still says who moves out on a swap', () => {
    const html = renderToStaticMarkup(
      <MoveInSheetView name="Sui" otherName="Lyra" firstRoom={false} busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(html).toContain('Lyra moves out first.');
  });
});

describe('MoveInSheetView (261118: custom-image line)', () => {
  const view = (extra: Partial<React.ComponentProps<typeof MoveInSheetView>>): string =>
    renderToStaticMarkup(<MoveInSheetView name="Aria" otherName={null} firstRoom busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} {...extra} />);

  it('shows one line for a custom uploaded picture, and Move in stays on', () => {
    const html = view({ customImage: true });
    expect(html).toContain('data-custom-image-notice="v1"');
    expect(html).toContain('Aria uses a custom image, which may not look as good here. Characters made in Sei work best.');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Move in</);
    expect(html).not.toMatch(/<ul|<li|â€”/);
    expect(html).not.toMatch(/friend/i);
  });

  it('is absent for a look made in Sei', () => {
    expect(view({ customImage: false })).not.toContain('data-custom-image-notice');
    expect(view({})).not.toContain('data-custom-image-notice');
  });

  it('gives way to the kept-out line when her look keeps her out', () => {
    const html = view({ customImage: true, lookBlocked: 'uploaded' });
    expect(html).toContain('data-look-blocked="uploaded"');
    expect(html).not.toContain('data-custom-image-notice');
  });
});




