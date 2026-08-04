/**
 * SuiMeetScene — "meet my companion", run by Sui (260731).
 *
 * Replaces the two screens the flow used to be: UniqueGenderScreen (a form
 * asking which gender to cast) and UniqueCastingScreen (a bare progress bar).
 * Both were correct and neither had a voice, which made the one moment the
 * app is actually about read like a settings step followed by a download.
 *
 * The beat: Sui walks in, counts which companion this is for you, offers the
 * three she says are ready to be awakened, then goes to fetch them. She walks
 * off, the field slides off after her, and the bar takes the empty sky.
 *
 * Generation starts the INSTANT the choice is made, not when the bar appears.
 * The walk-off is about two seconds of animation and the cast is a minute of
 * model calls; paying for both in series would be two seconds of nothing.
 *
 * On success the scene hands off to the reveal exactly as the old casting
 * screen did. Failures surface over the sky with the same copy (CAST_ERROR_COPY)
 * and the same two ways out.
 *
 * ── The preference questions live HERE now (260802) ──────────────────────
 * The cast needs the questionnaire answered — it is the generation seed — and
 * the app used to collect it by AMBUSH: a Home gate that opened
 * ProfileQuestionsScreen (a dark-chrome form) the moment a signed-in user with
 * gaps landed anywhere near Home, plus a matching gate on this flow's entry
 * that bounced the player out to that same form and back. Nobody asked for
 * either. That screen is gone, and so is every unprompted route to it: the
 * questionnaire is now asked in exactly two places, both of which the player
 * clicked on purpose — "Update my preferences" (SuiPrefsScene) and here.
 *
 * So when answers are missing, Sui asks for them BETWEEN the greeting and the
 * casting question, on the same stage, without leaving: she says she needs a
 * hand first, asks only the gaps (PREF_QUESTIONS order), saves once, and walks
 * straight on into "which one would you like to meet?". No walk-off, no route
 * change, no second scene — the whole point is that this reads as one
 * conversation rather than a detour.
 *
 * The question lines are the prefs-scene wording with the ordinals removed
 * ("First!" / "Second!" / "Finally"): a subset ask cannot promise a count, and
 * a line that opens on "Second!" when it is the only question is worse than no
 * line at all. Hence their own clips.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { isHomeCharacter } from '../lib/homeLibrary';
import { MAX_COMPANION_SLOTS, PREF_QUESTIONS } from '@shared/characterSchema';
import type { PrefQuestion, UserPreferencesPatch } from '@shared/characterSchema';
import type { UniqueGender } from '@shared/ipc';
import {
  CAST_ERROR_COPY,
  STAGE_COPY,
  useUniqueCasting,
} from '../lib/uniqueCasting';
import { OnboardScene, type SuiPose } from './OnboardScene';
import {
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
  GENDER_OPTIONS,
  PillPicker,
} from './suiQuestions';
import styles from './onboard.module.css';

type QuestionLineId = 'qAge' | 'qDyn' | 'qArt';
type LineId = 'ready' | 'needQs' | QuestionLineId | 'which' | 'gotIt';

/** Which line asks which stored answer. Keyed by PrefQuestion so the ask order
 * is PREF_QUESTIONS' order and a question added there cannot be silently
 * skipped here — the map stops compiling until it has a line. */
const QUESTION_LINE: Record<PrefQuestion, QuestionLineId> = {
  companion_age_range: 'qAge',
  companion_dynamics: 'qDyn',
  art_style: 'qArt',
};

/** The greeting counts which companion this is, and ASKS rather than tells:
 * the player arrives here from a tile, which is a click and not a decision, so
 * the scene opens by giving them one.
 *
 * Four WHOLE sentences rather than one sentence with an {ordinal} slot: a bare
 * "third" is too generic a dictionary key to own safely, and languages that
 * need a measure word or a different word order cannot get there by
 * substitution. Each carries its OWN clip for the same reason it carries its
 * own sentence — one clip across all four would speak an ordinal that is not
 * the one on screen. */
const READY_LINES: Array<{ text: string; clip: string }> = [
  { text: 'So! Are you ready to meet your first companion?', clip: 'meet-readyFirst' },
  { text: 'So! Are you ready to meet your second companion?', clip: 'meet-readySecond' },
  { text: 'So! Are you ready to meet your third companion?', clip: 'meet-readyThird' },
  { text: 'So! Are you ready to meet your final companion?', clip: 'meet-readyFinal' },
];

/** "Not yet" leaves the scene rather than stalling in it: there is nothing
 * else here to do, and a companion is not something to be talked into. */
