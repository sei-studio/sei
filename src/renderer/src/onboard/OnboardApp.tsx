/**
 * OnboardApp — the first-run ritual (260728), rendered as a full-window view
 * inside the normal app window (view kind 'onboard' in App.tsx).
 *
 * Sui is the mascot: she walks into a hand-drawn scene, runs the whole setup
 * as a conversation (name, the companion questionnaire reworded as her
 * questions), "forgets" the third question, panics, and walks off to let the
 * player sign in while character generation runs in the background. The scene
 * returns for a send-off and fades out; `onComplete` hands App the tutorial
 * decision.
 *
 * Flow branches:
 *   returning  → sign-in only → complete, no tutorial
 *   new+cloud  → questionnaire → sign up → ToS → generation → full tutorial
 *   new+local  → questionnaire → "continue locally" → provider+key → reduced
 *   skip       → no questionnaire/generation → reduced tutorial
 *   generation failure is silent: reduced tutorial (spec: "see 18").
 *   new branch, but the sign-in lands on an EXISTING account (the "I already
 *   have an account" form, or Google into an old account) → "welcome back"
 *   notice, then complete as returning: no config write, no generation, no
 *   tutorial (260729).
 *
 * This surface deliberately has NO theme — one fixed light look — and no
 * window chrome: it hides the macOS traffic lights while mounted
 * (windowSetButtonsVisible) and never mounts MacosWindow's drag strip or
 * version tag; a transparent top strip keeps the window draggable. The scene
 * art (1500x1000 layers + the Sui sprites) lives in a single fixed-aspect
 * stage that covers the window bottom-anchored, so the background and the
 * sprite always scale by the SAME factor and their line weights stay matched;
 * dialogue and the sign-in panel stay in window coordinates at full size.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { OnboardScene, type SuiPose } from './OnboardScene';
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import type { AuthState, UniqueGender } from '@shared/ipc';
import type { UserConfig, UserPreferences } from '@shared/characterSchema';
import chibiF from '../assets/art-styles/chibi-female.jpg';
import chibiM from '../assets/art-styles/chibi-male.jpg';
import animeF from '../assets/art-styles/anime-female.jpg';
import animeM from '../assets/art-styles/anime-male.jpg';
import celF from '../assets/art-styles/celshaded-female.jpg';
import celM from '../assets/art-styles/celshaded-male.jpg';
import cartoonF from '../assets/art-styles/cartoon-female.jpg';
import cartoonM from '../assets/art-styles/cartoon-male.jpg';
import threeDF from '../assets/art-styles/3d-female.jpg';
import threeDM from '../assets/art-styles/3d-male.jpg';
import styles from './onboard.module.css';

type AgeRange = NonNullable<UserPreferences['companion_age_range']>;
type ArtStyle = NonNullable<UserPreferences['art_style']>;
type Dynamic = NonNullable<UserPreferences['companion_dynamics']>[number];

/* ── Script ──────────────────────────────────────────────────────────────── */

type LineId =
  | 'hey'
  | 'runPlace'
  | 'newQ'
  | 'welcomeBack'
  | 'nameQ'
  | 'iSee'
  | 'job'
  | 'skipConfirm'
  | 'fiveQs'
  | 'qDyn'
  | 'qAge'
  | 'qArt'
  | 'qGender'
  | 'allDone'
  | 'dots'
  | 'ahh'
  | 'skippedThird'
  | 'ready';

const SCRIPT: Record<LineId, string> = {
  hey: "Hey. I'm Sui!",
  runPlace: 'I run this place. The Sei terminal, I mean.',
  newQ: 'Hmmmm... Are you new here?',
  welcomeBack: "Ah, welcome back. I'm not needed here then. Back to gaming I go!",
  nameQ: "So! My name's Sui. What do I call you?",
  iSee: 'I see I see... {name}!',
  job: 'So, {name}, my job here is to help you meet other AI friends from my world.',
  skipConfirm: 'Aww, really? I was going to find a companion just for you. You wanna skip it?',
  fiveQs:
    'The terminal says I need five quick answers from you. It uses them to pick who you meet first, so be honest with me okay?',
  qDyn: 'First! What kind of people do you like having around? Pick as many as you want. Order matters.',
  qAge: "Oooh, noted. Second, we AI can live for a very long time. Which age range best fits what you're looking for?",
  qArt: 'Ok, um, fourth. Take a look at these portraits. Which one do you like the most?',
  qGender: 'Last one! Let me pull up the options... which do you prefer?',
  allDone: "Aaaand we're done! By the way, you can always change these later in the app.",
  dots: '..',
  ahh: 'AHHHHH!',
  skippedThird:
    "I SKIPPED THE THIRD QUESTION! You still need to sign in! Ok, I'll go set things up for you while you do that.",
  ready: 'Welcome back! Everything is in place. You ready?',
};

const DYN_OPTIONS: Array<{ value: Dynamic; label: string }> = [
  { value: 'partner-in-crime', label: 'A partner in crime' },
  { value: 'caretaker', label: 'Someone to look after me' },
  { value: 'protege', label: 'Someone to look after' },
  { value: 'chill-friend', label: 'A chill friend' },
  { value: 'challenger', label: 'Someone who pushes me' },
];
const AGE_OPTIONS: Array<{ value: AgeRange; label: string }> = [
  { value: 'young-adult', label: 'Young adult' },
  { value: 'adult', label: 'Adult' },
  { value: 'mature', label: 'Mature' },
  { value: 'elder', label: 'Elder' },
  { value: 'timeless', label: 'Timeless' },
];
const ART_OPTIONS: Array<{ value: ArtStyle; label: string; imgs: [string, string] }> = [
  { value: 'chibi', label: 'Round chibi', imgs: [chibiF, chibiM] },
  { value: 'anime', label: 'Anime', imgs: [animeF, animeM] },
  { value: 'celshaded', label: 'Cel-shaded', imgs: [celF, celM] },
  { value: 'cartoon', label: 'Cartoon', imgs: [cartoonF, cartoonM] },
  { value: '3d', label: '3D', imgs: [threeDF, threeDM] },
];
/** Text-only lines (no controls, advance on click/Enter) that get the idle
 * continue hint after 5s without input. 'ahh' auto-advances and 'ready' has a
 * button, so neither belongs here. */
