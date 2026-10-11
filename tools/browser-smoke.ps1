# Browser smoke test for CalSnap.
#
#   powershell -NoProfile -File tools/browser-smoke.ps1
#   powershell -NoProfile -File tools/browser-smoke.ps1 -BaseUrl http://127.0.0.1:5173
#
# Runs the fixtures in tests/browser-smoke.html and tests/browser-share.html through
# headless Chrome or Edge and prints the JSON each one reports. That checks the real
# DOM behaviour - extraction, the review step, the Google Calendar link, the .ics
# document and share-target handling - without a person clicking through the UI.
#
# Start the application first: npm start

param(
    [string]$BaseUrl = 'http://127.0.0.1:5173',
    [string]$Browser
)

$ErrorActionPreference = 'Continue'

if (-not $Browser) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    $Browser = ($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

if (-not $Browser -or -not (Test-Path $Browser)) {
    Write-Host 'No Chrome or Edge installation found. Pass -Browser <path to chrome.exe>.' -ForegroundColor Red
    exit 1
}

try {
    Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
    # A host serving from a sub-path (GitHub Pages project sites, for example)
    # redirects /repo to /repo/, so try once more with the trailing slash.
    try {
        $BaseUrl = $BaseUrl.TrimEnd('/') + '/'
        Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 5 | Out-Null
    } catch {
        Write-Host "CalSnap is not answering at $BaseUrl. Start it first with: npm start" -ForegroundColor Red
        exit 1
    }
}

# Fixture URLs are built from a base without a trailing slash.
$FixtureBase = $BaseUrl.TrimEnd('/')

Write-Host "Browser : $Browser"
Write-Host "Base URL: $BaseUrl"

function Invoke-Smoke {
    param([string]$Label, [string]$Url)

    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("calsnap-smoke-" + [guid]::NewGuid().ToString('N') + '.html')
    $profileDir = Join-Path ([System.IO.Path]::GetTempPath()) ("calsnap-profile-" + [guid]::NewGuid().ToString('N'))

    # Chrome writes noisy lines to stderr; they are not failures, so they are dropped.
    & $Browser --headless=new --disable-gpu --no-sandbox --no-first-run --disable-extensions `
        --user-data-dir="$profileDir" --virtual-time-budget=6000 --dump-dom $Url 2>$null |
        Out-File -FilePath $temp -Encoding utf8

    $dom = if (Test-Path $temp) { Get-Content -Raw -LiteralPath $temp } else { '' }
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host "===== $Label =====" -ForegroundColor Cyan
    if ($dom -match 'SMOKE_RESULTS=(\{.*?\})</pre>') {
        $json = $Matches[1] -replace '&quot;', '"' -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>'
        $json | ConvertFrom-Json | ConvertTo-Json -Depth 6
    } else {
        Write-Host "The fixture produced no result (DOM length: $($dom.Length))." -ForegroundColor Yellow
    }
}

Invoke-Smoke 'full workflow (paste, extract, Google link, .ics)' "$FixtureBase/tests/browser-smoke.html"

$shared = [uri]::EscapeDataString("Design Summit`nDate: 2026-05-01 at 10:00`nLocation: Hall B")
$sharedUrl = [uri]::EscapeDataString('https://example.com/summit')
Invoke-Smoke 'share target: text + url' "$FixtureBase/tests/browser-share.html?text=$shared&url=$sharedUrl"

$onlyUrl = [uri]::EscapeDataString('https://example.com/events/spring-product-launch')
Invoke-Smoke 'share target: url only (must not invent details)' "$FixtureBase/tests/browser-share.html?url=$onlyUrl"

$messy = [uri]::EscapeDataString(
    "Hi team!`n`n**Winter Party**`nWhen: Friday, 18 December 2026, 7:00 PM until late`nWhere: The Old Mill, Riverside`n`nBring a Secret Santa gift (max 15) and a dish to share.`nRSVP: https://example.com/rsvp"
)
Invoke-Smoke 'share target: messy real-world text' "$FixtureBase/tests/browser-share.html?text=$messy"

Write-Host ''
Write-Host 'Smoke tests finished. Compare the values above with the expectations in README section 6.' -ForegroundColor Green
