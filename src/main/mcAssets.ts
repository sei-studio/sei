/**
 * mcAssets — read-only Minecraft item texture resolution for the dashboard
 * (260721). The renderer's Minecraft dashboard shows real item textures in
 * its inventory slots; this module backs the skin server's
 * `GET /mcassets/<version>/item/<name>.png` endpoint (see skinServer.ts).
 *
 * Source of the bytes: the app already ships Minecraft textures inside
 * `node_modules/prismarine-viewer/public/textures/<mcVersion>/` (the package
 * is asar-unpacked in production along with the rest of node_modules, and
 * Electron's patched fs reads through app.asar paths transparently). Nothing
 * is copied into the repo or the build output; the files are served straight
 * from the installed package at runtime.
 *
 * NOTE (legally cleanest future source): the tidiest origin for these
 * textures would be the user's OWN installed Minecraft client jar
 * (~/Library/Application Support/minecraft/versions/<v>/<v>.jar →
 * assets/minecraft/textures/...) extracted into a userData cache, falling
 * back to prismarine-viewer's copies. Not implemented yet — jar discovery +
 * zip extraction is not worth the weight for v0.5. Never commit Mojang asset
 * files to the repo or bundle them into build output.
 *
 * Item name → file mapping: prismarine-viewer ships a per-version
 * `items_textures.json` (`[{name, model, texture}]`) whose `texture` field
 * points at either an item sprite ("minecraft:items/iron_pickaxe") or, for
 * block items, a block face ("minecraft:block/cobblestone"). We resolve
 * through that table so block items get a real texture too. Items whose
 * icon has no flat sprite (missingno / entity renders) resolve to null and
 * the endpoint 404s; the renderer keeps its text-label slot as the fallback.
 *
 * Path-traversal safety: every URL segment is regex-validated (version:
 * digits+dots or "latest"; name: [a-z0-9_]{1,64}); the URL is never
 * percent-decoded, so encoded dots cannot sneak through. The resolved
 * version directory comes from a readdir of the textures root (never from
 * the URL verbatim), and the final absolute path is verified to stay under
 * the textures root as a belt-and-braces guard.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

/** GET /mcassets/<version>/item/<name>.png — the ONLY accepted URL shape. */
const MC_ASSET_URL_RE =
  /^\/mcassets\/(latest|\d{1,2}(?:\.\d{1,3}){0,2})\/item\/([a-z0-9_]{1,64})\.png(\?.*)?$/;

/** Version folders inside the textures root look like "1.21.4". */
const VERSION_DIR_RE = /^\d{1,2}(?:\.\d{1,3}){0,2}$/;

export interface McAssetRequest {
  /** Requested MC version ("1.21.4") or "latest". */
  version: string;
  /** Item id without namespace, e.g. "iron_pickaxe". */
  name: string;
}

/** Parse an /mcassets request URL. Null = not an asset URL / invalid shape. */
export function parseMcAssetUrl(url: string): McAssetRequest | null {
  const m = url.match(MC_ASSET_URL_RE);
  if (!m) return null;
  return { version: m[1], name: m[2] };
}