const READY_OPTIONS: Array<{ value: 'yes' | 'no'; label: string }> = [
  { value: 'yes', label: "I'm ready" },
  { value: 'no', label: 'Not yet' },
];

const SCRIPT: Record<Exclude<LineId, 'ready'>, string> = {
  needQs: 'Before that, I need your help with a few questions!',
  qAge: "We AI can live for a very long time. Which age range best fits what you're looking for?",
  qDyn: 'What kind of people do you like having around? Pick as many as you want. Order matters.',
  qArt: 'Take a look at these portraits. Which one do you like the most?',
  which: 'I have three companions who are ready to be awakened! Which one would you like to meet?',
  gotIt: 'Got it. Let me go get them!',
};

/** Own clip namespace — none of these lines exist in the first-run script, so
 * there is nothing to reuse. Cut 260731 (the four `meet-q*` / `meet-needQs`
 * ones 260802) through the same three steps as the rest
 * (public/voice/onboard/meet-<id>.en.mp3 — see useSuiVoice); a missing clip
 * stays a non-event, so a new line can ship ahead of its recording. */
const CLIP: Record<Exclude<LineId, 'ready'>, string> = {
  needQs: 'meet-needQs',
  qAge: 'meet-qAge',
  qDyn: 'meet-qDyn',
  qArt: 'meet-qArt',
  which: 'meet-which',
  gotIt: 'meet-gotIt',
};

type Phase =
  | { k: 'intro' } // ground slides in, Sui walks in
  | { k: 'line'; id: LineId }
  | { k: 'walkoff' } // Sui leaves, then the field leaves
  | { k: 'casting' } // empty sky, wordmark, bar
  | { k: 'fade' };

