/**
 * SetupStepper — the one-step-at-a-time setup window every bot-backed
 * game's launch panel opens (260909). It replaced the numbered lists that
 * used to sit on the panels (McSteps, DstSteps on the panel): three or four
 * steps with their copy and buttons made the panel taller than the game
 * aside, and the Launch button fell below the fold on a small window. The
 * window shows ONE step, so it is never taller than the tallest step, and
 * the Launch button stays in view under it.
 *
 * The steps are DATA (`SetupStep[]`, from a per-game hook: useMcSetupSteps,
 * useDstSetupSteps, useStardewSetupSteps), each carrying its live `done`
 * flag, so the window always shows the current state rather than
 * instructions: the same component serves "Set up" (opened on the first
 * step that is not done, and it FOLLOWS progress: whenever a step
 * completes the window moves to the next open one, and it closes on its
 * own once everything is done) and "How do I set up launch?" (opened on
 * step 1 for a player who wants to read it through again; Back / Next
 * browse either way).
 *
 * It renders STRUCTURE only. Every class comes from the caller's
 * `StepperSkin`, because each game paints the window in its own register
 * (a vanilla Minecraft dialog, a Stardew wooden frame, a Don't Starve
 * parchment sheet); the default skin in SetupStepper.module.css is the
 * token look for a game without a register of its own. The step BODIES are
 * rendered by the game hooks against a `StepSkin` for the same reason, and
 * because the same hook feeds the token-styled setup MODAL (DstSetupBody)
 * as well as the game-styled panel.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import defaultStyles from './SetupStepper.module.css';

export interface SetupStep {
  id: string;
  /** Short name shown in the window head ("A world open to LAN"). */
  title: string;
  done: boolean;
  body: React.ReactNode;
}

export interface StepButtonProps {
  kind: 'primary' | 'quiet';
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

/** What a step BODY renders with: a few line styles and the game's button. */
export interface StepSkin {
  /** A row of buttons under the copy. */
  actions: string;
  /** A quieter secondary line (a hint, a sub-step). */
  sub: string;
  /** A path or code line. */
  mono: string;
  /** A quiet text control ("Do not show again"). */
  link: string;
  Button: React.ComponentType<StepButtonProps>;
}

/** What the WINDOW renders with. */
export interface StepperSkin {
  window: string;
  head: string;
  count: string;
  title: string;
  close: string;
  body: string;
  nav: string;
  dots: string;
  dot: string;
  dotDone: string;
  dotNow: string;
  navBtn: string;
}

export type SetupWindowMode = 'setup' | 'help';

/** The default (token) window skin, for a game without a register. */
export const DEFAULT_STEPPER_SKIN: StepperSkin = {
  window: defaultStyles.window,
  head: defaultStyles.head,
  count: defaultStyles.count,
  title: defaultStyles.title,
  close: defaultStyles.close,
  body: defaultStyles.body,
  nav: defaultStyles.nav,
  dots: defaultStyles.dots,
  dot: defaultStyles.dot,
  dotDone: defaultStyles.dotDone,
  dotNow: defaultStyles.dotNow,
  navBtn: defaultStyles.navBtn,
};

/**
 * The launch panel's window state. `setup` closes itself once every step
 * is done (the world is open: nothing left to show, and the panel under it
 * now reads Launch); `help` stays until the player closes it.
 */
export function useSetupWindow(allDone: boolean): {
  mode: SetupWindowMode | null;
  openSetup: () => void;
  openHelp: () => void;
  close: () => void;
} {
  const [mode, setMode] = useState<SetupWindowMode | null>(null);
  useEffect(() => {
    if (mode === 'setup' && allDone) setMode(null);
  }, [mode, allDone]);
  return {
    mode,
    openSetup: () => setMode('setup'),
    openHelp: () => setMode('help'),
    close: () => setMode(null),
  };
}

/** The pulsing-dots waiting line ("Waiting for your world..."). */
export function SearchingLine({ label, className }: { label: string; className?: string }): React.ReactElement {
  return (
    <div className={`${defaultStyles.searching} ${className ?? ''}`}>
      <span className={defaultStyles.searchDots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </div>
  );
}

export interface SetupStepperProps {
  steps: SetupStep[];
  mode: SetupWindowMode;
  onClose: () => void;
  skin?: StepperSkin;
  /** aria-label for the window. */
  label: string;
}

export function SetupStepper({ steps, mode, onClose, skin = DEFAULT_STEPPER_SKIN, label }: SetupStepperProps): React.ReactElement | null {
  const t = useT();
  const firstOpen = steps.findIndex((s) => !s.done);
  // null = follow progress (the first step that is not done); a number =
  // the player pressed Back / Next. Help opens on step 1.
  const [pinned, setPinned] = useState<number | null>(mode === 'help' ? 0 : null);
  const lastFirstOpen = useRef(firstOpen);
  useEffect(() => {
    // Progress (a step completed, or came undone) releases the pin, so a
    // player who browsed ahead is brought back to the step that matters.
    if (lastFirstOpen.current !== firstOpen) {
      lastFirstOpen.current = firstOpen;
      setPinned(null);
    }
  }, [firstOpen]);

  if (steps.length === 0) return null;
  const last = steps.length - 1;
  const fallback = firstOpen === -1 ? last : firstOpen;
  const index = Math.max(0, Math.min(pinned ?? fallback, last));
  const step = steps[index];

  return (
    <section className={skin.window} aria-label={label} data-step={step.id} data-mode={mode}>
      <header className={skin.head}>
        <span className={skin.count}>{t('Step {n} of {m}', { n: index + 1, m: steps.length })}</span>
        <span className={skin.title} data-done={step.done ? 'true' : undefined}>
          {step.done ? '✓ ' : ''}
          {step.title}
        </span>
        <button type="button" className={skin.close} aria-label={t('Close')} onClick={onClose}>
          ×
        </button>
      </header>
      <div className={skin.body}>{step.body}</div>
      <footer className={skin.nav}>
        <button type="button" className={skin.navBtn} disabled={index === 0} onClick={() => setPinned(index - 1)}>
          {t('Back')}
        </button>
        <span className={skin.dots} aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id} className={`${skin.dot} ${s.done ? skin.dotDone : ''} ${i === index ? skin.dotNow : ''}`} />
          ))}
        </span>
        <button type="button" className={skin.navBtn} disabled={index === last} onClick={() => setPinned(index + 1)}>
          {t('Next')}
        </button>
      </footer>
    </section>
  );
}
