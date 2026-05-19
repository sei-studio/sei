/**
 * Wizard install orchestrator (Phase 9 Plan 05 Task 1).
 *
 * Composes the four Plan 04 modules — mcInstallScan, fabricInstaller,
 * customSkinLoader, wizardStateStore — into a single
 * `runWizardInstall(args)` flow that the renderer drives via the
 * `wizard:install` IPC handler.
 *
 * Three exports:
 *   - `runWizardInstall(args)` — the orchestrator. For each selected install
 *     id, in series: scan-match → (vanilla only) installFabricLoader →
 *     downloadCustomSkinLoader → writeCustomSkinLoaderConfig → persist state.
 *     Emits per-step `WizardProgressEvent`s via `args.onProgress` (which
 *     the IPC handler forwards via `webContents.send` on the
 *     `wizard:progress` push channel).
 *   - `registerWizardSession(sessionId)` — allocates a new AbortController
 *     and stores it in a module-private `Map<sessionId, AbortController>`.
 *     `runWizardInstall` calls this on entry; explicit export lets tests
 *     introspect.
 *   - `abortWizardSession(sessionId)` — the BLOCKER 2 mechanism. Looks up
 *     the session's AbortController and fires `.abort()` so the in-flight
 *     fetch / execFile / writeFile in the Plan 04 modules unwinds through
 *     the AbortSignal chain. Returns true if a session was aborted.
 *
 * Cross-cutting:
 *   - SERIES not parallel. Multiple concurrent `java -jar fabric-installer`
 *     processes would thrash CPU + the UI shows one progress row at a
 *     time per UI-SPEC §InstallProgressList.
 *   - On abort mid-run, we emit `cancelled` for the current install and
 *     BREAK the loop — the user cancelled the whole run, not just this row.
 *   - The session entry is `finally`-deleted at the end of `runWizardInstall`
 *     so cancellation after completion is a silent no-op (the map lookup
 *     returns undefined → abortWizardSession returns false).
 *   - Loader-kind decision: vanilla → fabric (installer runs Fabric step
 *     first if no loader present yet); curseforge → uses the scan's
 *     detected loader (forge/fabric), defaulting to forge for null because
 *     the vast majority of CF modpacks ship Forge.
 *
 * Sources:
 *   - 09-05-PLAN Task 1
 *   - src/main/mcInstallScan.ts (scanMcInstalls)
 *   - src/main/fabricInstaller.ts (installFabricLoader)
 *   - src/main/customSkinLoader.ts (downloadCustomSkinLoader + writeCustomSkinLoaderConfig)
 *   - src/main/wizardStateStore.ts (loadWizardState + saveWizardState)
 *   - CONTEXT.md §"First-launch wizard scope" (5 steps the orchestrator implements)
 *   - 09-01-PLAN BLOCKER 2 (IPC-crossing abort via Map<sessionId, AbortController>)
 */
import path from 'node:path';
import { scanMcInstalls } from './mcInstallScan';
import { installFabricLoader } from './fabricInstaller';
import { downloadCustomSkinLoader, writeCustomSkinLoaderConfig } from './customSkinLoader';
import { loadWizardState, saveWizardState } from './wizardStateStore';
import type { McInstall, WizardInstallResult, WizardProgressEvent } from '../shared/ipc';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/**
 * Module-private session registry. One entry per in-flight runWizardInstall.
 * Keyed by the renderer-generated `sessionId` (typically `crypto.randomUUID()`).
 * The AbortController is what `wizard:cancel` fires `.abort()` on; the signal
 * threads through every Plan 04 external call (fetch / execFile / writeFile).
 *
 * Single source of truth for cancellation (BLOCKER 2 fix). A renderer-side
 * AbortController cannot reach the main-process child `java -jar fabric-installer`
 * subprocess; this map lets the renderer's `wizard:cancel(sessionId)` IPC call
 * cross the process boundary and SIGTERM the running installer.
 */
