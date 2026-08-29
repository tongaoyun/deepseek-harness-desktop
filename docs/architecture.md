# 小胤桌面端架构与能力

本文描述 `xiaoyin-desktop v0.1.9` 当前已经实现的架构与能力。

## 总体架构

```text
员工电脑
┌──────────────────────────────────────────────┐
│ xiaoyin-desktop                              │
│ React 工作台                                 │
│        │ Tauri Command / Event               │
│ Tauri 原生层                                 │
│ ├─ ERP 扫码登录与系统凭据                    │
│ ├─ 专家套件安装与本地目录授权                │
│ ├─ 原生审批、任务历史、自动更新              │
│ └─ 启动并隔离 Harness Host                   │
│        │ JSON-RPC / stdio                     │
│ DeepSeek Harness Host                        │
│ ├─ Skills 与专家套件命令                     │
│ ├─ 企业 MCP Client                           │
│ ├─ 本地文件、Office、Shell、Computer Use     │
│ ├─ 审批桥接与会话持久化                      │
│ └─ 钉钉 Stream 本地频道                      │
└───────────────┬──────────────────────────────┘
                │ 公司内网 HTTP(S)
公司服务端      │
┌───────────────▼──────────────────────────────┐
│ xiaoyin-control-plane                        │
│ ├─ Bootstrap、模型、连接器、Skill/套件目录   │
│ ├─ Temporal 定时任务、知识索引与执行记录     │
│ └─ 知识库、MinIO 文件与检索引用              │
│                                              │
│ LiteLLM ───────────────▶ DeepSeek            │
│ ERP MCP Gateway ───────▶ 订单/销售/库存      │
│ Temporal ──────────────▶ Workflow Worker     │
│ Nacos ─────────────────▶ Java 配置与目录发布 │
│ MinIO ─────────────────▶ 套件、产物、知识文档│
│ PostgreSQL ─────────────▶ 元数据与检索片段    │
└──────────────────────────────────────────────┘
```

桌面端不直连 Nacos、Temporal、PostgreSQL 或 MinIO 管理接口。它只使用控制中心下发的运行时目录、LiteLLM、MCP 地址和短期下载地址。

## 项目内部结构

| 目录 | 职责 |
| --- | --- |
| `src/` | React 工作台、能力页面、任务历史与执行时间线 |
| `src-tauri/` | Tauri 原生壳、扫码登录、权限边界、套件安装和 Harness 进程管理 |
| `harness-host/` | DeepSeek Harness Runtime、MCP Client、本地工具和钉钉 Stream Runtime |
| `scripts/` | Windows Runtime 准备、安装烟测、正式发布和回滚 |
| `.gitea/workflows/` | CI、Windows 安装包、正式 Release 与回滚 |

## 一次桌面对话的请求链路

1. 桌面通过控制中心 Bootstrap 获取可用模型、LiteLLM 地址和能力端点。
2. 员工选择已安装专家套件并发送任务。
3. Tauri 校验套件权限、连接器、工具白名单和知识库引用，然后启动或复用 Harness Host。
4. Harness 加载套件 Skill，通过 LiteLLM 请求模型。
5. 模型只能看到本次套件允许的本地工具、MCP 工具和知识库。
6. Harness 调用 ERP MCP 或本地文件、Office、Shell、Computer Use 工具；高风险操作进入原生审批。
7. Harness 只把阶段、工具名和成功/失败状态发送给工作台，不发送隐藏推理、工具参数或业务返回原文。
8. 最终回复与安全执行步骤保存在员工电脑的任务历史中。

## 其他请求链路

### 专家套件安装

控制中心目录 → 桌面解析技能、连接器和知识库名称 → 员工查看权限、依赖与版本变化并确认 → 一次性下载地址 → Tauri 下载 → SHA-256 校验 → 安全解包 → Manifest/版本/引用校验 → 应用数据目录。

套件只声明连接器 ID、工具、知识库引用和权限，不携带服务地址、账号或令牌。

### 云端定时任务

桌面任务表单 → 控制中心 → Temporal Schedule → `xiaoyin-workflow-worker` → ERP MCP → MinIO 任务产物 → 控制中心短期下载地址。

任务在服务端运行，桌面关闭后不会中断。

### 企业知识库

