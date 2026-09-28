/**
 * Start Minecraft (R1b, 260929): select the Sei profile in the Minecraft
 * Launcher and open the launcher, so the player only has to press Play.
 *
 * Selection: the launcher preselects the installation with the newest
 * `lastUsed` (launcherProfiles.ts), so the Sei profile is stamped with now in
 * every launcher profile file that has it. The launcher reads the file at
 * startup only; when it is already running it keeps its own selection, and
 * the result says so (`alreadyOpen`) so the UI can tell the player which
 * profile to pick next to Play.
 *
 * Launchers:
 *   - macOS: Minecraft.app in /Applications or ~/Applications, then the
 *     bundle id as a last resort.
 *   - Windows: the Microsoft Store / Xbox app launcher (the package Mojang's
 *     current installer also deploys) opened by its AppUserModelID through
 *     `explorer.exe shell:AppsFolder\...`, and the legacy
 *     `Minecraft Launcher\MinecraftLauncher.exe` in Program Files. When both
 *     exist, the one whose profile file was written last goes first.
 *
 * Nothing here can be verified on Linux beyond the pure helpers (tests); the
 * actual open and the lastUsed preselect need a Mac and a Windows machine.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import { compareMcVersions } from '../shared/mcSetup';
import type { MinecraftLauncherKind, StartMinecraftResult } from '../shared/ipc';
import {
  LAUNCHER_PROFILE_FILES,
  listFabricProfiles,
  markProfileSelected,
  readProfilesFile,
  writeProfilesFile,
  type LauncherProfilesDoc,
  type SeiProfileRef,
} from './launcherProfiles';
import { detectCustomSkinLoader, vanillaPaths } from './mcInstallScan';

const execFile = promisify(execFileCb);

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/** Package family of the Microsoft Store / Xbox app Minecraft Launcher. */
export const STORE_PACKAGE_FAMILY = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';
/** AppUserModelID of that launcher (package family + "!Minecraft"). */
export const STORE_LAUNCHER_AUMID = `${STORE_PACKAGE_FAMILY}!Minecraft`;
/** macOS launcher bundle id, used only when no Minecraft.app is found. */
export const MAC_LAUNCHER_BUNDLE_ID = 'com.mojang.minecraftlauncher';

const PROBE_TIMEOUT_MS = 5_000;

export interface LauncherCandidate {
  kind: MinecraftLauncherKind;
  /** 'path': open an app bundle / exe. 'aumid': a packaged Windows app. 'bundle-id': `open -b`. */
  via: 'path' | 'aumid' | 'bundle-id';
  target: string;
}

export interface LauncherEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => Promise<boolean>;
  mtimeMs: (p: string) => Promise<number | null>;
}

