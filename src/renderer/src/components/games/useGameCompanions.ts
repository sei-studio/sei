/**
 * useGameCompanions — the OTHER companions currently in the same game as
 * the dashboard's own (260909). A dashboard is mounted for one character,
 * but Minecraft (and Stardew) run several bodies at once, one per
 * character, and each used to be visible only from its own chat. The
 * dashboards now lay out one status window per companion in the game, so
 * this hook answers "who else is in here and what are they doing":
 *
 *   - membership comes from useDataStore.summons (every 'online' status in
 *     the same game, any character but this one), so it follows real
 *     sessions and not what is open on screen;
 *   - the activity line comes from that companion's own telemetry, which
 *     main only samples while someone is WATCHING, so the hook arms the
 *     watch flag for every sibling while the dashboard is mounted and drops
 *     it on unmount (the same 1 Hz feed the sibling's own dashboard would
 *     ask for; both watch channels land in supervisor.setDashboardWatch);
 *   - `paused` is the renderer-side runtime control, like the panel's own.
 *
 * Until a sibling's first snapshot lands, `activity` is null and the panels
 * show an ellipsis rather than claiming "idling".
 */
import { useEffect, useMemo } from 'react';
import type { GameId } from '@shared/gameIpc';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';

export interface GameCompanion {
  id: string;
  name: string | null;
  /** Lowercase bot activity line, or null before the first snapshot. */
  activity: string | null;
  paused: boolean;
}

export function useGameCompanions(characterId: string, game: GameId): GameCompanion[] {
  const summons = useDataStore((s) => s.summons);
  const characters = useDataStore((s) => s.characters);
  const controls = useMcDashboardStore((s) => s.controls);
  const snapshots = useMcDashboardStore((s) => s.snapshots);
  const gameSnapshots = useMcDashboardStore((s) => s.gameSnapshots);
  const setWatching = useMcDashboardStore((s) => s.setWatching);

  const ids = useMemo(() => {
    const out: string[] = [];
    for (const st of Object.values(summons ?? {})) {
      if (!st || st.kind !== 'online' || st.characterId === characterId) continue;
      if ((st.game ?? 'minecraft') !== game) continue;
      out.push(st.characterId);
    }
    return out.sort();
  }, [summons, characterId, game]);

  // One string key so the effect re-arms only when the SET changes, not on
  // every snapshot tick.
  const key = ids.join('\n');
  useEffect(() => {
    const list = key ? key.split('\n') : [];
    for (const id of list) setWatching(id, true);
    return () => {
      for (const id of list) setWatching(id, false);
    };
  }, [key, setWatching]);

  return ids.map((id) => {
    const snap = game === 'minecraft' ? snapshots?.[id] : gameSnapshots?.[id];
    return {
      id,
      name: characters.find((c) => c.id === id)?.name ?? null,
      activity: snap ? String(snap.activity ?? '') : null,
      paused: controls?.[id]?.paused ?? false,
    };
  });
}

/** "gathering oak logs..." -> "Gathering oak logs..."; null (no snapshot yet) -> an ellipsis. */
export function companionActivityText(c: GameCompanion, pausedLabel: string): string {
  if (c.paused) return pausedLabel;
  if (c.activity == null) return '...';
  const a = c.activity || 'idling';
  return a.charAt(0).toUpperCase() + a.slice(1);
}
