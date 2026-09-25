/**
 * FreePlayBackBanner — "Your free play is back." (260926).
 *
 * The credit wall used to read as an exit: of 16 users who hit it in the
 * analytics sample, 1 came back. Free play resets every week on its own, so
 * the first time the app sees the account off the wall AFTER the reset it
 * remembered from the wall, it says so, once, in a dismissable strip at the
 * top of the window.
 *
 * Bookkeeping is config.free_play_wall_resets_at (per profile) driven by the
 * credits store; the rules live in decideFreePlayBanner
 * (src/shared/freePlayReset.ts) so they are unit-tested without a DOM. A top
 * up or an upgrade that lifts the wall BEFORE the reset clears the memory
 * silently: "free play is back" would be the wrong thing to say then.
 *
 * Renders nothing until there is something to show.
 */
import React, { useEffect, useRef, useState } from 'react';
import { decideFreePlayBanner } from '@shared/freePlayReset';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { Banner } from './Banner';

export function FreePlayBackBanner(): React.ReactElement | null {
  const t = useT();
  const initialized = useCreditsStore((s) => s.initialized);
  const kind = useCreditsStore((s) => s.ai_backend_kind);
  const snapshotFailed = useCreditsStore((s) => s.snapshotFailed);
  const overLimit = useCreditsStore((s) => s.over_limit);
  const resetsAt = useCreditsStore((s) => s.resets_at);
  const plan = useCreditsStore((s) => s.plan);
  const [shown, setShown] = useState<null | 'free' | 'paid'>(null);
  // One decision at a time: a credits push landing mid-save must not race a
  // second read-modify-write of the same config key. A snapshot that arrives
  // while one runs is kept in `latest` and decided right after.
  const busy = useRef(false);
  const latest = useRef<{ snap: Parameters<typeof decideFreePlayBanner>[1]; plan: string } | null>(null);

  useEffect(() => {
    if (!initialized || kind === null) return;
    latest.current = {
      snap: { cloud: kind === 'cloud-proxy', snapshotFailed, over_limit: overLimit, resets_at: resetsAt },
      plan,
    };
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        while (latest.current) {
          const { snap, plan: planNow } = latest.current;
          latest.current = null;
          const cfg = await sei.getConfig();
          const decision = decideFreePlayBanner(cfg.free_play_wall_resets_at ?? null, snap, Date.now());
          if (decision.store !== undefined) {
            // Re-read right before the write so a settings change made while
            // this ran is not overwritten with the older copy.
            const fresh = await sei.getConfig();
            await sei.saveConfig({ ...fresh, free_play_wall_resets_at: decision.store });
          }
          if (decision.show) {
            setShown(planNow === 'free' ? 'free' : 'paid');
            sei.track('free_play_back_shown', { plan: planNow });
          }
        }
      } catch {
        /* best-effort: a missed banner is harmless */
      } finally {
        busy.current = false;
      }
    })();
  }, [initialized, kind, snapshotFailed, overLimit, resetsAt, plan]);

  if (!shown) return null;
  return (
    <Banner
      kind="info"
      message={
        shown === 'free'
          ? t('Your free play is back. Your companions are ready when you are.')
          : t('Your weekly allowance is back. Your companions are ready when you are.')
      }
      onDismiss={() => setShown(null)}
    />
  );
}
