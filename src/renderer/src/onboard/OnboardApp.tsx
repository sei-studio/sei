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
 *   new+local  → questionnaire → "continue locally" → provider+key → model
 *                (list + test) → STT choice → TTS choice → prefsSave + BYOK
 *                generation → full tutorial (260817, china-compat W6 — the
 *                local path gets the SAME arc as cloud; only portrait/skin
 *                degrade to the procedural look while signed out)
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
import { t, useT, uiLanguage } from '../lib/i18n';
import { useEmailCode } from '../lib/useEmailCode';
import { CodeInput } from '../components/CodeInput';
import { OnboardScene, type SuiPose } from './OnboardScene';
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  SHOWN_PROVIDERS,
  modelVision,
  type ProviderKind,
} from '@shared/llmCatalog';
import type { AuthState, SpeechPackStatePush, UniqueGender } from '@shared/ipc';
import type { UserConfig } from '@shared/characterSchema';
import {
  SENSEVOICE_PACK_ID,
  allPacksReady,
  llmTestErrorCopy,
  mbLabel,
  packsPct,
  packsTotalBytes,
  ttsPackIdsFor,
  type LocalSetupChoices,
  type SttEngineChoice,
  type TtsEngineChoice,
} from './localSetup';
import {
  ContinueHint,
  CornerControls,
  fadeThemeClass,
  fmtNodes,
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
  type AgeRange,
  type ArtStyle,
  type Dynamic,
} from './suiQuestions';
import styles from './onboard.module.css';

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
  const tt = useT();
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
      setSetupError((err as Error).message || t('Something went wrong.'));
    }
  }, [buildConfig]);

  // ── Setup pipeline (local path, 260817 china-compat W6) ────────────────
  // The FULL onboarding arc for BYOK users: same config-save + prefsSave +
  // generation + full-tutorial shape as runCloudSetup, with the generation
  // riding the user's own provider (main's local generateUnique path). Set by
  // finishLocalSetup before entering the 'setup' phase; null means the setup
  // phase belongs to the cloud path (which stays byte-identical).
  const localChoicesRef = useRef<LocalSetupChoices | null>(null);

  const runLocalSetup = useCallback(async () => {
    const choices = localChoicesRef.current;
    if (!choices) return;
    const run = ++setupRunRef.current;
    setSetupError(null);
    const a = answersRef.current;
    try {
      // One config write carrying the whole wizard: backend, provider, the
      // picked model (provider_config is where the llm layer reads it), and
      // the OPTIONAL voice engines — absent keys stay unwritten, so "decide
      // later" leaves Whisper-fallback STT / ElevenLabs TTS semantics. The
      // API key itself was saved at the wizard's key step (llm:list-models
      // needed it there).
      await sei.saveConfig({
        ...buildConfig('local', choices.provider as UserConfig['provider']),
        provider_config: { [choices.provider]: { model: choices.model } },
        ...(choices.stt ? { stt_engine: choices.stt } : {}),
        ...(choices.tts ? { tts_engine: choices.tts } : {}),
      });
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
      setSetupError((err as Error).message || t('Something went wrong.'));
    }
  }, [buildConfig]);

  useEffect(() => {
    if (phase.k === 'setup') void (localChoicesRef.current ? runLocalSetup() : runCloudSetup());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k]);

  // Existing-account greeting: hold long enough to read, then hand off as a
  // returning user (straight to Home, no tutorial, no config written).
  //
  // The ONE thing this branch does write is the questionnaire (260801). They
  // just answered all three of Sui's questions and then signed into an account
  // whose stored answers have gaps; dropping the answers on the floor meant
  // being asked all three again later. The answers are the freshest statement
  // of what they want either way, and prefsSave is a partial patch, so nothing
  // else on the account is touched. A failure is a non-event: Sui asks for
  // whatever is still missing when they go to meet a companion.
  useEffect(() => {
    if (phase.k !== 'welcome-existing') return undefined;
    let cancelled = false;
    const held = new Promise<void>((resolve) => setTimeout(resolve, 2400));
    void (async () => {
      const a = answersRef.current;
      // skipCreation walks off before the questions, so there is nothing to
      // carry — the same guard runCloudSetup uses.
      if (!a.skipCreation) {
        try {
          await sei.prefsSave({
            companion_age_range: a.age,
            art_style: a.art,
            companion_dynamics: a.dynamics,
          });
        } catch {
          /* best-effort: the Home gate re-asks, which is the old behaviour */
        }
      }
      await held;
      if (!cancelled) complete(false, null);
    })();
    return () => {
      cancelled = true;
    };
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
  // mid-line). Translation happens HERE, at render, via the subscribed
  // translator — the module-level SCRIPT stays English keys, so a language
  // flip re-renders with the other language instead of baking one in at
  // import time.
  const lineText = line
    ? tt(
        line === 'ready' && genCharacterIdRef.current
          ? "Welcome back! Everything is all set, and someone's waiting to meet you. You ready?"
          : SCRIPT[line],
        { name: name.trim() },
      )
    : '';
  const tw = useTypewriter(lineText);

  // ── Sui's voice-over (260730) ──────────────────────────────────────────
  // The clips and the playback contract live in suiStage/useSuiVoice, shared
  // with the in-app scenes. Two script facts stay here: the two {name} lines
  // (iSee/job) were generated name-free, so the clip never has to speak a name
  // the player typed, and 'dots' is silent by design.
  const { prefs: voicePrefs, setPrefs: setVoicePrefs, volume: effVolume } = useVoicePrefs();
  useSuiVoice(
    !line || line === 'dots'
      ? null
      : line === 'ready' && genCharacterIdRef.current
        ? 'readyGen'
        : line,
    effVolume,
  );
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
  useEnterAdvances(advance);

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
   * that already existed? Decided by ACCOUNT AGE for both the password form
   * and OAuth (260730). A pure intent check ('signin' = existing) broke the
   * boomerang first-timer: someone who created their account mid-onboarding,
   * quit before setup ran (the email-verification detour is the common way),
   * and came back through "I already have an account". Their profile has no
   * config yet, so the welcome-back dead-end would bounce them to Home and
   * replay the whole questionnaire on the NEXT launch — the account-age
   * window routes them into setup + tutorial now instead. 48h comfortably
   * covers a verify-tomorrow detour while still catching genuine veterans;
   * the cost when it misjudges (a days-old account's first sign-in on a
   * second machine) is one redundant setup, not data loss. A 'signup'
   * intent and a boot-restored session (null intent, relaunch
   * mid-onboarding) are always new. */
  const signedIntoExistingAccount = useCallback((): boolean => {
    const a = authRef.current;
    if (a.kind !== 'signed_in') return false;
    const intent = authIntentRef.current;
    if (intent === 'signin' || intent === 'oauth') {
      const ageMs = Date.now() - Date.parse(a.user.createdAt);
      return Number.isFinite(ageMs) && ageMs > 48 * 3600_000;
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
  // The wizard hands over its choices; the heavy lifting (config save,
  // prefsSave, BYOK generation) runs in runLocalSetup under the same
  // "Setting up..." surface the cloud path uses.
  const finishLocalSetup = useCallback((choices: LocalSetupChoices) => {
    localChoicesRef.current = choices;
    setPhase({ k: 'setup' });
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────
  const showDialogue = phase.k === 'line';
  const clickAdvances =
    line !== null &&
    !['newQ', 'nameQ', 'job', 'skipConfirm', 'qDyn', 'qAge', 'qArt', 'qGender', 'ahh'].includes(line);

  return (
    <div className={styles.root}>
      <CornerControls prefs={voicePrefs} onPrefs={setVoicePrefs} />
      <div
        className={styles.card}
        onClick={clickAdvances ? advance : line && !tw.done ? tw.skip : undefined}
      >
        <div className={styles.dragStrip} />
        <OnboardScene
          groundIn={groundIn}
          sui={sui}
          // Footsteps follow the voice volume/mute, well under her lines.
          sfxVolume={effVolume * 0.35}
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
            {hintOn && tw.done ? <ContinueHint /> : null}
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
          <LocalSetupPanel onDone={finishLocalSetup} />
        ) : null}

        {phase.k === 'welcome-existing' ? (
          <div className={styles.panel}>
            <p className={styles.panelText}>
              {tt('Welcome back! You already have an account with this login. Signing you in...')}
            </p>
          </div>
        ) : null}

        {phase.k === 'setup' ? (
          setupError ? (
            <div className={styles.panel}>
              <p className={styles.panelText}>{setupError}</p>
              <button
                className={styles.pill}
                onClick={() => void (localChoicesRef.current ? runLocalSetup() : runCloudSetup())}
              >
                {tt('Try again')}
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
              <p className={styles.panelText}>{tt('Setting up...')}</p>
            </div>
          )
        ) : null}

        <div className={phase.k === 'fade' ? `${styles.fade} ${styles.fadeOn} ${fadeThemeClass()}` : styles.fade} />
      </div>
    </div>
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
  const tt = useT();

  switch (line) {
    case 'newQ':
      return (
        <div className={styles.choices}>
          <button className={styles.pill} onClick={() => goLine('nameQ')}>
            {tt('Yes')}
          </button>
          <button
            className={styles.pill}
            onClick={() => {
              answersRef.current.returning = true;
              goLine('welcomeBack');
            }}
          >
            {tt('No')}
          </button>
          <button className={styles.quietLink} onClick={() => goLine('runPlace')}>
            {tt('Back')}
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
            placeholder={tt('Your name')}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) goLine('iSee');
            }}
            aria-label={tt('Your name')}
          />
          <button className={styles.quietLink} onClick={() => goLine('newQ')}>
            {tt('Back')}
          </button>
        </div>
      );
    case 'job':
      return (
        <div className={styles.choices}>
          <button className={styles.pill} onClick={advance}>
            {tt('Sounds fun')}
          </button>
          <button className={styles.quietLink} onClick={() => goLine('skipConfirm')}>
            {tt('Not interested')}
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
            {tt('Skip')}
          </button>
          <button className={styles.pill} onClick={() => goLine('job')}>
            {tt('Nevermind')}
          </button>
        </div>
      );
    case 'qDyn':
      return (
        <DynPicker
          onDone={(picked) => {
            answersRef.current.dynamics = picked;
            goLine('qAge');
          }}
          onBack={() => goLine('fiveQs')}
        />
      );
    case 'qAge':
      return (
        <PillPicker
          options={AGE_OPTIONS}
          onPick={(value) => {
            answersRef.current.age = value;
            goLine('qArt');
          }}
          onBack={() => goLine('qDyn')}
        />
      );
    case 'qArt':
      return (
        <ArtPicker
          onPick={(value) => {
            answersRef.current.art = value;
            goLine('qGender');
          }}
          onBack={() => goLine('qAge')}
        />
      );
    case 'qGender':
      return (
        <PillPicker
          options={GENDER_OPTIONS}
          onPick={(value) => {
            answersRef.current.gender = value;
            goLine('allDone');
          }}
          onBack={() => goLine('qArt')}
        />
      );
    case 'ready':
      return (
        <div className={styles.choices}>
          <button className={styles.pill} onClick={advance}>
            {tt("Let's go")}
          </button>
        </div>
      );
    default:
      return null;
  }
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
  const tt = useT();
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
  /**
   * 260804 — address the emailed code went to, and the flag that swaps this
   * panel for the code entry. ONE panel covers signup, a sign-in against an
   * unconfirmed address, and forgot-password: the copy names none of them, so
   * it cannot reveal whether the address was already registered. Redemption
   * lands the session (or, for a recovery code, opens SetNewPasswordModal via
   * main's push) and OnboardApp proceeds from the auth push exactly as before.
   */
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const codeState = useEmailCode(codeSentTo);
  const [oauth, setOauth] = useState(false);
  /**
   * W7 region gate (260816). Pre-checked on mount over region:status so the
   * blocking panel appears before a failed submit; the submit paths below
   * also honor a main-side `region_blocked` refusal as the authoritative
   * backstop. Fails open: a failed pre-check leaves the form usable.
   */
  const [regionBlocked, setRegionBlocked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    sei.regionStatus().then(
      (s) => {
        if (!cancelled && s.blocked) setRegionBlocked(true);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

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
        if (!res.ok) {
          // W7: main refused on region; swap to the blocking panel (its copy
          // is translated locally) instead of the inline error line.
          if (res.code === 'region_blocked') setRegionBlocked(true);
          else setError(res.message);
        } else if (res.requiresVerification) setCodeSentTo(email.trim());
        // A session lands via the auth push; OnboardApp proceeds from there.
      } else {
        const res = await sei.signInPassword({ email: email.trim(), password });
        if (!res.ok) {
          if (res.code === 'region_blocked') setRegionBlocked(true);
          else setError(res.message);
        }
        // Right password, address never confirmed. Main has already sent a
        // fresh code (260804); show the panel rather than sitting on the form.
        else if (res.needsVerification) setCodeSentTo(email.trim());
      }
    } catch (err) {
      setError((err as Error).message || t('Something went wrong.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (needsTos) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>
          {fmtNodes(tt('One more thing: the {terms} and {privacy}.'), {
            terms: (
              <a
                className={styles.panelLink}
                href="#tos"
                onClick={(e) => {
                  e.preventDefault();
                  void sei.openExternal('https://sei.gg/terms.html');
                }}
              >
                {tt('Terms of Service')}
              </a>
            ),
            privacy: (
              <a
                className={styles.panelLink}
                href="#privacy"
                onClick={(e) => {
                  e.preventDefault();
                  void sei.openExternal('https://sei.gg/privacy.html');
                }}
              >
                {tt('Privacy Policy')}
              </a>
            ),
          })}
        </p>
        <button className={styles.pill} onClick={props.onAgreeTos}>
          {tt('I agree')}
        </button>
      </div>
    );
  }

  // W7 region gate (260816) — cloud accounts are unavailable here; steer to
  // the local-setup path. Placed AFTER the needsTos branch on purpose: that
  // branch serves an already-signed-in user, and existing sessions are never
  // gated.
  if (regionBlocked) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>
          {tt('Our servers do not currently support your region. Please continue with local mode.')}
        </p>
        <button className={`${styles.pill} ${styles.pillWide}`} onClick={props.onLocal}>
          {tt('Continue locally with my own API key')}
        </button>
      </div>
    );
  }

  const forgotPassword = async (): Promise<void> => {
    if (!email.trim()) {
      setError(t('Enter your email above first.'));
      return;
    }
    setError(null);
    try {
      const res = await sei.sendPasswordReset({ email: email.trim() });
      // Neutral success routes to the SAME code panel a signup lands on.
      if (res.ok) setCodeSentTo(email.trim());
      else setError(res.message);
    } catch {
      setError(t("Couldn't send the code. Try again in a moment."));
    }
  };

  if (codeSentTo !== null) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>
          {tt('Enter the 6-digit code we emailed you. Check spam if it is not there.')}
        </p>
        <CodeInput
          value={codeState.code}
          onChange={codeState.setCode}
          onComplete={(v) => void codeState.submit(v)}
          disabled={codeState.submitting}
          invalid={!!codeState.error}
          autoFocus
          rowClassName={styles.codeRow}
          cellClassName={styles.codeCell}
          aria-label={tt('Verification code')}
        />
        {codeState.error ? (
          <p className={styles.panelError} role="alert">
            {codeState.error}
          </p>
        ) : null}
        <button
          className={`${styles.pill} ${styles.pillWide}`}
          disabled={codeState.submitting || codeState.code.length === 0}
          onClick={() => void codeState.submit()}
        >
          {codeState.submitting ? tt('Checking...') : tt('Verify')}
        </button>
        <button
          className={styles.quietLink}
          disabled={codeState.resending}
          onClick={() => void codeState.resend()}
        >
          {codeState.resending ? tt('Sending...') : tt('Send a new code')}
        </button>
        {codeState.note ? <p className={styles.panelNote}>{codeState.note}</p> : null}
        <button
          className={styles.quietLink}
          onClick={() => {
            codeState.reset();
            setCodeSentTo(null);
          }}
        >
          {tt('Back')}
        </button>
      </div>
    );
  }

  if (oauth) return <GoogleWaitPanel onDone={() => setOauth(false)} onLocal={props.onLocal} />;

  return (
    <div className={styles.panel}>
      <img className={styles.panelLogo} src="./img/sei-text.png" alt="Sei" draggable={false} />
      <input
        className={styles.field}
        type="email"
        value={email}
        placeholder={tt('Email')}
        autoFocus
        onChange={(e) => setEmail(e.target.value)}
        aria-label={tt('Email')}
      />
      <input
        className={styles.field}
        type="password"
        value={password}
        placeholder={tt('Password')}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        aria-label={tt('Password')}
      />
      {!signup ? (
        <button
          className={styles.quietLink}
          disabled={submitting}
          onClick={() => void forgotPassword()}
        >
          {tt('Forgot password?')}
        </button>
      ) : null}
      {signup ? (
        <>
          <div className={styles.dobRow} aria-label={tt('Birthday')}>
            <select
              className={styles.fieldSelect}
              value={dobMonth}
              onChange={(e) => setDobMonth(Number(e.target.value))}
              aria-label={tt('Birth month')}
            >
              <option value={0}>{tt('Month')}</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {tt(m)}
                </option>
              ))}
            </select>
            <select
              className={styles.fieldSelect}
              value={dobDay}
              onChange={(e) => setDobDay(Number(e.target.value))}
              aria-label={tt('Birth day')}
            >
              <option value={0}>{tt('Day')}</option>
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
              aria-label={tt('Birth year')}
            >
              <option value={0}>{tt('Year')}</option>
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
              {fmtNodes(tt('I agree to the {terms} and {privacy}'), {
                terms: (
                  <a
                    className={styles.panelLink}
                    href="#tos"
                    onClick={(e) => {
                      e.preventDefault();
                      void sei.openExternal('https://sei.gg/terms.html');
                    }}
                  >
                    {tt('Terms')}
                  </a>
                ),
                privacy: (
                  <a
                    className={styles.panelLink}
                    href="#privacy"
                    onClick={(e) => {
                      e.preventDefault();
                      void sei.openExternal('https://sei.gg/privacy.html');
                    }}
                  >
                    {tt('Privacy Policy')}
                  </a>
                ),
              })}
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
        {signup
          ? submitting
            ? tt('Creating account...')
            : tt('Create account')
          : submitting
            ? tt('Signing in...')
            : tt('Sign in')}
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
        {tt('Continue with Google')}
      </button>
      {mode === 'new' ? (
        <button className={styles.quietLink} onClick={() => setSignup((s) => !s)}>
          {signup ? tt('I already have an account') : tt('New here? Create an account')}
        </button>
      ) : props.onStartFresh ? (
        <button className={styles.quietLink} onClick={props.onStartFresh}>
          {tt("I'm new here")}
        </button>
      ) : null}
      <button className={styles.quietLink} onClick={props.onLocal}>
        {tt('Continue locally with my own API key')}
      </button>
    </div>
  );
}

