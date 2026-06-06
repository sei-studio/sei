/**
 * InstallProgressList — per-install progress rows during the wizard's Installing step.
 *
 * For each ordered install, renders a row containing:
 *   - Left: install label (sans 14px) + path (mono 12px, --text-2)
 *   - Right: a stage label, an optional 4px progress bar for *-downloading
 *     stages, or a terminal StatusPill on done/failed/cancelled
 *
 * Progress events are keyed by installId in the Map<installId, WizardProgressEvent>
 * passed in via props. If no event has arrived yet, the row reads "Queued".
 *
 * The `cancelled` event variant is rendered as a muted StatusPill — distinct
 * from `failed` because cancellation is a user action, not an error condition.
 */

import React from 'react';
import type { McInstall, WizardInstallResult, WizardProgressEvent } from '@shared/ipc';
import { StatusPill } from './StatusPill';
import styles from './InstallProgressList.module.css';

export interface InstallProgressListProps {
  installs: McInstall[];
  progress: Map<string, WizardProgressEvent>;
  results: WizardInstallResult[];
}

interface StageRender {
  label: string;
  pct: number | null;
  /** Terminal: render a StatusPill instead of a stage label. */
  terminal: 'done' | 'failed' | 'cancelled' | null;
  /** Secondary text under a terminal pill (e.g. failure message). */
  terminalSecondary?: string;
}

/**
 * Map a WizardProgressEvent (or absence) to its visual descriptor.
 */
function describeStage(ev: WizardProgressEvent | undefined): StageRender {
  if (!ev) return { label: 'Queued', pct: null, terminal: null };
  switch (ev.stage) {
    case 'queued':
      return { label: 'Queued', pct: null, terminal: null };
    case 'fabric-downloading':
      return {
        label: `Downloading Fabric Loader… ${ev.pct}%`,
        pct: ev.pct,
        terminal: null,
      };
    case 'fabric-installing':
      return { label: 'Installing Fabric Loader…', pct: null, terminal: null };
    case 'mods-linking': {
      // 260518-o1k T7: scan/link counters. Before totalEstimate is known
      // (the first event the orchestrator fires) we show "Scanning your
      // mods…" with no numerics. After readdir lands we show
      // "Scanning your mods (linked X of Y so far, Z excluded)."
      if (ev.totalEstimate == null) {
        return { label: 'Scanning your mods…', pct: null, terminal: null };
      }
      return {
        label: `Scanning your mods (linked ${ev.linked} of ${ev.totalEstimate} so far, ${ev.excluded} excluded).`,
        pct: null,
        terminal: null,
      };
    }
    case 'mod-downloading':
      return {
        label: `Downloading CustomSkinLoader… ${ev.pct}%`,
        pct: ev.pct,
        terminal: null,
      };
    case 'mod-placing':
      return { label: 'Placing mod…', pct: null, terminal: null };
    case 'config-writing':
      return { label: 'Writing config…', pct: null, terminal: null };
    case 'done':
      return { label: 'Setup complete', pct: null, terminal: 'done' };
    case 'failed':
      return {
        label: 'Setup failed',
        pct: null,
        terminal: 'failed',
        terminalSecondary: ev.message,
      };
    case 'cancelled':
      return { label: 'Cancelled', pct: null, terminal: 'cancelled' };
  }
}

export function InstallProgressList({
  installs,
  progress,
  results,
}: InstallProgressListProps): React.ReactElement {
  return (
    <div className={styles.list}>
      {installs.map((install) => {
        const ev = progress.get(install.id);
        // Prefer result-derived terminal state once results have settled (e.g. after
        // runWizardInstall resolves) — covers the edge case where a `failed` push
        // event was racing the final resolve.
        const result = results.find((r) => r.installId === install.id);
        let render = describeStage(ev);
        if (result && !render.terminal) {
          if (result.ok) {
            render = { label: 'Setup complete', pct: null, terminal: 'done' };
          } else {
            render = {
              label: 'Setup failed',
              pct: null,
              terminal: 'failed',
              terminalSecondary: result.message,
            };
          }
        }
        return (
          <div key={install.id} className={styles.row}>
            <div className={styles.text}>
              <div className={styles.label}>{install.label}</div>
              <div className={styles.path}>{install.path}</div>
            </div>
            <div className={styles.stage}>
              {render.terminal === 'done' ? (
                <span className={styles.checkMark}>
                  <StatusPill tone="green" label="Setup complete" />
                </span>
              ) : render.terminal === 'failed' ? (
                <StatusPill
                  tone="red"
                  label="Setup failed"
                  secondary={render.terminalSecondary}
                />
              ) : render.terminal === 'cancelled' ? (
                <StatusPill tone="muted" label="Cancelled" />
              ) : (
                <div className={styles.inFlight}>
                  <div className={styles.stageLabel}>{render.label}</div>
                  {render.pct !== null ? (
                    <div
                      className={styles.bar}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={render.pct}
                      aria-label={`${install.label}: ${render.label}`}
                    >
                      <div
                        className={styles.barFill}
                        style={{ width: `${render.pct}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