export function SuiMeetScene(): React.ReactElement {
  const tt = useT();
  const navigate = useUiStore((s) => s.navigate);
  const [phase, setPhase] = useState<Phase>({ k: 'intro' });
  const [groundIn, setGroundIn] = useState(false);
  const [sui, setSui] = useState<SuiPose>('hidden');
  const { prefs: voicePrefs, setPrefs: setVoicePrefs, volume } = useVoicePrefs();

  // ── Which companion is this? ───────────────────────────────────────────
  // The same home-library rule the party wall and the rail count, so Sui's
  // number can never disagree with the slots the player can see. Computed
  // live rather than latched at mount: the library list can still be settling
  // when the scene opens, and a stale empty read would have her greet a full
  // party with "your first companion".
  const characters = useDataStore((s) => s.characters);
  const authState = useAuthStore((s) => s.state);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const readyLine = useMemo(() => {
    const filled = characters.filter((c) =>
      isHomeCharacter(c, currentUserId, addedDefaultIds, addedWorldIds),
    ).length;
    // The last slot is "final", not "fourth": it is the last one the player
    // has, and saying so is the honest thing to say at that moment.
    return READY_LINES[Math.min(Math.max(filled, 0), MAX_COMPANION_SLOTS - 1)];
  }, [characters, currentUserId, addedDefaultIds, addedWorldIds]);

  // ── The questionnaire gaps ─────────────────────────────────────────────
  // Read once at mount, which is several seconds of walk-in and greeting
  // before the answer is needed. A failed read means NO questions: the cast
  // seeds from whatever is stored and Sui asks next time, which is the same
  // fail-open stance the old Awaken gate took. `asked` is the gaps latched at
  // that read, so the questions cannot change under the player mid-run.
  const [asked, setAsked] = useState<PrefQuestion[]>([]);
  const [askIdx, setAskIdx] = useState(0);
  // Only the answers she actually asked for, accumulated as a patch: main
  // merges it over the stored profile, so an untouched question stays
  // untouched. A ref because each answer is read inside the NEXT answer's
  // handler, and a re-render is neither needed nor wanted mid-line.
  const answersRef = useRef<UserPreferencesPatch>({});
  const savingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await sei.prefsGet();
        if (cancelled) return;
        // PREF_QUESTIONS order, so she asks them the way every other surface
        // does rather than in whatever order the gaps came back.
        setAsked(PREF_QUESTIONS.filter((q) => res.missing.includes(q)));
      } catch {
        /* fail open: no questions, straight to the cast */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── The cast ───────────────────────────────────────────────────────────
  // null until the player picks; the hook holds off until then.
  const [gender, setGender] = useState<UniqueGender | null>(null);
  const cast = useUniqueCasting(gender);

  // ── Scene choreography ─────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => setGroundIn(true), 350);
    return () => clearTimeout(timer);
  }, []);

  const onGroundIn = useCallback(() => setSui('entering'), []);
  const onSuiEntered = useCallback(() => {
    setSui('idle');
    window.setTimeout(() => {
      setPhase((p) => (p.k === 'intro' ? { k: 'line', id: 'ready' } : p));
    }, 1000);
  }, []);
  const onSuiLeft = useCallback(() => {
    setSui('hidden');
    setGroundIn(false);
  }, []);
  // The field finishing its slide is what hands the window to the bar.
  const onGroundOut = useCallback(() => {
    setPhase((p) => (p.k === 'walkoff' ? { k: 'casting' } : p));
  }, []);

  const goLine = useCallback((id: LineId) => setPhase({ k: 'line', id }), []);
  const walkOff = useCallback(() => {
    setPhase({ k: 'walkoff' });
    setSui('leaving');
  }, []);

  /** "I'm ready" → the questions if there are any, else straight to the cast
   * question. Both destinations are on this stage; she never leaves. */
  const beginAsk = useCallback(() => {
    if (asked.length === 0) {
      goLine('which');
      return;
    }
    setAskIdx(0);
    goLine('needQs');
  }, [asked.length, goLine]);

  /** One answer in. Advances to the next gap, or writes the patch and hands
   * the scene on to the casting question.
   *
   * The write is AWAITED before 'which': the cast starts on the gender pick a
   * few seconds later and seeds itself from the stored profile, so a patch
   * still in flight would cast against the old answers. A failed write is not
   * worth stopping a companion over, so it falls through to the cast and the
   * gaps are simply still there next time. */
  const answer = useCallback(
    <K extends PrefQuestion>(key: K, value: UserPreferencesPatch[K]) => {
      answersRef.current[key] = value;
      const next = askIdx + 1;
      if (next < asked.length) {
        setAskIdx(next);
        goLine(QUESTION_LINE[asked[next]]);
        return;
      }
      if (savingRef.current) return;
      savingRef.current = true;
      void (async () => {
        try {
          await sei.prefsSave(answersRef.current);
          // Answered and stored: Back out of the casting question and in again
          // must not re-ask what she just wrote down. (A FAILED write keeps
          // them pending on purpose, so the second pass is a real retry.)
          setAsked([]);
        } catch {
          /* cast anyway; she asks again next time */
        } finally {
          savingRef.current = false;
          goLine('which');
        }
      })();
    },
    [askIdx, asked, goLine],
  );

  const leftRef = useRef(false);
  const leave = useCallback(
    (to: 'home' | 'awaken') => {
      if (leftRef.current) return;
      leftRef.current = true;
      setPhase({ k: 'fade' });
      setTimeout(() => navigate({ kind: to }), 700);
    },
    [navigate],
  );

  // Success hands off to the reveal, but never before the field has left:
  // cutting from the meadow straight to "meet <name>" would drop the walk-off
  // the whole beat is built on. (A cast this fast is not realistic today; it
  // is one line to be sure of anyway.)
  useEffect(() => {
    if (!cast.characterId || phase.k !== 'casting' || leftRef.current) return;
    leftRef.current = true;
    const id = cast.characterId;
    void useDataStore
      .getState()
      .loadCharacters()
      .catch(() => {
        /* the reveal screen re-fetches the character on its own */
      });
    navigate({ kind: 'unique-reveal', characterId: id });
  }, [cast.characterId, phase.k, navigate]);

  // ── Line rendering ─────────────────────────────────────────────────────
  const line = phase.k === 'line' ? phase.id : null;
  const lineText = line ? tt(line === 'ready' ? readyLine.text : SCRIPT[line]) : '';
  const tw = useTypewriter(lineText);
  useSuiVoice(line ? (line === 'ready' ? readyLine.clip : CLIP[line]) : null, volume);

  useEffect(() => {
    if (!line) return;
    setSui(tw.done || tw.paused ? 'idle' : 'talking');
  }, [line, tw.done, tw.paused]);

  // "Got it. Let me go get them!" is a send-off, not a prompt: it leaves on its
  // own a beat after the line lands. A click still skips ahead.
  useEffect(() => {
    if (line !== 'gotIt' || !tw.done) return undefined;
    const timer = setTimeout(walkOff, 1100);
    return () => clearTimeout(timer);
  }, [line, tw.done, walkOff]);

  // "Before that..." is a warning, not a question, and it is the one line here
  // that carries no controls of its own — so it rolls into the first question
  // by itself rather than sitting on screen waiting for a click nothing on it
  // suggests. (A click still skips the beat; see clickAdvances.)
  useEffect(() => {
    if (line !== 'needQs' || !tw.done || asked.length === 0) return undefined;
    const timer = setTimeout(() => goLine(QUESTION_LINE[asked[askIdx]]), 900);
    return () => clearTimeout(timer);
  }, [line, tw.done, asked, askIdx, goLine]);

  const advance = useCallback(() => {
    if (!line) return;
    if (!tw.done) {
      tw.skip();
      return;
    }
    if (line === 'ready') beginAsk();
    else if (line === 'needQs') goLine(QUESTION_LINE[asked[askIdx]]);
    else if (line === 'gotIt') walkOff();
  }, [line, tw, beginAsk, goLine, asked, askIdx, walkOff]);

  useEnterAdvances(advance);

  // The greeting is a question with two buttons now, so a click anywhere may
  // only finish the typewriter — answering it has to be deliberate. Enter
  // still takes the affirmative, the way it did when that was the only way on.
  // "Before that..." carries no controls, so it advances on a click like any
  // other text-only line.
  const clickAdvances = line === 'gotIt' || line === 'needQs';

  /** The pickers for whichever gap is being asked. Back walks the questions in
   * reverse and, from the first one, all the way out to the greeting, where
   * "Not yet" is still on offer. */
  const questionControls = ((): React.ReactNode => {
    if (!line || !(line === 'qAge' || line === 'qDyn' || line === 'qArt')) return null;
    const back = (): void => {
      if (askIdx === 0) {
        goLine('ready');
        return;
      }
      setAskIdx(askIdx - 1);
      goLine(QUESTION_LINE[asked[askIdx - 1]]);
    };
    switch (line) {
      case 'qAge':
        return (
          <PillPicker
            options={AGE_OPTIONS}
            onPick={(value) => answer('companion_age_range', value)}
            onBack={back}
          />
        );
      case 'qDyn':
        return (
          <DynPicker
            initial={null}
            // [] is the explicit "Surprise me" (vs null = never asked).
            onDone={(picked) => answer('companion_dynamics', picked)}
            onBack={back}
          />
        );
      case 'qArt':
        return <ArtPicker onPick={(value) => answer('art_style', value)} onBack={back} />;
    }
  })();

  return (
    <div className={styles.root}>
      <CornerControls
        prefs={voicePrefs}
        onPrefs={setVoicePrefs}
        // Backing out is only offered while nothing is being cast — once the
        // pipeline is running, a half-finished companion is not something to
        // walk away from mid-stride. (The cast's own error panel still has a
        // Back, which is the one exit that stage needs.)
        onClose={() => leave('awaken')}
        closeHidden={gender !== null}
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
            {tw.done && line === 'ready' ? (
              <PillPicker
                options={READY_OPTIONS}
                onPick={(value) => (value === 'yes' ? beginAsk() : leave('awaken'))}
              />
            ) : null}
            {tw.done ? questionControls : null}
            {tw.done && line === 'which' ? (
              <PillPicker
                options={GENDER_OPTIONS}
                onPick={(value) => {
                  // Start the cast here, so the walk-off runs over real work.
                  setGender(value);
                  goLine('gotIt');
                }}
                onBack={() => goLine('ready')}
              />
            ) : null}
          </div>
        ) : null}

        {phase.k === 'casting' ? (
          cast.errCode ? (
            <div className={styles.panel}>
              <p className={styles.panelText}>{tt(CAST_ERROR_COPY[cast.errCode].title)}</p>
              <p className={styles.panelNote}>{tt(CAST_ERROR_COPY[cast.errCode].body)}</p>
              {cast.errDetail ? (
                <p className={styles.panelNote} title={cast.errDetail}>
                  {cast.errDetail.length > 200 ? `${cast.errDetail.slice(0, 200)}…` : cast.errDetail}
                </p>
              ) : null}
              <button className={`${styles.pill} ${styles.pillWide}`} onClick={cast.retry}>
                {tt('Try again')}
              </button>
              <button className={styles.quietLink} onClick={() => leave('home')}>
                {tt('Back')}
              </button>
            </div>
          ) : (
            <div className={styles.setupWrap}>
              <img
                className={styles.setupLogo}
                src="./img/sei-text.png"
                alt="Sei"
                draggable={false}
              />
              <div className={`${styles.progress} ${styles.progressBig}`}>
                <div className={styles.progressFillDet} style={{ width: `${cast.pct}%` }} />
              </div>
              <p className={styles.panelText} aria-live="polite">
                {tt(STAGE_COPY[cast.stage])}
              </p>
              {cast.portraitFailed ? (
                <p className={styles.panelNote}>
                  {tt('Image generation failed. Continuing without a portrait.')}
                </p>
              ) : cast.skinFailed ? (
                <p className={styles.panelNote}>
                  {tt('Skin generation failed. Continuing with the default skin.')}
                </p>
              ) : null}
            </div>
          )
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
