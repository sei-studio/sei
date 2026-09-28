/**
 * 260929 — the Forge/NeoForge variant of the host warning blocks: it names the
 * loader, points at the Sei profile, and renders no "Summon anyway".
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/ipcClient', () => ({ sei: {} }));
import { LanHostWarningModal } from './LanHostWarningModal';

function render(warning: 'forge' | 'modded', client: 'forge' | 'neoforge' | 'quilt'): string {
  return renderToStaticMarkup(
    <LanHostWarningModal
      characterId="c1"
      warning={warning}
      host={{ client, forgeModCount: client === 'quilt' ? null : 0 }}
      fromChat={false}
    />,
  );
}

describe('LanHostWarningModal forge block', () => {
  it('says Sei cannot join, names the loader, and offers no summon', () => {
    const html = render('forge', 'neoforge');
    expect(html).toContain('join NeoForge worlds');
    expect(html).toContain('Sei profile');
    expect(html).toContain('Set up Sei profile');
    expect(html).not.toContain('Summon anyway');
    expect(html).not.toContain('—'); // no em-dashes in the copy
  });

  it('Forge on weak evidence gets the soft warning: says it may be Forge, keeps Summon anyway', () => {
    const html = renderToStaticMarkup(
      <LanHostWarningModal characterId="c1" warning="modded" host={{ client: 'forge', forgeModCount: null }} fromChat={false} />,
    );
    expect(html).toContain('may be running Forge');
    expect(html).toContain('Sei profile');
    expect(html).toContain('Summon anyway');
    expect(html).not.toContain('—');
  });

  it('a Quilt host keeps the soft warning with its escape hatch', () => {
    expect(render('modded', 'quilt')).toContain('Summon anyway');
  });
});
