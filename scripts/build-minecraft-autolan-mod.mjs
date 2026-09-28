#!/usr/bin/env node
// scripts/build-minecraft-autolan-mod.mjs [--only 1.21.1,26.1] [--no-write] [--keep-daemon]
//
// Builds the Sei Auto LAN Fabric mod (native/minecraft-autolan-mod) into
//   <repo>/assets/minecraft-autolan/sei-autolan-<ver>+mc<first>-<last>.jar
//   <repo>/assets/minecraft-autolan/manifest.json
// which electron-builder ships as extraResources (minecraft-autolan/) and
// src/main/mcAutoLan.ts copies into each Sei launcher profile's mods folder.
//
// How the jars are chosen. The mod is compiled once per stable Minecraft
// release in native/minecraft-autolan-mod/versions.json (oldest first). For
// every build it reads the constant pool of each class (javap) and the class
// file version. Consecutive releases whose builds are IDENTICAL there reference
// exactly the same Minecraft classes, methods and fields under the same runtime
// names (intermediary up to 1.21.11, Mojang names from 26.1), so the jar built
// for the first one runs on all of them. Each such run becomes one jar whose
// fabric.mod.json `minecraft` range is [first release, next group's first) and
// whose manifest entry the installer matches against the profile's version.
//
// Checks on top of the compile itself:
//   - obfuscated builds: the mixin's @Inject target must have been remapped to
//     an intermediary name (method_NNNN); a name the mappings did not know
//     would stay "tick" and silently never inject.
//   - unobfuscated builds: the Minecraft jar must declare `public void tick()`.
//
// Needs a JDK 21+ on PATH or JAVA_HOME (25 to compile the 26.x releases; the
// jars still target the Java each Minecraft line runs on) and network access
// to maven.fabricmc.net / Mojang for the first run. A full run is ~44 Gradle
// builds; Loom caches every Minecraft version under ~/.gradle, so reruns are
// fast. Plain node script: never run it from inside Electron.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD_DIR = path.join(ROOT, 'native', 'minecraft-autolan-mod');
const OUT_DIR = path.join(ROOT, 'assets', 'minecraft-autolan');
const log = (m) => console.log(`[autolan-mod] ${m}`);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const write = !flag('--no-write') && !only;

