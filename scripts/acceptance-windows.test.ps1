$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot "acceptance-windows.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Acceptance script syntax is invalid: $parseErrors" }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($function in $functions) {
  Set-Item -Path "Function:\$($function.Name)" -Value $function.Body.GetScriptBlock()
}

function Assert-Equal {
  param($Actual, $Expected)
  if ($Actual -ne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}

function Assert-Throws {
  param([scriptblock]$Action)
  $thrown = $false
  try { & $Action | Out-Null } catch { $thrown = $true }
  if (-not $thrown) { throw "Expected the operation to fail." }
}

$root = Join-Path $env:TEMP ("xiaoyin-preflight-test-" + [guid]::NewGuid().ToString("N"))
$originalLocalAppData = $env:LOCALAPPDATA
$originalProgramFiles = $env:ProgramFiles
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
try {
  $env:LOCALAPPDATA = Join-Path $root "user"
  $env:ProgramFiles = Join-Path $root "machine"
  $productName = (Get-Content (Join-Path $PSScriptRoot "../src-tauri/tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).productName
  $installDirectory = Join-Path $env:LOCALAPPDATA "Programs\$productName"
  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
  $application = Join-Path $installDirectory "xiaoyin-desktop.exe"
  New-Item -ItemType File -Path $application | Out-Null
  Assert-Equal (Resolve-XiaoyinApplication) $application
  Assert-Equal (Resolve-XiaoyinApplication -RequestedPath $application) $application
  Assert-Throws { Resolve-XiaoyinApplication -RequestedPath $installDirectory }
  Remove-Item -LiteralPath $application
  Assert-Throws { Resolve-XiaoyinApplication }
  New-Item -ItemType File -Path $application | Out-Null
  Write-Output "Application discovery and invalid-path rejection passed."

  $script:registryValues = @{}
  function Get-ItemPropertyValue {
    param($LiteralPath, $Name, $ErrorAction)
    return $script:registryValues[$LiteralPath]
  }
  $runtimeKey = "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  Assert-Equal (Test-WebView2Runtime) $false
  foreach ($registryRoot in @("HKCU:\Software", "HKLM:\SOFTWARE", "HKLM:\SOFTWARE\WOW6432Node")) {
    foreach ($invalidVersion in @("", "0.0.0.0", "invalid")) {
      $script:registryValues = @{ "$registryRoot\$runtimeKey" = $invalidVersion }
      Assert-Equal (Test-WebView2Runtime) $false
    }
    $script:registryValues = @{ "$registryRoot\$runtimeKey" = "140.0.3485.54" }
    Assert-Equal (Test-WebView2Runtime) $true
  }
  Write-Output "WebView2 installed, missing and invalid-version detection passed."

  $runtime = Join-Path $installDirectory "resources\harness-runtime"
  $hostRoot = Join-Path $runtime "harness-host"
  New-Item -ItemType Directory -Path (Join-Path $runtime "node"), (Join-Path $runtime "primary-runtime"), (Join-Path $runtime "office-skills\scripts"), (Join-Path $hostRoot "dist"), (Join-Path $hostRoot "runtime") -Force | Out-Null
  Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $runtime "node\node.exe")
  Set-Content -LiteralPath (Join-Path $hostRoot "runtime\cordis.yml") -Value "fixture: true" -Encoding ASCII
  $fixture = @'
const readline = require('node:readline');
const checks = ['local-files', 'office-runtime', 'office-skills', 'libreoffice-kit', 'native-shell', 'computer-use'];
const statuses = {'host.initialize': 'initialized', 'host.health': 'ready', 'host.self-test': 'passed', 'host.shutdown': 'closed'};
const shell = process.env.XIAOYIN_ALLOW_SHELL !== 'false';
const capabilities = {
  sessionPersistence: 'enabled', sessionQuery: 'enabled', sessionReference: 'enabled', present: 'enabled',
  workspaceChanges: 'enabled', workspaceDependencies: 'enabled', officeSkills: 'enabled', libreOfficeKit: 'enabled',
  shell: shell ? 'enabled' : 'gated', persistentTerminal: shell ? 'enabled' : 'gated',
  sessionQueryTools: process.env.XIAOYIN_ENABLE_SESSION_QUERY_TOOLS === 'false' ? 'gated' : 'enabled',
  mcpClient: 'gated',
};
let pending = false;
const input = readline.createInterface({input: process.stdin});
input.on('line', line => {
  if (pending) process.exit(9);
  pending = true;
  const request = JSON.parse(line);
  setTimeout(() => {
    pending = false;
    console.log(JSON.stringify({id: request.id, result: {status: statuses[request.method], capabilities, checks: checks.map(key => ({key, passed: true}))}}));
    if (request.method === 'host.shutdown') input.close();
  }, 50);
});
process.stdin.on('end', () => { if (pending) process.exit(8); });
'@
  $entry = Join-Path $hostRoot "dist\index.js"
  $primaryManifest = Join-Path $runtime "primary-runtime\runtime.json"
  $officeChecker = Join-Path $runtime "office-skills\scripts\check_office.py"
  Set-Content -LiteralPath $entry -Value $fixture -Encoding ASCII
  Set-Content -LiteralPath $primaryManifest -Value "{}" -Encoding ASCII
  Set-Content -LiteralPath $officeChecker -Value "# fixture" -Encoding ASCII
  Test-PackagedHarness -Executable $application
  Remove-Item -LiteralPath $officeChecker
  Assert-Throws { Test-PackagedHarness -Executable $application }
  Set-Content -LiteralPath $officeChecker -Value "# fixture" -Encoding ASCII
  Set-Content -LiteralPath $entry -Value "process.exit(7)" -Encoding ASCII
  Assert-Throws { Test-PackagedHarness -Executable $application }
  Write-Output "Packaged Harness request sequencing and failure propagation passed."
}
finally {
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:ProgramFiles = $originalProgramFiles
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "Windows desktop preflight regression passed."
exit 0
