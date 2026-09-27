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

# Keep Windows packaging usable on clean build agents that do not expose a
# global pnpm command, matching the macOS staging path.
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$pnpmExecutable = $null
$pnpmPrefix = @()
if ($null -ne $pnpmCommand) {
  $pnpmExecutable = $pnpmCommand.Source
} else {
  $corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
  if ($null -ne $corepackCommand) {
    $pnpmExecutable = $corepackCommand.Source
    $pnpmPrefix = @("pnpm")
  } else {
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
    if ($null -eq $npxCommand) {
      throw "pnpm is unavailable and neither corepack nor npx could be found."
    }
    $pnpmExecutable = $npxCommand.Source
    $pnpmPrefix = @("--yes", "pnpm@10")
  }
}

if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Push-Location $repository
try {
  & $pnpmExecutable @pnpmPrefix --dir harness-host build
  if ($LASTEXITCODE -ne 0) { throw "Harness Host build failed." }

  $hostStage = Join-Path $stage "harness-host"
  & $pnpmExecutable @pnpmPrefix --config.node-linker=hoisted --filter '@xiaoyin/harness-host' --prod deploy $hostStage
  if ($LASTEXITCODE -ne 0) { throw "Portable Harness dependency deployment failed." }

  # Runtime imports packages directly; package-manager command shims are not used by the desktop app.
  $commandShims = Join-Path $hostStage "node_modules\.bin"
  if (Test-Path -LiteralPath $commandShims) {
    Remove-Item -LiteralPath $commandShims -Recurse -Force
  }

  # Keep the Windows runtime aligned with the macOS staging path so Tauri
  # spends less time hashing and compressing files Node never loads at runtime.
  foreach ($path in @(
    (Join-Path $hostStage "src"),
    (Join-Path $hostStage "tsconfig.json"),
    (Join-Path $hostStage "pnpm-lock.yaml")
  )) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
  foreach ($directory in @(
    (Join-Path $hostStage "node_modules\@types")
  )) {
    if (Test-Path -LiteralPath $directory) {
      Remove-Item -LiteralPath $directory -Recurse -Force
    }
  }
  Get-ChildItem -LiteralPath (Join-Path $hostStage "dist") -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @(".d.ts", ".map") } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath (Join-Path $hostStage "node_modules") -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @(".map", ".pdb") } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  # Optional dependencies publish one package per platform. Do not carry
  # Darwin/Linux/ARM native binaries into the Windows x64 installer.
  $platformPackagePattern = "-(darwin|linux|freebsd|android|win32-arm64|win32-ia32)(-|$)"
  Get-ChildItem -LiteralPath (Join-Path $hostStage "node_modules") -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $platformPackagePattern } |
    Sort-Object FullName -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  $nodePtyPrebuilds = Join-Path $hostStage "node_modules\node-pty\prebuilds"
  if (Test-Path -LiteralPath $nodePtyPrebuilds) {
    Get-ChildItem -LiteralPath $nodePtyPrebuilds -Directory |
      Where-Object { $_.Name -notmatch "^win32-x64" } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}
finally {
  Pop-Location
}

$nodeStage = Join-Path $stage "node"
New-Item -ItemType Directory -Force -Path $nodeStage | Out-Null
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $nodeStage "node.exe")

$licenseDestination = Join-Path $nodeStage "LICENSE"
$nodeLicense = Join-Path $repository "third-party\node-v24.19.0\LICENSE"
if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
  throw "Pinned Node.js license notice is missing: $nodeLicense"
}
Copy-Item -LiteralPath $nodeLicense -Destination $licenseDestination
$expectedLicenseSha256 = "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5"
$licenseSha256 = (Get-FileHash -LiteralPath $licenseDestination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($licenseSha256 -ne $expectedLicenseSha256) {
  throw "Node.js $nodeVersion LICENSE SHA-256 mismatch: $licenseSha256"
}

$stagedNode = Join-Path $nodeStage "node.exe"
$stagedEntry = Join-Path $stage "harness-host\dist\index.js"
$stagedConfig = Join-Path $stage "harness-host\runtime\cordis.yml"
$cacheBase = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  [System.IO.Path]::GetTempPath()
} else {
  $env:LOCALAPPDATA
}
$primaryCache = Join-Path $cacheBase "xiaoyin-desktop-builder\primary-runtime"
& $nodeExecutable (Join-Path $PSScriptRoot "download-official-harness-runtime.mjs") `
  --target win-x64 --output $stage --cache $primaryCache
if ($LASTEXITCODE -ne 0) { throw "Official Primary Runtime preparation failed." }

$primaryManifest = Join-Path $stage "primary-runtime\runtime.json"
$officeChecker = Join-Path $stage "office-skills\scripts\check_office.py"
foreach ($required in @($stagedNode, $stagedEntry, $stagedConfig, $primaryManifest, $officeChecker)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Packaged Harness file is missing: $required"
  }
}

& $stagedNode (Join-Path $PSScriptRoot "check-harness-runtime.mjs") $stagedNode $hostStage
if ($LASTEXITCODE -ne 0) { throw "Packaged Harness health check failed with exit code $LASTEXITCODE." }

$manifest = [ordered]@{
  schemaVersion = 1
  platform = "windows-x64"
  nodeVersion = $nodeVersion
  generatedAt = [DateTime]::UtcNow.ToString("o")
  files = [ordered]@{
    node = (Get-FileHash -LiteralPath $stagedNode -Algorithm SHA256).Hash.ToLowerInvariant()
    entry = (Get-FileHash -LiteralPath $stagedEntry -Algorithm SHA256).Hash.ToLowerInvariant()
    config = (Get-FileHash -LiteralPath $stagedConfig -Algorithm SHA256).Hash.ToLowerInvariant()
    primaryRuntime = (Get-FileHash -LiteralPath $primaryManifest -Algorithm SHA256).Hash.ToLowerInvariant()
    officeSkills = (Get-FileHash -LiteralPath $officeChecker -Algorithm SHA256).Hash.ToLowerInvariant()
    lockfile = (Get-FileHash -LiteralPath (Join-Path $repository "pnpm-lock.yaml") -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$manifestPath = Join-Path $stage "runtime-manifest.json"
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 4) + "`n"), $utf8WithoutBom)

Write-Output "Packaged Harness runtime is ready: $stage"
Write-Output "Node runtime: $nodeVersion"
