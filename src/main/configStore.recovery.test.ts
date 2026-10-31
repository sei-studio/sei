/**
 * configStore resilience (261031, T277): durable writes with a last-known-good
 * backup, quarantine + restore of a damaged file, field-by-field salvage,
 * unknown-key and newer-schema preservation, migrations, and the
 * safe-mode "Reset settings".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths, setActiveScope } from './paths';
import {
  CONFIG_SCHEMA_VERSION,
  QUARANTINE_KEEP,
  _resetConfigRecoveryForTests,
  configRecoveries,
  extractIdentityKeys,
  loadConfig,
  migrateRawConfig,
  onConfigRecovered,
  parseConfigLenient,
  resetConfigKeepingIdentity,
  saveConfig,
  updateConfig,
  type ConfigRecoveryEvent,
} from './configStore';
import { UserConfigSchema } from '../shared/characterSchema';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-cfg-rec-'));
  _setUserDataOverride(tmp);
  _resetConfigRecoveryForTests();
});
afterEach(async () => {
  _setUserDataOverride(null);
  setActiveScope('local');
  _resetConfigRecoveryForTests();
  await rm(tmp, { recursive: true, force: true });
});

const cfgPath = () => paths.configPath();
const bakPath = () => paths.configPath() + '.bak';

async function writeRaw(text: string, file = cfgPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function readJson(file = cfgPath()): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}
async function dirNames(): Promise<string[]> {
  return (await readdir(path.dirname(cfgPath()))).sort();
}

describe('writes', () => {
  it('stamps schema_version and leaves no temp files', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Ana' }));
    const raw = await readJson();
    expect(raw.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(raw.preferred_name).toBe('Ana');
    expect((await dirNames()).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('keeps the previous valid file as config.json.bak', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'One' }));
    await updateConfig((c) => ({ ...c, preferred_name: 'Two' }));
    expect((await readJson(bakPath())).preferred_name).toBe('One');
    expect((await readJson()).preferred_name).toBe('Two');
  });

  it('a no-op update writes nothing (the backup is not churned)', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'One' }));
    await updateConfig((c) => ({ ...c, preferred_name: 'Two' }));
    await updateConfig((c) => c);
    expect((await readJson(bakPath())).preferred_name).toBe('One');
  });

  it('never backs up a damaged file over a good backup', async () => {
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Good' }));
    await updateConfig((c) => ({ ...c, preferred_name: 'Newer' }));
    // Backup now holds "Good". Damage the main file, then write.
    await writeRaw('{"preferred_name": "Ne');
    await updateConfig((c) => ({ ...c, theme_mode: 'acorn' }));
    // Recovery restored the backup ("Good"); the write then backed THAT up.
    expect((await readJson(bakPath())).preferred_name).toBe('Good');
    expect((await readJson()).theme_mode).toBe('acorn');
  });
});

describe('damaged files', () => {
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['whitespace', '   \n'],
    ['truncated', '{"preferred_name": "Ana", "theme_mo'],
    ['not json', 'garbage\u0000\u0000'],
    ['an array', '[1,2,3]'],
    ['a string', '"hello"'],
    ['null', 'null'],
  ];

  for (const [label, text] of cases) {
    it(`${label}: quarantined, then restored from the backup`, async () => {
      await writeRaw(JSON.stringify({ preferred_name: 'Backup', theme_mode: 'acorn' }), bakPath());
      await writeRaw(text);
      const cfg = await loadConfig();
      expect(cfg.preferred_name).toBe('Backup');
      expect(cfg.theme_mode).toBe('acorn');
      // The restored file is back on disk.
      expect((await readJson()).preferred_name).toBe('Backup');
      const names = await dirNames();
      const q = names.filter((n) => n.startsWith('config.corrupt-'));
      expect(q).toHaveLength(1);
      expect(await readFile(path.join(path.dirname(cfgPath()), q[0]), 'utf8')).toBe(text);
      expect(configRecoveries().map((e) => e.kind)).toEqual(['restored_backup']);
    });
  }

  it('no backup: identity keys are read back out of the damaged text', async () => {
    await writeRaw(
      '{\n  "mc_username": "ana_mc",\n  "preferred_name": "Ana \\"A\\"",\n  "ai_backend_kind": "cloud-proxy",\n' +
        '  "analytics_opt_out": true,\n  "added_world_ids": ["' + W1 + '", "' + W2 + '"],\n  "total_playtime_ms": 12345,\n  "theme_mo',
    );
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('Ana "A"');
    expect(cfg.mc_username).toBe('ana_mc');
    expect(cfg.ai_backend_kind).toBe('cloud-proxy');
    expect(cfg.analytics_opt_out).toBe(true);
    expect(cfg.added_world_ids).toEqual([W1, W2]);
    expect(cfg.total_playtime_ms).toBe(12345);
    // Persisted, so the next read is a normal read.
    expect((await readJson()).preferred_name).toBe('Ana "A"');
    const ev = configRecoveries();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'reset_defaults', keptIdentity: true });
  });

  it('no backup and nothing readable: defaults in memory, nothing written', async () => {
    await writeRaw('\u0000\u0000\u0000');
    const cfg = await loadConfig();
    expect(cfg).toEqual({ ...UserConfigSchema.parse({}), schema_version: CONFIG_SCHEMA_VERSION });
    expect((await dirNames()).includes('config.json')).toBe(false);
    expect(configRecoveries()[0]).toMatchObject({ kind: 'reset_defaults', keptIdentity: false });
  });

  it('a damaged backup is not used', async () => {
    await writeRaw('{"preferred_name": "x', bakPath());
    await writeRaw('');
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('');
    expect(configRecoveries()[0].kind).toBe('reset_defaults');
  });

  it('an invalid identity value from the damaged text is dropped, not written', async () => {
    await writeRaw('{"ai_backend_kind": "warp-drive", "preferred_name": "Ana", "x');
    const cfg = await loadConfig();
    expect(cfg.ai_backend_kind).toBe('local');
    expect(cfg.preferred_name).toBe('Ana');
    expect((await readJson()).ai_backend_kind).toBe('local');
  });

  it('keeps only the newest QUARANTINE_KEEP quarantined copies', async () => {
    const dir = path.dirname(cfgPath());
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(dir, `config.corrupt-2026-01-0${i + 1}T00-00-00-000Z.json`), 'old');
    }
    await writeRaw('');
    await loadConfig();
    const q = (await dirNames()).filter((n) => n.startsWith('config.corrupt-'));
    expect(q).toHaveLength(QUARANTINE_KEEP);
    // The fresh one (today's stamp) survived; the oldest went.
    expect(q.some((n) => n.startsWith('config.corrupt-2026-01-01'))).toBe(false);
  });

  it('updateConfig on a damaged file recovers first, then applies the mutation', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Backup' }), bakPath());
    await writeRaw('{{{');
    const next = await updateConfig((c) => ({ ...c, realistic_typing: false }));
    expect(next.preferred_name).toBe('Backup');
    expect(next.realistic_typing).toBe(false);
    expect((await readJson()).realistic_typing).toBe(false);
  });

  it('concurrent reads of a damaged file recover it once', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Backup' }), bakPath());
    await writeRaw('');
    const all = await Promise.all([loadConfig(), loadConfig(), loadConfig(), updateConfig((c) => c)]);
    for (const c of all) expect(c.preferred_name).toBe('Backup');
    expect((await dirNames()).filter((n) => n.startsWith('config.corrupt-'))).toHaveLength(1);
    expect(configRecoveries().filter((e) => e.kind === 'restored_backup')).toHaveLength(1);
  });

  it('a missing file is defaults, not a recovery', async () => {
    expect(await loadConfig()).toEqual(UserConfigSchema.parse({}));
    expect(configRecoveries()).toHaveLength(0);
  });

  it('never puts file content in logs or recovery events', async () => {
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await writeRaw('{"preferred_name": "SecretName", "web_search_api_key": "sk-SECRET-123", "x');
      await loadConfig();
      await writeRaw(JSON.stringify({ preferred_name: 'SecretName', theme_mode: 12, web_search_api_key: 'sk-SECRET-123' }));
      await loadConfig();
    } finally {
      console.warn = orig;
    }
    const blob = JSON.stringify(configRecoveries()) + logs.join('\n');
    expect(blob).not.toContain('SecretName');
    expect(blob).not.toContain('sk-SECRET');
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('schema-invalid fields', () => {
  it('keeps every valid field and defaults only the invalid ones', async () => {
    await writeRaw(
      JSON.stringify({ preferred_name: 'Ana', theme_mode: 'purple', background_opacity: 'lots', realistic_typing: false }),
    );
    const cfg = await loadConfig();
    expect(cfg.preferred_name).toBe('Ana');
    expect(cfg.realistic_typing).toBe(false);
    expect(cfg.theme_mode).toBe(UserConfigSchema.parse({}).theme_mode);
    const ev = configRecoveries();
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe('salvaged');
    expect(ev[0].keys?.sort()).toEqual(['background_opacity', 'theme_mode']);
  });

  it('a salvage is reported once per process, not on every read', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana', theme_mode: 'purple' }));
    await loadConfig();
    await loadConfig();
    expect(configRecoveries()).toHaveLength(1);
  });

  it('same-schema damage: the next write replaces the invalid value with its default', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana', theme_mode: 'purple' }));
    await updateConfig((c) => ({ ...c, realistic_typing: false }));
    const raw = await readJson();
    expect(raw.theme_mode).toBe(UserConfigSchema.parse({}).theme_mode);
  });

  it('listeners get replayed and live events', async () => {
    const seen: ConfigRecoveryEvent[] = [];
    await writeRaw('');
    await loadConfig();
    const off = onConfigRecovered((e) => seen.push(e));
    await writeRaw(JSON.stringify({ theme_mode: 'purple' }));
    await loadConfig();
    off();
    expect(seen.map((e) => e.kind)).toEqual(['reset_defaults', 'salvaged']);
  });
});

describe('downgrade safety (a file from a newer Sei)', () => {
  it('keeps unknown keys through writes', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana', future_flag: { a: 1 }, schema_version: 1 }));
    await updateConfig((c) => ({ ...c, realistic_typing: false }));
    const raw = await readJson();
    expect(raw.future_flag).toEqual({ a: 1 });
    expect(raw.realistic_typing).toBe(false);
    await saveConfig(UserConfigSchema.parse({ preferred_name: 'Bo' }));
    expect((await readJson()).future_flag).toEqual({ a: 1 });
  });

  it('keeps a value this build cannot read when the file is from a newer schema', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana', theme_mode: 'midnight-oled', schema_version: 99 }));
    const cfg = await loadConfig();
    expect(cfg.theme_mode).toBe(UserConfigSchema.parse({}).theme_mode);
    await updateConfig((c) => ({ ...c, realistic_typing: false }));
    const raw = await readJson();
    expect(raw.theme_mode).toBe('midnight-oled');
    expect(raw.schema_version).toBe(99);
  });

  it('but a value the user changed on this build wins', async () => {
    await writeRaw(JSON.stringify({ theme_mode: 'midnight-oled', schema_version: 99 }));
    await updateConfig((c) => ({ ...c, theme_mode: 'acorn' }));
    expect((await readJson()).theme_mode).toBe('acorn');
  });

  it('never lowers schema_version', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Ana', schema_version: 7 }));
    await updateConfig((c) => ({ ...c, preferred_name: 'Bo' }));
    expect((await readJson()).schema_version).toBe(7);
  });
});

describe('migrations', () => {
  it('stamps an unversioned config and is idempotent', () => {
    const once = migrateRawConfig({ preferred_name: 'Ana' });
    expect(once.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    const twice = migrateRawConfig(once);
    expect(twice).toEqual(once);
  });

  it('does not touch a newer file', () => {
    const raw = { preferred_name: 'Ana', schema_version: 50, extra: true };
    expect(migrateRawConfig(raw)).toEqual(raw);
  });

  it('treats a junk schema_version as unversioned', () => {
    expect(migrateRawConfig({ schema_version: 'x' }).schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(migrateRawConfig({ schema_version: -3 }).schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('parseConfigLenient on a valid object salvages nothing', () => {
    const r = parseConfigLenient({ preferred_name: 'Ana' });
    expect(r.salvaged).toEqual([]);
    expect(r.config.preferred_name).toBe('Ana');
  });
});

describe('extractIdentityKeys', () => {
  it('reads string, bool, number and array keys and skips the rest', () => {
    const got = extractIdentityKeys(
      '{"preferred_name":"Zoë","has_been_welcomed":false,"total_playtime_ms":9,"added_default_ids":["' + W1 + '"],"theme_mode":"dark"',
    );
    expect(got).toEqual({ preferred_name: 'Zoë', has_been_welcomed: false, total_playtime_ms: 9, added_default_ids: [W1] });
  });

  it('skips an array truncated mid-way', () => {
    expect(extractIdentityKeys('{"added_world_ids": ["a", "b')).toEqual({});
  });
});

describe('resetConfigKeepingIdentity', () => {
  it('keeps identity, resets preferences, moves the old file aside', async () => {
    await saveConfig(
      UserConfigSchema.parse({
        preferred_name: 'Ana',
        mc_username: 'ana_mc',
        ai_backend_kind: 'cloud-proxy',
        analytics_opt_out: true,
        added_world_ids: [W1],
        theme_mode: 'acorn',
        realistic_typing: false,
        avatar_mode: 'always',
        web_search_api_key: 'k',
      }),
    );
    // A future key too: a reset drops it.
    const raw = await readJson();
    await writeRaw(JSON.stringify({ ...raw, future_flag: 1 }));
    await resetConfigKeepingIdentity();
    const cfg = await loadConfig();
    const d = UserConfigSchema.parse({});
    expect(cfg.preferred_name).toBe('Ana');
    expect(cfg.mc_username).toBe('ana_mc');
    expect(cfg.ai_backend_kind).toBe('cloud-proxy');
    expect(cfg.analytics_opt_out).toBe(true);
    expect(cfg.added_world_ids).toEqual([W1]);
    expect(cfg.theme_mode).toBe(d.theme_mode);
    expect(cfg.realistic_typing).toBe(d.realistic_typing);
    expect(cfg.avatar_mode).toBeUndefined();
    expect(cfg.web_search_api_key).toBeUndefined();
    expect((await readJson()).future_flag).toBeUndefined();
    expect((await dirNames()).filter((n) => n.startsWith('config.before-reset-'))).toHaveLength(1);
  });

  it('works on a damaged file', async () => {
    await writeRaw('{"preferred_name": "Ana", "the');
    await resetConfigKeepingIdentity();
    expect((await loadConfig()).preferred_name).toBe('Ana');
  });

  it('works with no file at all', async () => {
    await resetConfigKeepingIdentity();
    expect(await loadConfig()).toEqual({ ...UserConfigSchema.parse({}), schema_version: CONFIG_SCHEMA_VERSION });
  });
});


describe('a damaged file in a folder that cannot be written (T280)', () => {
  const canTestReadOnly = typeof process.getuid === 'function' && process.getuid() !== 0 && process.platform !== 'win32';

  it.skipIf(!canTestReadOnly)('recovers in memory on every read but reports it once per process', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Kept' }), bakPath());
    await writeRaw('{"preferred_name": "x", broken');
    const dir = path.dirname(cfgPath());
    const seen: ConfigRecoveryEvent[] = [];
    onConfigRecovered((e) => seen.push(e));
    await chmod(dir, 0o555);
    try {
      const a = await loadConfig();
      const b = await loadConfig();
      const c = await loadConfig();
      expect(a.preferred_name).toBe('Kept');
      expect(b.preferred_name).toBe('Kept');
      expect(c.preferred_name).toBe('Kept');
      // The damaged file is still there (nothing could move or replace it).
      expect(await readFile(cfgPath(), 'utf8')).toContain('broken');
    } finally {
      await chmod(dir, 0o755);
    }
    expect(seen.map((e) => e.kind)).toEqual(['restored_backup']);
    expect(configRecoveries()).toHaveLength(1);
  });

  it.skipIf(!canTestReadOnly)('no backup either: reset_defaults once, not per read', async () => {
    await writeRaw('{ nothing readable');
    const dir = path.dirname(cfgPath());
    await chmod(dir, 0o555);
    try {
      await loadConfig();
      await loadConfig();
    } finally {
      await chmod(dir, 0o755);
    }
    expect(configRecoveries().map((e) => e.kind)).toEqual(['reset_defaults']);
  });

  it('a writable folder still reports a second, separate damage', async () => {
    await writeRaw(JSON.stringify({ preferred_name: 'Kept' }), bakPath());
    await writeRaw('{ broken');
    await loadConfig();
    await writeRaw('{ broken again');
    await loadConfig();
    expect(configRecoveries().map((e) => e.kind)).toEqual(['restored_backup', 'restored_backup']);
  });
});
