/**
 * useMcDashLifecycle — mount effect for the Minecraft dashboard surface.
 * Hydrates the latest snapshot once and reports renderer visibility to main
 * so the bot only samples the minimap while someone is looking
 * (mcdash:set-watching).
 */

import { useEffect } from 'react';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';

export function useMcDashLifecycle(characterId: string): void {
  const hydrate = useMcDashboardStore((s) => s.hydrate);
  const setWatching = useMcDashboardStore((s) => s.setWatching);
  useEffect(() => {
    void hydrate(characterId);
    setWatching(characterId, true);
    return () => setWatching(characterId, false);
  }, [characterId, hydrate, setWatching]);
}
