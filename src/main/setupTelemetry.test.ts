import { describe, expect, it } from 'vitest';
import type { McInstall, WizardProgressEvent } from '../shared/ipc';
import type { SetupStepInput } from '../shared/setupTelemetry';
import {
  createDedupedSink,
  observeWizardProgress,
  sanitizeRendererSetupProps,
  trackMcScan,
  trackStardewScan,
  trackStartMinecraft,
} from './setupTelemetry';

function recorder(): { sink: (i: SetupStepInput) => void; events: SetupStepInput[] } {
  const events: SetupStepInput[] = [];
  return { sink: (i) => events.push(i), events };
}

describe('observeWizardProgress', () => {
  it('folds a successful run into per-stage start/ok and one wizard ok', () => {
    const { sink, events } = recorder();
    const seen: WizardProgressEvent[] = [];
    let t = 1000;
    const on = observeWizardProgress((ev) => seen.push(ev), () => 'vanilla', sink, () => t);
    const id = 'i1';
    on({ installId: id, stage: 'queued' });
    on({ installId: id, stage: 'fabric-downloading', pct: 0 });
    on({ installId: id, stage: 'fabric-downloading', pct: 50 });
    on({ installId: id, stage: 'fabric-installing' });
    on({ installId: id, stage: 'mods-linking', scanned: 0, linked: 0, excluded: 0, totalEstimate: null });
    on({ installId: id, stage: 'mod-downloading', pct: 0 });
    on({ installId: id, stage: 'mod-placing' });
    on({ installId: id, stage: 'config-writing' });
    t = 6000;
    on({ installId: id, stage: 'done' });
    expect(seen).toHaveLength(9);
    expect(events.map((e) => `${e.step}:${e.outcome}`)).toEqual([
      'wizard:start',
      'fabric:start',
      'fabric:ok',
      'mods_link:start',
      'mods_link:ok',
      'skin_mod:start',
      'skin_mod:ok',
      'config:start',
      'config:ok',
      'wizard:ok',
    ]);
    expect(events.every((e) => e.game === 'minecraft' && e.store === 'vanilla')).toBe(true);
    expect(events.at(-1)?.wait_ms).toBe(5000);
  });

  it('reports the failing stage with its error class and a closed reason', () => {
    const { sink, events } = recorder();
    const on = observeWizardProgress(() => {}, () => 'curseforge', sink, () => 0);
    on({ installId: 'x', stage: 'queued' });
    on({ installId: 'x', stage: 'fabric-downloading', pct: 0 });
    on({ installId: 'x', stage: 'failed', error: 'FABRIC_INSTALL_FAILED', message: 'getaddrinfo ENOTFOUND meta.fabricmc.net' });
    expect(events.slice(-2)).toEqual([
      { game: 'minecraft', store: 'curseforge', step: 'fabric', outcome: 'fail', error_code: 'FABRIC_INSTALL_FAILED', reason: 'network' },
      { game: 'minecraft', store: 'curseforge', step: 'wizard', outcome: 'fail', error_code: 'FABRIC_INSTALL_FAILED', reason: 'network', wait_ms: 0 },
    ]);
  });

  it('passes events through even when the sink throws', () => {
    const seen: WizardProgressEvent[] = [];
    const on = observeWizardProgress((ev) => seen.push(ev), () => undefined, () => {
      throw new Error('boom');
    });
    on({ installId: 'x', stage: 'queued' });
    on({ installId: 'x', stage: 'cancelled' });
    expect(seen).toHaveLength(2);
  });
});

describe('trackMcScan', () => {
  it('sends one event per distinct answer', () => {
    const { sink, events } = recorder();
    const deduped = createDedupedSink(sink);
    const extras = { others: [{ launcher: 'prism' as const, label: 'My pack', mc_version: '1.21.1', loader: 'fabric' as const }], bedrock: true, launcherInstalled: false };
    trackMcScan([], extras, deduped);
    trackMcScan([], extras, deduped);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ step: 'install_scan', outcome: 'fail', found: 'other_launcher', error_code: 'MC_SCAN_OTHER_LAUNCHER', store: 'prism', bedrock: true, launchers: ['prism'] });
    expect(JSON.stringify(events[0])).not.toContain('My pack');
    trackMcScan([{ id: 'a', kind: 'vanilla' } as McInstall], extras, deduped);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ outcome: 'ok', found: 'java', store: 'vanilla', error_code: null });
  });
});

describe('trackStartMinecraft', () => {
  it('names the launcher on ok and the reason on fail', () => {
    const { sink, events } = recorder();
    trackStartMinecraft({ ok: true, profileName: 'Sei 1.21.4', mcVersion: '1.21.4', launcher: 'windows-store', alreadyOpen: false }, sink);
    trackStartMinecraft({ ok: false, reason: 'no_launcher', profileName: 'Sei 1.21.4' }, sink);
    expect(events).toEqual([
      { game: 'minecraft', step: 'start_minecraft', outcome: 'ok', store: 'windows-store' },
      { game: 'minecraft', step: 'start_minecraft', outcome: 'fail', error_code: 'MC_START_NO_LAUNCHER', store: 'none' },
    ]);
  });
});

describe('trackStardewScan', () => {
  it('reports found/not found with the store, deduped', () => {
    const { sink, events } = recorder();
    const deduped = createDedupedSink(sink);
    const base = { smapiInstalled: false, modInstalled: false, ready: false };
    trackStardewScan({ ...base, gamePath: null, store: 'unknown' }, deduped);
    trackStardewScan({ ...base, gamePath: null, store: 'unknown' }, deduped);
    trackStardewScan({ ...base, gamePath: 'D:\\XboxGames\\Stardew Valley\\Content', store: 'xbox' }, deduped);
    expect(events).toEqual([
      { game: 'stardew', step: 'find_game', outcome: 'fail', error_code: 'GAME_NOT_INSTALLED', store: 'unknown' },
      { game: 'stardew', step: 'find_game', outcome: 'ok', error_code: null, store: 'xbox' },
    ]);
  });
});

describe('sanitizeRendererSetupProps', () => {
  it('rebuilds renderer props from the closed set', () => {
    expect(
      sanitizeRendererSetupProps({ game: 'minecraft', step: 'lan_wait', outcome: 'fail', error_code: 'LAN_WAIT_CLOSED', ended: 'closed', wait_ms: 12, note: 'C:\\Users\\bob' }),
    ).toEqual({ game: 'minecraft', step: 'lan_wait', outcome: 'fail', error_code: 'LAN_WAIT_CLOSED', ended: 'closed', wait_ms: 12 });
  });
});
