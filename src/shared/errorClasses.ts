/**
 * Plain-English error narration surface (GUI-05).
 *
 * Each variant maps to a copy entry in src/renderer/src/lib/errors.ts.
 * Sources:
 *   - UI-SPEC §"Plain-English error copy" — 9 seeded classes
 *   - RESEARCH §"Pitfall 3" — KEYCHAIN_FALLBACK_PLAINTEXT (Linux fallback warning)
 *   - UI spec for skin/wizard ERROR_COPY entries — 7 skin/wizard classes
 *
 * Adding a new ErrorClass: also add a row to ERROR_COPY in lib/errors.ts.
 */

export type ErrorClass =
  | 'BOT_START_TIMEOUT'
  | 'LAN_NOT_OPEN'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'NETWORK_OFFLINE'
  | 'BOT_CRASH'
  | 'LAN_UNAVAILABLE'
  | 'KEYCHAIN_LOCKED'
  | 'KEYCHAIN_FALLBACK_PLAINTEXT'
  | 'NATIVE_MODULE_MISMATCH'
  | 'UNSUPPORTED_MC_VERSION'
  | 'MODDED_HOST_REJECTED'
  // Skin + setup-wizard surfaces
  | 'MOD_DOWNLOAD_FAILED'
  | 'FABRIC_INSTALL_FAILED'
  | 'MC_INSTALL_NOT_FOUND'
  | 'MOJANG_LOOKUP_FAILED'
  | 'SKIN_FILE_INVALID'
  | 'SKIN_SERVER_PORT_TAKEN'
  | 'WIZARD_PERMISSION_DENIED'
  | 'CLOUD_CREDITS_DEPLETED'
  | 'DAILY_LIMIT_REACHED'
  // 260828: summon pre-gate refusal when onboarding never captured a name.
  // Previously mislabeled as BOT_CRASH in the BotStatus while the throw already
  // used this token — production analytics showed users retry-looping on the
  // misleading "Sei stopped unexpectedly" copy.
  | 'PREFERRED_NAME_MISSING'
  // Game adapters (M0, 260908): game-neutral classes for the second and third
  // games. Minecraft keeps its own classes above (LAN_NOT_OPEN etc.); a game
  // module maps its own failures onto these, and the renderer routes them by
  // (game, errorClass) to a generic modal carrying ERROR_COPY.
  | 'GAME_WORLD_NOT_OPEN'
  | 'GAME_NOT_INSTALLED'
  | 'GAME_INSTALL_FAILED'
  | 'GAME_NOT_ANSWERING'
  | 'GAME_VERSION_UNSUPPORTED'
  // 260908 game packs: the adapter's runtime (a downloadable zip of its
  // node_modules, src/main/games/packs.ts) could not be fetched, verified or
  // extracted. Pre-fork like the wizard's MOD_DOWNLOAD_FAILED; a retry is the
  // fix that usually works.
  | 'GAME_PACK_DOWNLOAD_FAILED'
  // Don't Starve Together (game-adapters M2, 260908): only where the copy
  // must differ from the GAME_* classes. The mod answered but no survivor
  // appeared; Sei could not bind its loopback listener or the discovery
  // port; the survivor died (an ownerless body has no client to revive it).
  | 'DST_SPAWN_FAILED'
  | 'DST_PORT_IN_USE'
  | 'DST_BODY_DIED'
  // 260909: the helper runs ONE body per world. A second character's summon
  // used to replace the first (and, through a link-reset race, strand a
  // brainless survivor), so the supervisor refuses it and the launch panel
  // says who is already there.
  | 'DST_ONE_COMPANION'
  // Stardew Valley (M1, 260908): the two failures whose copy must differ from
  // the generic GAME_* classes. A farmhand without the mod cannot be shown a
  // custom-sprite NPC, so the mod refuses to spawn; SMAPI's own installer
  // failing is a different fix from the mod copy failing.
  | 'STARDEW_FARMHAND_NO_MOD'
  | 'SMAPI_INSTALL_FAILED';

export const ALL_ERROR_CLASSES: readonly ErrorClass[] = Object.freeze([
  'BOT_START_TIMEOUT',
  'LAN_NOT_OPEN',
  'INVALID_API_KEY',
  'RATE_LIMITED',
  'NETWORK_OFFLINE',
  'BOT_CRASH',
  'LAN_UNAVAILABLE',
  'KEYCHAIN_LOCKED',
  'KEYCHAIN_FALLBACK_PLAINTEXT',
  'NATIVE_MODULE_MISMATCH',
  'UNSUPPORTED_MC_VERSION',
  'MODDED_HOST_REJECTED',
  // Skin + setup-wizard surfaces
  'MOD_DOWNLOAD_FAILED',
  'FABRIC_INSTALL_FAILED',
  'MC_INSTALL_NOT_FOUND',
  'MOJANG_LOOKUP_FAILED',
  'SKIN_FILE_INVALID',
  'SKIN_SERVER_PORT_TAKEN',
  'WIZARD_PERMISSION_DENIED',
  'CLOUD_CREDITS_DEPLETED',
  'DAILY_LIMIT_REACHED',
  'PREFERRED_NAME_MISSING',
  'GAME_WORLD_NOT_OPEN',
  'GAME_NOT_INSTALLED',
  'GAME_INSTALL_FAILED',
  'GAME_NOT_ANSWERING',
  'GAME_VERSION_UNSUPPORTED',
  'GAME_PACK_DOWNLOAD_FAILED',
  'DST_SPAWN_FAILED',
  'DST_PORT_IN_USE',
  'DST_BODY_DIED',
  'DST_ONE_COMPANION',
  'STARDEW_FARMHAND_NO_MOD',
  'SMAPI_INSTALL_FAILED',
]);
