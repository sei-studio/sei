# Full virtual-screen capture via GDI with CAPTUREBLT (includes layered windows).
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class SeiDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][SeiDpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$op = [System.Drawing.CopyPixelOperation]([int][System.Drawing.CopyPixelOperation]::SourceCopy -bor [int][System.Drawing.CopyPixelOperation]::CaptureBlt)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size, $op)
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$($b.Width)x$($b.Height) -> $Path"
