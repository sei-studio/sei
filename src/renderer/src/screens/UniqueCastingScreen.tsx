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
 * Portrait/skin stage errors are NON-fatal — they surface a subtle
 * "(the vision blurred — continuing)" line rather than failing the ritual.
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
  const [blurred, setBlurred] = useState(false);
  const [errCode, setErrCode] = useState<ErrCode | null>(null);
  // Bumping `attempt` re-runs the generation effect (Try again).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const requestId = crypto.randomUUID();
    setStageState({});
    setBlurred(false);
    setErrCode(null);

    const off = sei.onGenProgress((ev) => {
      if (cancelled || ev.requestId !== requestId) return;
      setStageState((prev) => ({ ...prev, [ev.stage]: ev.status }));
      if (ev.status === 'error' && (ev.stage === 'portrait' || ev.stage === 'skin')) {
        setBlurred(true);
      }
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
        }
      })
      .catch(() => {
        if (!cancelled) setErrCode('generation_failed');
      });

    return () => {
      cancelled = true;
      off();
    };
  }, [gender, attempt, navigate]);

  // ── Error state ──────────────────────────────────────────────────────────
  if (errCode) {
    const copy = ERROR_COPY[errCode];
    return (
      <div className={styles.root}>
        <div className={styles.center}>
          <div className={styles.errTitle}>{copy.title}</div>
          <p className={styles.errBody}>{copy.body}</p>
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
  // 'error' counts as settled: portrait/skin errors are non-fatal (the pipeline
  // continues without art), so the bar must still reach 100% on a successful
  // cast instead of stalling at 60% and jumping to the reveal.
  const settledCount = STAGE_ORDER.filter(
    (s) => stageState[s] === 'done' || stageState[s] === 'error',
  ).length;
  const pct = Math.round((settledCount / STAGE_ORDER.length) * 100);
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
        {blurred ? (
          <p className={styles.blurred}>(the vision blurred — continuing)</p>
        ) : null}
      </div>
    </div>
  );
}
