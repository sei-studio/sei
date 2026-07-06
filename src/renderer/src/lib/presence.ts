/**
 * Presence model (Party redesign, .planning/design/UI-REDESIGN-PARTY.md §2).
 *
 * Five categories, computed from live summon state + last interaction:
 *   in-game    — bot is online in the player's world ("In your world")
 *   connecting — summon in flight ("Connecting…")
 *   new        — never chatted and never launched ("New")
 *   online     — last interaction within 30 minutes ("Online")
 *   idle       — everything else ("Idle")
 *
 * `usePresence` re-renders on a shared 60s ticker so `online` decays to
 * `idle` without navigation.
 */

import { useSyncExternalStore } from 'react';
import type { Character } from '@shared/characterSchema';
import type { BotStatus } from '@shared/ipc';
import { lastInteractionAt } from './lastInteraction';

export type PresenceCategory = 'in-game' | 'connecting' | 'new' | 'online' | 'idle';

export interface PresenceInfo {
  category: PresenceCategory;
  /** Display copy for the status line. */
  label: string;
}

export const ONLINE_WINDOW_MS = 30 * 60 * 1000;

const PRESENCE_LABEL: Record<PresenceCategory, string> = {
  'in-game': 'In your world',
  connecting: 'Connecting…',
  new: 'New',
  online: 'Online',
  idle: 'Idle',
};

/**
 * Pure categorization. `summon` is the character's entry in
 * useDataStore.summons (undefined = not summoned); `now` defaults to
 * Date.now() and exists for tests.
 */
export function presenceOf(
  character: Pick<Character, 'last_launched' | 'last_chatted'>,
  summon: BotStatus | undefined,
  now: number = Date.now(),
): PresenceInfo {
  if (summon?.kind === 'online') return { category: 'in-game', label: PRESENCE_LABEL['in-game'] };
  if (summon?.kind === 'connecting')
    return { category: 'connecting', label: PRESENCE_LABEL.connecting };
  const last = lastInteractionAt(character);
  if (!last) return { category: 'new', label: PRESENCE_LABEL.new };
  const lastMs = Date.parse(last);
  if (Number.isFinite(lastMs) && now - lastMs <= ONLINE_WINDOW_MS) {
    return { category: 'online', label: PRESENCE_LABEL.online };
  }
  return { category: 'idle', label: PRESENCE_LABEL.idle };
}

/* ── Shared 60s ticker ─────────────────────────────────────────────────
 * One interval for the whole app; subscribers re-render each minute so
 * time-derived presence (online → idle) stays honest. Interval starts with
 * the first subscriber and stops with the last. */

let tick = 0;
const listeners = new Set<() => void>();
let timer: number | null = null;

function subscribeTick(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === null) {
    timer = window.setInterval(() => {
      tick += 1;
      listeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** Re-render every minute (returns an increasing counter; value unused). */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribeTick, () => tick);
}
