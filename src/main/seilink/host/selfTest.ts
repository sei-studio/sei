/**
 * SeiLink desktop host CI self-test (261104). Runs inside the real app (main
 * process) when it is started UNPACKAGED with SEI_SEILINK_SELFTEST=<outdir>
 * and the dev flag (SEI_SEILINK_PACKS). Driven by
 * .github/workflows/seilink-host-check.yml on windows-2022/2025 and
 * macos-15/26; never compiled into a path a packaged build can reach (index.ts
 * imports it only behind !app.isPackaged).
 *
 * Steps, each a named check in <outdir>/result.json, screenshots beside it:
 *   attach      start(), attached behind the icons, first frame, frames > 0
 *   cover       a maximized window (mac: a work-area window over her box) -> covered, 0 fps
 *   uncover     close it -> fps back
 *   click       a synthetic click on her box -> open-chat; on bare wallpaper -> nothing;
 *               a double click -> dblclick and no click
 *   kill        kill the host -> a new host attaches and draws
 *   hang        wedge the host -> hang detected, a new host attaches
 *   explorer    (Windows) kill and restart Explorer -> back behind the icons
 *   stop        stop() -> host gone, status off
 */
import { app, BrowserWindow, screen } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundleRequire } from '../../bundleRequire';
import type { FromHost } from './protocol';
import { fakeDesktopEnabled } from './native';
import {
  seilinkHostEvents,
  seilinkHostPidForTest,
  seilinkHostStatus,
  sendToSeilinkHostForTest,
  startSeilinkHost,
  stopSeilinkHost,
} from './seilinkHost';
import { getCharacter } from '../../characterStore';
import { SUI_CHARACTER_ID } from '../../../shared/voicePitch';

/** No such character: the room draws her as a silhouette. Used when Sui is not in the store. */
const SYNTHETIC_CHARACTER = '5e11a1c0-0000-4000-8000-00000000c1a0';
const FAKE = fakeDesktopEnabled(app.isPackaged);
const IS_WIN = !FAKE && process.platform === 'win32';
const IS_MAC = !FAKE && process.platform === 'darwin';

interface TestAddon {
  testClick(x: number, y: number, count?: number): unknown;
  /** macOS only: size another app's first window through Accessibility. */
  axSetWindowFrame?(bundleId: string, x: number, y: number, w: number, h: number): string;
}

interface Check {
  ok: boolean;
  ms?: number;
  detail?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function waitFor<T>(pred: () => T | null | undefined | false, timeoutMs: number, everyMs = 100): Promise<T | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = (): void => {
      let v: T | null | undefined | false = null;
      try {
        v = pred();
      } catch {
        v = null;
      }
      if (v) return resolve(v as T);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, everyMs);
    };
    tick();
  });
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
      resolve(err ? `ERR ${err.message} ${stderr}` : String(stdout)),
    );
  });
}

/**
 * macOS: open TextEdit and size its window over the work area: through Accessibility (the
 * test addon; the runner grants it), else AppleScript (needs an Automation grant). True when
 * TextEdit opened; an unsized window may still cover her, the cover check says.
 */
async function coverWithTextEdit(
  out: string,
  wa: Electron.Rectangle,
  addon: TestAddon | null,
  log: (s: string) => void,
): Promise<boolean> {
  const file = path.join(out, 'cover.txt');
  writeFileSync(file, 'SeiLink self-test: this window covers the room.\n'.repeat(40));
  const opened = await run('/usr/bin/open', ['-a', 'TextEdit', file]);
  log(`open TextEdit: ${opened.trim() || 'ok'}`);
  if (opened.startsWith('ERR')) return false;
  await new Promise((r) => setTimeout(r, 3000));
  const ax = addon?.axSetWindowFrame?.('com.apple.TextEdit', wa.x, wa.y, wa.width, wa.height) ?? 'no AX helper';
  log(`TextEdit frame via AX (wanted ${wa.x},${wa.y} ${wa.width}x${wa.height}): ${ax}`);
  if (!ax.startsWith('ok')) {
    const bounds = `{${wa.x}, ${wa.y}, ${wa.x + wa.width}, ${wa.y + wa.height}}`;
    const res = await run('/usr/bin/osascript', ['-e', `tell application "TextEdit" to activate`, '-e', `tell application "TextEdit" to set bounds of front window to ${bounds}`], 8000);
    log(`TextEdit frame via AppleScript: ${res.trim().slice(0, 200) || 'ok'}`);
  }
  return true;
}

