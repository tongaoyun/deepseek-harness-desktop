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
    if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf) -or
        [System.IO.Path]::GetExtension($RequestedPath) -ne ".exe") {
      throw "请指定已安装的小胤 .exe 文件：$RequestedPath"
    }
    return (Resolve-Path -LiteralPath $RequestedPath -ErrorAction Stop).Path
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\小胤\xiaoyin-desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "小胤\xiaoyin-desktop.exe"),
    (Join-Path $env:ProgramFiles "小胤\xiaoyin-desktop.exe")
  )
  $resolved = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $resolved) {
    throw "未找到小胤，请用 -ApplicationPath 指定已安装的 xiaoyin-desktop.exe。"
  }
  return [System.IO.Path]::GetFullPath($resolved)
}

function Test-WebView2Runtime {
  $paths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  )
  foreach ($path in $paths) {
    $installedVersion = Get-ItemPropertyValue -LiteralPath $path -Name "pv" -ErrorAction SilentlyContinue
    $version = $null
    if ([version]::TryParse([string]$installedVersion, [ref]$version) -and $version -gt [version]"0.0.0.0") {
      return $true
    }
  }
  return $false
}

function Test-PackagedHarness {
  param([string]$Executable)
  $installRoot = Split-Path -Parent $Executable
  $runtimeRoot = Join-Path $installRoot "resources\harness-runtime"
  $node = Join-Path $runtimeRoot "node\node.exe"
  $entry = Join-Path $runtimeRoot "harness-host\dist\index.js"
  $config = Join-Path $runtimeRoot "harness-host\runtime\cordis.yml"
  $primaryManifest = Join-Path $runtimeRoot "primary-runtime\runtime.json"
  $officeChecker = Join-Path $runtimeRoot "office-skills\scripts\check_office.py"
  foreach ($required in @($node, $entry, $config, $primaryManifest, $officeChecker)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "安装包缺少 Harness 运行文件：$required"
    }
  }
  & $node (Join-Path $PSScriptRoot "check-harness-runtime.mjs") $node (Join-Path $runtimeRoot "harness-host") --self-test
  if ($LASTEXITCODE -ne 0) { throw "安装包 Harness 本地能力自检失败，退出码：$LASTEXITCODE" }
}

$app = Resolve-XiaoyinApplication -RequestedPath $ApplicationPath
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fixtureRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\小胤验收-$stamp"

if (-not (Test-WebView2Runtime)) { throw "未检测到 Microsoft Edge WebView2 Runtime。" }
Test-PackagedHarness -Executable $app

New-Item -ItemType Directory -Path (Join-Path $fixtureRoot "子目录") | Out-Null
Set-Content -LiteralPath (Join-Path $fixtureRoot "说明.txt") -Encoding utf8 -Value "小胤 Windows 验收文件。原值：未处理。"
Set-Content -LiteralPath (Join-Path $fixtureRoot "库存.csv") -Encoding utf8 -Value @(
  "sku,quantity,price",
  "A-100,12,19.90",
  "B-200,3,88.00"
)
Set-Content -LiteralPath (Join-Path $fixtureRoot "子目录\备注.md") -Encoding utf8 -Value "# 验收备注`n`n请让小胤读取、修改并在侧边栏预览。"

