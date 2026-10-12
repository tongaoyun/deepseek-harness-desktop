# DeepSeek Harness 产品层

[English](deepseek-harness-product.md) | 中文

企业目录扩展官方 Harness 的 Session、执行循环、审批和会话界面。产品包负责认证、下载、能力选择、连接器策略和限定范围的知识检索。[项目总览](../../apps/product-desktop/docs/README.zh.md)索引员工流程和仓库职责。

## 包

| 包 | 职责 |
|---|---|
| `@deepseek-harness/product` | 协议、认证、目录和服务端请求；不依赖 Harness 或 Electron |
| `@deepseek-harness/product-runtime` | 内容校验、组合、快照、连接器策略和知识工具的 Cordis Loader 插件 |
| `@deepseek-harness/product-desktop` | 钉钉登录、加密凭据、产品分发、sidecar 生命周期和打包资源 |
| `@deepseek-harness/product-ui` | 通过官方 Sidebar/Main 插槽提供四类目录；统一适配 Session、Workspace、Preset 和草稿 |

## 任务能力

专家套件从按内容哈希存储的文件生成 Provider 插件配置，准备过程不创建独立技能或套件 Preset。仅注册并保存完整任务组合。所选模式提供基础工具，依赖检查读取最终任务的工具目录。运行时使用 profile 配置的基础模式，不依赖 `standard` 定义。

套件设备安装使用 `expertKits.install`、`expertKits.installed.read` 和 `expertKits.uninstall`。`ProductInstalledExpertKits.installed` 返回按员工隔离的内容标识。单独安装不创建 Preset 或任务。卸载只移除设备记录，保留服务端资源、不可变内容和已有任务组合。[运行时协议](../../packages/deepseek-harness-product/runtime/README.zh.md)定义持久化和生命周期行为。

`tasks.capabilities.read` 返回当前任务选择。`tasks.capabilities.prepare` 接收专家套件、连接器 ID 和知识库 ID，返回执行位置、不可变 Preset ID、实际能力快照和依赖检查。套件提供初始组合，附加能力保留已有选择，必需依赖不能取消。连接器授权与任务启用是独立操作。

快捷任务准备提交 `expertKitTaskId`，由已安装制品提供提示词和内置 `skillIds`，快照通过 `expertKitTask` 固定该选择。官方执行前消息流程在模型执行前记录套件说明和绑定技能指令；其他技能保留原生语义发现。缺失绑定时明确失败。[README 插件约定](../../packages/deepseek-harness-product/expert-kit-readme/README.zh.md)定义加载、去重和权限检查。

两个任务接口通过 `requiredConnectorIds` 返回固定套件的必需连接器。技能和专家套件提供连接器依赖，产品 UI 不提供独立的连接器任务选择。连接器目录通过“全部 / 已连接”视图管理授权，两个视图均保留搜索和分类分组。参见 [UI 约定](../../packages/extensions/ui-deepseek-harness-product/README.zh.md)。

`skills.install` 校验内容并记录按员工隔离的安装，不修改任务或 Preset。技能没有启用、停用状态。`skills.installed.read` 返回安装标识和任务可见子集。`skills.uninstall` 移除设备安装记录，未开始任务不再发现该技能，已开始任务的固定内容和服务端资源保留。每个 Agent 的官方技能 Provider 发现依赖满足的已安装技能，通过官方 MCP 客户端挂载其声明的已授权连接器。首个模型步骤边界固定内容和连接器定义，日志目录消息记录这些信息且不包含凭据。加载说明使用官方技能事件。重启恢复固定内容并使用当前代理凭据；读取、加载和连接器执行时重新校验权限。参见[运行时协议](../../packages/deepseek-harness-product/runtime/README.zh.md)。

`basePresetId` 独立于产品能力选择执行模式。准备过程在替换基础插件集合时保留固定的产品插件，并检查必需工具。运行时处理通用的 `agent-preset/resolve-selection` waterfall，让官方选择入口保留任务能力。官方 Preset UI 显示组合快照的基础模式，任务开始后显示只读标签。`expertKitId: null` 清除套件组合，选择或取消套件保留已选知识库 ID。独立的套件选择器使用公开会话插槽，不覆盖官方模式控件。知识库使用独立的多选暂存入口，目录详情不修改任务选择。专家套件 README 预览可打开完整 Markdown 阅读弹窗，命令表格不声明可执行命令。

空任务直接选择派生 Preset。专家套件选择器在任务开始前展示，已开始任务通过只读页头标签展示固定套件，更换套件需新建对话。知识库调整、显式恢复、快捷任务准备或并发开始可能需要在相同 Workspace 创建新的官方 Session，并携带最新输入草稿。官方 Preset 选择检查处理并发开始。准备失败保留当前任务和草稿。已安装技能使用官方 `skill` 工具和纯文本 `/<skillName>` 调用，安装保留当前任务和草稿。

配置操作进入队列前捕获显式 Session ID，完成时只更新目标 Session，用户已导航到其他页面时保留当前视图。恢复通过一次准备请求退出套件、移除失权知识库 ID 并保留可用 ID；网络失败不能证明权限撤销。坏快照返回不可用诊断并要求显式恢复，对应历史仍可查看。