/** Onboarding-styled stand-in for the app's dark OAuth interstitial: runs the
 * Google sign-in flow while the player finishes it in the system browser.
 * On success (or an explicit cancel) it just dismisses itself — the session
 * lands via the auth push and OnboardApp proceeds from there. */
function GoogleWaitPanel(props: {
  onDone: () => void;
  /** W7 region gate: route to the local-setup path when main refuses on region. */
  onLocal?: () => void;
}): React.ReactElement {
  const tt = useT();
  const [error, setError] = useState<string | null>(null);
  // W7 region gate (260816) — main refused before opening the browser.
  const [regionBlocked, setRegionBlocked] = useState(false);
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
        else if (res.reason === 'region_blocked') setRegionBlocked(true);
        else setError(res.message || t("Sign-in didn't finish. Try again."));
      },
      () => {
        inFlightRef.current = false;
        setError(t("Sign-in didn't finish. Try again."));
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

  // W7 region gate — no "Try again": the verdict is cached, retrying cannot
  // change it. Offer the local path in the scene's own vocabulary.
  if (regionBlocked) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>
          {tt('Our servers do not currently support your region. Please continue with local mode.')}
        </p>
        {props.onLocal ? (
          <button className={`${styles.pill} ${styles.pillWide}`} onClick={props.onLocal}>
            {tt('Continue locally with my own API key')}
          </button>
        ) : null}
        <button className={styles.quietLink} onClick={props.onDone}>
          {tt('Back')}
        </button>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>{error}</p>
        <button className={`${styles.pill} ${styles.pillWide}`} onClick={start}>
          {tt('Try again')}
        </button>
        <button className={styles.quietLink} onClick={() => void cancel()}>
          {tt('Cancel sign-in')}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>
        {tt(
          "We opened a browser tab to finish signing in with Google. Come back when you're done; this picks up on its own.",
        )}
      </p>
      <button className={styles.quietLink} onClick={() => void cancel()}>
        {tt('Cancel sign-in')}
      </button>
    </div>
  );
}

