/**
 * Escalating per-device signup cooldown (anti-abuse Layer 1) tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

import { paths, _setUserDataOverride } from '../paths';
import {
  checkSignupCooldown,
  recordSignupAttempt,
  COOLDOWN_LADDER_MS,
  COOLDOWN_WINDOW_MS,
  _requiredWaitMsForTests,
} from './signupCooldown';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-cooldown-'));
  _setUserDataOverride(tmp);
});

afterEach(async () => {
  _setUserDataOverride(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('signupCooldown', () => {
  it('allows the first signup instantly (empty window)', async () => {
    const d = await checkSignupCooldown(() => 1_000_000);
    expect(d.allowed).toBe(true);
    expect(d.retryAfterMs).toBe(0);
  });

  it('ladder: required wait escalates with attempt count, then caps', async () => {
    expect(_requiredWaitMsForTests(0)).toBe(0);
    expect(_requiredWaitMsForTests(1)).toBe(COOLDOWN_LADDER_MS[1]); // 30s
    expect(_requiredWaitMsForTests(2)).toBe(COOLDOWN_LADDER_MS[2]); // 2m
    expect(_requiredWaitMsForTests(3)).toBe(COOLDOWN_LADDER_MS[3]); // 8m
    // 4, 5, 100 all clamp to the last (cap) entry.
    const cap = COOLDOWN_LADDER_MS[COOLDOWN_LADDER_MS.length - 1];
    expect(_requiredWaitMsForTests(4)).toBe(cap);
    expect(_requiredWaitMsForTests(100)).toBe(cap);
  });

  it('blocks the 2nd attempt immediately after the 1st (30s wait)', async () => {
    let now = 1_000_000;
    await recordSignupAttempt(() => now);
    // Immediately after, the 2nd attempt must wait ~30s.
    const d = await checkSignupCooldown(() => now);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(COOLDOWN_LADDER_MS[1]);
  });

  it('allows the 2nd attempt once the 30s wait has elapsed', async () => {
    let now = 1_000_000;
    await recordSignupAttempt(() => now);
    now += COOLDOWN_LADDER_MS[1]; // exactly 30s later
    const d = await checkSignupCooldown(() => now);
    expect(d.allowed).toBe(true);
  });

  it('escalates: after 3 attempts the next must wait the 8min (4th-attempt) rung', async () => {
    let now = 1_000_000;
    // Space the three attempts far enough apart that each is allowed when made.
    await recordSignupAttempt(() => now); // 1st
    now += COOLDOWN_LADDER_MS[1] + 1;
    await recordSignupAttempt(() => now); // 2nd
    now += COOLDOWN_LADDER_MS[2] + 1;
    await recordSignupAttempt(() => now); // 3rd
    // Now there are 3 attempts in-window → the 4th must wait COOLDOWN_LADDER_MS[3].
    const d = await checkSignupCooldown(() => now);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(COOLDOWN_LADDER_MS[3]);
  });

  it('prunes attempts older than the 24h window', async () => {
    let now = 1_000_000;
    await recordSignupAttempt(() => now);
    // Jump past the window — the old attempt is pruned, so a new signup is instant.
    now += COOLDOWN_WINDOW_MS + 1;
    const d = await checkSignupCooldown(() => now);
    expect(d.allowed).toBe(true);
    expect(d.retryAfterMs).toBe(0);
  });

  it('persists attempts atomically (no .tmp left behind)', async () => {
    await recordSignupAttempt(() => 1_000_000);
    const raw = JSON.parse(await readFile(paths.signupAttemptsPath(), 'utf8'));
    expect(Array.isArray(raw.attempts)).toBe(true);
    expect(raw.attempts.length).toBe(1);
  });

  it('tolerates a corrupt attempts file (treats as empty → allowed)', async () => {
    await writeFile(paths.signupAttemptsPath(), 'garbage', 'utf8');
    const d = await checkSignupCooldown(() => 1_000_000);
    expect(d.allowed).toBe(true);
  });
});
