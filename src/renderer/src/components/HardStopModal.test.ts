/**
 * Tests for HardStopModal — the two hard-stop presentations and the
 * auto-dismiss guard (260725 regression fixes).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style file presence checks. Mirrors
 * src/renderer/src/screens/SettingsScreen.test.tsx.
 *
 * Invariants:
 *   H.1 — auto-dismiss is NOT the bare `!over_limit` check. A hard-stop push
 *         carries no snapshot, so the store's over_limit is stale (normally
 *         false) and the popup used to unmount on its first effect run.
 *   H.2 — the modal refreshes credits when a stop arrives and only trusts that
 *         fresh, non-failed snapshot.
 *   H.3 — 'rate_limited' has its own branch: its own copy, the retry time from
 *         rateLimitedUntil, and NO billing CTAs.
 *   H.4 — the rate-limited branch is immune to the over_limit auto-dismiss.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'HardStopModal.tsx'), 'utf-8');

describe('HardStopModal', () => {
  it('H.1: auto-dismiss is not the bare !over_limit check', () => {
    // The exact regression: `if (hardStopActive && !overLimit) acknowledge()`.
    expect(SRC.includes('if (hardStopActive && !overLimit) acknowledgeHardStop()')).toBe(false);
    // Dismissal requires a limit that was CONFIRMED first.
    expect(SRC.includes('confirmedOverLimit && !overLimit')).toBe(true);
  });

  it('H.2: a hard stop pulls a fresh snapshot, and a failed one cannot dismiss', () => {
    expect(SRC.includes('s.refresh')).toBe(true);
    expect(SRC.includes('void refresh()')).toBe(true);
    expect(SRC.includes('snapshotFailed')).toBe(true);
    expect(SRC.includes('snapshotFresh')).toBe(true);
  });

  it('H.3: rate_limited renders its own copy with the retry time and no billing CTAs', () => {
    expect(SRC.includes("hardStopReason === 'rate_limited'")).toBe(true);
    expect(SRC.includes('rateLimitedUntil')).toBe(true);
    expect(SRC.includes('formatRetryWhen(rateLimitedUntil')).toBe(true);
    // The branch returns before the depleted body, so its only CTA is Close.
    const branch = SRC.slice(
      SRC.indexOf('if (isRateLimited) {'),
      SRC.indexOf('const handleUpgrade'),
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.includes('handleTopUp')).toBe(false);
    expect(branch.includes('handleUpgrade')).toBe(false);
  });

  it('H.4: the rate-limited branch is immune to the over_limit auto-dismiss', () => {
    expect(SRC.includes('if (!hardStopActive || isRateLimited) return;')).toBe(true);
  });

  it('H.5: no em dash in the rate-limited body copy', () => {
    const start = SRC.indexOf('const retryWhen');
    const branch = SRC.slice(start, SRC.indexOf('</ModalShell>', start));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.includes('—')).toBe(false);
  });
});
