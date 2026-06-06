/**
 * Wizard install orchestrator.
 *
 * Composes four modules — mcInstallScan, fabricInstaller, customSkinLoader,
 * wizardStateStore — into a single `runWizardInstall(args)` flow that the
 * renderer drives via the `wizard:install` IPC handler.
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
 *   - `abortWizardSession(sessionId)` — looks up the session's
 *     AbortController and fires `.abort()` so the in-flight fetch /
 *     execFile / writeFile in the install modules unwinds through the
 *     AbortSignal chain. Returns true if a session was aborted.
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
 *   - src/main/mcInstallScan.ts (scanMcInstalls)
 *   - src/main/fabricInstaller.ts (installFabricLoader)
 *   - src/main/customSkinLoader.ts (downloadCustomSkinLoader + writeCustomSkinLoaderConfig)
 *   - src/main/wizardStateStore.ts (loadWizardState + saveWizardState)
 *   - CONTEXT.md §"First-launch wizard scope" (5 steps the orchestrator implements)
 *   - IPC-crossing abort via Map<sessionId, AbortController>
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanMcInstalls } from './mcInstallScan';
import { installFabricLoader } from './fabricInstaller';
import { downloadCustomSkinLoader, writeCustomSkinLoaderConfig } from './customSkinLoader';
import { scanModJar } from './modScanner';
import {
  loadWizardState,
  saveWizardState,
  type LinkManifest,
  type LinkManifestEntry,
  type LinkManifestExclusion,
} from './wizardStateStore';
import type { McInstall, WizardInstallResult, WizardProgressEvent } from '../shared/ipc';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/**
 * Seed the isolated Sei gameDir (`<.minecraft>/sei/`) from the user's existing
 * vanilla `.minecraft` so the first Sei launch isn't a blank profile.
 *
 * Why this exists (260605 follow-up): the 260518-o1k T4 isolation change points
 * the Sei launcher profile at a fresh `<.minecraft>/sei/` gameDir. A fresh
 * gameDir means Minecraft writes a DEFAULT options.txt and re-shows the new-game
 * tutorial — users perceive this as "all my settings got reset." We carry the
 * user's existing settings forward by copying a small allowlist of state files
 * from the root `.minecraft` on FIRST creation only.
 *
 * Copy semantics:
 *   - Per-entry, skip if the destination already exists. This makes seeding a
 *     one-time bootstrap: once the user has launched (and possibly tweaked
 *     settings inside the isolated dir), we never clobber their edits on re-run.
 *   - Skip silently if the source is missing (fresh .minecraft with no options
 *     yet) — there's simply nothing to carry forward.
 *   - Best-effort: a copy failure logs a warn and continues; seeding must never
 *     block the install. options.txt is the important one (settings + the
 *     `tutorialStep:none` flag that suppresses the tutorial); servers.dat and
 *     resourcepacks/ are nice-to-haves.
 *
 * `rootDir` is the vanilla `.minecraft` (install.path); `seiGameDir` is
 * `<rootDir>/sei`.
 */
