/**
 * What the Minecraft install scan cannot use but the player should hear
 * about (261104). 30% of new users had no Java install the scan found
 * (~54 a week), and the setup step only said "Install Minecraft Java
 * Edition". Three common reasons, each with its own note in McSteps:
 *
 *   - Bedrock only (Minecraft for Windows, from the Store, the Xbox app or
 *     the Minecraft Launcher's Bedrock tab). Sei joins Java worlds only.
 *     Since June 2022 a Microsoft account that owns either PC edition owns
 *     both, so most of these players already have Java one click away.
 *   - The Minecraft Launcher is installed but Java was never played, so no
 *     `.minecraft` exists yet.
 *   - Java lives in a third-party launcher (Prism, MultiMC, Modrinth App,
 *     ATLauncher). DETECTION ONLY: Sei's setup writes a Fabric profile into
 *     the official launcher's files and cannot do that here, but the bot
 *     joins any LAN world on a supported version, so the player can open the
 *     instance's world to LAN themselves.
 *
 * Read-only, best effort: every probe swallows its error, and a missing
 * folder simply is not reported. Instance names are shown in the UI only;
 * telemetry gets launcher kinds and booleans (setupTelemetry.ts).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McOtherLauncher, McOtherInstance, McScanExtras } from '../shared/ipc';

/** Instances read per launcher root (DoS guard, like MAX_CF_INSTANCES). */
const MAX_INSTANCES = 50;

/** Store package of Minecraft for Windows (Bedrock, UWP builds). */
export const BEDROCK_UWP_PACKAGE = 'Microsoft.MinecraftUWP_8wekyb3d8bbwe';
/** Store package of the Minecraft Launcher (Java + Bedrock launcher). */
export const LAUNCHER_STORE_PACKAGE = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';

export interface OtherInstallsEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Fixed-drive roots probed for XboxGames (Windows: C:\ .. H:\, like the Stardew scan). */
  driveRoots: string[];
  /** macOS application folders. */
  macAppDirs: string[];
}

