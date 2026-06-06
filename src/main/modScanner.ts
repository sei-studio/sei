/**
 * Minecraft mod metadata scanner (Phase quick/260518-o1k Task 1).
 *
 * Pure, network-free, subprocess-free, IPC-free scanner that reads
 * `fabric.mod.json` and/or `META-INF/mods.toml` out of a JAR's ZIP central
 * directory and decides whether the JAR's declared `minecraft` version
 * constraint is satisfied by the given target MC version.
 *
 * NO WALL-CLOCK TIMEOUT — INTENTIONAL.
 *
 *   CLAUDE.md's "every external call has a wall-clock timeout" rule applies to
 *   network / subprocess / IPC paths (pathfinder, Anthropic, java subprocess,
 *   fetch). This file does NONE of those. It opens a local JAR file via
 *   `yauzl.open()`, walks the ZIP central directory, reads a single entry,
 *   and parses JSON or TOML in memory. The operation is bounded by file
 *   size — modern mods are <50MB, even Pixelmon-tier modpacks are <2GB.
 *
 *   If a future reader sees this and reflexively wants to add a timeout,
 *   please don't: a local-disk read does not need one, and adding one would
 *   require introducing an AbortController plumbing layer (yauzl's API is
 *   callback-based and doesn't natively accept abort signals). The cost of
 *   the abstraction would exceed the value of bounding a deterministic
 *   local read.
 *
 * Source format details:
 *   - Fabric: `fabric.mod.json` at the JAR root. JSON. `depends.minecraft`
 *     is a semver range — string OR array of strings OR omitted.
 *   - Forge / NeoForge: `META-INF/mods.toml`. TOML.
 *     `[[dependencies.<modId>]]` block with `modId = "minecraft"` carries
 *     `versionRange` (Maven-range syntax: `[1.20,1.21)`, `[1.16.5]`, etc.).
 *
 * Sources:
 *   - quick/260518-o1k PLAN.md Task T1
 *   - https://fabricmc.net/wiki/documentation:fabric_mod_json_spec
 *   - https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export type ModCompatibility =
  | {
      compatible: true;
      loader: 'fabric' | 'forge';
      modId: string;
      modVersion: string;
      declaredMc: string;
    }
  | {
      compatible: false;
      loader: 'fabric' | 'forge';
      modId: string;
      modVersion: string;
      declaredMc: string;
      reason: 'mc-version-mismatch';
    }
  | {
      compatible: false;
      loader: null;
      reason: 'unparseable' | 'no-metadata' | 'read-error';
      detail?: string;
    };

/* -------------------------------------------------------------------------- */
/*  ZIP entry extraction (yauzl helpers)                                       */
/* -------------------------------------------------------------------------- */

/** Read a single named entry's bytes out of a ZIP file. Resolves null if the
 *  entry isn't present. Throws on yauzl I/O errors. */
function readJarEntry(jarPath: string, wantedNames: string[]): Promise<
  { name: string; bytes: Buffer } | null
