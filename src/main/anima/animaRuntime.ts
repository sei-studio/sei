/**
 * The app's one AnimaClient (261105), wired to the real proxy, disk, windows
 * and analytics. Logic and its tests live in animaClient.ts / animaPacks.ts.
 */
import { stat } from 'node:fs/promises';
import { BrowserWindow, net } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import type { AnimaStatus } from '../../shared/anima';
import { getCharacter } from '../characterStore';
import { onCharacterSaved } from '../characterSignals';
import { getProxyJwt, ProxyAuthError } from '../auth/proxyJwtFetcher';
import { loadAnalytics } from '../lazyAnalytics';
import { noteSeilinkAvatarChanged } from '../seilink/host/hostSignals';
import { AnimaClient, AnimaNoSession } from './animaClient';
import { animaStore } from './animaStore';
import { paths } from '../paths';

/** Proxy base URL (proxyClient.ts's rule). `SEI_PROXY_URL` overrides for dev. */
const PROXY_BASE = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

function log(line: string): void {
  console.log(line);
}

async function api(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  let jwt: string;
  try {
    jwt = await getProxyJwt();
  } catch (err) {
    if (err instanceof ProxyAuthError && err.code === 'PROXY_NO_SESSION') throw new AnimaNoSession();
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${PROXY_BASE}${route}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

async function download(url: string, maxBytes: number): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error('download too big');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        ctrl.abort();
        throw new Error('download too big');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** Her looks changed: every RoomAvatar (app windows and the desktop host) re-resolves. */
async function pushAvatarChanged(characterId: string): Promise<void> {
  const { getAvatarManifest } = await import('../avatar/avatarStore');
  const manifest = await getAvatarManifest(characterId).catch(() => null);
  noteSeilinkAvatarChanged(characterId, manifest);
  broadcast(IpcChannel.avatar.manifestState, { characterId, manifest });
}

export const anima = new AnimaClient({
  api,
  online: () => {
    try {
      return net.isOnline();
    } catch {
      return true;
    }
  },
  download,
  store: animaStore,
  portraitRef: async (id) => {
    const c = await getCharacter(id).catch(() => null);
    if (!c) return undefined;
    if (!c.portrait_image) return null;
    // A local edit keeps the file name: its size and mtime say the bytes changed.
    let file = '';
    if (/^[0-9a-z_-]+\.png$/i.test(c.portrait_image)) {
      const s = await stat(paths.portraitPath(c.portrait_image.replace(/\.png$/i, ''))).catch(() => null);
      if (s) file = `${s.size}-${Math.round(s.mtimeMs)}`;
    }
    return `${c.portrait_image}|${c.cloud_updated_at ?? ''}|${file}`;
  },
  capture: (event, props) => {
    void loadAnalytics()
      .then((a) => a.capture(event, props))
      .catch(() => {
        /* analytics is optional */
      });
  },
  onReady: (characterId) => {
    void pushAvatarChanged(characterId).catch((err) => log(`[anima] avatar push failed (${(err as Error).message})`));
  },
  onStatus: (s: AnimaStatus) => broadcast(IpcChannel.seilink.animaChanged, s),
  // 261106: the stage pushes ride the same channel (the WorldLink intro paces its lines on them).
  onProgress: (s: AnimaStatus) => broadcast(IpcChannel.seilink.animaChanged, s),
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log,
});

// Her portrait may have changed: re-check her face set (only characters that went through SeiLink).
onCharacterSaved((id) => {
  void anima.portraitMaybeChanged(id).catch(() => {});
});
