import { describe, it, expect } from 'vitest';
import { notificationLanguage, pickActiveCompanion, refillNotificationText, trayMenuText } from './refillCopy';
import { CHAT_LANGUAGE_CODES } from '../../shared/chatLanguage';

describe('refill notification copy (261005)', () => {
  it('reads "{name}: Free play is back. Want to jump in?"', () => {
    expect(refillNotificationText({ name: 'Sui', lang: 'en', plan: 'free' })).toEqual({
      title: 'Sui',
      body: 'Free play is back. Want to jump in?',
    });
  });

  it('falls back to Sei with no companion, and never says "free" to a subscriber', () => {
    expect(refillNotificationText({ name: '  ', lang: 'en', plan: 'free' }).title).toBe('Sei');
    expect(refillNotificationText({ name: null, lang: 'en', plan: 'quest' }).body).toBe(
      'Your weekly allowance is back. Want to jump in?',
    );
  });

  it('has every conversation language, with no em dash or emoji', () => {
    for (const lang of CHAT_LANGUAGE_CODES) {
      for (const plan of ['free', 'party'] as const) {
        const { body } = refillNotificationText({ name: 'Sui', lang, plan });
        expect(body.length).toBeGreaterThan(0);
        expect(body).not.toMatch(/—/);
        expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it('follows the conversation language, then a Chinese UI, then English', () => {
    expect(notificationLanguage({ chat_language: 'ja', ui_language: 'en' })).toBe('ja');
    expect(notificationLanguage({ chat_language: 'en', ui_language: 'zh' })).toBe('zh');
    expect(notificationLanguage({ chat_language: undefined, ui_language: 'zh' })).toBe('zh');
    expect(notificationLanguage({})).toBe('en');
  });

  it('picks the most recently used companion', () => {
    const chars = [
      { name: 'Sui', last_chatted: '2026-10-01T00:00:00Z' },
      { name: 'Lyra', last_launched: '2026-10-03T00:00:00Z' },
      { name: 'Marv', last_chatted: 'garbage' },
    ];
    expect(pickActiveCompanion(chars)?.name).toBe('Lyra');
    expect(pickActiveCompanion([{ name: 'Only' }])?.name).toBe('Only');
    expect(pickActiveCompanion([])).toBeNull();
  });

  it('tray menu words in both UI languages', () => {
    expect(trayMenuText('en')).toEqual({ open: 'Open Sei', quit: 'Quit Sei', update: 'Restart to update' });
    expect(trayMenuText('zh').open).toBe('打开 Sei');
  });
});
