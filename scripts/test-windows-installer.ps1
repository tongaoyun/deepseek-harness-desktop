[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$InstallerPath,

  [string]$InstallRoot = (Join-Path $env:TEMP ("xiaoyin-installer-smoke-" + [guid]::NewGuid().ToString("N"))),

  [ValidateRange(3, 60)]
  [int]$StartupSeconds = 8
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This smoke test can only run on Windows."
}
if ($env:XIAOYIN_WINDOWS_SMOKE -ne "1") {
  throw "Set XIAOYIN_WINDOWS_SMOKE=1 to confirm this is a disposable Windows smoke-test environment."
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if (Test-Path -LiteralPath $resolvedRoot) {
  throw "Refusing to reuse an existing install directory: $resolvedRoot"
}

$launchedProcess = $null
$installedByThisRun = $false
$uninstallCompleted = $false

function Wait-PathState {
  param([string]$Path, [bool]$ShouldExist, [int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ((Test-Path -LiteralPath $Path) -eq $ShouldExist) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for path state ($ShouldExist): $Path"
}

function Find-Uninstaller {
  param([string]$Root)
  return Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^(uninstall|unins.*)\.exe$" } |
    Select-Object -First 1
}

try {
  $installer = Start-Process -FilePath $resolvedInstaller -ArgumentList @("/S", "/D=$resolvedRoot") -PassThru -Wait
  if ($installer.ExitCode -ne 0) { throw "Installer exited with code $($installer.ExitCode)." }
  $installedByThisRun = $true
  Wait-PathState -Path $resolvedRoot -ShouldExist $true

  $runtimeRoot = Join-Path $resolvedRoot "resources\harness-runtime"
  $runtimeNode = Join-Path $runtimeRoot "node\node.exe"
  $runtimeEntry = Join-Path $runtimeRoot "harness-host\dist\index.js"
  $runtimeConfig = Join-Path $runtimeRoot "harness-host\runtime\cordis.yml"
  foreach ($required in @($runtimeNode, $runtimeEntry, $runtimeConfig, (Join-Path $runtimeRoot "runtime-manifest.json"))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Installed Harness resource is missing: $required"
    }
  }

  $previousConfig = $env:DSH_CORDIS_CONFIG
  $env:DSH_CORDIS_CONFIG = $runtimeConfig
  try {
    $runtimeOutput = @(
      '{"jsonrpc":"2.0","id":1,"method":"host.health"}',
      '{"jsonrpc":"2.0","id":2,"method":"host.shutdown"}'
    ) | & $runtimeNode $runtimeEntry
    if ($LASTEXITCODE -ne 0) { throw "Installed Harness runtime exited with $LASTEXITCODE." }
  }
  finally {
    $env:DSH_CORDIS_CONFIG = $previousConfig
  }
  $health = @($runtimeOutput) | ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.id -eq 1 } | Select-Object -First 1
  if (-not $health -or $health.result.status -ne "ready") {
    throw "Installed Harness runtime health check failed."
  }

  $application = Get-ChildItem -LiteralPath $resolvedRoot -File -Filter "*.exe" |
    Where-Object { $_.Name -notmatch "^(uninstall|unins.*)\.exe$" } |
    Select-Object -First 1
  if (-not $application) { throw "Installed application executable was not found in $resolvedRoot." }

  $previousApiBaseUrl = $env:XIAOYIN_API_BASE_URL
  $env:XIAOYIN_API_BASE_URL = "http://127.0.0.1:9"
  try { $launchedProcess = Start-Process -FilePath $application.FullName -PassThru }
  finally { $env:XIAOYIN_API_BASE_URL = $previousApiBaseUrl }

  Start-Sleep -Seconds $StartupSeconds
  $launchedProcess.Refresh()
  if ($launchedProcess.HasExited) {
    throw "Installed application exited during startup with code $($launchedProcess.ExitCode)."
  }
  Stop-Process -Id $launchedProcess.Id -Force
  $launchedProcess.WaitForExit(10000) | Out-Null
  $launchedProcess = $null

  $uninstaller = Find-Uninstaller -Root $resolvedRoot
  if (-not $uninstaller) { throw "NSIS uninstaller was not found under $resolvedRoot." }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstall.ExitCode)." }
  Wait-PathState -Path $resolvedRoot -ShouldExist $false
  $uninstallCompleted = $true
  Write-Output "Windows installer and embedded Harness smoke tests passed."
}
finally {
  if ($launchedProcess -and -not $launchedProcess.HasExited) {
    Stop-Process -Id $launchedProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($installedByThisRun -and -not $uninstallCompleted -and (Test-Path -LiteralPath $resolvedRoot)) {
    $cleanupUninstaller = Find-Uninstaller -Root $resolvedRoot
    if ($cleanupUninstaller) {
      Start-Process -FilePath $cleanupUninstaller.FullName -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
    }
  }
}
