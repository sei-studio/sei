/**
 * UpdatePopup — in-app updater modal (quick/260604-uoy).
 *
 * Replaces the old bottom-right UpdateToast (notify-and-redirect). Prop-driven,
 * single-modal surface for every updater state the renderer can be in:
 *
 *   - available-optional → minor/major update detected; shows the changelog up
 *     front with [Update now] / [Later]. "Update now" → sei.downloadUpdate().
 *   - forced → non-dismissable "Applying the update — restarting…" (apply:'now'
 *     mandatory path; main restarts automatically after a short delay).
 *   - whats-new → post-update changelog with [Got it].
 *
 * The download itself is NOT here (260801): progress and the "ready, restart to
 * apply" prompt moved out of the modal (260801), and since 261023 they live in
 * the sidebar "Update Sei" button (UpdateRailButton), which never blocks.
 * `forced` is the one updater state that still takes over the window, because
 * main quits and installs a few seconds later either way.
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
 *   - docs/design/in-app-updater-260604.md Task 6
 */
import React from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { stripDuplicateTitleHeading } from '../lib/changelog';
import { WINDOWS_UPDATE_NOTE, showsWindowsUpdateNote } from '../lib/stores/useUpdateStore';
import styles from './UpdatePopup.module.css';

/** The discriminated state the popup renders. */
export type UpdatePopupState =
  | { kind: 'available-optional'; currentVersion: string; latestVersion: string; changelog?: string }
  | { kind: 'forced' }
  | { kind: 'whats-new'; version: string; changelog: string };

export interface UpdatePopupProps {
  state: UpdatePopupState;
  /** Accept an optional update → download. */
  onUpdateNow?: () => void;
  /** Dismiss a dismissable state (Later / Got it). Omitted for forced. */
  onDismiss?: () => void;
  /**
   * Host OS (`process.platform`). On Windows the forced restart adds the
   * "takes about a minute, Sei reopens by itself" line (261030); main waits
   * FORCED_RESTART_DELAY_MS (3.5 s) before quitAndInstall, so it is read.
   */
  platform?: string;
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

export function UpdatePopup({ state, onUpdateNow, onDismiss, platform }: UpdatePopupProps): React.ReactElement {
  const t = useT();
  const dismissable = state.kind === 'available-optional' || state.kind === 'whats-new';

  // ESC dismisses only the dismissable states; `forced` never closes on ESC
  // (the restart is already in flight). ModalShell owns the keydown listener;
  // escClose is gated on `dismissable`.

  let body: React.ReactNode;
  let footer: React.ReactNode = null;
  let title = t('Update');

  switch (state.kind) {
    case 'available-optional':
      title = t('Update available');
      body = (
        <>
          <p className={styles.body}>
            {t('Sei {latest} is ready. You’re on {current}.', {
              latest: state.latestVersion,
              current: state.currentVersion,
            })}
          </p>
          {state.changelog ? (
            <div className={styles.changelog}>{renderChangelog(state.changelog)}</div>
          ) : null}
        </>
      );
      footer = (
        <>
          <Button kind="quiet" size="md" onClick={() => onDismiss?.()}>
            {t('Later')}
          </Button>
          <Button kind="primary" size="md" onClick={() => onUpdateNow?.()}>
            {t('Update now')}
          </Button>
        </>
      );
      break;

    case 'forced':
      title = t('Update ready');
      body = (
        <>
          <p className={styles.body}>{t('Applying the update. Sei will restart in a moment…')}</p>
          {showsWindowsUpdateNote(platform) ? (
            <p className={`${styles.body} ${styles.note}`}>{t(WINDOWS_UPDATE_NOTE)}</p>
          ) : null}
        </>
      );
      break;

    case 'whats-new':
      title = t('What’s new in {version}', { version: state.version });
      // 261020: the feed's changelog usually opens with the same "What's new
      // in X" line; don't show the title twice.
      body = (
        <div className={styles.changelog}>
          {renderChangelog(
            stripDuplicateTitleHeading(state.changelog, [title, `What’s new in ${state.version}`]),
          )}
        </div>
      );
      footer = (
        <Button kind="primary" size="md" onClick={() => onDismiss?.()}>
          {t('Got it')}
        </Button>
      );
      break;
  }

  return (
    // Stacked tier (1100) per the modal z-tier spec (OAuth / AutoRenewal /
    // UpdatePopup / ApiKeySetup). Non-dismissable states pin the shell open.
    <ModalShell
      title={title}
      width={460}
      tier="stacked"
      escClose={dismissable}
      onClose={dismissable ? onDismiss : undefined}
    >
      {body}
      {footer ? <ModalFooter>{footer}</ModalFooter> : null}
    </ModalShell>
  );
}
