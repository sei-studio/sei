/**
 * Minecraft Launcher profile files: read, write, and pick the Sei profile.
 *
 * The official launcher keeps its installations in `<.minecraft>/launcher_profiles.json`.
 * The Microsoft Store / Xbox app build of the launcher on Windows uses the
 * same `.minecraft` directory but its own file,
 * `launcher_profiles_microsoft_store.json` (the Fabric installer handles the
 * same split). Sei writes the Sei profile into every file that exists so the
 * profile shows up whichever launcher the player opens.
 *
 * The launcher preselects the installation with the newest `lastUsed`
 * timestamp (this is how the Fabric installer makes a fresh Fabric profile
 * the selected one), so "select the Sei profile" means "set its lastUsed to
 * now". Older launcher builds also honour a top-level `selectedProfile`
 * key; it is updated only when the file already has it.
 *
 * launcher_profiles.json is the one file Sei writes that Sei does NOT own,
 * so every write goes through atomicWrite (tmp + rename) and keeps every
 * field Sei does not understand.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { SEI_PROFILE_ICON } from './seiProfileIcon';

/** Launcher profile files, in the order Sei prefers them. */
export const LAUNCHER_PROFILE_FILES = [
  'launcher_profiles.json',
  'launcher_profiles_microsoft_store.json',
] as const;

/** Matches a Fabric version id and captures the Minecraft version. */
export const FABRIC_VERSION_ID_RE = /^fabric-loader-\d+\.\d+\.\d+-(\d+\.\d+(?:\.\d+)?)$/;


export interface LauncherProfile {
  name?: string;
  type?: string;
  created?: string;
  lastUsed?: string;
  icon?: string;
  lastVersionId?: string;
  gameDir?: string;
  [key: string]: unknown;
}

export interface LauncherProfilesDoc {
  profiles?: Record<string, LauncherProfile>;
  selectedProfile?: string;
  [key: string]: unknown;
}

/** `<.minecraft>/sei/<mcVersion>`: the isolated game dir of one Sei profile. */
export function seiGameDirFor(mcDir: string, mcVersion: string): string {
  return path.join(mcDir, 'sei', mcVersion);
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a).replace(/[\\/]+$/, '');
  const nb = path.resolve(b).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/** Resolve a profile's gameDir the way the launcher does (absent = mcDir). */
export function profileGameDir(mcDir: string, profile: LauncherProfile): string {
  const g = typeof profile.gameDir === 'string' ? profile.gameDir.trim() : '';
  return g ? path.resolve(mcDir, g) : mcDir;
}

export interface UpsertSeiProfileOpts {
  mcDir: string;
  mcVersion: string;
  /** Fabric version id, e.g. `fabric-loader-0.19.5-26.1`. */
  versionId: string;
  profileName: string;
  gameDir: string;
  now: Date;
}

/**
 * Insert or refresh the Sei profile for one Minecraft version and mark it
 * as the selected installation. Mutates and returns `doc`.
 *
 * Key choice, in order:
 *   1. an existing profile whose gameDir is this Sei game dir (Sei owns it,
 *      whatever key an older Sei or the Fabric installer gave it);
 *   2. `sei-<mcVersion>`.
 * Profiles Sei does not own are never renamed or repointed (the old
 * installer path renamed every `fabric-loader-*` profile on a key miss).
 */
export function upsertSeiProfile(
  doc: LauncherProfilesDoc,
  opts: UpsertSeiProfileOpts,
): { doc: LauncherProfilesDoc; key: string } {
  if (!doc.profiles || typeof doc.profiles !== 'object' || Array.isArray(doc.profiles)) {
    doc.profiles = {};
  }
  const profiles = doc.profiles;
  let key: string | undefined;
  for (const [k, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.gameDir !== 'string' || !p.gameDir.trim()) continue;
    if (!samePath(profileGameDir(opts.mcDir, p), opts.gameDir)) continue;
    // Before 260929 setup renamed EVERY fabric-loader-* profile to "Sei" and
    // pointed it at the Sei game dir of the version just set up, so this dir
    // can also be claimed by the player's own Fabric profile or by Sei's
    // profile for another version. Only a profile running this version (or
    // not a Fabric profile at all) is ours to reuse; otherwise a new
    // `sei-<version>` entry is made and the misfiled one is left as it is.
    const m = typeof p.lastVersionId === 'string' ? FABRIC_VERSION_ID_RE.exec(p.lastVersionId) : null;
    if (m && m[1] !== opts.mcVersion) continue;
    key = k;
    break;
  }
  key ??= `sei-${opts.mcVersion}`;
  const nowIso = opts.now.toISOString();
  const prev = profiles[key] && typeof profiles[key] === 'object' ? profiles[key] : {};
  profiles[key] = {
    ...prev,
    name: opts.profileName,
    type: 'custom',
    created: typeof prev.created === 'string' ? prev.created : nowIso,
    lastUsed: nowIso,
    icon: SEI_PROFILE_ICON,
    lastVersionId: opts.versionId,
    gameDir: opts.gameDir,
  };
  if (typeof doc.selectedProfile === 'string') doc.selectedProfile = key;
  return { doc, key };
}

