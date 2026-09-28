# 小胤 Electron 产品层

[English](xiaoyin-electron-architecture.md) | 中文

小胤桌面端以 DeepSeek Harness `dsh-v0.1.7-rc.2` 为唯一桌面、运行时和会话基线。Electron 官方窗口、`apps/desktop-host`、Harness Session、Conversation、Browser、Approval、Question、Tool、历史回放和 Office 由上游实现负责。

小胤产品能力位于 `packages/xiaoyin-product/product`，通过 `window.xiaoyin.product` 访问（`window.dshDesktop.product` 仅作为官方桌面载体上的同一只读引用）：

- 钉钉企业登录和员工会话；
- 专家套件、技能和连接器目录；
- WeKnora 知识库；
- IM 和系统级定时任务；
- 成果、业务引用和产品标签。

Renderer 只能调用白名单产品方法。`sessionToken` 只保存在 Electron 主进程或 `xiaoyin-native` sidecar，不能通过 `window` 暴露。产品层不创建 Turn、Step、Tool Card 或 Transcript，也不修改 Harness Session 状态。

需要原生权限的能力通过 `native/xiaoyin` 的 `xiaoyin.native.v1` 行协议接入。当前协议只提供受限的文件、附件、SQLite、凭据、钉钉状态、设备标识、图片预览和文件撤销方法；路径限制在 Electron 分配的数据目录内，文件载荷使用 hex 编码并限制为 8 MiB。该 sidecar 不承载 Harness 执行逻辑，不保留旧 Tauri `invoke` 协议。

上游同步以 tag 和固定 commit 为单位。`pnpm run verify:upstream` 要求配置的 Git 远程仓库和本地 tag 均解析到该 commit。先验证官方测试和 Electron 构建，再验证产品包、sidecar 和服务端契约。
