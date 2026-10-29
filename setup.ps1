# One-time setup for dsh-tutor (Windows, PowerShell 5.1+)
# Installs: embedded Python 3.11, offline STT (faster-whisper), optional Edge TTS.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupDir = Join-Path $root ".setup"
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
$env:TEMP = $setupDir
$env:TMP = $setupDir
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"

function Info($m) { Write-Host "[setup] $m" }

Info "checking node..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 18+ is required: https://nodejs.org" }
node --version

Info "checking ffmpeg..."
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ff) { Info ("ffmpeg: " + $ff.Source) }
else { Info "ffmpeg not found on PATH. Audio conversion needs it; set FFMPEG_PATH or install ffmpeg." }

# ---------- embedded python 3.11 ----------
$pyDir = Join-Path $root "stt\py311"
$python = Join-Path $pyDir "python.exe"
if (-not (Test-Path $python)) {
    Info "downloading Python 3.11 embeddable..."
    $zip = Join-Path $setupDir "py311.zip"
    $urls = @(
        "https://registry.npmmirror.com/-/binary/python/3.11.9/python-3.11.9-embed-amd64.zip",
        "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
    )
    foreach ($u in $urls) {
        try {
            Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 120
            if ((Get-Item $zip).Length -gt 5MB) { break }
        } catch { Info ("download failed: " + $u) }
    }
    if (-not (Test-Path $zip)) { throw "could not download Python embeddable" }
    Expand-Archive -Path $zip -DestinationPath $pyDir -Force
    $pth = Join-Path $pyDir "python311._pth"
    $lines = Get-Content $pth
    $lines = $lines -replace '^#import site$', 'import site'
    if ($lines -notcontains "Lib\site-packages") { $lines += "Lib\site-packages" }
    Set-Content -Path $pth -Value $lines -Encoding ascii
}

if (-not (Test-Path (Join-Path $pyDir "Scripts\pip.exe"))) {
    Info "installing pip..."
    $getpip = Join-Path $setupDir "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getpip -UseBasicParsing
    & $python $getpip --no-warn-script-location
}

Info "installing offline speech recognition (faster-whisper)..."
& $python -m pip install --no-cache-dir --disable-pip-version-check --timeout 60 --retries 5 `
    -i https://pypi.tuna.tsinghua.edu.cn/simple faster-whisper

# ---------- optional edge-tts for higher quality voices ----------
Info "installing Edge TTS (optional, cloud voices)..."
$vendor = Join-Path $root "vendor"
if (-not (Test-Path (Join-Path $vendor "edge_tts"))) {
    & $python -m pip install --no-cache-dir --disable-pip-version-check --target $vendor edge-tts
}

# ---------- config ----------
$config = Join-Path $root "config.json"
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $root "config.example.json") $config
    Info "created config.json - put your DeepSeek API key in it, or set DEEPSEEK_API_KEY"
}

Info "done. Run start.cmd"
