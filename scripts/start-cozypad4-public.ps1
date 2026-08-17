param(
  [int]$WebPort = 5173,
  [int]$ApiPort = 5174,
  [switch]$RestartTunnel
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$tunnelId = "60f47fa8-e390-4c4f-a416-777b2b825e2d"
$publicUrl = "https://cozypad.modoubletw.com/"
$originUrl = "http://127.0.0.1:$WebPort"
$logDir = Join-Path $root ".run-logs"
$legacyRoot = Join-Path $root "..\CozyPad"
$agentTunnelRoot = Join-Path $root "..\..\Agent\cloudflare_ddns_agent"
$credentialCandidates = @(
  (Join-Path $root "cloudflared-token-credentials.json")
)
if (Test-Path -LiteralPath $legacyRoot) {
  $credentialCandidates += Join-Path (Resolve-Path $legacyRoot).Path "cloudflared-token-credentials.json"
}
if (Test-Path -LiteralPath $agentTunnelRoot) {
  $credentialCandidates += Join-Path (Resolve-Path $agentTunnelRoot).Path "cloudflared-token-credentials.json"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-HttpOk {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    return [int]$response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Start-DetachedProcess {
  param(
    [string]$FileName,
    [string]$Arguments,
    [string]$WorkingDirectory
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  if ($process) {
    return $process.Id
  }
  return $null
}

function Start-CozyPadApi {
  $existing = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    return @($existing | ForEach-Object { $_.OwningProcess })
  }

  $args = "scripts\legacy-v2-api-server.mjs 1> .run-logs\api.out.log 2> .run-logs\api.err.log"
  $processId = Start-DetachedProcess -FileName "cmd.exe" -Arguments "/d /s /c `"node $args`"" -WorkingDirectory $root
  Start-Sleep -Seconds 2
  return @($processId)
}

function Start-CozyPadWeb {
  if (Test-HttpOk $originUrl) {
    return @()
  }

  $args = "pnpm --filter @cozypad/app dev 1> .run-logs\vite.out.log 2> .run-logs\vite.err.log"
  $processId = Start-DetachedProcess -FileName "cmd.exe" -Arguments "/d /s /c `"$args`"" -WorkingDirectory $root
  Start-Sleep -Seconds 5
  return @($processId)
}

function Get-TunnelCredentialFile {
  foreach ($candidate in $credentialCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  throw "Cloudflare tunnel credentials were not found. Reinstall this tunnel connector from Cloudflare Zero Trust."
}

if (-not (Test-Path -LiteralPath $cloudflared)) {
  throw "cloudflared.exe was not found."
}

$apiPids = Start-CozyPadApi
$webPids = Start-CozyPadWeb

if (-not (Test-HttpOk $originUrl)) {
  throw "CozyPad web origin is not reachable at $originUrl"
}

$credentialFile = Get-TunnelCredentialFile
$existingTunnel = @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
  Where-Object { $_.CommandLine -like "*$tunnelId*" })

$hasWrongTunnelOrigin = @($existingTunnel | Where-Object { $_.CommandLine -notlike "*--url $originUrl*" }).Count -gt 0

if (($RestartTunnel -or $hasWrongTunnelOrigin) -and $existingTunnel.Count -gt 0) {
  foreach ($process in $existingTunnel) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  $existingTunnel = @()
}

if ($existingTunnel.Count -eq 0) {
  $escapedCredential = $credentialFile.Replace('"', '\"')
  $escapedCloudflared = $cloudflared.Replace('"', '\"')
  $cloudflaredArgs = "tunnel --no-autoupdate --protocol http2 --url $originUrl --credentials-file `"$escapedCredential`" run $tunnelId 1> .run-logs\cloudflared.out.log 2> .run-logs\cloudflared.err.log"
  Start-DetachedProcess -FileName "cmd.exe" -Arguments "/d /s /c `"`"$escapedCloudflared`" $cloudflaredArgs`"" -WorkingDirectory $root | Out-Null
  Start-Sleep -Seconds 8
}

$runningTunnel = @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
  Where-Object { $_.CommandLine -like "*$tunnelId*" })

[pscustomobject]@{
  PublicUrl = $publicUrl
  OriginUrl = $originUrl
  ApiPort = $ApiPort
  ApiPids = $apiPids
  WebPids = $webPids
  TunnelRunning = $runningTunnel.Count -gt 0
  TunnelPids = @($runningTunnel | ForEach-Object { $_.ProcessId })
  Protocol = "http2"
  Logs = $logDir
} | ConvertTo-Json -Compress
