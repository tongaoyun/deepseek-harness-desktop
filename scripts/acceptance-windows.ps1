[CmdletBinding()]
param(
  [string]$ApplicationPath,
  [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "此验收脚本只能在 Windows 10/11 员工桌面运行。"
}

function Resolve-XiaoyinApplication {
  param([string]$RequestedPath)
  if ($RequestedPath) {
    return (Resolve-Path -LiteralPath $RequestedPath -ErrorAction Stop).Path
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\小胤\小胤.exe"),
    (Join-Path $env:LOCALAPPDATA "小胤\小胤.exe"),
    (Join-Path $env:ProgramFiles "小胤\小胤.exe")
  )
  $resolved = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $resolved) {
    throw "未找到小胤，请用 -ApplicationPath 指定已安装的小胤.exe。"
  }
  return [System.IO.Path]::GetFullPath($resolved)
}

function Test-WebView2Runtime {
  $paths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F1E7E5F5-3E5B-4D54-BD77-4E88E86C1E25}",
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F1E7E5F5-3E5B-4D54-BD77-4E88E86C1E25}"
  )
  return $null -ne ($paths | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

function Test-PackagedHarness {
  param([string]$Executable)
  $installRoot = Split-Path -Parent $Executable
  $runtimeRoot = Join-Path $installRoot "resources\harness-runtime"
  $node = Join-Path $runtimeRoot "node\node.exe"
  $entry = Join-Path $runtimeRoot "harness-host\dist\index.js"
  $config = Join-Path $runtimeRoot "harness-host\runtime\cordis.yml"
  foreach ($required in @($node, $entry, $config)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "安装包缺少 Harness 运行文件：$required"
    }
  }
  $oldConfig = $env:DSH_CORDIS_CONFIG
  $oldShell = $env:XIAOYIN_ALLOW_SHELL
  $oldApproval = $env:XIAOYIN_APPROVE_SHELL
  $env:DSH_CORDIS_CONFIG = $config
  $env:XIAOYIN_ALLOW_SHELL = "true"
  $env:XIAOYIN_APPROVE_SHELL = "false"
  try {
    $output = @(
      '{"jsonrpc":"2.0","id":1,"method":"host.initialize"}',
      '{"jsonrpc":"2.0","id":2,"method":"host.self-test"}',
      '{"jsonrpc":"2.0","id":3,"method":"host.shutdown"}'
    ) | & $node $entry
    if ($LASTEXITCODE -ne 0) { throw "Harness 自检进程退出码：$LASTEXITCODE" }
  }
  finally {
    $env:DSH_CORDIS_CONFIG = $oldConfig
    $env:XIAOYIN_ALLOW_SHELL = $oldShell
    $env:XIAOYIN_APPROVE_SHELL = $oldApproval
  }
  $selfTest = @($output) | ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.id -eq 2 } | Select-Object -First 1
  if (-not $selfTest -or $selfTest.result.status -ne "passed") {
    throw "安装包 Harness 本地能力自检未通过。"
  }
  return @($selfTest.result.checks | Where-Object { $_.passed } | ForEach-Object { $_.key })
}

$app = Resolve-XiaoyinApplication -RequestedPath $ApplicationPath
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fixtureRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\小胤验收-$stamp"

if (-not (Test-WebView2Runtime)) { throw "未检测到 Microsoft Edge WebView2 Runtime。" }
$capabilities = Test-PackagedHarness -Executable $app

New-Item -ItemType Directory -Path (Join-Path $fixtureRoot "子目录") | Out-Null
Set-Content -LiteralPath (Join-Path $fixtureRoot "说明.txt") -Encoding utf8 -Value "小胤 Windows 验收文件。原值：未处理。"
Set-Content -LiteralPath (Join-Path $fixtureRoot "库存.csv") -Encoding utf8 -Value @(
  "sku,quantity,price",
  "A-100,12,19.90",
  "B-200,3,88.00"
)
Set-Content -LiteralPath (Join-Path $fixtureRoot "子目录\备注.md") -Encoding utf8 -Value "# 验收备注`n`n请让小胤读取、修改并在侧边栏预览。"

