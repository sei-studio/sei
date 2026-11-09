/**
 * "Minimize other windows" (261110, product call 261110): when the room goes
 * live it is the wallpaper, so it shows only where no window covers it. The
 * live card offers to clear the desktop in one go before Sei steps aside.
 *
 *  - Windows: every visible, minimizable top-level window of other apps is
 *    minimized without being activated (ShowWindowAsync SW_SHOWMINNOACTIVE),
 *    from a short PowerShell script (EnumWindows through Add-Type). Skipped:
 *    Sei's own processes, owned and tool windows, cloaked windows (other
 *    virtual desktops, suspended UWP), and the shell's desktop and taskbars.
 *    Like Win+M, without touching Sei's window.
 *  - macOS: "Hide Others" (the app menu's command, NSApplication
 *    hideOtherApplications:), sent through Menu.sendActionToFirstResponder.
 *    No Apple Events and no new entitlement: it is the app's own menu action.
 *  - Linux: unsupported.
 *
 * Neither is testable on the Linux build box: hand-test on Windows and macOS.
 */
import { Menu, app } from 'electron';
import { runPowerShell } from '../winPowerShell';

export type MinimizeResult = { ok: true; minimized?: number } | { ok: false; error: 'unsupported' | 'failed' };

const PS_TIMEOUT_MS = 15_000;

/** The PowerShell script (exported for a test that checks its guards). Prints the number of windows it minimized. */
export const MINIMIZE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SeiMinimizeOthers {
  private delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  public static int Run(uint[] keep) {
    HashSet<uint> skip = new HashSet<uint>(keep);
    HashSet<string> shell = new HashSet<string>(new string[] { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" });
    int n = 0;
    EnumProc each = delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 || (ex & 0x08000000) != 0) return true;
      int style = GetWindowLong(h, -16);
      if ((style & 0x00020000) == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (skip.Contains(pid)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      StringBuilder c = new StringBuilder(256);
      GetClassName(h, c, 256);
      if (shell.Contains(c.ToString())) return true;
      if (ShowWindowAsync(h, 7)) n++;
      return true;
    };
    EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    return n;
  }
}
'@
$keep = @($env:SEI_KEEP_PIDS -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [uint32]$_ })
[SeiMinimizeOthers]::Run([uint32[]]$keep)
`;

/** Sei's own process ids (main, renderers, GPU, the wallpaper host): never minimized. */
function ownPids(): number[] {
  const pids = new Set<number>([process.pid]);
  try {
    for (const m of app.getAppMetrics()) pids.add(m.pid);
  } catch {
    /* main's own pid is enough to keep the main window */
  }
  return [...pids];
}

export async function minimizeOtherWindows(): Promise<MinimizeResult> {
  if (process.platform === 'darwin') {
    try {
      Menu.sendActionToFirstResponder('hideOtherApplications:');
      return { ok: true };
    } catch {
      return { ok: false, error: 'failed' };
    }
  }
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported' };
  const out = await runPowerShell(MINIMIZE_SCRIPT, PS_TIMEOUT_MS, { SEI_KEEP_PIDS: ownPids().join(',') });
  if (out === null) return { ok: false, error: 'failed' };
  const n = Number(out.split(/\s+/).pop());
  return { ok: true, minimized: Number.isFinite(n) ? n : undefined };
}
