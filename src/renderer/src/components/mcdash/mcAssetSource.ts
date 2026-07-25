/**
 * mcAssetSource — renderer-side URL helpers for the Minecraft dashboard's
 * real-texture rendering (260721). The main process serves read-only item
 * textures from prismarine-viewer's bundled folders on the local skin
 * server (GET /mcassets/<version>/item/<name>.png, see src/main/skinServer.ts
 * + src/main/mcAssets.ts); persona skins live at /skins/<username>.png on
 * the same server. This module resolves the server base URL once per
 * renderer session and builds those URLs.
 *
 * Every consumer must keep a graceful fallback: a null base (server failed
 * to bind) or a 404 texture (renderer falls back to the text-label slot via
 * <img onError>) must never break the dashboard.
 */

import { useEffect, useState } from 'react';

/** Narrow view of the one window.sei member we need (single cast). */
interface SkinServerApi {
  getSkinServerUrl(): Promise<{ baseUrl: string }>;
}

let basePromise: Promise<string | null> | null = null;

/** Resolve the local skin server base URL once; null when unavailable. */
export function skinServerBase(): Promise<string | null> {
  if (!basePromise) {
    basePromise = (async () => {
      try {
        const api = window.sei as unknown as Partial<SkinServerApi>;
        const res = await api.getSkinServerUrl?.();
        return res?.baseUrl ?? null;
      } catch {
        return null;
      }
    })();
  }
  return basePromise;
}

/** Hook form: null until resolved (or when the server is unavailable). */
export function useSkinServerBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void skinServerBase().then((b) => {
      if (alive && b) setBase(b);
    });
    return () => {
      alive = false;
    };
  }, []);
  return base;
}

/**
 * Extract a plain "1.21.4"-style version out of the LAN status ping's
 * versionName (modded servers report loader-flavored strings like
 * "Fabric 1.21.4"). Falls back to "latest": main then serves the newest
 * bundled texture folder.
 */
export function extractMcVersion(versionName: string | undefined): string {
  const m = versionName?.match(/\d{1,2}\.\d{1,3}(?:\.\d{1,3})?/);
  return m ? m[0] : 'latest';
}

/** Item texture URL ("cobblestone" -> .../mcassets/1.21.4/item/cobblestone.png). */
export function mcItemIconUrl(base: string, version: string, itemName: string): string {
  return `${base}/mcassets/${version}/item/${encodeURIComponent(itemName)}.png`;
}

/** Persona skin URL for the avatar viewport (404s until a skin is cached). */
export function mcSkinUrl(base: string, username: string): string {
  return `${base}/skins/${encodeURIComponent(username)}.png`;
}
