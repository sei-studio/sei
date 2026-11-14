/**
 * The Sei link folder for Slay the Spire 2 (261115): where main and the mod
 * in both game windows meet, OUTSIDE the game's .app bundle (writes inside it
 * need the macOS App Management grant; this folder never does).
 *
 *   macOS    ~/Library/Application Support/sei-sts2/
 *   Windows  %APPDATA%\sei-sts2\
 *   Linux    $XDG_CONFIG_HOME/sei-sts2/ (or ~/.config/sei-sts2/)
 *
 *   link.json          main writes {v, port, token} before each session; the
 *                      mod re-reads it before every connect attempt
 *   status-host.json   the player's window's heartbeat (mod, ~3 s)
 *   status-seat.json   the companion window's heartbeat (mod, ~3 s)
 *
 * native/sts2-mod/PROTOCOL.md mirrors this (the mod computes the same path).
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { STS2_LINK_PORT_COUNT, STS2_LINK_PORT_FIRST, type Sts2LobbyKind, type Sts2Role, type Sts2StatusFile } from '../../../shared/sts2Ipc';

export const LINK_DIR_NAME = 'sei-sts2';
export const LINK_FILE = 'link.json';
export const statusFile = (role: Sts2Role): string => `status-${role}.json`;

export function linkDirFor(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), LINK_DIR_NAME);
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', LINK_DIR_NAME);
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), LINK_DIR_NAME);
}

export interface LinkRecord {
  v: 1;
  port: number;
  token: string;
}

export const newToken = (): string => randomBytes(16).toString('hex');

const LOBBIES = new Set<Sts2LobbyKind>(['none', 'enet', 'steam']);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A status file's text as a Sts2StatusFile, or null when unreadable or for the other role. */
export function parseStatus(text: string | null, role: Sts2Role): Sts2StatusFile | null {
  if (!text) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const ts = num(raw.ts);
  if (ts <= 0) return null;
  if (raw.role != null && raw.role !== role) return null;
  const lobby = LOBBIES.has(raw.lobby as Sts2LobbyKind) ? (raw.lobby as Sts2LobbyKind) : 'none';
  return {
    ts,
    role,
    version: str(raw.version, 32),
    protocol: num(raw.protocol),
    game_version: str(raw.game_version, 64),
    screen: str(raw.screen, 40) || 'unknown',
    lobby,
    in_run: raw.in_run === true,
    players: Array.isArray(raw.players) ? raw.players.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 40)).slice(0, 8) : [],
    pid: num(raw.pid),
  };
}

/** Is the loopback port free to listen on right now? */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** The first free port of the link range, or null. */
export async function pickLinkPort(free: (port: number) => Promise<boolean> = isPortFree): Promise<number | null> {
  for (let i = 0; i < STS2_LINK_PORT_COUNT; i++) {
    const port = STS2_LINK_PORT_FIRST + i;
    if (await free(port).catch(() => false)) return port;
  }
  return null;
}
