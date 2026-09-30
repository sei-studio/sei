import { describe, it, expect } from 'vitest';
import { connectingLabel } from './summonProgress';
import { ZH_CHATUI as zhChatui } from './i18n/zh/chatui';

// 260926: the launch button shows boot progress instead of a flat
// "Connecting..." that read as a hang during a 20s+ Windows cold boot.
describe('connectingLabel', () => {
  const echo = (k: string): string => k;

  it('reads "Starting companion..." while the bot boots', () => {
    expect(connectingLabel({ kind: 'connecting', characterId: 'a', stage: 'starting' }, echo)).toBe(
      'Starting companion...',
    );
  });

  it('reads "Joining your world..." once the bot has booted', () => {
    expect(connectingLabel({ kind: 'connecting', characterId: 'a', stage: 'joining' }, echo)).toBe(
      'Joining your world...',
    );
  });

  it('treats a stage-less status (older main, other games) as starting', () => {
    expect(connectingLabel({ kind: 'connecting', characterId: 'a' }, echo)).toBe('Starting companion...');
    expect(connectingLabel(undefined, echo)).toBe('Starting companion...');
  });

  it('has zh strings for both labels', () => {
    expect(zhChatui['Starting companion...']).toBeTruthy();
    expect(zhChatui['Joining your world...']).toBeTruthy();
  });
});