const HINT_LINES: LineId[] = [
  'hey',
  'runPlace',
  'welcomeBack',
  'iSee',
  'fiveQs',
  'allDone',
  'dots',
  'skippedThird',
];

const GENDER_OPTIONS: Array<{ value: UniqueGender; label: string }> = [
  { value: 'female', label: 'Feminine' },
  { value: 'male', label: 'Masculine' },
  { value: 'other', label: 'Androgynous' },
];

/* ── Machine ─────────────────────────────────────────────────────────────── */

type Phase =
  | { k: 'intro' } // ground slides in, Sui walks in
  | { k: 'line'; id: LineId }
  | { k: 'walkoff'; to: 'auth-new' | 'auth-returning' } // Sui leaves, then ground leaves
  | { k: 'auth'; mode: 'new' | 'returning' }
  | { k: 'local-setup' }
  | { k: 'setup' } // "setting up..." — config save + generation
  | { k: 'welcome-existing' } // new-user branch signed into an EXISTING account
  | { k: 'return' } // ground + Sui come back for the send-off
  | { k: 'fade'; done?: boolean };

interface Answers {
  dynamics: Dynamic[];
  age: AgeRange | null;
  art: ArtStyle | null;
  gender: UniqueGender;
  skipCreation: boolean;
  returning: boolean;
}

const CHAR_MS = 24;
// Breath at the end of a sentence (260729). `paused` is exposed so the talk
// flap can close the mouth for the beat instead of flapping through it.
const FULL_STOP_PAUSE_MS = 340;

/** Typewriter — chars appear over time; skip() completes instantly. */
function useTypewriter(text: string): {
  shown: string;
  done: boolean;
  paused: boolean;
  skip: () => void;
} {
  const [n, setN] = useState(0);
  const [paused, setPaused] = useState(false);
  const skipRef = useRef(false);
  // Render-phase reset: when the line changes, `n` still holds the previous
  // line's count until an effect runs, and slicing the NEW text by the OLD
  // count flashed the whole next line for one frame (260729). Resetting
  // during render (the sanctioned derive-from-props pattern) means no commit
  // ever renders the new text with the stale count.
  const prevTextRef = useRef(text);
  if (prevTextRef.current !== text) {
    prevTextRef.current = text;
    setN(0);
    setPaused(false);
  }
  useEffect(() => {
    skipRef.current = false;
    setN(0);
    setPaused(false);
    if (text.length === 0) return undefined;
    let i = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const step = (): void => {
      if (skipRef.current) return;
      i += 1;
      setN(i);
      if (i >= text.length) {
        setPaused(false);
        return;
      }
      // The pause lands after a sentence-ending stop that has a word after it
      // (mid-ellipsis dots don't qualify: only the one before the space does).
      const atStop = '.!?'.includes(text[i - 1]) && text[i] === ' ';
      setPaused(atStop);
      t = setTimeout(step, atStop ? FULL_STOP_PAUSE_MS : CHAR_MS);
    };
    t = setTimeout(step, CHAR_MS);
    return () => {
      if (t) clearTimeout(t);
    };
  }, [text]);
  return {
    shown: text.slice(0, n),
    done: n >= text.length,
    paused,
    skip: () => {
      skipRef.current = true;
      setPaused(false);
      setN(text.length);
    },
  };
}

export interface OnboardResult {
  /** False → returning user: straight to Home, no tutorial. */
  tutorial: boolean;
  /** Companion for the full tutorial; null → reduced (home-only) tutorial. */
  characterId: string | null;
}

export interface OnboardAppProps {
  onComplete: (result: OnboardResult) => void;
  /** Mount directly at the returning sign-in panel (empty sky, no Sui, no
   * dialogue). The boot route for signed-out-but-onboarded profiles uses
   * this so a routine launch is one click, not a cutscene. Constant for the
   * component's lifetime. */
  startAtSignIn?: boolean;
  /** startAtSignIn only: "I'm new here" — remount as the full scene so a new
   * person on this machine can reach account creation. */
  onStartFresh?: () => void;
}

