# 桌面架构

小胤采用一个桌面任务入口。专家套件、Skills、定时计划与钉钉会话统一使用本机 Harness 执行。

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

桌面使用 Bootstrap 下发的端点和制品 URL。Nacos、数据库及对象存储管理接口由服务端访问。ERP 工具在 `erp-mcp-gateway` 开发并注册，官方扩展内容在 `xiaoyin-extensions` 维护。

## 代码边界

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx` | 页面协调、任务调度与状态连接 |
| `src/useEnterpriseSession.ts` | 登录检查、到期重查、网络恢复与退出 |
| `src/harnessSession.ts`、`src/taskTurn.ts` | 会话选择、恢复上下文、新轮次准备 |
| `src/executionRuntime.ts` | `Thread -> Turn -> Item -> Event` 状态机、事件去重、生命周期变更与 UI 投影 |
| `src/capabilitySnapshot.ts` | 每轮能力快照与语义变化判断 |
| `src-tauri/src/` | 系统权限、ERP Cookie、凭据、持久化与进程控制 |
| `harness-host/src/runtime.ts` | 模型会话和工具运行时 |
| `harness-host/src/task-instructions.ts` | 澄清、执行、验证和交付约定 |

## 运行流程

| 场景 | 流程 |
| --- | --- |
| 登录 | 钉钉扫码、ERP Cookie、身份校验、员工工作台 |
| 执行 | 需求与工作区、能力快照、模型与工具、结果检查、交付 |
| 恢复 | 读取任务与目录、恢复原会话；需要重建时携带有界的需求、文件与结果上下文 |
| 扩展安装 | 下载制品、校验摘要与清单、检查路径、写入版本目录 |
| 连接器 | 员工配置、握手和工具发现、按轮次装配 |
| 知识库 | 上传原件、数据库排队、服务端解析索引、按权限检索和来源回读 |
| 定时任务 | 本机计划触发普通任务入口，保存运行记录 |
| 钉钉 | Stream 收取消息、本地队列、Harness 执行、正文与成果回传 |

登录检查避免并发请求。网络失败每 15 秒重试，有效期内保留已验证身份；过期后暂停使用并重查。窗口激活和网络恢复会检查到期状态，退出登录后丢弃先前请求。ERP 明确返回未登录时进入扫码，Cookie 有效期由 ERP 与 WebView 管理。

身份接口的 401、403、网络异常与响应无效分别处理。脱敏诊断记录位置和升级验收见 [登录与会话](login.md)。

任务恢复优先复用原会话。工作目录或能力内容变化时重建；JSON 对象键顺序不构成能力变化。正在运行的任务周期保存，重启后暂停未执行的队列，用户决定是否继续。

桌面任务以 `ExecutionThread` 为唯一可写事实源。每条用户请求建立一个 `ExecutionTurn`，消息、工具、授权、验收和文件状态作为 Item 与有序 `ExecutionEvent` 记录。原生事件使用 `streamId + sequence` 去重；Harness 重启后新的流不会与旧请求编号混淆。

`TaskMonitorProjection` 只供界面展示和旧组件兼容。开始、重试、停止、完成、失败、IM 接管和文件撤销必须先提交运行时事件，再由同一 reducer 生成投影。Assistant 消息通过 `executionTurnId` 关联产生它的 Turn，恢复任务即使复用 `operationScope` 也不会串改历史投影。加载本地历史时始终从有效事件线程重放，磁盘中的 Monitor 缓存即使过期或损坏也不能覆盖事件事实；没有事件线程或消息 Turn 引用的旧记录在首次继续处理时迁移。

## 数据与权限

| 数据 | 保存位置 |
| --- | --- |
| 任务、草稿、附件引用和执行记录 | 本机 SQLite 与应用数据目录 |
| 用户工作文件和成果 | 员工授权目录 |
| 扩展安装与设备启停 | 本机扩展版本目录 |
| ERP Cookie | 系统 WebView |
| 模型、连接器、IM 凭据 | 受控进程或系统凭据库 |
| 企业目录、审计、记忆同步与知识元数据 | 服务端 PostgreSQL |
| 扩展制品、知识原文件和反馈图片 | MinIO |

本地工具检查目录授权、路径穿越和符号链接。破坏性操作经过原生确认。设备报告和审计不携带隐藏推理、业务原文、工具参数、凭据或绝对路径。

能力快照固定当前轮次使用的扩展、工具和知识范围，下一轮重新读取启停及配置。未声明知识范围时可按员工权限检索；显式空范围表示不检索。手动指定的知识引用加入本轮范围，仍受员工权限约束。

## 平台约束

Windows 支持 x64；macOS 支持 14+ 的 Apple Silicon 与 Intel。Intel 包可在 Apple Silicon 上交叉构建并用 Rosetta 检查，实际硬件交互需要 Intel 设备验收。

Computer Use 需要可交互桌面及相应系统权限。Mac 操作前核对进程、窗口位置和尺寸、截图尺寸；观察过期时重新观察。主显示器以外的布局与锁屏操作单独验收。

LibreOffice 提供公式重算和 Office 转 PDF，需要在员工电脑安装。工具职责、大小限制和中文字体见 [Office 工具](office.md)。

交互细节见 [任务执行](task-execution.md)、[扩展](extensions.md)、[知识库](knowledge-base.md)、[记忆](memory.md)、[定时任务与 IM](schedules-and-im.md)。
