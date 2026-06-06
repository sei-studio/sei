/**
 * CAPTCHA / Turnstile token seam (anti-abuse Layer 2) tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setCaptchaToken,
  consumeCaptchaToken,
  isCaptchaEnabled,
  _resetCaptchaForTests,
} from './captcha';

beforeEach(() => _resetCaptchaForTests());
afterEach(() => {
  _resetCaptchaForTests();
  delete process.env.CAPTCHA_ENABLED;
});

describe('captcha seam', () => {
  it('returns undefined when no token is set (inert)', () => {
    expect(consumeCaptchaToken()).toBeUndefined();
  });

  it('stores and consumes a token (single-use)', () => {
    setCaptchaToken('tok-123');
    expect(consumeCaptchaToken()).toBe('tok-123');
    // Consumed — a second read is undefined (no reuse of a stale token).
    expect(consumeCaptchaToken()).toBeUndefined();
  });

  it('treats empty string / null as clearing the token', () => {
    setCaptchaToken('tok');
    setCaptchaToken('');
    expect(consumeCaptchaToken()).toBeUndefined();
    setCaptchaToken('tok');
    setCaptchaToken(null);
    expect(consumeCaptchaToken()).toBeUndefined();
  });

  it('isCaptchaEnabled reflects the CAPTCHA_ENABLED env flag', () => {
    expect(isCaptchaEnabled()).toBe(false);
    process.env.CAPTCHA_ENABLED = 'true';
    expect(isCaptchaEnabled()).toBe(true);
    process.env.CAPTCHA_ENABLED = '1';
    expect(isCaptchaEnabled()).toBe(true);
    process.env.CAPTCHA_ENABLED = 'false';
    expect(isCaptchaEnabled()).toBe(false);
  });
});
