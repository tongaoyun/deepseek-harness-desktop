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
Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
$httpClient = [System.Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromMinutes(60)
$httpClient.DefaultRequestHeaders.Authorization =
  [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", $basicCredential)

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
    [Parameter(Mandatory = $true)][ValidateSet("Get", "Post", "Patch", "Delete")][string]$Method,
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

function Start-BinaryUpload {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Post", "Put")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  # Invoke-WebRequest can misinterpret package paths ending in .sig on the Windows
  # runner as a response filename. Stream the file with one shared HttpClient so
  # release assets reuse the same connection pool instead of reconnecting for
  # every installer and metadata file.
  $stream = $null
  $content = $null
  $request = $null
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    $content = [System.Net.Http.StreamContent]::new($stream)
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new("application/octet-stream")
    $request = [System.Net.Http.HttpRequestMessage]::new(
      [System.Net.Http.HttpMethod]::new($Method.ToUpperInvariant()),
      $Uri
    )
    $request.Content = $content
    $task = $httpClient.SendAsync(
      $request,
      [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
    )
    return [pscustomobject]@{
      Label = $Label
      Path = $Path
      Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      Task = $task
      Request = $request
      Content = $content
      Stream = $stream
    }
  }
  catch {
    if ($request) { $request.Dispose() }
    if ($content) { $content.Dispose() }
    if ($stream) { $stream.Dispose() }
    throw
  }
}

function Complete-BinaryUpload {
  param([Parameter(Mandatory = $true)]$Upload)
  $response = $null
  try {
    $response = $Upload.Task.GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      throw "Binary upload failed: HTTP $([int]$response.StatusCode) $($response.ReasonPhrase) $body"
    }
  }
  finally {
    if ($response) { $response.Dispose() }
    $Upload.Request.Dispose()
    $Upload.Content.Dispose()
    $Upload.Stream.Dispose()
    $Upload.Stopwatch.Stop()
    $fileSize = (Get-Item -LiteralPath $Upload.Path).Length
    Write-Output ("Uploaded {0} ({1:N0} bytes) in {2:N1}s" -f $Upload.Label, $fileSize, $Upload.Stopwatch.Elapsed.TotalSeconds)
  }
}

function Invoke-BinaryUploadBatch {
  param(
    [Parameter(Mandatory = $true)][object[]]$Uploads,
    # Gitea's SQLite backend permits one writer at a time; concurrent asset
    # uploads can surface SQLITE_BUSY even when the HTTP requests are valid.
    [ValidateRange(1, 4)][int]$ThrottleLimit = 1
  )
  for ($offset = 0; $offset -lt $Uploads.Count; $offset += $ThrottleLimit) {
    $pending = @()
    $end = [Math]::Min($offset + $ThrottleLimit, $Uploads.Count)
    try {
      for ($index = $offset; $index -lt $end; $index++) {
        $definition = $Uploads[$index]
        $pending += Start-BinaryUpload -Method $definition.Method -Uri $definition.Uri -Path $definition.Path -Label $definition.Label
      }
    }
    catch {
      foreach ($upload in $pending) {
        try { Complete-BinaryUpload -Upload $upload | Out-Null } catch { }
      }
      throw
    }

    $failure = $null
    foreach ($upload in $pending) {
      try {
        Complete-BinaryUpload -Upload $upload
      }
      catch {
        if ($null -eq $failure) { $failure = $_ }
      }
    }
    if ($null -ne $failure) { throw $failure }
  }
}

$versionPattern = "(^|_)$([regex]::Escape($version))(?=_|-|\.)"
$nsisInstaller = @(Get-ChildItem $artifactDirectory -File -Filter "*.exe" | Where-Object { $_.Name -match $versionPattern })
$msiInstaller = @(Get-ChildItem $artifactDirectory -File -Filter "*.msi" | Where-Object { $_.Name -match $versionPattern })
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
  notes = "Xiaoyin desktop $version"
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
    name = "Xiaoyin Desktop $version"
    body = "Official Xiaoyin desktop release with signed installers, checksums, and release audit metadata generated by Gitea Actions."
    draft = $true
    prerelease = $false
  })
}
else {
  $draftAssets = @(Invoke-JsonRequest -Method Get -Uri "$api/releases/$($release.id)/assets")
  foreach ($asset in $draftAssets) {
    Invoke-JsonRequest -Method Delete -Uri "$api/releases/assets/$($asset.id)" | Out-Null
    Write-Output "Removed incomplete draft asset: $($asset.name)"
  }
}

$versionPackageApi = "$server/api/v1/packages/$owner/generic/xiaoyin-desktop/$version"
try {
  Invoke-WebRequest -Uri $versionPackageApi -Method Delete -Headers $headers -UseBasicParsing | Out-Null
  Write-Output "Removed incomplete version package: $version"
}
catch {
  $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  if ($statusCode -ne 404) { throw }
}

