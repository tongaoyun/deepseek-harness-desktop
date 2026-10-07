# DeepSeek Harness产品层

[English](deepseek-harness-product.md) | 中文

DeepSeek Harness产品层围绕官方 DeepSeek Harness 桌面端提供企业能力。产品层只负责产品数据和外部集成；会话、回合、工具、审批、会话界面、Browser、Office、权限以及会话持久化仍由 Harness 负责。

## 产品能力

- 钉钉 OAuth 会话和员工初始化信息。
- 专家套件、技能、数据连接和知识库目录。
- 系统定时任务关联。
- 产品引用、交付成果和 Electron 桥接。

产品桥向 Renderer 暴露 `invoke`、`subscribe` 和 `getSession`。白名单内的文件、凭据、SQLite、附件、设备身份、图片预览和文件撤销操作通过 `invoke` 转发到 `deepseek-harness.native.v1` sidecar 协议。

Electron 主进程在 Host 启动前续期钉钉身份，并自行读取已认证的运行时 Bootstrap。员工级模型虚拟 Key 和推理地址只传给官方 Host 子进程；`bootstrap.get` 不是 Renderer 桥接方法。

Desktop Host 通过私有的关联 IPC 客户端读取产品目录。目录管理器在登录后、窗口重新获得焦点时、每五分钟和手动请求时刷新；并发刷新合并为一次请求，失败时保留最后一份成功快照。成功的快照变更会向界面和 Host 发布真实 `catalog.changed` 事件。准备状态限定到目录条目的 `id`、`version` 和 SHA-256 标识，刷新后删除过期标识。新 Session 使用最新快照，已存在 Session 保持其记录的内容版本和 Preset。

独立技能只在员工选择使用时准备。Host 以 `id`、`version` 和 SHA-256 标识不可变内容代，限制压缩大小，校验摘要，安全解压后原子替换，再通过 `dsh-skill-filesystem` 注册。Host 同时创建不可变的 Skill Preset，固定该目录版本的数据连接、工具声明和知识库引用；授权、工具或可见知识不满足时不创建 Session。“使用技能”创建绑定该 Preset 的官方 Session，并通过官方 Input Trigger Source 插入中文 Skill 引用 Chip；提交时由 `ReferenceCodec` 精确序列化为 `/<skillId>`。官方 `skill` 工具读取已准备的 Skill。本地技能使用 Harness 默认根目录，包括 `$DSH_HOME/skills` 和 `~/.agents/skills`；产品不额外接入 `~/.codex/skills`。

专家套件也只在使用时准备到按内容寻址的 `<kitId>/<sha256>` 目录。员工选择**开始使用**后，Host 注册一个不可变 Agent Preset，在 `standard` 基础上固定该快照的 README、Skill 版本、`dsh-mcp-client` 数据连接、知识库引用和工具权限；客户端随后创建官方 Session、绑定该 Preset 并打开 Session。常用任务使用相同流程，只把业务提示预填到输入框而不自动发送。不含秘密的描述文件用于 Host 重启后恢复被 Session 投影引用的 Preset。全部 Session 成功检查后，Host 才清理未被 Session 和当前目录引用的产物代；检查不完整或清理失败时保留数据且不阻止 Host 启动。单个条目准备失败只影响该条目，可重试且不阻止 Host 启动。

`oauth` 数据连接由 Electron 主进程打开系统浏览器，服务端负责员工凭据保存、刷新、撤销和 MCP 代理。Renderer 和 Host 不获取上游 Access Token 或 Refresh Token。`none` 直连，`employee-bearer` 只在服务端代理中获取员工 Session。运行时读写级别只来自 MCP ToolSpec，未知工具作为写操作使用官方 Harness 审批。

全局 `knowledge_search` 工具按当前会话能力快照的知识库引用限制搜索范围，工具调用和结果写入正常的 Harness 会话日志。

## 边界

产品包只能使用公开的 Harness 包 API 和稳定扩展点，不得导入私有运行时模块，不得替换 Session Controller，也不得维护第二套会话 reducer。产品能力通过官方 Sidebar/Main Slot 扩展点展示，设置页只保留通用设置。
