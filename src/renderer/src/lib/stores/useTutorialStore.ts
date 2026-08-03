/**
 * useTutorialStore — the post-onboarding guided tour (260728).
 *
 * Armed by App.tsx when the Sui onboarding scene completes (OnboardApp's
 * onComplete). Two shapes:
 *   full     — a companion was generated: starts on their page ('meet') and
 *              walks say-hi → chat surface → games → home terminal → settings
 *              → Sui → goodbye.
 *   reduced  — local mode / generation skipped or failed: no companion page
 *              to tour, so it starts at the home terminal step.
 *
 * The TutorialOverlay component owns rendering, step advancement, and target
 * spotlighting (via [data-tutorial] attributes sprinkled on the real UI).
 *
 * PERSISTED since 260730 (config.tutorial_state): every start/advance writes
 * the current step, finish/skip clears it, and App.tsx's boot resumes an
 * armed tour at the same step and screen. It used to be deliberately
 * unpersisted ("a mid-tutorial quit just means no tour next launch"), but
 * that silently dropped the one-shot unique-reveal "say hello" page along
 * with the rest of the tour. The write is fire-and-forget through the
 * get-then-save pattern; a failed write degrades to exactly the old
 * behavior (no tour next launch), never a stuck overlay.
 */
import { create } from 'zustand';
import { sei } from '../ipcClient';

export type TutorialStep =
  | 'meet'
  | 'sayhi'
  | 'texting'
  | 'games'
  | 'tiles'
  // 260803: sits between 'tiles' and 'terminal' on purpose, because it needs
  // the chat header, which is still on screen behind the games popup. It is
  // also now the step that leaves for Home, which 'tiles' used to do.
  | 'backseat'
  | 'terminal'
  | 'settings'
  | 'sui'
  | 'bye';

function persist(state: { step: TutorialStep; characterId: string | null } | null): void {
  void sei
    .getConfig()
    .then((cfg) => sei.saveConfig({ ...cfg, tutorial_state: state }))
    .catch(() => {
      /* resume just won't survive a quit */
    });
}

interface TutorialState {
  active: boolean;
  /** The generated companion the full tour introduces; null → reduced tour. */
  characterId: string | null;
  step: TutorialStep;
  start: (characterId: string | null) => void;
  /** Boot-resume: arm the tour at a saved step without re-persisting it. */
  resume: (characterId: string | null, step: TutorialStep) => void;
  setStep: (step: TutorialStep) => void;
  end: () => void;
}

export const useTutorialStore = create<TutorialState>((set, get) => ({
  active: false,
  characterId: null,
  step: 'meet',
  start: (characterId) => {
    const step: TutorialStep = characterId ? 'meet' : 'terminal';
    set({ active: true, characterId, step });
    persist({ step, characterId });
  },
  resume: (characterId, step) => set({ active: true, characterId, step }),
  setStep: (step) => {
    set({ step });
    persist({ step, characterId: get().characterId });
  },
  end: () => {
    set({ active: false, characterId: null });
    persist(null);
  },
}));