/** Same ordering as src/shared/mcSetup.ts compareMcVersions. */
function compareMc(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const unobfuscated = (mc) => compareMc(mc, '26.0') >= 0;

// ── JDK ──────────────────────────────────────────────────────────────────
function findJavaHome() {
  if (process.env.JAVA_HOME && existsSync(path.join(process.env.JAVA_HOME, 'bin', 'javap'))) {
    return process.env.JAVA_HOME;
  }
  for (const c of ['/usr/lib/jvm/java-25-openjdk-amd64', '/usr/lib/jvm/java-25-openjdk-arm64']) {
    if (existsSync(path.join(c, 'bin', 'javap'))) return c;
  }
  return null;
}
const JAVA_HOME = findJavaHome();
if (!JAVA_HOME) {
  console.error('[autolan-mod] no JDK found. Install JDK 25 (e.g. apt install openjdk-25-jdk-headless) or set JAVA_HOME.');
  process.exit(1);
}
const JAVAP = path.join(JAVA_HOME, 'bin', 'javap');
const env = { ...process.env, JAVA_HOME };
const gradlew = path.join(MOD_DIR, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

function gradle(mc, compat, mcRange) {
  const a = ['build', `-Pmc=${mc}`, `-Pcompat=${compat}`, '-q', '--console=plain'];
  if (mcRange) a.push(`-PmcRange=${mcRange}`);
  const r = spawnSync(gradlew, a, { cwd: MOD_DIR, env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`gradle build failed for Minecraft ${mc} (compat ${compat})`);
  const libs = path.join(MOD_DIR, 'build', `mc-${mc}`, 'libs');
  const jar = readdirSync(libs).find((f) => f.endsWith('.jar') && !f.includes('-sources'));
  if (!jar) throw new Error(`no jar in ${libs}`);
  return path.join(libs, jar);
}

function unzipTo(jar) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sei-autolan-'));
  execFileSync('unzip', ['-q', jar, '-d', dir]);
  return dir;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * What a jar asks of Minecraft: per class, its class file version and every
 * constant-pool string (member names, descriptors, annotation values). Two
 * jars with the same signature link against Minecraft identically.
 */
function signature(jar) {
  const dir = unzipTo(jar);
  try {
    const parts = [];
    let mixinTargets = [];
    for (const f of walk(dir).filter((p) => p.endsWith('.class')).sort()) {
      const buf = readFileSync(f);
      const major = buf.readUInt16BE(6);
      const out = execFileSync(JAVAP, ['-v', '-p', f], { encoding: 'utf8' });
      const utf8 = [...out.matchAll(/= Utf8\s+(.*)$/gm)].map((m) => m[1]).sort();
      parts.push(`${path.relative(dir, f)}@${major}\n${utf8.join('\n')}`);
      if (f.endsWith('MinecraftMixin.class')) {
        // javap renders the @Inject annotation as `method=["method_1574"]`.
        mixinTargets = [...out.matchAll(/^\s*method=\["([^"]+)"\]/gm)].map((m) => m[1]);
      }
    }
    const mixins = JSON.parse(readFileSync(path.join(dir, 'sei-autolan.mixins.json'), 'utf8'));
    parts.push(`mixins@${mixins.compatibilityLevel}`);
    const text = parts.join('\n--\n');
    return {
      hash: createHash('sha256').update(text).digest('hex'),
      mixinTargets,
      javaMajor: Math.max(...parts.map((p) => parseInt(p.split('@')[1], 10) || 0)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The Mojang-named client jar Loom unpacked for an unobfuscated release. */
function loomMinecraftJar(mc) {
  const base = path.join(homedir(), '.gradle', 'caches', 'fabric-loom', mc);
  for (const n of ['minecraft-merged.jar', 'minecraft-client.jar']) {
    if (existsSync(path.join(base, n))) return path.join(base, n);
  }
  return null;
}

function checkMixinTarget(mc, sig) {
  const target = sig.mixinTargets[0];
  if (!target) throw new Error(`${mc}: could not read the @Inject target from MinecraftMixin`);
  if (!unobfuscated(mc)) {
    if (!/^method_\d+$/.test(target)) {
      throw new Error(`${mc}: @Inject target "${target}" was not remapped to intermediary; Minecraft.tick() is missing from its mappings`);
    }
    return target;
  }
  const mcJar = loomMinecraftJar(mc);
  if (!mcJar) throw new Error(`${mc}: Loom's Minecraft jar not found to check tick()`);
  const out = execFileSync(JAVAP, ['-cp', mcJar, 'net.minecraft.client.Minecraft'], { encoding: 'utf8' });
  if (!/public void tick\(\);/.test(out)) throw new Error(`${mc}: net.minecraft.client.Minecraft has no public void tick()`);
  return target;
}

// ── Matrix ───────────────────────────────────────────────────────────────
const versions = JSON.parse(readFileSync(path.join(MOD_DIR, 'versions.json'), 'utf8'));
const modVersion = /mod_version=(.+)/.exec(readFileSync(path.join(MOD_DIR, 'gradle.properties'), 'utf8'))[1].trim();
const matrix = versions.matrix.filter((e) => !only || only.includes(e.mc));
for (let i = 1; i < versions.matrix.length; i++) {
  if (compareMc(versions.matrix[i - 1].mc, versions.matrix[i].mc) >= 0) {
    throw new Error(`versions.json matrix is not in ascending order at ${versions.matrix[i].mc}`);
  }
}

const results = [];
for (const e of matrix) {
  log(`build ${e.mc} (compat ${e.compat})`);
  const jar = gradle(e.mc, e.compat);
  const sig = signature(jar);
  const target = checkMixinTarget(e.mc, sig);
  log(`  ${e.mc}: sig ${sig.hash.slice(0, 12)} class v${sig.javaMajor} inject ${target}`);
  results.push({ ...e, sig });
}

if (!write) {
  log(`checked ${results.length} release(s); --only / --no-write leaves assets/ untouched`);
  process.exit(0);
}

// ── Group consecutive identical builds ───────────────────────────────────
const groups = [];
for (const r of results) {
  const g = groups[groups.length - 1];
  if (g && g.sig.hash === r.sig.hash && g.compat === r.compat) g.verified.push(r.mc);
  else groups.push({ compat: r.compat, sig: r.sig, verified: [r.mc] });
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const jars = [];
for (let i = 0; i < groups.length; i++) {
  const g = groups[i];
  const first = g.verified[0];
  const last = g.verified[g.verified.length - 1];
  const maxExclusive = i + 1 < groups.length ? groups[i + 1].verified[0] : versions.ceiling;
  const range = `>=${first} <${maxExclusive}`;
  log(`jar for ${first}..${last} (range "${range}")`);
  const jar = gradle(first, g.compat, range);
  const sig = signature(jar);
  if (sig.hash !== g.sig.hash) throw new Error(`${first}: the range build differs from the matrix build`);
  const file = `sei-autolan-${modVersion}+mc${first === last ? first : `${first}-${last}`}.jar`;
  copyFileSync(jar, path.join(OUT_DIR, file));
  const bytes = readFileSync(path.join(OUT_DIR, file));
  jars.push({
    file,
    minMc: first,
    maxMcExclusive: maxExclusive,
    verified: g.verified,
    javaMajor: sig.javaMajor,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  });
}

const manifest = {
  comment: 'Generated by scripts/build-minecraft-autolan-mod.mjs. Do not edit by hand.',
  modId: 'sei-autolan',
  modVersion,
  jars,
};
writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(path.join(MOD_DIR, 'LICENSE'), path.join(OUT_DIR, 'LICENSE'));
log(`wrote ${jars.length} jar(s) + manifest.json to ${path.relative(ROOT, OUT_DIR)}`);
if (!flag('--keep-daemon')) spawnSync(gradlew, ['--stop'], { cwd: MOD_DIR, env, stdio: 'ignore' });