/**
 * Make `key` the launcher's selected installation. Returns false when the
 * profile is not in this document.
 */
export function markProfileSelected(doc: LauncherProfilesDoc, key: string, now: Date): boolean {
  const p = doc.profiles?.[key];
  if (!p || typeof p !== 'object') return false;
  p.lastUsed = now.toISOString();
  if (typeof doc.selectedProfile === 'string') doc.selectedProfile = key;
  return true;
}

export interface SeiProfileRef {
  key: string;
  name: string;
  mcVersion: string;
  gameDir: string;
  lastUsed: string | null;
}

/**
 * True when `gameDir` is a per-version Sei dir (`<mcDir>/sei/<v>`) for a
 * Minecraft version other than `mcVersion`. Such a profile was misfiled by
 * the pre-260929 setup bug (every fabric-loader-* profile was repointed at
 * the newest Sei dir): its mods folder holds another version's skin mod, so
 * Fabric refuses to start it. It must never count as a Sei-ready profile.
 */
export function inOtherVersionSeiDir(mcDir: string, gameDir: string, mcVersion: string): boolean {
  const rel = path.relative(path.join(mcDir, 'sei'), gameDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length !== 1 || !/^\d+\.\d+(?:\.\d+)?$/.test(parts[0])) return false;
  return parts[0] !== mcVersion;
}

/**
 * Fabric profiles in a document, with the Minecraft version and resolved
 * game dir. Callers decide which of these count as "Sei" (skin mod present).
 * Profiles pointed at another version's Sei dir are left out (see
 * inOtherVersionSeiDir).
 */
export function listFabricProfiles(doc: LauncherProfilesDoc, mcDir: string): SeiProfileRef[] {
  const out: SeiProfileRef[] = [];
  const profiles = doc.profiles;
  if (!profiles || typeof profiles !== 'object') return out;
  for (const [key, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue;
    const m = typeof p.lastVersionId === 'string' ? FABRIC_VERSION_ID_RE.exec(p.lastVersionId) : null;
    if (!m) continue;
    const gameDir = profileGameDir(mcDir, p);
    if (inOtherVersionSeiDir(mcDir, gameDir, m[1])) continue;
    out.push({
      key,
      name: typeof p.name === 'string' && p.name.trim() ? p.name : key,
      mcVersion: m[1],
      gameDir,
      lastUsed: typeof p.lastUsed === 'string' ? p.lastUsed : null,
    });
  }
  return out;
}

/**
 * Read one launcher profile file. Returns null when the file is missing;
 * throws when it exists but is not a JSON object (never overwrite a file we
 * could not parse).
 */
export async function readProfilesFile(file: string): Promise<LauncherProfilesDoc | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  // Tolerate a UTF-8 BOM (hand-edited files); JSON.parse rejects it.
  const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path.basename(file)} is not a JSON object`);
  }
  return parsed as LauncherProfilesDoc;
}

/** Rename errors Windows raises while another process (launcher, antivirus) has the file open. */
const TRANSIENT_WIN_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WRITE_RETRY_DELAYS_MS = [100, 300, 800];

/**
 * Atomic write, two-space JSON like the launcher and the Fabric installer.
 * On Windows the final rename fails while another process holds the file
 * open without delete sharing (antivirus scanning it, the launcher reading
 * it), so a transient EPERM/EBUSY/EACCES is retried a few times. The old
 * file stays intact on every failure.
 */
export async function writeProfilesFile(
  file: string,
  doc: LauncherProfilesDoc,
  opts: { platform?: NodeJS.Platform; write?: (file: string, text: string) => Promise<void> } = {},
): Promise<void> {
  const text = JSON.stringify(doc, null, 2);
  const write = opts.write ?? ((f: string, t: string) => atomicWrite(f, t));
  const platform = opts.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try {
      await write(file, text);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const delay = WRITE_RETRY_DELAYS_MS[attempt];
      if (platform !== 'win32' || !TRANSIENT_WIN_CODES.has(code) || delay == null) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Absolute paths of the launcher profile files present in `mcDir`. */
export async function existingProfileFiles(mcDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of LAUNCHER_PROFILE_FILES) {
    const file = path.join(mcDir, name);
    try {
      await fs.access(file);
      out.push(file);
    } catch {
      /* absent */
    }
  }
  return out;
}
