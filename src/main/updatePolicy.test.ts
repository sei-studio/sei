/**
 * updatePolicy.test.ts — quick/260604-uoy Task 2.
 *
 * Locks in the pure policy decisions that gate the in-app updater:
 *   - deriveLevel: minor/major → optional, patch-only → mandatory, equal /
 *     downgrade / invalid → none, multi-version skip with a minor diff →
 *     optional (the skipped patch rides inside the minor).
 *   - isPatchOnlyBump: forward patch-only true; minor/major/equal/down false.
 *   - normalizeApply: 'now' passes through; everything else → 'on-restart'.
 *   - shouldShowWhatsNew: patch-only forward bump only.
 *   - isMissingReleaseArtifacts: a feed entry with no installable build behind
 *     it (draft release's tag, tag ahead of its build) reads as "no update",
 *     while real failures still surface as errors.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveLevel,
  isMissingReleaseArtifacts,
  isPatchOnlyBump,
  normalizeApply,
  shouldShowWhatsNew,
} from './updatePolicy';

/** Build an error shaped like electron-updater's `newError(message, code)`. */
function updaterError(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) (err as Error & { code?: string }).code = code;
  return err;
}

describe('deriveLevel', () => {
  it('patch-only bump → mandatory', () => {
    expect(deriveLevel('0.1.1', '0.1.2')).toBe('mandatory');
    expect(deriveLevel('0.1.1', '0.1.5')).toBe('mandatory');
    expect(deriveLevel('1.4.0', '1.4.1')).toBe('mandatory');
  });

  it('minor bump → optional', () => {
    expect(deriveLevel('0.1.1', '0.2.0')).toBe('optional');
    expect(deriveLevel('1.0.0', '1.1.0')).toBe('optional');
  });

  it('major bump → optional', () => {
    expect(deriveLevel('0.1.1', '1.0.0')).toBe('optional');
    expect(deriveLevel('1.9.9', '2.0.0')).toBe('optional');
  });

  it('multi-version skip with a minor diff → optional (skipped patch rides along)', () => {
    // On 0.1.1, latest 0.2.0 — the minor component moved, so even though a
    // patch was skipped (0.1.2), the level is optional, not mandatory.
    expect(deriveLevel('0.1.1', '0.2.0')).toBe('optional');
    // On 0.1.1, latest 0.2.3 — minor moved AND patch moved → still optional.
    expect(deriveLevel('0.1.1', '0.2.3')).toBe('optional');
  });

  it('equal version → none', () => {
    expect(deriveLevel('0.1.2', '0.1.2')).toBe('none');
    expect(deriveLevel('1.0.0', '1.0.0')).toBe('none');
  });

  it('downgrade → none (never act on an older remote version)', () => {
    expect(deriveLevel('0.2.0', '0.1.1')).toBe('none');
    expect(deriveLevel('1.0.0', '0.9.9')).toBe('none');
  });

  it('invalid / unparseable versions → none (defensive)', () => {
    expect(deriveLevel('0.1.1', 'not-a-version')).toBe('none');
    expect(deriveLevel('garbage', '0.1.2')).toBe('none');
    expect(deriveLevel('', '0.1.2')).toBe('none');
  });

  it('tolerates a leading v prefix', () => {
    expect(deriveLevel('v0.1.1', 'v0.1.2')).toBe('mandatory');
    expect(deriveLevel('v0.1.1', 'v0.2.0')).toBe('optional');
  });
});

describe('isPatchOnlyBump', () => {
  it('true for a forward patch-only bump', () => {
    expect(isPatchOnlyBump('0.1.1', '0.1.2')).toBe(true);
    expect(isPatchOnlyBump('1.4.0', '1.4.9')).toBe(true);
  });

  it('false for minor or major bumps', () => {
    expect(isPatchOnlyBump('0.1.1', '0.2.0')).toBe(false);
    expect(isPatchOnlyBump('0.1.1', '1.0.0')).toBe(false);
  });

  it('false for equal versions and downgrades', () => {
    expect(isPatchOnlyBump('0.1.2', '0.1.2')).toBe(false);
    expect(isPatchOnlyBump('0.1.2', '0.1.1')).toBe(false);
  });

  it('false for invalid versions', () => {
    expect(isPatchOnlyBump('0.1.1', 'nope')).toBe(false);
    expect(isPatchOnlyBump('', '0.1.2')).toBe(false);
  });
});

