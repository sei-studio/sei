/**
 * SetupWizardModal — first-launch / re-runnable Minecraft skin setup wizard.
 *
 * Top-level shell + step machine for the wizard. Renders a scrim + centered
 * 680×520 modal over the existing desktop wallpaper (matches LanModal scrim
 * alpha), traps focus inside the modal, dismisses on ESC, and crossfades
 * between steps with a 200ms opacity tween (motion-safe).
 *
 * Step machine (UI-SPEC §"First-launch wizard step-by-step copy"):
 *   - welcome  → Welcome panel; primary "Begin" calls runDetection
 *   - detecting → "Looking for Minecraft installs" while sei.detectMcInstalls runs
 *   - none-found → 1b branch — installs.length === 0 after detection
 *   - pick     → "Pick which installs to enable" with McInstallList
 *   - installing → "Setting up your installs" with InstallProgressList
 *   - one-failed → 3b branch — at least one install result.ok === false
 *   - done     → "All set"
 *
 * The wizard NEVER holds a renderer-side AbortController. The Cancel button on
 * the installing step calls `cancelInstall` — an async store action that fires
 * `sei.wizardCancel(sessionId)` across the IPC boundary. Main then aborts the
 * in-flight `java -jar fabric-installer` child process. ESC dismissal during
 * install also routes through the same IPC abort (via closeWizard →
 * wizardCancel if sessionId !== null).
 */

import React, { useEffect, useRef } from 'react';
import { Button } from './Button';
import { StatusPill } from './StatusPill';
import { ModalShell } from './ModalShell';
import { WizardStepShell } from './WizardStepShell';
import { McInstallList } from './McInstallList';
import { InstallProgressList } from './InstallProgressList';
import { useUiStore } from '../lib/stores/useUiStore';
import { useWizardStore, type WizardStep } from '../lib/stores/useWizardStore';
import { WARN_COPY } from '../lib/errors';
import styles from './SetupWizardModal.module.css';

export function SetupWizardModal(): React.ReactElement | null {
  const open = useWizardStore((s) => s.open);
  const step = useWizardStore((s) => s.step);
  const closeWizard = useWizardStore((s) => s.closeWizard);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // ── Focus trap: focus the first interactive element when the wizard opens
  //    or whenever the step changes. Tab / Shift+Tab wrap inside the modal.
  //    (ESC dismissal + the scrim are owned by ModalShell now.)
  useEffect(() => {
    if (!open) return;
    const node = contentRef.current;
    if (!node) return;

    // Focus the first focusable element so keyboard users land on the primary CTA.
    const focusables = node.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length > 0) {
      // Prefer the LAST focusable (typically the primary CTA in the footer).
      focusables[focusables.length - 1].focus();
    }

    const trap = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const list = node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', trap);
    return () => node.removeEventListener('keydown', trap);
  }, [open, step]);

  if (!open) return null;

  return (
    <ModalShell
      title={null}
      width={680}
      panelClassName={styles.wizardPanel}
      onClose={closeWizard}
      aria-label="Set up Minecraft skins"
    >
      {/* key on step so React unmounts/remounts on transition → CSS crossfade applies */}
      <div key={step} ref={contentRef} className={styles.stepContent}>
        {renderStep(step)}
      </div>
    </ModalShell>
  );
}

/**
 * The wizard's step machine WITHOUT the modal scrim/card — rendered inline by
 * the dedicated onboarding SkinSetupScreen so skin setup is a full page (matching
 * "What should they call you?") rather than a popup. Reads the same useWizardStore
 * step; the step components' terminal actions (closeWizard) are watched by the
 * host screen to advance the onboarding flow. The `key` drives the crossfade.
 */
export function WizardStepMachine(): React.ReactElement {
  const step = useWizardStore((s) => s.step);
  return (
    <div key={step} className={styles.stepContent}>
      {renderStep(step)}
    </div>
  );
}

