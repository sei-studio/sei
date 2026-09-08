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
  | 'GAME_PACK_DOWNLOAD_FAILED';

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
]);
