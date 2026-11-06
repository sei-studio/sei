/**
 * The app's one AvatarLibraryClient (261106), wired to the real proxy, the
 * local avatar store, the config (viewer picks), windows and analytics.
 * Logic and its tests live in avatarLibraryClient.ts.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { AvatarLibraryClient, AvatarLibraryNoSession, imageMime, type SkipList } from './avatarLibraryClient';

const CARD_MAX_BYTES = 10 * 1024 * 1024;
/** The proxy answers a commit within 85 s (202 processing past that; Cloudflare cuts at 100 s). */
const COMMIT_TIMEOUT_MS = 95_000;

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

/** At most this many skipped rows are remembered (oldest dropped first). */
const SKIP_MAX = 500;

/**
 * The skip list as a small JSON file in the active profile
 * (`{ "<avatarId>": "<rev>" }`): read on every check so an account switch
 * reads the new profile's file. Writes are serialized.
 */
function fileSkipList(): SkipList {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Record<string, string>> => {
    try {
      const v = JSON.parse(await readFile(paths.avatarLibrarySkipPath(), 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = async (map: Record<string, string>): Promise<void> => {
    const file = paths.avatarLibrarySkipPath();
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(map), 'utf8');
    await rename(tmp, file);
  };
  const update = (fn: (m: Record<string, string>) => Record<string, string> | null): Promise<void> => {
    const next = chain.then(async () => {
      const m = fn(await read());
      if (m) await write(m);
    });
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    has: async (id, rev) => (await read())[id] === rev,
    add: (id, rev) =>
      update((m) => {
        delete m[id];
        m[id] = rev;
        const keys = Object.keys(m);
        for (const k of keys.slice(0, Math.max(0, keys.length - SKIP_MAX))) delete m[k];
        return m;
      }),
    clear: (id) =>
      update((m) => {
        if (!(id in m)) return null;
        delete m[id];
        return m;
      }),
  };
}

export const avatarLibrary = new AvatarLibraryClient({
  // A commit downloads the upload, inflates every zip entry and moderates every image: give it the proxy's deadline.
  api: (method, route, body) =>
    proxyJson(method, route, body, () => new AvatarLibraryNoSession(), route.endsWith('/commit') ? COMMIT_TIMEOUT_MS : undefined),
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
  skip: fileSkipList(),
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
