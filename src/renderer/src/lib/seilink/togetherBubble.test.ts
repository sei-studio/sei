import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/ipc';
import { bubbleMs, freshCompanionLine } from './togetherBubble';

const row = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, text, ts: 0, ...extra });

describe('her bubble in the shared editor', () => {
  it('shows only lines that arrived after the editor opened, newest first', () => {
    const history = [row('a', 'user', 'hi'), row('b', 'companion', 'hey')];
    const seen = new Set(history.map((m) => m.id));
    expect(freshCompanionLine(seen, history)).toBeNull();
    // The talk box: her reply follows the player's line in the same chat.
    const next = [...history, row('c', 'user', 'make it cozier'), row('d', 'companion', 'on it'), row('e', 'companion', ' there, warmer ')];
    expect(freshCompanionLine(seen, next)).toEqual({ id: 'e', text: 'there, warmer' });
    expect(freshCompanionLine(seen, next)).toBeNull();
  });

  it('skips the player, system rows and empty lines, and shows spoken call lines', () => {
    const seen = new Set<string>();
    expect(freshCompanionLine(seen, [row('s', 'system', 'You and Sui called'), row('u', 'user', 'look')])).toBeNull();
    expect(freshCompanionLine(seen, [row('v', 'companion', 'nice rug', { voice: true }), row('w', 'companion', '  ')])).toEqual({ id: 'v', text: 'nice rug' });
  });

  it('keeps short lines up for a few seconds and caps long ones', () => {
    expect(bubbleMs('ok')).toBeGreaterThanOrEqual(4000);
    expect(bubbleMs('x'.repeat(500))).toBe(12_000);
  });
});
