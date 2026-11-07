/**
 * 261107: the "Open on login" step after the guided room setup's Done
 * (loginStep.ts; RoomEditor renders it). Preselected on, asked once, only
 * where the login item works.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpenAtLoginState } from '@shared/openAtLogin';

const h = vi.hoisted(() => ({ sei: {} as Record<string, unknown> }));
vi.mock('../ipcClient', () => ({ sei: h.sei }));

const { LOGIN_STEP_DEFAULT, ipcOpenAtLoginSource, loginStepAfter, offersLoginStep } = await import('./loginStep');
const { DICTIONARIES } = await import('../i18n');

const st = (over: Partial<OpenAtLoginState> = {}): OpenAtLoginState => ({ supported: true, enabled: false, needsApproval: false, decided: false, ...over });

describe('the Open on login setup step', () => {
  it('starts on: the main button turns it on', () => {
    expect(LOGIN_STEP_DEFAULT).toBe(true);
  });

  it('is offered only where the login item works, and only until the user has answered', () => {
    expect(offersLoginStep(st())).toBe(true);
    expect(offersLoginStep(st({ supported: false }))).toBe(false);
    expect(offersLoginStep(st({ decided: true }))).toBe(false);
    expect(offersLoginStep(st({ decided: true, enabled: true }))).toBe(false);
    expect(offersLoginStep(null)).toBe(false);
    expect(offersLoginStep(undefined)).toBe(false);
  });

  it('closes after an answer the OS took; stays with a line when it refused or macOS waits for approval', () => {
    expect(loginStepAfter(true, st({ enabled: true, decided: true }))).toBe('close');
    expect(loginStepAfter(false, st({ decided: true }))).toBe('close');
    expect(loginStepAfter(true, st({ enabled: false }))).toBe('failed');
    expect(loginStepAfter(true, null)).toBe('failed');
    expect(loginStepAfter(true, st({ enabled: true, needsApproval: true }))).toBe('approval');
    // "Not now" never keeps the step up, even if the reply is lost.
    expect(loginStepAfter(false, null)).toBe('close');
  });

  it('the app source answers through IPC with surface setup, and is absent without the preload API', () => {
    expect(ipcOpenAtLoginSource()).toBeNull();
    const set = vi.fn(async (enabled: boolean) => st({ enabled, decided: true }));
    h.sei.seilinkLoginItemGet = async () => st();
    h.sei.seilinkLoginItemSet = set;
    const src = ipcOpenAtLoginSource();
    expect(src).not.toBeNull();
    void src?.set(true);
    expect(set).toHaveBeenCalledWith(true, 'setup');
  });

  it('its copy is translated in every UI language, without em dashes', () => {
    for (const k of ['Open on login', '{name} comes back after a restart.', 'Turn on', 'Not now', 'Done']) {
      expect(k).not.toContain('—');
      for (const [lang, dict] of Object.entries(DICTIONARIES)) expect(dict[k], `${lang}: ${k}`).toBeTruthy();
    }
  });
});
