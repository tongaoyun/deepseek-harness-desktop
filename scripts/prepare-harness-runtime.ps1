[CmdletBinding()]
param(
  [string]$StageRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Harness packaging must run on Windows because it contains native dependencies."
}
if ([Environment]::Is64BitOperatingSystem -ne $true -or [Environment]::Is64BitProcess -ne $true) {
  throw "Harness packaging requires a 64-bit Windows process."
}

$repository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $repository "src-tauri\resources\harness-runtime"))
$stage = if ([string]::IsNullOrWhiteSpace($StageRoot)) {
  $expectedRoot
} else {
  [System.IO.Path]::GetFullPath($StageRoot)
}
if ($stage -ne $expectedRoot) {
  throw "Refusing to stage outside the dedicated Tauri resource directory: $stage"
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeExecutable = [System.IO.Path]::GetFullPath($nodeCommand.Source)
$nodeVersion = (& $nodeExecutable --version).Trim()
$expectedNodeVersion = "v24.19.0"
if ($nodeVersion -ne $expectedNodeVersion) {
  throw "Node.js $expectedNodeVersion is required; found $nodeVersion at $nodeExecutable"
}

if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Push-Location $repository
try {
  pnpm --dir harness-host build
  if ($LASTEXITCODE -ne 0) { throw "Harness Host build failed." }

  $hostStage = Join-Path $stage "harness-host"
  pnpm --config.node-linker=hoisted --filter '@xiaoyin/harness-host' --prod deploy $hostStage
  if ($LASTEXITCODE -ne 0) { throw "Portable Harness dependency deployment failed." }

  # Runtime imports packages directly; package-manager command shims are not used by the desktop app.
  $commandShims = Join-Path $hostStage "node_modules\.bin"
  if (Test-Path -LiteralPath $commandShims) {
    Remove-Item -LiteralPath $commandShims -Recurse -Force
  }
}
finally {
  Pop-Location
}

$nodeStage = Join-Path $stage "node"
New-Item -ItemType Directory -Force -Path $nodeStage | Out-Null
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $nodeStage "node.exe")

$nodeDirectory = Split-Path -Parent $nodeExecutable
$licenseDestination = Join-Path $nodeStage "LICENSE"
$licenseCandidates = @(
  (Join-Path $nodeDirectory "LICENSE"),
  (Join-Path $nodeDirectory "LICENSE.txt")
)
$nodeLicense = $licenseCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ($nodeLicense) {
  Copy-Item -LiteralPath $nodeLicense -Destination $licenseDestination
} else {
  $licenseUri = "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE"
  Write-Output "Node.js MSI did not install LICENSE; downloading the pinned official notice from $licenseUri"
  Invoke-WebRequest -Uri $licenseUri -OutFile $licenseDestination -UseBasicParsing -TimeoutSec 60
}
$expectedLicenseSha256 = "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5"
$licenseSha256 = (Get-FileHash -LiteralPath $licenseDestination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($licenseSha256 -ne $expectedLicenseSha256) {
  throw "Node.js $nodeVersion LICENSE SHA-256 mismatch: $licenseSha256"
}

$stagedNode = Join-Path $nodeStage "node.exe"
$stagedEntry = Join-Path $stage "harness-host\dist\index.js"
$stagedConfig = Join-Path $stage "harness-host\runtime\cordis.yml"
foreach ($required in @($stagedNode, $stagedEntry, $stagedConfig)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Packaged Harness file is missing: $required"
  }
}

$previousConfig = $env:DSH_CORDIS_CONFIG
$env:DSH_CORDIS_CONFIG = $stagedConfig
try {
  $requests = @(
    '{"jsonrpc":"2.0","id":1,"method":"host.health"}',
    '{"jsonrpc":"2.0","id":2,"method":"host.shutdown"}'
  )
  $responses = @($requests | & $stagedNode $stagedEntry)
  if ($LASTEXITCODE -ne 0) { throw "Packaged Harness health process exited with $LASTEXITCODE." }
}
finally {
  $env:DSH_CORDIS_CONFIG = $previousConfig
}

$health = $responses | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.id -eq 1 } | Select-Object -First 1
if (-not $health -or $health.result.status -ne "ready") {
  throw "Packaged Harness health check did not return ready."
}

$manifest = [ordered]@{
  schemaVersion = 1
  platform = "windows-x64"
  nodeVersion = $nodeVersion
  generatedAt = [DateTime]::UtcNow.ToString("o")
  files = [ordered]@{
    node = (Get-FileHash -LiteralPath $stagedNode -Algorithm SHA256).Hash.ToLowerInvariant()
    entry = (Get-FileHash -LiteralPath $stagedEntry -Algorithm SHA256).Hash.ToLowerInvariant()
    config = (Get-FileHash -LiteralPath $stagedConfig -Algorithm SHA256).Hash.ToLowerInvariant()
    lockfile = (Get-FileHash -LiteralPath (Join-Path $repository "pnpm-lock.yaml") -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$manifestPath = Join-Path $stage "runtime-manifest.json"
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 4) + "`n"), $utf8WithoutBom)

Write-Output "Packaged Harness runtime is ready: $stage"
Write-Output "Node runtime: $nodeVersion"
