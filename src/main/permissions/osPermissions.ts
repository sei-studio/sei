/**
 * OS permission helpers (260929). Pure logic only, no electron import, so the
 * allowlist, the URL choice, the resume flag and the screen-probe verdict are
 * unit tested directly. The electron glue is permissionsService.ts.
 *
 * WHY A SEPARATE OPENER. app.openExternal only lets https (and mailto) through
 * (lib/externalUrlValidator.ts), and it should stay that way. The Settings deep
 * links are custom schemes (x-apple.systempreferences:, ms-settings:), so they
 * get their own path that opens EXACTLY the strings below and nothing else. The
 * renderer asks by kind; it never supplies a URL.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PERMISSION_RESUME_TTL_MS,
  type OsPermissionKind,
  type OsPermissionStatus,
  type PermissionResume,
} from '../../shared/permissionsIpc';

export const SETTINGS_URLS = {
  /** macOS 13 Ventura and later (System Settings). */
  macMicModern: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone',
  macScreenModern:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
  /** macOS 12 Monterey and earlier (System Preferences). */
  macMicLegacy: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  macScreenLegacy: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  winMic: 'ms-settings:privacy-microphone',
} as const;

/** Every URL the settings opener will ever pass to shell.openExternal. */
export const ALLOWED_SETTINGS_URLS: ReadonlySet<string> = new Set(Object.values(SETTINGS_URLS));

/** Exact-match gate. Throws on anything not in the allowlist. */
export function assertAllowedSettingsUrl(url: string): void {
  if (!ALLOWED_SETTINGS_URLS.has(url)) throw new Error('Settings URL not allowed');
}

/** Major macOS version from process.getSystemVersion() ("14.5.0" -> 14). */
export function macMajor(systemVersion: string): number {
  const n = Number.parseInt(String(systemVersion).split('.')[0] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The Settings page for this permission on this OS, or null where there is no
 * such page (Screen Recording is a macOS-only gate; Linux has neither).
 * An unreadable macOS version gets the modern URL: every macOS Sei can still
 * be installed on that would misreport is recent.
 */
export function settingsUrlFor(
  kind: OsPermissionKind,
  platform: NodeJS.Platform | string,
  systemVersion: string,
): string | null {
  if (platform === 'darwin') {
    const major = macMajor(systemVersion);
    const legacy = major > 0 && major < 13;
    if (kind === 'mic') return legacy ? SETTINGS_URLS.macMicLegacy : SETTINGS_URLS.macMicModern;
    return legacy ? SETTINGS_URLS.macScreenLegacy : SETTINGS_URLS.macScreenModern;
  }
  if (platform === 'win32' && kind === 'mic') return SETTINGS_URLS.winMic;
  return null;
}

/** Normalize whatever getMediaAccessStatus returned. */
export function normalizeStatus(raw: unknown): OsPermissionStatus {
  return raw === 'granted' || raw === 'denied' || raw === 'restricted' || raw === 'not-determined'
    ? raw
    : 'unknown';
}

/**
 * Did a desktopCapturer.getSources() call see through the Screen Recording
 * gate? Without the grant macOS still lists the displays and Sei's own windows
 * (their titles are Sei's to read), but no other app's windows. So one window
 * that is not Sei's is proof of access.
 *
 * It has to carry a TITLE. Since Catalina, CGWindowList still returns other
 * apps' windows without the grant, only with kCGWindowName stripped, so a
 * lister that keeps untitled on-screen windows would hand back entries with an
 * empty name; counting those would skip the card and land the player in the
 * blank picker this flow exists to replace. A granted Mac nearly always has
 * some titled window open, and the status read covers a fresh process.
 *
 * getMediaAccessStatus('screen') is not used for the negative: Electron reads
 * it through CGPreflightScreenCaptureAccess, which keeps answering "denied" for
 * the life of the process once it has said so, even after the user turns the
 * switch on. A 'granted' from it is trustworthy, a 'denied' is not.
 */
export const SEI_WINDOW_NAME = /^Sei($| [-—|])/;
export function screenProbeSeesOtherApps(sources: ReadonlyArray<{ id: string; name: string }>): boolean {
  return sources.some(
    (s) => s.id.startsWith('window:') && s.name.trim() !== '' && !SEI_WINDOW_NAME.test(s.name),
  );
}

// ── Resume flag ─────────────────────────────────────────────────────────────

export const RESUME_FILE = 'permission-resume.json';

interface ResumeFile {
  resume: PermissionResume;
  at: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Validate a resume payload from the renderer or from disk. */
export function parseResume(raw: unknown): PermissionResume | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: unknown; characterId?: unknown };
  if (r.kind !== 'share-screen' && r.kind !== 'call') return null;
  if (typeof r.characterId !== 'string' || !ID_RE.test(r.characterId)) return null;
  return { kind: r.kind, characterId: r.characterId };
}

export function writeResume(dir: string, resume: PermissionResume, now: number = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  const body: ResumeFile = { resume, at: now };
  writeFileSync(path.join(dir, RESUME_FILE), JSON.stringify(body) + '\n');
}

export function clearResume(dir: string): void {
  try {
    rmSync(path.join(dir, RESUME_FILE), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Read and DELETE the resume flag. One-shot: a crash loop or a second launch
 * never reopens the picker twice. Expired or malformed flags return null (and
 * are deleted all the same).
 */
export function takeResume(dir: string, now: number = Date.now()): PermissionResume | null {
  const file = path.join(dir, RESUME_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  clearResume(dir);
  if (!parsed || typeof parsed !== 'object') return null;
  const { resume, at } = parsed as Partial<ResumeFile>;
  if (typeof at !== 'number' || now - at > PERMISSION_RESUME_TTL_MS || now < at - 60_000) return null;
  return parseResume(resume);
}