快照固定内容标识、插件配置、连接器工具协议和能力选择。上游凭据留在主进程，重启时重新连接其私有 MCP 代理。作用域系统提示记录能力选择及内容标识。官方 `agent-preset/selected` 事件记录按哈希寻址的快照 ID；正常技能和工具事件保留模型可见内容、检索查询及结果。目录刷新只影响后续选择。任务快照及其内容保留，暂不自动清理任务快照。

## 权限与检索

已声明的 READ 连接器工具继续通过 Harness 策略，WRITE 工具请求官方审批。未声明连接器工具被拒绝。服务端负责实时权限校验和撤销。员工令牌留在主进程，上游连接器 OAuth 凭据留在服务端。

知识库选择属于任务快照。搜索只接受查询和结果数量，引用片段阅读接受来源 ID。所选组合注册 `knowledge_search` 和 `knowledge_read`；空选择不注册检索工具，也不会扩大为全部可见知识库。解析后的知识库 ID 定义精确的搜索与阅读范围。服务端权限失败作为工具失败处理，超出所选 ID 的结果被拒绝。

知识库归属使用 `PERSONAL`、`DEPARTMENT`、`COMPANY`。每次目录查询和检索，服务端通过 `org-directory` 优先解析已认证的钉钉 unionId；OAuth 缺少 unionId 时按 userid 解析，随后校验员工映射、userid、员工编号、在职状态及快照有效期。租户没有该员工的 unionId 时，经过校验的 userid 作为稳定归属键，绝不使用 openId。再授予个人、全部直属部门和配置公司的范围。上级、下级和其他分支不扩大权限。快照最大有效期默认两小时。组织服务故障拒绝访问并返回可重试诊断，不使用固定团队或任务中的旧授权代替目录。

管理员将已有知识库绑定到目录员工或部门 ID，或配置公司。未绑定库不可检索。WeKnora 保留文档和索引，组织同步不创建库。执行前和加载说明时按资源 ID 重新检查套件权限，版本保持固定。产品失败包含错误码、相关资源、可重试性，以及准备失败时的依赖结果。

产品元数据负责文件夹、归属及读取和管理权限。可读取不代表可写入：个人所有者、指定知识库管理者和配置的管理员 ID 可管理内容。员工显式创建个人库，共享库创建要求管理员权限。管理者可新建多层文件夹、重命名、删除空文件夹并上传到所选目录。创建携带可为 null 的 `parentId`，响应包含上级标识；上级必须属于同一知识库，同级名称唯一，存在子文件夹或资料时拒绝删除。上级重命名不移动引擎内容。Markdown 和链接仍在根目录创建，之后可移动。WeKnora 负责解析、索引、文档内容和原生文件夹路径。产品接口提供筛选后的文档分页、解析正文阅读、链接导入、Markdown 创建或修改、文件上传及异步删除。文件夹 ID 稳定且独立于展示名称，文件夹不影响授权。Markdown 时间检查将产品内编辑串行化，但无法对直接在 WeKnora 中修改提供原子冲突保护。实时协作编辑不属于此模块。

任务结果保存需显式要求，独立于检索范围。可写入目标元数据与 Markdown 保存通过产品工具使用官方 Session 日志和审批，详见[运行时约定](../../packages/deepseek-harness-product/runtime/README.zh.md)。保存不会自动将目标加入当前任务，也不表示索引已完成。

原文件查看独立于检索及索引就绪状态。服务端校验原文件元数据和字节的访问权限，产品 UI 通过公开的官方文档预览 Factory 展示内容，不创建 Session。主进程流式写入私有暂存文件，向渲染进程发送有界二进制块，官方 Host Office 转换使用有界 JSON 块。传输在完成、取消或释放时关闭。已认证的服务端限制和桌面策略共同限定预览、上传及下载，官方格式保护继续生效。原文件下载和桌面系统打开留在主进程，不返回本地路径。Office 转换重新检查权限与版本；[产品桥约定](../../packages/deepseek-harness-product/product/README.zh.md)定义限制和无凭据传输。没有保存原文件的网页导入不提供文件预览，其引用片段仍需通过检索权限检查。

原件读取必须提供稳定的 `contentVersion`，服务端流传输、桌面分块校验及 Office 缓存统一使用该版本。索引处理时间不替代内容版本，原件标识缺失时拒绝读取。

## 桌面与上游集成

官方壳提供可信启动准备、环境与 profile overlay、命名空间 IPC、事件和清理。preload 传输结构化响应：`{ ok: true, result }` 或 `{ ok: false, failure }`。产品客户端在跨过隔离世界的桥后解析失败，保留错误码、相关资源和可重试性。产品自行校验方法白名单。Electron 保留窗口、来源和主 frame 检查。运行时注册和进程监听随 Cordis 插件释放。

请求取消贯穿 Renderer、主进程、Host 和远端请求。产品释放时取消并等待在途操作，再释放监听和原生 sidecar。准备取消不会撤销其他调用方的注册或丢弃草稿。

产品代码使用 Harness 公开出口，包括保留声明方 Loader 解析上下文的类型化 `agentPresets.derive`。`verify-upstream` 校验固定版本、登记补丁的完整差异、源码引用及依赖方向。升级依次更新基线、显式应用和解决补丁冲突、检查适配层并运行验收。官方 profile 可不加载产品 overlay 使用。

参见[任务能力升级说明](../upgrade-guide/v0.2.0-rc.2/product-task-capabilities/guide.zh.md)、[知识库管理升级说明](../upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.zh.md)和[补丁清单](../../scripts/upstream-patches/manifest.json)。
