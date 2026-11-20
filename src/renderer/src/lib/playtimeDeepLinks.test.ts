/**
 * Every way into Playtime lands on the right tab (261110). Source contracts,
 * like the other screen tests (no testing-library here); the runtime paths
 * of the wall and the popup actions are covered in HardStopModal.free.test
 * and popupActions.test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');

describe('Playtime deep links', () => {
  it('Settings "Brain, voice and plan" opens Playtime on the setup tab', () => {
    const s = read('screens/SettingsScreen.tsx');
    const at = s.indexOf('data-testid="settings-open-playtime"');
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 400)).toContain("navigate({ kind: 'credits' })");
  });

  it('the rail star opens Playtime on every reported backend', () => {
    expect(read('components/IconRail.tsx')).toContain("onClick={() => navigate({ kind: 'credits' })}");
  });

  it('the credit wall: ChatGPT to the ChatGPT tab, own key to My keys', () => {
    const s = read('components/HardStopModal.tsx');
    expect(s).toContain("navigate({ kind: 'credits', tab: 'chatgpt' })");
    expect(s).toContain("navigate({ kind: 'credits', tab: 'mykeys' })");
  });

  it('the plan offer and the startup popup carry the switch intent to the ChatGPT tab', () => {
    expect(read('components/ChatgptPlanHost.tsx')).toContain(
      "navigate({ kind: 'credits', tab: 'chatgpt', useChatgptPlan: true })",
    );
    expect(read('lib/popupActions.ts')).toContain("kind: 'credits', tab: 'chatgpt'");
  });

  it('the spend alert opens My keys', () => {
    expect(read('components/playtime/SpendAlertBanner.tsx')).toContain("navigate({ kind: 'credits', tab: 'mykeys' })");
  });

  it('the page reads view.tab first, then the setup tab', () => {
    const s = read('screens/PlaytimeScreen.tsx');
    expect(s).toContain("s.view.kind === 'credits' ? s.view.tab ?? null : null");
    expect(s).toContain('playtimeTabForSetup(');
  });
});
