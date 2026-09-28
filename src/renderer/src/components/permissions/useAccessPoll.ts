/**
 * React glue for lib/permissions/accessPoller (260929): poll while `active`,
 * re-check at once when the window regains focus (the player coming back from
 * System Settings), stop on unmount.
 */
import { useEffect, useRef } from 'react';
import { startAccessPoller } from '../../lib/permissions/accessPoller';

export function useAccessPoll(
  active: boolean,
  check: () => Promise<boolean>,
  onGranted: () => void,
  immediate = true,
): void {
  // Latest callbacks without restarting the poller on every render.
  const checkRef = useRef(check);
  const grantedRef = useRef(onGranted);
  checkRef.current = check;
  grantedRef.current = onGranted;

  useEffect(() => {
    if (!active) return;
    const poller = startAccessPoller({
      check: () => checkRef.current(),
      onGranted: () => grantedRef.current(),
      immediate,
    });
    const onFocus = (): void => poller.poke();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      poller.stop();
    };
  }, [active, immediate]);
}
