/**
 * ProfileQuestionsScreen — the companion questionnaire (260703 procgen, spec
 * item 6; reworked 260706). Up to three QuestionShell steps of tile options
 * that seed a user profile used as the generation seed for 'unique'
 * companions, in ask order (PREF_QUESTIONS):
 *   1. How old should your companions feel? (companion_age_range)
 *   2. What are you looking for? (companion_dynamics — RANKED, partial ok)
 *   3. Pick an art style. (art_style)
 *
 * The dynamics step is a ranking, not a single pick: ranked relationships are
 * granted one cast each, top pick first (resolveDynamic in
 * src/main/uniqueGeneration.ts). "Surprise me" is exclusive — selecting it
 * locks the other tiles and saves an empty ranking.
 *
 * Modes (260706):
 *   - 'missing' — asks ONLY the unanswered questions (fresh onboarding asks
 *     all three; a profile completed before a new question shipped, or
 *     abandoned partway, re-asks just the gaps). Used by every gate flow.
 *   - 'all'     — full retake, every question prefilled with the current
 *     answer. Used by the "Update my preferences" entries (Awaken, Settings).
 *
 * Submit persists ONLY the questions that were shown, via sei.prefsSave —
 * a partial patch that main merges over the stored answers under the config
 * file lock (local config.user_profile + cloud user_preferences upsert).
 * On completion it routes to `next`; cancelling (Back on the first step)
 * returns to the flow's origin.
 *
 * Names only for the art styles for now (spec: example images come later).
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import type {
  CompanionDynamic,
  PrefQuestion,
  UserPreferences,
  UserPreferencesPatch,
} from '@shared/characterSchema';
import { PREF_QUESTIONS } from '@shared/characterSchema';
import styles from './ProfileQuestionsScreen.module.css';

type AgeRange = NonNullable<UserPreferences['companion_age_range']>;
type ArtStyle = NonNullable<UserPreferences['art_style']>;

const AGE_OPTIONS: Array<{ value: AgeRange; label: string; sub: string }> = [
  { value: 'young-adult', label: 'Young adult', sub: 'Fresh, spirited, early twenties energy.' },
  { value: 'adult', label: 'Adult', sub: 'Grounded and self-assured.' },
  { value: 'mature', label: 'Mature', sub: 'Seasoned, with lived-in wisdom.' },
  { value: 'elder', label: 'Elder', sub: 'Old souls who have seen it all.' },
  { value: 'timeless', label: 'Timeless', sub: 'Ageless, beyond years entirely.' },
];

const DYNAMIC_OPTIONS: Array<{ value: CompanionDynamic; label: string; sub: string }> = [
  { value: 'partner-in-crime', label: 'A partner in crime', sub: 'Always game for the questionable idea.' },
  { value: 'caretaker', label: 'Someone to look after you', sub: 'Warm, steady, keeps an eye on you.' },
  { value: 'protege', label: 'Someone to look after', sub: 'A little green. They grow at your side.' },
  { value: 'chill-friend', label: 'A chill friend', sub: 'Easy company, no drama.' },
  { value: 'challenger', label: 'Someone who pushes you', sub: 'Keeps you sharp, keeps you honest.' },
];

const STYLE_OPTIONS: Array<{ value: ArtStyle; label: string; sub: string }> = [
  { value: 'chibi', label: 'Round chibi', sub: 'Soft, cute, big-headed charm.' },
  { value: 'anime', label: 'Anime', sub: 'Classic Japanese animation look.' },
  { value: 'celshaded', label: 'Cel-shaded', sub: 'Bold lines, flat painterly shading.' },
  { value: 'cartoon', label: 'Cartoon', sub: 'Western animated styling.' },
  { value: '3d', label: '3D', sub: 'Rendered, dimensional, modern.' },
];

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

export interface ProfileQuestionsScreenProps {
  next: 'home' | 'unique-gender' | 'activity-picker' | 'awaken' | 'settings';
  mode: 'missing' | 'all' | 'first-fill';
  /**
   * Called when the user dismisses the questionnaire with "Later" on the first
   * step (first-sign-in Home gate only). Lets the App gate record the deferral
   * so it does not immediately re-open the questionnaire in this session.
   */
  onDefer?: () => void;
}