function defaultEnv(): LauncherEnv {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    exists: async (p) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    mtimeMs: async (p) => {
      try {
        return (await fs.stat(p)).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}

/** Launchers to try, best first. Pure apart from the injected fs probes. */
export async function launcherCandidates(e: LauncherEnv, mcDir: string | null): Promise<LauncherCandidate[]> {
  const out: LauncherCandidate[] = [];
  if (e.platform === 'darwin') {
    const apps = [
      '/Applications/Minecraft.app',
      path.join(e.home, 'Applications', 'Minecraft.app'),
      '/Applications/Minecraft Launcher.app',
    ];
    for (const app of apps) {
      if (await e.exists(app)) out.push({ kind: 'mac', via: 'path', target: app });
    }
    out.push({ kind: 'mac', via: 'bundle-id', target: MAC_LAUNCHER_BUNDLE_ID });
    return out;
  }
  if (e.platform !== 'win32') return out;

  const win = path.win32;
  const localAppData = e.env.LOCALAPPDATA ?? win.join(e.home, 'AppData', 'Local');
  const storeSignals = [
    win.join(localAppData, 'Packages', STORE_PACKAGE_FAMILY),
    win.join(e.env.SystemDrive ?? 'C:', 'XboxGames', 'Minecraft Launcher'),
    ...(mcDir ? [win.join(mcDir, LAUNCHER_PROFILE_FILES[1])] : []),
  ];
  let store: LauncherCandidate | null = null;
  for (const s of storeSignals) {
    if (await e.exists(s)) {
      store = { kind: 'windows-store', via: 'aumid', target: STORE_LAUNCHER_AUMID };
      break;
    }
  }
  const legacyExes = [
    e.env['ProgramFiles(x86)'] ? win.join(e.env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe') : null,
    e.env.ProgramFiles ? win.join(e.env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe') : null,
  ].filter((p): p is string => !!p);
  let legacy: LauncherCandidate | null = null;
  for (const exe of legacyExes) {
    if (await e.exists(exe)) {
      legacy = { kind: 'windows', via: 'path', target: exe };
      break;
    }
  }
  if (store && legacy && mcDir) {
    // Both installed: the launcher the player used last wrote its files last.
    // The accounts files come first because Sei never writes them; Sei's own
    // setup writes BOTH profile files, which leaves their mtimes saying
    // nothing about the player. Profile files are the fallback when neither
    // accounts file exists.
    for (const [legacyName, storeName] of [
      ['launcher_accounts.json', 'launcher_accounts_microsoft_store.json'],
      [LAUNCHER_PROFILE_FILES[0], LAUNCHER_PROFILE_FILES[1]],
    ] as const) {
      const storeT = await e.mtimeMs(win.join(mcDir, storeName));
      const legacyT = await e.mtimeMs(win.join(mcDir, legacyName));
      if (storeT == null && legacyT == null) continue;
      return (legacyT ?? 0) > (storeT ?? 0) ? [legacy, store] : [store, legacy];
    }
    return [store, legacy];
  }
  if (store) out.push(store);
  if (legacy) out.push(legacy);
  return out;
}

export interface FoundSeiProfile extends SeiProfileRef {
  /** Launcher profile files (absolute) that carry this profile, with its key in each. */
  files: Array<{ file: string; key: string }>;
}

/**
 * The Sei-ready profile to start: a Fabric profile for a version Sei can join
 * whose own mods folder has the skin mod. `preferred` wins when present;
 * otherwise the newest version, then a "Sei ..." name, then the latest used.
 */
export async function findSeiProfile(
  mcDir: string,
  opts: {
    preferred?: string;
    supported?: readonly string[];
    hasSkinMod?: (modsDir: string) => Promise<boolean>;
  } = {},
): Promise<FoundSeiProfile | null> {
  const supported = opts.supported ?? supportedVersions;
  const hasSkinMod =
    opts.hasSkinMod ?? (async (dir: string) => (await detectCustomSkinLoader(dir)).installed);
  const byId = new Map<string, FoundSeiProfile>();
  for (const name of LAUNCHER_PROFILE_FILES) {
    const file = path.join(mcDir, name);
    let doc: LauncherProfilesDoc | null;
    try {
      doc = await readProfilesFile(file);
    } catch {
      continue;
    }
    if (!doc) continue;
    for (const p of listFabricProfiles(doc, mcDir)) {
      if (!supported.includes(p.mcVersion)) continue;
      const id = `${p.mcVersion}\u0000${path.resolve(p.gameDir)}`;
      const seen = byId.get(id);
      if (seen) {
        seen.files.push({ file, key: p.key });
        if ((p.lastUsed ?? '') > (seen.lastUsed ?? '')) seen.lastUsed = p.lastUsed;
        continue;
      }
      if (!(await hasSkinMod(path.join(p.gameDir, 'mods')))) continue;
      byId.set(id, { ...p, files: [{ file, key: p.key }] });
    }
  }
  const all = [...byId.values()];
  if (all.length === 0) return null;
  const rank = (a: FoundSeiProfile, b: FoundSeiProfile): number => {
    if (opts.preferred) {
      const pa = a.mcVersion === opts.preferred ? 1 : 0;
      const pb = b.mcVersion === opts.preferred ? 1 : 0;
      if (pa !== pb) return pb - pa;
    }
    const v = compareMcVersions(b.mcVersion, a.mcVersion);
    if (v !== 0) return v;
    const sa = /^sei\b/i.test(a.name) ? 1 : 0;
    const sb = /^sei\b/i.test(b.name) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '');
  };
  return all.sort(rank)[0];
}

/** Stamp lastUsed = now on the profile in every file that has it. */
export async function selectSeiProfile(found: FoundSeiProfile, now = new Date()): Promise<number> {
  let n = 0;
  for (const { file, key } of found.files) {
    try {
      const doc = await readProfilesFile(file);
      if (!doc || !markProfileSelected(doc, key, now)) continue;
      await writeProfilesFile(file, doc);
      n++;
    } catch (err) {
      logger.warn(`mcLauncher: could not select profile in ${file}: ${(err as Error).message}`);
    }
  }
  return n;
}

/** Best-effort: is a Minecraft Launcher process running? False when unsure. */
export async function isLauncherRunning(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      await execFile('pgrep', ['-f', 'Minecraft( Launcher)?\\.app/Contents/MacOS/'], { timeout: PROBE_TIMEOUT_MS });
      return true; // pgrep exits 0 only on a match
    }
    if (platform === 'win32') {
      const { stdout } = await execFile('tasklist', ['/FO', 'CSV', '/NH'], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return tasklistHasLauncher(stdout);
    }
  } catch {
    /* no match, or the probe is unavailable */
  }
  return false;
}

/** `tasklist /FO CSV /NH` output contains a launcher process. */
export function tasklistHasLauncher(csv: string): boolean {
  return /^"(MinecraftLauncher|Minecraft)\.exe"/im.test(csv);
}

async function openCandidate(c: LauncherCandidate): Promise<void> {
  if (c.via === 'aumid') {
    // explorer.exe exits 1 even on success, so only a spawn failure counts.
    await new Promise<void>((resolve, reject) => {
      const child = execFileCb('explorer.exe', [`shell:AppsFolder\\${c.target}`], { windowsHide: true }, () => resolve());
      child.once('error', reject);
    });
    return;
  }
  if (c.via === 'bundle-id') {
    await execFile('open', ['-b', c.target], { timeout: PROBE_TIMEOUT_MS });
    return;
  }
  const { shell } = await import('electron');
  const err = await shell.openPath(c.target);
  if (err) throw new Error(err);
}

export interface StartMinecraftDeps {
  env?: LauncherEnv;
  mcDir?: string | null;
  isRunning?: () => Promise<boolean>;
  open?: (c: LauncherCandidate) => Promise<void>;
  supported?: readonly string[];
  hasSkinMod?: (modsDir: string) => Promise<boolean>;
  now?: Date;
}

/** Select the Sei profile and open the launcher. Never throws. */
export async function startMinecraft(
  args: { mcVersion?: string } = {},
  deps: StartMinecraftDeps = {},
): Promise<StartMinecraftResult> {
  const env = deps.env ?? defaultEnv();
  try {
    let mcDir = deps.mcDir === undefined ? null : deps.mcDir;
    if (deps.mcDir === undefined) {
      for (const p of vanillaPaths({ platformOverride: env.platform, homedirOverride: env.home })) {
        if (await env.exists(p)) {
          mcDir = p;
          break;
        }
      }
    }
    const found = mcDir
      ? await findSeiProfile(mcDir, { preferred: args.mcVersion, supported: deps.supported, hasSkinMod: deps.hasSkinMod })
      : null;
    if (!found) return { ok: false, reason: 'no_profile' };

    // Order the launchers before selecting: writing the profile files moves
    // their mtimes, which is what the Windows ordering reads.
    const candidates = await launcherCandidates(env, mcDir);
    const alreadyOpen = await (deps.isRunning ?? (() => isLauncherRunning(env.platform)))();
    await selectSeiProfile(found, deps.now);

    if (candidates.length === 0) {
      return { ok: false, reason: 'no_launcher', profileName: found.name };
    }
    const open = deps.open ?? openCandidate;
    const errors: string[] = [];
    for (const c of candidates) {
      try {
        await open(c);
        logger.info(`mcLauncher: opened ${c.kind} launcher (${c.via}) with profile '${found.name}'`);
        return { ok: true, profileName: found.name, mcVersion: found.mcVersion, launcher: c.kind, alreadyOpen };
      } catch (err) {
        errors.push(`${c.kind}/${c.via}: ${(err as Error).message}`);
      }
    }
    logger.warn(`mcLauncher: could not open a launcher: ${errors.join('; ')}`);
    return { ok: false, reason: 'launch_failed', profileName: found.name, detail: errors.join('; ') };
  } catch (err) {
    logger.warn(`mcLauncher: startMinecraft failed: ${(err as Error).message}`);
    return { ok: false, reason: 'launch_failed', detail: (err as Error).message };
  }
}
