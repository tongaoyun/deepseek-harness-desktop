$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot "test-windows-installer.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Installer smoke script syntax is invalid: $parseErrors" }
$resolver = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Resolve-InstallerPath"
}, $false)
if (-not $resolver) { throw "Installer path resolver is missing" }
Set-Item -Path Function:\Resolve-InstallerPath -Value $resolver.Body.GetScriptBlock()
$shortcutSource = Get-Content -LiteralPath $scriptPath -Raw
if ($shortcutSource -notmatch 'IsNullOrWhiteSpace\(\$desktop\).*Directory\]::Exists\(\$desktop\)') {
  throw "Desktop shortcut discovery must tolerate a missing service-account Desktop directory"
}

$testRoot = Join-Path (Get-Location).Path ("xiaoyin-installer-path-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  foreach ($fileName in @("xiaoyin-installer.exe", ([char]0x5c0f + [char]0x80e4 + "_installer.exe"))) {
    $path = Join-Path $testRoot $fileName
    New-Item -ItemType File -Path $path | Out-Null
    if ((Resolve-InstallerPath -Path $path) -ne $path) { throw "Installer path was not preserved: $fileName" }
  }
  foreach ($invalid in @("", (Join-Path $testRoot "missing.exe"), $testRoot)) {
    $rejected = $false
    try { Resolve-InstallerPath -Path $invalid | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid installer path was accepted: $invalid" }
  }
  Write-Output "Windows installer path regression passed."
}
finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