function renderStep(step: WizardStep): React.ReactElement {
  switch (step) {
    case 'welcome':
      return <WelcomeStep />;
    case 'detecting':
      return <DetectingStep />;
    case 'none-found':
      return <NoneFoundStep />;
    case 'pick':
      return <PickInstallsStep />;
    case 'installing':
      return <InstallingStep />;
    case 'one-failed':
      return <OneFailedStep />;
    case 'done':
      return <DoneStep />;
  }
}

/* -------------------------------------------------------------------------- */
/*  Step components — verbatim copy from 09-UI-SPEC §"First-launch wizard"     */
/* -------------------------------------------------------------------------- */

function WelcomeStep(): React.ReactElement {
  const isReentry = useWizardStore((s) => s.isReentry);
  const runDetection = useWizardStore((s) => s.runDetection);
  const closeWizard = useWizardStore((s) => s.closeWizard);
  return (
    <WizardStepShell
      stepNumber={null}
      heading="Set up Minecraft skins"
      footer={
        <>
          {isReentry ? (
            <Button kind="quiet" size="md" onClick={closeWizard}>
              Back to settings
            </Button>
          ) : (
            // First-launch onboarding: the skip control belongs in the footer
            // row, aligned with Begin. It previously lived in a separate row
            // BELOW the panel (SkinSetupScreen.skipRow), which made it sit lower
            // than the primary CTA. closeWizard routes the onboarding page to
            // home (SkinSetupScreen finalizes on open→closed).
            <Button kind="quiet" size="md" onClick={closeWizard}>
              Set up later
            </Button>
          )}
          <Button kind="accent" size="md" onClick={() => void runDetection()}>
            Begin
          </Button>
        </>
      }
    >
      <p>
        Sei can give each companion a custom skin and username inside your Minecraft
        world. We&apos;ll install a small mod (CustomSkinLoader) into your Minecraft
        profile. Takes about a minute.
      </p>
    </WizardStepShell>
  );
}

function DetectingStep(): React.ReactElement {
  const closeWizard = useWizardStore((s) => s.closeWizard);
  return (
    <WizardStepShell
      stepNumber={1}
      heading="Looking for Minecraft installs"
      footer={
        <>
          <span />
          <Button kind="quiet" size="md" onClick={closeWizard}>
            Cancel
          </Button>
        </>
      }
    >
      <div role="status" aria-live="polite">
        <p>
          Scanning your Minecraft launcher and CurseForge instances. This stays on
          your computer.
        </p>
      </div>
    </WizardStepShell>
  );
}

function NoneFoundStep(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const closeWizard = useWizardStore((s) => s.closeWizard);
  const runDetection = useWizardStore((s) => s.runDetection);
  return (
    <WizardStepShell
      stepNumber={null}
      heading="We couldn't find Minecraft"
      footer={
        <>
          <Button kind="quiet" size="md" onClick={() => void runDetection()}>
            Try again
          </Button>
          <Button
            kind="primary"
            size="md"
            onClick={() => {
              closeWizard();
              navigate({ kind: 'settings' });
            }}
          >
            Open settings
          </Button>
        </>
      }
    >
      <p>
        Sei looked in the usual places and didn&apos;t find a Minecraft install.
        Install Minecraft from minecraft.net or the CurseForge app, then re-run
        this wizard from Settings.
      </p>
    </WizardStepShell>
  );
}

function PickInstallsStep(): React.ReactElement {
  const installs = useWizardStore((s) => s.installs);
  const selectedIds = useWizardStore((s) => s.selectedIds);
  const toggleSelected = useWizardStore((s) => s.toggleSelected);
  const gotoStep = useWizardStore((s) => s.gotoStep);
  const runInstall = useWizardStore((s) => s.runInstall);
  return (
    <WizardStepShell
      stepNumber={2}
      heading="Pick which installs to enable"
      footer={
        <>
          <Button kind="quiet" size="md" onClick={() => gotoStep('welcome')}>
            Back
          </Button>
          <Button
            kind="primary"
            size="md"
            disabled={selectedIds.size === 0}
            onClick={() => void runInstall()}
          >
            Continue
          </Button>
        </>
      }
    >
      <p>
        Sei will install Fabric Loader and CustomSkinLoader into each install you
        select. Already-modded CurseForge instances get only the mod jar.
      </p>
      <McInstallList
        installs={installs}
        selectedIds={selectedIds}
        onToggle={toggleSelected}
      />
    </WizardStepShell>
  );
}