/** "1.21.4" → sortable numeric key. Null when unparsable. */
function versionKey(v: string): number | null {
  const m = v.match(/^(\d{1,2})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  return Number(m[1]) * 1e6 + Number(m[2] ?? 0) * 1e3 + Number(m[3] ?? 0);
}

/**
 * Pick the bundled texture folder closest to the requested world version:
 * the newest folder that is <= the request; if the request predates every
 * folder, the oldest one; "latest"/unparsable requests get the newest.
 */
export function pickClosestVersion(requested: string, available: string[]): string | null {
  const keyed = available
    .map((v) => ({ v, k: versionKey(v) }))
    .filter((e): e is { v: string; k: number } => e.k !== null)
    .sort((a, b) => a.k - b.k);
  if (keyed.length === 0) return null;
  const want = requested === 'latest' ? null : versionKey(requested);
  if (want === null) return keyed[keyed.length - 1].v;
  let best: string | null = null;
  for (const e of keyed) {
    if (e.k <= want) best = e.v;
  }
  return best ?? keyed[0].v;
}

/** textures root → sorted version folder list (cached; missing root = []). */
const versionsCache = new Map<string, Promise<string[]>>();

function listTextureVersions(texturesRoot: string): Promise<string[]> {
  let p = versionsCache.get(texturesRoot);
  if (!p) {
    p = readdir(texturesRoot, { withFileTypes: true })
      .then((es) => es.filter((e) => e.isDirectory() && VERSION_DIR_RE.test(e.name)).map((e) => e.name))
      .catch(() => []);
    versionsCache.set(texturesRoot, p);
  }
  return p;
}

/** `${root}|${version}` → item name → relative texture path ("items/x.png"). */
const itemMapCache = new Map<string, Promise<Map<string, string>>>();

/** Map one items_textures.json `texture` ref to a relative png path. */
function textureRefToRelPath(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 128) return null;
  const parts = ref.replace(/^minecraft:/, '').split('/');
  if (parts.length !== 2) return null; // "missingno", "entity/..." etc.
  const folder = parts[0] === 'items' || parts[0] === 'item' ? 'items' : parts[0] === 'block' || parts[0] === 'blocks' ? 'blocks' : null;
  if (!folder || !/^[a-z0-9_]{1,64}$/.test(parts[1])) return null;
  return `${folder}/${parts[1]}.png`;
}

function loadItemTextureMap(texturesRoot: string, version: string): Promise<Map<string, string>> {
  const key = `${texturesRoot}|${version}`;
  let p = itemMapCache.get(key);
  if (!p) {
    p = readFile(path.join(texturesRoot, version, 'items_textures.json'), 'utf8')
      .then((raw) => {
        const out = new Map<string, string>();
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const e of entries) {
            const name = (e as { name?: unknown })?.name;
            if (typeof name !== 'string' || !/^[a-z0-9_]{1,64}$/.test(name)) continue;
            const rel = textureRefToRelPath((e as { texture?: unknown }).texture);
            if (rel) out.set(name, rel);
          }
        }
        return out;
      })
      .catch(() => new Map<string, string>());
    itemMapCache.set(key, p);
  }
  return p;
}

/**
 * Resolve an /mcassets request to an absolute png path under `texturesRoot`,
 * or null when the version folder / item texture doesn't exist.
 */
export async function resolveMcAssetFile(
  texturesRoot: string,
  requestedVersion: string,
  itemName: string,
): Promise<string | null> {
  // Re-validate inputs so this function is safe even if a future caller
  // bypasses parseMcAssetUrl.
  if (requestedVersion !== 'latest' && versionKey(requestedVersion) === null) return null;
  if (!/^[a-z0-9_]{1,64}$/.test(itemName)) return null;
  const versions = await listTextureVersions(texturesRoot);
  const version = pickClosestVersion(requestedVersion, versions);
  if (!version) return null;
  const rel = (await loadItemTextureMap(texturesRoot, version)).get(itemName);
  if (!rel) return null;
  const abs = path.resolve(texturesRoot, version, rel);
  // Belt and braces: the path must stay inside the textures root.
  if (!abs.startsWith(path.resolve(texturesRoot) + path.sep)) return null;
  return abs;
}

let cachedRoot: string | null | undefined;

/**
 * Locate prismarine-viewer's bundled textures dir. Resolved relative to this
 * module (works from the bundled CJS main in dev and packaged builds; the
 * createRequire fallback covers ESM test runners). Null when the package
 * can't be resolved — the endpoint then 404s and the renderer keeps its
 * text-label slots.
 */
export function defaultTexturesRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  try {
    const req = typeof require === 'function' ? require : createRequire(process.cwd() + '/');
    cachedRoot = path.join(path.dirname(req.resolve('prismarine-viewer/package.json')), 'public', 'textures');
  } catch {
    cachedRoot = null;
  }
  return cachedRoot;
}
