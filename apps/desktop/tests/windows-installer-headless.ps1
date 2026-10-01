<# Silent NSIS installation checks for service-hosted Windows runners without a window station. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey,
    [Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$installPath = Join-Path $OutputDirectory 'Headless App'
$appPath = Join-Path $installPath ($ProductName + '.exe')
$uninstaller = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey

function Invoke-Process([string]$FilePath, [string]$Arguments, [int]$TimeoutMs = 60000) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try {
        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Process timed out: $FilePath $Arguments"
        }
        if ($process.ExitCode -ne 0) { throw "Process failed with exit code $($process.ExitCode): $FilePath $Arguments" }
    } finally { $process.Dispose() }
}

try {
    if (Test-Path -LiteralPath $installPath) { Remove-Item -LiteralPath $installPath -Recurse -Force }
    Invoke-Process $Installer ('/S /D=' + $installPath)
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw 'Silent install did not produce the application executable' }
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Silent install did not produce the uninstaller' }

    $entry = Get-ItemProperty -LiteralPath $registryPath
    if ($entry.InstallLocation.TrimEnd('\') -ne $installPath.TrimEnd('\')) { throw 'Silent install registered an unexpected directory' }

    Invoke-Process $appPath '/S'
    $marker = Join-Path $installPath 'launched.txt'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Installed application did not execute' }

    Invoke-Process $uninstaller '/S'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (Test-Path -LiteralPath $installPath) {
        if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Silent uninstaller did not remove the installation' }
        Start-Sleep -Milliseconds 100
    }
    if (Test-Path -LiteralPath $registryPath) { throw 'Silent uninstaller left the registry entry behind' }
    Write-Output 'PASS: silent install, launch, registry, and uninstall'
} finally {
    if (Test-Path -LiteralPath $installPath) { Remove-Item -LiteralPath $installPath -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction SilentlyContinue }
}
