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

import { describe, it, expect } from 'vitest';
import { ERROR_COPY, classifyRendererError, cleanIpcError, errorCopyText } from './errors';
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

describe('cleanIpcError', () => {
  it('strips the invoke wrapper and the Error prefix', () => {
    expect(
      cleanIpcError(new Error("Error invoking remote method 'chars:portrait-select': Error: Unknown portrait version.")),
    ).toBe('Unknown portrait version.');
  });

  it('strips any error class name, and leaves a plain message alone', () => {
    expect(
      cleanIpcError(new Error("Error invoking remote method 'knowledge:extract': KnowledgeExtractError: That file is empty.")),
    ).toBe('That file is empty.');
    expect(cleanIpcError(new Error('Character not found.'))).toBe('Character not found.');
    expect(cleanIpcError('plain string')).toBe('plain string');
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

  // Retrying a modded-host rejection is the one action guaranteed not to work,
  // so the copy must not suggest it.
  it('does not tell a modded-host user to press Summon again', () => {
    expect(ERROR_COPY.MODDED_HOST_REJECTED.toLowerCase()).not.toContain('summon again');
  });

  // 260926: the copy names the exact range (from minecraft-protocol's table)
  // and the launcher path, and no placeholder ever renders literally.
  it('UNSUPPORTED_MC_VERSION names the supported range and the launcher steps', () => {
    const copy = errorCopyText('UNSUPPORTED_MC_VERSION');
    expect(copy).toContain(`to ${supportedVersions[supportedVersions.length - 1]}`);
    expect(copy).toContain('Installations');
    expect(copy).toContain('New installation');
    for (const cls of ALL_ERROR_CLASSES) {
      expect(errorCopyText(cls), `unfilled placeholder in ${cls}`).not.toMatch(/\{(oldest|newest|recommended|versions)\}/);
    }
  });

  // 260926 (PR #26): the bot joins 26.2 / 26.3, but the skin mod only works on
  // the wizard's version. The copy lists every joinable version and steers the
  // launcher steps to the wizard's version, never to the protocol table's newest.
  it('UNSUPPORTED_MC_VERSION lists 26.2 / 26.3 but recommends the skin-mod version', () => {
    const copy = errorCopyText('UNSUPPORTED_MC_VERSION');
    const newest = supportedVersions[supportedVersions.length - 1];
    expect(newest).toBe('26.3');
    expect(copy, copy).toContain(`to ${newest}`);
    expect(copy).toContain(`For companion skins, use ${WIZARD_MAX_MC}`);
    expect(copy).toContain(`pick ${WIZARD_MAX_MC} as the version`);
    expect(copy).not.toContain(`pick ${newest}`);
  });
});
