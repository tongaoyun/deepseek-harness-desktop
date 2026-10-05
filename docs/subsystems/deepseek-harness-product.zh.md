# DeepSeek Harness产品层

[English](deepseek-harness-product.md) | 中文

DeepSeek Harness产品层围绕官方 DeepSeek Harness 桌面端提供企业能力。产品层只负责产品数据和外部集成；会话、回合、工具、审批、会话界面、Browser、Office、权限以及会话持久化仍由 Harness 负责。

## 产品能力

- 钉钉 OAuth 会话和员工初始化信息。
- 专家套件、技能、连接器和知识库目录。
- 系统定时任务关联。
- 产品引用、交付成果和 Electron 桥接。

产品桥向 Renderer 暴露 `invoke`、`subscribe` 和 `getSession`。白名单内的文件、凭据、SQLite、附件、设备身份、图片预览和文件撤销操作通过 `invoke` 转发到 `deepseek-harness.native.v1` sidecar 协议。

Electron 主进程在 Host 启动前续期钉钉身份，并自行读取已认证的运行时 Bootstrap。员工级模型虚拟 Key 和推理地址只传给官方 Host 子进程；`bootstrap.get` 不是 Renderer 桥接方法。

Desktop Host 通过私有的关联 IPC 客户端读取产品目录。独立技能产物在流式下载时接受压缩大小限制，经过 SHA-256 校验和安全解压后进入产品管理的 Harness 目录，并通过 `dsh-skill-filesystem` 注册，因此官方 `/` 技能选择器和 `skill` 工具是唯一调用入口。本地技能使用 Harness 默认根目录，包括 `$DSH_HOME/skills` 和 `~/.agents/skills`；产品不会额外接入 `~/.codex/skills`。“使用技能”会创建普通官方会话，并预填 `/<skillId>`，但不自动发送。该操作不会复用专家套件会话，也不会带入其他会话的草稿。

每个专家套件制品保存在按内容寻址的 `<kitId>/<sha256>` 目录中。员工选择**开始使用**后，Host 注册一个不可变 Agent Preset，在 `standard` 基础上加入该套件的 Skill 目录、仅供模型调用的 README 入口、`dsh-mcp-client` 连接器和知识库引用；客户端随后创建官方 Session、绑定该 Preset 并打开 Session。常用任务使用相同流程，只把业务提示预填到输入框而不自动发送，也不绑定 Slash 前缀或 Skill ID。不含秘密的描述文件记录单个套件代和连接器元数据，Host 重启后只恢复被 Session 投影引用的 Preset。只有全部 Session 都成功检查后，Host 才会删除未被这些引用与当前目录覆盖的描述文件和产物代；检查不完整或清理失败时保留数据，且不会阻止 Host 启动。加载目录时会跳过无效或不可用套件，准备不存在的套件会直接失败，不会选择不完整 Preset。独立技能单独注册并继续使用官方 `/<skillId>` 调用方式。

全局 `knowledge_search` 工具按当前会话能力快照的知识库引用限制搜索范围，工具调用和结果写入正常的 Harness 会话日志。

## 边界

产品包只能使用公开的 Harness 包 API 和稳定扩展点，不得导入私有运行时模块，不得替换 Session Controller，也不得维护第二套会话 reducer。产品能力通过官方 Sidebar/Main Slot 扩展点展示，设置页只保留通用设置。
