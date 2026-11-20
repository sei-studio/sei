/**
 * 261031 (T278 review): the PostHog identity call sequence, end to end with
 * posthog-node mocked. Every capture / alias / identify the app makes is
 * replayed through `PostHogPersons`, a small model of PostHog's person-merge
 * rules, so a sequence PostHog would refuse (or one that orphans day-0
 * events from the account) fails here instead of in the retention numbers.
 *
 * The rules modelled (PostHog docs, "Identifying users" / alias, and the
 * person-merge restrictions in its ingestion pipeline):
 *   - capture(D) creates an anonymous person for an unseen D.
 *   - alias({distinctId: D, alias: A}) merges A's person into D's and marks
 *     D's person identified. It is REFUSED when A was itself the distinctId
 *     of an earlier alias, or when A's person is already identified and is a
 *     different person from D's (an identified person never merges into
 *     another). When D has no person yet, D is simply added to A's person,
 *     identified or not: aliasing an already-merged anonymous id into a NEW
 *     account therefore joins two accounts into one person (`joined`).
 *   - identify(D) is modelled as marking D's person identified (stricter
 *     than posthog-node, whose identify without $anon_distinct_id only sets
 *     person properties).
 *
 * `scripts/posthog-identity-check.mjs` sends the same sequences to a SCRATCH
 * PostHog project for a by-hand check against the real server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call =
  | { op: 'capture'; distinctId: string; event: string }
  | { op: 'alias'; distinctId: string; alias: string }
  | { op: 'identify'; distinctId: string };

const h = vi.hoisted(() => ({
  calls: [] as Array<
    | { op: 'capture'; distinctId: string; event: string }
    | { op: 'alias'; distinctId: string; alias: string }
    | { op: 'identify'; distinctId: string }
  >,
  props: [] as Array<Record<string, unknown>>,
  app: { getVersion: () => '0.7.0', isPackaged: true as boolean },
  cfg: { value: {} as Record<string, unknown> },
  deviceIdFails: { value: false },
}));

vi.mock('electron', () => ({ app: h.app }));
vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(m: { distinctId: string; event: string; properties: Record<string, unknown> }) {
      h.calls.push({ op: 'capture', distinctId: m.distinctId, event: m.event });
      h.props.push(m.properties);
    }
    alias(m: { distinctId: string; alias: string }) {
      h.calls.push({ op: 'alias', distinctId: m.distinctId, alias: m.alias });
    }
    identify(m: { distinctId: string }) {
      h.calls.push({ op: 'identify', distinctId: m.distinctId });
    }
    shutdown = vi.fn(async () => {});
  },
}));
vi.mock('./configStore', () => ({
  loadConfig: vi.fn(async () => h.cfg.value),
  updateConfig: vi.fn(async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
    h.cfg.value = fn(h.cfg.value);
    return h.cfg.value;
  }),
}));
vi.mock('./apiKeyStore', () => ({
  getAiBackendKind: vi.fn(async () => 'local'),
  onAiBackendKindChanged: vi.fn(),
}));
vi.mock('./auth/deviceId', async (orig) => {
  const real = await orig<typeof import('./auth/deviceId')>();
  return {
    ...real,
    getDeviceId: async () => {
      if (h.deviceIdFails.value) throw new Error('keychain unavailable');
      return real.getDeviceId();
    },
  };
});

/** PostHog's person-merge rules, as far as the app's calls touch them. */
class PostHogPersons {
  private personOf = new Map<string, number>();
  private identified = new Set<number>();
  private aliasTargets = new Set<string>();
  private next = 1;
  readonly refused: string[] = [];
  readonly joined: string[] = [];

  private person(id: string): number {
    let p = this.personOf.get(id);
    if (p === undefined) {
      p = this.next++;
      this.personOf.set(id, p);
    }
    return p;
  }

  apply(c: Call): void {
    if (c.op === 'capture') {
      this.person(c.distinctId);
    } else if (c.op === 'identify') {
      this.identified.add(this.person(c.distinctId));
    } else {
      const { distinctId: d, alias: a } = c;
      if (this.aliasTargets.has(a)) {
        this.refused.push(`${a} was already the distinctId of an alias`);
      } else {
        const pd = this.personOf.get(d);
        const pa = this.personOf.get(a);
        if (pd !== undefined && pa !== undefined && pd !== pa && this.identified.has(pa)) {
          this.refused.push(`${a} is an identified person; refused merge into ${d}`);
        } else if (pd === undefined && pa === undefined) {
          const p = this.person(d);
          this.personOf.set(a, p);
          this.identified.add(p);
        } else if (pd === undefined) {
          if (this.identified.has(pa!)) this.joined.push(`${d} added to the identified person of ${a}`);
          this.personOf.set(d, pa!);
          this.identified.add(pa!);
        } else if (pa === undefined) {
          this.personOf.set(a, pd);
          this.identified.add(pd);
        } else {
          for (const [id, p] of this.personOf) if (p === pa) this.personOf.set(id, pd);
          this.identified.add(pd);
        }
      }
      this.aliasTargets.add(d);
    }
  }

