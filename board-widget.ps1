param([Parameter(Mandatory=$true)][string]$Url)
$ErrorActionPreference = "SilentlyContinue"

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $edge)) { exit 1 }

Start-Process -FilePath $edge -ArgumentList "--app=$Url", "--window-size=560,760", "--window-position=980,80" | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshTopmost {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
}
"@

$target = [string][char]0x5C0F + "D " + [char]0x00B7 + " " + [char]0x9ED1 + [char]0x677F
$HWND_TOPMOST = [IntPtr]::new(-1)
$flags = 0x0001 -bor 0x0002 -bor 0x0010

for ($i = 0; $i -lt 21600; $i++) {
    $p = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $target } | Select-Object -First 1
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
        [DshTopmost]::SetWindowPos($p.MainWindowHandle, $HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null
    }
    Start-Sleep -Seconds 2
}