/* ── Local (BYOK) setup wizard ───────────────────────────────────────────── */

// 260816 (china-compat): the offered set comes from the shared catalog (8
// providers; SHOWN_PROVIDERS in src/shared/llmCatalog.ts).
const PROVIDERS: Array<{ value: string; label: string }> = SHOWN_PROVIDERS.map((id) => ({
  value: id,
  label: PROVIDER_LABELS[id],
}));

/**
 * 260817 (china-compat W6): the local path is a four-step wizard in the
 * scene's own panel vocabulary — provider + key, model (live list + Test),
 * STT choice, TTS choice. The API key saves at the key→model transition
 * because llm:list-models / llm:test read it from the main-side store;
 * everything else rides component state and lands in ONE config write inside
 * runLocalSetup via onDone. Both voice steps are optional: "Decide later"
 * leaves the engine fields absent (Whisper-fallback STT semantics,
 * ElevenLabs TTS semantics), matching Settings' vocabulary later.
 */
function LocalSetupPanel(props: { onDone: (choices: LocalSetupChoices) => void }): React.ReactElement {
  const tt = useT();
  const [step, setStep] = useState<'key' | 'model' | 'stt' | 'tts'>('key');
  const [provider, setProvider] = useState<ProviderKind>('anthropic');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_MODELS.anthropic);
  const sttRef = useRef<SttEngineChoice | undefined>(undefined);
  // ElevenLabs key presence — shared by the Scribe and ElevenLabs-voices
  // options so the key is asked for at most once across both steps.
  const [elKeySaved, setElKeySaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    sei.voiceElevenKeyStatus().then(
      (s) => {
        if (!cancelled && s.present) setElKeySaved(true);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Ollama runs locally and authenticates nothing — the key is optional there
  // and skipped from the save; every other provider requires one.
  const keyOk = key.trim() !== '' || provider === 'ollama';
  const submitKey = async (): Promise<void> => {
    if (busy || !keyOk) return;
    setBusy(true);
    setError(null);
    try {
      if (key.trim()) await sei.saveApiKey(key.trim());
      setModel(DEFAULT_MODELS[provider] ?? '');
      setStep('model');
    } catch (err) {
      setError((err as Error).message || t('Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'key') {
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>{tt('Pick your model provider and paste your API key.')}</p>
        <select
          className={styles.fieldSelect}
          value={provider}
          onChange={(e) => setProvider(e.target.value as ProviderKind)}
          aria-label={tt('Model provider')}
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
            if (e.key === 'Enter') void submitKey();
          }}
          aria-label={tt('API key')}
        />
        {provider === 'ollama' ? (
          <p className={styles.panelNote}>{tt('Ollama runs on your computer and needs no API key.')}</p>
        ) : null}
        {error ? (
          <p className={styles.panelError} role="alert">
            {error}
          </p>
        ) : null}
        <button
          className={`${styles.pill} ${styles.pillWide}`}
          disabled={!keyOk || busy}
          onClick={() => void submitKey()}
        >
          {tt('Continue')}
        </button>
      </div>
    );
  }

  if (step === 'model') {
    return (
      <ModelStep
        provider={provider}
        model={model}
        setModel={setModel}
        onBack={() => setStep('key')}
        onNext={() => setStep('stt')}
      />
    );
  }

  if (step === 'stt') {
    return (
      <SttStep
        elKeySaved={elKeySaved}
        onElKeySaved={() => setElKeySaved(true)}
        onPick={(stt) => {
          sttRef.current = stt;
          setStep('tts');
        }}
        onBack={() => setStep('model')}
      />
    );
  }

  return (
    <TtsStep
      elKeySaved={elKeySaved}
      onElKeySaved={() => setElKeySaved(true)}
      onPick={(tts) =>
        props.onDone({
          provider,
          model: model.trim(),
          ...(sttRef.current ? { stt: sttRef.current } : {}),
          ...(tts ? { tts } : {}),
        })
      }
      onBack={() => setStep('stt')}
    />
  );
}

/**
 * Model selection + Test. The list is live (llm:list-models with the key
 * saved one step earlier); on any listing failure the step degrades to a
 * free-text model id primed with the catalog default, so an offline or
 * unlistable provider never blocks the wizard. Non-vision models get a short
 * hint because two whole surfaces (screen sharing, Draw!) need vision.
 */
function ModelStep(props: {
  provider: ProviderKind;
  model: string;
  setModel: (m: string) => void;
  onBack: () => void;
  onNext: () => void;
}): React.ReactElement {
  const tt = useT();
  const { provider, model, setModel } = props;
  // null = loading. An empty array = listing failed → free-text fallback.
  const [models, setModels] = useState<Array<{ id: string; vision: 'yes' | 'no' | 'unknown' }> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    sei.llmListModels(provider).then(
      (r) => {
        if (!cancelled) setModels(r.error || r.models.length === 0 ? [] : r.models);
      },
      () => {
        if (!cancelled) setModels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [provider]);

  type TestState = { k: 'idle' } | { k: 'busy' } | { k: 'ok'; seconds: string } | { k: 'err'; copy: string };
  const [test, setTest] = useState<TestState>({ k: 'idle' });
  const pickModel = (m: string): void => {
    setModel(m);
    setTest({ k: 'idle' }); // a verdict is per-model; changing it stales the old one
  };
  const runTest = async (): Promise<void> => {
    if (test.k === 'busy' || !model.trim()) return;
    setTest({ k: 'busy' });
    try {
      const r = await sei.llmTest(provider, model.trim());
      setTest(
        r.ok
          ? { k: 'ok', seconds: (r.latencyMs / 1000).toFixed(1) }
          : { k: 'err', copy: llmTestErrorCopy(r.error) },
      );
    } catch {
      setTest({ k: 'err', copy: llmTestErrorCopy('unknown') });
    }
  };

  // Keep the current pick selectable even when the live list omits it (the
  // catalog default may not appear in /models on every provider).
  const options =
    models && models.length > 0
      ? models.some((m) => m.id === model)
        ? models
        : [{ id: model, vision: modelVision(provider, model) }, ...models]
      : null;
  const vision = options?.find((m) => m.id === model)?.vision ?? modelVision(provider, model);

  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>{tt('Pick the model your companions will think with.')}</p>
      {models === null ? (
        <p className={styles.panelNote}>{tt('Loading the model list...')}</p>
      ) : options ? (
        <select
          className={styles.fieldSelect}
          value={model}
          onChange={(e) => pickModel(e.target.value)}
          aria-label={tt('Model')}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            className={styles.field}
            value={model}
            onChange={(e) => pickModel(e.target.value)}
            aria-label={tt('Model')}
          />
          <p className={styles.panelNote}>
            {tt("Couldn't load the model list. Keep the suggested model or type a model id.")}
          </p>
        </>
      )}
      {vision === 'no' ? (
        <p className={styles.panelNote}>
          {tt('This model cannot see images. Screen sharing and Draw! need a vision model.')}
        </p>
      ) : null}
      {test.k === 'busy' ? (
        <p className={styles.panelNote}>
          {provider === 'deepseek'
            ? tt('Testing... DeepSeek can take up to a minute to answer.')
            : tt('Testing...')}
        </p>
      ) : test.k === 'ok' ? (
        <p className={styles.panelNote}>{tt('Connection works ({seconds}s).', { seconds: test.seconds })}</p>
      ) : test.k === 'err' ? (
        <p className={styles.panelError} role="alert">
          {tt(test.copy)}
        </p>
      ) : null}
      <div className={styles.choices}>
        <button className={styles.pill} disabled={test.k === 'busy' || !model.trim()} onClick={() => void runTest()}>
          {tt('Test')}
        </button>
        {/* Continue stays live during a slow test — the test is optional. */}
        <button className={styles.pill} disabled={!model.trim()} onClick={props.onNext}>
          {tt('Continue')}
        </button>
      </div>
      <button className={styles.quietLink} onClick={props.onBack}>
        {tt('Back')}
      </button>
    </div>
  );
}

/**
 * STT choice — how companions hear the player on voice calls. Scribe needs
 * the ElevenLabs key (asked inline, once, shared with the TTS step);
 * SenseVoice needs its pack downloaded; Whisper downloads itself on first
 * use through the existing renderer worker, so it needs nothing here.
 */
function SttStep(props: {
  elKeySaved: boolean;
  onElKeySaved: () => void;
  onPick: (stt: SttEngineChoice | undefined) => void;
  onBack: () => void;
}): React.ReactElement {
  const tt = useT();
  const [sub, setSub] = useState<'pick' | 'elkey' | 'download'>('pick');
  if (sub === 'elkey') {
    return (
      <ElKeyPanel
        onSaved={() => {
          props.onElKeySaved();
          props.onPick('scribe');
        }}
        onBack={() => setSub('pick')}
      />
    );
  }
  if (sub === 'download') {
    return (
      <PackDownloadPanel
        packIds={[SENSEVOICE_PACK_ID]}
        title={tt('SenseVoice runs on your computer, free.')}
        onDone={() => props.onPick('sensevoice')}
        onBack={() => setSub('pick')}
      />
    );
  }
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>{tt('Voice calls: how should companions hear you?')}</p>
      <div className={styles.choicesCol}>
        <button
          className={styles.pill}
          onClick={() => (props.elKeySaved ? props.onPick('scribe') : setSub('elkey'))}
        >
          {tt('ElevenLabs Scribe (your ElevenLabs key)')}
        </button>
        <button className={styles.pill} onClick={() => props.onPick('whisper')}>
          {tt('Whisper (free)')}
        </button>
        <button className={styles.pill} onClick={() => setSub('download')}>
          {tt('SenseVoice (free, best for Chinese)')}
        </button>
      </div>
      <p className={styles.panelNote}>{tt('The free options run on your computer. Whisper downloads itself on first use.')}</p>
      <button className={styles.quietLink} onClick={() => props.onPick(undefined)}>
        {tt('Decide later')}
      </button>
      <button className={styles.quietLink} onClick={props.onBack}>
        {tt('Back')}
      </button>
    </div>
  );
}

/**
 * TTS choice — how companions speak. Picking local voices downloads the
 * pack(s) for the current UI language (zh needs both gendered packs; en is
 * one pack). Characters keep their ElevenLabs voiceId either way; local
 * synthesis maps it to a gendered local voice at call time.
 */
function TtsStep(props: {
  elKeySaved: boolean;
  onElKeySaved: () => void;
  onPick: (tts: TtsEngineChoice | undefined) => void;
  onBack: () => void;
}): React.ReactElement {
  const tt = useT();
  const [sub, setSub] = useState<'pick' | 'elkey' | 'download'>('pick');
  if (sub === 'elkey') {
    return (
      <ElKeyPanel
        onSaved={() => {
          props.onElKeySaved();
          props.onPick('elevenlabs');
        }}
        onBack={() => setSub('pick')}
      />
    );
  }
  if (sub === 'download') {
    return (
      <PackDownloadPanel
        packIds={ttsPackIdsFor(uiLanguage())}
        title={tt('Local voices run on your computer, free.')}
        onDone={() => props.onPick('local')}
        onBack={() => setSub('pick')}
      />
    );
  }
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>{tt('And how should companions speak?')}</p>
      <div className={styles.choicesCol}>
        <button
          className={styles.pill}
          onClick={() => (props.elKeySaved ? props.onPick('elevenlabs') : setSub('elkey'))}
        >
          {tt('ElevenLabs voices (your ElevenLabs key)')}
        </button>
        <button className={styles.pill} onClick={() => setSub('download')}>
          {tt('Local voices (free)')}
        </button>
      </div>
      <button className={styles.quietLink} onClick={() => props.onPick(undefined)}>
        {tt('Decide later')}
      </button>
      <button className={styles.quietLink} onClick={props.onBack}>
        {tt('Back')}
      </button>
    </div>
  );
}