$cases = @(
  [ordered]@{ id = "extension-lifecycle"; name = "官方扩展"; prompt = "在界面安装单元测试 Skill 和全栈开发专家 1.0.1，重复安装、切换启停，并选择专家套件。"; expected = "目录版本正确；重复安装不重复展示；独立 Skill 与套件中的同名技能只加载一次；停用后不能调用。" },
  [ordered]@{ id = "streaming"; name = "增量聊天"; prompt = "用不少于 300 字解释冒泡排序，并先给结论。"; expected = "2 秒内出现首段文字，正文连续增长至少 3 次，不是结束后整段闪现。" },
  [ordered]@{ id = "local-files"; name = "本地文件"; prompt = "授权验收目录后，读取库存.csv，并把说明.txt中的‘未处理’改成‘已处理’；尝试读取未授权目录，核对拒绝结果。"; expected = "授权目录内正确读取并修改；越界被拒绝；聊天中出现文件变更卡片。" },
  [ordered]@{ id = "code-task"; name = "代码任务与交付"; prompt = "选择单元测试 Skill，在验收目录创建读取库存.csv并计算库存总金额的 Node.js 脚本及测试，运行测试，展示代码差异并交付文件。"; expected = "实际调用 Skill；生成代码和测试；测试通过；总金额为 502.8；差异与磁盘文件一致，产物可打开。" },
  [ordered]@{ id = "stop-resume"; name = "停止与重启恢复"; prompt = "发送：在验收目录等待 60 秒后创建恢复验证.txt，内容为 XY-RESUME。等待期间在界面停止任务，再重启小胤并继续该任务。"; expected = "停止后进程退出且文件未创建；重启后原任务仍显示已停止；主动继续后只执行一次，文件内容正确，历史记录保留。" },
  [ordered]@{ id = "network-retry"; name = "断线与失败重试"; prompt = "在空闲测试桌面暂时断开模型连接，发送普通问答；出现失败后恢复连接，在原对话重试。"; expected = "失败原因可见，不显示已完成或无限加载；恢复后可以重试，原对话历史保留，不重复用户消息。" },
  [ordered]@{ id = "preview"; name = "内置预览"; prompt = "打开刚才修改的说明.txt。"; expected = "文件在小胤右侧预览，不调用记事本或其他外部软件。" },
  [ordered]@{ id = "shell-job"; name = "Shell 与后台任务"; prompt = "在验收目录运行一个命令统计所有文件大小，并汇总结果；不要修改文件。"; expected = "展示精简命令进度和最终结果，无黑色控制台窗口。" },
  [ordered]@{ id = "browser"; name = "浏览器"; prompt = "打开 https://example.com，告诉我页面标题。"; expected = "小胤浏览器出现真实页面而非空白页，并返回 Example Domain。" },
  [ordered]@{ id = "office"; name = "Office 产物"; prompt = "根据库存.csv生成库存分析.xlsx和库存简报.docx，保存到验收目录。"; expected = "两个文件均由官方 Office Skill 生成、重新读取检查并通过 present 交付；点击后可由本机应用打开。" },
  [ordered]@{ id = "credential-vault"; name = "连接器凭据库"; prompt = "创建一个个人测试连接器，密钥填 XY-VAULT-$stamp，保存并重启小胤后重新打开。"; expected = "重启后配置仍在；连接器草稿不展示明文；删除连接器后凭据同时移除。" },
  [ordered]@{ id = "multi-agent"; name = "多 Agent"; prompt = "并行检查验收目录的文本内容、CSV 数据质量和文件结构，最后统一汇总。"; expected = "复杂任务自动出现多个简洁协作活动；只有主 Agent 给最终答复。" },
  [ordered]@{ id = "extension-uninstall"; name = "扩展卸载"; prompt = "卸载本轮安装的单元测试 Skill 和全栈开发专家，重启小胤并核对列表，再尝试调用。"; expected = "扩展不再出现在已安装列表，重启后不恢复，运行时无法加载已卸载的技能。" }
)

$session = [ordered]@{
  createdAt = (Get-Date).ToString("o")
  application = $app
  fixtureRoot = $fixtureRoot
  os = [Environment]::OSVersion.VersionString
  applicationVersion = (Get-Item -LiteralPath $app).VersionInfo.ProductVersion
  harnessSelfTest = "passed"
  cases = $cases
}
$sessionPath = Join-Path $fixtureRoot "acceptance-session.json"
$session | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sessionPath -Encoding utf8

$processName = [System.IO.Path]::GetFileNameWithoutExtension($app)
$process = Get-Process -Name $processName -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $app } | Select-Object -First 1
if (-not $process) { Start-Process -FilePath $app | Out-Null }

Write-Host "`n小胤 Windows 验收已准备：$fixtureRoot" -ForegroundColor Green
Write-Host "自动预检通过：WebView2、安装包 Harness、本地能力。"

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
if ($report.failed -gt 0 -or $report.skipped -gt 0) { exit 1 }