export async function runSeilinkSelfTest(opts: { getMainWindow: () => BrowserWindow | null }): Promise<void> {
  const out = path.resolve(process.env.SEI_SEILINK_SELFTEST ?? 'seilink-selftest');
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const lines: string[] = [];
  const log = (s: string): void => {
    const line = `[selftest +${((Date.now() - t0) / 1000).toFixed(2)}s] ${s}`;
    lines.push(line);
    console.log(line);
    try {
      writeFileSync(path.join(out, 'selftest.log'), lines.join('\n') + '\n');
    } catch {
      /* ignore */
    }
  };
  const checks: Record<string, Check> = {};
  const timings: Record<string, number> = {};
  const events: Array<{ t: number; m: FromHost | { type: string; [k: string]: unknown } }> = [];
  const heartbeats: Array<{ t: number; fps: number; covered: boolean }> = [];
  const onMsg = (m: FromHost): void => {
    if (m.type === 'heartbeat') heartbeats.push({ t: Date.now(), fps: m.effectiveFps, covered: m.covered });
    else {
      events.push({ t: Date.now(), m });
      log(`host: ${JSON.stringify(m).slice(0, 300)}`);
    }
  };
  seilinkHostEvents.on('message', onMsg);
  for (const ev of ['spawn', 'exit', 'restart', 'hung']) {
    seilinkHostEvents.on(ev, (e: Record<string, unknown>) => {
      events.push({ t: Date.now(), m: { type: `sup:${ev}`, ...e } });
      log(`supervisor ${ev} ${JSON.stringify(e)}`);
    });
  }
  const since = (t: number, type: string, pred?: (m: Record<string, unknown>) => boolean) => () =>
    events.find((e) => e.t >= t && e.m.type === type && (!pred || pred(e.m as Record<string, unknown>)));
  const fpsAfter = async (t: number, want: 'zero' | 'positive', timeoutMs: number): Promise<number | null> => {
    const hit = await waitFor(() => {
      const hb = heartbeats.filter((h) => h.t >= t);
      if (hb.length < 2) return null;
      const last2 = hb.slice(-2);
      return want === 'zero' ? last2.every((h) => h.fps === 0) && last2 : last2.every((h) => h.fps > 0) && last2;
    }, timeoutMs);
    return hit ? hit[1].fps : null;
  };
  const shot = async (name: string): Promise<void> => {
    const file = path.join(out, `${name}.png`);
    if (IS_WIN) {
      const ps1 = path.join(app.getAppPath(), 'scripts', 'seilink', 'shot-win.ps1');
      log(`shot ${name}: ${(await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, file])).trim()}`);
    } else if (IS_MAC) {
      log(`shot ${name}: ${(await run('screencapture', ['-x', '-C', '-m', file])).trim() || 'ok'}`);
    } else if (process.platform === 'linux' && process.env.DISPLAY) {
      // The Xvfb smoke (fake desktop): ImageMagick's import, when installed.
      log(`shot ${name}: ${(await run('import', ['-window', 'root', file])).trim() || 'ok'}`);
    }
  };
  const hideMain = (): void => {
    const w = opts.getMainWindow();
    if (w && !w.isDestroyed()) w.hide();
  };

  let testAddon: TestAddon | null = null;
  try {
    testAddon = bundleRequire()(path.join(app.getAppPath(), 'native', 'seilink', 'out', 'seilink_test.node')) as TestAddon;
  } catch (err) {
    log(`test addon missing: ${(err as Error).message}`);
  }

  try {
    // Let the app settle, then get the main window out of the way.
    await waitFor(() => opts.getMainWindow(), 60_000);
    await sleep(4000);
    hideMain();
    await sleep(1000);
    await shot('00-before');

    // A move-in restored at boot (a previous run) is not this test's start.
    await stopSeilinkHost('user_stop');
    await sleep(1500);

    // ── attach ──
    let t = Date.now();
    // Sui when the profile has her (her bundled portrait, cut out), so the screenshots show a real figure.
    const testCharacter = (await getCharacter(SUI_CHARACTER_ID).catch(() => null)) ? SUI_CHARACTER_ID : SYNTHETIC_CHARACTER;
    log(`character ${testCharacter === SUI_CHARACTER_ID ? 'sui' : 'synthetic'}`);
    const st = await startSeilinkHost(testCharacter);
    log(`start -> ${JSON.stringify(st)}`);
    const gaveUp = (): boolean => seilinkHostStatus().state === 'failed';
    const attachedOrFailed = await waitFor(() => since(t, 'attached')() ?? (gaveUp() ? 'failed' : null), 60_000);
    const attached = attachedOrFailed && attachedOrFailed !== 'failed' ? attachedOrFailed : null;
    const first = attached ? await waitFor(since(t, 'first-frame'), 60_000) : null;
    const drawing = await fpsAfter(t, 'positive', 15_000);
    timings.attachMs = attached ? attached.t - t : -1;
    timings.firstFrameMs = first ? first.t - t : -1;
    checks.attach = {
      ok: !!attached && !!first && drawing !== null && seilinkHostStatus().state === 'running',
      ms: timings.firstFrameMs,
      detail: attached ? JSON.stringify(attached.m) : 'no attached',
    };
    await sleep(1500);
    await shot('01-attached');
    if (!checks.attach.ok) throw new Error(`never attached (${seilinkHostStatus().state} ${seilinkHostStatus().failure ?? ''})`);

    if (!FAKE) {
      // ── cover / uncover ──
      const box = [...events].reverse().find((e) => e.m.type === 'box' && (e.m as { screen: unknown }).screen)?.m as
        | { screen: { x: number; y: number; w: number; h: number } }
        | undefined;
      log(`her box ${JSON.stringify(box?.screen ?? null)}`);
      t = Date.now();
      const d = screen.getPrimaryDisplay();
      // macOS: another app's window zoomed over the work area (the spike's cover; a window of our
      // own Electron bundle did not occlude the hit panel on macos-26). Windows: a maximized window.
      const textEdit = IS_MAC ? await coverWithTextEdit(out, d.workArea, testAddon, log) : false;
      log(`cover with ${textEdit ? 'TextEdit' : 'an Electron window'}`);
      const cover = textEdit
        ? null
        : new BrowserWindow({
            ...(IS_MAC ? d.workArea : { x: d.workArea.x + 40, y: d.workArea.y + 40, width: 800, height: 600 }),
            show: false,
            backgroundColor: '#2d6a4f',
            title: 'SeiLink cover',
          });
      if (cover) {
        void cover.loadURL('data:text/html,<body style="background:%232d6a4f;color:white;font:40px sans-serif">cover</body>');
        if (IS_WIN) cover.maximize();
        cover.show();
      }
      const coveredMsg = await waitFor(since(t, 'activity', (m) => m.covered === true), 15_000);
      const zero = await fpsAfter(coveredMsg ? coveredMsg.t : t, 'zero', 10_000);
      timings.coverDetectMs = coveredMsg ? coveredMsg.t - t : -1;
      checks.cover = { ok: !!coveredMsg && zero === 0, ms: timings.coverDetectMs, detail: coveredMsg ? String((coveredMsg.m as { reason?: string }).reason) : 'never covered' };
      await shot('02-covered');
      t = Date.now();
      if (cover) cover.destroy();
      // killall, not AppleScript: no Automation grant needed.
      else log(`uncover: ${(await run('/usr/bin/killall', ['TextEdit'], 8000)).trim() || 'TextEdit killed'}`);
      const uncoveredMsg = await waitFor(since(t, 'activity', (m) => m.covered === false), 15_000);
      const back = await fpsAfter(uncoveredMsg ? uncoveredMsg.t : t, 'positive', 10_000);
      timings.uncoverMs = uncoveredMsg ? uncoveredMsg.t - t : -1;
      checks.uncover = { ok: !!uncoveredMsg && back !== null, ms: timings.uncoverMs, detail: `fps ${back}` };

      // ── click ──
      if (testAddon && box?.screen) {
        const b = box.screen;
        const s = IS_WIN ? d.scaleFactor : 1;
        const cx = Math.round((b.x + b.w / 2) * s);
        const cy = Math.round((b.y + b.h * 0.6) * s);
        t = Date.now();
        log(`click her at ${cx},${cy}: ${JSON.stringify(testAddon.testClick(cx, cy, 1))}`);
        const clicked = await waitFor(since(t, 'click', (m) => m.kind === 'click'), 5000);
        timings.clickMs = clicked ? clicked.t - t : -1;
        await sleep(800);
        const mainShown = !!opts.getMainWindow()?.isVisible();
        hideMain();
        await sleep(800);
        // Bare wallpaper: beside her on the wider side, a third of the way into the gap (clear of
        // her and of the icon column at the screen edge), at her mid-height.
        const wa = d.workArea;
        const leftGap = b.x - wa.x;
        const rightGap = wa.x + wa.width - (b.x + b.w);
        const bxPt = rightGap >= leftGap ? b.x + b.w + rightGap / 3 : b.x - leftGap / 3;
        const byPt = Math.min(Math.max(b.y + b.h / 2, wa.y + 20), wa.y + wa.height - 20);
        const bx = Math.round(bxPt * s);
        const by = Math.round(byPt * s);
        const insideHer = bxPt >= b.x && bxPt <= b.x + b.w && byPt >= b.y && byPt <= b.y + b.h;
        t = Date.now();
        log(`click bare wallpaper at ${bx},${by} (gaps ${Math.round(leftGap)}/${Math.round(rightGap)}${insideHer ? ', INSIDE her box' : ''})`);
        testAddon.testClick(bx, by, 1);
        const stray = await waitFor(since(t, 'click'), 2000);
        // A stray open would put the app window over her and eat the double click.
        if (stray) {
          hideMain();
          await sleep(800);
        }
        t = Date.now();
        testAddon.testClick(cx, cy, 2);
        const dbl = await waitFor(since(t, 'click', (m) => m.kind === 'dblclick'), 3000);
        await sleep(1200);
        const singleAfterDbl = events.find((e) => e.t >= t && e.m.type === 'click' && (e.m as { kind?: string }).kind === 'click');
        hideMain();
        checks.click = {
          ok: !!clicked && mainShown && !stray && !insideHer && !!dbl && !singleAfterDbl,
          ms: timings.clickMs,
          detail: `click ${!!clicked} mainShown ${mainShown} stray ${!!stray} dbl ${!!dbl} singleAfterDbl ${!!singleAfterDbl}`,
        };
      } else {
        checks.click = { ok: false, detail: testAddon ? 'no box reported' : 'no test addon' };
      }

    } else {
      for (const k of ['cover', 'uncover', 'click']) checks[k] = { ok: true, detail: 'skipped: fake desktop (no coverage or input here)' };
    }

    // ── kill ──
    await sleep(1000);
    const pid = seilinkHostPidForTest();
    t = Date.now();
    if (pid) {
      if (IS_WIN) await run('taskkill', ['/PID', String(pid), '/T', '/F']);
      else process.kill(pid, 'SIGKILL');
    }
    const reattached = await waitFor(since(t, 'attached'), 30_000);
    const refirst = await waitFor(since(t, 'first-frame'), 30_000);
    const redraw = await fpsAfter(t, 'positive', 15_000);
    timings.killToAttachMs = reattached ? reattached.t - t : -1;
    timings.killToFrameMs = refirst ? refirst.t - t : -1;
    checks.kill = { ok: !!pid && !!reattached && !!refirst && redraw !== null && seilinkHostPidForTest() !== pid, ms: timings.killToFrameMs };
    await sleep(1000);
    await shot('03-after-kill');

    // ── hang ──
    await sleep(2000);
    t = Date.now();
    sendToSeilinkHostForTest({ type: 'test-hang', ms: 15_000 });
    const hung = await waitFor(since(t, 'sup:hung'), 10_000);
    const afterHang = await waitFor(since(t, 'attached'), 40_000);
    timings.hangDetectMs = hung ? hung.t - t : -1;
    timings.hangToAttachMs = afterHang ? afterHang.t - t : -1;
    checks.hang = { ok: !!hung && !!afterHang && timings.hangDetectMs < 4500, ms: timings.hangDetectMs };

    // ── explorer (Windows) ──
    if (IS_WIN) {
      await fpsAfter(Date.now(), 'positive', 15_000);
      await sleep(2000);
      t = Date.now();
      log(`explorer kill: ${(await run('taskkill', ['/F', '/IM', 'explorer.exe'])).trim()}`);
      await sleep(6000);
      const tasks = await run('tasklist', ['/FI', 'IMAGENAME eq explorer.exe', '/NH']);
      if (!/explorer\.exe/i.test(tasks)) {
        log('explorer did not come back by itself; starting it');
        execFile('explorer.exe', [], { windowsHide: false }, () => {});
      }
      const back2 = await waitFor(since(t, 'attached'), 60_000);
      const frame2 = await fpsAfter(back2 ? back2.t : t, 'positive', 20_000);
      timings.explorerToAttachMs = back2 ? back2.t - t : -1;
      checks.explorer = { ok: !!back2 && frame2 !== null, ms: timings.explorerToAttachMs, detail: back2 ? JSON.stringify(back2.m) : 'never re-attached' };
      await sleep(3000);
      await shot('04-after-explorer');
    }

    // ── stop ──
    const lastPid = seilinkHostPidForTest();
    t = Date.now();
    await stopSeilinkHost('user_stop');
    const gone = await waitFor(() => {
      if (!lastPid) return true;
      try {
        process.kill(lastPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8000);
    timings.stopMs = Date.now() - t;
    checks.stop = { ok: !!gone && seilinkHostStatus().state === 'off', ms: timings.stopMs };
    await sleep(1500);
    await shot('05-stopped');
  } catch (err) {
    log(`self-test threw: ${(err as Error).stack ?? err}`);
    checks.threw = { ok: false, detail: String((err as Error).message) };
  }

  const ok = Object.values(checks).length > 0 && Object.values(checks).every((c) => c.ok);
  const fpsSamples = heartbeats.map((h) => h.fps);
  writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        ok,
        platform: process.platform,
        arch: process.arch,
        osRelease: (await import('node:os')).release(),
        electron: process.versions.electron,
        checks,
        timings,
        heartbeatFps: { samples: fpsSamples.length, max: Math.max(0, ...fpsSamples) },
        events: events.map((e) => ({ t: e.t - t0, ...e.m })),
      },
      null,
      2,
    ),
  );
  log(`done: ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(checks)}`);
  app.exit(ok ? 0 : 1);
}