/** ElevenLabs key entry, shared by the Scribe and ElevenLabs-voices options.
 * The key never comes back to the renderer; main stores it encrypted
 * (voice:eleven-key-set). */
function ElKeyPanel(props: { onSaved: () => void; onBack: () => void }): React.ReactElement {
  const tt = useT();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    if (busy || key.trim().length < 8) return;
    setBusy(true);
    setError(null);
    try {
      await sei.voiceElevenKeySet({ key: key.trim() });
      props.onSaved();
    } catch (err) {
      setError((err as Error).message || t('Something went wrong.'));
      setBusy(false);
    }
  };
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>
        {tt('Paste your ElevenLabs API key. It powers Scribe recognition and ElevenLabs voices.')}
      </p>
      <input
        className={styles.field}
        type="password"
        value={key}
        placeholder="xi-..."
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
        }}
        aria-label={tt('ElevenLabs API key')}
      />
      {error ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
      <button
        className={`${styles.pill} ${styles.pillWide}`}
        disabled={key.trim().length < 8 || busy}
        onClick={() => void save()}
      >
        {tt('Save')}
      </button>
      <button className={styles.quietLink} onClick={props.onBack}>
        {tt('Back')}
      </button>
    </div>
  );
}

/**
 * Confirm-then-download for one or more speech packs. The confirm names the
 * EXACT archive cost, read off speech:pack-status (main's pack registry is
 * the single source of truth for sizes — the renderer hardcodes nothing).
 * The download runs in MAIN, so "Continue" is available the moment it
 * starts: leaving the panel does not cancel it, and a failed download just
 * leaves the pack absent — the first call then surfaces the typed
 * VOICE_PACK_MISSING caption pointing at the Settings download.
 * Already-downloaded packs (a re-run of onboarding) skip straight through.
 */
