// Game pack zip verification (260924). Shared by scripts/build-game-pack.mjs
// (which refuses to publish a zip that fails it) and the vitest suite.
//
// Why it exists: v0.6.5-beta.1 shipped sei-pack-dontstarve-*-any-any.zip at
// 745 bytes. The builder staged and HASHED the Lua mod under assets/ (pack.json
// says 14 files) but zipped only `pack.json node_modules`, so the zip carried
// the empty node_modules placeholder and no mod. Nothing compared the zip with
// the tree it claimed to hold. verifyPackZip re-derives the treeHash from the
// zip's own bytes, so a zip that drops any hashed file (or adds one) fails the
// build, and checks each game's required payload by name on top.
//
// Plain ESM, only jszip: the builder is a node script, not part of the TS
// build. The client keeps its own copy of REQUIRED_PAYLOAD as
// GAME_PACKS[game].requiredPaths (src/shared/gamePacks.ts); a test pins the
// two equal.

import { createHash } from 'node:crypto';
import JSZip from 'jszip';

/**
 * Files a pack for each game must carry, relative to the pack root, posix.
 * A pack that lacks one is unusable: the adapter or installer reads exactly
 * these paths (dontstarve/install.ts MOD_SOURCE_RELATIVE + modinfo.lua,
 * stardewIpc.ts STARDEW_MOD_PACK_PATH, the bot's require of mineflayer).
 */
export const REQUIRED_PAYLOAD = {
  minecraft: ['node_modules/mineflayer/package.json', 'node_modules/minecraft-data/package.json'],
  stardew: ['assets/stardew-mod/SeiCompanion/SeiCompanion.dll', 'assets/stardew-mod/SeiCompanion/manifest.json'],
  dontstarve: ['assets/dst-mod/sei/modinfo.lua', 'assets/dst-mod/sei/modmain.lua'],
};

/** Placeholder files that never count as payload. */
const PLACEHOLDERS = new Set(['pack.json', 'node_modules/.sei-pack-keep']);

/**
 * sha256 over sorted relative paths and per-file sha256s (pack.json excluded).
 * `entries` is [[posixRelPath, sha256Hex], ...] in any order. The builder's
 * staging-tree hash and the zip-derived hash both go through here, so the two
 * can only agree when the zip holds exactly the staged files.
 */
export function treeHashOfEntries(entries) {
  const sorted = entries.filter(([f]) => f !== 'pack.json').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const [f, sha] of sorted) h.update(`${f}\n${sha}\n`);
  return { treeHash: h.digest('hex'), files: sorted.length };
}

/** Every regular file in a zip buffer: Map<posixPath, sha256Hex>. */
export async function zipFileHashes(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map();
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async('nodebuffer');
    out.set(name.replace(/\\/g, '/'), createHash('sha256').update(data).digest('hex'));
  }
  return { zip, hashes: out };
}

/**
 * Check a built pack zip. Returns a list of problems (empty = good).
 *   expect.game      the game id (selects REQUIRED_PAYLOAD)
 *   expect.treeHash  the treeHash the builder computed over its staging tree
 *   expect.files     the file count that hash covered
 */
export async function verifyPackZip(buf, expect) {
  const problems = [];
  const { zip, hashes } = await zipFileHashes(buf);

  let packJson = null;
  if (!hashes.has('pack.json')) problems.push('zip has no pack.json');
  else {
    try {
      packJson = JSON.parse(await zip.file('pack.json').async('string'));
    } catch {
      problems.push('pack.json in the zip is not JSON');
    }
  }
  if (packJson) {
    if (packJson.game !== expect.game) problems.push(`pack.json game ${packJson.game} != ${expect.game}`);
    if (packJson.treeHash !== expect.treeHash) problems.push('pack.json treeHash differs from the staged tree');
  }

  const { treeHash, files } = treeHashOfEntries([...hashes.entries()]);
  if (files !== expect.files) problems.push(`zip holds ${files} files, the staged tree had ${expect.files}`);
  if (treeHash !== expect.treeHash) problems.push('treeHash of the zip contents differs from the staged tree (the zip is missing or adding files)');

  const required = REQUIRED_PAYLOAD[expect.game];
  if (!required) problems.push(`no REQUIRED_PAYLOAD entry for ${expect.game}`);
  else for (const p of required) if (!hashes.has(p)) problems.push(`required payload missing from the zip: ${p}`);

  const payload = [...hashes.keys()].filter((f) => !PLACEHOLDERS.has(f));
  if (payload.length === 0) problems.push('zip carries no payload (only pack.json and placeholders)');

  return problems;
}
