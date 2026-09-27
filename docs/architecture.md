# 桌面架构

本文面向桌面端开发和维护人员。员工使用方式见[产品能力](desktop-alignment.md)、[任务执行](task-execution.md)和[扩展](extensions.md)。

小胤采用一个桌面任务入口。专家套件、Skills、定时计划与钉钉会话统一使用本机 Harness 执行。

产品与运行时只有一个明确边界：专家套件、技能、连接器、知识库、定时任务和 IM 频道是小胤的产品事实源；Session、Agent Loop、上下文、工具、权限、工作流和执行事件由 DeepSeek Harness 负责。产品能力不能直接拼接 Prompt 或注册第二套工具，而是先由 `Xiaoyin Capability Resolver` 编译为 `CapabilitySnapshot`。

```text
用户选择 / 频道配置 / 定时任务
  -> Xiaoyin Capability Resolver
  -> CapabilitySnapshot
     +-- selections + exact artifacts
     +-- implicitArtifacts (仅可发现元数据，按需加载正文)
     +-- requested connector / knowledge choices
     +-- resolved connectors / knowledge scope
  -> Tauri 校验版本、摘要、启停和依赖
  -> DeepSeek Harness Session
```

## 组件

```text
React 工作台
  | Tauri Command / Event
Tauri 原生层
  | JSON-RPC / stdio
Harness Host
  +-- 模型、Skills、MCP、Shell、Office、浏览器、Computer Use
  +-- 桌面任务、定时任务、钉钉会话
  | HTTP
xiaoyin-server
  +-- 企业控制台、模型与扩展目录、记忆、审计、反馈
  +-- 知识索引、PostgreSQL、MinIO
  +-- Nacos MCP Registry
```

桌面使用 Bootstrap 下发的端点和制品 URL。Nacos、数据库及对象存储管理接口由服务端访问。ERP 工具在 `erp-mcp-gateway` 开发并注册；官方 Skill 和专家套件在 `xiaoyin-extensions` 维护并发布。连接器目录及知识库由 `xiaoyin-server` 管理，不作为扩展仓库中的独立发布物。