async function seedSeiGameDir(rootDir: string, seiGameDir: string): Promise<void> {
  // Files copied verbatim. options.txt also carries `tutorialStep` — copying it
  // forward both restores settings AND skips the tutorial in one shot.
  const fileAllowlist = ['options.txt', 'servers.dat', 'optionsof.txt', 'optionsshaders.txt'];
  for (const name of fileAllowlist) {
    const src = path.join(rootDir, name);
    const dest = path.join(seiGameDir, name);
    try {
      // Don't clobber an existing dest (one-time seed only).
      await fs.access(dest);
      continue;
    } catch {
      /* dest missing → proceed to copy */
    }
    try {
      await fs.copyFile(src, dest);
      logger.info(`wizard: seeded ${name} into Sei gameDir`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // ENOENT on src is the common, expected case (nothing to carry forward).
      if (e.code !== 'ENOENT') {
        logger.warn(`wizard: failed to seed ${name}: ${e.message}`);
      }
    }
  }
  // resourcepacks/ — copy the directory tree once, only if the user has packs
  // and the isolated dir doesn't already have a populated folder.
  const rpSrc = path.join(rootDir, 'resourcepacks');
  const rpDest = path.join(seiGameDir, 'resourcepacks');
  try {
    const srcEntries = await fs.readdir(rpSrc);
    let destEntries: string[] = [];
    try {
      destEntries = await fs.readdir(rpDest);
    } catch {
      /* dest missing → treat as empty */
    }
    if (srcEntries.length > 0 && destEntries.length === 0) {
      await fs.cp(rpSrc, rpDest, { recursive: true });
      logger.info(`wizard: seeded resourcepacks/ (${srcEntries.length} entries) into Sei gameDir`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      logger.warn(`wizard: failed to seed resourcepacks/: ${e.message}`);
    }
  }
}

/**
 * Module-private session registry. One entry per in-flight runWizardInstall.
 * Keyed by the renderer-generated `sessionId` (typically `crypto.randomUUID()`).
 * The AbortController is what `wizard:cancel` fires `.abort()` on; the signal
 * threads through every external call (fetch / execFile / writeFile).
 *
 * Single source of truth for cancellation. A renderer-side AbortController
 * cannot reach the main-process child `java -jar fabric-installer` subprocess;
 * this map lets the renderer's `wizard:cancel(sessionId)` IPC call cross the
 * process boundary and SIGTERM the running installer.
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
 * (already cleaned up / never existed). This is the IPC-crossing abort
 * entry point — `wizard:cancel` IPC handler calls into here.
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
 * The install modules throw Errors with messages like `FABRIC_INSTALL_FAILED:
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
    // Even though the wizard UI calls detectInstalls then install with the
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

  // ── Compute target placement directory (260518-o1k T5) ────────────────
  //
  // Vanilla installs get isolated under <.minecraft>/sei/ so the Fabric
  // gameDir on the Sei profile (set in T4) and the CSL JAR + config all
  // live together inside the isolated directory. CurseForge instances
  // pass their own instance dir (unchanged behavior — instances are
  // already isolated per-instance and version-coherent by design).
  //
  // For vanilla we expect seiGameDir to be defined (T4's
  // installFabricLoader return value); fall back to install.path with a
  // warn if somehow not.
  const targetDir = install.kind === 'vanilla'
    ? (seiGameDir ?? install.path)
    : install.path;
  if (install.kind === 'vanilla' && !seiGameDir) {
    logger.warn(`wizard: seiGameDir missing for vanilla install ${installId}; falling back to ${install.path}`);
  }

  // ── Seed the isolated gameDir from the user's existing .minecraft ──────
  // First-launch-only carry-forward of settings + tutorial flag so the
  // isolated Sei profile doesn't present as a wiped, tutorial-laden install.
  // Vanilla only — CurseForge instances are already their own gameDir.
  if (install.kind === 'vanilla' && seiGameDir) {
    await seedSeiGameDir(install.path, seiGameDir);
  }

  const modsDir = path.join(targetDir, 'mods');

  // ── Mod-link stage (vanilla only, 260518-o1k T6) ──────────────────────
  // Scan <.minecraft>/mods/, parse each non-CSL JAR's metadata via T1,
  // and hardlink (with symlink/copy fallback) the compatible ones into
  // <sei gameDir>/mods/. Reconciles against the persisted manifest so
  // re-runs are idempotent and removed mods get unlinked.
  let modLinkSummary: WizardInstallResult['modLinkSummary'] | undefined;
  let newLinkManifest: LinkManifest | null = null;
  if (install.kind === 'vanilla' && seiGameDir) {
    const priorState = await loadWizardState().catch(() => null);
    const priorManifest = priorState?.linkManifests?.[installId] ?? null;
    try {
      const stageResult = await runModLinkStage({
        install,
        seiGameDir,
        targetMc: mcVersion,
        signal,
        onProgress,
        priorManifest,
      });
      modLinkSummary = stageResult.summary;
      newLinkManifest = stageResult.manifest;
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
      // Non-cancellation failure during mod-linking is NOT fatal to the
      // install — we'd rather get CSL placed (skin loading still works)
      // than fail the whole row over a permission glitch on a single
      // user mod. Log + continue; the manifest stays unchanged.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`wizard: mod-link stage failed for ${installId}: ${msg}`);
    }
  }

  // ── CSL download step ─────────────────────────────────────────────────
  let installedCslVersion: string;
  onProgress({ installId, stage: 'mod-downloading', pct: 0 });
  try {
    const cslRes = await downloadCustomSkinLoader({
      loaderKind,
      mcVersion,
      modsDir,
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
      targetDir,
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

  // ── Persist link manifest (260518-o1k T6) ─────────────────────────────
  // After CSL placement succeeded for a vanilla install, persist the new
  // manifest so the next wizard run can reconcile. Manifest is part of
  // the extended wizard state; we merge into linkManifests keyed by
  // installId so other installs' manifests aren't touched.
  if (install.kind === 'vanilla' && newLinkManifest) {
    try {
      const current = await loadWizardState();
      await saveWizardState({
        ...current,
        linkManifests: {
          ...(current.linkManifests ?? {}),
          [installId]: newLinkManifest,
        },
      });
    } catch (err) {
      // Persistence failure is non-fatal; the on-disk links still work,
      // we just lose the reconciliation guide for the next run.
      logger.warn(`wizard: persist link manifest for ${installId} failed: ${(err as Error).message}`);
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────
  onProgress({ installId, stage: 'done' });
  results.push({
    installId,
    ok: true,
    installedFabricVersion,
    installedCslVersion,
    ...(modLinkSummary ? { modLinkSummary } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/*  Public: runModLinkStage (260518-o1k T6)                                    */
/* -------------------------------------------------------------------------- */

/** CSL filename regex — borrowed from customSkinLoader.ts / mcInstallScan.ts.
 *  JARs matching this regex are NEVER linked into the Sei gameDir; Sei always
 *  ships its own CSL build. Centralized here so future scan paths share it. */
const CSL_JAR_REGEX = /^CustomSkinLoader[_-].*\.jar$/i;

export interface RunModLinkStageArgs {
  install: McInstall;
  /** Absolute path to the Sei gameDir (T4's installFabricLoader return value). */
  seiGameDir: string;
  /** Concrete MC version to resolve each JAR's range against. */
  targetMc: string;
  /** Threaded from the wizard session's AbortController. */
  signal: AbortSignal;
  /** Progress callback — same surface as processOneInstall. */
  onProgress: (ev: WizardProgressEvent) => void;
  /** Previous run's manifest (loaded from wizardStateStore), if any. */
  priorManifest: LinkManifest | null;
}

/**
 * Mod-link stage. For each non-CSL JAR in `<.minecraft>/mods/`:
 *   1. Parse metadata via scanModJar(targetMc).
 *   2. If compatible: hardlink into `<sei gameDir>/mods/`. On any of
 *      EXDEV/EPERM/EACCES/ENOTSUP/EOPNOTSUPP (cross-FS or permission),
 *      fall back to symlink; on its failure, fall back to copyFile.
 *      Each fallback level logs the errno at warn.
 *   3. If incompatible: record an exclusion with the scanner's reason.
 *
 * After scanning all source JARs, reconcile against `priorManifest`:
 *   - For each entry whose `sourceName` is no longer in the current
 *     scan (the user removed the source mod), `fs.unlink` the target
 *     and drop it from the manifest.
 *
 * Returns the new manifest + a renderer-friendly summary suitable for
 * attaching to WizardInstallResult.modLinkSummary.
 *
 * Cancellation: checks `signal.aborted` before each JAR scan; throws
 * `MOD_DOWNLOAD_FAILED: cancelled` on abort so the caller's isCancellationError
 * branch unwinds cleanly.
 */
export async function runModLinkStage(args: RunModLinkStageArgs): Promise<{
  manifest: LinkManifest;
  summary: WizardInstallResult['modLinkSummary'];
}> {
  const { install, seiGameDir, targetMc, signal, onProgress, priorManifest } = args;
  const installId = install.id;
  const sourceModsDir = path.join(install.path, 'mods');
  const targetModsDir = path.join(seiGameDir, 'mods');

  // Initial event with totalEstimate=null (we haven't readdir'd yet).
  onProgress({
    installId,
    stage: 'mods-linking',
    scanned: 0,
    linked: 0,
    excluded: 0,
    totalEstimate: null,
  });

  await fs.mkdir(targetModsDir, { recursive: true });

  // List the source mods/ dir. ENOENT (user has no mods/) → treat as empty
  // and run the reconciliation pass against whatever the prior manifest had.
  let allEntries: string[];
  try {
    allEntries = await fs.readdir(sourceModsDir);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      allEntries = [];
    } else {
      throw err;
    }
  }

  // Candidate set: only .jar files, never the CSL JAR.
  const candidates = allEntries.filter(
    (n) => n.toLowerCase().endsWith('.jar') && !CSL_JAR_REGEX.test(n),
  );

  // Emit again with total now known.
  onProgress({
    installId,
    stage: 'mods-linking',
    scanned: 0,
    linked: 0,
    excluded: 0,
    totalEstimate: candidates.length,
  });

  const newEntries: LinkManifestEntry[] = [];
  const newExclusions: LinkManifestExclusion[] = [];
  const linkedJars: NonNullable<WizardInstallResult['modLinkSummary']>['linkedJars'] = [];
  const excludedJars: NonNullable<WizardInstallResult['modLinkSummary']>['excludedJars'] = [];

  let scanned = 0;
  let linked = 0;
  let excluded = 0;

  for (const sourceName of candidates) {
    if (signal.aborted) {
      throw new Error('MOD_DOWNLOAD_FAILED: cancelled');
    }

    const sourcePath = path.join(sourceModsDir, sourceName);
    const targetPath = path.join(targetModsDir, sourceName);

    const result = await scanModJar(sourcePath, targetMc);
    scanned++;

    if (result.compatible) {
      // ── If target already points at the right source, skip linking ──
      // Re-runs without changes should be cheap. fs.lstat tells us whether
      // a link exists; fs.realpath resolves any symlink. If both resolve
      // to the same source, we treat the link as already-present and
      // record its strategy without re-doing the OS call.
      let alreadyLinked: 'link' | 'symlink' | null = null;
      try {
        const lst = await fs.lstat(targetPath);
        if (lst.isSymbolicLink()) {
          const rp = await fs.realpath(targetPath);
          if (rp === sourcePath) alreadyLinked = 'symlink';
        } else if (lst.isFile()) {
          // Could be a hardlink (same inode) or a copy. Compare inode
          // against the source — same inode means we hardlinked it.
          try {
            const srcSt = await fs.stat(sourcePath);
            if (srcSt.ino === lst.ino && srcSt.ino !== 0) alreadyLinked = 'link';
          } catch {
            // ignore — we'll just re-link below.
          }
        }
      } catch {
        // ENOENT → no existing target; fall through to fresh link.
      }

      if (alreadyLinked) {
        const entry: LinkManifestEntry = {
          sourceName,
          sourcePath,
          targetPath,
          strategy: alreadyLinked,
          linkedAt: new Date().toISOString(),
        };
        newEntries.push(entry);
        linkedJars.push({ sourceName, strategy: alreadyLinked });
        linked++;
      } else {
        // No usable existing target. Try fs.link → fs.symlink → fs.copyFile.
        // Each step has its own try/catch and logs the errno on failure.
        // If a stale file is in the way we unlink it first.
        try {
          await fs.unlink(targetPath);
        } catch {
          /* ENOENT is the expected case here */
        }
        let strategy: 'link' | 'symlink' | 'copy' | null = null;
        try {
          await fs.link(sourcePath, targetPath);
          strategy = 'link';
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
          logger.warn(`wizard: fs.link ${sourceName} failed (${code}); trying symlink`);
          try {
            await fs.symlink(sourcePath, targetPath);
            strategy = 'symlink';
          } catch (err2) {
            const code2 = (err2 as NodeJS.ErrnoException).code ?? 'unknown';
            logger.warn(`wizard: fs.symlink ${sourceName} failed (${code2}); falling back to copyFile`);
            try {
              await fs.copyFile(sourcePath, targetPath);
              strategy = 'copy';
            } catch (err3) {
              const code3 = (err3 as NodeJS.ErrnoException).code ?? 'unknown';
              logger.warn(`wizard: fs.copyFile ${sourceName} failed (${code3}); skipping`);
            }
          }
        }
        if (strategy) {
          const entry: LinkManifestEntry = {
            sourceName,
            sourcePath,
            targetPath,
            strategy,
            linkedAt: new Date().toISOString(),
          };
          newEntries.push(entry);
          linkedJars.push({ sourceName, strategy });
          linked++;
        }
      }
    } else if (result.loader === 'fabric' || result.loader === 'forge') {
      // mc-version-mismatch (loader recognized but range didn't match).
      const exclusion: LinkManifestExclusion = {
        name: sourceName,
        reason: 'mc-version-mismatch',
        declaredMc: result.declaredMc,
      };
      newExclusions.push(exclusion);
      excludedJars.push({ name: sourceName, reason: exclusion.reason, declaredMc: exclusion.declaredMc });
      excluded++;
    } else {
      // unparseable / no-metadata / read-error.
      const exclusion: LinkManifestExclusion = {
        name: sourceName,
        reason: result.reason,
      };
      newExclusions.push(exclusion);
      excludedJars.push({ name: sourceName, reason: exclusion.reason });
      excluded++;
    }

    // Live event per-JAR so the renderer's progress counters tick smoothly.
    onProgress({
      installId,
      stage: 'mods-linking',
      scanned,
      linked,
      excluded,
      totalEstimate: candidates.length,
    });
  }

  // ── Reconciliation pass ────────────────────────────────────────────────
  // For each entry the prior manifest had that DOES NOT appear in the new
  // entries (by sourceName), unlink the target. ENOENT is fine — means
  // someone (or the link's source file going away) already cleaned up.
  // Never touches the CSL JAR (the candidates filter excluded it, and the
  // CSL_JAR_REGEX check below is belt-and-braces).
  if (priorManifest) {
    const newNames = new Set(newEntries.map((e) => e.sourceName));
    for (const oldEntry of priorManifest.entries) {
      if (newNames.has(oldEntry.sourceName)) continue;
      if (CSL_JAR_REGEX.test(oldEntry.sourceName)) continue;
      // Only unlink if the target still resides under our target mods/
      // dir — defensive against a manifest that somehow points elsewhere.
      if (!oldEntry.targetPath.startsWith(targetModsDir + path.sep) &&
          oldEntry.targetPath !== targetModsDir) {
        continue;
      }
      try {
        await fs.unlink(oldEntry.targetPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
        if (code !== 'ENOENT') {
          logger.warn(`wizard: reconcile unlink ${oldEntry.targetPath} failed (${code})`);
        }
      }
    }
  }

  const manifest: LinkManifest = {
    targetMc,
    entries: newEntries,
    excluded: newExclusions,
  };

  const summary: WizardInstallResult['modLinkSummary'] = {
    linked,
    excluded,
    linkedJars,
    excludedJars,
  };

  return { manifest, summary };
}
