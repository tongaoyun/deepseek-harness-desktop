# DeepSeek Harness Electron 产品层

DeepSeek Harness桌面端以 DeepSeek Harness `dsh-v0.2.2-alpha.2` 为唯一桌面、运行时和会话基线。Electron 官方窗口、`apps/desktop-host`、Harness Session、Conversation、Browser、Approval、Question、Tool、历史回放和 Office 由上游实现负责。

[产品子系统](subsystems/deepseek-harness-product.md)定义独立的协议、运行时、桌面和 UI 包。产品 UI 使用 `window.dshDesktop.extensions` 的 `product` 命名空间访问：

- 钉钉企业登录和员工会话；
- 专家套件、技能和连接器目录；
- WeKnora 知识库；
- 设备上报状态及员工主动反馈；
- 系统级定时任务；
- 成果、业务引用和产品标签。

Renderer 通过通用 preload 传输调用产品和原生方法，产品包校验方法白名单。Electron 校验所属窗口、来源和主 frame。员工令牌保留在主进程；Host 接收推理配置和私有 loopback MCP relay 凭证，Renderer 不接收员工令牌或 Bootstrap 机密。UI 通过官方 Session、Workspace、Preset 和草稿 API 选择能力；Turn、Step、Tool Card 和 Transcript 由 Harness 管理。

Host 只能通过私有 Electron IPC 请求目录、制品、连接器、知识库和桌面版本。取消传递到主进程、Host 和 HTTP 请求。公开失败保留错误码、相关资源和可重试性，不包含凭据文本；未知失败使用通用诊断。产品制品在解压前后执行哈希、条目数量、压缩大小、解压大小、路径和文件类型限制。生成的 Skill、Agent Preset、MCP 工具、提示上下文和 Session 事件全部由官方 Harness 注册表管理。

产品桌面启动时续期已保存的钉钉会话或在系统浏览器完成钉钉 OAuth，读取已认证的 Bootstrap，再向官方 Host 提供推理配置和 Loader overlay。产品桌面包负责登录、加密存储、relay 和 sidecar 清理以及打包资源。官方 profile 可不加载这些扩展启动。模型请求和 Session 执行由 Host 负责。

产品自有的 [Rust sidecar](../native/deepseek-harness/README.zh.md) 通过 `deepseek-harness.native.v1` 行协议提供健康检查和设备标识，不承载 Harness 执行逻辑。

[产品桌面包](../packages/deepseek-harness-product/desktop/README.md#device-and-feedback)负责随生命周期管理的设备上报和员工主动反馈。执行审计不上传服务端，官方 Session 历史保留在本地。

[产品交付参考](../apps/product-desktop/README.md)说明 GitHub 私有仓库同步、托管 Windows/macOS 验收构建及已验证的开发预发布。内网 Gitea 仍是开发主仓库。GitHub 只运行产品打包工作流；内网交付 runner 向公开 GitHub 下载仓库和内网 Gitea 发布完整、已验证的安装包，不向托管 runner 提供内网发布凭据。

上游同步以 tag 和固定 commit 为单位。桌面仓库保存固定的官方 tag 及其 Git 对象；CI 和发布任务从 `origin` 获取该 tag，无需拉取 GitHub 或使用独立镜像仓库。`UPSTREAM_REPOSITORY` 标识官方源，仅用于显式升级。`pnpm run verify:upstream` 在本地校验 tag 解析、登记的完整补丁和 Harness 公开出口，不要求上游 remote 或网络连接。升级时更新固定版本，运行 `pnpm run sync:upstream` 获取选定的官方 tag 并保存到 `origin`，显式应用补丁并解决冲突、验证适配层，再运行官方与产品验收。参见[破坏性变更指南](upgrade-guide/v0.2.0-rc.2/product-task-capabilities/guide.md)。
