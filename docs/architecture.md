# 小胤架构与能力

本文描述 `xiaoyin-desktop v0.1.17` 的已实现状态。

## 总体架构

```text
员工电脑
┌─────────────────────────────────────┐
│ xiaoyin-desktop                     │
│ React 工作台                        │
│   │ Tauri Command / Event           │
│ Tauri 原生层                        │
│ ├─ 登录、凭据、权限与审批           │
│ ├─ 套件安装、文件授权与自动更新     │
│ └─ Harness Host 进程管理            │
│   │ JSON-RPC / stdio                │
│ DeepSeek Harness Host               │
│ ├─ Skills、MCP 与知识库             │
│ ├─ 文件、Office、Shell、Computer Use│
│ └─ 本地钉钉频道                     │
└────────────────┬────────────────────┘
                 │ 公司内网 HTTP(S)
公司服务端       │
┌────────────────▼────────────────────┐
│ xiaoyin-control-plane               │
│ ├─ Bootstrap、模型和扩展目录        │
│ ├─ 知识库、任务、记忆与中央审计     │
│ └─ 短期制品上传/下载授权            │
│ LiteLLM ─────────▶ 模型              │
│ ERP MCP ─────────▶ 订单/销售/库存    │
│ Temporal ────────▶ Workflow Worker   │
│ Nacos / MinIO / PostgreSQL           │
└─────────────────────────────────────┘
```

桌面不直连 Nacos、Temporal、PostgreSQL 或 MinIO 管理接口。服务地址和短期制品 URL 均由控制中心下发。

## 仓库结构

| 目录 | 职责 |
|---|---|
| `src/` | React 工作台与能力页面 |
| `src-tauri/` | 原生安全边界、安装器和进程管理 |
| `harness-host/` | Agent Runtime、MCP Client、本地工具和 IM |
| `scripts/` | Windows 构建、烟测、发布和回滚 |
| `.gitea/workflows/` | CI、安装包与正式 Release |

## 核心链路

| 场景 | 链路 |
|---|---|
| 桌面对话 | Bootstrap → Tauri 校验权限 → Harness → LiteLLM/MCP/本地工具 → 安全时间线 |
| 套件安装 | 控制中心目录 → 短期下载地址 → SHA-256/Manifest/权限校验 → 应用数据目录 |
| 套件发布 | SDK 校验 → 依赖预检 → MinIO 上传 → 控制中心原子发布 |
| MCP 接入 | 项目模板 → 公共准入 CI → 部署 → 注册目录 → Nacos 动态下发 |
| 连接器诊断 | 一次性 Harness Host → MCP 握手和 `tools/list` → 登记清单对比 → 立即关闭 |
| 设备预检 | 原生探针 + 实时 MCP 诊断 → 去敏能力报告 → 控制中心组织总览 |
| 定时任务 | 桌面 → 控制中心 → Temporal Schedule → Workflow Worker → MinIO 产物 |
| 知识库 | 文档上传 → MinIO → Temporal 解析 → PostgreSQL 检索片段 |
| 钉钉频道 | 钉钉 Stream → 本机 Harness → Skills/只读 MCP → 原会话 |
| 意识同步 | 本机副本 ↔ 控制中心员工档案 → 桌面对话与本机 IM |
| 审计 | 桌面/服务端 → 去敏事件 API → PostgreSQL → 桌面审计页 |

连接器诊断不初始化模型、不调用业务工具，也不复用或重启聊天 Harness。设备上报只保留握手状态和工具差异数量，不上传端点、工具名、令牌或错误原文。

## 当前能力

| 领域 | 已实现能力 |
|---|---|
| 身份与模型 | ERP 扫码登录、控制中心模型目录、LiteLLM |
| Agent | 内置 DeepSeek Harness、会话持久化、安全执行时间线 |
| 扩展 | 专家套件、独立 Skills、命令入口、版本与权限治理 |
| 连接器 | Streamable HTTP/SSE、白名单、写审批、实时诊断 |
| ERP | `order_get`、`sales_summary`、`inventory_risk` |
| 本地工具 | 文件、DOCX/XLSX/PDF、Shell、Windows Computer Use |
| 知识 | 跨设备意识、`记住：`显式沉淀、个人/团队/公司知识库和来源引用 |
| 云端任务 | Temporal 定时任务、执行记录和产物下载 |
| IM | 本地钉钉 Stream、开放/配对模式、系统托盘驻留 |
| 运维 | 中央审计、设备基线、组织总览、签名更新、正式版本回滚 |
| 团队开发 | 专家套件和 Java MCP 脚手架、公共准入 CI |

## 安全规则

- 套件只声明连接器 ID、工具、知识库引用和权限，不携带地址或凭据。
- 普通会话默认只开放 MCP 只读工具；写工具必须由套件声明并逐次审批。
- 本地工具只能访问员工授权目录；目录穿越、越界符号链接和敏感文件被拒绝。
- 模型凭据、员工令牌和 IM Secret 只存在于受控进程或系统凭据库。
- UI 和设备报告不包含隐藏推理、工具参数、业务返回、绝对路径或截图。
- 审计只保存事件分类、动作、结果、资源标识和安全摘要，不保存工具参数或业务原文。
- 云端无人值守工作流不执行声明为破坏性的 MCP 工具。

## 当前边界

- Computer Use 仅支持 Windows 交互桌面，不支持锁屏或无桌面会话。
- 钉钉使用 Client ID/Secret 手动配置；扫码自动注册尚未接入公司授权服务。
- 飞书、Lark、微信和企业微信仍需各平台应用、接收模式与凭据，未伪装为可用连接。
- 正式安装包仅发布 Windows x64；企业代码签名证书暂未接入。
- ERP MCP 当前只发布只读工具。

## 运行配置

正式控制中心为 `http://192.168.2.67:30081`。LiteLLM、ERP MCP、扩展目录、知识库和任务端点由 Bootstrap 返回；连接器目录由 Nacos 动态刷新，桌面不硬编码业务 MCP。

## 相关仓库

| 仓库 | 职责 |
|---|---|
| `xiaoyin-desktop` | Windows 桌面、Harness、本地工具和本地 IM |
| `xiaoyin-server` | 控制中心与 Workflow Worker |
| `xiaoyin-extensions` | SDK、专家套件、Skills 和模板 |
| `xiaoyin-connectors` | 连接器目录、准入工具和 Java MCP 模板 |
| `erp-mcp-gateway` | ERP 业务 MCP 工具 |

平台固定维护 4 个 `xiaoyin-*` 主仓库；业务团队生成的 MCP 和专家套件使用独立仓库。