describe('normalizeApply', () => {
  it("passes 'now' through", () => {
    expect(normalizeApply('now')).toBe('now');
  });

  it("defaults to 'on-restart' for the literal", () => {
    expect(normalizeApply('on-restart')).toBe('on-restart');
  });

  it("defaults to 'on-restart' for absent / invalid / wrong-type input", () => {
    expect(normalizeApply(undefined)).toBe('on-restart');
    expect(normalizeApply(null)).toBe('on-restart');
    expect(normalizeApply('')).toBe('on-restart');
    expect(normalizeApply('NOW')).toBe('on-restart');
    expect(normalizeApply('immediately')).toBe('on-restart');
    expect(normalizeApply(42)).toBe('on-restart');
    expect(normalizeApply({})).toBe('on-restart');
  });
});

describe('shouldShowWhatsNew', () => {
  it('true only for a patch-only forward bump', () => {
    expect(shouldShowWhatsNew('0.1.1', '0.1.2')).toBe(true);
  });

  it('false for minor/major bumps (changelog was shown up front)', () => {
    expect(shouldShowWhatsNew('0.1.1', '0.2.0')).toBe(false);
    expect(shouldShowWhatsNew('0.1.1', '1.0.0')).toBe(false);
  });

  it('false when lastSeen is null (fresh install / first launch)', () => {
    expect(shouldShowWhatsNew(null, '0.1.2')).toBe(false);
  });

  it('false for equal versions and downgrades', () => {
    expect(shouldShowWhatsNew('0.1.2', '0.1.2')).toBe(false);
    expect(shouldShowWhatsNew('0.2.0', '0.1.1')).toBe(false);
  });
});

describe('isMissingReleaseArtifacts', () => {
  it('true for the draft-tag case: channel file 404s on the newest feed entry', () => {
    // Verbatim shape from GitHubProvider.getLatestVersion (260725, v0.5.0-beta.1
    // sat in draft while its tag was already public in releases.atom).
    const err = updaterError(
      'Cannot find beta-mac.yml in the latest release artifacts ' +
        '(https://github.com/sei-studio/sei/releases/download/v0.5.0-beta.1/beta-mac.yml): ' +
        'HttpError: 404 Not Found',
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    );
    expect(isMissingReleaseArtifacts(err)).toBe(true);
  });

  it('true for a repo with no published versions', () => {
    expect(
      isMissingReleaseArtifacts(
        updaterError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'),
      ),
    ).toBe(true);
  });

  it('true from the message alone when the code is lost in re-wrapping', () => {
    expect(
      isMissingReleaseArtifacts(
        updaterError('Cannot find latest-mac.yml in the latest release artifacts (...): 404'),
      ),
    ).toBe(true);
    expect(isMissingReleaseArtifacts('No published versions on GitHub')).toBe(true);
  });

  it('false for real failures that must still surface as "check failed"', () => {
    expect(isMissingReleaseArtifacts(updaterError('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
    expect(isMissingReleaseArtifacts(updaterError('HttpError: 500 Internal Server Error'))).toBe(false);
    expect(
      isMissingReleaseArtifacts(updaterError('Cannot parse releases feed', 'ERR_UPDATER_INVALID_RELEASE_FEED')),
    ).toBe(false);
    expect(isMissingReleaseArtifacts(updaterError('sha512 checksum mismatch'))).toBe(false);
  });

  it('false for null, undefined, and non-error junk', () => {
    expect(isMissingReleaseArtifacts(null)).toBe(false);
    expect(isMissingReleaseArtifacts(undefined)).toBe(false);
    expect(isMissingReleaseArtifacts({})).toBe(false);
    expect(isMissingReleaseArtifacts(42)).toBe(false);
  });
});