> {
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error('yauzl.open returned no zipfile'));
        return;
      }
      const zipfile = zip as ZipFile;
      let resolved = false;
      const settle = (val: { name: string; bytes: Buffer } | null) => {
        if (resolved) return;
        resolved = true;
        try {
          zipfile.close();
        } catch {
          /* ignore */
        }
        resolve(val);
      };
      const fail = (e: Error) => {
        if (resolved) return;
        resolved = true;
        try {
          zipfile.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };

      zipfile.on('error', fail);
      zipfile.on('end', () => settle(null));
      zipfile.on('entry', (entry: Entry) => {
        if (!wantedNames.includes(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (rsErr, stream) => {
          if (rsErr || !stream) {
            fail(rsErr ?? new Error('openReadStream returned no stream'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => settle({ name: entry.fileName, bytes: Buffer.concat(chunks) }));
          stream.on('error', fail);
        });
      });

      zipfile.readEntry();
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Fabric semver range resolver                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a Fabric-style minecraft version range against a concrete MC
 * version. Fabric uses semver ranges that mostly overlap with node-semver
 * (`>=1.21.0`, `~1.20.1`, `1.8.9`), but also accepts loose specifiers like
 * `*`, `>=1.14`, and partial versions (`1.14` should be `1.14.x`).
 *
 * Strategy:
 *   1. Treat `*` / empty / `any` as compatible-with-anything.
 *   2. Coerce both the version and the range with `semver.coerce`-style
 *      normalization where appropriate so `1.14` becomes `1.14.0`, etc.
 *   3. Hand off to `semver.satisfies` with `includePrerelease: true` so
 *      snapshots / release candidates don't get spuriously excluded.
 *   4. Fallback: if `semver.satisfies` rejects and the range is a bare
 *      version-prefix (e.g. `1.14`), do a prefix match against the version.
 */
export function satisfiesFabric(range: string, version: string): boolean {
  const r = String(range ?? '').trim();
  const v = String(version ?? '').trim();
  if (v === '') return false;
  if (r === '' || r === '*' || r.toLowerCase() === 'any') return true;

  // Normalize the version: `1.14` → `1.14.0`. Use coerce defensively.
  const coercedV = semver.valid(v) ?? semver.coerce(v)?.version ?? v;

  // Try direct semver.satisfies first.
  try {
    if (semver.satisfies(coercedV, r, { includePrerelease: true })) return true;
  } catch {
    // Range isn't a node-semver range; fall through to manual checks.
  }

  // Handle bare exact-version (`1.8.9`, `1.14`) — node-semver treats `1.14`
  // as `>=1.14.0 <1.15.0` already via satisfies, so this is mostly for the
  // case where the range threw above. We accept the range as a prefix of
  // the version.
  if (/^\d+(\.\d+){0,2}$/.test(r)) {
    if (coercedV === r) return true;
    if (coercedV.startsWith(r + '.')) return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Forge Maven-range resolver                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a Maven version range like `[1.20,1.21)` and test it against a
 * concrete version. Supported forms:
 *   - `[a,b]`   closed on both sides — a <= v <= b
 *   - `[a,b)`   closed-open         — a <= v < b
 *   - `(a,b]`   open-closed         — a <  v <= b
 *   - `(a,b)`   open on both sides  — a <  v <  b
 *   - `[a,)`    no upper bound      — a <= v
 *   - `(,b]`    no lower bound      — v <= b
 *   - `[a]`     exact (Maven syntactic shorthand for `[a,a]`)
 *   - `a`       bare exact          — v === a (semantically the same as [a])
 *
 * Empty / `*` / `any` → true (any version).
 *
 * Comparison uses semver — Forge versions are always semver-shaped MC
 * releases (`1.20.1`, `1.21.4`), and node-semver's `gte / gt / lte / lt`
 * accept partial versions via coerce.
 */
export function satisfiesForgeMavenRange(range: string, version: string): boolean {
  const r = String(range ?? '').trim();
  const v = String(version ?? '').trim();
  if (v === '') return false;
  if (r === '' || r === '*' || r.toLowerCase() === 'any') return true;

  const cv = semver.coerce(v)?.version ?? v;

  const cmp = (a: string, op: '>=' | '>' | '<=' | '<' | '=', b: string): boolean => {
    const ca = semver.coerce(a)?.version;
    const cb = semver.coerce(b)?.version;
    if (!ca || !cb) return false;
    if (op === '=') return semver.eq(ca, cb);
    if (op === '>=') return semver.gte(ca, cb);
    if (op === '>') return semver.gt(ca, cb);
    if (op === '<=') return semver.lte(ca, cb);
    if (op === '<') return semver.lt(ca, cb);
    return false;
  };

  // Bracketed form: `[a,b]`, `[a,b)`, `(a,b]`, `(a,b)`, `[a]`, `[a,)`, `(,b]`.
  const bracketMatch = /^([\[(])\s*([^,\s\])]*)\s*(?:,\s*([^,\s\])]*)\s*)?([\])])$/.exec(r);
  if (bracketMatch) {
    const [, openParen, low, high, closeParen] = bracketMatch;
    const lowInclusive = openParen === '[';
    const highInclusive = closeParen === ']';

    // `[a]` — exact-version shorthand (no comma).
    if (low && high === undefined) {
      return cmp(cv, '=', low);
    }

    // Lower bound check.
    if (low !== '') {
      const op = lowInclusive ? '>=' : '>';
      if (!cmp(cv, op, low)) return false;
    }
    // Upper bound check.
    if (high !== undefined && high !== '') {
      const op = highInclusive ? '<=' : '<';
      if (!cmp(cv, op, high)) return false;
    }
    return true;
  }

  // Bare exact version (`1.16.5`).
  if (/^\d+(\.\d+){0,2}$/.test(r)) {
    return cmp(cv, '=', r);
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Minimal TOML reader for mods.toml                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse just enough TOML to extract `mods.modId`, `mods.version`, and the
 * first `[[dependencies."<modId>"]]` block with `modId = "minecraft"`.
 *
 * mods.toml is small (<5KB typical) and structurally simple — top-level
 * key=value pairs, single-line strings, and `[[array.of.tables]]` blocks.
 * We don't need a full TOML implementation; we only need enough to read
 * three fields.
 *
 * Returns a normalized object; missing fields surface as undefined so the
 * caller's branch can return `no-metadata` cleanly.
 */
interface ParsedModsToml {
  mod: { modId?: string; version?: string } | null;
  minecraftRange: string | null;
}

function parseModsToml(text: string): ParsedModsToml {
  const lines = text.split(/\r?\n/);
  let section: string | null = null;
  let inMcDeps = false;
  let mcDepIsMinecraft = false;
  let pendingMcRange: string | null = null;

  const mod: { modId?: string; version?: string } = {};
  let firstMcRange: string | null = null;
  // Track first [[mods]] block.
  let firstModsBlockSeen = false;

  const readValue = (raw: string): string => {
    // Strip an inline `# comment`.
    let v = raw.trim();
    // Remove trailing comment if outside a quoted string.
    // (Crude — sufficient for the simple values we extract.)
    if (!(v.startsWith('"') || v.startsWith("'"))) {
      const hashIdx = v.indexOf('#');
      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
    }
    // Strip surrounding quotes (single or double).
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  };

  const commitMcRange = () => {
    if (mcDepIsMinecraft && pendingMcRange != null && firstMcRange == null) {
      firstMcRange = pendingMcRange;
    }
    mcDepIsMinecraft = false;
    pendingMcRange = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // Section header.
    const sectionMatch = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(line);
    if (sectionMatch) {
      // If we were tracking a dependencies entry, commit it before switching.
      if (inMcDeps) commitMcRange();

      const fullHeader = line;
      const name = sectionMatch[1].replace(/['"]/g, '');
      section = name;

      // Track [[mods]] block — first one wins.
      if (fullHeader.startsWith('[[') && name === 'mods') {
        firstModsBlockSeen = true;
        inMcDeps = false;
      } else if (fullHeader.startsWith('[[') && /^dependencies\b/.test(name)) {
        inMcDeps = true;
        mcDepIsMinecraft = false;
        pendingMcRange = null;
      } else {
        inMcDeps = false;
      }
      continue;
    }

    // key = value.
    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const value = readValue(kvMatch[2]);

    if (section === 'mods' && firstModsBlockSeen) {
      if (key === 'modId' && mod.modId === undefined) mod.modId = value;
      else if (key === 'version' && mod.version === undefined) mod.version = value;
    } else if (inMcDeps) {
      if (key === 'modId') {
        mcDepIsMinecraft = value === 'minecraft';
      } else if (key === 'versionRange') {
        pendingMcRange = value;
      }
    }
  }

  // Commit a trailing in-progress dependencies block at EOF.
  if (inMcDeps) commitMcRange();

  return {
    mod: mod.modId || mod.version ? mod : null,
    minecraftRange: firstMcRange,
  };
}

/* -------------------------------------------------------------------------- */
/*  Public: scanModJar                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Scan a JAR's metadata to determine whether it targets a compatible MC
 * version. See file header for the no-timeout rationale.
 *
 *   @param jarPath  Absolute path to the JAR file (local disk).
 *   @param targetMc Concrete MC version we're installing for, e.g. `1.21.4`.
 */
export async function scanModJar(jarPath: string, targetMc: string): Promise<ModCompatibility> {
  // Sanity check the path exists. ENOENT → read-error.
  try {
    await fs.access(jarPath);
  } catch {
    return { compatible: false, loader: null, reason: 'read-error', detail: 'file not found' };
  }

  let entry: { name: string; bytes: Buffer } | null;
  try {
    // Order matters: fabric.mod.json wins if both happen to be present (rare
    // but possible in Sinytra-style cross-loader packages).
    entry = await readJarEntry(jarPath, ['fabric.mod.json', 'META-INF/mods.toml']);
  } catch (err) {
    logger.warn(`modScanner: yauzl I/O failure for ${path.basename(jarPath)}: ${(err as Error).message}`);
    return { compatible: false, loader: null, reason: 'read-error', detail: (err as Error).message };
  }

  if (!entry) {
    return { compatible: false, loader: null, reason: 'no-metadata' };
  }

  // ── Fabric branch ─────────────────────────────────────────────────────
  if (entry.name === 'fabric.mod.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.bytes.toString('utf8'));
    } catch (err) {
      return {
        compatible: false,
        loader: null,
        reason: 'unparseable',
        detail: `fabric.mod.json JSON parse error: ${(err as Error).message}`,
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { compatible: false, loader: null, reason: 'unparseable', detail: 'fabric.mod.json not an object' };
    }
    const obj = parsed as {
      id?: unknown;
      version?: unknown;
      depends?: unknown;
    };
    const modId = typeof obj.id === 'string' ? obj.id : '';
    const modVersion = typeof obj.version === 'string' ? obj.version : '';
    if (!modId || !modVersion) {
      return { compatible: false, loader: null, reason: 'unparseable', detail: 'fabric.mod.json missing id/version' };
    }
    const depends = obj.depends as Record<string, unknown> | undefined;
    const mcDep = depends && typeof depends === 'object' ? depends.minecraft : undefined;

    let declaredMc: string;
    if (typeof mcDep === 'string') {
      declaredMc = mcDep;
    } else if (Array.isArray(mcDep) && mcDep.length > 0 && typeof mcDep[0] === 'string') {
      declaredMc = mcDep[0];
    } else if (mcDep == null) {
      // Mod doesn't declare an MC dependency — treat as no-metadata since we
      // can't make a compatibility decision.
      return { compatible: false, loader: null, reason: 'no-metadata', detail: 'fabric.mod.json has no depends.minecraft' };
    } else {
      return { compatible: false, loader: null, reason: 'unparseable', detail: 'depends.minecraft is not a string/array' };
    }

    const ok = satisfiesFabric(declaredMc, targetMc);
    if (ok) {
      return { compatible: true, loader: 'fabric', modId, modVersion, declaredMc };
    }
    return {
      compatible: false,
      loader: 'fabric',
      modId,
      modVersion,
      declaredMc,
      reason: 'mc-version-mismatch',
    };
  }

  // ── Forge / NeoForge branch ───────────────────────────────────────────
  // entry.name === 'META-INF/mods.toml'
  let parsedToml: ParsedModsToml;
  try {
    parsedToml = parseModsToml(entry.bytes.toString('utf8'));
  } catch (err) {
    return {
      compatible: false,
      loader: null,
      reason: 'unparseable',
      detail: `mods.toml parse error: ${(err as Error).message}`,
    };
  }

  const modId = parsedToml.mod?.modId ?? '';
  const modVersion = parsedToml.mod?.version ?? '';
  if (!modId || !modVersion) {
    return { compatible: false, loader: null, reason: 'unparseable', detail: 'mods.toml missing modId/version' };
  }
  const declaredMc = parsedToml.minecraftRange;
  if (declaredMc == null) {
    // No minecraft dependency declared — can't decide.
    return { compatible: false, loader: null, reason: 'no-metadata', detail: 'mods.toml has no minecraft dependency' };
  }

  const ok = satisfiesForgeMavenRange(declaredMc, targetMc);
  if (ok) {
    return { compatible: true, loader: 'forge', modId, modVersion, declaredMc };
  }
  return {
    compatible: false,
    loader: 'forge',
    modId,
    modVersion,
    declaredMc,
    reason: 'mc-version-mismatch',
  };
}