export function defaultOtherInstallsEnv(): OtherInstallsEnv {
  const home = os.homedir();
  const driveRoots: string[] = [];
  for (let d = 'C'.charCodeAt(0); d <= 'H'.charCodeAt(0); d++) driveRoots.push(`${String.fromCharCode(d)}:\\`);
  return {
    platform: process.platform,
    home,
    env: process.env,
    driveRoots,
    macAppDirs: ['/Applications', path.join(home, 'Applications')],
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function appData(e: OtherInstallsEnv): string {
  return e.env.APPDATA ?? path.join(e.home, 'AppData', 'Roaming');
}

function localAppData(e: OtherInstallsEnv): string {
  return e.env.LOCALAPPDATA ?? path.join(e.home, 'AppData', 'Local');
}

/** Per-OS data folder a cross-platform launcher keeps (APPDATA / Application Support / XDG). */
function dataDirs(e: OtherInstallsEnv, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (e.platform === 'win32') out.push(path.join(appData(e), name));
    else if (e.platform === 'darwin') out.push(path.join(e.home, 'Library', 'Application Support', name));
    else out.push(path.join(e.env.XDG_DATA_HOME ?? path.join(e.home, '.local', 'share'), name));
  }
  return out;
}

/** Launcher roots, each with the subfolder its instances live in. */
export function launcherRoots(e: OtherInstallsEnv): { launcher: McOtherLauncher; root: string; sub: string }[] {
  const out: { launcher: McOtherLauncher; root: string; sub: string }[] = [];
  for (const root of dataDirs(e, ['PrismLauncher'])) out.push({ launcher: 'prism', root, sub: 'instances' });
  if (e.platform === 'linux') {
    out.push({ launcher: 'prism', root: path.join(e.home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher'), sub: 'instances' });
  }
  // MultiMC is portable on Windows: no fixed folder, so the usual unzip spots.
  if (e.platform === 'win32') {
    for (const dir of [path.join(e.home, 'MultiMC'), path.join(e.home, 'Desktop', 'MultiMC'), path.join(e.home, 'Downloads', 'MultiMC'), path.join(e.home, 'Documents', 'MultiMC'), path.join(localAppData(e), 'MultiMC')]) {
      out.push({ launcher: 'multimc', root: dir, sub: 'instances' });
    }
  } else {
    for (const root of dataDirs(e, e.platform === 'darwin' ? ['MultiMC'] : ['multimc'])) out.push({ launcher: 'multimc', root, sub: 'instances' });
  }
  for (const root of dataDirs(e, ['ModrinthApp', 'com.modrinth.theseus'])) out.push({ launcher: 'modrinth', root, sub: 'profiles' });
  for (const root of dataDirs(e, e.platform === 'linux' ? ['ATLauncher', 'atlauncher'] : ['ATLauncher'])) out.push({ launcher: 'atlauncher', root, sub: 'instances' });
  return out;
}

/** Prism / MultiMC `mmc-pack.json`: the Minecraft version and the loader component. */
export function parseMmcPack(doc: unknown): { mc_version: string | null; loader: McOtherInstance['loader'] } {
  const comps = (doc as { components?: unknown })?.components;
  if (!Array.isArray(comps)) return { mc_version: null, loader: null };
  let mc: string | null = null;
  let loader: McOtherInstance['loader'] = 'vanilla';
  for (const c of comps) {
    const uid = typeof c?.uid === 'string' ? c.uid : '';
    const version = typeof c?.version === 'string' ? c.version : typeof c?.cachedVersion === 'string' ? c.cachedVersion : null;
    if (uid === 'net.minecraft') mc = version;
    else if (uid === 'net.fabricmc.fabric-loader') loader = 'fabric';
    else if (uid === 'org.quiltmc.quilt-loader') loader = 'quilt';
    else if (uid === 'net.neoforged') loader = 'neoforge';
    else if (uid === 'net.minecraftforge') loader = 'forge';
  }
  return { mc_version: mc, loader };
}

function loaderFromName(name: unknown): McOtherInstance['loader'] {
  const n = String(name ?? '').toLowerCase();
  if (!n) return null;
  if (n.includes('neoforge')) return 'neoforge';
  if (n.includes('forge')) return 'forge';
  if (n.includes('quilt')) return 'quilt';
  if (n.includes('fabric')) return 'fabric';
  if (n.includes('vanilla')) return 'vanilla';
  return null;
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

async function readInstance(launcher: McOtherLauncher, dir: string, name: string): Promise<McOtherInstance | null> {
  if (launcher === 'prism' || launcher === 'multimc') {
    // An instance folder holds instance.cfg; mmc-pack.json names the components.
    if (!(await exists(path.join(dir, 'instance.cfg')))) return null;
    const pack = parseMmcPack(await readJson(path.join(dir, 'mmc-pack.json')));
    return { launcher, label: name, ...pack };
  }
  if (launcher === 'atlauncher') {
    const doc = (await readJson(path.join(dir, 'instance.json'))) as { id?: unknown; launcher?: { loaderVersion?: { type?: unknown } } } | null;
    if (!doc) return null;
    const id = typeof doc.id === 'string' && VERSION_RE.test(doc.id) ? doc.id : null;
    return { launcher, label: name, mc_version: id, loader: loaderFromName(doc.launcher?.loaderVersion?.type) ?? 'vanilla' };
  }
  // Modrinth App: newer builds keep metadata in app.db (SQLite, not read);
  // older Theseus builds wrote profile.json. A profile folder counts either way.
  const doc = (await readJson(path.join(dir, 'profile.json'))) as { metadata?: { game_version?: unknown; loader?: unknown } } | null;
  const gv = doc?.metadata?.game_version;
  return {
    launcher,
    label: name,
    mc_version: typeof gv === 'string' && VERSION_RE.test(gv) ? gv : null,
    loader: loaderFromName(doc?.metadata?.loader),
  };
}

/** Prism keeps a custom instance folder in prismlauncher.cfg (`InstanceDir=`). */
async function prismInstanceDir(root: string, sub: string): Promise<string> {
  try {
    const cfg = await fs.readFile(path.join(root, 'prismlauncher.cfg'), 'utf8');
    const m = /^InstanceDir=(.+)$/m.exec(cfg);
    if (m) {
      const v = m[1].trim();
      if (v) return path.isAbsolute(v) ? v : path.join(root, v);
    }
  } catch {
    /* default folder */
  }
  return path.join(root, sub);
}

export async function scanOtherLaunchers(e: OtherInstallsEnv): Promise<McOtherInstance[]> {
  const out: McOtherInstance[] = [];
  const seen = new Set<string>();
  for (const { launcher, root, sub } of launcherRoots(e)) {
    const dir = launcher === 'prism' ? await prismInstanceDir(root, sub) : path.join(root, sub);
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    let names: string[];
    try {
      names = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map((d) => d.name)
        .slice(0, MAX_INSTANCES);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const inst = await readInstance(launcher, path.join(dir, name), name);
        if (inst) out.push(inst);
      } catch {
        /* unreadable instance: skip */
      }
    }
  }
  return out;
}

/** Bedrock (Minecraft for Windows) on this machine. Windows only. */
export async function bedrockInstalled(e: OtherInstallsEnv): Promise<boolean> {
  if (e.platform !== 'win32') return false;
  const probes = [
    path.join(localAppData(e), 'Packages', BEDROCK_UWP_PACKAGE),
    // The GDK builds (2025+) install under XboxGames and keep data here.
    path.join(appData(e), 'Minecraft Bedrock'),
    ...e.driveRoots.map((d) => path.join(d, 'XboxGames', 'Minecraft for Windows')),
  ];
  for (const p of probes) if (await exists(p)) return true;
  return false;
}

/** The official Minecraft Launcher is installed (whether or not Java was ever played). */
export async function officialLauncherInstalled(e: OtherInstallsEnv): Promise<boolean> {
  const probes: string[] = [];
  if (e.platform === 'win32') {
    probes.push(path.join(localAppData(e), 'Packages', LAUNCHER_STORE_PACKAGE));
    for (const d of e.driveRoots) probes.push(path.join(d, 'XboxGames', 'Minecraft Launcher'));
    for (const pf of [e.env['ProgramFiles(x86)'], e.env.ProgramFiles]) {
      if (pf) probes.push(path.join(pf, 'Minecraft Launcher', 'MinecraftLauncher.exe'));
    }
  } else if (e.platform === 'darwin') {
    for (const dir of e.macAppDirs) {
      probes.push(path.join(dir, 'Minecraft.app'), path.join(dir, 'Minecraft Launcher.app'));
    }
  }
  for (const p of probes) if (await exists(p)) return true;
  return false;
}

export async function scanMcExtras(e: OtherInstallsEnv = defaultOtherInstallsEnv()): Promise<McScanExtras> {
  const [others, bedrock, launcherInstalled] = await Promise.all([
    scanOtherLaunchers(e).catch(() => [] as McOtherInstance[]),
    bedrockInstalled(e).catch(() => false),
    officialLauncherInstalled(e).catch(() => false),
  ]);
  return { others, bedrock, launcherInstalled };
}
