# Windows 正式版验收

## 环境

- Windows 10 或 Windows 11 x64
- 可交互的员工桌面会话
- WebView2 Runtime
- 已安装待验收版本的小胤

## 启动

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pnpm acceptance:windows
```

仅准备验收目录和环境：

```powershell
pnpm acceptance:windows -- -PrepareOnly
```

脚本在“下载”目录创建独立验收目录并生成 `acceptance-report.json`。

## 验收项

| 项目 | 通过标准 |
|---|---|
| 增量聊天 | 回复持续更新，完成后消息和任务状态一致 |
| 本地文件 | 只能读取授权目录，越界访问被拒绝 |
| 文件预览 | 文本、代码、图片或 Office/PDF 产物可在侧边栏打开 |
| Shell 与 Jobs | 命令状态、后台任务和终端结果正常展示 |
| 浏览器 | 页面打开、交互、标签页和下载可用 |
| Office 产物 | DOCX、XLSX、PPTX 和 PDF 可以生成并打开 |
| 系统凭据 | Secret 写入 Windows Credential Manager，不写入前端存储 |
| 多 Agent | 独立子任务可以并行执行并汇总结果 |

所有项目通过后才允许发布。失败时保留验收目录和 `acceptance-report.json`。

## 安装器烟测

在可丢弃的测试环境执行：

```powershell
$env:XIAOYIN_WINDOWS_SMOKE = "1"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-installer.ps1 -InstallerPath <安装包.exe>
```
