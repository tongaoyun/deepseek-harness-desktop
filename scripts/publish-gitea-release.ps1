[CmdletBinding()]
param(
  [string]$ArtifactRoot = "",
  [string]$ServerUrl = "http://192.168.2.66:3300",
  [string]$Repository = "instudio/xiaoyin-desktop",
  [string]$Tag = $env:GITHUB_REF_NAME
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "The Xiaoyin release publisher must run on the Windows release runner."
}
if ([string]::IsNullOrWhiteSpace($env:RELEASE_USERNAME) -or
    [string]::IsNullOrWhiteSpace($env:RELEASE_CREDENTIAL)) {
  throw "RELEASE_USERNAME and RELEASE_CREDENTIAL are required."
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactDirectory = if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
  Join-Path $repositoryRoot "windows-artifacts"
} else {
  [System.IO.Path]::GetFullPath($ArtifactRoot)
}
if (-not $artifactDirectory.StartsWith(($repositoryRoot.TrimEnd("\") + "\"), [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to publish files outside the repository workspace: $artifactDirectory"
}

$package = Get-Content (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$expectedTag = "v$version"
if ($Tag -ne $expectedTag) {
  throw "Release tag $Tag does not match package version $version ($expectedTag expected)."
}

$repositoryParts = $Repository.Split("/")
if ($repositoryParts.Count -ne 2 -or
    @($repositoryParts | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
  throw "Repository must use the owner/name format."
}
$owner = $repositoryParts[0]
$repositoryName = $repositoryParts[1]
$server = $ServerUrl.TrimEnd("/")
$api = "$server/api/v1/repos/$owner/$repositoryName"
$packageApi = "$server/api/packages/$owner/generic"

$basicCredential = [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes("$($env:RELEASE_USERNAME):$($env:RELEASE_CREDENTIAL)")
)
$headers = @{ Authorization = "Basic $basicCredential" }
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)

function Write-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  [System.IO.File]::WriteAllText(
    $Path,
    (($Value | ConvertTo-Json -Depth 10) + "`n"),
    $utf8WithoutBom
  )
}

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Get", "Post", "Patch")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    $Body,
    [switch]$AllowNotFound
  )
  try {
    $parameters = @{
      Uri = $Uri
      Method = $Method
      Headers = $headers
      UseBasicParsing = $true
    }
    if ($null -ne $Body) {
      $parameters.ContentType = "application/json"
      $parameters.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    return Invoke-RestMethod @parameters
  }
  catch {
    $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($AllowNotFound -and $statusCode -eq 404) { return $null }
    throw
  }
}

function Invoke-BinaryUpload {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Post", "Put")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Path
  )
  Invoke-WebRequest -Uri $Uri -Method $Method -Headers $headers -ContentType "application/octet-stream" -InFile $Path -UseBasicParsing | Out-Null
}

$expectedVersionToken = "_$($version)_"
$nsisInstaller = @(Get-ChildItem $artifactDirectory -File -Filter "*.exe" | Where-Object { $_.Name -like "*$expectedVersionToken*" })
$msiInstaller = @(Get-ChildItem $artifactDirectory -File -Filter "*.msi" | Where-Object { $_.Name -like "*$expectedVersionToken*" })
if ($nsisInstaller.Count -ne 1 -or $msiInstaller.Count -ne 1) {
  throw "Expected exactly one NSIS installer and one MSI installer."
}
$nsisSignature = Get-Item -LiteralPath ($nsisInstaller[0].FullName + ".sig")
$msiSignature = Get-Item -LiteralPath ($msiInstaller[0].FullName + ".sig")

$releaseFiles = @(
  [ordered]@{ Name = "xiaoyin-desktop_$($version)_windows-x64-setup.exe"; Path = $nsisInstaller[0].FullName; Role = "nsis-installer" },
  [ordered]@{ Name = "xiaoyin-desktop_$($version)_windows-x64-setup.exe.sig"; Path = $nsisSignature.FullName; Role = "nsis-signature" },
  [ordered]@{ Name = "xiaoyin-desktop_$($version)_windows-x64_zh-CN.msi"; Path = $msiInstaller[0].FullName; Role = "msi-installer" },
  [ordered]@{ Name = "xiaoyin-desktop_$($version)_windows-x64_zh-CN.msi.sig"; Path = $msiSignature.FullName; Role = "msi-signature" }
)

$publishedAt = [DateTime]::UtcNow.ToString("o")
$versionPackageBase = "$packageApi/xiaoyin-desktop/$version"
$updaterMetadataUrl = "$packageApi/xiaoyin-desktop-updater/latest/latest.json"
$nsisReleaseFile = $releaseFiles | Where-Object { $_.Role -eq "nsis-installer" } | Select-Object -First 1
$signature = (Get-Content -LiteralPath $nsisSignature.FullName -Raw).Trim()
$windowsPlatform = [ordered]@{
  signature = $signature
  url = "$versionPackageBase/$($nsisReleaseFile.Name)"
}
$platforms = [ordered]@{}
$platforms.Add("windows-x86_64", $windowsPlatform)
$latest = [ordered]@{
  version = $version
  notes = "小胤 $version 正式版"
  pub_date = $publishedAt
  platforms = $platforms
}
$latestPath = Join-Path $artifactDirectory "latest.json"
Write-JsonFile -Path $latestPath -Value $latest

$manifestArtifacts = @($releaseFiles | ForEach-Object {
  $file = Get-Item -LiteralPath $_.Path
  [ordered]@{
    name = $_.Name
    role = $_.Role
    size = $file.Length
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
})
$manifest = [ordered]@{
  schemaVersion = 1
  product = "xiaoyin-desktop"
  version = $version
  tag = $Tag
  commit = $env:GITHUB_SHA
  workflowRunId = $env:GITHUB_RUN_ID
  publishedAt = $publishedAt
  updaterMetadataUrl = $updaterMetadataUrl
  artifacts = $manifestArtifacts
}
$manifestPath = Join-Path $artifactDirectory "release-manifest.json"
Write-JsonFile -Path $manifestPath -Value $manifest

$checksumPath = Join-Path $artifactDirectory "RELEASE-SHA256SUMS.txt"
$checksumLines = @($manifestArtifacts | ForEach-Object { "$($_.sha256)  $($_.name)" })
[System.IO.File]::WriteAllText($checksumPath, (($checksumLines -join "`n") + "`n"), $utf8WithoutBom)

$release = Invoke-JsonRequest -Method Get -Uri "$api/releases/tags/$([Uri]::EscapeDataString($Tag))" -AllowNotFound
if ($release -and -not $release.draft) {
  throw "Release $Tag is already published; refusing to replace immutable release assets."
}
if (-not $release) {
  $release = Invoke-JsonRequest -Method Post -Uri "$api/releases" -Body ([ordered]@{
    tag_name = $Tag
    target_commitish = $env:GITHUB_SHA
    name = "小胤 $version"
    body = "小胤 $version 正式版。安装包、更新签名、SHA-256 清单和发布审计清单均由 Gitea Actions 生成。"
    draft = $true
    prerelease = $false
  })
}

$releaseAssets = @(
  $releaseFiles +
  @(
    [ordered]@{ Name = "SHA256SUMS.txt"; Path = $checksumPath },
    [ordered]@{ Name = "release-manifest.json"; Path = $manifestPath },
    [ordered]@{ Name = "latest.json"; Path = $latestPath }
  )
)
foreach ($asset in $releaseAssets) {
  $assetName = [Uri]::EscapeDataString([string]$asset.Name)
  Invoke-BinaryUpload -Method Post -Uri "$api/releases/$($release.id)/assets?name=$assetName" -Path $asset.Path
  Write-Output "Uploaded release asset: $($asset.Name)"
}

$versionPackageFiles = @(
  $releaseFiles +
  @(
    [ordered]@{ Name = "latest.json"; Path = $latestPath },
    [ordered]@{ Name = "release-manifest.json"; Path = $manifestPath },
    [ordered]@{ Name = "SHA256SUMS.txt"; Path = $checksumPath }
  )
)
foreach ($asset in $versionPackageFiles) {
  $packageName = [Uri]::EscapeDataString([string]$asset.Name)
  Invoke-BinaryUpload -Method Put -Uri "$versionPackageBase/$packageName" -Path $asset.Path
  Write-Output "Published immutable package: $($asset.Name)"
}

$latestPackageApi = "$server/api/v1/packages/$owner/generic/xiaoyin-desktop-updater/latest"
try {
  Invoke-WebRequest -Uri $latestPackageApi -Method Delete -Headers $headers -UseBasicParsing | Out-Null
}
catch {
  $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  if ($statusCode -ne 404) { throw }
}
Invoke-BinaryUpload -Method Put -Uri $updaterMetadataUrl -Path $latestPath

$publishedMetadata = Invoke-RestMethod -Uri $updaterMetadataUrl -Method Get -UseBasicParsing
$publishedWindows = $publishedMetadata.platforms.PSObject.Properties["windows-x86_64"].Value
if ($publishedMetadata.version -ne $version -or
    $publishedWindows.signature -ne $signature) {
  throw "Published updater metadata did not pass the anonymous read-back check."
}

$release = Invoke-JsonRequest -Method Patch -Uri "$api/releases/$($release.id)" -Body ([ordered]@{
  tag_name = $Tag
  target_commitish = $env:GITHUB_SHA
  name = "小胤 $version"
  body = "小胤 $version 正式版。安装包、更新签名、SHA-256 清单和发布审计清单均由 Gitea Actions 生成。"
  draft = $false
  prerelease = $false
})

Write-Output "Published Gitea release: $($release.html_url)"
Write-Output "Updater metadata: $updaterMetadataUrl"
