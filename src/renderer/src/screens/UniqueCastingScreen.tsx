/**
 * UniqueCastingScreen — the full-screen generation/ritual progress surface
 * (260703 procgen, spec item 3).
 *
 * On mount it mints a requestId, subscribes to sei.onGenProgress (filtered by
 * that id), and kicks off sei.generateUnique({ requestId, gender }). The
 * pipeline stages surface as ritual copy over a PercentBar:
 *   sheet   → "Casting their soul…"
 *   portrait→ "Giving them a face…"
 *   skin    → "Weaving their skin…"
 *   persona → "Teaching them who they are…"
 *   saving  → "Binding to your world…"
 *
 * Portrait/skin stage errors are NON-fatal — they surface a plain-spoken
 * "Image generation failed…" / "Skin generation failed…" line rather than
 * failing the ritual (260705: replaced the cryptic "the vision blurred").
 * On { ok:false } we swap to a code-appropriate error state with Try again /
 * Back. On { ok:true } we refresh the character list and route to the reveal.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { PercentBar } from '../components/PercentBar';
import { Button } from '../components/Button';
import type { GenStage, GenerateUniqueResult, UniqueGender } from '@shared/ipc';
import styles from './UniqueCastingScreen.module.css';

const STAGE_ORDER: GenStage[] = ['sheet', 'portrait', 'skin', 'persona', 'saving'];

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

const STAGE_COPY: Record<GenStage, string> = {
  sheet: 'Casting their soul…',
  portrait: 'Giving them a face…',
  skin: 'Weaving their skin…',
  persona: 'Teaching them who they are…',
  saving: 'Binding to your world…',
};

type ErrCode = Extract<GenerateUniqueResult, { ok: false }>['code'];

const ERROR_COPY: Record<ErrCode, { title: string; body: string }> = {
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

export interface UniqueCastingScreenProps {
  gender: UniqueGender;
}

export function UniqueCastingScreen({ gender }: UniqueCastingScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const [stageState, setStageState] = useState<Partial<Record<GenStage, 'start' | 'done' | 'error'>>>(
    {},
  );
  // Non-fatal art failures, reported honestly under the bar. A portrait
  // failure implies no custom skin either (the skin derives from the same
  // image), so only the portrait line shows in that case.
  const [portraitFailed, setPortraitFailed] = useState(false);
  const [skinFailed, setSkinFailed] = useState(false);
  const [errCode, setErrCode] = useState<ErrCode | null>(null);
  // The pipeline's specific failure reason (e.g. which stage broke and why).
  // Shown as a dim detail line so a failed cast is diagnosable, not just poetic.
  const [errDetail, setErrDetail] = useState<string | null>(null);
  // Bumping `attempt` re-runs the generation effect (Try again).
  const [attempt, setAttempt] = useState(0);
  // Smoothed bar value — creeps toward `ceilingPct` between stage events.
  const [displayPct, setDisplayPct] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const requestId = crypto.randomUUID();
    setStageState({});
    setPortraitFailed(false);
    setSkinFailed(false);
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
        if (res.ok) {
          // Refresh the library so the new companion occupies its slot, then
          // move to the meeting moment.
          void useDataStore.getState().loadCharacters().catch(() => {
            /* the reveal screen re-fetches the character on its own */
          });
          navigate({ kind: 'unique-reveal', characterId: res.characterId });
        } else {
          setErrCode(res.code);
          setErrDetail(res.message || null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrCode('generation_failed');
          setErrDetail(err instanceof Error ? err.message : null);
        }
      });

    return () => {
      cancelled = true;
      off();
    };
  }, [gender, attempt, navigate]);

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
    STAGE_ORDER.reduce(
      (acc, s) => acc + (stageState[s] === 'start' ? STAGE_WEIGHT[s] * 0.9 : 0),
      0,
    );

  // Creep the displayed value toward the ceiling; jump instantly when real
  // progress (a settled stage) lands. Never moves backwards. (Must run before
  // the error-state early return — hooks order.)
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

  // ── Error state ──────────────────────────────────────────────────────────
  if (errCode) {
    const copy = ERROR_COPY[errCode];
    return (
      <div className={styles.root}>
        <div className={styles.center}>
          <div className={styles.errTitle}>{copy.title}</div>
          <p className={styles.errBody}>{copy.body}</p>
          {errDetail ? (
            <p className={styles.errDetail} title={errDetail}>
              {errDetail.length > 200 ? `${errDetail.slice(0, 200)}…` : errDetail}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button kind="quiet" size="md" onClick={() => navigate({ kind: 'home' })}>
              Back
            </Button>
            <Button
              kind="accent"
              size="md"
              onClick={() => setAttempt((a) => a + 1)}
            >
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Progress state ───────────────────────────────────────────────────────
  const pct = Math.round(displayPct);
  // Show the EARLIEST in-flight stage — portrait and persona run in parallel,
  // and the first unfinished one is the honest headline.
  const activeStage =
    STAGE_ORDER.find((s) => stageState[s] === 'start') ??
    STAGE_ORDER.find((s) => stageState[s] !== 'done' && stageState[s] !== 'error') ??
    'saving';

  return (
    <div className={styles.root}>
      <div className={styles.center}>
        <div className={styles.eyebrow}>Casting your companion</div>
        <div className={styles.headline} aria-live="polite">
          {STAGE_COPY[activeStage]}
        </div>
        <div className={styles.barWrap}>
          <PercentBar value={pct} size="md" label={`Casting your companion, ${pct} percent`} />
        </div>
        {portraitFailed ? (
          <p className={styles.blurred}>Image generation failed. Continuing without a portrait.</p>
        ) : skinFailed ? (
          <p className={styles.blurred}>Skin generation failed. Continuing with the default skin.</p>
        ) : null}
      </div>
    </div>
  );
}
