/**
 * UpdatePopup — in-app updater modal (quick/260604-uoy).
 *
 * Replaces the old bottom-right UpdateToast (notify-and-redirect). Prop-driven,
 * single-modal surface for every updater state the renderer can be in:
 *
 *   - available-optional → minor/major update detected; shows the changelog up
 *     front with [Update now] / [Later]. "Update now" → sei.downloadUpdate().
 *   - downloading → PercentBar progress while the accepted update downloads.
 *   - downloaded → brief "restarting…" then the parent invokes installUpdate().
 *   - downloaded-on-restart → mandatory patch finished downloading; dismissable
 *     "Update ready — restart to apply" with [Later] / [Restart now] so the
 *     download bar can't hang at 100% (applies on next quit regardless).
 *   - forced → non-dismissable "Critical update — restarting…" (apply:'now'
 *     mandatory path; main restarts automatically after a short delay).
 *   - whats-new → post-update changelog with [Got it].
 *
 * Follows the existing modal pattern (AutoRenewalConsentModal): a fixed scrim
 * + a sharp-cornered card built from design tokens (never literal hex/px),
 * reusing Button (kinds primary/accent/ghost/quiet/danger) and PercentBar.
 * The changelog renders with a tiny inline markdown subset (## heading, -
 * bullet) — no new dependency.
 *
 * Source:
 *   - src/renderer/src/components/AutoRenewalConsentModal.tsx (modal template)
 *   - src/renderer/src/components/Button.tsx / PercentBar.tsx (reused primitives)
 *   - .planning/quick/260604-uoy-... PLAN.md Task 6
 */
import React, { useEffect, useId } from 'react';
import { Button } from './Button';
import { PercentBar } from './PercentBar';
import styles from './UpdatePopup.module.css';

/** The discriminated state the popup renders. */
export type UpdatePopupState =
  | { kind: 'available-optional'; currentVersion: string; latestVersion: string; changelog?: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded' }
  | { kind: 'downloaded-on-restart' }
  | { kind: 'forced' }
  | { kind: 'whats-new'; version: string; changelog: string };

export interface UpdatePopupProps {
  state: UpdatePopupState;
  /** Accept an optional update → download. */
  onUpdateNow?: () => void;
  /** Dismiss a dismissable state (Later / Got it). Omitted for forced. */
  onDismiss?: () => void;
}

/**
 * Render a minimal markdown subset to React nodes: `## heading` → a styled
 * heading, `- bullet` → a list item, everything else → a paragraph line. No
 * HTML is ever injected (no dangerouslySetInnerHTML) — plain text only, so a
 * malicious/garbled changelog can't inject markup.
 */
function renderChangelog(text: string): React.ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (keyBase: number): void => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${keyBase}`} className={styles.changelogList}>
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      flushBullets(idx);
      out.push(
        <div key={`h-${idx}`} className={styles.changelogHeading}>
          {line.replace(/^##\s+/, '')}
        </div>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flushBullets(idx);
    } else {
      flushBullets(idx);
      out.push(
        <p key={`p-${idx}`} className={styles.changelogPara}>
          {line.replace(/^#\s+/, '')}
        </p>,
      );
    }
  });
  flushBullets(lines.length);
  return out;
}

export function UpdatePopup({ state, onUpdateNow, onDismiss }: UpdatePopupProps): React.ReactElement {
  const titleId = useId();
  const dismissable =
    state.kind === 'available-optional' ||
    state.kind === 'whats-new' ||
    state.kind === 'downloaded-on-restart';

  // ESC dismisses only the dismissable states; forced/downloading/downloaded
  // never close on ESC (the restart is in flight / about to be).
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissable, onDismiss]);

  let body: React.ReactNode;
  let footer: React.ReactNode = null;
  let title = 'Update';

  switch (state.kind) {
    case 'available-optional':
      title = 'Update available';
      body = (
        <>
          <p className={styles.body}>
            Sei {state.latestVersion} is ready. You’re on {state.currentVersion}.
          </p>
          {state.changelog ? (
            <div className={styles.changelog}>{renderChangelog(state.changelog)}</div>
          ) : null}
        </>
      );
      footer = (
        <>
          <Button kind="quiet" size="md" onClick={() => onDismiss?.()}>
            Later
          </Button>
          <Button kind="primary" size="md" onClick={() => onUpdateNow?.()}>
            Update now
          </Button>
        </>
      );
      break;

    case 'downloading':
      title = 'Downloading update';
      body = (
        <>
          <p className={styles.body}>Downloading the latest version…</p>
          <PercentBar value={state.percent} label={`Downloading update, ${Math.round(state.percent)} percent`} size="md" />
        </>
      );
      break;

    case 'downloaded':
      title = 'Update ready';
      body = <p className={styles.body}>Update downloaded. Restarting…</p>;
      break;

    case 'downloaded-on-restart':
      title = 'Update ready';
      body = (
        <p className={styles.body}>
          Update downloaded. It’ll apply the next time you restart Sei.
        </p>
      );
      footer = (
        <>
          <Button kind="quiet" size="md" onClick={() => onDismiss?.()}>
            Later
          </Button>
          <Button kind="primary" size="md" onClick={() => onUpdateNow?.()}>
            Restart now
          </Button>
        </>
      );
      break;

    case 'forced':
      title = 'Critical update';
      body = <p className={styles.body}>Critical update. Restarting…</p>;
      break;

    case 'whats-new':
      title = `What’s new in ${state.version}`;
      body = <div className={styles.changelog}>{renderChangelog(state.changelog)}</div>;
      footer = (
        <Button kind="primary" size="md" onClick={() => onDismiss?.()}>
          Got it
        </Button>
      );
      break;
  }

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {body}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
