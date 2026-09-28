/**
 * Resume after "Restart Sei and continue" (260929). Main keeps a one-shot flag
 * (permissions/osPermissions takeResume, ten-minute TTL); once the app has
 * booted into a normal view, take it and reopen what the player was doing:
 * the share picker for the same companion, or the call.
 */
import { useEffect, useRef } from 'react';
import { sei } from '../ipcClient';
import { useUiStore } from '../stores/useUiStore';
import { useDataStore } from '../stores/useDataStore';
import { startOrOpenCall } from '../callLaunch';
import type { PermissionResume } from '@shared/permissionsIpc';

/** Views that are "the app", as opposed to boot, sign-in and onboarding. */
const SETTLED_VIEWS: ReadonlySet<string> = new Set(['home', 'chat', 'character', 'awaken', 'settings', 'credits']);

/** How long a taken flag waits for its character to load before it is dropped. */
const WAIT_FOR_CHARACTER_MS = 30_000;

export function resumeViewReady(viewKind: string): boolean {
  return SETTLED_VIEWS.has(viewKind);
}

export function usePermissionResume(): void {
  const viewKind = useUiStore((s) => s.view.kind);
  const characters = useDataStore((s) => s.characters);
  const taken = useRef(false);
  const pending = useRef<{ resume: PermissionResume; at: number } | null>(null);

  useEffect(() => {
    if (taken.current || !resumeViewReady(viewKind)) return;
    taken.current = true;
    void sei
      .permissionsTakeResume()
      .then((resume) => {
        if (resume) {
          pending.current = { resume, at: Date.now() };
          // Nudge the character check below even if characters never change.
          act();
        }
      })
      .catch(() => {});
    // act reads refs and store state only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKind]);

  useEffect(() => {
    act();
  }, [characters]);

  function act(): void {
    const p = pending.current;
    if (!p) return;
    if (Date.now() - p.at > WAIT_FOR_CHARACTER_MS) {
      pending.current = null;
      return;
    }
    const { characterId, kind } = p.resume;
    if (!useDataStore.getState().characters.some((c) => c.id === characterId)) return;
    pending.current = null;
    if (kind === 'share-screen') {
      useUiStore.getState().openModal({ kind: 'share-screen', characterId });
    } else {
      startOrOpenCall(characterId);
    }
  }
}
