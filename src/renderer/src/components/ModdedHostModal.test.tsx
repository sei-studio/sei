/**
 * ModdedHostModal (261007): a Fabric kick reads as Fabric even when the host
 * classifier said "unknown" (both 0.6.7 cases), names the mods the world
 * asked for, and no longer recommends minimaps.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = { sei: {}, addEventListener: () => undefined, removeEventListener: () => undefined };
const { ModdedHostModal } = await import('./ModdedHostModal');

const FABRIC =
  'MODDED_HOST_REJECTED: This world runs Fabric with mods that add content, and it only lets in players who have those mods. ' +
  'Sei joins as a vanilla client, so the world turns it away. The mods it names: xaerominimap, xaeroworldmap.';

const render = (message?: string) =>
  renderToStaticMarkup(React.createElement(ModdedHostModal, { characterId: 'c1', message }));

describe('ModdedHostModal', () => {
  it('reads a Fabric kick as Fabric and lists the named mods', () => {
    const html = render(FABRIC);
    expect(html).toContain('It runs Fabric with other mods');
    expect(html).not.toContain('Forge or NeoForge');
    expect(html).toContain('The world asked for these mods: xaerominimap, xaeroworldmap.');
    expect(html).toContain('Xaero&#x27;s Minimap and World Map');
    expect(html).toContain('Sei profile');
    expect(html).not.toMatch(/client-side mods like minimaps/);
  });

  it('keeps the Forge body when the message does not say Fabric', () => {
    const html = render('MODDED_HOST_REJECTED: This world runs Forge or NeoForge and only lets in players who have its mods.');
    expect(html).toContain('It runs Forge or NeoForge');
    expect(html).not.toContain('The world asked for these mods');
  });
});