const sessions = new Map<string, AbortController>();

/**
 * Fallback MC version when `launcher_profiles.json` is unreadable or absent.
 * Picked to be a known-good Fabric-compatible version that's been released
 * long enough that meta.fabricmc.net has stable loader+installer entries.
 * Surfaces as a UI warning ("we couldn't read your MC version; defaulting to
 * 1.21.4") but doesn't block setup.
 */
const DEFAULT_MC_VERSION = '1.21.4';

/**
 * Allocate a fresh AbortController for the given sessionId and store it in
 * the module's session map. If a session with the same id already exists,
 * we abort the previous one first (defensive — shouldn't happen with
 * `crypto.randomUUID()` but cheap to guard against).
 *
 * Returns the new controller so the caller (typically `runWizardInstall`)
 * can pass `controller.signal` down to its external calls.
 */
export function registerWizardSession(sessionId: string): AbortController {
  const existing = sessions.get(sessionId);
  if (existing) {
    // Defensive: a duplicate sessionId means somehow two runWizardInstalls
    // started with the same id. Cancel the previous so we don't leave a
    // dangling controller in the map.
    try { existing.abort(new Error('WIZARD_CANCELLED: superseded by new session')); } catch { /* ignore */ }
  }
  const ctl = new AbortController();
  sessions.set(sessionId, ctl);
  return ctl;
}

/**
 * Abort the AbortController for the given session, if one exists. Returns
 * true if a session was found and aborted; false if no such session
 * (already cleaned up / never existed). This is the BLOCKER 2 IPC-crossing
 * abort entry point — `wizard:cancel` IPC handler calls into here.
 *
 * We do NOT delete the map entry here. `runWizardInstall`'s finally block
 * is the single owner of cleanup; deleting here too could race with
 * `registerWizardSession`'s superseded-session guard.
 */
export function abortWizardSession(sessionId: string): boolean {
  const ctl = sessions.get(sessionId);
  if (!ctl) return false;
  ctl.abort(new Error('WIZARD_CANCELLED: user cancelled'));
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export interface RunWizardInstallArgs {
  /** Renderer-generated routing key (typically `crypto.randomUUID()`). */
  sessionId: string;
  /** Subset of `scanMcInstalls()` ids the user selected in the wizard UI. */
  installIds: string[];
  /** e.g. `http://127.0.0.1:54321` — captured from `skin:get-server-url`. */
  skinServerBaseUrl: string;
  /**
   * Per-step progress callback. The IPC handler forwards each event to
   * the renderer via `webContents.send(IpcChannel.wizard.progress, ev)`.
   */
  onProgress: (ev: WizardProgressEvent) => void;
}

/**
 * Determine which loader kind to use for the CSL download step, based on
 * the McInstall record. Vanilla → fabric (installer puts Fabric Loader in
 * place first; CSL Fabric build follows). CurseForge → use whatever the
 * scanner detected; default to forge for null because the vast majority of
 * CF modpacks ship Forge.
 */
function decideLoaderKind(install: McInstall): 'fabric' | 'forge' {
  if (install.kind === 'vanilla') return 'fabric';
  // CurseForge: respect the detected loader; fall back to forge.
  if (install.loader === 'fabric') return 'fabric';
  return 'forge';
}

/**
 * Heuristic test: is this rejection a cancellation (vs. a real failure)?
 * Plan 04's modules throw Errors with messages like `FABRIC_INSTALL_FAILED:
 * cancelled` / `MOD_DOWNLOAD_FAILED: cancelled` when the abort signal fires
 * mid-operation. We classify by literal-substring match because that's
 * what the modules emit; the alternative (checking the controller signal
 * directly) is less robust if the user fires abort during the brief
 * synchronous post-await window.
 */
function isCancellationError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cancelled/i.test(msg);
}

