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
    expect(html).not.toContain('—');
  });
  it('still says who moves out on a swap', () => {
    const html = renderToStaticMarkup(
      <MoveInSheetView name="Sui" otherName="Lyra" firstRoom={false} busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(html).toContain('Lyra moves out first.');
  });
});