桌面上传文档 → 控制中心写入 MinIO 并创建文档记录 → Temporal `KnowledgeIndexWorkflow` →
Workflow Worker 按 PDF 页、Excel 工作表或正文解析和分块 → PostgreSQL 检索索引。

知识库具有 `personal:<key>`、`team:<key>`、`organization:<key>` 稳定引用。桌面和钉钉 Harness 通过只读 `knowledge_list`、`knowledge_search` 工具检索当前员工可见范围；选中专家套件后，再与 Manifest 的 `knowledgeBaseRefs` 取交集。结果带文件名与页码、工作表或正文位置。支持删除、失败重试和重建索引，桌面关闭不影响解析。

### 钉钉频道

钉钉 Stream → 员工电脑上的 Harness Host → Skills/LiteLLM/企业只读 MCP → 回复原会话。

频道配置保存在本机，Client Secret 使用系统凭据库；显式退出程序或电脑关机后停止。

## 当前能力

| 能力 | 当前状态 |
| --- | --- |
| ERP 扫码登录 | 已实现，使用独立原生登录窗口 |
| 模型选择 | 已实现，当前控制中心发布 `deepseek-v4-flash` |
| DeepSeek Harness | 已内置到 Windows 安装包，无需员工安装 Node.js |
| 专家套件 | 已实现目录、详情、依赖检查、安装/更新权限确认、版本差异、下载校验、选择、命令入口和知识库绑定 |
| Skills | 已实现套件 Skill 发现、加载与执行 |
| MCP 连接器 | 已实现 Streamable HTTP/SSE、工具白名单和读写权限控制 |
| ERP MCP | 已接入 `order_get`、`sales_summary`、`inventory_risk` |
| 本地文件 | 已实现授权目录内浏览、文本读写、复制、移动、删除和建目录 |
| Office | 已实现文档读取及 DOCX、XLSX、PDF 生成 |
| Shell | 已实现授权目录内 PowerShell/Bash，带原生单次审批 |
| Windows Computer Use | 已实现截图、活动窗口 UI 元素、点击、输入、受限按键和滚动，全部逐次审批 |
| 执行过程 | 已实现安全时间线和任务历史回放，不展示隐藏推理 |
| 本地记忆 | 已实现按员工保存协作风格和工作手册 |
| 定时任务 | 已接入 Temporal，支持创建、暂停、恢复、立即运行和执行记录 |
| 任务中心 | 已合并本地 Agent 任务和云端 Temporal 任务 |
| 企业知识库 | 已实现个人/团队/公司范围、稳定引用、上传、索引、检索和来源引用 |
| IM 频道 | 钉钉已实现；飞书、Lark、微信、企业微信当前仅为预留入口 |
| 自动更新 | 已实现正式单通道、签名校验、不可变版本包和回滚 |
| Windows 发布 | 已实现 MSI/NSIS、内置 Runtime、安装/启动/卸载烟测 |

## 当前边界

- Computer Use 当前只支持 Windows 交互桌面，不支持锁屏、远程无桌面会话或 macOS。
- 钉钉当前使用 Client ID/Secret 手动配置，扫码自动注册尚未接入公司授权服务。
- 当前只发布 Windows x64 正式安装包，未发布 macOS 正式安装包。
- ERP 写工具尚未在 `erp-mcp-gateway` 对外发布。

## 运行配置

当前桌面正式环境通过控制中心 `http://192.168.2.67:30081` 启动，运行时目录中包含：

- LiteLLM：`http://192.168.2.67:32000/v1`
- ERP MCP：`http://192.168.2.67:30083/mcp`
- 专家套件、Skills、连接器、知识库、定时任务和任务记录 API

这些地址由控制中心管理；连接器目录由 Nacos 动态刷新，桌面端不硬编码具体业务 MCP 工具。

## 相关项目

| 项目 | 职责 |
| --- | --- |
| `xiaoyin-control-plane` | 桌面控制中心与 Temporal Schedule 管理 |
| `xiaoyin-workflow-worker` | 云端确定性工作流执行 |
| `erp-mcp-gateway` | ERP 业务工具 MCP 服务 |
| `xiaoyin-connectors` | 企业连接器目录与 Nacos 发布 |
| `xiaoyin-expert-kits` | 公司专家套件内容仓 |
| `xiaoyin-expert-kit-sdk` | 套件校验、打包、发布和平台预检 |
| `xiaoyin-expert-kit-template` | 各团队创建单套件项目的模板 |