/**
 * Execute the wizard against a list of selected installs. Returns one
 * `WizardInstallResult` per install id (in the order supplied), including
 * `ok: false` rows for ids that no longer exist or were cancelled.
 *
 * NEVER throws — every install's failure is captured into the results
 * array so the renderer can render a per-row error state. The only
 * rejection path is invalid sessionId, which is a programmer error
 * surfaced before any state mutation.
 */
export async function runWizardInstall(
  args: RunWizardInstallArgs,
): Promise<{ results: WizardInstallResult[] }> {
  const { sessionId, installIds, skinServerBaseUrl, onProgress } = args;

  // ── Pre-flight: validate sessionId ────────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string') {
    // Empty / non-string sessionId is a programmer error from the IPC
    // boundary (zod should have rejected). Surface as a hard error so a
    // misuse upstream is visible during dev.
    throw new Error('WIZARD_PERMISSION_DENIED: invalid session');
  }

  const ctl = registerWizardSession(sessionId);
  const results: WizardInstallResult[] = [];

  try {
    // ── Re-scan: trust only paths the scanner currently reports ─────────
    // Even though Plan 07's UI calls detectInstalls then install with the
    // returned ids, racing the user editing their filesystem between the
    // two calls means we MUST re-scan to confirm. Also gives us the
    // freshest McInstall record (mc_version, loader, etc.) for each id.
    const scanned = await scanMcInstalls();
    const byId = new Map(scanned.map((i) => [i.id, i]));

    for (const installId of installIds) {
      // Cancellation gate at the top of each install iteration. Catches
      // the case where the user hits Cancel between installs.
      if (ctl.signal.aborted) {
        onProgress({ installId, stage: 'cancelled' });
        results.push({
          installId,
          ok: false,
          error: 'FABRIC_INSTALL_FAILED',
          message: 'Cancelled.',
        });
        // Don't try to process remaining ids — the user cancelled the run.
        break;
      }

      const install = byId.get(installId);
      if (!install) {
        // Install was selected in the UI but isn't in the current scan —
        // user moved/deleted the MC dir between detect and install. Emit
        // a failed event so the row shows the error inline.
        onProgress({
          installId,
          stage: 'failed',
          error: 'MC_INSTALL_NOT_FOUND',
          message: 'Install no longer detected. Re-run setup.',
        });
        results.push({
          installId,
          ok: false,
          error: 'MC_INSTALL_NOT_FOUND',
          message: 'Install no longer detected. Re-run setup.',
        });
        continue;
      }

      try {
        await processOneInstall(install, skinServerBaseUrl, ctl.signal, onProgress, results);
      } catch (err) {
        // Defensive — processOneInstall is supposed to catch and push to
        // results itself. This catch is a last-resort net for an
        // unexpected throw so the loop doesn't unwind for the remaining
        // installs.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`wizard: unexpected error processing ${installId}: ${msg}`);
        if (isCancellationError(err, ctl.signal)) {
          onProgress({ installId, stage: 'cancelled' });
          results.push({
            installId,
            ok: false,
            error: 'FABRIC_INSTALL_FAILED',
            message: 'Cancelled.',
          });
          break; // User cancelled the run, stop processing.
        }
        onProgress({
          installId,
          stage: 'failed',
          error: 'FABRIC_INSTALL_FAILED',
          message: msg,
        });
        results.push({
          installId,
          ok: false,
          error: 'FABRIC_INSTALL_FAILED',
          message: msg,
        });
      }

      // After processOneInstall, re-check the abort signal — if the user
      // hit Cancel during a step that completed before the signal fired
      // (e.g. between the last `await` and the loop continuation), break.
      if (ctl.signal.aborted) {
        break;
      }
    }

    // ── Persist updated state ───────────────────────────────────────────
    // Even on partial-failure runs, persist what succeeded. Only successful
    // installs are added to enabledInstallIds (the port-drift detector
    // only rewrites configs for installs that DID get setup successfully).
    try {
      const current = await loadWizardState();
      const newlyEnabled = results.filter((r) => r.ok).map((r) => r.installId);
      const mergedEnabled = Array.from(new Set([...current.enabledInstallIds, ...newlyEnabled]));
      // Port = the last path component of the URL. Defensive parse: if the
      // URL is malformed, fall back to whatever was saved before (rather
      // than zeroing out and breaking the port-drift detector forever).
      let port: number | null = current.lastSkinServerPort;
      try {
        const parsedPort = parseInt(new URL(skinServerBaseUrl).port, 10);
        if (Number.isFinite(parsedPort) && parsedPort > 0) port = parsedPort;
      } catch {
        // Leave lastSkinServerPort unchanged on parse failure.
      }
      await saveWizardState({
        ...current,
        hasRunOnce: true,
        enabledInstallIds: mergedEnabled,
        lastRunAt: new Date().toISOString(),
        lastSkinServerPort: port,
      });
    } catch (err) {
      // State persistence failure is non-fatal — the actual install on
      // disk succeeded. Log it; user will re-detect on next launch.
      logger.warn(`wizard: persist state failed: ${(err as Error).message}`);
    }

    return { results };
  } finally {
    // Always free the controller reference, even on early break / throw.
    // After this, `wizard:cancel(sessionId)` will return false (no-op).
    sessions.delete(sessionId);
  }
}