export function ProfileQuestionsScreen({ next, mode, onDefer }: ProfileQuestionsScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  // Questions this run asks, resolved from the current profile on mount.
  // null = still loading the profile.
  const [questions, setQuestions] = useState<PrefQuestion[] | null>(null);
  const [step, setStep] = useState(0);
  const [age, setAge] = useState<AgeRange | null>(null);
  const [ranking, setRanking] = useState<CompanionDynamic[]>([]);
  const [surprise, setSurprise] = useState(false);
  const [style, setStyle] = useState<ArtStyle | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goTo = (view: ProfileQuestionsScreenProps['next']): void => {
    if (view === 'home') {
      navigate({ kind: 'home' });
    } else if (view === 'unique-gender') {
      navigate({ kind: 'unique-gender' });
    } else if (view === 'activity-picker') {
      navigate({ kind: 'activity-picker' });
    } else if (view === 'awaken') {
      navigate({ kind: 'awaken' });
    } else {
      navigate({ kind: 'settings' });
    }
  };

  // Where a completed run lands. 'first-fill' (a brand-new user walked through
  // the questionnaire by the Home gate) continues straight into the unique
  // companion flow at the gender step so their first companion gets cast,
  // rather than dropping them on an empty Home.
  const finish = (): void => {
    if (mode === 'first-fill') {
      navigate({ kind: 'unique-gender' });
      return;
    }
    goTo(next);
  };

  // Where Back-on-the-first-step (cancel) lands. Gate flows return to a
  // sensible origin; the mid-onboarding flow has no "back" (onboarding is
  // already submitted), so cancel just continues onward — the missing
  // answers are re-asked at "Meet my companion".
  const cancel = (): void => {
    if (next === 'unique-gender' || next === 'awaken') {
      navigate({ kind: 'awaken' });
    } else if (next === 'activity-picker') {
      navigate({ kind: 'activity-picker' });
    } else if (next === 'settings') {
      navigate({ kind: 'settings' });
    } else {
      navigate({ kind: 'home' });
    }
  };

  // Resolve which questions to ask + prefill current answers. 'all' shows
  // every question; 'missing' only the unanswered ones (and routes straight
  // onward if nothing is missing — e.g. a stale gate).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let profile: UserPreferences | null = null;
      let missing: PrefQuestion[] = [...PREF_QUESTIONS];
      try {
        const res = await sei.prefsGet();
        profile = res.profile;
        missing = res.missing;
      } catch {
        // Fall through: ask everything, prefill nothing.
      }
      if (cancelled) return;
      if (profile) {
        setAge(profile.companion_age_range);
        setStyle(profile.art_style);
        if (profile.companion_dynamics !== null) {
          setSurprise(profile.companion_dynamics.length === 0);
          setRanking(profile.companion_dynamics);
        }
      }
      const asked = mode === 'all' ? [...PREF_QUESTIONS] : missing;
      if (asked.length === 0) {
        finish();
        return;
      }
      setQuestions(asked);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, next]);

  if (questions === null) return <></>;

  const current = questions[step];
  const isLast = step === questions.length - 1;

  const answered = (q: PrefQuestion): boolean => {
    if (q === 'companion_age_range') return age !== null;
    if (q === 'companion_dynamics') return surprise || ranking.length > 0;
    return style !== null;
  };

  const goNext = async (): Promise<void> => {
    if (!isLast) {
      setStep((s) => s + 1);
      return;
    }
    if (!questions.every(answered)) return;
    setSubmitting(true);
    setError(null);
    try {
      // Persist ONLY the questions this run asked — main merges the patch
      // over the stored answers (see prefs:save), so an unshown question's
      // existing answer is never touched.
      const patch: UserPreferencesPatch = {};
      for (const q of questions) {
        if (q === 'companion_age_range') patch.companion_age_range = age;
        // [] is the explicit "Surprise me" (vs null = never asked).
        else if (q === 'companion_dynamics') patch.companion_dynamics = surprise ? [] : ranking;
        else patch.art_style = style;
      }
      await sei.prefsSave(patch);
      finish();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const back = (): void => {
    if (step > 0) {
      setStep((s) => s - 1);
      return;
    }
    // First step: the button reads "Later" and dismisses the questionnaire
    // without saving completion. Notify the caller so the Home gate records the
    // deferral (no re-open this session); the gate offers it again next launch.
    onDefer?.();
    cancel();
  };

  const toggleDynamic = (v: CompanionDynamic): void => {
    if (surprise) return; // locked while "Surprise me" is on
    setRanking((prev) => (prev.includes(v) ? prev.filter((d) => d !== v) : [...prev, v]));
  };

  const toggleSurprise = (): void => {
    setSurprise((prev) => {
      if (!prev) setRanking([]); // turning it on wipes the ranking
      return !prev;
    });
  };

  // First step's back button dismisses ("Later") rather than navigating a step
  // back; later steps keep the "Back" affordance.
  const onFirstStep = step === 0;
  const shellProps = {
    eyebrow: 'Set up your companions',
    stepCount: questions.length,
    currentStep: step,
    onBack: back,
    backLabel: onFirstStep ? 'Later' : 'Back',
    hideBackIcon: onFirstStep,
    onNext: () => void goNext(),
    nextLabel: isLast ? (submitting ? 'Saving…' : 'Finish') : 'Continue',
    nextKind: isLast ? ('accent' as const) : undefined,
    nextDisabled: !answered(current) || submitting,
    // Wider column so the tile groups lay out horizontally and every question
    // page fits the default window without a scrollbar.
    wide: true,
  };

  if (current === 'companion_age_range') {
    return (
      <QuestionShell
        {...shellProps}
        title="How old should your companions feel?"
        hint="This shapes how the companions Sei casts for you come across. You can update this any time from Settings."
      >
        <TileGroup
          ariaLabel="Companion age range"
          options={AGE_OPTIONS}
          value={age}
          onChange={setAge}
        />
        {isLast && error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
      </QuestionShell>
    );
  }

  if (current === 'companion_dynamics') {
    return (
      <QuestionShell
        {...shellProps}
        title="What are you looking for?"
        hint="Rank what you're hoping to meet. Your first companion matches your first pick, the next one your second, and so on. You don't have to rank them all."
      >
        <div className={styles.rankGrid} aria-label="Companion dynamics ranking">
          {DYNAMIC_OPTIONS.map((opt) => {
            const rank = ranking.indexOf(opt.value);
            const ranked = rank !== -1;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={ranked}
                disabled={surprise}
                className={[
                  styles.tile,
                  styles.rankTile,
                  ranked ? styles.tileSelected : '',
                  surprise ? styles.tileLocked : '',
                ].join(' ')}
                onClick={() => toggleDynamic(opt.value)}
              >
                <span className={styles.rankTileText}>
                  <span className={styles.tileLabel}>{opt.label}</span>
                  <span className={styles.tileSub}>{opt.sub}</span>
                </span>
                {ranked ? <span className={styles.rankBadge}>{ORDINALS[rank]}</span> : null}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={surprise}
            className={`${styles.tile} ${styles.rankTile} ${surprise ? styles.tileSelected : ''}`}
            onClick={toggleSurprise}
          >
            <span className={styles.rankTileText}>
              <span className={styles.tileLabel}>Surprise me</span>
              <span className={styles.tileSub}>Let the cast decide who you meet.</span>
            </span>
          </button>
        </div>
        {isLast && error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
      </QuestionShell>
    );
  }

  return (
    <QuestionShell
      {...shellProps}
      title="Pick an art style"
      hint="How your companions look when Sei gives them a face."
    >
      <TileGroup
        ariaLabel="Art style"
        options={STYLE_OPTIONS}
        value={style}
        onChange={setStyle}
      />
      {isLast && error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
    </QuestionShell>
  );
}

/**
 * TileGroup — a vertical radio-tile group matching the AddCharacterScreen
 * proactiveness step idiom (accent border + soft fill when selected).
 */
function TileGroup<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: Array<{ value: T; label: string; sub: string }>;
  value: T | null;
  onChange: (v: T) => void;
}): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.tiles}>
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <span className={styles.tileLabel}>{opt.label}</span>
            <span className={styles.tileSub}>{opt.sub}</span>
          </button>
        );
      })}
    </div>
  );
}
