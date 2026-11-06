/**
 * The app's one AvatarLibraryClient (261106), wired to the real proxy, the
 * local avatar store, the config (viewer picks), windows and analytics.
 * Logic and its tests live in avatarLibraryClient.ts.
 */
import { readFile } from 'node:fs/promises';
import { BrowserWindow, net } from 'electron';
import { IpcChannel, type AvatarManifest } from '../../shared/ipc';
import { getCharacter } from '../characterStore';
import { onCharacterSaved } from '../characterSignals';
import { downloadCapped, proxyJson, putSigned } from '../cloud/proxyHttp';
import { loadConfig, updateConfig } from '../configStore';
import { loadAnalytics } from '../lazyAnalytics';
import { noteSeilinkAvatarChanged } from '../seilink/host/hostSignals';
import {
  getAvatarManifest,
  importAvatarZip,
  removeAvatar,
  setAvatarLibraryLink,
  zipStoredAvatar,
} from '../avatar/avatarStore';
import { paths } from '../paths';
import { AvatarLibraryClient, AvatarLibraryNoSession, imageMime } from './avatarLibraryClient';

const CARD_MAX_BYTES = 10 * 1024 * 1024;

function log(line: string): void {
  console.log(line);
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** Her card image bytes (a local upload, or her cloud portrait), or null. */
async function cardPortrait(characterId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const c = await getCharacter(characterId).catch(() => null);
  const ref = c?.portrait_image;
  if (!ref) return null;
  let bytes: Uint8Array | null = null;
  if (/^[0-9a-z_-]+\.png$/i.test(ref)) {
    bytes = await readFile(paths.portraitPath(ref.replace(/\.png$/i, ''))).catch(() => null);
  } else if (/^https:\/\//i.test(ref)) {
    bytes = await downloadCapped(ref, CARD_MAX_BYTES).catch(() => null);
  }
  if (!bytes || bytes.byteLength > CARD_MAX_BYTES) return null;
  const mime = imageMime(bytes);
  return mime ? { bytes, mime } : null;
}

export const avatarLibrary = new AvatarLibraryClient({
  api: (method, route, body) => proxyJson(method, route, body, () => new AvatarLibraryNoSession()),
  online: () => {
    try {
      return net.isOnline();
    } catch {
      return true;
    }
  },
  putSigned,
  download: downloadCapped,
  cardPortrait,
  models: {
    manifest: (id) => getAvatarManifest(id),
    zip: (id) => zipStoredAvatar(id),
    import: (id, zip) => importAvatarZip(id, Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)),
    link: (id, link) => setAvatarLibraryLink(id, link),
    remove: (id) => removeAvatar(id),
  },
  getPick: async (id) => (await loadConfig()).avatar_prefs?.[id]?.avatar_id ?? null,
  setPick: async (id, avatarId) => {
    await updateConfig((c) => {
      const prefs = { ...(c.avatar_prefs ?? {}) };
      const entry = { ...(prefs[id] ?? {}) };
      if (avatarId) entry.avatar_id = avatarId;
      else delete entry.avatar_id;
      if (Object.keys(entry).length) prefs[id] = entry;
      else delete prefs[id];
      return { ...c, avatar_prefs: prefs };
    });
  },
  capture: (event, props) => {
    void loadAnalytics()
      .then((a) => a.capture(event, props))
      .catch(() => {
        /* analytics is optional */
      });
  },
  onView: (characterId, view) => broadcast(IpcChannel.avatarLibrary.changed, { characterId, view }),
  onModel: (characterId, manifest: AvatarManifest | null) => {
    noteSeilinkAvatarChanged(characterId, manifest);
    broadcast(IpcChannel.avatar.manifestState, { characterId, manifest });
  },
  onEffectiveChanged: (characterId) => {
    // Lazy: animaRuntime imports this module (for avatarFor).
    void import('../anima/animaRuntime')
      .then((m) => m.anima.avatarChanged(characterId))
      .catch(() => {});
  },
  now: () => Date.now(),
  log,
});

// A saved character may carry a new card image: the owner's card row follows.
onCharacterSaved((id) => {
  void avatarLibrary.characterSaved(id)?.catch(() => {});
});