/**
 * Per-install pipeline. Mutates `results` in place (push). Re-throws on
 * cancellation so the caller can break the install loop.
 *
 * Stages (matching `WizardProgressEvent` variants):
 *   queued → (vanilla only: fabric-downloading + fabric-installing) →
 *   mod-downloading → mod-placing → config-writing → done
 *
 * On `signal.aborted` partway through: emit `cancelled`, push the result,
 * re-throw so the orchestrator's outer loop can break.
 * On any other error: emit `failed` + push the result; do NOT re-throw
 * (the orchestrator continues to the next install).
 */
async function processOneInstall(
  install: McInstall,
  skinServerBaseUrl: string,
  signal: AbortSignal,
  onProgress: (ev: WizardProgressEvent) => void,
  results: WizardInstallResult[],
): Promise<void> {
  const installId = install.id;

  // ── Lunar early return (260518-o1k T3) ────────────────────────────────
  // Lunar Client doesn't support custom skin mods and has no
  // user-accessible mods/ directory. We never install here. The wizard UI
  // disables the row's checkbox (T7), so this branch is purely defensive
  // — a UI bug that lets a Lunar id through the selection set won't
  // wedge the orchestrator.
  if (install.kind === 'lunar') {
    onProgress({ installId, stage: 'queued' });
    onProgress({ installId, stage: 'done' });
    results.push({
      installId,
      ok: true,
      // Empty version fields: we didn't install anything, so there's
      // nothing to report. The renderer treats undefined as "n/a".
    });
    return;
  }

  // ── Determine MC version (with fallback) ──────────────────────────────
  const mcVersion = install.mc_version ?? DEFAULT_MC_VERSION;
  if (!mcVersion) {
    onProgress({
      installId,
      stage: 'failed',
      error: 'MC_INSTALL_NOT_FOUND',
      message: "Couldn't determine MC version.",
    });
    results.push({
      installId,
      ok: false,
      error: 'MC_INSTALL_NOT_FOUND',
      message: "Couldn't determine MC version.",
    });
    return;
  }

  // ── Decide loader kind ────────────────────────────────────────────────
  const loaderKind = decideLoaderKind(install);

  // ── Emit queued ────────────────────────────────────────────────────────
  onProgress({ installId, stage: 'queued' });

  // ── Fabric step (always on vanilla — installer is idempotent and
  // re-running ensures the launcher profile entry exists). CurseForge
  // instances already ship their own loader, so skip the step there.
  let installedFabricVersion: string | undefined;
  // 260518-o1k T4: installFabricLoader now returns the absolute path to
  // the isolated Sei gameDir (`<.minecraft>/sei/`). Captured here so T5
  // can hand it to the CSL helpers as targetDir and T6 can hand it to
  // the mod-link scanner.
  let seiGameDir: string | undefined;
  const needsFabricInstall = install.kind === 'vanilla';
  if (needsFabricInstall) {
    onProgress({ installId, stage: 'fabric-downloading', pct: 0 });
    try {
      const fabricRes = await installFabricLoader({
        mcInstall: install,
        mcVersion,
        signal,
        onProgress: (pct) => onProgress({ installId, stage: 'fabric-downloading', pct }),
      });
      installedFabricVersion = fabricRes.loaderVersion;
      seiGameDir = fabricRes.seiGameDir;
      onProgress({ installId, stage: 'fabric-installing' });
    } catch (err) {
      if (isCancellationError(err, signal)) {
        onProgress({ installId, stage: 'cancelled' });
        results.push({
          installId,
          ok: false,
          error: 'FABRIC_INSTALL_FAILED',
          message: 'Cancelled.',
        });
        // Re-throw so the orchestrator breaks the loop on cancel.
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      onProgress({ installId, stage: 'failed', error: 'FABRIC_INSTALL_FAILED', message: msg });
      results.push({
        installId,
        ok: false,
        error: 'FABRIC_INSTALL_FAILED',
        message: msg,
      });
      return;
    }
  }

  // ── CSL download step ─────────────────────────────────────────────────
  let installedCslVersion: string;
  onProgress({ installId, stage: 'mod-downloading', pct: 0 });
  try {
    const cslRes = await downloadCustomSkinLoader({
      loaderKind,
      mcVersion,
      modsDir: path.join(install.path, 'mods'),
      signal,
      onProgress: (pct) => onProgress({ installId, stage: 'mod-downloading', pct }),
    });
    installedCslVersion = cslRes.version;
    // Placement is technically already done inside downloadCustomSkinLoader
    // (via fs.rename). This stage is purely a UI signal so the renderer can
    // flip the row from "downloading" to "placing" between the actual
    // download finishing and the config-writing step starting.
    onProgress({ installId, stage: 'mod-placing' });
  } catch (err) {
    if (isCancellationError(err, signal)) {
      onProgress({ installId, stage: 'cancelled' });
      results.push({
        installId,
        ok: false,
        error: 'MOD_DOWNLOAD_FAILED',
        message: 'Cancelled.',
      });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ installId, stage: 'failed', error: 'MOD_DOWNLOAD_FAILED', message: msg });
    results.push({
      installId,
      ok: false,
      error: 'MOD_DOWNLOAD_FAILED',
      message: msg,
    });
    return;
  }

  // ── Config write step ─────────────────────────────────────────────────
  onProgress({ installId, stage: 'config-writing' });
  try {
    await writeCustomSkinLoaderConfig({
      mcInstallDir: install.path,
      loaderKind,
      skinServerBaseUrl,
    });
  } catch (err) {
    if (isCancellationError(err, signal)) {
      onProgress({ installId, stage: 'cancelled' });
      results.push({
        installId,
        ok: false,
        error: 'WIZARD_PERMISSION_DENIED',
        message: 'Cancelled.',
      });
      throw err;
    }
    // Most likely EACCES on the config dir — surface as a permission error
    // with the underlying message preserved so the UI can show the path.
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ installId, stage: 'failed', error: 'WIZARD_PERMISSION_DENIED', message: msg });
    results.push({
      installId,
      ok: false,
      error: 'WIZARD_PERMISSION_DENIED',
      message: msg,
    });
    return;
  }

  // ── Done ───────────────────────────────────────────────────────────────
  onProgress({ installId, stage: 'done' });
  results.push({
    installId,
    ok: true,
    installedFabricVersion,
    installedCslVersion,
  });
}