  same(a: string, b: string): boolean {
    const pa = this.personOf.get(a);
    return pa !== undefined && pa === this.personOf.get(b);
  }
}

/** Replay `history` (another machine, an earlier build) then the app's calls. */
function replay(history: Call[] = []): PostHogPersons {
  const ph = new PostHogPersons();
  for (const c of [...history, ...h.calls]) ph.apply(c);
  return ph;
}

let userData: string;

async function launch(): Promise<typeof import('./analytics')> {
  vi.resetModules();
  const { _setUserDataOverride } = await import('./paths');
  _setUserDataOverride(userData);
  const { _resetDeviceIdCacheForTests } = await import('./auth/deviceId');
  _resetDeviceIdCacheForTests();
  const a = await import('./analytics');
  await a.initAnalytics();
  return a;
}

/** What a first launch sends before sign-in (onboarding runs signed out). */
function dayZero(a: typeof import('./analytics')): void {
  a.capture('installer_first_launch', {});
  a.capture('app_opened', {});
  a.capture('onboarding_step', { step: 'intro' });
}

const ops = (): string[] =>
  h.calls.filter((c) => c.op !== 'capture').map((c) => (c.op === 'alias' ? `alias(${c.distinctId}<-${c.alias})` : `identify(${c.distinctId})`));

const lastDistinct = (): string => {
  const caps = h.calls.filter((c) => c.op === 'capture');
  return caps[caps.length - 1].distinctId;
};

const dayZeroIds = (): string[] =>
  h.calls
    .filter((c): c is Extract<Call, { op: 'capture' }> => c.op === 'capture')
    .filter((c) => ['installer_first_launch', 'app_opened', 'onboarding_step'].includes(c.event))
    .map((c) => c.distinctId);

beforeEach(() => {
  userData = mkdtempSync(path.join(os.tmpdir(), 'sei-identity-'));
  h.calls.length = 0;
  h.props.length = 0;
  h.cfg.value = { analytics_opt_out: false, preferred_name: 'Sam' };
  h.deviceIdFails.value = false;
  vi.stubEnv('SEI_ANALYTICS_DEV', '');
  vi.stubEnv('SEI_RELEASE_CHANNEL', 'sei-channel=stable');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(userData, { recursive: true, force: true });
});

describe('(a) fresh install, never signs in', () => {
  it('captures on the device id, aliases and identifies nothing, mints no install id', async () => {
    let a = await launch();
    dayZero(a);
    const device = lastDistinct();
    expect(device).toMatch(/^[0-9a-f]{32}$/);
    expect(h.props.at(-1)!.device_id).toBe(device);
    a = await launch();
    a.capture('app_opened', {});
    expect(lastDistinct()).toBe(device);
    expect(ops()).toEqual([]);
    expect(h.cfg.value.analytics_install_id).toBeUndefined();
  });
});

describe('(b) fresh install, then signs in to a NEW account', () => {
  it('alias(user <- device) then identify(user); the day-0 events join the account', async () => {
    const a = await launch();
    dayZero(a);
    const device = lastDistinct();
    a.identifyUser('user-new');
    a.capture('signed_in', {});
    expect(ops()).toEqual([`alias(user-new<-${device})`, 'identify(user-new)']);
    expect(lastDistinct()).toBe('user-new');
    expect(h.props.at(-1)!.device_id).toBe(device);
    const ph = replay();
    expect(ph.refused).toEqual([]);
    for (const id of dayZeroIds()) expect(ph.same(id, 'user-new')).toBe(true);
  });

  it('a restored session on every later launch repeats the same pair, which PostHog accepts', async () => {
    let a = await launch();
    dayZero(a);
    a.identifyUser('user-new');
    a = await launch();
    a.identifyUser('user-new');
    a.capture('app_opened', {});
    a.resetUser();
    a.capture('signed_out', {});
    const ph = replay();
    expect(ph.refused).toEqual([]);
    // Signed out, the device id is still the account's person.
    expect(ph.same(lastDistinct(), 'user-new')).toBe(true);
  });
});