function PackDownloadPanel(props: {
  packIds: string[];
  /** One translated line naming what this download is. */
  title: string;
  onDone: () => void;
  onBack: () => void;
}): React.ReactElement {
  const tt = useT();
  const { packIds } = props;
  const [packs, setPacks] = useState<Record<string, SpeechPackStatePush> | null>(null);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const doneRef = useRef(false);
  const finish = useCallback((): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    props.onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let cancelled = false;
    sei.speechPackStatus().then(
      (s) => {
        if (!cancelled) setPacks(s.packs);
      },
      () => undefined,
    );
    const off = sei.onSpeechPackState((push) => setPacks(push.packs));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  const ready = allPacksReady(packIds, packs);
  useEffect(() => {
    if (started && ready) finish();
  }, [started, ready, finish]);
  const start = (): void => {
    setStarted(true);
    setFailed(false);
    void Promise.all(packIds.map((packId) => sei.speechPackDownload({ packId }))).catch(() => {
      setFailed(true);
    });
  };

  if (!started) {
    const totalBytes = packsTotalBytes(packIds, packs);
    return (
      <div className={styles.panel}>
        <p className={styles.panelText}>{props.title}</p>
        {ready ? (
          <button className={`${styles.pill} ${styles.pillWide}`} onClick={finish}>
            {tt('Already downloaded. Continue')}
          </button>
        ) : (
          <button
            className={`${styles.pill} ${styles.pillWide}`}
            disabled={totalBytes === null}
            onClick={start}
          >
            {totalBytes === null
              ? tt('Checking...')
              : tt('Download? ({mb} MB)', { mb: mbLabel(totalBytes) })}
          </button>
        )}
        <button className={styles.quietLink} onClick={props.onBack}>
          {tt('Back')}
        </button>
      </div>
    );
  }

  const pct = packsPct(packIds, packs);
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>{tt('Downloading... {pct}%', { pct })}</p>
      <div className={styles.progress}>
        <div className={styles.progressFillDet} style={{ width: `${pct}%` }} />
      </div>
      {failed ? (
        <>
          <p className={styles.panelError} role="alert">
            {tt('The download failed. Check your connection and try again.')}
          </p>
          <button className={`${styles.pill} ${styles.pillWide}`} onClick={start}>
            {tt('Try again')}
          </button>
        </>
      ) : (
        <p className={styles.panelNote}>{tt('You can keep going; it finishes in the background.')}</p>
      )}
      <button className={styles.quietLink} onClick={finish}>
        {tt('Continue')}
      </button>
    </div>
  );
}
