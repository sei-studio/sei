/**
 * Dependency-free Minecraft Server List Ping (SLP) over a TCP socket.
 *
 * Used by the loopback LAN watcher (src/main/lanWatcher.ts) to confirm that a
 * locally-listening TCP port is actually a Minecraft "open to LAN" world and to
 * read its MOTD + version — replacing the old multicast beacon, which macOS 26
 * silently drops for signed apps unless the app carries the restricted
 * `com.apple.developer.networking.multicast` entitlement (which bricks launch
 * without an embedded provisioning profile). Loopback TCP is exempt from Local
 * Network privacy, so this path needs no entitlement and no permission prompt.
 *
 * Implements the modern (Netty) handshake: Handshake(next=status) + Status
 * Request, then parses the length-prefixed Status Response JSON. Kept minimal
 * and self-contained so the main process never imports the bot's MC libs.
 */
import net from 'node:net';

export interface McStatus {
  port: number;
  motd: string;
  versionName: string;
  protocol: number | null;
  /**
   * Mod count from Forge/NeoForge ping metadata (`forgeData.mods` on 1.13+,
   * `modinfo.modList` on 1.12-). null when the ping carries no such metadata
   * (vanilla, Fabric, Lunar); 0 when the metadata is present but the mod list
   * is empty or unparseable (still a Forge-family server).
   */
  forgeModCount: number | null;
}

/**
 * Extract the Forge/NeoForge mod count from a parsed status-response object.
 * Exported for tests.
 */
export function forgeModCountFromStatus(parsed: unknown): number | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as { forgeData?: unknown; modinfo?: unknown };
  const mods = (p.forgeData as { mods?: unknown } | undefined)?.mods;
  if (Array.isArray(mods)) return mods.length;
  const modList = (p.modinfo as { modList?: unknown } | undefined)?.modList;
  if (Array.isArray(modList)) return modList.length;
  return p.forgeData != null || p.modinfo != null ? 0 : null;
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let numRead = 0;
  let result = 0;
  let byte: number;
  do {
    if (offset + numRead >= buf.length) return null; // need more bytes
    byte = buf[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error('VarInt too big');
  } while ((byte & 0x80) !== 0);
  return { value: result >>> 0, size: numRead };
}

function mkPacket(...parts: Buffer[]): Buffer {
  const data = Buffer.concat(parts);
  return Buffer.concat([writeVarInt(data.length), data]);
}

function motdToText(desc: unknown): string {
  if (desc == null) return '';
  if (typeof desc === 'string') return desc;
  if (typeof desc === 'object') {
    const d = desc as { text?: string; extra?: unknown[] };
    let out = typeof d.text === 'string' ? d.text : '';
    if (Array.isArray(d.extra)) out += d.extra.map(motdToText).join('');
    return out;
  }
  return '';
}

/**
 * Status-ping a TCP endpoint. Resolves with the parsed status when the peer
 * speaks the Minecraft status protocol; rejects on timeout, socket error, or a
 * non-Minecraft response. `host` defaults to loopback — the only thing Sei can
 * actually reach, since the bot connects over 127.0.0.1.
 */
export function mcPing(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<McStatus> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let chunks = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, val?: McStatus): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(val as McStatus);
    };
    const timer = setTimeout(() => finish(new Error('LAN_PING_TIMEOUT')), timeoutMs);
    sock.on('error', (e) => finish(e));
    sock.on('connect', () => {
      const addr = Buffer.from(host, 'utf8');
      const handshake = mkPacket(
        writeVarInt(0x00), // packet id: handshake
        writeVarInt(0), // protocol version (0 = unspecified; fine for status)
        writeVarInt(addr.length),
        addr,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]), // server port (u16 BE)
        writeVarInt(1), // next state: status
      );
      const statusReq = mkPacket(writeVarInt(0x00));
      sock.write(Buffer.concat([handshake, statusReq]));
    });
    sock.on('data', (d: Buffer) => {
      chunks = Buffer.concat([chunks, d]);
      let lenRes: { value: number; size: number } | null;
      try {
        lenRes = readVarInt(chunks, 0);
      } catch (e) {
        return finish(e as Error);
      }
      if (!lenRes) return; // wait for more
      const total = lenRes.size + lenRes.value;
      if (chunks.length < total) return; // packet not fully arrived
      try {
        let off = lenRes.size;
        const idRes = readVarInt(chunks, off);
        if (!idRes) return;
        off += idRes.size;
        if (idRes.value !== 0x00) return finish(new Error('not a status response'));
        const strLen = readVarInt(chunks, off);
        if (!strLen) return;
        off += strLen.size;
        const json = chunks.slice(off, off + strLen.value).toString('utf8');
        const parsed = JSON.parse(json) as {
          description?: unknown;
          version?: { name?: string; protocol?: number };
        };
        // Guard: a real MC status object always carries version/description.
        if (typeof parsed !== 'object' || parsed === null || (!parsed.version && parsed.description == null)) {
          return finish(new Error('not minecraft'));
        }
        finish(null, {
          port,
          motd: motdToText(parsed.description),
          versionName: parsed.version?.name ?? '',
          protocol: typeof parsed.version?.protocol === 'number' ? parsed.version.protocol : null,
          forgeModCount: forgeModCountFromStatus(parsed),
        });
      } catch (e) {
        finish(e as Error);
      }
    });
  });
}
