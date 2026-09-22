# A real OS left click at a PHYSICAL screen point (goes through Windows hit
# testing, unlike webContents.sendInputEvent), then puts the cursor back.
param([int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public struct POINT { public int X; public int Y; }
}
'@
[void][M]::SetProcessDpiAwarenessContext([IntPtr](-4))
$p = New-Object M+POINT
[void][M]::GetCursorPos([ref]$p)
[void][M]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 50
[M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[void][M]::SetCursorPos($p.X, $p.Y)