function InstallingStep(): React.ReactElement {
  const installs = useWizardStore((s) => s.installs);
  const selectedIds = useWizardStore((s) => s.selectedIds);
  const progress = useWizardStore((s) => s.progress);
  const results = useWizardStore((s) => s.results);
  const cancelInstall = useWizardStore((s) => s.cancelInstall);
  const selected = installs.filter((i) => selectedIds.has(i.id));
  return (
    <WizardStepShell
      stepNumber={3}
      heading="Setting up your installs"
      footer={
        <>
          <span />
          <Button kind="quiet" size="md" onClick={() => void cancelInstall()}>
            Cancel
          </Button>
        </>
      }
    >
      <div role="status" aria-live="polite">
        <p>
          Downloading Fabric Loader and CustomSkinLoader. Don&apos;t close Minecraft
          if it&apos;s open.
        </p>
        <InstallProgressList
          installs={selected}
          progress={progress}
          results={results}
        />
      </div>
    </WizardStepShell>
  );
}

function OneFailedStep(): React.ReactElement {
  const installs = useWizardStore((s) => s.installs);
  const selectedIds = useWizardStore((s) => s.selectedIds);
  const progress = useWizardStore((s) => s.progress);
  const results = useWizardStore((s) => s.results);
  const gotoStep = useWizardStore((s) => s.gotoStep);
  const runInstall = useWizardStore((s) => s.runInstall);

  // Surface the first failing install's name + plain-english error in the body copy.
  const failedResult = results.find((r) => !r.ok);
  const failedInstall = failedResult
    ? installs.find((i) => i.id === failedResult.installId)
    : null;
  const failedName = failedInstall?.label ?? 'One install';
  const failedMessage = failedResult?.message ?? 'an unknown error';

  // Bring failed install rows to the top of the InstallProgressList.
  const selected = installs.filter((i) => selectedIds.has(i.id));
  const failedIds = new Set(results.filter((r) => !r.ok).map((r) => r.installId));
  const reordered = [
    ...selected.filter((i) => failedIds.has(i.id)),
    ...selected.filter((i) => !failedIds.has(i.id)),
  ];

  return (
    <WizardStepShell
      stepNumber={null}
      heading="One install couldn't finish"
      footer={
        <>
          <Button kind="quiet" size="md" onClick={() => void runInstall()}>
            Try again
          </Button>
          <Button kind="primary" size="md" onClick={() => gotoStep('done')}>
            Continue anyway
          </Button>
        </>
      }
    >
      <p>
        {failedName} hit an error: {failedMessage}. The other installs are ready.
        You can re-run setup for this one later from Settings.
      </p>
      <InstallProgressList
        installs={reordered}
        progress={progress}
        results={results}
      />
    </WizardStepShell>
  );
}

