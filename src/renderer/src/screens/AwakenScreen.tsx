/**
 * AwakenScreen — the "awaken a companion" chooser view (Party redesign §4.3).
 * Replaces AddCompanionChooserModal: a full view (rail visible) with the
 * flagship "Meet my companion" match hero on the left and the two secondary
 * origins (create my own / invite from World) stacked on the right.
 *
 * Gates (moved verbatim from the old HomeGrid handlers):
 *   - Meet my companion → signed-in + cloud backend required, else SignInModal with
 *     the "meet your unique companion" framing; then the first-sign-in
 *     questionnaire gate (prefsGet) routes to profile-questions or straight to
 *     the unique-gender step. Config/prefs reads fail OPEN.
 *   - Create your own → daily creation quota (checkCreateQuota) shows
 *     CreationLimitModal when blocked, else the add-character wizard.
 *   - Invite from World → Home's World tab.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §4.3; mockup view-awaken.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { GatherPixels } from '../components/GatherPixels';
import { Button } from '../components/Button';
import { SignInModal } from '../components/SignInModal';
import { CreationLimitModal } from '../components/CreationLimitModal';
import styles from './AwakenScreen.module.css';

export function AwakenScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const authKind = useAuthStore((s) => s.state.kind);
  const setUpgradeFraming = useAuthStore((s) => s.setUpgradeFraming);
  const upgradeFraming = useAuthStore((s) => s.upgradeFraming);
  const [showSignIn, setShowSignIn] = useState<boolean>(false);
  const [createLimit, setCreateLimit] = useState<{ resetsAt: string | null } | null>(null);

  // The hero CTA label tells the truth about what the click does (260705):
  // signed-out or local-backend (BYOK) users get routed to sign-in first, so
  // show "Sign In" instead of "Begin" for them. Config read fails open to
  // "Begin" — same fail-open stance as handleBegin's own gate.
  const [backendLocal, setBackendLocal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void sei
      .getConfig()
      .then((cfg) => {
        if (!cancelled) setBackendLocal((cfg.ai_backend_kind ?? 'local') !== 'cloud-proxy');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const beginLabel = authKind !== 'signed_in' || backendLocal ? 'Sign In' : 'Begin';

  // Flagship "Be matched" path. Cloud + signed-in only: a signed-out user OR a
  // local-mode (BYOK) user is routed to the sign-in modal (framed for this
  // action). When eligible, run the first-sign-in questionnaire gate if it
  // hasn't been answered yet, then land on the per-slot gender question.
  const handleBegin = async (): Promise<void> => {
    if (authKind !== 'signed_in') {
      setUpgradeFraming('meet your unique companion');
      setShowSignIn(true);
      return;
    }
    let backendLocal = false;
    try {
      const cfg = await sei.getConfig();
      backendLocal = (cfg.ai_backend_kind ?? 'local') !== 'cloud-proxy';
    } catch {
      // Fail OPEN — let the generation pipeline surface any real backend issue
      // rather than blocking an eligible user on a transient config read.
      backendLocal = false;
    }
    if (backendLocal) {
      setUpgradeFraming('meet your unique companion');
      setShowSignIn(true);
      return;
    }
    try {
      const prefs = await sei.prefsGet();
      // 260706: gate on MISSING answers, not just never-completed — a
      // questionnaire abandoned partway, or completed before a newer
      // question shipped, asks exactly the gaps before casting.
      if (prefs.missing.length > 0) {
        navigate({ kind: 'profile-questions', next: 'unique-gender', mode: 'missing' });
        return;
      }
    } catch {
      // Fail open — proceed to the gender step; the pipeline can still run.
    }
    navigate({ kind: 'unique-gender' });
  };

  // The existing custom wizard, gated on the daily creation quota.
  // checkCreateQuota fails open (blocked:false) for BYOK users and on any
  // error, so this never wrongly blocks creation.
  const handleCreate = async (): Promise<void> => {
    const quota = await sei.checkCreateQuota();
    if (quota.blocked) {
      setCreateLimit({ resetsAt: quota.resetsAt });
      return;
    }
    navigate({ kind: 'add-character' });
  };

  const handleWorld = (): void => {
    // Analytics (260707): the World (public-character discovery) tab was opened.
    sei.track('world_browsed');
    setHomeTab('world');
    navigate({ kind: 'home' });
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <Button kind="quiet" size="sm" onClick={() => navigate({ kind: 'home' })}>
          ← Back
        </Button>
      </div>
      <div className={styles.body}>
        <button
          type="button"
          className={styles.matched}
          onClick={() => void handleBegin()}
        >
          <span className={styles.matchedSky} aria-hidden="true" />
          <GatherPixels cycle="a" large className={styles.mark} />
          <h2 className={styles.matchedTitle}>Meet my companion</h2>
          <p className={styles.matchedSub}>Match with a companion meant for you.</p>
          <span className={styles.go}>{beginLabel}</span>
        </button>
        <div className={styles.origins}>
          <button type="button" className={styles.origin} onClick={() => void handleCreate()}>
            <h3 className={styles.originTitle}>Create my own</h3>
            <p className={styles.originSub}>Design from scratch.</p>
          </button>
          <button type="button" className={styles.origin} onClick={handleWorld}>
            <h3 className={styles.originTitle}>Invite from World</h3>
            <p className={styles.originSub}>Browse existing companions.</p>
          </button>
        </div>
      </div>
      {/* 260706: retake entry — the full questionnaire, prefilled, returning
          here. Signed-in only (the questionnaire is a cloud-user concept,
          same as the match hero). */}
      {authKind === 'signed_in' ? (
        <div className={styles.foot}>
          <button
            type="button"
            className={styles.prefsLink}
            onClick={() => navigate({ kind: 'profile-questions', next: 'awaken', mode: 'all' })}
          >
            Update my preferences
          </button>
        </div>
      ) : null}
      {showSignIn ? (
        <SignInModal framingLabel={upgradeFraming} onClose={() => setShowSignIn(false)} />
      ) : null}
      {createLimit ? (
        <CreationLimitModal resetsAt={createLimit.resetsAt} onClose={() => setCreateLimit(null)} />
      ) : null}
    </div>
  );
}
