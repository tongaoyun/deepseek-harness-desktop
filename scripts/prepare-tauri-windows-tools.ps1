[CmdletBinding()]
param(
  [string]$PackageBaseUrl = "http://192.168.2.66:3300/api/packages/instudio/generic/tauri-bundler-tools/2.11.4"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Tauri Windows tools must be prepared on Windows."
}
if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
  throw "CARGO_TARGET_DIR must be set to the dedicated Windows build target directory."
}

$targetRoot = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
$toolsRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot ".tauri"))
if (-not $toolsRoot.StartsWith(($targetRoot.TrimEnd("\") + "\"), [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to prepare tools outside CARGO_TARGET_DIR: $toolsRoot"
}

$wixRoot = Join-Path $toolsRoot "WixTools314"
$nsisRoot = Join-Path $toolsRoot "NSIS"
$downloadRoot = Join-Path $toolsRoot "downloads"
$wixArchive = Join-Path $downloadRoot "wix314-binaries.zip"
$nsisArchive = Join-Path $downloadRoot "nsis-3.11.zip"
$nsisPlugin = Join-Path $downloadRoot "nsis_tauri_utils.dll"

$wixSha256 = "6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31"
$nsisSha1 = "ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d"
$nsisPluginSha1 = "75197fee3c6a814fe035788d1c34ead39349b860"

function Assert-ToolsChildPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith(($toolsRoot.TrimEnd("\") + "\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the dedicated Tauri tools directory: $resolved"
  }
  return $resolved
}

function Test-RequiredFiles {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths
  )
  foreach ($relativePath in $RelativePaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relativePath) -PathType Leaf)) {
      return $false
    }
  }
  return $true
}

function Get-VerifiedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][ValidateSet("SHA1", "SHA256")][string]$Algorithm,
    [Parameter(Mandatory = $true)][string]$ExpectedHash
  )

  $destinationPath = Assert-ToolsChildPath -Path $Destination
  if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
    $cachedHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm $Algorithm).Hash.ToLowerInvariant()
    if ($cachedHash -eq $ExpectedHash) {
      Write-Output "Using verified cached download: $destinationPath"
      return
    }
    Remove-Item -LiteralPath $destinationPath -Force
  }

  $temporaryPath = Assert-ToolsChildPath -Path ($destinationPath + ".download-" + [guid]::NewGuid().ToString("N"))
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $temporaryPath -UseBasicParsing -TimeoutSec 300
    $downloadedHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm $Algorithm).Hash.ToLowerInvariant()
    if ($downloadedHash -ne $ExpectedHash) {
      throw "$Algorithm mismatch for $Uri; expected $ExpectedHash, found $downloadedHash"
    }
    Move-Item -LiteralPath $temporaryPath -Destination $destinationPath
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

$wixRequired = @("candle.exe", "light.exe", "darice.cub", "WixUIExtension.dll")
$nsisRequired = @("makensis.exe", "Plugins\x86-unicode\additional\nsis_tauri_utils.dll")
New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
$baseUrl = $PackageBaseUrl.TrimEnd("/")
Get-VerifiedFile -Uri "$baseUrl/wix314-binaries.zip" -Destination $wixArchive -Algorithm SHA256 -ExpectedHash $wixSha256
Get-VerifiedFile -Uri "$baseUrl/nsis-3.11.zip" -Destination $nsisArchive -Algorithm SHA1 -ExpectedHash $nsisSha1
Get-VerifiedFile -Uri "$baseUrl/nsis_tauri_utils.dll" -Destination $nsisPlugin -Algorithm SHA1 -ExpectedHash $nsisPluginSha1

$wixStage = Assert-ToolsChildPath -Path (Join-Path $toolsRoot ("stage-wix-" + [guid]::NewGuid().ToString("N")))
$nsisStage = Assert-ToolsChildPath -Path (Join-Path $toolsRoot ("stage-nsis-" + [guid]::NewGuid().ToString("N")))
try {
  Expand-Archive -LiteralPath $wixArchive -DestinationPath $wixStage
  Expand-Archive -LiteralPath $nsisArchive -DestinationPath $nsisStage

  $expandedNsis = Join-Path $nsisStage "nsis-3.11"
  $pluginDestination = Join-Path $expandedNsis "Plugins\x86-unicode\additional\nsis_tauri_utils.dll"
  New-Item -ItemType Directory -Force -Path (Split-Path $pluginDestination -Parent) | Out-Null
  Copy-Item -LiteralPath $nsisPlugin -Destination $pluginDestination

  if (-not (Test-RequiredFiles -Root $wixStage -RelativePaths $wixRequired)) {
    throw "The verified WiX archive did not contain the files required by Tauri."
  }
  if (-not (Test-RequiredFiles -Root $expandedNsis -RelativePaths $nsisRequired)) {
    throw "The verified NSIS archive did not contain the files required by Tauri."
  }

  foreach ($existingRoot in @($wixRoot, $nsisRoot)) {
    $safeRoot = Assert-ToolsChildPath -Path $existingRoot
    if (Test-Path -LiteralPath $safeRoot) {
      Remove-Item -LiteralPath $safeRoot -Recurse -Force
    }
  }
  Move-Item -LiteralPath $wixStage -Destination $wixRoot
  Move-Item -LiteralPath $expandedNsis -Destination $nsisRoot
}
finally {
  foreach ($stageRoot in @($wixStage, $nsisStage)) {
    if (Test-Path -LiteralPath $stageRoot) {
      Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
  }
}

if (-not ((Test-RequiredFiles -Root $wixRoot -RelativePaths $wixRequired) -and
          (Test-RequiredFiles -Root $nsisRoot -RelativePaths $nsisRequired))) {
  throw "Tauri Windows bundler tool preparation was incomplete."
}

Write-Output "Tauri Windows bundler tools are ready: $toolsRoot"
