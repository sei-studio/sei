/**
 * useHomeNextStepStore â€” the Home "up next" card's data (261013, T119).
 *
 * Holds main's answer to `home:next-steps` for the Home roster, plus the
 * cards the player dismissed this app session (a dismissed card comes back on
 * the next launch: reopening the app is exactly when it should be seen). The
 * rules for which card shows live in lib/homeNextStep.ts.
 *
 * Account scoped: the bundled defaults share their ids across profiles, so
 * resetAccountScopedState (lib/scopeReset.ts) calls reset(), and a load that
 * was in flight across the reset is dropped (epoch).
 */
import { create } from 'zustand';
import type { HomeNextStep } from '@shared/homeNextStep';
import { sei } from '../ipcClient';
import { nextStepKey, resetNextStepShown } from '../homeNextStep';

interface HomeNextStepState {
  steps: Record<string, HomeNextStep>;
  dismissed: Set<string>;
  epoch: number;
  /** Re-read the cards for these ids (Home order). Never throws. */
  load: (ids: readonly string[]) => Promise<void>;
  dismiss: (step: HomeNextStep) => void;
  reset: () => void;
}

export const useHomeNextStepStore = create<HomeNextStepState>((set, get) => ({
  steps: {},
  dismissed: new Set<string>(),
  epoch: 0,
  load: async (ids) => {
    const epoch = get().epoch;
    if (ids.length === 0) {
      set({ steps: {} });
      return;
    }
    try {
      const steps = await sei.homeNextSteps([...ids]);
      if (get().epoch !== epoch) return;
      set({ steps: steps ?? {} });
    } catch {
      /* no card is the safe answer */
    }
  },
  dismiss: (step) => set((s) => ({ dismissed: new Set([...s.dismissed, nextStepKey(step)]) })),
  reset: () => {
    resetNextStepShown();
    set((s) => ({ steps: {}, dismissed: new Set<string>(), epoch: s.epoch + 1 }));
  },
}));




