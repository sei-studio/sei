/**
 * uniqueCasting — running a unique-companion generation and turning its stage
 * events into a progress bar (260703 procgen; extracted from the standalone
 * UniqueCastingScreen at 260731 when the flow moved into Sui's scene).
 *
 * The hook mints a requestId, subscribes to sei.onGenProgress filtered by it,
 * kicks off sei.generateUnique, and exposes a smoothed percentage plus the
 * stage headline. Portrait/skin failures are NON-fatal: they settle their
 * stage and surface a plain-spoken line rather than failing the cast.
 *
 * Generation starts the moment a gender is passed in, which lets a caller
 * overlap it with an animation (Sui walking off) instead of paying for that
 * time twice.
 */
import { useEffect, useState } from 'react';
import { sei } from './ipcClient';
import type { GenStage, GenerateUniqueResult, UniqueGender } from '@shared/ipc';

export const STAGE_ORDER: GenStage[] = ['sheet', 'portrait', 'skin', 'persona', 'saving'];

/**
 * Rough share of wall-clock each stage takes (sums to 100). The bar credits a
 * stage's full weight when it settles and creeps toward 90% of an in-flight
 * stage's weight while it runs, so the long LLM calls (sheet, persona) read as
 * live motion instead of a frozen bar that lurches in 20% steps.
 */
const STAGE_WEIGHT: Record<GenStage, number> = {
  sheet: 30,
  portrait: 20,
  skin: 10,
  persona: 30,
  saving: 10,
};

const CREEP_TICK_MS = 200;
/** Fraction of the remaining gap closed per tick (~4s time constant). */
const CREEP_RATE = 0.05;

/**
 * Stage headlines, in SUI'S frame (260731b).
 *
 * These are the only words on screen while she is away, so they set what the
 * player thinks just happened. The first cut described the machine doing the
 * work — casting a soul, giving them a face, weaving their skin — which reads
 * as assembling a person to order, and lands somewhere between unsettling and
 * sad once you are supposed to like them.
 *
 * Sui's own lines a few seconds earlier say the opposite: "I have three
 * companions who are ready to be awakened", "Let me go get them". Someone
 * already exists; she is going to fetch them. So every stage is her finding
 * out about a person, not building one, and the last one is her walking back.
 */
export const STAGE_COPY: Record<GenStage, string> = {
  sheet: 'Finding someone for you…',
  portrait: 'Seeing their face…',
  skin: "Sorting out what they'll wear…",
  persona: 'Hearing their story…',
  saving: 'Bringing them over…',
};

export type CastErrorCode = Extract<GenerateUniqueResult, { ok: false }>['code'];

export const CAST_ERROR_COPY: Record<CastErrorCode, { title: string; body: string }> = {
  not_signed_in: {
    title: 'Sign in to continue',
    body: 'Meeting a unique companion needs a Sei account. Sign in and try again.',
  },
  slot_limit: {
    title: 'Your slots are full',
    body: 'Free up one of your companion slots, then cast again.',
  },
  daily_limit: {
    title: 'That’s enough casting for today',
    body: 'You’ve reached today’s limit. Come back tomorrow to meet someone new.',
  },
  generation_failed: {
    title: 'The cast didn’t take',
    body: 'Something went wrong weaving your companion. Let’s try once more.',
  },
  network: {
    title: 'Couldn’t reach the aether',
    body: 'Check your connection and try the ritual again.',
  },
};

export interface CastingState {
  /** Smoothed 0-100 progress. */
  pct: number;
  /** The earliest in-flight stage — the honest headline (portrait and persona
   * run in parallel). */
  stage: GenStage;
  portraitFailed: boolean;
  skinFailed: boolean;
  /** Set once the cast succeeds. */
  characterId: string | null;
  errCode: CastErrorCode | null;
  errDetail: string | null;
  retry: () => void;
}

