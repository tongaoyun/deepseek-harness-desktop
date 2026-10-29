---
kind: upgrade-guide
description: "独立产品包和任务快照取代内嵌运行时与旧选择协议。"
---

# 产品任务能力

## Change

`@deepseek-harness/desktop-assembly` 加载独立产品包，官方桌面可独立运行。preload 传输 `dshDesktop.extensions`，产品包校验方法并跨过 Electron 桥还原类型化错误。

`tasks.capabilities.prepare` 取代 `expertKits.preset.prepare`，与 `tasks.capabilities.read` 一起保留已有选择。已开始任务创建携带来源 Workspace 和最新草稿的新任务。必需依赖保持锁定，未选择知识库时不提供检索工具。

旧缓存和产品全局对象不再受支持。官方 Preset API 恢复固定内容与连接器定义的快照，不包含凭据。Session 日志格式不变。

`basePresetId` 切换模式并保留能力。原生选择器展示名称和描述，通过开发者工具设置筛选编程模式，开始执行后只读。空任务选择可访问的已安装套件；已开始任务的标题栏只显示已选套件标签。`expertKitId: null` 清除套件并保留知识库。知识库通过会话选择，其详情不提供选择。README 表格不注册命令。

套件须显式安装后才能选择或使用快捷命令。准备任务保留安装记录；新选择时未安装或目录版本不匹配会返回 `KIT_NOT_INSTALLED` 或 `KIT_INSTALLED_VERSION_CHANGED`。卸载不会触发重新安装；已有任务保留固定内容并检查当前访问权限。

`skills.install` 和 `skills.installed.read` 取代 `skills.prepare` 及 `addSkillIds`，保留 Session、Preset 和草稿。技能没有启用或停用状态。可用技能进入官方目录；模型使用 `skill`，显式调用使用 `/<skillName>`。已开始任务固定版本。

任务响应暴露 `requiredConnectorIds`。连接器通过“全部 / 已连接”标签页管理授权。技能通过官方 MCP 挂载声明的已授权连接器；重启为固定定义提供当前代理凭据。

知识库范围改为 `PERSONAL`、`DEPARTMENT`、`COMPANY`，每次目录和检索重新检查钉钉组织。版本 2 快照固定 `requiredKnowledgeBaseIds`。产品快照丢失或无效时，对应任务须显式恢复，官方 Session 历史不变。套件失权阻止执行和说明加载，不替换固定内容。

## Migration

保留制品、快照和官方 Session 历史。不支持的独立技能或套件 Preset 需创建新任务。

1. 审查固定基线和[补丁清单](../../../../scripts/upstream-patches/manifest.json)。
2. 企业 profile 使用产品桌面组合启动。开发时使用 `DEEPSEEK_HARNESS_SERVER_URL`，打包应用使用产品资源。
3. 将产品全局对象替换为命名空间和任务能力方法，将 Preset 展示 YAML 替换为公开的类型化 `derive`。
4. 在新任务中重新选择旧产品能力；缓存不提供迁移。
5. 运行 `pnpm run verify:upstream` 和相关产品测试。确认未登记的官方改动会失败，以及官方 profile 可不加载产品 overlay 启动。
6. 使用 `skills.install` 和 `skills.installed.read`，删除 `skills.prepare` 与 `addSkillIds`。任务保留固定内容。
7. 选择套件或已发布更新前使用 `expertKits.install`。已开始任务的标题栏不能切换套件；从目录选择**开始使用**或快捷命令准备新任务。验证卸载保留固定任务且不重新安装。删除 `setConnectorEnabled` 和连接器任务选择。从会话提交完整知识库范围。缺少连接器定义的技能缓存需创建新任务。验证审批、撤销授权、重启和卸载。
8. 配置公司 ID 和钉钉目录有效期；迁移归属并在管理员控制中心绑定未确认的知识库。`recoverCapabilities: true` 退出套件，保留可见的知识库 ID。恢复执行前验证调岗和失权。
