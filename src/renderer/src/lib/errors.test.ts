/**
 * 260806 — modded-host classification.
 *
 * A NeoForge 1.20.1 world kicked one user's summon five times in four minutes.
 * Every attempt was classified LAN_NOT_OPEN and opened the "press Esc, choose
 * Open to LAN" popup for a world that was open and answering status pings; they
 * re-opened it four times. The kick text said "This server has mods that require
 * NeoForge to be installed on the client" and nothing in the product read it.
 *
 * The predicate is duplicated in three places by design (the bot's connect.js
 * runs in the utilityProcess, main's classifyChildError in the Electron host,
 * and this one in the renderer, with no shared module between the three). These
 * tests pin the renderer copy against the same strings connect.humanize.test.js
 * pins the bot copy against, so the three cannot drift apart silently.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ERROR_COPY,
  FRIENDLY_ERROR_COPY,
  classifyRendererError,
  errorCopyText,
  userFacingDetail,
  userFacingError,
} from './errors';
import { useLangStore } from './i18n';
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import { ALL_ERROR_CLASSES } from '@shared/errorClasses';
import { WIZARD_MAX_MC } from '@shared/mcSetup';

const NEOFORGE_KICK = 'This server has mods that require NeoForge to be installed on the client.';

describe('classifyRendererError — modded hosts', () => {
  it('classifies the NeoForge kick, not LAN_NOT_OPEN', () => {
    expect(classifyRendererError(new Error(NEOFORGE_KICK)).class).toBe('MODDED_HOST_REJECTED');
  });

  it('classifies the tagged error the bot emits', () => {
    expect(
      classifyRendererError(new Error('MODDED_HOST_REJECTED: This world runs Forge or NeoForge')).class,
    ).toBe('MODDED_HOST_REJECTED');
  });

  it('classifies Forge, FML and Fabric wordings', () => {
    for (const msg of [
      'Incompatible FML modded server',
      'Please install Forge to connect',
      'This server requires the following mods: create, jei',
    ]) {
      expect(classifyRendererError(new Error(msg)).class).toBe('MODDED_HOST_REJECTED');
    }
  });

  // The ordering constraint: the modded branch has to come BEFORE the LAN branch,
  // because the kick text contains both "kicked" and (often) "connect".
  it('wins over the LAN branch when the message contains both', () => {
    expect(classifyRendererError(new Error(`Kicked: ${NEOFORGE_KICK}`)).class).toBe(
      'MODDED_HOST_REJECTED',
    );
  });

  it('leaves genuine LAN failures alone', () => {
    expect(classifyRendererError(new Error('No Minecraft LAN world found')).class).toBe(
      'LAN_NOT_OPEN',
    );
    expect(classifyRendererError(new Error('connect ECONNRESET 127.0.0.1:55555')).class).toBe(
      'LAN_NOT_OPEN',
    );
  });

  // "userland" in node's punycode deprecation warning is the historical false
  // positive the \blan\b word boundary exists for; the new branch must not
  // reintroduce one of its own via a bare /mod/.
  it('does not fire on incidental substrings', () => {
    expect(classifyRendererError(new Error('model row failed to render')).class).not.toBe(
      'MODDED_HOST_REJECTED',
    );
  });
});

describe('userFacingError', () => {
  const LIMIT = 'You can only have 4 companions. Remove one to make room.';
  const quiet = (): void => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  };
  afterEach(() => {
    vi.restoreAllMocks();
    useLangStore.getState().setLang('en');
  });

  it('strips the invoke wrapper and the Error prefix', () => {
    expect(
      userFacingError(new Error("Error invoking remote method 'chars:portrait-select': Error: Unknown portrait version.")),
    ).toBe('Unknown portrait version.');
  });

  it('shows the companion-limit message clean (product report 261119)', () => {
    expect(userFacingError(new Error(`Error invoking remote method 'chars:add-to-library': Error: ${LIMIT}`))).toBe(
      LIMIT,
    );
    // Already unwrapped by the preload: unchanged.
    expect(userFacingError(new Error(LIMIT))).toBe(LIMIT);
  });

  it('translates the companion-limit message with its number', () => {
    useLangStore.getState().setLang('es');
    expect(userFacingError(new Error(LIMIT))).toBe('Solo puedes tener 4 compis. Quita uno para hacer hueco.');
  });

  it('strips nested wrappers and any error class name, and leaves a plain message alone', () => {
    expect(
      userFacingError(new Error("Error invoking remote method 'knowledge:extract': KnowledgeExtractError: That file is empty.")),
    ).toBe('That file is empty.');
    expect(
      userFacingError(
        new Error("Error invoking remote method 'a:b': Error: Error invoking remote method 'c:d': Error: Error: Character not found."),
      ),
    ).toBe('Character not found.');
    expect(userFacingError(new Error('Character not found.'))).toBe('Character not found.');
    expect(userFacingError('plain string')).toBe('plain string');
    expect(userFacingError({ message: 'A result message.' })).toBe('A result message.');
  });

  it('maps network failures to the connection line', () => {
    quiet();
    const line = "Can't reach Sei right now. Check your connection and try again.";
    for (const raw of [
      "Error invoking remote method 'chars:save': TypeError: fetch failed",
      'Failed to fetch',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.sei.gg',
      'net::ERR_INTERNET_DISCONNECTED',
      'socket hang up',
    ]) {
      expect(userFacingError(new Error(raw)), raw).toBe(line);
    }
  });

  it('maps timeouts and server errors to their own lines', () => {
    quiet();
    expect(userFacingError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('That took too long. Please try again.');
    expect(userFacingError(new Error('The operation was aborted due to timeout'))).toBe(
      'That took too long. Please try again.',
    );
    const server = "Sei's servers are having trouble. Please try again in a moment.";
    expect(userFacingError(new Error('502 Bad Gateway'))).toBe(server);
    expect(userFacingError(new Error('Request failed with status code 503'))).toBe(server);
  });

  it('hides technical text behind the fallback', () => {
    quiet();
    const generic = 'Something went wrong. Please try again.';
    for (const raw of [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "Error invoking remote method 'x:y': ReferenceError: foo is not defined",
      'Error: boom\n    at Object.<anonymous> (/app/main.js:1:1)',
      '[{"code":"invalid_type","expected":"string","path":["name"]}]',
      '{"error":"internal"}',
      '404',
      'HTTP 401 Unauthorized',
      "ENOENT: no such file or directory, open '/Users/x/config.json'",
      'An object could not be cloned.',
      'CHAT_ABORTED',
      'undefined',
      '[object Object]',
    ]) {
      expect(userFacingError(new Error(raw)), raw).toBe(generic);
    }
    expect(userFacingError(new Error('TypeError: x is not a function'), 'Failed to save.')).toBe('Failed to save.');
  });

  it('uses the fallback for empty and non-Error rejections', () => {
    expect(userFacingError(undefined)).toBe('Something went wrong. Please try again.');
    expect(userFacingError(null, 'Failed to save.')).toBe('Failed to save.');
    expect(userFacingError({ code: 1 })).toBe('Something went wrong. Please try again.');
    expect(userFacingError(new Error("Error invoking remote method 'x:y': Error: "))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('turns a known error class into its copy, and judges an unknown code by its tail', () => {
    quiet();
    expect(userFacingError(new Error('NETWORK_OFFLINE'))).toBe(ERROR_COPY.NETWORK_OFFLINE);
    expect(userFacingError(new Error('MOJANG_LOOKUP_FAILED: whatever'))).toBe(ERROR_COPY.MOJANG_LOOKUP_FAILED);
    expect(userFacingError(new Error('SEILINK_PACK_MISSING: Download the room pack first.'))).toBe(
      'Download the room pack first.',
    );
    expect(userFacingError(new Error('VOICE_TTS_FAILED: 500'))).toBe(
      "Sei's servers are having trouble. Please try again in a moment.",
    );
  });

  it('logs the raw text when it replaces it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    userFacingError(new Error('TypeError: x is not a function'));
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'TypeError: x is not a function');
    warn.mockClear();
    userFacingError(new Error(LIMIT));
    expect(warn).not.toHaveBeenCalled();
  });

  it('every line it can produce has no em dash', () => {
    for (const v of Object.values(FRIENDLY_ERROR_COPY)) expect(v).not.toContain('\u2014');
  });
});

describe('userFacingDetail', () => {
  it('is the message only when it was written for people', () => {
    expect(userFacingDetail(new Error('That file is empty.'))).toBe('That file is empty.');
    expect(userFacingDetail(new Error('fetch failed'))).toBeNull();
    expect(userFacingDetail(new Error('TypeError: nope'))).toBeNull();
    expect(userFacingDetail(undefined)).toBeNull();
  });
});

describe('classifyRendererError fallback', () => {
  it('never puts raw technical text into the line', () => {
    const { copy } = classifyRendererError(new Error("TypeError: Cannot read properties of undefined (reading 'x')"));
    expect(copy).toBe('Something went wrong. Try again.');
  });

  it('keeps a readable reason', () => {
    expect(classifyRendererError(new Error('That skin is too big')).copy).toBe(
      'Something went wrong. That skin is too big. Try again.',
    );
  });
});

describe('ERROR_COPY', () => {
  it('has a row for every ErrorClass', () => {
    for (const cls of ALL_ERROR_CLASSES) {
      expect(ERROR_COPY[cls], `missing copy for ${cls}`).toBeTruthy();
    }
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...ALL_ERROR_CLASSES].sort());
  });

  // CLAUDE.md: no em dashes in any copy a user can read.
  it('contains no em dashes', () => {
    for (const [cls, copy] of Object.entries(ERROR_COPY)) {
      expect(copy, `em dash in ${cls}`).not.toContain('—');
    }
  });

  // 261017 (issue #46, review round 2): a 403 without a known code is a
  // region / plan restriction; signing in again cannot fix it.
  it('a ChatGPT 403 names a region or plan restriction, not a re-sign-in', () => {
    expect(ERROR_COPY.CHATGPT_FORBIDDEN).toMatch(/region|plan/);
    expect(ERROR_COPY.CHATGPT_FORBIDDEN.toLowerCase()).not.toContain('sign in again');
    expect(ERROR_COPY.CHATGPT_AUTH_REJECTED.toLowerCase()).toContain('sign in again');
  });

  // Retrying a modded-host rejection is the one action guaranteed not to work,
  // so the copy must not suggest it.
  it('does not tell a modded-host user to press Summon again', () => {
    expect(ERROR_COPY.MODDED_HOST_REJECTED.toLowerCase()).not.toContain('summon again');
  });

  // 261007: Fabric worlds were half of the rejections, and the minimap the old
  // copy recommended was the mod those worlds required.
  it('MODDED_HOST_REJECTED is not Forge-only and does not recommend minimaps', () => {
    expect(ERROR_COPY.MODDED_HOST_REJECTED).not.toMatch(/forge/i);
    expect(ERROR_COPY.MODDED_HOST_REJECTED).not.toMatch(/minimaps? (are|is) fine|client-only mods like minimaps/i);
    expect(ERROR_COPY.MODDED_HOST_REJECTED).toContain('Sei profile');
  });

  it('classifies an online-mode kick before the LAN branch (261007)', () => {
    for (const msg of [
      'ONLINE_MODE_REJECTED: This world checks Minecraft accounts (online mode).',
      'Kicked: multiplayer.disconnect.unverified_username',
      'Failed to verify username!',
    ]) {
      expect(classifyRendererError(new Error(msg)).class).toBe('ONLINE_MODE_REJECTED');
    }
    expect(ERROR_COPY.ONLINE_MODE_REJECTED).toContain('online-mode=false');
  });

  // 260926: the copy names the exact range (from minecraft-protocol's table)
  // and the launcher path, and no placeholder ever renders literally.
  // 260929 (R1c): the fix is the Sei profile, not a hand-made installation.
  it('UNSUPPORTED_MC_VERSION names the supported range and points at the Sei profile', () => {
    const copy = errorCopyText('UNSUPPORTED_MC_VERSION');
    expect(copy).toContain(`to ${supportedVersions[supportedVersions.length - 1]}`);
    expect(copy).toContain('Open the Sei profile');
    expect(copy).not.toContain('New installation');
    expect(copy).not.toContain('—');
    for (const cls of ALL_ERROR_CLASSES) {
      expect(errorCopyText(cls), `unfilled placeholder in ${cls}`).not.toMatch(/\{(oldest|newest|recommended|versions)\}/);
    }
  });

  // 261103 (T303): a BYOK provider refused the region; the bot's terminal
  // error carries the provider name in its message.
  it('PROVIDER_REGION_UNSUPPORTED names the provider from the message', () => {
    const msg = 'PROVIDER_REGION_UNSUPPORTED[Anthropic]: Anthropic does not support your region.';
    expect(errorCopyText('PROVIDER_REGION_UNSUPPORTED', undefined, msg)).toBe('Anthropic does not support your region.');
    expect(errorCopyText('PROVIDER_REGION_UNSUPPORTED')).toBe('Your AI provider does not support your region.');
    expect(errorCopyText('PROVIDER_REGION_UNSUPPORTED', undefined, msg)).not.toMatch(/\u2014|VPN/i);
  });

  // 260926 (PR #26): the bot joins 26.2 / 26.3, but the skin mod only works on
  // the wizard's version. The copy lists every joinable version and steers the
  // launcher steps to the wizard's version, never to the protocol table's newest.
  it('UNSUPPORTED_MC_VERSION lists 26.2 / 26.3 but recommends the skin-mod version', () => {
    const copy = errorCopyText('UNSUPPORTED_MC_VERSION');
    const newest = supportedVersions[supportedVersions.length - 1];
    expect(newest).toBe('26.3');
    expect(copy, copy).toContain(`to ${newest}`);
    expect(copy).toContain(`it runs ${WIZARD_MAX_MC}, with companion skins`);
    expect(copy).not.toContain(`runs ${newest}`);
  });
});
