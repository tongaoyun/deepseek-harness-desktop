# DeepSeek Harness 产品层

产品层通过公开扩展点接入企业身份、公司内容、连接器和资料库；对话、执行、审批及持久化由 Harness 提供。员工入口见[项目总览](../../apps/product-desktop/docs/README.md)。

## 原生能力复用

| 扩展 | 复用的原生能力 | 产品负责 |
| --- | --- | --- |
| 技能管理 | Skill Provider、文件解析、Remote/Typert、工作目录 | 公司目录、个人内容管理、启停及发布审核 |
| 专家套件 | Subagent、系统提示词、Settings、工具策略 | AgentSpec 包、参考资源、目录及固定版本 |
| 专家团 | Agent Team、子代理、消息与任务板 | 团队定义、成员固定版本、分工及选择入口 |
| 连接器 | MCP 客户端、工具注册与执行、审批 | 公司目录、第三方授权、本机私密配置及访问范围 |
| 资料库 | 附件 admission、上传、重试、会话记录、文件工具、预览与 Office | 企业权限、文件视图、访问与来源记录、文件目录与显式归档 |

Agent Team 默认开启，团队协作使用原生服务与工具。内容分发、员工授权和任务版本绑定由产品维护；产品不实现独立的技能执行器、子代理或团队调度器。模型名称与角标使用原生模型列表。

## 模块职责

| 模块 | 负责内容 |
| --- | --- |
| [产品协议](../../packages/deepseek-harness-product/product/README.md) | 钉钉会话、目录与服务端请求校验 |
| [桌面](../../packages/deepseek-harness-product/desktop/README.md) | 凭据隔离、原生文件、设备上报和 Host 启动准备 |
| [运行时](../../packages/deepseek-harness-product/runtime/README.md) | MCP 工具发现、审批策略、资料文件归档和内容版本绑定 |
| [产品 UI](../../packages/extensions/ui-deepseek-harness-product/README.md) | 扩展页面、文件工作区、附件选择与反馈 |
| [专家](../../packages/deepseek-harness-product/experts/README.md)与[技能](../../packages/deepseek-harness-product/skills/README.md) | 原生 Agent、Agent Team、Settings 与 Skill Provider 的产品入口 |

## 身份与权限

员工令牌留在主进程，连接器 OAuth 凭据留在服务端。连接器工具按版本和定义绑定，执行时重新检查访问资格；READ 通过策略，WRITE 请求官方审批，未声明工具拒绝。

资料库使用 `PERSONAL / TEAM`。个人仅本人访问；团队默认仅所有者可见，可显式授权员工、部门或全公司为可编辑或仅查看，多项授权取最高权限。所有者管理成员和资料库，转移所有权后保留编辑权限。服务端通过 org-directory 将已认证的 unionId 或 userid 精确映射到在职员工及公司、直属部门，不按姓名、openId 或会话中的旧部门声明授权。目录快照默认有效 26 小时，超期或组织服务故障拒绝访问。部署配置由服务端 `docs/deployment.md` 维护。

团队所有者可管理成员、转移所有权及修改资料库；可编辑成员管理文件与文件夹，仅查看成员可读取、下载和引用。文件夹继承资料库权限。

## 资料库与原生附件

MinIO 保存不可变文件和显式归档的 AI 产物，PostgreSQL 保存资料库、目录、版本、员工访问记录及权限。资料库左侧提供新建、最近、我的资料和共享空间，目录树复用原生 Factory，按需展开、分页及局部重试；右侧提供搜索、上传、对话生成和文件列表。个人与共享目录展示文件和文件夹，最近展示跨库文件。新建文件夹后进入实际保存目录并更新导航；上传目标由操作入口确定，最近视图先选择位置。文件和文件夹通过拖动在同库可编辑目录间移动；引用和归档使用目标选择窗口。筛选与排序在服务端分页前执行；网络写入完成后以短事务提交元数据，失败对象进入现有清理队列。

用户选择文件后，主进程实时授权并校验摘要、大小及版本，再通过 Harness 原生附件 admission 加入当前草稿。上传、重试、卡片、会话记录、文件与 Office 工具均复用原生能力。产物仅在用户点击“保存到资料库”并确认目标后归档。

