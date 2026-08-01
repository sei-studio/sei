/**
 * SuiPrefsScene — "update my preferences", asked by Sui (260731).
 *
 * The retake used to be ProfileQuestionsScreen in 'all' mode: the same three
 * questions as a form, in the app's dark chrome. It is the same three
 * questions here, in the scene the player already answered them in, so
 * changing your mind reads as going back to Sui rather than opening a
 * settings page.
 *
 * The script is NOT the first-run one. That one is a gag (she promises five
 * questions, asks first / second / fourth / last, then realizes she skipped
 * the third and panics) and it only lands once. A returning player gets the
 * straight version: a greeting, three numbered questions, a confirmation.
 *
 * ProfileQuestionsScreen stays for the GATE flows ('missing' / 'first-fill'),
 * which are a different thing: filling gaps before a cast, not a retake.
 *
 * Saving is the same partial-patch write the form used (sei.prefsSave), fired
 * once after the third answer — so backing out of the scene early changes
 * nothing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { t, useT } from '../lib/i18n';
import { useUiStore } from '../lib/stores/useUiStore';
import { OnboardScene, type SuiPose } from './OnboardScene';
import {
  ContinueHint,
  CornerControls,
  fadeThemeClass,
  useEnterAdvances,
  useSuiVoice,
  useTypewriter,
  useVoicePrefs,
} from './suiStage';
import {
  AGE_OPTIONS,
  ArtPicker,
  DynPicker,
  PillPicker,
  type AgeRange,
  type ArtStyle,
  type Dynamic,
} from './suiQuestions';
import styles from './onboard.module.css';

type LineId = 'welcome' | 'qDyn' | 'qAge' | 'qArt' | 'saved';

const SCRIPT: Record<LineId, string> = {
  welcome: 'Welcome back! So you want to update your preferences!',
  qDyn: 'First! What kind of people do you like having around? Pick as many as you want. Order matters.',
  qAge: "Got it. Second! We AI can live for a very long time. Which age range best fits what you're looking for?",
  qArt: 'I see! Finally, take a look at these portraits. Which one do you like the most?',
  saved: "I've saved your preferences. Come back anytime!",
};

/** Voice clip ids, deliberately their OWN namespace: three of these lines read
 * differently from the first-run ones, so reusing those clips would speak text
 * that is not on screen. Cut 260731 (public/voice/onboard/prefs-<id>.en.mp3),
 * through the same three steps as the first-run clips — see useSuiVoice. */
const CLIP: Record<LineId, string> = {
  welcome: 'prefs-welcome',
  qDyn: 'prefs-qDyn',
  qAge: 'prefs-qAge',
  qArt: 'prefs-qArt',
  saved: 'prefs-saved',
};

/** Text-only lines get the idle "continue" nudge after 5s; the question lines
 * have controls, so they never do. */
const HINT_LINES: LineId[] = ['welcome', 'saved'];

type Phase =
  | { k: 'intro' } // ground slides in, Sui walks in
  | { k: 'line'; id: LineId }
  | { k: 'walkoff' } // Sui leaves, then the ground leaves, then we navigate
  | { k: 'fade' };

export interface SuiPrefsSceneProps {
  /** Where leaving the scene lands: the surface the entry link lives on. */
  next: 'awaken' | 'settings';
}

