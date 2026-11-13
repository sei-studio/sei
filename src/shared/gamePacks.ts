/**
 * Game packs (260908, game-adapters M0b) — the cross-process contract for a
 * game adapter's downloadable runtime.
 *
 * A game pack is a zip of `node_modules/` (a production install of the
 * `packs/<game>` npm workspace with native modules rebuilt against Electron's
 * ABI) and/or `assets/` (a game-side mod: Stardew, DST) plus a `pack.json`, built by scripts/build-game-pack.mjs and published
 * beside the app's release assets. Nothing in it is bundled in the installer:
 * the Minecraft adapter's dependencies alone were 753MB of the packaged app on
 * mac arm64 and dead weight for a player who never opens Minecraft.
 *
 * Naming is the whole contract between the builder, CI, the mirror and the
 * client, so it lives here once:
 *
 *   sei-pack-<game>-<version>-<platform>-<arch>.zip   one pack
 *   sei-pack-<game>-<version>-any-any.zip             a pack with no native code
 *   game-packs-<version>.json                         the manifest for one release
 *
 * where <version> is the APP version (the pack is built from the same lockfile
 * as the app that will load it). Every release asset is mirrored flat under
 * https://dl.sei.gg/updates/ by .github/workflows/mirror-release.yml, so the
 * mirror URL is just the base plus the asset name. The GitHub release URL is
 * the origin and the fallback.
 *
 * Pure: no Node, no Electron. src/main/games/packs.ts does the I/O.
 */
import { z } from 'zod';

import type { GameId } from './gameIpc';
export type { GameId } from './gameIpc';
export { GAME_IDS, isGameId } from './gameIpc';

export interface GamePackDescriptor {
  id: GameId;
  /** User-facing game name (the download card says "Download {name} support"). */
  name: string;
  /**
   * True when the pack carries native modules and is built per platform+arch
   * (Minecraft: gl + canvas). A pack with no native code is built once as
   * `any-any` and served to every platform.
   */
  platformSpecific: boolean;
  /**
   * Approximate zip size for the "about NN MB" copy shown BEFORE the manifest
   * has been fetched. The manifest's `bytes` replaces it once known. Keep it
   * close to the real thing (measured on the darwin arm64 pack).
   */
  sizeHintBytes: number;
  /**
   * Files (pack-root relative, posix) a usable pack must contain. The client
   * treats an extracted or installed pack missing any of them as broken and
   * downloads it again instead of re-linking it; the builder refuses to write
   * a zip without them. Must equal REQUIRED_PAYLOAD in
   * scripts/lib/gamePackVerify.mjs (pinned by its test). v0.6.5-beta.1's DST
   * pack held pack.json and an empty node_modules/ only, and its treeHash
   * (computed over the staged tree, mod included) would have matched every
   * fixed rebuild, so without this check those installs would never repair.
   */
  requiredPaths: readonly string[];
}

export const GAME_PACKS: Record<GameId, GamePackDescriptor> = {
  minecraft: {
    id: 'minecraft',
    name: 'Minecraft',
    platformSpecific: true,
    // Measured 260908: the darwin arm64 zip is 47.6MB (17,949 files, 354MB
    // unpacked); the win32 pack carries gl's DLL payload on top. The copy
    // rounds to whole MB, and ERROR_COPY names the same figure.
    sizeHintBytes: 50 * 1024 * 1024,
    requiredPaths: ['node_modules/mineflayer/package.json', 'node_modules/minecraft-data/package.json'],
  },
  // The two mod-driven games carry no node_modules: their pack is the
  // game-side mod (Stardew: the built SMAPI DLL + manifest; DST: the Lua
  // mod), platform-neutral, built once as any-any. Sizes measured on the
  // v0.6.5-beta.2 packs: Stardew ~107 KB, DST ~30 KB.
  stardew: {
    id: 'stardew',
    name: 'Stardew Valley',
    platformSpecific: false,
    sizeHintBytes: 110 * 1024,
    requiredPaths: ['assets/stardew-mod/SeiCompanion/SeiCompanion.dll', 'assets/stardew-mod/SeiCompanion/manifest.json'],
  },
  dontstarve: {
    id: 'dontstarve',
    name: "Don't Starve Together",
    platformSpecific: false,
    sizeHintBytes: 32 * 1024,
    requiredPaths: ['assets/dst-mod/sei/modinfo.lua', 'assets/dst-mod/sei/modmain.lua'],
  },
};

// ── Asset naming ────────────────────────────────────────────────────────────

export type PackPlatform = 'darwin' | 'win32' | 'linux' | 'any';
export type PackArch = 'arm64' | 'x64' | 'any';

/** The zip file name for one pack. `any`/`any` for a pack with no native code. */
export function packAssetName(
  game: GameId,
  version: string,
  platform: PackPlatform,
  arch: PackArch,
): string {
  return `sei-pack-${game}-${version}-${platform}-${arch}.zip`;
}

/** The per-release manifest listing every pack with its sha256 / size / treeHash. */
export function manifestAssetName(version: string): string {
  return `game-packs-${version}.json`;
}

/** Parse a pack asset name back into its parts (null when it is not one). */
export function parsePackAssetName(
  file: string,
): { game: string; version: string; platform: string; arch: string } | null {
  const m = /^sei-pack-([a-z0-9]+)-(.+)-([a-z0-9]+)-([a-z0-9]+)\.zip$/.exec(file);
  if (!m) return null;
  return { game: m[1], version: m[2], platform: m[3], arch: m[4] };
}

