# DeepSeek Harness Electron 产品层

[English](deepseek-harness-electron-architecture.md) | 中文

DeepSeek Harness桌面端以 DeepSeek Harness `dsh-v0.2.0-rc.2` 为唯一桌面、运行时和会话基线。Electron 官方窗口、`apps/desktop-host`、Harness Session、Conversation、Browser、Approval、Question、Tool、历史回放和 Office 由上游实现负责。

DeepSeek Harness产品能力位于 `packages/deepseek-harness-product/product`，通过 `window.deepseek-harness.product` 访问（`window.dshDesktop.product` 是官方桌面载体上的同一桥接引用）：

- 钉钉企业登录和员工会话；
- 专家套件、技能和连接器目录；
- WeKnora 知识库；
- 系统级定时任务；
- 成果、业务引用和产品标签。

Renderer 可以通过 preload 桥接调用白名单产品和原生方法，包括受限的文件、SQLite、凭据、附件、设备、图片预览和文件撤销操作。`sessionToken` 和员工级模型 Key 保留在 Electron 主进程中，不能通过 `window` 返回。产品层不创建 Turn、Step、Tool Card 或 Transcript，也不修改 Harness Session 状态。

Host 只能通过私有 Electron IPC 请求目录、制品、连接器和知识库操作；任务取消会传递到进行中的知识库 HTTP 请求，主进程错误只返回不含凭据文本的通用诊断。产品制品在解压前后执行哈希、条目数量、压缩大小、解压大小、路径和文件类型限制。生成的 Skill、Agent Preset、MCP 工具、提示上下文和 Session 事件全部由官方 Harness 注册表管理。

桌面端只有一个企业身份边界：先续期已保存的钉钉会话，失效时在系统浏览器完成钉钉 OAuth；再读取已认证的DeepSeek Harness Bootstrap；最后用员工级模型虚拟 Key 和 LiteLLM 地址启动官方 Harness Host。官方 DeepSeek 欢迎页不是DeepSeek Harness登录入口。Bootstrap 机密只存在于主进程，不能通过 preload API 读取；模型请求和 Session 执行仍全部由 Harness Host 负责。

原生产品方法通过 `native/deepseek-harness` 的 `deepseek-harness.native.v1` 行协议接入。当前协议提供受限的文件、附件、SQLite、凭据、钉钉状态、设备标识、图片预览和文件撤销方法；路径限制在 Electron 分配的数据目录内，文件载荷使用 hex 编码并限制为 8 MiB。该 sidecar 不承载 Harness 执行逻辑，不保留旧 Tauri `invoke` 协议。

上游同步以 tag 和固定 commit 为单位。`pnpm run verify:upstream` 要求配置的 Git 远程仓库和本地 tag 均解析到该 commit。先验证官方测试和 Electron 构建，再验证产品包、sidecar 和服务端契约。
