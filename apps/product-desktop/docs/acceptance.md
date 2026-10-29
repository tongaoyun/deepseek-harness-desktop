# 产品桌面验收

本页面向产品桌面的开发和交付维护者。按改动选择检查；精确源码的 Gitea main CI 成功后才能进入三平台打包。发布与恢复见[交付说明](delivery.md)。以下命令均在仓库根目录执行。

## 本地回归

```sh
node --test apps/product-desktop/tests/github-delivery.test.mjs apps/product-desktop/tests/desktop-release.test.mjs apps/product-desktop/tests/product-updates.test.mjs apps/product-desktop/tests/acceptance-process.test.mjs
pnpm exec vitest run scripts/upstream-boundaries.spec.ts scripts/deepseek-harness-electron-workflows.spec.ts
pnpm exec vitest run apps/product-desktop/tests/close-electron.spec.ts apps/product-desktop/tests/office-fixture.spec.ts
pnpm run verify:upstream
```

这些入口覆盖源码交付、发布恢复、更新配置、验收进程和上游补丁限制。技能与套件的内容、组合及模型输入由产品包的 Loader/profile 和无密钥 Session 回归验证；检查归属见[运行时](../../../packages/deepseek-harness-product/runtime/README.md)与 [UI](../../../packages/extensions/ui-deepseek-harness-product/README.md)。

## 安装后界面

需要目标平台的原生 runner 及完整安装包。将 `PACKAGE_VERSION` 设为包的完整版本，`PACKAGE_SIGNING` 设为 `unsigned`、`internal` 或 `signed`，选择匹配的 `--target`。例如 macOS ARM64：

```sh
pnpm --dir apps/product-desktop run test:installed --target mac-arm64 --installer /absolute/path/to/installer.dmg
```

不传 `--installer` 时使用本次打包产物。Windows 使用 `win-x64` 和 EXE；Mac Intel 使用 `mac-x64`。不要在 Windows 上与同产品的其他安装操作并行。

验收将 EXE 安装或 DMG 应用复制到私有目录，运行打包 ASAR、内置 Host、产品扩展和 sidecar，结束后卸载或删除副本。仅临时副本的服务地址指向本地 fixture，身份与模型使用无密钥模拟，不覆盖员工数据。built 界面验收覆盖目录、技能与套件安装、连接器、知识原件、任务选择及重启恢复。安装后验收聚焦包内模块、扩展导航、真实对话、设备与反馈版本，以及原生 A→B 更新中的进程退出和状态保留；不重复完整任务能力场景。

界面验收命令有十分钟总期限。超时或取消终止当前命令进程树，等待关闭后才卸载；清理失败也使验收失败。Electron 正常关闭最多等待十秒，卡住后终止所属进程树并失败。Windows 仅回收私有安装目录内的孤儿可执行进程，不按应用名处理其他安装。重启前等待官方 Agent 运行标记消失，不能只看回复或按钮。

截图和 JSON 报告在失败时也上传，缺失报告阻止发布。失败诊断包含启动、重启、进程退出和清理阶段，不包含凭据、命令参数或员工内容。macOS Office 打包卡住时的调用栈采样不改变转换期限或结果。

## 原生 A→B 更新

`internal` 验收从完整安装包制作两个隔离、递增版本。Mac 使用同一固定证书及 Squirrel.Mac；Windows 使用生产 NSIS 目录安装器。保留依赖、解包二进制、运行时清单及 ASAR 完整性，只替换测试启动、版本和服务输入，原安装包不变。

两端均通过产品内的“检查更新”验证：安装 A，点击后直接下载 B，确认实际收到安装包请求，再取消重启并继续使用 A，重新打开确认后重启安装 B。有活动任务时，显式确认按钮为“停止任务并更新”；空闲时为“安装并重启”。验收只接受这两类 shell 确认，记录实际按钮，关闭弹层始终取消。检查版本、Session 与草稿保留，以及旧 Host 和 sidecar 退出。Mac 更新测试有八分钟执行、一分钟清理及十分钟父进程期限。

结果写入 `.artifacts/native-macos-update-*.json` 或 `.artifacts/native-windows-update-*.json`。正式 `signed` 分发仍须分别完成 Windows、Mac ARM64 和 Mac Intel 的签名、公证及 A→B 升级，不能以模拟结果替代。

## 证据限制

模拟服务验证组合、界面、请求及恢复；安装器和更新器保持真实。它不证明真实钉钉权限、第二员工隔离、模型推理效果或首次下载的系统放行。

Mac 无密钥界面测试在一次性配置目录中使用 Chromium 测试钥匙串，窗口不接收系统键盘焦点。这不验证系统钥匙串保护或授权弹窗；正式启动仍使用操作系统加密存储。固定自签不解决 Gatekeeper，Windows 未签名包仍可能提示未知发布者。