$cases = @(
  [ordered]@{ id = "streaming"; name = "增量聊天"; prompt = "用不少于 300 字解释冒泡排序，并先给结论。"; expected = "2 秒内出现首段文字，正文连续增长至少 3 次，不是结束后整段闪现。" },
  [ordered]@{ id = "local-files"; name = "本地文件"; prompt = "列出下载目录里的‘小胤验收-$stamp’，读取库存.csv，并把说明.txt中的‘未处理’改成‘已处理’。"; expected = "不弹目录选择器；正确读取并修改；聊天中出现文件变更卡片。" },
  [ordered]@{ id = "preview"; name = "内置预览"; prompt = "打开刚才修改的说明.txt。"; expected = "文件在小胤右侧预览，不调用记事本或其他外部软件。" },
  [ordered]@{ id = "shell-job"; name = "Shell 与后台任务"; prompt = "在验收目录运行一个命令统计所有文件大小，并汇总结果；不要修改文件。"; expected = "展示精简命令进度和最终结果，无黑色控制台窗口。" },
  [ordered]@{ id = "browser"; name = "浏览器"; prompt = "打开 https://example.com，告诉我页面标题。"; expected = "小胤浏览器出现真实页面而非空白页，并返回 Example Domain。" },
  [ordered]@{ id = "office"; name = "Office 产物"; prompt = "根据库存.csv生成库存分析.xlsx和库存简报.docx，保存到验收目录。"; expected = "两个文件均生成；点击后在小胤右侧预览；内容和表格可读。" },
  [ordered]@{ id = "credential-vault"; name = "连接器凭据库"; prompt = "创建一个个人测试连接器，密钥填 XY-VAULT-$stamp，保存并重启小胤后重新打开。"; expected = "重启后配置仍在；连接器草稿不展示明文；删除连接器后凭据同时移除。" },
  [ordered]@{ id = "multi-agent"; name = "多 Agent"; prompt = "并行检查验收目录的文本内容、CSV 数据质量和文件结构，最后统一汇总。"; expected = "复杂任务自动出现多个简洁协作活动；只有主 Agent 给最终答复。" }
)

$session = [ordered]@{
  createdAt = (Get-Date).ToString("o")
  application = $app
  fixtureRoot = $fixtureRoot
  os = [Environment]::OSVersion.VersionString
  harnessCapabilities = $capabilities
  cases = $cases
}
$sessionPath = Join-Path $fixtureRoot "acceptance-session.json"
$session | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sessionPath -Encoding utf8

$processName = [System.IO.Path]::GetFileNameWithoutExtension($app)
$process = Get-Process -Name $processName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $process) { Start-Process -FilePath $app | Out-Null }

Write-Host "`n小胤 Windows 验收已准备：$fixtureRoot" -ForegroundColor Green
Write-Host "自动预检通过：WebView2、安装包 Harness、本地能力 $($capabilities -join ', ')。"

if ($PrepareOnly) {
  Write-Output $sessionPath
  return
}

$results = @()
foreach ($case in $cases) {
  Write-Host "`n[$($case.id)] $($case.name)" -ForegroundColor Cyan
  Write-Host "发送：$($case.prompt)"
  Write-Host "通过标准：$($case.expected)"
  do { $answer = (Read-Host "结果 [P=通过 / F=失败 / S=跳过]").Trim().ToUpperInvariant() } while ($answer -notin @("P", "F", "S"))
  $note = if ($answer -eq "F") { Read-Host "失败现象" } else { "" }
  $results += [ordered]@{ id = $case.id; result = $answer; note = $note }
}

$report = [ordered]@{
  completedAt = (Get-Date).ToString("o")
  session = $session
  results = $results
  passed = @($results | Where-Object { $_.result -eq "P" }).Count
  failed = @($results | Where-Object { $_.result -eq "F" }).Count
  skipped = @($results | Where-Object { $_.result -eq "S" }).Count
}
$reportPath = Join-Path $fixtureRoot "acceptance-report.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host "`n验收报告：$reportPath"
if ($report.failed -gt 0) { exit 1 }
