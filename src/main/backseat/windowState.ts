/**
 * Is a shared window minimized right now (261123)?
 *
 * Asked only after Chromium refused to capture a window (`capture_failed:busy`,
 * a NotReadableError). Windows' window capturer refuses a minimized window, and
 * a fullscreen game minimizes itself when the player alt-tabs to Sei to press
 * Share, so this is the one fact that says whether that is what happened. It
 * rides the failure analytics as a tri-state; nothing else reads it.
 *
 * Electron names a Windows window source `window:<HWND>:0`, so the handle is
 * in the id. One short PowerShell call (IsIconic through Add-Type), the same
 * route as seilink/minimizeOthers.ts. Not testable on the Linux build box
 * beyond the id parsing: hand-test on Windows.
 */
import { runPowerShell } from '../winPowerShell';

const PS_TIMEOUT_MS = 5_000;

/** The HWND of a Windows window source id, or null. */
export function hwndOfSource(sourceId: string): string | null {
  const m = /^window:(\d{1,20}):/.exec(sourceId);
  return m ? m[1] : null;
}

export const IS_ICONIC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SeiWin -Name State -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);'
$h = [IntPtr][Int64]$env:SEI_HWND
if (-not [SeiWin.State]::IsWindow($h)) { 'gone' } elseif ([SeiWin.State]::IsIconic($h)) { 'yes' } else { 'no' }
`;

export async function isWindowSourceMinimized(sourceId: string): Promise<boolean | null> {
  if (process.platform !== 'win32') return null;
  const hwnd = hwndOfSource(sourceId);
  if (!hwnd) return null;
  const out = await runPowerShell(IS_ICONIC_SCRIPT, PS_TIMEOUT_MS, { SEI_HWND: hwnd });
  if (out === 'yes') return true;
  if (out === 'no') return false;
  return null;
}
