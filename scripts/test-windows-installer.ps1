[CmdletBinding()]
param(
  [string]$InstallerPath = "",

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

function Resolve-InstallerPath {
  param([AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = [System.IO.Path]::Combine((Get-Location).Path, "xiaoyin-installer-smoke.exe")
  }
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "Installer path is empty." }
  if (-not [System.IO.File]::Exists($Path)) { throw "Installer was not found: $Path" }
  return [System.IO.Path]::GetFullPath($Path)
}

$resolvedInstaller = Resolve-InstallerPath -Path $InstallerPath
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if (Test-Path -LiteralPath $resolvedRoot) {
  throw "Refusing to reuse an existing install directory: $resolvedRoot"
}

$launchedProcess = $null
$installedByThisRun = $false
$uninstallCompleted = $false
$desktopShortcutSnapshot = @()

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

function Get-XiaoyinDesktopShortcuts {
  $desktop = [Environment]::GetFolderPath("Desktop")
  if ([string]::IsNullOrWhiteSpace($desktop) -or -not [System.IO.Directory]::Exists($desktop)) { return @() }
  $shell = New-Object -ComObject WScript.Shell
  return @(Get-ChildItem -LiteralPath $desktop -Filter "*.lnk" -File -ErrorAction SilentlyContinue | ForEach-Object {
    $shortcut = $shell.CreateShortcut($_.FullName)
    if ($shortcut.TargetPath -match "(?i)xiaoyin") {
      [ordered]@{
        path = $_.FullName
        targetPath = $shortcut.TargetPath
        arguments = $shortcut.Arguments
        workingDirectory = $shortcut.WorkingDirectory
        description = $shortcut.Description
        iconLocation = $shortcut.IconLocation
        hotkey = $shortcut.Hotkey
        windowStyle = $shortcut.WindowStyle
      }
    }
  })
}

function Restore-XiaoyinDesktopShortcuts {
  param([object[]]$Snapshot)
  if (-not $Snapshot -or $Snapshot.Count -eq 0) { return }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($item in $Snapshot) {
    $shortcut = $shell.CreateShortcut([string]$item.path)
    $shortcut.TargetPath = [string]$item.targetPath
    $shortcut.Arguments = [string]$item.arguments
    $shortcut.WorkingDirectory = [string]$item.workingDirectory
    $shortcut.Description = [string]$item.description
    $shortcut.IconLocation = [string]$item.iconLocation
    $shortcut.Hotkey = [string]$item.hotkey
    $shortcut.WindowStyle = [int]$item.windowStyle
    $shortcut.Save()
  }
}

function Get-PeSubsystem {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $reader = [System.IO.BinaryReader]::new($stream)
  try {
    $stream.Seek(0x3c, [System.IO.SeekOrigin]::Begin) | Out-Null
    $peOffset = $reader.ReadInt32()
    $stream.Seek($peOffset + 24 + 68, [System.IO.SeekOrigin]::Begin) | Out-Null
    return $reader.ReadUInt16()
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

try {
  $desktopShortcutSnapshot = Get-XiaoyinDesktopShortcuts
  $installer = Start-Process -FilePath $resolvedInstaller -ArgumentList @("/S", "/D=$resolvedRoot") -PassThru -Wait
  if ($installer.ExitCode -ne 0) { throw "Installer exited with code $($installer.ExitCode)." }
  $installedByThisRun = $true
  Wait-PathState -Path $resolvedRoot -ShouldExist $true

  $runtimeRoot = Join-Path $resolvedRoot "resources\harness-runtime"
  $runtimeNode = Join-Path $runtimeRoot "node\node.exe"
  $runtimeEntry = Join-Path $runtimeRoot "harness-host\dist\index.js"
  $runtimeConfig = Join-Path $runtimeRoot "harness-host\runtime\cordis.yml"
  $primaryManifest = Join-Path $runtimeRoot "primary-runtime\runtime.json"
  $officeChecker = Join-Path $runtimeRoot "office-skills\scripts\check_office.py"
  foreach ($required in @($runtimeNode, $runtimeEntry, $runtimeConfig, $primaryManifest, $officeChecker, (Join-Path $runtimeRoot "runtime-manifest.json"))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Installed Harness resource is missing: $required"
    }
  }

  & $runtimeNode (Join-Path $PSScriptRoot "check-harness-runtime.mjs") $runtimeNode (Join-Path $runtimeRoot "harness-host") --self-test
  if ($LASTEXITCODE -ne 0) { throw "Installed Harness runtime and capability check failed with exit code $LASTEXITCODE." }

  foreach ($acceptance in @("acceptance-skill-loading.mjs", "acceptance-session-recovery.mjs")) {
    & $runtimeNode (Join-Path $runtimeRoot "harness-host\scripts\$acceptance")
    if ($LASTEXITCODE -ne 0) { throw "Installed Harness acceptance failed: $acceptance (exit code $LASTEXITCODE)." }
  }

  $application = Get-ChildItem -LiteralPath $resolvedRoot -File -Filter "*.exe" |
    Where-Object { $_.Name -notmatch "^(uninstall|unins.*)\.exe$" } |
    Select-Object -First 1
  if (-not $application) { throw "Installed application executable was not found in $resolvedRoot." }
  if ((Get-PeSubsystem -Path $application.FullName) -ne 2) {
    throw "Installed application is not a Windows GUI executable and would open a console window."
  }

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
  Write-Output "Windows installer, embedded Harness and local capability smoke tests passed."
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
  Restore-XiaoyinDesktopShortcuts -Snapshot $desktopShortcutSnapshot
}