公司专家、技能和团队内容仍按 Session 固定版本与哈希，子会话继承。资料库文件作为普通原生附件保存到 Session，不增加知识任务、派生 Preset 或检索工具。

### 资料库数据与接口

[`library` 出口](../../packages/deepseek-harness-product/product/src/library.ts)定义跨进程元数据及校验；原文件通过独立传输读取。

| 数据 | 语义 |
| --- | --- |
| `Library` | UUID 标识、名称、简介、`PERSONAL / TEAM` 范围、所属公司、员工所有者、当前员工的 `role` 与文件编辑资格 `canManage`、正整数版本及创建／更新时间 |
| `LibraryEntry` | 库与父目录标识、名称、`FILE / FOLDER`、摘要、媒体类型、字节数及版本；根目录的 `parentId` 为 `null` |
| 文件与文件夹 | 文件必须有 SHA-256、媒体类型及正数字节数；文件夹的摘要和媒体类型为 `null`，字节数为零 |
| 分页 | `data / pageIndex / pageSize / totalCount / totalPages`；页码从 1 开始，每页默认 20 项、最多 100 项；空目录的总页数为零 |
| `LibraryFile` | 跨库文件投影，含所在库、管理资格、本人访问时间、来源类型；原会话标识仅向创建者返回 |
| `LibrarySelection` | 主进程持有的上传选择标识、文件或目录类型、名称、相对目录及字节数，不包含本地路径；空目录保留，上传与对话附件使用独立限制 |

[`library-bridge`](../../packages/deepseek-harness-product/product/src/library-bridge.ts)校验元数据请求和回执；跨库文件查询使用 `/api/v1/library-files`，库与条目操作使用 `/api/v1/libraries`。

| IPC 方法 | 操作 |
| --- | --- |
| `library.files.list` | 分页查询跨库文件视图，支持名称、分类、视图、排序和方向 |
| `library.entries.access` | 记录当前员工明确读取文件的访问时间，不扩大权限 |
| `library.list / get` | 分页搜索可访问资料库或读取单库 |
| `library.personal.ensure` | 按认证员工自动准备个人根目录；并发请求返回同一目录 |
| `library.create` | 幂等创建仅本人可见的团队资料库 |
| `library.members.list / save / remove` | 查看成员、授予编辑或查看权限、撤销授权；写入携带资料库版本 |
| `library.owner.transfer` | 所有者转移给同公司员工；原所有者保留编辑权限 |
| `library.memberOptions.employees / departments` | 从企业目录选择员工或部门 |
| `library.update / delete` | 修改或删除资料库；携带期望版本 |
| `library.entries.list / get` | 分页读取文件目录、最近文件或文件夹候选，或按标识读取条目 |
| `library.folders.create` | 使用幂等键在指定父目录创建文件夹 |
| `library.entries.update / delete` | 重命名、移动、删除；修改和删除携带期望版本 |
| 其余 `library.files.*` | 主进程处理文件选择、上传、预览、下载及系统打开；传输规则见[桌面文件接口](../../packages/deepseek-harness-product/desktop/README.md) |

条目搜索可返回库内其他目录的结果；无搜索词的文件夹视图只返回当前父目录。分页回执必须匹配请求页码和页大小，条目标识不得重复，条目归属必须匹配目标库；更新回执的版本必须递增一。校验失败拒绝整份结果，不将失败显示为空目录。

## 桌面与上游集成

官方壳提供可信启动、profile overlay、命名空间 IPC、来源检查及清理。产品校验方法白名单和结构化响应，保留错误码、关联资源及可重试性。取消贯穿 Renderer、主进程、Host 和远端请求，插件释放等待在途操作及资源清理。

产品使用公开 API。固定版本见 [UPSTREAM_TAG](../../UPSTREAM_TAG)，改动清单见[上游补丁](../../scripts/upstream-patches/manifest.json)；`verify:upstream` 校验基线、登记差异及依赖方向。产品 profile 使用钉钉身份，官方 profile 可独立运行。