## 代码边界

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx` | 页面协调、任务调度与状态连接 |
| `src/useEnterpriseSession.ts` | 登录检查、到期重查、网络恢复与退出 |
| `src/harnessSession.ts`、`src/taskTurn.ts` | 会话选择、恢复上下文、新轮次准备 |
| `src/useHarnessNotifications.ts`、`src/taskHistory.ts` | 消费 Harness Session Projection、按序去重、任务历史持久化与恢复状态 |
| `src/capabilitySnapshot.ts` | 产品能力解析、依赖闭包、凭据脱敏、不可变能力快照与语义变化判断 |
| `src-tauri/src/` | 系统权限、钉钉会话、凭据、持久化与进程控制 |
| `harness-host/src/runtime.ts` | 模型会话和工具运行时 |
| `harness-host/src/task-instructions.ts` | 澄清、执行、验证和交付约定 |
| `src/useDeviceHeartbeat.ts` | 上报脱敏的桌面与 Harness 能力状态，供设备诊断使用 |

## 运行流程

| 场景 | 流程 |
| --- | --- |
| 登录 | 钉钉官方 OAuth、不透明会话、身份校验、员工工作台 |
| 执行 | 需求与工作区、能力快照、模型与工具、结果检查、交付 |
| 恢复 | 读取任务与目录、恢复原会话；需要重建时携带有界的需求、文件与结果上下文 |
| 扩展安装 | 下载制品、校验摘要与清单、检查路径、写入版本目录 |
| 连接器 | 员工配置、握手和工具发现、按轮次装配 |
| 知识库 | 上传原件、数据库排队、服务端解析索引、按权限检索和来源回读 |
| 定时任务 | 本机计划触发普通任务入口，保存运行记录；Harness `schedule_*` 仅处理当前 Session 内提醒 |
| 钉钉 | Stream 收取消息、本地队列、Harness 执行、正文与成果回传 |

登录检查避免并发请求。网络失败按有界退避重试，有效期内保留已验证身份；过期后暂停使用并重查。窗口激活和网络恢复会检查到期状态，退出登录后丢弃先前请求。钉钉会话过期后重新打开官方 OAuth 授权，不创建内嵌二维码窗口。

身份接口的 401、403、网络异常与响应无效分别处理。脱敏诊断记录位置和升级验收见 [登录与会话](login.md)。

任务恢复优先复用原会话。工作目录或能力内容变化时重建；JSON 对象键顺序不构成能力变化。正在运行的任务周期保存，重启后暂停未执行的队列，用户决定是否继续。

文件交付遵循同一文件系统策略：无显式小胤授权目录时使用 Harness 官方 `present`，只把 Session filesystem 中的相对路径声明写入 `deliverables/presented` 事件；有授权目录时关闭 `present`，由小胤 `local_files_publish` 负责目录权限、备份和撤销。两种模式都只在投影中保存文件引用，不复制文件内容。

跨会话上下文使用 Harness 官方 `dsh-session-reference`：消息中的规范 `dsh-session:` 引用在运行时读取一次，生成有界、不可变并明确标记为不可信的快照。小胤任务历史仍只保存轻量索引和 Session 引用，完整会话内容不复制到第二套产品存储。

桌面任务以 Harness `sessionId` 和官方 Session Log 为执行事实源。Harness 的官方 Conversation/Trajectory 生成实时对话与操作状态，Host 通过本机 Bearer Bridge 转发；小胤注册 `xiaoyin.product` 产品投影，只补充文件、成果、知识来源和产品标签。任务索引只保存产品元数据、最近摘要和轻量状态；打开历史时通过官方 Persistence 重放事件并重建消息与投影，不再维护第二套 `ExecutionThread/Turn/Item/Event` 执行树，也不从文本猜测运行状态。

Harness 的持久化根目录、默认工作区和 IM 会话状态按员工标识的 SHA-256 命名空间隔离，Session inspect/search 也必须显式提供员工标识；员工标识不会直接写入路径。附件仍使用统一的内容寻址存储，因为预览只接受带 SHA-256 校验的不可变对象，避免为同一图片维护多份副本。浏览器 profile 同时按员工和任务隔离。

Harness 进程缓存只在完整 `RuntimeFingerprint` 相同时复用；模型、凭据摘要、员工/团队、能力目录、连接器、知识范围、执行模式或权限任一变化都会销毁旧进程并重新初始化，避免把上一轮上下文带入新任务。

Harness 的官方 settings 与 credentials provider 显式写入员工隔离的 `DSH_HOME`（`settings.yaml` 与 `.credentials.yaml`）。小胤不把企业账号或模型密钥复制到第二套本地配置；启动时只注入本轮凭据，运行时凭据文件不进入任务投影、心跳或日志。

由于员工 `DSH_HOME` 位于打包运行时之外，Host 启动前会在 `DSH_HOME/profiles/node_modules` 为小胤额外挂载且不属于官方 `dsh` 依赖闭包的 Harness 插件建立受控回退链接（终端、代码运行时、LSP 和可选外部子 Agent）。已有 profile 管理条目始终优先，不覆盖用户安装的插件；链接只解决官方 Loader 的模块解析，不改变员工配置和权限边界。

## 数据与权限

| 数据 | 保存位置 |
| --- | --- |
| 任务索引、定时计划、队列、草稿、最近工作目录和附件引用 | 按员工隔离的本机 SQLite 与应用数据目录 |
| 用户工作文件和成果 | 员工授权目录 |
| 扩展安装与设备启停 | 本机扩展版本目录 |
| 钉钉会话 | 系统凭据库 |
| 模型、连接器、IM 凭据 | 受控进程或系统凭据库 |
| 企业目录、审计、记忆同步与知识元数据 | 服务端 PostgreSQL |
| 扩展制品、知识原文件和反馈图片 | MinIO |

本地工具检查目录授权、路径穿越和符号链接。破坏性操作经过原生确认。设备报告和审计不携带隐藏推理、业务原文、工具参数、凭据或绝对路径。

能力快照固定任务选择的套件、技能、制品版本和知识范围。正在执行的轮次固定其连接器配置、工具与凭据，不在中途热切换；下一轮启动前重新检查目录和授权，并绑定最新的 `ready` 连接器。员工主动调整能力选择时生成新快照并重建 Harness Session。制品停用、卸载、摘要不符，或者连接器被下架、停用、待授权、不可用或不再有权限时，即使旧快照仍有记录也不能继续执行。

显式选择的套件和技能记录在 `selections + artifacts`。允许自动调用但未被显式选择的能力单独记录在 `implicitArtifacts`，只向 Harness 提供受预算限制的技能目录，正文仍由 Harness 按需加载；自动能力不会扩大连接器、知识库或写权限。连接器凭据不进入持久化快照，启动执行时从系统凭据存储注入。

## 平台约束

Windows 支持 x64；macOS 支持 14+ 的 Apple Silicon 与 Intel。Intel 包可在 Apple Silicon 上交叉构建并用 Rosetta 检查，实际硬件交互需要 Intel 设备验收。

Computer Use 需要可交互桌面及相应系统权限。Mac 操作前核对进程、窗口位置和尺寸、截图尺寸；观察过期时重新观察。主显示器以外的布局与锁屏操作单独验收。

Harness 官方 Office Skills 使用安装包内的 Primary Runtime 和 LibreOffice Kit 完成生成、结构检查、公式重算、转换与渲染，不依赖员工电脑预装 Python 或 LibreOffice。Primary Runtime 来自固定版本 `0.1.7-rc.2` 的平台制品，不在小胤构建时下载或改写 Harness 源码；构建脚本只按平台选择归档、校验 SHA-256、解压并检查必需文件。见 [Office 文档能力](office.md) 和 [构建流程](build-workflows.md)。

交互细节见 [任务执行](task-execution.md)、[扩展](extensions.md)、[知识库](knowledge-base.md)、[记忆](memory.md)、[定时任务与 IM](schedules-and-im.md)。
