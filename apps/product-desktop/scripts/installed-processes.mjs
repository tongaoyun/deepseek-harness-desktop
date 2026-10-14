/** Stop orphaned Windows processes belonging to one disposable installation. */
import { execFileSync } from 'node:child_process'

/** @param {string} directory Private installation directory. @returns {void} Returns after all matching executable processes stop; rejects inspection or termination failures. */
export function stopInstalledProcesses(directory) {
  if (process.platform !== 'win32') throw new Error('Installed process recovery requires Windows')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AcceptancePath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetLongPathName(string source, StringBuilder destination, uint length);
}
'@
function Expand-AcceptancePath([string]$path) {
  $expanded = New-Object System.Text.StringBuilder 32768
  if ([AcceptancePath]::GetLongPathName($path, $expanded, $expanded.Capacity) -eq 0) { return $null }
  return $expanded.ToString()
}
$installation = Expand-AcceptancePath $env:HARNESS_ACCEPTANCE_INSTALLATION
if (-not $installation) { throw 'Cannot resolve private installation directory' }
$prefix = $installation.TrimEnd('\\') + '\\'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $owned = @(Get-CimInstance Win32_Process | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    $image = Expand-AcceptancePath $_.ExecutablePath
    return $image -and $image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($owned.Count -eq 0) { break }
  foreach ($process in $owned) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ([DateTime]::UtcNow -ge $deadline) { throw 'Private installation processes did not stop' }
  Start-Sleep -Milliseconds 100
} while ($true)
`], { stdio: 'inherit', timeout: 20_000, windowsHide: true,
    env: { ...process.env, HARNESS_ACCEPTANCE_INSTALLATION: directory } })
}
