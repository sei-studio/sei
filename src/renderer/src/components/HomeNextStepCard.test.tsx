/**
 * HomeNextStepCard (261013, T119), server-rendered. Effects do not run under
 * renderToStaticMarkup, so the shown event is covered in
 * lib/homeNextStep.test.ts, not here.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HomeNextStep } from '@shared/homeNextStep';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { HomeNextStepCard } = await import('./HomeNextStepCard');

function render(step: HomeNextStep | null): string {
  return renderToStaticMarkup(
    React.createElement(HomeNextStepCard, { step, name: 'Sui', theme: 'dark', onDismiss: () => undefined }),
  );
}

const base: HomeNextStep = {
  characterId: 'c1',
  source: 'plan',
  text: 'Finish the roof on the lake house',
  at: Date.now() - 3_600_000,
  surface: 'game',
  game: 'minecraft',
};

describe('HomeNextStepCard', () => {
  it('renders nothing without a step', () => {
    expect(render(null)).toBe('');
  });

  it('shows the companion, the plan and a game button', () => {
    const html = render(base);
    expect(html).toContain('data-home-next-step="plan"');
    expect(html).toContain('Up next with Sui');
    expect(html).toContain('Finish the roof on the lake house');
    expect(html).toContain('Play Minecraft');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('a call plan says Call; an untagged plan says Play', () => {
    expect(render({ ...base, surface: 'call', game: null })).toContain('Call Sui');
    const untagged = render({ ...base, surface: null, game: null });
    expect(untagged).toMatch(/>Play<\//);
  });

  it('a goal renders the same way', () => {
    const html = render({ ...base, source: 'goal', text: 'Reach iron tier', game: 'stardew' });
    expect(html).toContain('data-home-next-step="goal"');
    expect(html).toContain('Reach iron tier');
    expect(html).toContain('Play Stardew Valley');
  });
});




