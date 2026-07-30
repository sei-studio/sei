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
 * Deliberately NOT persisted: a mid-tutorial quit just means no tour next
 * launch, never a stuck overlay.
 */
import { create } from 'zustand';

export type TutorialStep =
  | 'meet'
  | 'sayhi'
  | 'texting'
  | 'games'
  | 'tiles'
  | 'terminal'
  | 'settings'
  | 'sui'
  | 'bye';

interface TutorialState {
  active: boolean;
  /** The generated companion the full tour introduces; null → reduced tour. */
  characterId: string | null;
  step: TutorialStep;
  start: (characterId: string | null) => void;
  setStep: (step: TutorialStep) => void;
  end: () => void;
}

export const useTutorialStore = create<TutorialState>((set) => ({
  active: false,
  characterId: null,
  step: 'meet',
  start: (characterId) =>
    set({ active: true, characterId, step: characterId ? 'meet' : 'terminal' }),
  setStep: (step) => set({ step }),
  end: () => set({ active: false, characterId: null }),
}));
