/**
 * useChatgptLogin (261023): copy coverage + surface wiring.
 *
 * Renderer convention here is source-grep plus pure-function checks (no
 * @testing-library). The copy helpers are pure; the wiring checks pin that
 * every surface that offers Google also offers ChatGPT through the shared
 * hook, so the code step cannot drift between them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ChatgptLoginFailure, ChatgptLoginCodeReason } from '@shared/ipc';
import { ZH } from './i18n/zh';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(resolve(here, '..', p), 'utf8');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { sei: {} };
});

const FAILURES: ChatgptLoginFailure[] = [
  'region_blocked',
  'cancelled',
  'denied',
  'timeout',
  'browser_failed',
  'network',
  'unavailable',
  'no_email',
  'account_conflict',
  'linked_elsewhere',
  'rate_limited',
  'token_rejected',
  'sign_in_failed',
  'invalid_code',
  'code_expired',
  'not_signed_in',
];
const REASONS: ChatgptLoginCodeReason[] = ['existing_account', 'new_device', 'unverified_email'];
const ident = (s: string): string => s;

describe('ChatGPT login copy', () => {
  it('every failure has user copy (cancelled is silent), translated, with no em dash', async () => {
    const { chatgptLoginErrorCopy } = await import('./useChatgptLogin');
    for (const f of FAILURES) {
      const copy = chatgptLoginErrorCopy(f, ident);
      if (f === 'cancelled') {
        expect(copy).toBeNull();
        continue;
      }
      expect(copy, f).toBeTruthy();
      expect(copy!.includes('—'), f).toBe(false);
      expect(ZH[copy!], `zh for ${f}`).toBeTruthy();
    }
  });

  it('rate limiting tells the user to wait or use Google (and only wait in Settings)', async () => {
    const { chatgptLoginErrorCopy } = await import('./useChatgptLogin');
    const signIn = chatgptLoginErrorCopy('rate_limited', ident)!;
    expect(signIn).toMatch(/Too many tries/);
    expect(signIn).toMatch(/Google/);
    const link = chatgptLoginErrorCopy('rate_limited', ident, 'link')!;
    expect(link).toMatch(/Too many tries/);
    expect(link).not.toMatch(/Google/);
    expect(ZH[signIn]).toBeTruthy();
    expect(ZH[link]).toBeTruthy();
  });

  it('every code reason has its own line, translated', async () => {
    const { chatgptCodeReasonCopy } = await import('./useChatgptLogin');
    const lines = REASONS.map((r) => chatgptCodeReasonCopy(r, ident));
    expect(new Set(lines).size).toBe(REASONS.length);
    for (const l of lines) {
      expect(l.includes('—')).toBe(false);
      expect(ZH[l]).toBeTruthy();
    }
  });
});

describe('ChatGPT login surfaces', () => {
  const SURFACES = ['screens/AuthChoiceScreen.tsx', 'components/SignInModal.tsx', 'onboard/OnboardApp.tsx'];

  it('every surface with a Google sign-in also offers Continue with ChatGPT through the shared hook', () => {
    for (const f of SURFACES) {
      const s = src(f);
      expect(s.includes('useChatgptLogin('), f).toBe(true);
      expect(s.includes('<ContinueWithChatGPTButton'), f).toBe(true);
      expect(s.includes('gpt.start()'), f).toBe(true);
      // The code step: CodeInput fed by the hook, resend and a way back.
      expect(s.includes('onComplete={(v) => void gpt.submit(v)}'), f).toBe(true);
      expect(s.includes('gpt.resend()'), f).toBe(true);
      expect(s.includes('gpt.cancel'), f).toBe(true);
      expect(s.includes('chatgptCodeReasonCopy(gpt.reason'), f).toBe(true);
    }
  });

  it('the hook cancels a flow left running when its host unmounts', () => {
    const s = src('lib/useChatgptLogin.ts');
    expect(s).toMatch(/phaseRef\.current !== 'idle'\) void sei\.cancelChatgptLogin\(\)/);
  });

  it('the plan offer reuses the Playtime switch intent (existing confirm semantics)', () => {
    const s = src('components/ChatgptPlanHost.tsx');
    expect(s.includes('takeChatgptPlanOffer()')).toBe(true);
    expect(s.includes("navigate({ kind: 'credits', tab: 'chatgpt', useChatgptPlan: true })")).toBe(true);
    // Only on calm screens, never over the tour or onboarding.
    expect(s.includes("viewKind !== 'home' && viewKind !== 'settings' && viewKind !== 'credits'")).toBe(true);
    expect(s.includes('tourActive')).toBe(true);
  });

  it('Settings has the Link ChatGPT row in the signed-in Account group', () => {
    const settings = src('screens/SettingsScreen.tsx');
    expect(settings.includes('<ChatgptLinkRow')).toBe(true);
    const row = src('components/settings/ChatgptLinkRow.tsx');
    expect(row.includes('sei.linkChatgptAccount()')).toBe(true);
    expect(row.includes("t('Link ChatGPT')")).toBe(true);
  });
});