/** Run a cast. Passing null holds off until a gender has been chosen. */
export function useUniqueCasting(gender: UniqueGender | null): CastingState {
  const [stageState, setStageState] = useState<Partial<Record<GenStage, 'start' | 'done' | 'error'>>>({});
  // Non-fatal art failures, reported honestly under the bar. A portrait
  // failure implies no custom skin either (the skin derives from the same
  // image), so only the portrait line shows in that case.
  const [portraitFailed, setPortraitFailed] = useState(false);
  const [skinFailed, setSkinFailed] = useState(false);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<CastErrorCode | null>(null);
  // The pipeline's specific failure reason (e.g. which stage broke and why),
  // shown as a dim detail line so a failed cast is diagnosable, not just poetic.
  const [errDetail, setErrDetail] = useState<string | null>(null);
  // Bumping `attempt` re-runs the generation effect (Try again).
  const [attempt, setAttempt] = useState(0);
  // Smoothed bar value — creeps toward the ceiling between stage events.
  const [displayPct, setDisplayPct] = useState(0);

  useEffect(() => {
    if (gender === null) return undefined;
    let cancelled = false;
    const requestId = crypto.randomUUID();
    setStageState({});
    setPortraitFailed(false);
    setSkinFailed(false);
    setCharacterId(null);
    setErrCode(null);
    setErrDetail(null);
    setDisplayPct(0);

    const off = sei.onGenProgress((ev) => {
      if (cancelled || ev.requestId !== requestId) return;
      setStageState((prev) => ({ ...prev, [ev.stage]: ev.status }));
      if (ev.status === 'error' && ev.stage === 'portrait') setPortraitFailed(true);
      if (ev.status === 'error' && ev.stage === 'skin') setSkinFailed(true);
    });

    void sei
      .generateUnique({ requestId, gender })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setCharacterId(res.characterId);
        else {
          setErrCode(res.code);
          setErrDetail(res.message || null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setErrCode('generation_failed');
        setErrDetail(err instanceof Error ? err.message : null);
      });

    return () => {
      cancelled = true;
      off();
    };
  }, [gender, attempt]);

  // ── Progress accounting ──────────────────────────────────────────────────
  // 'error' counts as settled: portrait/skin errors are non-fatal (the pipeline
  // continues without art), so the bar must still reach 100% on a successful
  // cast instead of stalling and jumping to the reveal.
  const settledPct = STAGE_ORDER.reduce(
    (acc, s) => acc + (stageState[s] === 'done' || stageState[s] === 'error' ? STAGE_WEIGHT[s] : 0),
    0,
  );
  // Ceiling the creep may approach: settled weight + 90% of every in-flight
  // stage's weight. Never reaches a stage boundary before the stage settles.
  const ceilingPct =
    settledPct +
    STAGE_ORDER.reduce((acc, s) => acc + (stageState[s] === 'start' ? STAGE_WEIGHT[s] * 0.9 : 0), 0);

  // Creep the displayed value toward the ceiling; jump instantly when real
  // progress (a settled stage) lands. Never moves backwards.
  useEffect(() => {
    setDisplayPct((p) => Math.max(p, settledPct));
    const timer = window.setInterval(() => {
      setDisplayPct((p) => {
        const base = Math.max(p, settledPct);
        const next = base + Math.max(0, ceilingPct - base) * CREEP_RATE;
        return next > base ? next : base;
      });
    }, CREEP_TICK_MS);
    return () => window.clearInterval(timer);
  }, [settledPct, ceilingPct]);

  const stage =
    STAGE_ORDER.find((s) => stageState[s] === 'start') ??
    STAGE_ORDER.find((s) => stageState[s] !== 'done' && stageState[s] !== 'error') ??
    'saving';

  return {
    pct: Math.round(displayPct),
    stage,
    portraitFailed,
    skinFailed,
    characterId,
    errCode,
    errDetail,
    retry: () => setAttempt((a) => a + 1),
  };
}
