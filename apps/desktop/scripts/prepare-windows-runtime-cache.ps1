param(
  [string] $Cache = "C:\xiaoyin-desktop-builder\runtime-downloads"
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$DownloadCache = Join-Path $RepositoryRoot "apps\desktop\.desktop-build\downloads"
$RuntimeLockPath = Join-Path $RepositoryRoot "scripts\primary-runtime\lock.json"

New-Item -ItemType Directory -Path $Cache -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $DownloadCache) -Force | Out-Null
if (Test-Path -LiteralPath $DownloadCache) {
  $Existing = Get-Item -LiteralPath $DownloadCache -Force
  if (($Existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    [IO.Directory]::Delete($DownloadCache)
  } else {
    Remove-Item -LiteralPath $DownloadCache -Recurse -Force
  }
}
New-Item -ItemType Junction -Path $DownloadCache -Target $Cache | Out-Null

function Save-LockedAsset([string] $Source, [string] $ExpectedHash) {
  $Destination = Join-Path $DownloadCache $ExpectedHash
  $LockPath = "$Destination.lock"
  $Lock = $null
  $Deadline = [DateTime]::UtcNow.AddMinutes(12)
  while ($null -eq $Lock) {
    try {
      $Lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $Deadline) { throw "Runtime asset lock timed out: $ExpectedHash" }
      Start-Sleep -Milliseconds 200
    }
  }
  $Temporary = "$Destination.$PID.$([Guid]::NewGuid().ToString('N')).download"
  try {
    if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedHash)) {
      Write-Output "Runtime cache hit: $ExpectedHash"
      return
    }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    curl.exe -fL -C - --retry 4 --retry-all-errors --connect-timeout 30 --max-time 600 -o $Temporary $Source
    if ($LASTEXITCODE -ne 0) { throw "Runtime asset download failed: $Source" }
    $ActualHash = (Get-FileHash -LiteralPath $Temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) { throw "Runtime asset checksum mismatch: $Source" }
    # Windows PowerShell 5 runs on .NET Framework, which only exposes the
    # two-argument File.Move overload. The per-hash lock and removal above
    # make this same-volume rename exclusive without an overwrite flag.
    [IO.File]::Move($Temporary, $Destination)
  } finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }
    $Lock.Dispose()
  }
}

$RuntimeLock = Get-Content -Raw $RuntimeLockPath | ConvertFrom-Json
$TargetLock = $RuntimeLock.targets.PSObject.Properties['win-x64'].Value
$NodeArchive = "node-v$($RuntimeLock.nodeVersion)-$($TargetLock.nodeArchive)"
Save-LockedAsset "https://cdn.npmmirror.com/binaries/node/v$($RuntimeLock.nodeVersion)/$NodeArchive" $TargetLock.nodeSha256
$PythonArchive = "cpython-$($RuntimeLock.pythonVersion)+$($RuntimeLock.pythonRelease)-$($TargetLock.pythonTarget)-install_only_stripped.tar.gz"
$EncodedPythonArchive = [Uri]::EscapeDataString($PythonArchive)
Save-LockedAsset "https://ghfast.top/https://github.com/astral-sh/python-build-standalone/releases/download/$($RuntimeLock.pythonRelease)/$EncodedPythonArchive" $TargetLock.pythonSha256
$Wheels = @($TargetLock.wheels) + @($RuntimeLock.wheels)
foreach ($Wheel in $Wheels) {
  $WheelUri = [Uri] $Wheel.url
  Save-LockedAsset "https://mirrors.aliyun.com/pypi$($WheelUri.AbsolutePath)" $Wheel.sha256
}
