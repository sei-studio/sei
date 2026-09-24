/**
 * Side-effect module: refuse Chromium remote debugging in packaged STABLE
 * builds. Policy and rationale: `remoteDebugPolicy.ts`.
 *
 * MUST be the first import of `src/main/index.ts`. ES module bodies evaluate
 * in import order, so this runs before any other main module, before app
 * 'ready', and before any window exists.
 *
 * Timing (measured 260925, Electron on Linux with --remote-debugging-port):
 * Chromium has NOT opened the DevTools port while the main script evaluates;
 * it starts listening only after the script has run (around 'ready'). Exiting
 * here means the port never opens. process.exit is used instead of app.exit
 * because app.exit before 'ready' is deferred, and the rest of the module
 * graph would keep evaluating until the quit lands.
 *
 * Electron has no environment variable that enables remote debugging
 * (checked against the binary's strings), and NODE_OPTIONS / --inspect are
 * already off via fuses, so argv plus Chromium's parsed command line is the
 * whole surface.
 */
import { app } from 'electron';
import { remoteDebuggingVerdict } from './remoteDebugPolicy';

const verdict = remoteDebuggingVerdict({
  argv: process.argv,
  isPackaged: app.isPackaged,
  version: app.getVersion(),
  platform: process.platform,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
});

if (verdict.block) {
  console.error(
    `[sei] refusing to start: remote debugging switches (${verdict.found.join(', ')}) ` +
      `are not allowed in stable builds (v${app.getVersion()}).`,
  );
  process.exit(1);
} else if (verdict.found.length > 0) {
  console.warn(
    `[sei] remote debugging enabled (${verdict.found.join(', ')}); allowed in ` +
      `${app.isPackaged ? `prerelease v${app.getVersion()}` : 'dev'}.`,
  );
}
