param()

$ErrorActionPreference = "Stop"
$EncodedCertificate = $env:WINDOWS_AUTHENTICODE_PFX_BASE64
if ([string]::IsNullOrWhiteSpace($EncodedCertificate)) {
  throw "WINDOWS_AUTHENTICODE_PFX_BASE64 is required"
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_AUTHENTICODE_PFX_PASSWORD)) {
  throw "WINDOWS_AUTHENTICODE_PFX_PASSWORD is required"
}

$Root = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$CertificatePath = Join-Path $Root "xiaoyin-authenticode-$PID.pfx"
[IO.File]::WriteAllBytes($CertificatePath, [Convert]::FromBase64String($EncodedCertificate))
$env:XIAOYIN_AUTHENTICODE_PFX_PATH = $CertificatePath
$SignScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "sign-windows-artifact.ps1")).Path
$env:XIAOYIN_SIGN_SCRIPT_PATH = $SignScriptPath

if ($env:GITHUB_ENV) {
  "XIAOYIN_AUTHENTICODE_PFX_PATH=$CertificatePath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "XIAOYIN_SIGN_SCRIPT_PATH=$SignScriptPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
Write-Output "Authenticode certificate prepared in the runner temporary directory."
