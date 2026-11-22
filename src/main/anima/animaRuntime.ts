/**
 * The app's one AnimaClient (261105), wired to the real proxy, disk, windows
 * and analytics. Logic and its tests live in animaClient.ts / animaPacks.ts.
 */
import { readFile, stat } from 'node:fs/promises';
import { BrowserWindow, net } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import type { AnimaCutout, AnimaStatus } from '../../shared/anima';
import { getCharacter } from '../characterStore';
import { onCharacterSaved } from '../characterSignals';
import { downloadCapped as download, proxyJson } from '../cloud/proxyHttp';
import { loadAnalytics } from '../lazyAnalytics';
import { noteSeilinkAvatarChanged } from '../seilink/host/hostSignals';
import { avatarLibrary } from '../avatarLibrary/avatarLibraryRuntime';
import { AnimaClient, AnimaNoSession } from './animaClient';
import { ANIMA_CUTOUT_MAX_BYTES } from './animaPacks';
import { animaStore } from './animaStore';
import { paths } from '../paths';

function log(line: string): void {
  console.log(line);
}

const api = (method: 'GET' | 'POST', route: string, body?: unknown) =>
  proxyJson(method, route, body, () => new AnimaNoSession());

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

/** 261119: in-process listeners for any change of her look's progress (the desktop arrival, seilinkHost.ts). */
const changeListeners = new Set<(characterId: string) => void>();

/** Called on every status, stage and ready push. Returns the unsubscribe. */
export function onAnimaChange(cb: (characterId: string) => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

function noteChange(characterId: string): void {
  for (const cb of [...changeListeners]) {
    try {
      cb(characterId);
    } catch {
      /* a listener must not break the client */
    }
  }
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
  // 261106: bake the library portrait avatar that plays for her, when there is one.
  avatarFor: (id) => avatarLibrary.animaAvatarFor(id),
  capture: (event, props) => {
    void loadAnalytics()
      .then((a) => a.capture(event, props))
      .catch(() => {
        /* analytics is optional */
      });
  },
  onReady: (characterId) => {
    void pushAvatarChanged(characterId).catch((err) => log(`[anima] avatar push failed (${(err as Error).message})`));
    noteChange(characterId);
  },
  onStatus: (s: AnimaStatus) => {
    broadcast(IpcChannel.seilink.animaChanged, s);
    noteChange(s.characterId);
  },
  // 261106: the stage pushes ride the same channel (the WorldLink intro paces its lines on them).
  onProgress: (s: AnimaStatus) => {
    broadcast(IpcChannel.seilink.animaChanged, s);
    noteChange(s.characterId);
  },
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log,
});

/** 261118: her cloud cut-out's bytes for a view in this process (the desktop host reads the file itself). */
export async function readAnimaCutout(characterId: string): Promise<AnimaCutout | null> {
  const found = await anima.cutoutFor(characterId).catch(() => null);
  if (!found) return null;
  try {
    const s = await stat(found.path);
    if (!s.isFile() || s.size > ANIMA_CUTOUT_MAX_BYTES) return null;
    return { sha256: found.sha256, png: new Uint8Array(await readFile(found.path)) };
  } catch {
    return null;
  }
}

// Her portrait may have changed: re-check her face set (only characters that went through SeiLink).
onCharacterSaved((id) => {
  void anima.portraitMaybeChanged(id).catch(() => {});
});




