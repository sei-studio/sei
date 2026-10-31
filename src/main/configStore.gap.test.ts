/**
 * T283: the settings-recovery gap left by T277. A damaged config whose
 * restore cannot be written, a config lost between quarantine and restore,
 * main + backup both unreadable, and "recovered to defaults" never reading
 * as a new user. Real fs in a temp dir; disk-full is simulated by failing
 * writeFileDurable for chosen paths, read-only by chmod.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fail = vi.hoisted(() => ({ match: null as null | ((file: string) => boolean), calls: 0 }));
vi.mock('./durableWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./durableWrite')>();
  return {
    ...actual,
    writeFileDurable: async (file: string, data: string | Uint8Array): Promise<void> => {
      if (fail.match?.(file)) {
        fail.calls++;
        const e = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        e.code = 'ENOSPC';
        throw e;
      }
      return actual.writeFileDurable(file, data);
    },
  };
});

import { _setUserDataOverride, paths, profileRootFor, setActiveScope } from './paths';
import {
  _isConfigHeldForTests,
  _resetConfigRecoveryForTests,
  configRecoveries,
  configShowsPriorSetup,
  loadConfig,
  onConfigRecovered,
  resetConfigKeepingIdentity,
  saveConfig,
  updateConfig,
  type ConfigRecoveryEvent,
} from './configStore';
import { readProfileSetupState } from './profileSetupState';
import { UserConfigSchema } from '../shared/characterSchema';

const ACCOUNT = '33333333-3333-4333-8333-333333333333';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-cfg-gap-'));
  _setUserDataOverride(tmp);
  _resetConfigRecoveryForTests();
  fail.match = null;
  fail.calls = 0;
});
afterEach(async () => {
  fail.match = null;
  _setUserDataOverride(null);
  setActiveScope('local');
  _resetConfigRecoveryForTests();
  await rm(tmp, { recursive: true, force: true });
});

const cfgPath = () => paths.configPath();
const bakPath = () => paths.configPath() + '.bak';
const dir = () => path.dirname(cfgPath());
const isTarget = (file: string) => file === cfgPath();

async function writeRaw(text: string, file = cfgPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function readJson(file = cfgPath()): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}
async function names(): Promise<string[]> {
  return (await readdir(dir())).sort();
}
const quarantined = async () => (await names()).filter((n) => n.startsWith('config.corrupt-'));
const q = (stamp: string) => path.join(dir(), `config.corrupt-${stamp}.json`);

describe('main and backup both unreadable', () => {
  it('restores the newest quarantined copy that parses, and writes it back', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Older', theme_mode: 'acorn' }), q('2026-01-01T00-00-00-000Z'));
    await writeRaw(JSON.stringify({ preferred_name: 'Newer', theme_mode: 'mint', some_future_key: 1 }), q('2026-02-01T00-00-00-000Z'));
    await writeRaw('{"preferred_name": "Newest but tru', q('2026-03-01T00-00-00-000Z'));
    await writeRaw('{ broken backup', bakPath());
    await writeRaw('\u0000\u0000');
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('Newer');
    expect(cfg.theme_mode).toBe('mint');
    // Written back verbatim (unknown keys included), so the next read is normal.
    expect(await readJson()).toMatchObject({ preferred_name: 'Newer', some_future_key: 1 });
    expect(configRecoveries().map((e) => e.kind)).toEqual(['restored_quarantine']);
    expect(_isConfigHeldForTests(cfgPath())).toBe(false);
    // The damaged main file joined the quarantine; nothing was deleted
    // beyond the newest-QUARANTINE_KEEP rule.
    expect(await quarantined()).toHaveLength(3);
  });

  it('no copy parses: identity keys are merged from the damaged text, the backup and the copies', async () => {
    await writeRaw('{"preferred_name": "FromQuarantine", "mc_username": "q_mc", "ui_lang', q('2026-01-01T00-00-00-000Z'));
    await writeRaw('{"mc_username": "bak_mc", "ai_backend_kind": "cloud-proxy", "the', bakPath());
    await writeRaw('{"analytics_opt_out": true, "pre');
    const cfg = await loadConfig();
    expect(cfg.analytics_opt_out).toBe(true); // damaged text
    expect(cfg.mc_username).toBe('bak_mc'); // backup beats an older quarantined copy
    expect(cfg.ai_backend_kind).toBe('cloud-proxy');
    expect(cfg.preferred_name).toBe('FromQuarantine');
    expect(configRecoveries()[0]).toMatchObject({ kind: 'reset_defaults', keptIdentity: true });
    expect((await readJson()).preferred_name).toBe('FromQuarantine');
  });

  it('nothing readable anywhere: defaults held in memory, reported once, and not a new user', async () => {
    await writeRaw('{ nope', bakPath());
    await writeRaw('');
    const a = await loadConfig();
    const b = await loadConfig();
    expect(a.preferred_name).toBe('');
    expect(b).toEqual(a);
    expect(configRecoveries().map((e) => e.kind)).toEqual(['reset_defaults']);
    expect(await quarantined()).toHaveLength(1);
    expect(await configShowsPriorSetup()).toBe(true);
    // The next save lands, keeping the recovered state.
    await updateConfig((c) => ({ ...c, theme_mode: 'acorn' }));
    expect((await readJson()).theme_mode).toBe('acorn');
    expect(_isConfigHeldForTests(cfgPath())).toBe(false);
  });
});

describe('a config lost between quarantine and restore (a later launch)', () => {
  it('missing main + a good backup: restored from the backup, not defaults', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana', theme_mode: 'acorn' }), bakPath());
    await writeRaw('old damage', q('2026-01-01T00-00-00-000Z'));
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('Ana');
    expect((await readJson()).preferred_name).toBe('Ana');
    expect(configRecoveries().map((e) => e.kind)).toEqual(['restored_backup']);
  });

  it('missing main + a good backup alone (no quarantine) also restores', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana' }), bakPath());
    expect((await loadConfig()).preferred_name).toBe('Ana');
  });

  it('missing main + only damaged copies: identity from the copies', async () => {
    await writeRaw('{"preferred_name": "Bo", "x', q('2026-01-01T00-00-00-000Z'));
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('Bo');
    expect(configRecoveries()[0]).toMatchObject({ kind: 'reset_defaults', keptIdentity: true });
  });

  it('a fresh profile (nothing on disk) is still plain defaults with no recovery', async () => {
    expect(await loadConfig()).toEqual(UserConfigSchema.parse({}));
    expect(configRecoveries()).toHaveLength(0);
    expect(await configShowsPriorSetup()).toBe(false);
  });
});

describe('the restore write fails (disk full)', () => {
  it('serves the recovery from memory, does not quarantine again, reports once, retries on the next save', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Kept', theme_mode: 'acorn' }), bakPath());
    await writeRaw('{"preferred_name": "Kept", "the');
    const seen: ConfigRecoveryEvent[] = [];
    onConfigRecovered((e) => seen.push(e));
    fail.match = isTarget;

    const first = await loadConfig();
    expect(first.preferred_name).toBe('Kept');
    // Quarantined, and the restore did not land: config.json is gone.
    expect((await names()).includes('config.json')).toBe(false);
    expect(_isConfigHeldForTests(cfgPath())).toBe(true);

    // Later reads: same settings, no second quarantine, no second report.
    for (let i = 0; i < 3; i++) expect((await loadConfig()).preferred_name).toBe('Kept');
    expect(await quarantined()).toHaveLength(1);

    // A save while the disk is still full keeps the change in memory, no throw.
    const next = await updateConfig((c) => ({ ...c, realistic_typing: false }));
    expect(next.realistic_typing).toBe(false);
    expect((await loadConfig()).realistic_typing).toBe(false);
    expect((await loadConfig()).preferred_name).toBe('Kept');

    // Space comes back: the next save writes everything held plus its own change.
    fail.match = null;
    await updateConfig((c) => ({ ...c, call_captions: true }));
    const disk = await readJson();
    expect(disk).toMatchObject({ preferred_name: 'Kept', theme_mode: 'acorn', realistic_typing: false, call_captions: true });
    expect(_isConfigHeldForTests(cfgPath())).toBe(false);
    expect(await quarantined()).toHaveLength(1);
    expect(seen.map((e) => e.kind)).toEqual(['restored_backup']);
  });

  it('the profile still reads as set up while held (never onboarding)', async () => {
    await writeRaw(JSON.stringify({ preferred_name: '' }), bakPath());
    await writeRaw('garbage');
    fail.match = isTarget;
    expect((await loadConfig()).preferred_name).toBe('');
    expect(await configShowsPriorSetup()).toBe(true);
  });

  it('a valid file that appears on disk wins over the held copy', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Kept' }), bakPath());
    await writeRaw('{ broken');
    fail.match = isTarget;
    await loadConfig();
    expect(_isConfigHeldForTests(cfgPath())).toBe(true);
    await writeRaw(JSON.stringify({ preferred_name: 'ByHand' }));
    expect((await loadConfig()).preferred_name).toBe('ByHand');
    expect(_isConfigHeldForTests(cfgPath())).toBe(false);
  });

  it('a normal write failure on a healthy file still throws (nothing was recovered)', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Ok' }));
    fail.match = isTarget;
    await expect(updateConfig((c) => ({ ...c, theme_mode: 'acorn' }))).rejects.toThrow(/ENOSPC/);
    expect((await readJson()).preferred_name).toBe('Ok');
  });
});

describe('a read-only folder (T283)', () => {
  const canTestReadOnly = typeof process.getuid === 'function' && process.getuid() !== 0 && process.platform !== 'win32';

  it.skipIf(!canTestReadOnly)('saves stay in memory; once writable, the damaged file is quarantined once and the settings land', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Kept' }), bakPath());
    await writeRaw('{"preferred_name": "x", broken');
    await chmod(dir(), 0o555);
    try {
      expect((await loadConfig()).preferred_name).toBe('Kept');
      const next = await updateConfig((c) => ({ ...c, theme_mode: 'acorn' }));
      expect(next.theme_mode).toBe('acorn');
      expect((await loadConfig()).theme_mode).toBe('acorn');
      await updateConfig((c) => ({ ...c, call_captions: true }));
      // Still the damaged file on disk, nothing moved.
      expect(await readFile(cfgPath(), 'utf8')).toContain('broken');
    } finally {
      await chmod(dir(), 0o755);
    }
    await updateConfig((c) => ({ ...c, realistic_typing: false }));
    expect(await readJson()).toMatchObject({ preferred_name: 'Kept', theme_mode: 'acorn', call_captions: true, realistic_typing: false });
    const copies = await quarantined();
    expect(copies).toHaveLength(1);
    expect(await readFile(path.join(dir(), copies[0]), 'utf8')).toContain('broken');
    expect(configRecoveries().map((e) => e.kind)).toEqual(['restored_backup']);
  });

  it.skipIf(!canTestReadOnly)('both files corrupt in a read-only folder: identity from memory, one report', async () => {
    await writeRaw('{"mc_username": "ro_mc", "x', bakPath());
    await writeRaw('{"preferred_name": "Ro", "y');
    const seen: ConfigRecoveryEvent[] = [];
    onConfigRecovered((e) => seen.push(e));
    await chmod(dir(), 0o555);
    try {
      for (let i = 0; i < 3; i++) {
        const cfg = await loadConfig();
        expect(cfg.preferred_name).toBe('Ro');
        expect(cfg.mc_username).toBe('ro_mc');
      }
      expect(await configShowsPriorSetup()).toBe(true);
    } finally {
      await chmod(dir(), 0o755);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'reset_defaults', keptIdentity: true });
  });
});

describe('configShowsPriorSetup', () => {
  it('an onboarding left half way (config + backup, no name) is still new', async () => {
    await saveConfig(UserConfigSchema.parse({ ui_language: 'zh' }));
    await updateConfig((c) => ({ ...c, theme_mode: 'acorn' }));
    expect((await names()).includes('config.json.bak')).toBe(true);
    expect(await configShowsPriorSetup()).toBe(false);
  });

  it('a backup that names the player means set up', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana' }), bakPath());
    await writeRaw(JSON.stringify({ preferred_name: '' }));
    expect(await configShowsPriorSetup()).toBe(true);
  });

  it('chat transcripts or memories mean set up; an empty memory dir does not', async () => {
    const mem = path.join(dir(), 'memory', 'sui');
    await mkdir(mem, { recursive: true });
    expect(await configShowsPriorSetup()).toBe(false);
    await writeFile(path.join(mem, 'chat.jsonl'), '{}\n');
    expect(await configShowsPriorSetup()).toBe(false);
    await writeFile(path.join(mem, 'chat.jsonl'), JSON.stringify({ id: 'a', role: 'user', text: 'hi', ts: 1 }) + '\n');
    expect(await configShowsPriorSetup()).toBe(true);
    await rm(path.join(mem, 'chat.jsonl'));
    await writeFile(path.join(mem, 'MEMORY.md'), '- [x] likes cats\n');
    expect(await configShowsPriorSetup()).toBe(true);
  });

  it('a transcript with only a system play row (written after a factory reset wipe) is still new', async () => {
    const mem = path.join(dir(), 'memory', 'sui');
    await mkdir(mem, { recursive: true });
    const row = { id: 'p', role: 'system', text: 'You and Sui played chess for 3 minutes.', ts: 1, event: { kind: 'play' } };
    await writeFile(path.join(mem, 'chat.jsonl'), JSON.stringify(row) + '\n');
    expect(await configShowsPriorSetup()).toBe(false);
  });

  it('a pre-reset copy that names the player means set up', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana' }), path.join(dir(), 'config.before-reset-2026-01-01T00-00-00-000Z.json'));
    expect(await configShowsPriorSetup()).toBe(true);
  });

  it('a safe-mode reset of a profile that never onboarded is still new', async () => {
    // Safe-mode Reset runs on every profile: a fresh install that failed to
    // start twice, or a signed-in user's untouched local profile.
    await saveConfig(UserConfigSchema.parse({ ui_language: 'zh' }));
    await updateConfig((c) => ({ ...c, theme_mode: 'acorn' }));
    await resetConfigKeepingIdentity();
    expect((await names()).some((n) => n.startsWith('config.before-reset-'))).toBe(true);
    expect(await configShowsPriorSetup()).toBe(false);
  });

  it('is per profile', async () => {
    await writeRaw('x', path.join(profileRootFor(ACCOUNT), 'config.corrupt-2026-01-01T00-00-00-000Z.json'));
    expect(await configShowsPriorSetup()).toBe(false);
    expect(await configShowsPriorSetup({ scope: ACCOUNT })).toBe(true);
  });
});

describe('readProfileSetupState', () => {
  it('a named profile is set up without a disk scan or cloud read', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Ana' }));
    const fetchCloudName = vi.fn(async () => 'Cloud');
    expect(await readProfileSetupState({ fetchCloudName })).toEqual({ returning: true, preferredName: 'Ana' });
    expect(fetchCloudName).not.toHaveBeenCalled();
  });

  it('a fresh profile is new', async () => {
    expect(await readProfileSetupState({ fetchCloudName: async () => 'Cloud' })).toEqual({ returning: false, preferredName: '' });
  });

  it('local profile recovered to defaults: returning, no name, no cloud read', async () => {
    await writeRaw('');
    const fetchCloudName = vi.fn(async () => 'Cloud');
    expect(await readProfileSetupState({ fetchCloudName })).toEqual({ returning: true, preferredName: '' });
    expect(fetchCloudName).not.toHaveBeenCalled();
  });

  it('account profile recovered to defaults: the name is read back from the cloud and saved', async () => {
    setActiveScope(ACCOUNT);
    await writeRaw('');
    expect(await readProfileSetupState({ fetchCloudName: async () => ' Ana ' })).toEqual({ returning: true, preferredName: 'Ana' });
    expect((await readJson()).preferred_name).toBe('Ana');
  });

  it('a cloud read that hangs is bounded', async () => {
    setActiveScope(ACCOUNT);
    await writeRaw('');
    const st = await readProfileSetupState({ fetchCloudName: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(st).toEqual({ returning: true, preferredName: '' });
  });
});

describe('safe-mode reset never leaves the config missing', () => {
  it('copies the old file aside and replaces it in place', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Ana', theme_mode: 'acorn' }));
    await resetConfigKeepingIdentity();
    expect(await readJson()).toMatchObject({ preferred_name: 'Ana', theme_mode: 'system' });
    const before = (await names()).filter((n) => n.startsWith('config.before-reset-'));
    expect(before).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(dir(), before[0]), 'utf8')).theme_mode).toBe('acorn');
  });

  it('a copy that cannot be written stops the reset with the old file intact', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Ana', theme_mode: 'acorn' }));
    fail.match = (file) => path.basename(file).startsWith('config.before-reset-');
    await expect(resetConfigKeepingIdentity()).rejects.toThrow(/ENOSPC/);
    expect(await readJson()).toMatchObject({ preferred_name: 'Ana', theme_mode: 'acorn' });
  });

  it('a failed replace leaves the old file in place (no defaults on the next read)', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Ana', theme_mode: 'acorn' }));
    fail.match = isTarget;
    await expect(resetConfigKeepingIdentity()).rejects.toThrow(/ENOSPC/);
    fail.match = null;
    expect((await loadConfig()).preferred_name).toBe('Ana');
  });
});
