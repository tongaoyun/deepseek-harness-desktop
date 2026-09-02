param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Signing target does not exist: $Path" }
if (-not (Test-Path -LiteralPath $env:XIAOYIN_AUTHENTICODE_PFX_PATH -PathType Leaf)) { throw "Authenticode PFX is unavailable" }
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_AUTHENTICODE_PFX_PASSWORD)) { throw "Authenticode PFX password is unavailable" }

$SignTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $SignTool) {
  $KitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $SignTool = Get-ChildItem -Path $KitsRoot -Filter signtool.exe -Recurse -File |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -ExpandProperty FullName -First 1
}
if (-not $SignTool) { throw "signtool.exe was not found" }

$TimestampUrl = if ($env:WINDOWS_AUTHENTICODE_TIMESTAMP_URL) { $env:WINDOWS_AUTHENTICODE_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
& $SignTool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /f $env:XIAOYIN_AUTHENTICODE_PFX_PATH /p $env:WINDOWS_AUTHENTICODE_PFX_PASSWORD /v $Path
if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed with exit code $LASTEXITCODE" }
& $SignTool verify /pa /v $Path
if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed with exit code $LASTEXITCODE" }