// ── Download sources ────────────────────────────────────────────────────────

/**
 * Mirror of every published release asset (R2 behind Cloudflare, reachable
 * from mainland China). Same bucket + prefix the updater feed and
 * mirror-release.yml use; src/main/speech/mirrors.ts holds the speech-model
 * prefix of the same host.
 *
 * The layout is CHANNEL-SEPARATED (mirror-release.yml, 260909): artifacts land
 * under `updates/stable/` or `updates/beta/` by whether the GitHub release was
 * published as a pre-release, and only the feed ymls stay flat. The packs and
 * the manifest are release assets like any other, so the client must look in
 * the channel dir of ITS OWN version (`gamePackMirrorDir`): a version with a
 * prerelease part (`0.6.5-beta.1`) was cut from a pre-release tag. The first
 * cut fetched them flat and 404ed on every mirror attempt, silently falling
 * back to GitHub (slow or blocked exactly where the mirror exists for).
 */
export const GAME_PACK_MIRROR_BASE = 'https://dl.sei.gg/updates';

/** `beta` for a prerelease app version (a `-` suffix), `stable` otherwise. */
export function gamePackMirrorDir(version: string): 'beta' | 'stable' {
  return version.includes('-') ? 'beta' : 'stable';
}

/** Origin: the GitHub release the app version was cut from. */
export function gamePackOriginBase(version: string): string {
  return `https://github.com/sei-studio/sei/releases/download/v${version}`;
}

/**
 * Connect budget for the mirror attempt. The mirror is an optimization; a
 * mirror that is missing an asset (or is unreachable) must cost seconds, not a
 * stall, before the origin is tried.
 */
export const GAME_PACK_MIRROR_CONNECT_TIMEOUT_MS = 8_000;

export interface GamePackSource {
  url: string;
  /** Abort the attempt if headers have not landed inside this window. */
  connectTimeoutMs?: number;
}

/** Mirror first (bounded connect), then origin. */
export function gamePackSources(version: string, asset: string): GamePackSource[] {
  return [
    {
      url: `${GAME_PACK_MIRROR_BASE}/${gamePackMirrorDir(version)}/${asset}`,
      connectTimeoutMs: GAME_PACK_MIRROR_CONNECT_TIMEOUT_MS,
    },
    { url: `${gamePackOriginBase(version)}/${asset}` },
  ];
}

export function manifestSources(version: string): GamePackSource[] {
  return gamePackSources(version, manifestAssetName(version));
}

// ── Manifest ────────────────────────────────────────────────────────────────

export const GamePackManifestEntrySchema = z.object({
  game: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  treeHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const GamePackManifestSchema = z.object({
  version: z.string().min(1),
  packs: z.array(GamePackManifestEntrySchema),
});

export type GamePackManifestEntry = z.infer<typeof GamePackManifestEntrySchema>;
export type GamePackManifest = z.infer<typeof GamePackManifestSchema>;

/** Validate a fetched manifest; throws a ZodError on a malformed one. */
export function parseGamePackManifest(json: unknown): GamePackManifest {
  return GamePackManifestSchema.parse(json);
}

/**
 * The manifest entry for one game on one platform+arch: an exact match wins,
 * else the platform-independent `any`/`any` build, else null.
 */
export function pickPackEntry(
  manifest: GamePackManifest,
  game: GameId,
  platform: string,
  arch: string,
): GamePackManifestEntry | null {
  const mine = manifest.packs.filter((p) => p.game === game);
  return (
    mine.find((p) => p.platform === platform && p.arch === arch) ??
    mine.find((p) => p.platform === 'any' && p.arch === 'any') ??
    null
  );
}

// ── State pushed to the renderer ────────────────────────────────────────────

/**
 * One game pack's state, returned by game:pack-state and pushed on
 * game:pack-progress. `ready` carries the pack root the bot will be pointed
 * at; `error` carries the ErrorClass the renderer looks up in ERROR_COPY.
 */
export type GamePackState =
  | { kind: 'ready'; root: string }
  | { kind: 'missing' }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'error'; error: 'GAME_PACK_DOWNLOAD_FAILED'; message: string };

export interface GamePackProgressPush {
  game: GameId;
  state: GamePackState;
}

/** Whole mebibytes for user copy, floored at 1 so a tiny pack never says 0. */
export function packSizeMb(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

/**
 * A size for the pack card: "50 MB", or "107 KB" under a megabyte (260925:
 * the Stardew and DST packs are a few dozen KB and read "about 1 MB" / "2 MB"
 * through packSizeMb's whole-MB floor). `unitOf` picks the unit from another
 * size, so "12 of 107 KB" never mixes units mid-download.
 */
export function packSizeLabel(bytes: number, unitOf: number = bytes): string {
  const { n, unit } = packSizeParts(bytes, unitOf);
  return `${n} ${unit}`;
}

/** packSizeLabel's number and unit apart, for "12 of 48 MB". */
export function packSizeParts(bytes: number, unitOf: number = bytes): { n: number; unit: 'KB' | 'MB' } {
  if (unitOf < 1024 * 1024) return { n: Math.max(1, Math.round(bytes / 1024)), unit: 'KB' };
  return { n: packSizeMb(bytes), unit: 'MB' };
}

/** 0..100 for a progress bar; 0 while the total is unknown. */
export function packProgressPct(received: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}
