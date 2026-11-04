# SeiLink host check (CI only, .github/workflows/seilink-host-check.yml): screenshot for selfTest.ts.
# Full virtual-screen capture via GDI BitBlt with SRCCOPY|CAPTUREBLT (includes layered windows).
# CopyFromScreen rejects the combined CopyPixelOperation value, so BitBlt is called directly.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class SeiShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
  public static Bitmap Grab() {
    SetProcessDPIAware();
    int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
    var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dst = g.GetHdc();
      IntPtr src = GetDC(IntPtr.Zero);
      bool ok = BitBlt(dst, 0, 0, w, h, src, x, y, 0x00CC0020 | 0x40000000);
      ReleaseDC(IntPtr.Zero, src);
      g.ReleaseHdc(dst);
      if (!ok) throw new Exception("BitBlt failed " + Marshal.GetLastWin32Error());
    }
    return bmp;
  }
}
"@
$bmp = [SeiShot]::Grab()
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($bmp.Width)x$($bmp.Height) -> $Path"
$bmp.Dispose()