function DoneStep(): React.ReactElement {
  const installs = useWizardStore((s) => s.installs);
  const selectedIds = useWizardStore((s) => s.selectedIds);
  const results = useWizardStore((s) => s.results);
  const error = useWizardStore((s) => s.error);
  const closeWizard = useWizardStore((s) => s.closeWizard);

  // The done step is also reached from one-failed via "Continue anyway", so it
  // must NOT unconditionally claim success. Treat a stored install error or any
  // failed result as a partial outcome (empty results + an error = a total
  // failure that still routed here). Only an all-ok run earns the green pill.
  const anyFailed = error != null || results.some((r) => !r.ok);

  // Derive a representative profile name for the body copy. For vanilla installs
  // the launcher shows a "fabric-loader-{loaderVersion}-{mcVersion}" profile; for
  // CurseForge instances the launcher shows the instance name directly.
  const profileName = (() => {
    const first = installs.find((i) => selectedIds.has(i.id));
    if (!first) return 'your modded';
    if (first.kind === 'vanilla') {
      const lv = first.loader_version ?? '';
      const mv = first.mc_version ?? '';
      if (lv && mv) return `fabric-loader-${lv}-${mv}`;
      return 'Fabric Loader';
    }
    return first.label;
  })();

  // 260518-o1k T7: per-install mod-link summaries on the done step. Only
  // vanilla installs carry modLinkSummary (CurseForge instances are already
  // isolated; Lunar never reaches the link stage). Render one block per
  // install that has a summary attached.
  const summaries = results
    .filter((r) => r.ok && r.modLinkSummary)
    .map((r) => ({
      result: r,
      install: installs.find((i) => i.id === r.installId),
    }))
    .filter((x): x is { result: typeof x.result; install: NonNullable<typeof x.install> } => x.install != null);

  return (
    <WizardStepShell
      stepNumber={4}
      heading={anyFailed ? 'Setup finished with issues' : 'All set'}
      footer={
        <>
          <span />
          <Button kind="accent" size="md" onClick={closeWizard}>
            Finish setup
          </Button>
        </>
      }
    >
      <div style={{ marginBottom: 'var(--space-md)' }}>
        {anyFailed ? (
          <StatusPill tone="warn" label="Some installs skipped" />
        ) : (
          <StatusPill tone="green" label="All set" />
        )}
      </div>
      <p>
        {anyFailed
          ? `Some installs didn't finish, but the rest are ready. Open Minecraft, pick the ${profileName} profile from the launcher dropdown, and start your world. You can re-run setup for the others from Settings.`
          : `Open Minecraft, pick the ${profileName} profile from the launcher dropdown, and start your world. Companions will appear with their chosen skin and username.`}
      </p>

      {summaries.length > 0 ? (
        <div className={styles.modLinkSummary}>
          {summaries.map(({ result, install }) => {
            const summary = result.modLinkSummary!;
            return (
              <div key={install.id} style={{ marginBottom: 'var(--space-md)' }}>
                <h4>{install.label}</h4>
                <p>
                  Linked {summary.linked} mod{summary.linked === 1 ? '' : 's'}
                  {summary.excluded > 0
                    ? `, excluded ${summary.excluded} (wrong MC version or unreadable metadata).`
                    : '.'}
                </p>
                {summary.excludedJars.length > 0 ? (
                  <details>
                    <summary>Show excluded mods</summary>
                    <ul className={styles.modLinkExclusionList}>
                      {summary.excludedJars.map((j) => {
                        // 260518-o1k T8: tooltips on the unparseable /
                        // read-error / no-metadata rows surface the
                        // MOD_SCAN_PARSE_FAIL guidance ("copy into
                        // <install>/sei/mods/ manually if it's actually
                        // compatible"). mc-version-mismatch rows already
                        // show the declared MC inline so no tooltip
                        // needed.
                        const tooltip =
                          j.reason === 'unparseable' ||
                          j.reason === 'read-error' ||
                          j.reason === 'no-metadata'
                            ? WARN_COPY.MOD_SCAN_PARSE_FAIL
                            : undefined;
                        return (
                          <li key={j.name} title={tooltip}>
                            {j.name}:{' '}
                            {j.reason === 'mc-version-mismatch' && j.declaredMc
                              ? `targets MC ${j.declaredMc}`
                              : j.reason === 'mc-version-mismatch'
                                ? 'wrong MC version'
                                : j.reason === 'unparseable'
                                  ? 'metadata unreadable'
                                  : j.reason === 'no-metadata'
                                    ? 'no mod metadata'
                                    : 'read error'}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </WizardStepShell>
  );
}
