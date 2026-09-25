import { describe, it, expect } from 'vitest';
import { supportedVersions } from 'minecraft-protocol/src/version.js';

// The modal's store imports read window.sei at module load.
(globalThis as unknown as { window: unknown }).window = { sei: {}, addEventListener: () => undefined, removeEventListener: () => undefined };
const { humanBody, reportedVersion } = await import('./UnsupportedVersionModal');
const { useLangStore } = await import('../lib/i18n');

const NEWEST = supportedVersions[supportedVersions.length - 1];
const BOT_MSG =
  "UNSUPPORTED_MC_VERSION: This world is running Minecraft 26.2, which Sei can't join yet. " +
  'Sei supports Minecraft Java 1.8.8 to 26.1. Open your world from a launcher installation on a supported version and press Launch again.';

describe('UnsupportedVersionModal copy (260926)', () => {
  it('pulls the world version out of the bot error', () => {
    expect(reportedVersion(BOT_MSG)).toBe('26.2');
    expect(reportedVersion('garbage')).toBeNull();
  });

  it('names the world version and the exact supported range', () => {
    useLangStore.getState().setLang('en');
    const body = humanBody(BOT_MSG, null);
    expect(body).toContain('Minecraft 26.2');
    expect(body).toContain(`to ${NEWEST}`);
    expect(body).not.toContain('{');
  });

  it('falls back to the LAN-detected version, then to no version', () => {
    useLangStore.getState().setLang('en');
    expect(humanBody('', '26.3')).toContain('Minecraft 26.3');
    const bare = humanBody('', null);
    expect(bare).toContain(NEWEST);
    expect(bare).not.toContain('{');
  });

  it('recommends the wizard version, not the newest joinable one', async () => {
    const { MC_RECOMMENDED } = await import('../lib/mcVersions');
    const { WIZARD_MAX_MC, selectTargetMcVersion } = await import('@shared/mcSetup');
    expect(MC_RECOMMENDED).toBe(WIZARD_MAX_MC);
    expect(MC_RECOMMENDED).toBe(selectTargetMcVersion({ supported: supportedVersions }));
    expect(MC_RECOMMENDED).not.toBe(NEWEST);
    // The body still names the newest joinable version in its list.
    useLangStore.getState().setLang('en');
    expect(humanBody('', '26.4')).toContain(`to ${NEWEST}`);
  });

  it('is translated in zh with the numbers intact', () => {
    useLangStore.getState().setLang('zh');
    const body = humanBody(BOT_MSG, null);
    expect(body).toContain('26.2');
    expect(body).toContain(NEWEST);
    expect(body).not.toContain('Sei works with');
    useLangStore.getState().setLang('en');
  });
});
