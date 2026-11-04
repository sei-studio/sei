/**
 * Where the room editor reads and writes (261104, editor pass).
 *
 * In the app it is IPC (ipcRoomEditorSource): packs from main's pack loader,
 * her room from the room store (seilinkRoomGet / seilinkRoomSet, which
 * sanitize against the pack), and the custom avatar from the existing Live2D
 * avatar store (avatarImport / avatarGet, the same pipeline as the profile's
 * Avatar tab). The dev preview in a plain browser tab has no IPC, so it uses
 * memoryRoomEditorSource over packs fetched by URL.
 */
import type { RoomPresetId, RoomPresetManifest, RoomState } from '@shared/seilinkRoom';
import { sanitizeRoomState } from '@shared/seilinkValidate';
import { seilinkResolver, type RoomUrlResolver } from '@shared/seilinkPack';
import { sei } from '../../lib/ipcClient';
import { useAvatarStore } from '../../lib/stores/useAvatarStore';

export interface EditorPack {
  id: RoomPresetId;
  manifest: RoomPresetManifest;
  resolve: RoomUrlResolver;
  /** Changes when the pack changes (thumbnail cache key). */
  rev: number | string;
}

/** Her custom avatar model, when one is imported. */
export interface EditorAvatarModel {
  name: string;
  /** The model entry inside her avatar store (RoomState avatar.modelPath). */
  entry: string;
}

export interface RoomEditorSource {
  packs(): Promise<EditorPack[]>;
  /** Her saved room (sanitized), or null when none can be read. */
  load(): Promise<RoomState | null>;
  /** Save; resolves with the state as stored (sanitized). */
  save(state: RoomState): Promise<RoomState>;
  /** The custom Live2D avatar, when the host can import one. */
  avatar?: {
    get(): Promise<EditorAvatarModel | null>;
    importZip(bytes: ArrayBuffer): Promise<EditorAvatarModel>;
  };
  /** Someone else saved her room (the AI, another window). */
  onChanged?(cb: () => void): () => void;
}

export function ipcRoomEditorSource(characterId: string): RoomEditorSource {
  return {
    async packs() {
      const list = (await sei.seilinkPacks?.()) ?? [];
      return list.map((p) => ({ id: p.id, manifest: p.manifest, resolve: seilinkResolver(p), rev: p.rev }));
    },
    async load() {
      const payload = await sei.seilinkRoomGet?.(characterId);
      return payload?.state ?? null;
    },
    async save(state) {
      if (!sei.seilinkRoomSet) throw new Error('SEILINK_UNAVAILABLE');
      return (await sei.seilinkRoomSet(characterId, state)).state;
    },
    avatar: {
      async get() {
        const m = await sei.avatarGet(characterId);
        return m ? { name: m.name, entry: m.entry } : null;
      },
      async importZip(bytes) {
        const m = await sei.avatarImport(characterId, bytes);
        // Keep the profile's Avatar tab and the overlay in step.
        useAvatarStore.getState().setManifest(characterId, m);
        return { name: m.name, entry: m.entry };
      },
    },
    onChanged(cb) {
      return (
        sei.onSeilinkRoomChanged?.((id) => {
          if (id === characterId || id === '*') cb();
        }) ?? (() => {})
      );
    },
  };
}

/**
 * In-memory source (dev preview in a browser tab): saves live until reload.
 * The avatar upload is shown but cannot import here (no avatar store).
 */
export function memoryRoomEditorSource(packs: EditorPack[], initial: RoomState | null = null): RoomEditorSource {
  let stored: RoomState | null = initial;
  return {
    avatar: {
      get: async () => null,
      importZip: async () => {
        throw new Error('SEILINK_PREVIEW: no avatar store in the browser preview');
      },
    },
    packs: async () => packs,
    load: async () => stored,
    async save(state) {
      const pack = packs.find((p) => p.id === state.preset);
      if (!pack) throw new Error(`SEILINK_PACK_MISSING: no pack for preset ${state.preset}`);
      stored = sanitizeRoomState(pack.manifest, JSON.parse(JSON.stringify(state)));
      return stored;
    },
  };
}
