/**
 * The Sei link port for Factorio (261113): which localhost UDP port Factorio
 * is started with (`--enable-lua-udp <port>`), remembered so the watcher and
 * the join target can find the game again after Sei restarts while Factorio
 * keeps running.
 *
 * Kept in `<userData>/factorio-link.json` (device-wide, like Stardew's
 * stardew-game-path.json), not in the profile config: it describes this
 * machine's game process, not an account. `bad` lists ports Factorio said it
 * could not open ("Opening Lua UDP Socket failed" in factorio-current.log);
 * the next launch skips them.
 */
import dgram from 'node:dgram';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FACTORIO_DEFAULT_UDP_PORT, FACTORIO_GAME_PORT } from '../../../shared/factorioIpc';

export const LINK_FILE = 'factorio-link.json';
/** 34990..34999. */
export const LINK_PORT_RANGE: readonly number[] = Array.from({ length: 10 }, (_, i) => FACTORIO_DEFAULT_UDP_PORT + i);

export interface LinkRecord {
  port: number | null;
  bad: number[];
}

const isPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 1024 && n < 65536 && n !== FACTORIO_GAME_PORT;

export function parseLinkRecord(text: string | null): LinkRecord {
  if (!text) return { port: null, bad: [] };
  try {
    const j = JSON.parse(text) as { port?: unknown; bad?: unknown };
    return {
      port: isPort(j.port) ? j.port : null,
      bad: Array.isArray(j.bad) ? j.bad.filter(isPort).slice(0, 32) : [],
    };
  } catch {
    return { port: null, bad: [] };
  }
}

/**
 * Ports to try, in order: the remembered one (a running Factorio may already
 * hold it, and keeping it stable keeps the link findable), then the range.
 * Never the game's own 34197, never a port Factorio refused. When every
 * candidate has been refused once, the refusals are forgotten (a port taken
 * last week is likely free again) rather than leaving no port at all.
 */
export function portCandidates(rec: LinkRecord): number[] {
  const all = [...(rec.port != null ? [rec.port] : []), ...LINK_PORT_RANGE].filter((p, i, a) => isPort(p) && a.indexOf(p) === i);
  const ok = all.filter((p) => !rec.bad.includes(p));
  return ok.length > 0 ? ok : all;
}

/** Can a UDP socket bind 127.0.0.1:<port> right now? */
export function udpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let settled = false;
    const done = (free: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        s.close();
      } catch {
        /* already closed */
      }
      resolve(free);
    };
    s.once('error', () => done(false));
    try {
      s.bind(port, '127.0.0.1', () => done(true));
    } catch {
      done(false);
    }
  });
}

/** The first candidate that binds, or null when none does. */
export async function pickLinkPort(rec: LinkRecord, isFree: (port: number) => Promise<boolean> = udpPortFree): Promise<number | null> {
  for (const p of portCandidates(rec)) {
    if (await isFree(p).catch(() => false)) return p;
  }
  return null;
}

export interface LinkStore {
  read(): Promise<LinkRecord>;
  write(rec: LinkRecord): Promise<void>;
}

export function createLinkStore(file?: () => Promise<string>): LinkStore {
  const resolveFile =
    file ??
    (async () => {
      const { paths } = await import('../../paths');
      return path.join(paths.userData(), LINK_FILE);
    });
  return {
    async read() {
      try {
        return parseLinkRecord(await readFile(await resolveFile(), 'utf8'));
      } catch {
        return { port: null, bad: [] };
      }
    },
    async write(rec) {
      const target = await resolveFile();
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify({ port: rec.port, bad: rec.bad.slice(-32) }), 'utf8');
      await rename(tmp, target);
    },
  };
}
