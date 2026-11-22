/**
 * 261023: the own-key import offer has an existing-account variant (merge
 * copy, "Not now"), and every string it shows has a Chinese translation.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { ImportLocalProfileModal, ImportLocalProfileModalView, importAttemptFailed } = await import('./ImportLocalProfileModal');
const { ZH } = await import('../lib/i18n/zh');

const peek = (n: number) => ({
  migratableCharacterIds: Array.from({ length: n }, (_, i) => `id-${i}`),
  memoryOnlyCharacterIds: n === 0 ? ['m'] : [],
  mcUsername: null,
  preferredName: 'Boss',
  hasData: true,
  hasCompanionData: true,
  untouchedSeedIds: [] as string[],
});

function render(n: number, existingAccount: boolean): string {
  return renderToStaticMarkup(
    React.createElement(ImportLocalProfileModal, { peek: peek(n), existingAccount, onDone: () => undefined }),
  );
}

describe('ImportLocalProfileModal', () => {
  it('existing account: says nothing is replaced and offers "Not now"', () => {
    const html = render(2, true);
    expect(html).toContain('You have 2 companions on this computer from before you signed in.');
    expect(html).toContain('Nothing already in your account is replaced.');
    expect(html).toContain('Not now');
    expect(html).not.toContain('Start fresh');
  });

  it('new account keeps the original copy', () => {
    const html = render(1, false);
    expect(html).toContain('You set up 1 companion before signing in.');
    expect(html).toContain('Start fresh');
  });

  it('every existing-account string has a zh translation', () => {
    for (const key of [
      'You have 1 companion on this computer from before you signed in. Add it and its memories to this account? Nothing already in your account is replaced.',
      'You have {count} companions on this computer from before you signed in. Add them and their memories to this account? Nothing already in your account is replaced.',
      'You have companion memories on this computer from before you signed in. Add them to this account? Nothing already in your account is replaced.',
      'Not now',
    ]) {
      expect(ZH[key], key).toBeTruthy();
    }
  });

  it('a failed import shows the error line with Continue and Try again', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImportLocalProfileModalView, {
        peek: peek(2),
        existingAccount: true,
        status: 'error',
        onDecline: () => undefined,
        onImport: () => undefined,
        onContinue: () => undefined,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Not everything came over. Try again, or later from Settings.');
    expect(html).toContain('Continue');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Not now');
    expect(ZH['Not everything came over. Try again, or later from Settings.']).toBeTruthy();
  });

  it('no error line before an attempt or while importing', () => {
    for (const status of ['idle', 'importing'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(ImportLocalProfileModalView, {
          peek: peek(1),
          existingAccount: true,
          status,
          onDecline: () => undefined,
          onImport: () => undefined,
          onContinue: () => undefined,
        }),
      );
      expect(html).not.toContain('role="alert"');
    }
  });

  it('an import that threw or left companions behind counts as failed', () => {
    expect(importAttemptFailed(null)).toBe(true);
    expect(importAttemptFailed({ imported: ['a'], failed: ['b'] } as never)).toBe(true);
    expect(importAttemptFailed({ imported: ['a'], failed: [] } as never)).toBe(false);
  });
});




