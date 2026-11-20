/**
 * ProfileOverview (profile v3, product call 261110 follow-up),
 * server-rendered: the creator's description sits in the user-text box, and
 * the Overview no longer lists games or avatars (every companion plays every
 * game; the avatars open from the portrait's corner button, which renders
 * nothing until the avatar library has been read).
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
};

const { ProfileAvatarsButton, ProfileIntro, ProfileOverview } = await import('./ProfileOverview');
type Character = Parameters<typeof ProfileIntro>[0]['character'];

const character = {
  id: 'c1',
  kind: 'custom',
  public_id: 'M5IR',
  name: 'Aria',
  persona: { source: 'A bard.', expanded: '' },
  is_default: false,
  description: 'A cheerful bard who narrates your mining trips.',
  shared: true,
  slug: null,
  metadata: { voiceId: 'v-sarah' },
  created: '2026-10-20T00:00:00Z',
  last_launched: null,
  playtime_ms: 0,
  skin: { source: 'png', mojang_username: null, png_sha256: 'x', applied_at: null },
  username: null,
  owner: 'someone',
} as unknown as Character;

const noop = (): void => undefined;

function overview(c: Character): string {
  return renderToStaticMarkup(
    React.createElement(ProfileOverview, {
      character: c,
      canReport: true,
      onReport: noop,
      intro: React.createElement(ProfileIntro, { character: c, info: null, onSample: noop }),
    }),
  );
}

describe('ProfileOverview (profile v3)', () => {
  it("boxes the creator's description as user text", () => {
    const html = overview(character);
    expect(html).toMatch(/data-user-text="true" data-ov="description"[^>]*><p[^>]*>A cheerful bard who narrates your mining trips\.<\/p>/);
  });

  it('no box when there is no description', () => {
    expect(overview({ ...character, description: '' } as Character)).not.toContain('data-user-text');
  });

  it('no games or avatars sections, the Report link stays', () => {
    const html = overview(character);
    expect(html).not.toContain('data-ov="games"');
    expect(html).not.toContain('data-ov="avatars"');
    expect(html).not.toContain('Skin ready');
    expect(html).toContain('Report');
  });

  it('the corner Avatars button renders nothing before the library is read', () => {
    const html = renderToStaticMarkup(React.createElement(ProfileAvatarsButton, { character, className: 'x' }));
    expect(html).toBe('');
  });
});
