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

Desktop Host 通过私有的关联 IPC 客户端读取产品目录。独立技能产物在流式下载时接受压缩大小限制，经过 SHA-256 校验和安全解压后进入产品管理的 Harness 目录，并通过 `dsh-skill-filesystem` 注册，因此官方 `/` 技能选择器和 `skill` 工具是唯一调用入口。本地技能使用 Harness 默认根目录，包括 `$DSH_HOME/skills` 和 `~/.agents/skills`；产品不会额外接入 `~/.codex/skills`。“使用技能”会复用当前官方会话；没有打开的会话时会创建普通会话。随后，界面会预填 `/<skillId>`，且不会覆盖现有草稿。

专家套件启用状态按员工保存在原生产品数据库中。Host 将已启用套件合成为确定性的能力快照，在 `standard` 基础上加入去重后的技能目录、仅供模型调用的专家套件 README 入口、`dsh-mcp-client` 连接器和知识库引用，并将其设为后续会话的默认能力。专家套件制品保存在按内容寻址的 `<kitId>/<sha256>` 目录中。不含秘密的快照描述文件会记录套件代；Host 重启后只恢复被 Session 投影引用或当前启用组合需要的快照。只有全部 Session 都成功检查后，Host 才会删除未被这些引用与当前目录覆盖的描述文件和产物代；检查不完整或清理失败时保留数据，且不会阻止 Host 启动。初始技能目录只包含各套件的名称和摘要；模型选择套件时，官方 `skill` 工具才会读取制品中的原始 README。后续开关会创建或选择另一个不可变快照，已有会话仍保留原快照。已启用套件的快捷命令会创建普通会话，并预填声明的 `/<skillId>` 和说明。加载目录时会跳过单个无效或不可用套件；已启用套件不可用时，Host 会拒绝选择不完整快照。

全局 `knowledge_search` 工具按当前会话能力快照的知识库引用限制搜索范围，工具调用和结果写入正常的 Harness 会话日志。

## 边界

产品包只能使用公开的 Harness 包 API 和稳定扩展点，不得导入私有运行时模块，不得替换 Session Controller，也不得维护第二套会话 reducer。产品能力通过官方 Sidebar/Main Slot 扩展点展示，设置页只保留通用设置。
