param([switch]$Rebuild, [switch]$RestartTunnel)

$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'cloudflare-public.json'))) {
  throw 'Copy scripts/cloudflare-public.example.json to scripts/cloudflare-public.json and configure your own Cloudflare tunnel first.'
}
$Settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot "cloudflare-public.json") -Encoding UTF8 | ConvertFrom-Json
if ($Settings.tunnelId -notmatch '^[0-9a-f-]{36}$' -or $Settings.hostname -notmatch '^[a-z0-9]+([.-][a-z0-9]+)+$' -or $Settings.port -lt 1024 -or $Settings.port -gt 65535) {
  throw "Invalid public deployment settings."
}
$Port = [int]$Settings.port
$PublicOrigin = "https://$($Settings.hostname)"
$LocalOrigin = "http://127.0.0.1:$Port"
$LogDir = Join-Path $Root ".run-logs"
$RuntimePath = Join-Path $LogDir "public-runtime.json"
$TunnelConfig = Join-Path $LogDir "cozypadtt-tunnel.yml"
$CredentialFile = Join-Path $env:USERPROFILE ".cloudflared\$($Settings.tunnelId).json"
$CloudflaredCommand = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
$Cloudflared = if ($CloudflaredCommand) { $CloudflaredCommand.Source } else { "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Entry = Join-Path $Root "apps\server\src\index.mjs"
if (!(Test-Path -LiteralPath $CredentialFile) -or !(Test-Path -LiteralPath $Cloudflared)) { throw "Cloudflare tunnel credentials or cloudflared were not found." }

$LaunchMutex = [Threading.Mutex]::new($false, "Local\CozyPadTT.PublicLauncher")
$LockAcquired = $false
try {
try { $LockAcquired = $LaunchMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $LockAcquired = $true }
if (!$LockAcquired) { throw "Another CozyPadTT launcher is running. Check its status before retrying." }

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Runtime = if (Test-Path -LiteralPath $RuntimePath) { Get-Content -LiteralPath $RuntimePath -Encoding UTF8 | ConvertFrom-Json } else { $null }

function Test-TtHealth {
  param([string]$Origin)
  try {
    $health = Invoke-RestMethod -Uri "$Origin/api/health" -TimeoutSec 5
    return $health.ok -eq $true -and $health.name -eq "CozyPad TT" -and $health.version -eq "4.0.0"
  } catch { return $false }
}

function Wait-TtHealth {
  param([string]$Origin, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-TtHealth $Origin) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

$Listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
$ExistingApp = $null
if ($Listeners.Count -gt 0) {
  if ($Runtime -and $Runtime.root -eq $Root -and $Runtime.publicOrigin -eq $PublicOrigin -and $Listeners.OwningProcess -contains $Runtime.appPid) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$($Runtime.appPid)" -ErrorAction SilentlyContinue
    if ($candidate.Name -eq 'node.exe' -and $candidate.CommandLine.Contains($Entry) -and (Test-TtHealth $LocalOrigin)) { $ExistingApp = $candidate }
  }
  if (!$ExistingApp) { throw "Port $Port is occupied by an unmanaged process. No existing process was stopped." }
  if ($Rebuild) { throw "Stop the managed public server before rebuilding its live assets." }
}

if ($Rebuild -or !(Test-Path -LiteralPath (Join-Path $Root "apps\app\dist\index.html"))) {
  Push-Location $Root
  try {
    $Pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (!$Pnpm) { $Pnpm = Get-Command pnpm -ErrorAction Stop }
    & $Pnpm.Source build
    if ($LASTEXITCODE -ne 0) { throw "CozyPad TT build failed." }
  } finally { Pop-Location }
}

if ($ExistingApp) { $AppPid = $ExistingApp.ProcessId }
else {
  $Environment = @{
    COZYPAD_HOST = "127.0.0.1"
    COZYPAD_WEB_PORT = "$Port"
    COZYPAD_API_PORT = "$Port"
    COZYPAD_PUBLIC_ORIGIN = $PublicOrigin
    COZYPAD_COOKIE_SECURE = "true"
    COZYPAD_DATA_DIR = (Join-Path $Root "data")
    NODE_ENV = "production"
  }
  $Previous = @{}
  foreach ($key in $Environment.Keys) { $Previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process") }
  try {
    foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable($key, $Environment[$key], "Process") }
    $App = Start-Process -FilePath $Node -ArgumentList "`"$Entry`"" -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $LogDir "public-app.out.log") -RedirectStandardError (Join-Path $LogDir "public-app.err.log")
    $AppPid = $App.Id
  } finally {
    foreach ($key in $Previous.Keys) { [Environment]::SetEnvironmentVariable($key, $Previous[$key], "Process") }
  }
  if (!(Wait-TtHealth $LocalOrigin 45)) { throw "CozyPad TT origin did not become healthy. Check .run-logs/public-app.err.log." }
}

# The credentials stay outside the project; only their path is written to the runtime config.
$CredentialPath = $CredentialFile.Replace("\", "/")
$Yaml = @(
  "tunnel: $($Settings.tunnelId)",
  "credentials-file: '$CredentialPath'",
  "protocol: http2",
  "ingress:",
  "  - hostname: $($Settings.hostname)",
  "    service: $LocalOrigin",
  "  - service: http_status:404"
) -join "`n"
Set-Content -LiteralPath $TunnelConfig -Value $Yaml -Encoding UTF8
& $Cloudflared tunnel --config $TunnelConfig ingress validate
if ($LASTEXITCODE -ne 0) { throw "Cloudflare ingress validation failed." }

$TunnelProcesses = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($TunnelConfig) -and $_.CommandLine.Contains($Settings.tunnelId) })
if ($TunnelProcesses.Count -gt 1) { throw "Multiple CozyPad TT tunnel processes already exist. No additional process was started." }
if ($RestartTunnel -and $TunnelProcesses.Count -eq 1) {
  Stop-Process -Id $TunnelProcesses[0].ProcessId -ErrorAction Stop
  $TunnelProcesses = @()
}
if ($TunnelProcesses.Count -eq 1) { $TunnelPid = $TunnelProcesses[0].ProcessId }
else {
  $Tunnel = Start-Process -FilePath $Cloudflared -ArgumentList "--no-autoupdate tunnel --config `"$TunnelConfig`" run $($Settings.tunnelId)" -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "public-tunnel.out.log") -RedirectStandardError (Join-Path $LogDir "public-tunnel.err.log")
  $TunnelPid = $Tunnel.Id
}
@{ root = $Root; publicOrigin = $PublicOrigin; localOrigin = $LocalOrigin; appPid = $AppPid; tunnelPid = $TunnelPid; tunnelId = $Settings.tunnelId; startedAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $RuntimePath -Encoding UTF8
if (!(Wait-TtHealth $PublicOrigin 60)) { throw "Public HTTPS health check failed. The processes were retained; check DNS and .run-logs/public-tunnel.err.log." }
Write-Output "CozyPad TT is live: $PublicOrigin/ (app PID $AppPid, tunnel PID $TunnelPid)"
} finally {
  if ($LockAcquired) { $LaunchMutex.ReleaseMutex() }
  $LaunchMutex.Dispose()
}
