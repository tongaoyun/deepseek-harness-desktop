# 小胤架构与能力

本文描述 `xiaoyin-desktop v0.1.28` 的已实现状态。

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
| ERP 登录 | 钉钉扫码 → 隐藏 ERP WebView 建立 Cookie 会话 → 公司身份接口或旧 ERP 权限接口校验 → 小胤工作台 |
| 桌面对话 | `/` 选择方法、`@` 挂载知识库 → 固化扩展/连接器/知识能力快照 → Tauri 校验权限 → Harness → LiteLLM/MCP/本地工具 → 安全时间线 |
| 运行恢复 | 启动轻量 Host 探测 → 异常通知 → Harness 进程中止/清理 → 用户重新检测或重试任务；完整本地工具自检按需执行 |
| 能力同步 | 并行拉取目录 → 分项诊断 → SQLite 持久缓存；失败项使用上次成功数据，超过 7 天停止旧能力执行 |
| 本地拖入 | 原生拖放事件 → 授权文件所在目录 → 加入当前任务上下文 |
| 扩展安装 | 控制中心目录 → 短期下载地址 → SHA-256/Manifest/权限校验 → `extensions/<kind>/<id>/<version>` |
| 扩展发布 | SDK 校验独立 Skill 或专家套件 → 依赖预检 → MinIO 上传 → 控制中心原子发布 |
| MCP 接入 | `erp-mcp-gateway` 新增 Tool → 契约测试 → 部署 → 更新 `erp-mcp` 注册目录 → Nacos 动态下发 |
| 连接器诊断 | 一次性 Harness Host → MCP 握手和 `tools/list` → 登记清单对比 → 立即关闭 |
| 设备预检 | 原生探针 + Harness 本地工具自检 + 实时 MCP 诊断 → 去敏能力报告 → 控制中心组织总览 |
| 定时任务 | 模板/下次执行预览 → 控制中心 → Temporal Schedule → Workflow Worker → PostgreSQL 运行投影/MinIO 产物 → 桌面通知 |
| 知识库 | 文档上传 → MinIO → Temporal 解析/OCR → PostgreSQL 全文、同义词与模糊混合检索 |
| 钉钉频道 | 钉钉 Stream → 本机持久队列/会话隔离 → Harness；Office/PDF 附件本机解析，任务结果按配置主动推送 |
| 记忆同步 | 桌面设置 ↔ 本机版本历史 ↔ 控制中心员工档案 → 确认后进入桌面对话与本机 IM |
| 审计 | 桌面/服务端 → 去敏事件 API → PostgreSQL → 桌面审计页 |

连接器诊断不初始化模型、不调用业务工具，也不复用或重启聊天 Harness。设备上报只保留握手状态和工具差异数量，不上传端点、工具名、令牌或错误原文。

## 当前能力

| 领域 | 已实现能力 |
|---|---|
| 身份与模型 | ERP 扫码登录、控制中心模型目录、LiteLLM |
| Agent | 内置 DeepSeek Harness、SQLite 会话、搜索/分页/归档、富文本回复、产物卡片、安全执行时间线、任务取消与失败重试 |
| 扩展 | `.xiaoyin-kit/kit.json` 专家套件、根目录 `SKILL.md` 独立 Skill、`/` 命令入口、自动触发、版本与权限治理 |
| 连接器 | 任务基础工具层、Streamable HTTP/SSE、白名单、写审批、实时诊断和新任务能力快照 |
| ERP | `order_get`、`sales_summary`、`inventory_risk` |
| 本地工具 | 文件、DOCX/XLSX/PDF、Shell、Windows Computer Use |
| 知识 | 跨设备记忆、保存确认、本机 50 版历史与导入导出、个人/团队/公司知识库和来源引用 |
| 云端任务 | Temporal 定时任务、常用时间模板、执行预览、失败通知、执行记录和产物下载 |
| IM | 本地钉钉 Stream、持久队列、重试、开放/配对模式、会话隔离、文档附件解析、任务结果推送和系统托盘驻留 |
| 运维 | 运行通知、中央审计、设备基线、组织总览、定时签名更新检查、正式版本回滚 |
| 团队开发 | 独立专家套件模板；ERP MCP Tool 统一在 `erp-mcp-gateway` 开发 |

## 安全规则

- 专家套件和 Skill 只声明连接器 ID、工具、知识库引用和权限，不携带地址或凭据。
- 所有已就绪连接器会加入新任务能力快照；扩展声明的连接器和工具属于强依赖，缺失时阻止运行。连接器写操作始终逐次审批。
- 新建任务、选择专家套件或调用 Skill 时重新生成能力快照；连接器、扩展或知识上下文更新不改变进行中的任务。
- 本地工具只能访问员工授权目录；目录穿越、越界符号链接和敏感文件被拒绝。
- 模型凭据、员工令牌和 IM Secret 只存在于受控进程或系统凭据库。
- UI 和设备报告不包含隐藏推理、工具参数、业务返回、绝对路径或截图。
- 审计只保存事件分类、动作、结果、资源标识和安全摘要，不保存工具参数或业务原文。
- 云端无人值守工作流不执行声明为破坏性的 MCP 工具。
- Windows 主程序和 Harness 子进程不创建控制台窗口；ERP 授权 WebView 完成扫码后立即隐藏并重置为小胤二维码页。
- ERP Cookie 只留在系统 WebView；优先使用公司身份接口，旧 ERP 会话回退到 `managerstats` 校验，并生成不包含 Cookie 的短期运行凭据。

## 当前边界

- Computer Use 仅支持 Windows 交互桌面，不支持锁屏或无桌面会话；发布 Runner 在 Session 0 验证桥接依赖，员工桌面预检通过安装包内 Harness 实际验证截图与可访问性观察。
- 钉钉使用 Client ID/Secret 手动配置；扫码自动注册尚未接入公司授权服务。
- 钉钉任务结果推送依赖开放平台“机器人主动发消息”权限；桌面离线时云端任务继续执行，本地频道恢复后只推送新结果，不补发启用前历史记录。
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
| `xiaoyin-connectors` | `erp-mcp` 连接器目录、契约校验、在线探测和 Nacos 发布 |
| `erp-mcp-gateway` | 全部 ERP MCP Tool 的统一开发与运行入口 |

平台固定维护 4 个 `xiaoyin-*` 主仓库。业务专家套件可以使用独立仓库；MCP 不拆分项目，所有 ERP Tool 统一提交到 `erp-mcp-gateway`。
