---
kind: package-library
description: "认证产品桌面用户，管理凭据、原生操作与产品资源。"
---

# 产品桌面

[English](README.md) | 中文

## 概述

进入企业工作区前通过钉钉登录。员工令牌由 Electron 主进程使用操作系统加密存储。可信桌面扩展管理产品请求和原生 sidecar。

## 目录

- [组合](#assembly)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="assembly"></a>
## 组合

`createExtension` 向官方壳提供启动准备、产品分发、事件和关闭钩子。产品组合负责 `desktop-extension.json`、`assembly.json`、服务端资源与原生二进制。官方 profile 默认不加载产品扩展。参见[产品子系统](../../../docs/subsystems/deepseek-harness-product.zh.md)。

通过 `pnpm --dir apps/product-desktop run package <target>` 打包产品，未签名制品添加 `--unsigned`。该入口为官方构建流程选择产品组合。内部桌面 CI 与发布流程使用此入口；根目录的 `package:desktop:*` 命令打包不含产品资源的官方桌面。

产品打包通过 Cargo metadata 解析原生二进制，支持 `CARGO_TARGET_DIR` 和 Cargo 配置。准备应用前先构建并检查 sidecar，打包进程退出后清理临时组合清单。

桌面构建将 `electron` 保留为外部依赖，由正在运行的 Electron 进程提供主进程 API。

`ExtensionAuthoring` 负责原生目录、ZIP 或独立 `SKILL.md` 选择、有界检查、员工隔离暂存、不可变制品上传和激活。选中文件路径和上传凭据不会返回渲染进程。非法路径、链接、重复文件、超限内容和哈希不匹配在激活前拒绝。独立 Markdown 限制为 64 KiB，附属资源需通过目录导入。导入资源随编辑保留，目录技能按选中版本下载复制。取消或关闭清理暂存，上传工作目录始终清理。个人技能保存成功后通过官方 Host 技能 Provider 安装，不准备任务。

`extensions.delete` 将技能或套件 ID 和版本转发到已认证服务端进行退役，服务端校验员工所有权并保护共享版本。本机不可变内容、任务快照及官方 Session 历史保留，后续执行仍须通过服务端授权。连接器退役由 `PersonalConnectors` 处理，仅在服务端删除成功后清理设备配置。

`AuthoringSessions` 在桌面用户数据的 `extension-conversations-v1` 目录中原子保存按员工隔离的草稿及原始资源。创建记录在 Agent 创建前关联预分配的官方 Session ID，仅保存该 Session 标识。模型更新在提交草稿前，按不可变版本坐标解析目录技能的正文和依赖。更新和保存按修订号串行执行，过时请求无法替换更新的内容。Host 白名单允许对应 Session 读取、更新并保存个人资源，提交共享仍是独立操作。保存完成后固定该版本。保存失败和桌面重启保留草稿及资源；损坏记录保留原始文件，仅自身读取失败。草稿限制为 2 MiB，包资源遵循导入限制。未保存的创建草稿仅保留在本设备。

`PersonalConnectors` 发现 MCP 工具，使用操作系统存储加密私密 Header 与环境变量，并通过本地 HTTP 转发 stdio。只有实际非破坏性只读注解允许 READ，其他已声明工具走官方审批，未声明工具拒绝。公开配置同步服务端，私密配置按员工隔离留在设备。切换账号与关闭会结束 SDK 连接和子进程。员工令牌只发送到产品服务端精确的托管 MCP 路径，已配置 OAuth 复用现有服务端提供方。

所有者修改时读取公开字段，本机私密键只返回空占位值。仅连接类型、地址、命令和参数均未改变时，留空才保留已有密钥；修改目标地址需要重新填写私密值。保存发现工具并创建新版本。删除使服务端全部版本退役，关闭缓存连接并移除当前版本的本机配置。修改失败保留原配置。

主进程从 Electron 提供 `runtime.environment.desktopVersion`，Renderer 无法覆盖。Host、HTTP 和原生请求将调用方取消与扩展生命周期信号组合。关闭时停止后台刷新，取消待处理操作并等待完成，确认 sidecar 已退出。不含凭据的产品诊断保留错误码、资源 ID、可重试性和依赖结果。

知识库上传使用主进程原生文件选择器，保留所选文件夹。普通上传保留服务端文档处理方式；文本型 PDF 上传仅可选择 PDF，要求提取内嵌文字且不执行 OCR，非 PDF 文件拒绝上传。主进程打开单个普通文件，不跟随符号链接，并将字节、有限枚举 `pdfParseMode` 和所选文件夹上传到已认证的产品服务端。上传上限取实时服务端限制与主进程 `knowledgeFiles.uploadMaxBytes` 中较小的值。取消选择器返回取消结果，不执行写入。请求取消及时结束对原生选择器和保存窗口的等待，丢弃迟到的选择结果。本地路径和 WeKnora 凭据不会返回 Renderer 或 Host，失败或取消均关闭文件句柄。

原文件预览流式写入随机私有目录，目录权限为 0700，文件权限为 0600。不透明句柄绑定员工、知识库、文档及内容版本；每个分块都重新检查当前权限和版本。取消、身份变化、过期及关闭应用均清理私有文件。启动时清理遗留的受管传输，不跟随符号链接。Renderer 收到最大 256 KiB 的 `Uint8Array` 分块，Host 转换使用有界 JSON 分块。下载原文件使用原生保存对话框；在线文档带 Markdown 后缀导出，私有文件名按 UTF-8 字节预算截断并保留普通扩展名。系统打开只允许文档和图片格式，私有文件保留至传输过期或应用关闭。

原件元数据必须提供稳定的 `contentVersion`。索引状态及其 `updatedAt` 不改变内容标识，替换原件或编辑 Markdown 则会改变。内容标识缺失时拒绝读取，Office 转换及其缓存使用同一版本。

打包的 `product.json` 支持 `knowledgeFiles` 对象，默认值为：`previewMaxBytes` 32 MiB、`spreadsheetMaxBytes` 16 MiB、`officeInputMaxBytes` 50 MiB、`officeOutputMaxBytes` 100 MiB、`downloadMaxBytes` 250 MiB、`uploadMaxBytes` 50 MiB、`transferLifetimeMs` 15 分钟、`fileRequestTimeoutMs` 5 分钟、`maxTransfers` 8。配置值必须是有界正整数；字节限制与实时服务端上限共同生效，官方查看器仍保留自身保护。Renderer 不能覆盖该配置。

启动时按服务端 Bootstrap 的精确模型 ID 生成不含凭据的模型 overlay。DeepSeek 模型使用官方 DeepSeek 适配器，其余模型使用官方 pi-ai 适配器的 OpenAI 兼容网关路由。产品 profile 不加载公共账号路由。有效的已保存默认模型会保留，不可用的默认模型在创建任务前替换为服务端第一个模型。已有 Session 的模型选择仍然显式保存，可通过官方模型选择器修改。

本机 MCP 配置将 `timeoutSeconds` 保存在加密设备配置中，范围 1–600 秒，默认 60 秒。连接、完整的分页工具发现和工具调用遵循该期限及调用方取消。Host 接收无凭据超时配置并交给官方 MCP 客户端。创建连接器的通用桌面传输期限包含两次操作期限和服务端保存时间，Host 目录查询允许最大连接及发现期限。已配置 OAuth 保留默认超时。

<a id="model-experience"></a>
## 模型体验

### 产品桌面

#### 模型看到的内容

主进程通过 `prepareHost` 向 Host 提供推理配置。本地 MCP 代理将上游凭据替换为私有代理凭证，并逐请求检查连接器可用性。员工令牌留在主进程，Renderer 不接收员工令牌或运行时 Bootstrap 机密。

#### Token 影响

认证和原生操作不增加模型 Token。

#### KV Cache 影响

此包不组装模型请求或缓存条目。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 真实钉钉登录需要可访问的产品服务。打包和原生二进制依赖目标平台工具链，签名和部署是独立操作。

<a id="dev-note"></a>
### 开发备注

关闭时取消认证轮询、停止产品刷新并结束 sidecar。方法白名单属于产品协议，preload 传输命名空间请求，壳校验请求来源。构建并准备本地 macOS 运行时后，执行 `DSH_DESKTOP_SMOKE=1 DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/deepseek-harness-catalog.e2e.ts`，用独立产品服务夹具验证两种 Electron profile。