export function OnboardApp({
  onComplete,
  startAtSignIn,
  onStartFresh,
}: OnboardAppProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>(
    startAtSignIn ? { k: 'auth', mode: 'returning' } : { k: 'intro' },
  );

  // No window chrome while the scene runs: hide the mac traffic lights on
  // mount, restore on unmount (no-op on Windows/Linux).
  useEffect(() => {
    void sei.windowSetButtonsVisible(false).catch(() => {});
    return () => {
      void sei.windowSetButtonsVisible(true).catch(() => {});
    };
  }, []);
  const [groundIn, setGroundIn] = useState(false);
  const [sui, setSui] = useState<SuiPose>('hidden');
  const [name, setName] = useState('');
  const answersRef = useRef<Answers>({
    dynamics: [],
    age: null,
    art: null,
    gender: 'other',
    skipCreation: false,
    // startAtSignIn IS the returning branch, just without the walk-in.
    returning: startAtSignIn === true,
  });

  // ── Auth plumbing ──────────────────────────────────────────────────────
  const authRef = useRef<AuthState>({ kind: 'local' });
  const scopeReadyRef = useRef(false);
  /** How the session that's about to land was initiated, set by AuthPanel at
   * each attempt. Distinguishes an existing-account sign-in from a fresh
   * sign-up on the NEW branch, where `mode` alone can't tell (260729). Null =
   * no panel interaction (e.g. a session restored at boot mid-onboarding). */
  const authIntentRef = useRef<'signup' | 'signin' | 'oauth' | null>(null);
  const [authTick, setAuthTick] = useState(0); // re-render on auth pushes
  useEffect(() => {
    const offAuth = sei.onAuthState((s) => {
      authRef.current = s;
      setAuthTick((t) => t + 1);
    });
    const offScope = sei.onScopeChanged((ev) => {
      if (ev.reason === 'sign-in') {
        scopeReadyRef.current = true;
        setAuthTick((t) => t + 1);
      }
    });
    return () => {
      offAuth();
      offScope();
    };
  }, []);

  // ── Scene choreography ─────────────────────────────────────────────────
  useEffect(() => {
    // startAtSignIn mounts on the empty sky (the state the normal flow is in
    // once Sui has walked off) — no ground, no walk-in.
    if (startAtSignIn) return undefined;
    // Mount: let the sky paint, then slide the ground in.
    const t = setTimeout(() => setGroundIn(true), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- constant prop
  }, []);

  const onGroundIn = useCallback(() => {
    setSui('entering');
  }, []);
  const onSuiEntered = useCallback(() => {
    setSui('idle');
    // A beat of her just standing there before she speaks — walking in and
    // talking in the same instant read as rushed (260729).
    window.setTimeout(() => {
      setPhase((p) => {
        if (p.k === 'intro') return { k: 'line', id: 'hey' };
        if (p.k === 'return') return { k: 'line', id: 'ready' };
        return p;
      });
    }, 1000);
  }, []);
  const onSuiLeft = useCallback(() => {
    setSui('hidden');
    setGroundIn(false);
  }, []);
  const onGroundOut = useCallback(() => {
    setPhase((p) =>
      p.k === 'walkoff' ? { k: 'auth', mode: p.to === 'auth-returning' ? 'returning' : 'new' } : p,
    );
  }, []);

  // ── Line advance logic ─────────────────────────────────────────────────
  const goLine = useCallback((id: LineId) => setPhase({ k: 'line', id }), []);

  const walkOff = useCallback((to: 'auth-new' | 'auth-returning') => {
    setPhase({ k: 'walkoff', to });
    setSui('leaving');
  }, []);

  /** "I'm new here" from the full scene's returning sign-in panel: replay the
   * walk-in and run the new-user branch. (The signin-variant mount gets the
   * App-level onStartFresh remount instead.) */
  const startFresh = useCallback(() => {
    answersRef.current.returning = false;
    setPhase({ k: 'intro' });
    setGroundIn(true);
  }, []);

  /** Fade + hand off to App. Fires exactly once. */
  const completedRef = useRef(false);
  const complete = useCallback(
    (tutorial: boolean, characterId: string | null) => {
      if (completedRef.current) return;
      completedRef.current = true;
      setPhase({ k: 'fade' });
      setTimeout(() => onComplete({ tutorial, characterId }), 950);
    },
    [onComplete],
  );

  // ── Setup pipeline (cloud path) ────────────────────────────────────────
  const [setupError, setSetupError] = useState<string | null>(null);
  const genCharacterIdRef = useRef<string | null>(null);
  const setupRunRef = useRef(0);

  const buildConfig = useCallback(
    (backend: 'cloud-proxy' | 'local', provider: UserConfig['provider'] = 'anthropic') => ({
      mc_username: '',
      preferred_name: name.trim(),
      profile_picture: null,
      background_image: null,
      provider,
      provider_config: {},
      theme_mode: 'system' as const,
      linuxBasicTextWarnDismissed: false,
      ai_backend_kind: backend,
      ai_backend_kind_source: 'default' as const,
      dev_console_visible: false,
      advanced_updates: false,
      realistic_typing: true,
      call_captions: false,
      removed_default_ids: [],
      added_default_ids: [],
      added_world_ids: [],
      user_profile: {
        companion_age_range: null,
        art_style: null,
        companion_dynamics: null,
        completed_at: null,
      },
      dynamics_granted: [],
      chat_panel_hidden: false,
      // The tutorial replaces the old one-time Home greeting.
      has_been_welcomed: true,
      vision_mode: 'on-demand' as const,
      total_playtime_ms: 0,
      total_playtime_backfilled: true,
      call_overlay_enabled: false,
      call_convo_starters: true,
      added_defaults_backfilled: true,
      defaults_to_world_migrated: true,
      feedback_reward_claimed: false,
      skin_setup_pending: false,
    }),
    [name],
  );

  const runCloudSetup = useCallback(async () => {
    const run = ++setupRunRef.current;
    setSetupError(null);
    const a = answersRef.current;
    try {
      await sei.saveConfig(buildConfig('cloud-proxy'));
      if (!a.skipCreation) {
        await sei.prefsSave({
          companion_age_range: a.age,
          art_style: a.art,
          companion_dynamics: a.dynamics,
        });
      }
      // Sui joins the party — best-effort, never blocks onboarding.
      void sei
        .charsAddToLibrary(DEFAULT_CHARACTER_UUIDS.sui)
        .catch(() => {});
      let characterId: string | null = null;
      if (!a.skipCreation) {
        try {
          const res = await sei.generateUnique({
            requestId: crypto.randomUUID(),
            gender: a.gender,
          });
          if (res.ok) characterId = res.characterId;
        } catch {
          // Generation failure is silent — reduced tutorial (spec step 18).
        }
      }
      if (run !== setupRunRef.current) return;
      genCharacterIdRef.current = characterId;
      sei.track('onboarding_completed');
      setPhase({ k: 'return' });
      setGroundIn(true);
    } catch (err) {
      if (run !== setupRunRef.current) return;
      setSetupError((err as Error).message || 'Something went wrong.');
    }
  }, [buildConfig]);

  useEffect(() => {
    if (phase.k === 'setup') void runCloudSetup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k]);

  // Existing-account greeting: hold long enough to read, then hand off as a
  // returning user (straight to Home, no tutorial, nothing written).
  useEffect(() => {
    if (phase.k !== 'welcome-existing') return undefined;
    const t = setTimeout(() => complete(false, null), 2400);
    return () => clearTimeout(t);
  }, [phase.k, complete]);

  // Re-entering the scene for the send-off: ground slides in → Sui walks in
  // (onGroundIn/onSuiEntered above route 'return' to the 'ready' line).
  useEffect(() => {
    if (phase.k === 'return' && !groundIn) setGroundIn(true);
  }, [phase.k, groundIn]);

  // ── Talking pose follows the typewriter ────────────────────────────────
  const line = phase.k === 'line' ? phase.id : null;
  // Display text: the 'ready' line has a variant for when a companion was
  // generated, and {name} placeholders render as the entered name (the name
  // is fixed before iSee/job render, so the typewriter never restarts
  // mid-line).
  const lineText = (
    line === 'ready'
      ? genCharacterIdRef.current
        ? "Welcome back! Everything is all set, and someone's waiting to meet you. You ready?"
        : SCRIPT.ready
      : line
        ? SCRIPT[line]
        : ''
  ).replaceAll('{name}', name.trim());
  const tw = useTypewriter(lineText);
  useEffect(() => {
    if (!line) return;
    // The panic sequence holds the shock face straight through the
    // "I skipped the third question!" line — flipping back to the talk flap
    // there undercut the whole beat (260729).
    if (line === 'ahh' || line === 'skippedThird') {
      setSui('shock');
      return;
    }
    if (line === 'dots') {
      setSui('idle');
      return;
    }
    // Mouth closes during the full-stop breath, matching the typewriter.
    setSui(tw.done || tw.paused ? 'idle' : 'talking');
  }, [line, tw.done, tw.paused]);

  // Auto-advance the panic beat: '..' waits for input; 'AHHHHH!' advances
  // itself after a beat of shock.
  useEffect(() => {
    if (line !== 'ahh') return;
    const t = setTimeout(() => goLine('skippedThird'), 1200);
    return () => clearTimeout(t);
  }, [line, goLine]);

  // Continue nudge: on the very first line it fades in right after the text
  // finishes (a first-time player doesn't know clicking advances); on every
  // other text-only line it is an idle hint after 5s without input.
  const [hintOn, setHintOn] = useState(false);
  useEffect(() => {
    setHintOn(false);
    if (!line || !tw.done) return undefined;
    if (!HINT_LINES.includes(line)) return undefined;
    const t = setTimeout(() => setHintOn(true), line === 'hey' ? 250 : 5000);
    return () => clearTimeout(t);
  }, [line, tw.done]);

  // ── Advance handlers ───────────────────────────────────────────────────
  const advance = useCallback(() => {
    if (!line) return;
    if (!tw.done) {
      tw.skip();
      return;
    }
    switch (line) {
      case 'hey':
        goLine('runPlace');
        break;
      case 'runPlace':
        goLine('newQ');
        break;
      case 'welcomeBack':
        walkOff('auth-returning');
        break;
      case 'nameQ':
        if (name.trim()) goLine('iSee');
        break;
      case 'iSee':
        goLine('job');
        break;
      case 'job':
        goLine('fiveQs');
        break;
      case 'fiveQs':
        goLine('qDyn');
        break;
      case 'allDone':
        goLine('dots');
        break;
      case 'dots':
        goLine('ahh');
        break;
      case 'skippedThird':
        walkOff('auth-new');
        break;
      case 'ready':
        complete(
          true,
          genCharacterIdRef.current,
        );
        break;
      default:
        break;
    }
  }, [line, tw, name, goLine, walkOff, complete]);

  // Enter advances any line that advances on click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return;
      const target = e.target as HTMLElement | null;
      // Let form fields own Enter (auth panel, name input handles its own).
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON')) return;
      advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance]);

  // ── Auth phase: already signed in? (relaunch mid-onboarding) ───────────
  useEffect(() => {
    if (phase.k !== 'auth') return;
    if (authRef.current.kind === 'signed_in' && phase.mode === 'new') {
      // Session restored at boot — no scope switch will fire; treat as ready.
      scopeReadyRef.current = true;
      void proceedAfterAuth(phase.mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k]);

  /** New branch only: did the session that just landed belong to an account
   * that already existed? A password sign-in is definitive (the panel was in
   * "I already have an account" mode). OAuth can be either, so fall back to
   * the account's age: Supabase creates the user at the moment of a first
   * Google sign-in, so an account older than a few minutes is a returning
   * one. A 'signup' intent (even with an email-verification delay) and a
   * boot-restored session (null intent, relaunch mid-onboarding) are new. */
  const signedIntoExistingAccount = useCallback((): boolean => {
    const a = authRef.current;
    if (a.kind !== 'signed_in') return false;
    const intent = authIntentRef.current;
    if (intent === 'signin') return true;
    if (intent === 'oauth') {
      const ageMs = Date.now() - Date.parse(a.user.createdAt);
      return Number.isFinite(ageMs) && ageMs > 5 * 60_000;
    }
    return false;
  }, []);

  /** Post-auth continuation: ToS gate, then setup (new) or done (returning). */
  const [needsTos, setNeedsTos] = useState(false);
  const proceedingRef = useRef(false);
  const proceedAfterAuth = useCallback(
    async (mode: 'new' | 'returning') => {
      if (proceedingRef.current) return;
      proceedingRef.current = true;
      try {
        try {
          const tos = await sei.tosStatus();
          // null = check unavailable (offline) — proceed; the normal window's
          // blocking AcceptToSModal re-asks. Only a definite false blocks here.
          if (tos.accepted === false) {
            setNeedsTos(true);
            return; // the ToS panel's Agree button re-enters below
          }
        } catch {
          /* offline ToS check: let the normal window's gate re-ask */
        }
        if (mode === 'returning') {
          complete(false, null);
        } else if (signedIntoExistingAccount()) {
          // They walked the new-user branch but signed into an account that
          // already exists. Running setup here would clobber the profile's
          // config and mint a new character on the account (260729) — greet
          // them instead and route as returning.
          setPhase({ k: 'welcome-existing' });
        } else {
          setPhase({ k: 'setup' });
        }
      } finally {
        proceedingRef.current = false;
      }
    },
    [complete, signedIntoExistingAccount],
  );

  const agreeTos = useCallback(async () => {
    try {
      await sei.tosAccept();
    } catch {
      /* recorded again by the normal window's gate if this failed */
    }
    setNeedsTos(false);
    const mode = phase.k === 'auth' ? phase.mode : 'new';
    if (mode === 'returning') complete(false, null);
    else if (signedIntoExistingAccount()) setPhase({ k: 'welcome-existing' });
    else setPhase({ k: 'setup' });
  }, [phase, complete, signedIntoExistingAccount]);

  // Watch for the sign-in to land while the auth panel is up.
  useEffect(() => {
    if (phase.k !== 'auth') return;
    if (authRef.current.kind === 'signed_in' && scopeReadyRef.current) {
      void proceedAfterAuth(phase.mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authTick, phase.k]);

  // ── Local path completion ──────────────────────────────────────────────
  const finishLocalSetup = useCallback(async (provider: string, apiKey: string) => {
    await sei.saveConfig(buildConfig('local', provider as UserConfig['provider']));
    await sei.saveApiKey(apiKey.trim());
    void sei.charsAddToLibrary(DEFAULT_CHARACTER_UUIDS.sui).catch(() => {});
    sei.track('onboarding_completed');
    genCharacterIdRef.current = null;
    setPhase({ k: 'return' });
    setGroundIn(true);
  }, [buildConfig]);

  // ── Render ─────────────────────────────────────────────────────────────
  const showDialogue = phase.k === 'line';
  const clickAdvances =
    line !== null &&
    !['newQ', 'nameQ', 'job', 'skipConfirm', 'qDyn', 'qAge', 'qArt', 'qGender', 'ahh'].includes(line);

  return (
    <div className={styles.root}>
      <div
        className={styles.card}
        onClick={clickAdvances ? advance : line && !tw.done ? tw.skip : undefined}
      >
        <div className={styles.dragStrip} />
        <OnboardScene
          groundIn={groundIn}
          sui={sui}
          onGroundIn={onGroundIn}
          onGroundOut={onGroundOut}
          onSuiEntered={onSuiEntered}
          onSuiLeft={onSuiLeft}
        />

        {showDialogue && line ? (
          <div className={styles.dialogue}>
            <p className={line === 'ahh' ? `${styles.lineText} ${styles.lineShout}` : styles.lineText}>
              {tw.shown}
              {!tw.done ? <span className={styles.caret} /> : null}
            </p>
            {hintOn && tw.done ? (
              <div className={styles.continueHint}>
                <MouseIcon /> or <span className={styles.hintGlyph}>&#x21B5;</span> to continue
              </div>
            ) : null}
            {tw.done ? <LineControls
              line={line}
              name={name}
              setName={setName}
              answersRef={answersRef}
              goLine={goLine}
              advance={advance}
              walkOff={walkOff}
            /> : null}
          </div>
        ) : null}

        {phase.k === 'auth' ? (
          <AuthPanel
            mode={phase.mode}
            needsTos={needsTos}
            onIntent={(i) => {
              authIntentRef.current = i;
            }}
            onStartFresh={
              // The App-level prop remounts the FULL scene — only meaningful
              // from the signin-variant mount (different key). From within the
              // full scene the view/key wouldn't change, so replay in place.
              phase.mode === 'returning'
                ? startAtSignIn
                  ? onStartFresh
                  : startFresh
                : undefined
            }
            onAgreeTos={() => void agreeTos()}
            onLocal={() => {
              if (phase.mode === 'returning') {
                // A returning local player needs no re-setup; the normal
                // window routes them (home, or legacy onboarding if their
                // profile is incomplete).
                complete(false, null);
              } else {
                answersRef.current.skipCreation = answersRef.current.skipCreation || false;
                setPhase({ k: 'local-setup' });
              }
            }}
          />
        ) : null}

        {phase.k === 'local-setup' ? (
          <LocalSetupPanel onDone={(prov, key) => void finishLocalSetup(prov, key)} />
        ) : null}

        {phase.k === 'welcome-existing' ? (
          <div className={styles.panel}>
            <p className={styles.panelText}>
              Welcome back! You already have an account with this login. Signing you in...
            </p>
          </div>
        ) : null}

        {phase.k === 'setup' ? (
          setupError ? (
            <div className={styles.panel}>
              <p className={styles.panelText}>{setupError}</p>
              <button className={styles.pill} onClick={() => void runCloudSetup()}>
                Try again
              </button>
            </div>
          ) : (
            /* Boxless setup state (260729): big white wordmark over a larger
               progress bar, sitting below center, caption underneath. */
            <div className={styles.setupWrap}>
              <img
                className={styles.setupLogo}
                src="./img/sei-text.png"
                alt="Sei"
                draggable={false}
              />
              <div className={`${styles.progress} ${styles.progressBig}`}>
                <div className={styles.progressFill} />
              </div>
              <p className={styles.panelText}>Setting up...</p>
            </div>
          )
        ) : null}

        <button
          className={styles.closeBtn}
          aria-label="Quit Sei"
          onClick={(e) => {
            e.stopPropagation();
            void sei.windowClose();
          }}
        >
          ×
        </button>

        <div className={phase.k === 'fade' ? `${styles.fade} ${styles.fadeOn} ${fadeThemeClass()}` : styles.fade} />
      </div>
    </div>
  );
}

function fadeThemeClass(): string {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? styles.fadeDark : styles.fadeLight;
}

/** The "click" half of the continue hint: a mouse with the left button shaded. */
function MouseIcon(): React.ReactElement {
  return (
    <svg className={styles.hintMouse} viewBox="0 0 16 22" aria-label="Click">
      <rect x="1" y="1" width="14" height="20" rx="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1 A7 7 0 0 0 1 8 L 8 8 Z" fill="currentColor" />
      <line x1="8" y1="1" x2="8" y2="8" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/* ── Per-line controls ───────────────────────────────────────────────────── */

interface LineControlsProps {
  line: LineId;
  name: string;
  setName: (v: string) => void;
  answersRef: React.MutableRefObject<Answers>;
  goLine: (id: LineId) => void;
  advance: () => void;
  walkOff: (to: 'auth-new' | 'auth-returning') => void;
}

function LineControls(props: LineControlsProps): React.ReactElement | null {
  const { line, name, setName, answersRef, goLine, advance, walkOff } = props;

  switch (line) {
    case 'newQ':
      return (
        <div className={styles.choices}>
          <button className={styles.pill} onClick={() => goLine('nameQ')}>
            Yep
          </button>
          <button
            className={styles.pill}
            onClick={() => {
              answersRef.current.returning = true;
              goLine('welcomeBack');
            }}
          >
            Nah
          </button>
          <button className={styles.quietLink} onClick={() => goLine('runPlace')}>
            Back
          </button>
        </div>
      );
    case 'nameQ':
      return (
        <div className={styles.choices}>
          <input
            className={styles.nameInput}
            value={name}
            autoFocus
            placeholder="Your name"
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) goLine('iSee');
            }}
            aria-label="Your name"
          />
          <button className={styles.quietLink} onClick={() => goLine('newQ')}>
            Back
          </button>
        </div>
      );
    case 'job':
      return (
        <div className={styles.choices}>
          <button className={styles.pill} onClick={advance}>
            Sounds fun
          </button>
          <button className={styles.quietLink} onClick={() => goLine('skipConfirm')}>
            Not interested
          </button>
        </div>
      );
    case 'skipConfirm':
      return (
        <div className={styles.choices}>
          <button
            className={styles.pill}
            onClick={() => {
              answersRef.current.skipCreation = true;
              walkOff('auth-new');
            }}
          >
            Skip
          </button>
          <button className={styles.pill} onClick={() => goLine('job')}>
            Nevermind
          </button>
        </div>
      );
    case 'qDyn':
      return (
        <DynPicker
          answersRef={answersRef}
          onDone={() => goLine('qAge')}
          onBack={() => goLine('fiveQs')}
        />
      );
    case 'qAge':
      return (
        <div className={styles.choices}>
          {AGE_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={styles.pill}
              onClick={() => {
                answersRef.current.age = o.value;
                goLine('qArt');
              }}
            >
              {o.label}
            </button>
          ))}
          <button className={styles.quietLink} onClick={() => goLine('qDyn')}>
            Back
          </button>
        </div>
      );
    case 'qArt':
      return (
        <div className={styles.choicesCol}>
          <div className={styles.artRow}>
            {ART_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={styles.artTile}
                aria-label={o.label}
                onClick={() => {
                  answersRef.current.art = o.value;
                  goLine('qGender');
                }}
              >
                <span className={styles.artImgs}>
                  <img src={o.imgs[0]} alt="" draggable={false} />
                  <img src={o.imgs[1]} alt="" draggable={false} />
                </span>
              </button>
            ))}
          </div>
          <button className={styles.quietLink} onClick={() => goLine('qAge')}>
            Back
          </button>
        </div>
      );
    case 'qGender':
      return (
        <div className={styles.choices}>
          {GENDER_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={styles.pill}
              onClick={() => {
                answersRef.current.gender = o.value;
                goLine('allDone');
              }}
            >
              {o.label}
            </button>
          ))}
          <button className={styles.quietLink} onClick={() => goLine('qArt')}>
            Back
          </button>
        </div>
      );
    case 'ready':
      return (
        <div className={styles.choices}>
          <button className={styles.pill} onClick={advance}>
            Let's go
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** Rank-by-click multi-select for the dynamics question. "Surprise me" is a
 * selectable state (mutually exclusive with the ranked picks), and BOTH paths
 * confirm through the same Done button — a single-click Surprise-me that
 * advanced instantly read as a misclick trap (260729). */
function DynPicker(props: {
  answersRef: React.MutableRefObject<Answers>;
  onDone: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [picked, setPicked] = useState<Dynamic[]>([]);
  const [surprise, setSurprise] = useState(false);
  const toggle = (v: Dynamic): void => {
    setSurprise(false);
    setPicked((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  };
  return (
    <div className={styles.choicesCol}>
      <div className={styles.choices}>
        {DYN_OPTIONS.map((o) => {
          const rank = picked.indexOf(o.value);
          return (
            <button
              key={o.value}
              className={rank >= 0 ? `${styles.pill} ${styles.pillPicked}` : styles.pill}
              onClick={() => toggle(o.value)}
            >
              {rank >= 0 ? <span className={styles.rankBadge}>{rank + 1}</span> : null}
              {o.label}
            </button>
          );
        })}
        <button
          className={surprise ? `${styles.pill} ${styles.pillPicked}` : styles.pill}
          onClick={() => {
            setSurprise((s) => !s);
            setPicked([]);
          }}
        >
          Surprise me
        </button>
      </div>
      <div className={styles.choices}>
        <button
          className={styles.pill}
          disabled={!surprise && picked.length === 0}
          onClick={() => {
            props.answersRef.current.dynamics = surprise ? [] : picked;
            props.onDone();
          }}
        >
          Done
        </button>
        <button className={styles.quietLink} onClick={props.onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

/* ── Auth panel ──────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Google's four-color G, per their sign-in branding assets. */
function GoogleG(): React.ReactElement {
  return (
    <svg className={styles.googleIcon} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function AuthPanel(props: {
  mode: 'new' | 'returning';
  needsTos: boolean;
  /** Reports how each auth attempt was initiated (sign-up form, sign-in form,
   * or Google) so the parent can tell an existing-account sign-in from a
   * fresh sign-up when the session lands. */
  onIntent: (intent: 'signup' | 'signin' | 'oauth') => void;
  onAgreeTos: () => void;
  onLocal: () => void;
  /** Returning panels only: "I'm new here" — replay the full Sui scene so a
   * new person can reach account creation (the returning panel deliberately
   * has no sign-up form). The boot signin variant remounts via App; the
   * in-scene returning panel replays the walk-in in place. */
  onStartFresh?: () => void;
}): React.ReactElement {
  const { mode, needsTos } = props;
  // New users create an account; returning users sign in. Both can toggle.
  const [signup, setSignup] = useState(mode === 'new');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const now = new Date();
  const [dobYear, setDobYear] = useState(0);
  const [dobMonth, setDobMonth] = useState(0);
  const [dobDay, setDobDay] = useState(0);
  const [tosChecked, setTosChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingVerify, setAwaitingVerify] = useState(false);
  const [oauth, setOauth] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);

  const years = useMemo(() => {
    const y = now.getFullYear();
    return Array.from({ length: 100 }, (_, i) => y - i);
  }, [now]);

  const canSubmit =
    email.trim() !== '' &&
    password !== '' &&
    !submitting &&
    (!signup || (dobYear > 0 && dobMonth > 0 && dobDay > 0 && tosChecked));

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    props.onIntent(signup ? 'signup' : 'signin');
    try {
      if (signup) {
        const res = await sei.signUpPassword({
          email: email.trim(),
          password,
          dobYear,
          dobMonth,
          dobDay,
        });
        if (!res.ok) setError(res.message);
        else if (res.requiresVerification) setAwaitingVerify(true);
        // A session lands via the auth push; OnboardApp proceeds from there.
      } else {
        const res = await sei.signInPassword({ email: email.trim(), password });
        if (!res.ok) setError(res.message);
      }
    } catch (err) {
      setError((err as Error).message || 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  if (needsTos) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>
          One more thing: the{' '}
          <a
            className={styles.panelLink}
            href="#tos"
            onClick={(e) => {
              e.preventDefault();
              void sei.openExternal('https://sei.gg/terms.html');
            }}
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a
            className={styles.panelLink}
            href="#privacy"
            onClick={(e) => {
              e.preventDefault();
              void sei.openExternal('https://sei.gg/privacy.html');
            }}
          >
            Privacy Policy
          </a>
          .
        </p>
        <button className={styles.pill} onClick={props.onAgreeTos}>
          I agree
        </button>
      </div>
    );
  }

  const resendEmail = async (): Promise<void> => {
    if (resendBusy) return;
    setResendBusy(true);
    setVerifyNote(null);
    try {
      // Pass the address explicitly: an unverified signup has no session, so
      // the handler's signed-in fallback cannot resolve it (260729).
      const res = await sei.resendVerification({ email: email.trim() });
      setVerifyNote(res.ok ? 'Sent. Give it a minute, and check spam too.' : res.message);
    } catch {
      setVerifyNote("Couldn't resend. Try again in a moment.");
    } finally {
      setResendBusy(false);
    }
  };

  const forgotPassword = async (): Promise<void> => {
    if (!email.trim()) {
      setError('Enter your email above first.');
      return;
    }
    setError(null);
    setResetNote(null);
    try {
      const res = await sei.sendPasswordReset({ email: email.trim() });
      setResetNote(res.ok ? 'Reset link sent. Check your email.' : res.message);
    } catch {
      setResetNote("Couldn't send the reset link. Try again in a moment.");
    }
  };

  if (awaitingVerify) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>
          Check your email to confirm your account. This continues on its own once you do.
        </p>
        <button
          className={`${styles.pill} ${styles.pillWide}`}
          disabled={resendBusy}
          onClick={() => void resendEmail()}
        >
          {resendBusy ? 'Sending...' : 'Resend email'}
        </button>
        {verifyNote ? <p className={styles.panelNote}>{verifyNote}</p> : null}
        <button className={styles.quietLink} onClick={() => setAwaitingVerify(false)}>
          Back
        </button>
      </div>
    );
  }

  if (oauth) return <GoogleWaitPanel onDone={() => setOauth(false)} />;

  return (
    <div className={styles.panel}>
      <img className={styles.panelLogo} src="./img/sei-text.png" alt="Sei" draggable={false} />
      <input
        className={styles.field}
        type="email"
        value={email}
        placeholder="Email"
        autoFocus
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Email"
      />
      <input
        className={styles.field}
        type="password"
        value={password}
        placeholder="Password"
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        aria-label="Password"
      />
      {!signup ? (
        <button
          className={styles.quietLink}
          disabled={submitting}
          onClick={() => void forgotPassword()}
        >
          Forgot password?
        </button>
      ) : null}
      {resetNote ? <p className={styles.panelNote}>{resetNote}</p> : null}
      {signup ? (
        <>
          <div className={styles.dobRow} aria-label="Birthday">
            <select
              className={styles.fieldSelect}
              value={dobMonth}
              onChange={(e) => setDobMonth(Number(e.target.value))}
              aria-label="Birth month"
            >
              <option value={0}>Month</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <select
              className={styles.fieldSelect}
              value={dobDay}
              onChange={(e) => setDobDay(Number(e.target.value))}
              aria-label="Birth day"
            >
              <option value={0}>Day</option>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              className={styles.fieldSelect}
              value={dobYear}
              onChange={(e) => setDobYear(Number(e.target.value))}
              aria-label="Birth year"
            >
              <option value={0}>Year</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <label className={styles.tosRow}>
            <input
              type="checkbox"
              checked={tosChecked}
              onChange={(e) => setTosChecked(e.target.checked)}
            />
            <span>
              I agree to the{' '}
              <a
                className={styles.panelLink}
                href="#tos"
                onClick={(e) => {
                  e.preventDefault();
                  void sei.openExternal('https://sei.gg/terms.html');
                }}
              >
                Terms
              </a>{' '}
              and{' '}
              <a
                className={styles.panelLink}
                href="#privacy"
                onClick={(e) => {
                  e.preventDefault();
                  void sei.openExternal('https://sei.gg/privacy.html');
                }}
              >
                Privacy Policy
              </a>
            </span>
          </label>
        </>
      ) : null}
      {error ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
      <button className={`${styles.pill} ${styles.pillWide}`} disabled={!canSubmit} onClick={() => void submit()}>
        {signup ? (submitting ? 'Creating account...' : 'Create account') : submitting ? 'Signing in...' : 'Sign in'}
      </button>
      <button
        className={styles.googleBtn}
        disabled={submitting}
        onClick={() => {
          setError(null);
          props.onIntent('oauth');
          setOauth(true);
        }}
      >
        <GoogleG />
        Continue with Google
      </button>
      {mode === 'new' ? (
        <button className={styles.quietLink} onClick={() => setSignup((s) => !s)}>
          {signup ? 'I already have an account' : 'New here? Create an account'}
        </button>
      ) : props.onStartFresh ? (
        <button className={styles.quietLink} onClick={props.onStartFresh}>
          I'm new here
        </button>
      ) : null}
      <button className={styles.quietLink} onClick={props.onLocal}>
        Continue locally with my own API key
      </button>
    </div>
  );
}

/** Onboarding-styled stand-in for the app's dark OAuth interstitial: runs the
 * Google sign-in flow while the player finishes it in the system browser.
 * On success (or an explicit cancel) it just dismisses itself — the session
 * lands via the auth push and OnboardApp proceeds from there. */
function GoogleWaitPanel(props: { onDone: () => void }): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);

  const start = (): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    sei.signInGoogle().then(
      (res) => {
        inFlightRef.current = false;
        if (res.ok || res.reason === 'user_cancelled') props.onDone();
        else setError(res.message || "Sign-in didn't finish. Try again.");
      },
      () => {
        inFlightRef.current = false;
        setError("Sign-in didn't finish. Try again.");
      },
    );
  };

  // Kick off once on mount (ref-guarded against StrictMode double-invoke).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = async (): Promise<void> => {
    try {
      await sei.cancelGoogle();
    } catch {
      /* ignore — dismiss regardless */
    }
    props.onDone();
  };

  if (error !== null) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>{error}</p>
        <button className={`${styles.pill} ${styles.pillWide}`} onClick={start}>
          Try again
        </button>
        <button className={styles.quietLink} onClick={() => void cancel()}>
          Cancel sign-in
        </button>
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>
        We opened a browser tab to finish signing in with Google. Come back when you're done;
        this picks up on its own.
      </p>
      <button className={styles.quietLink} onClick={() => void cancel()}>
        Cancel sign-in
      </button>
    </div>
  );
}

/* ── Local (BYOK) setup panel ────────────────────────────────────────────── */

const PROVIDERS: Array<{ value: string; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'grok', label: 'Grok' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'together', label: 'Together' },
  { value: 'groq', label: 'Groq' },
  { value: 'fireworks', label: 'Fireworks' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'perplexity', label: 'Perplexity' },
];

function LocalSetupPanel(props: { onDone: (provider: string, key: string) => void }): React.ReactElement {
  const [provider, setProvider] = useState('anthropic');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      props.onDone(provider, key);
    } catch (err) {
      setError((err as Error).message || 'Something went wrong.');
      setBusy(false);
    }
  };
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>Pick your model provider and paste your API key.</p>
      <select
        className={styles.fieldSelect}
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        aria-label="Model provider"
      >
        {PROVIDERS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <input
        className={styles.field}
        type="password"
        value={key}
        placeholder="sk-..."
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        aria-label="API key"
      />
      {error ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
      <button className={`${styles.pill} ${styles.pillWide}`} disabled={!key.trim() || busy} onClick={() => void submit()}>
        Done
      </button>
    </div>
  );
}
