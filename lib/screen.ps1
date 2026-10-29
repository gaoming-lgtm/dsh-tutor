param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing | Out-Null
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshWin {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@

[DshWin]::SetProcessDPIAware() | Out-Null
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size)
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

$sb = New-Object System.Text.StringBuilder 512
$hwnd = [DshWin]::GetForegroundWindow()
[DshWin]::GetWindowText($hwnd, $sb, 512) | Out-Null

[ordered]@{ width = $screen.Width; height = $screen.Height; title = $sb.ToString(); path = $Out } | ConvertTo-Json -Compress
