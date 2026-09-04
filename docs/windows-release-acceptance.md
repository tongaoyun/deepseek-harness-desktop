# Windows 正式版验收

正式发布前在一台真实的 Windows 10/11 员工电脑上执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
pnpm acceptance:windows
```

脚本会自动检查 WebView2、安装包内 Harness 与本地能力，随后在“下载”目录创建一个独立验收目录、启动小胤，并逐项给出可直接发送的任务和通过标准。结果保存在该目录的 `acceptance-report.json`。

必须全部通过的场景只有八项：增量聊天、本地文件、内置侧边预览、Shell/后台任务、真实浏览器、Office 产物、系统凭据库和多 Agent。失败项不得靠重装或清缓存掩盖，应保留验收目录和报告用于复现。

仅准备环境、不进入人工判定：

```powershell
pnpm acceptance:windows -- -PrepareOnly
```

安装器本身仍使用自动烟测：

```powershell
$env:XIAOYIN_WINDOWS_SMOKE = "1"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-installer.ps1 -InstallerPath <安装包.exe>
```
