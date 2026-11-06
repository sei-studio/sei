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
import { downloadCapped as download, proxyJson } from '../cloud/proxyHttp';
import { loadAnalytics } from '../lazyAnalytics';
import { noteSeilinkAvatarChanged } from '../seilink/host/hostSignals';
import { avatarLibrary } from '../avatarLibrary/avatarLibraryRuntime';
import { AnimaClient, AnimaNoSession } from './animaClient';
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
  },
  onStatus: (s: AnimaStatus) => broadcast(IpcChannel.seilink.animaChanged, s),
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
