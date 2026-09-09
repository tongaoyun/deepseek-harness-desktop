$ErrorActionPreference = 'Stop'
$Metadata = cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps | ConvertFrom-Json
$Binary = Get-ChildItem (Join-Path $Metadata.target_directory 'debug/deps/xiaoyin_desktop_lib-*.exe') |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Binary) { throw 'Rust test executable not found' }
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$VsRoot = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$Dumpbin = Get-ChildItem "$VsRoot\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $Dumpbin) { throw 'MSVC dumpbin not found' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LoaderDiagnostics {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadLibraryEx(string name, IntPtr file, uint flags);
  [DllImport("kernel32", CharSet=CharSet.Ansi, ExactSpelling=true)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32", CharSet=CharSet.Unicode)]
  public static extern bool SetDllDirectory(string path);
  [DllImport("kernel32")]
  public static extern bool FreeLibrary(IntPtr module);
}
'@
[void][LoaderDiagnostics]::SetDllDirectory($Binary.DirectoryName)
$Module = [IntPtr]::Zero
$Library = ''
try {
  foreach ($Line in (& $Dumpbin.FullName /imports $Binary.FullName)) {
    if ($Line -match '^\s+(\S+\.dll)\s*$') {
      if ($Module -ne [IntPtr]::Zero) { [void][LoaderDiagnostics]::FreeLibrary($Module) }
      $Library = $Matches[1]
      $Module = [LoaderDiagnostics]::LoadLibraryEx($Library, [IntPtr]::Zero, 1)
      Write-Output "Import library: $Library; load=$($Module -ne [IntPtr]::Zero)"
    } elseif ($Module -ne [IntPtr]::Zero -and $Line -match '^\s+[0-9A-F]+\s+([^\s]+)\s*$') {
      $Symbol = $Matches[1]
      if ([LoaderDiagnostics]::GetProcAddress($Module, $Symbol) -eq [IntPtr]::Zero) {
        Write-Output "Missing import: $Library!$Symbol"
      }
    }
  }
} finally {
  if ($Module -ne [IntPtr]::Zero) { [void][LoaderDiagnostics]::FreeLibrary($Module) }
  [void][LoaderDiagnostics]::SetDllDirectory($null)
}