describe('(c) fresh install, then signs in to an EXISTING account', () => {
  it('the device person merges into the account person from another machine', async () => {
    const otherMachine: Call[] = [
      { op: 'capture', distinctId: 'old-install-elsewhere', event: 'app_opened' },
      { op: 'alias', distinctId: 'user-old', alias: 'old-install-elsewhere' },
      { op: 'identify', distinctId: 'user-old' },
      { op: 'capture', distinctId: 'user-old', event: 'chat_session_started' },
    ];
    const a = await launch();
    dayZero(a);
    const device = lastDistinct();
    a.identifyUser('user-old');
    expect(ops()).toEqual([`alias(user-old<-${device})`, 'identify(user-old)']);
    const ph = replay(otherMachine);
    expect(ph.refused).toEqual([]);
    for (const id of dayZeroIds()) expect(ph.same(id, 'user-old')).toBe(true);
    expect(ph.same('old-install-elsewhere', 'user-old')).toBe(true);
  });
});

describe('(d) an anonymous install from before 261031, then signs in', () => {
  it('keeps its install id as the distinct id (device_id a property) and aliases only it', async () => {
    const before: Call[] = [
      { op: 'capture', distinctId: 'install-legacy-1', event: 'installer_first_launch' },
      { op: 'capture', distinctId: 'install-legacy-1', event: 'app_opened' },
    ];
    h.cfg.value = { ...h.cfg.value, analytics_install_id: 'install-legacy-1' };
    const a = await launch();
    a.capture('app_opened', {});
    expect(lastDistinct()).toBe('install-legacy-1');
    expect(h.props.at(-1)!.device_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ops()).toEqual([]);
    a.identifyUser('user-9');
    expect(ops()).toEqual(['alias(user-9<-install-legacy-1)', 'identify(user-9)']);
    const ph = replay(before);
    expect(ph.refused).toEqual([]);
    expect(ph.same('install-legacy-1', 'user-9')).toBe(true);
  });
});

describe('invariants', () => {
  it('the anonymous id is never the distinctId of an alias or of identify', async () => {
    const a = await launch();
    dayZero(a);
    const device = lastDistinct();
    a.identifyUser('user-1');
    a.resetUser();
    a.identifyUser('user-1');
    for (const c of h.calls) {
      if (c.op === 'alias' || c.op === 'identify') expect(c.distinctId).not.toBe(device);
    }
  });

  it('a device id that cannot be read falls back to a minted install id', async () => {
    h.deviceIdFails.value = true;
    const a = await launch();
    a.capture('app_opened', {});
    const installId = h.cfg.value.analytics_install_id as string;
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastDistinct()).toBe(installId);
    expect(h.props.at(-1)!.device_id).toBeNull();
    a.identifyUser('user-2');
    expect(ops()).toEqual([`alias(user-2<-${installId})`, 'identify(user-2)']);
  });

  it('a second account on one device is identified only, never aliased into the first', async () => {
    let a = await launch();
    dayZero(a);
    const device = lastDistinct();
    a.identifyUser('user-a');
    a.resetUser();
    a.identifyUser('user-b');
    // The guard is on disk too: a later launch signing in to a third account.
    a = await launch();
    a.identifyUser('user-c');
    a.identifyUser('user-a');
    expect(ops()).toEqual([
      `alias(user-a<-${device})`,
      'identify(user-a)',
      'identify(user-b)',
      'identify(user-c)',
      `alias(user-a<-${device})`,
      'identify(user-a)',
    ]);
    const ph = replay();
    expect(ph.refused).toEqual([]);
    expect(ph.joined).toEqual([]);
    expect(ph.same('user-a', 'user-b')).toBe(false);
    for (const id of dayZeroIds()) expect(ph.same(id, 'user-a')).toBe(true);
  });

  it('the model catches the pre-review sequence (alias at init, then sign-in to an existing account)', () => {
    const ph = new PostHogPersons();
    for (const c of [
      { op: 'capture', distinctId: 'dev-1', event: 'installer_first_launch' },
      { op: 'alias', distinctId: 'dev-1', alias: 'inst-1' },
      { op: 'capture', distinctId: 'user-old', event: 'app_opened' },
      { op: 'identify', distinctId: 'user-old' },
      { op: 'alias', distinctId: 'user-old', alias: 'dev-1' },
    ] as Call[]) {
      ph.apply(c);
    }
    expect(ph.refused).toHaveLength(1);
    expect(ph.same('dev-1', 'user-old')).toBe(false);
  });
});
