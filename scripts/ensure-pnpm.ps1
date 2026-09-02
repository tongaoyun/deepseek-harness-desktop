[CmdletBinding()]
param(
  [string]$Version = "10.33.0",
  [string]$Registry = "http://192.168.2.9:4873/"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCommand) {
  $installedVersion = (& $pnpmCommand.Source --version).Trim()
  if ($installedVersion -eq $Version) {
    Write-Output "Using pnpm $installedVersion"
    return
  }
}

npm install -g "pnpm@$Version" --prefer-offline --no-audit --fund=false "--registry=$Registry"
if ($LASTEXITCODE -ne 0) {
  throw "pnpm $Version installation failed with exit code $LASTEXITCODE"
}

Write-Output "Installed pnpm $Version"