$releaseAssets = @(
  $releaseFiles +
  @(
    [ordered]@{ Name = "SHA256SUMS.txt"; Path = $checksumPath },
    [ordered]@{ Name = "release-manifest.json"; Path = $manifestPath },
    [ordered]@{ Name = "latest.json"; Path = $latestPath }
  )
)
$releaseUploads = @($releaseAssets | ForEach-Object {
  $assetName = [Uri]::EscapeDataString([string]$_.Name)
  [pscustomobject]@{
    Method = "Post"
    Uri = "$api/releases/$($release.id)/assets?name=$assetName"
    Path = $_.Path
    Label = "release/$($_.Name)"
  }
})
Invoke-BinaryUploadBatch -Uploads $releaseUploads

# The updater feed points only to the NSIS installer. Keep the immutable
# package small; MSI remains available as a Release asset for manual installs.
$versionPackageFiles = @(
  @(
    [ordered]@{ Name = $nsisReleaseFile.Name; Path = $nsisReleaseFile.Path },
    [ordered]@{ Name = $nsisSignature.Name; Path = $nsisSignature.FullName }
  ) +
  @(
    [ordered]@{ Name = "latest.json"; Path = $latestPath },
    [ordered]@{ Name = "release-manifest.json"; Path = $manifestPath },
    [ordered]@{ Name = "SHA256SUMS.txt"; Path = $checksumPath }
  )
)
$versionPackageUploads = @($versionPackageFiles | ForEach-Object {
  $packageName = [Uri]::EscapeDataString([string]$_.Name)
  [pscustomobject]@{
    Method = "Put"
    Uri = "$versionPackageBase/$packageName"
    Path = $_.Path
    Label = "package/$($_.Name)"
  }
})
Invoke-BinaryUploadBatch -Uploads $versionPackageUploads

$latestPackageApi = "$server/api/v1/packages/$owner/generic/xiaoyin-desktop-updater/latest"
try {
  Invoke-WebRequest -Uri $latestPackageApi -Method Delete -Headers $headers -UseBasicParsing | Out-Null
}
catch {
  $statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  if ($statusCode -ne 404) { throw }
}
Invoke-BinaryUploadBatch -Uploads @([pscustomobject]@{
  Method = "Put"
  Uri = $updaterMetadataUrl
  Path = $latestPath
  Label = "updater/latest.json"
})

$publishedMetadata = Invoke-RestMethod -Uri $updaterMetadataUrl -Method Get -UseBasicParsing
$publishedWindows = $publishedMetadata.platforms.PSObject.Properties["windows-x86_64"].Value
if ($publishedMetadata.version -ne $version -or
    $publishedWindows.signature -ne $signature) {
  throw "Published updater metadata did not pass the anonymous read-back check."
}

$release = Invoke-JsonRequest -Method Patch -Uri "$api/releases/$($release.id)" -Body ([ordered]@{
  tag_name = $Tag
  target_commitish = $env:GITHUB_SHA
  name = "Xiaoyin Desktop $version"
  body = "Official Xiaoyin desktop release with signed installers, checksums, and release audit metadata generated by Gitea Actions."
  draft = $false
  prerelease = $false
})

$publishedRelease = Invoke-JsonRequest -Method Get -Uri "$api/releases/tags/$([Uri]::EscapeDataString($Tag))"
if ($publishedRelease.draft -or $publishedRelease.prerelease -or $publishedRelease.tag_name -ne $Tag) {
  throw "Published release metadata did not pass the read-back check."
}
$publishedAssets = @($publishedRelease.assets)
if ($publishedAssets.Count -ne $releaseAssets.Count) {
  throw "Published release contains $($publishedAssets.Count) assets; expected $($releaseAssets.Count)."
}
foreach ($expected in $releaseAssets) {
  $expectedFile = Get-Item -LiteralPath $expected.Path
  $actual = @($publishedAssets | Where-Object { $_.name -eq $expected.Name })
  if ($actual.Count -ne 1 -or [long]$actual[0].size -ne $expectedFile.Length) {
    throw "Published release asset did not pass the size read-back check: $($expected.Name)"
  }
}
$publishedManifest = $publishedAssets | Where-Object { $_.name -eq "release-manifest.json" } | Select-Object -First 1
$manifestReadBack = Join-Path $env:TEMP ("xiaoyin-release-manifest-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  Invoke-WebRequest -Uri $publishedManifest.browser_download_url -Headers $headers -OutFile $manifestReadBack -UseBasicParsing
  $expectedManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
  $actualManifestHash = (Get-FileHash -LiteralPath $manifestReadBack -Algorithm SHA256).Hash
  if ($actualManifestHash -ne $expectedManifestHash) {
    throw "Published release manifest did not pass the SHA-256 read-back check."
  }
}
finally {
  Remove-Item -LiteralPath $manifestReadBack -Force -ErrorAction SilentlyContinue
}

Write-Output "Published Gitea release: $($release.html_url)"
Write-Output "Updater metadata: $updaterMetadataUrl"
$httpClient.Dispose()