export function SuiPrefsScene({ next }: SuiPrefsSceneProps): React.ReactElement {
  const tt = useT();
  const navigate = useUiStore((s) => s.navigate);
  const [phase, setPhase] = useState<Phase>({ k: 'intro' });
  const [groundIn, setGroundIn] = useState(false);
  const [sui, setSui] = useState<SuiPose>('hidden');
  const { prefs: voicePrefs, setPrefs: setVoicePrefs, volume } = useVoicePrefs();

  // ── Answers ────────────────────────────────────────────────────────────
  // State, not a ref: "Back" re-renders the previous picker and it has to open
  // on what is already chosen. null = not loaded / never answered.
  const [dynamics, setDynamics] = useState<Dynamic[] | null>(null);
  const [age, setAge] = useState<AgeRange | null>(null);
  const [art, setArt] = useState<ArtStyle | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);

  // Prefill from the stored profile. Resolves long before the first question
  // (the walk-in plus the greeting is several seconds), and a failure still
  // flips `loaded` — an unreachable profile must not lock the scene shut.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await sei.prefsGet();
        if (cancelled) return;
        if (res.profile) {
          setDynamics(res.profile.companion_dynamics);
          setAge(res.profile.companion_age_range);
          setArt(res.profile.art_style);
        }
      } catch {
        /* ask everything fresh, prefill nothing */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Scene choreography ─────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => setGroundIn(true), 350);
    return () => clearTimeout(timer);
  }, []);

  const onGroundIn = useCallback(() => setSui('entering'), []);
  const onSuiEntered = useCallback(() => {
    setSui('idle');
    // A beat of her just standing there before she speaks.
    window.setTimeout(() => {
      setPhase((p) => (p.k === 'intro' ? { k: 'line', id: 'welcome' } : p));
    }, 1000);
  }, []);
  const onSuiLeft = useCallback(() => {
    setSui('hidden');
    setGroundIn(false);
  }, []);

  const leftRef = useRef(false);
  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    setPhase({ k: 'fade' });
    setTimeout(() => navigate({ kind: next === 'settings' ? 'settings' : 'awaken' }), 700);
  }, [navigate, next]);
  const onGroundOut = useCallback(() => leave(), [leave]);

  const goLine = useCallback((id: LineId) => setPhase({ k: 'line', id }), []);
  const walkOff = useCallback(() => {
    setPhase({ k: 'walkoff' });
    setSui('leaving');
  }, []);

  // ── Line rendering ─────────────────────────────────────────────────────
  const line = phase.k === 'line' ? phase.id : null;
  const lineText = line ? tt(SCRIPT[line]) : '';
  const tw = useTypewriter(lineText);
  useSuiVoice(line ? CLIP[line] : null, volume);

  useEffect(() => {
    if (!line) return;
    // Mouth closes during the full-stop breath, matching the typewriter.
    setSui(tw.done || tw.paused ? 'idle' : 'talking');
  }, [line, tw.done, tw.paused]);

  const [hintOn, setHintOn] = useState(false);
  useEffect(() => {
    setHintOn(false);
    if (!line || !tw.done || !HINT_LINES.includes(line)) return undefined;
    const timer = setTimeout(() => setHintOn(true), 5000);
    return () => clearTimeout(timer);
  }, [line, tw.done]);

  // ── Save ───────────────────────────────────────────────────────────────
  // One write, after the third answer. The same partial patch the form sent:
  // main merges it over the stored answers under the config lock.
  const save = useCallback(
    async (finalArt: ArtStyle) => {
      // Single flight: the art tiles stay clickable for the moment the write
      // is in the air, and a second pick would send a second patch.
      if (savingRef.current) return;
      savingRef.current = true;
      setSaveError(null);
      try {
        await sei.prefsSave({
          companion_age_range: age,
          // [] is the explicit "Surprise me" (vs null = never asked).
          companion_dynamics: dynamics ?? [],
          art_style: finalArt,
        });
        goLine('saved');
      } catch (err) {
        setSaveError((err as Error).message || t('Something went wrong.'));
      } finally {
        savingRef.current = false;
      }
    },
    [age, dynamics, goLine],
  );

  const advance = useCallback(() => {
    if (!line) return;
    if (!tw.done) {
      tw.skip();
      return;
    }
    if (line === 'welcome') goLine('qDyn');
    else if (line === 'saved') walkOff();
  }, [line, tw, goLine, walkOff]);

  useEnterAdvances(advance);

  const clickAdvances = line === 'welcome' || line === 'saved';

  const controls = ((): React.ReactNode => {
    if (!line || !loaded) return null;
    switch (line) {
      case 'qDyn':
        return (
          <DynPicker
            initial={dynamics}
            onDone={(picked) => {
              setDynamics(picked);
              goLine('qAge');
            }}
            onBack={() => goLine('welcome')}
          />
        );
      case 'qAge':
        return (
          <PillPicker
            options={AGE_OPTIONS}
            selected={age}
            onPick={(value) => {
              setAge(value);
              goLine('qArt');
            }}
            onBack={() => goLine('qDyn')}
          />
        );
      case 'qArt':
        return (
          <ArtPicker
            selected={art}
            onPick={(value) => {
              setArt(value);
              void save(value);
            }}
            onBack={() => goLine('qAge')}
          />
        );
      case 'saved':
        return (
          <div className={styles.choices}>
            <button className={styles.pill} onClick={advance}>
              {tt('See you')}
            </button>
          </div>
        );
      default:
        return null;
    }
  })();

  return (
    <div className={styles.root}>
      <CornerControls
        prefs={voicePrefs}
        onPrefs={setVoicePrefs}
        onClose={leave}
        closeLabel="Leave"
      />
      <div
        className={styles.card}
        onClick={clickAdvances ? advance : line && !tw.done ? tw.skip : undefined}
      >
        <div className={styles.dragStrip} />
        <OnboardScene
          groundIn={groundIn}
          sui={sui}
          // Footsteps follow the voice volume/mute, well under her lines.
          sfxVolume={volume * 0.35}
          onGroundIn={onGroundIn}
          onGroundOut={onGroundOut}
          onSuiEntered={onSuiEntered}
          onSuiLeft={onSuiLeft}
        />

        {line ? (
          <div className={styles.dialogue}>
            <p className={styles.lineText}>
              {tw.shown}
              {!tw.done ? <span className={styles.caret} /> : null}
            </p>
            {hintOn && tw.done ? <ContinueHint /> : null}
            {tw.done ? controls : null}
          </div>
        ) : null}

        {saveError ? (
          <div className={styles.panel}>
            <p className={styles.panelText}>{saveError}</p>
            <button
              className={styles.pill}
              onClick={() => {
                if (art) void save(art);
              }}
            >
              {tt('Try again')}
            </button>
            <button className={styles.quietLink} onClick={leave}>
              {tt('Back')}
            </button>
          </div>
        ) : null}

        <div
          className={
            phase.k === 'fade' ? `${styles.fade} ${styles.fadeOn} ${fadeThemeClass()}` : styles.fade
          }
        />
      </div>
    </div>
  );
}
