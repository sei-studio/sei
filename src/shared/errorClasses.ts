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
  // Skin + setup-wizard surfaces
  | 'MOD_DOWNLOAD_FAILED'
  | 'FABRIC_INSTALL_FAILED'
  | 'MC_INSTALL_NOT_FOUND'
  | 'MOJANG_LOOKUP_FAILED'
  | 'SKIN_FILE_INVALID'
  | 'SKIN_SERVER_PORT_TAKEN'
  | 'WIZARD_PERMISSION_DENIED'
  | 'CLOUD_CREDITS_DEPLETED'
  | 'DAILY_LIMIT_REACHED';

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
]);
