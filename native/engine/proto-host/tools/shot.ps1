# Capture a PHYSICAL-pixel screen rectangle to PNG — what the user sees,
# including native child windows (CDP Page.captureScreenshot cannot see those).
param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v); }
'@
[void][Dpi]::SetProcessDpiAwarenessContext([System.IntPtr](-4))  # PER_MONITOR_AWARE_V2
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
