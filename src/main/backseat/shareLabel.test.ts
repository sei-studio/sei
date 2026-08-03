/**
 * The share label (260804), against a stubbed desktopCapturer.
 *
 * Worth testing rather than eyeballing because the two cases resolve
 * differently — a window share matches by id, a screen share takes the front of
 * the list — and because the "skip our own windows" rule is the one that goes
 * wrong silently: on a whole-screen share Sei is usually frontmost at the exact
 * moment sharing starts, and naming ourselves would tell the companion it is
 * watching itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSources = vi.fn();
vi.mock('electron', () => ({ desktopCapturer: { getSources: (o: unknown) => getSources(o) } }));

const { readShareLabel } = await import('./shareLabel');

const win = (id: string, name: string): { id: string; name: string } => ({ id, name });

beforeEach(() => {
  getSources.mockReset();
});

describe('readShareLabel', () => {
  it('reads a shared window by id, not by position', () => {
    getSources.mockResolvedValue([win('window:2', 'Discord'), win('window:9', 'Valorant')]);
    return expect(readShareLabel('window:9')).resolves.toBe('Valorant');
  });

  it('re-reads the CURRENT title, which is the reason it is polled at all', async () => {
    // A browser tab switch changes what is on screen completely while the
    // source id stays the same. Pinning the pick-time name would leave the
    // companion talking about the last video for the rest of the session.
    getSources.mockResolvedValue([win('window:3', 'Dune (2021) - YouTube')]);
    expect(await readShareLabel('window:3')).toBe('Dune (2021) - YouTube');
    getSources.mockResolvedValue([win('window:3', 'How to poach an egg - YouTube')]);
    expect(await readShareLabel('window:3')).toBe('How to poach an egg - YouTube');
  });

  it('takes the frontmost window on a whole-screen share', () => {
    getSources.mockResolvedValue([win('window:1', 'Valorant'), win('window:2', 'Discord')]);
    return expect(readShareLabel('screen:0:0')).resolves.toBe('Valorant');
  });

  it('never names one of our own windows as the frontmost', async () => {
    getSources.mockResolvedValue([
      win('window:0', 'Sei'),
      win('window:8', 'Sei — Settings'),
      win('window:1', 'Valorant'),
    ]);
    expect(await readShareLabel('screen:0:0')).toBe('Valorant');
  });

  it('does not mistake another app for ours on a prefix collision', async () => {
    // "Seismograph" starts with Sei and is not us.
    getSources.mockResolvedValue([win('window:4', 'Seismograph')]);
    expect(await readShareLabel('screen:0:0')).toBe('Seismograph');
  });

  it('truncates a long title rather than letting it crowd the note', async () => {
    getSources.mockResolvedValue([win('window:1', 'x'.repeat(200))]);
    const label = (await readShareLabel('screen:0:0'))!;
    expect(label.length).toBeLessThanOrEqual(70);
    expect(label.endsWith('…')).toBe(true);
  });

  it('collapses the whitespace a window title can carry', () => {
    getSources.mockResolvedValue([win('window:1', '  Some   Doc \n ')]);
    return expect(readShareLabel('window:1')).resolves.toBe('Some Doc');
  });

  it('answers null rather than a stale label when the window has closed', () => {
    getSources.mockResolvedValue([win('window:2', 'Discord')]);
    return expect(readShareLabel('window:9')).resolves.toBeNull();
  });

  it('answers null when there is nothing but us on screen', () => {
    getSources.mockResolvedValue([win('window:0', 'Sei')]);
    return expect(readShareLabel('screen:0:0')).resolves.toBeNull();
  });

  it('never throws: a label is a nicety, the session is not', () => {
    getSources.mockRejectedValue(new Error('screen recording permission revoked'));
    return expect(readShareLabel('screen:0:0')).resolves.toBeNull();
  });
});
