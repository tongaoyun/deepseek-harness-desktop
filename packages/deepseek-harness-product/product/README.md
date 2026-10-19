---
description: "提供产品协议、认证、目录与服务端访问，不依赖 Harness 或 Electron。"
kind: "package-library"
---

# DeepSeek Harness产品桥

## 概述

文件夹列表请求使用 `parentId` 选择一个分支，null 代表根目录直属子项。桥接转发上级标识和指定页码、页大小，不读取完整目录层级。

产品桥提供已认证的员工目录、任务能力准备和连接器授权，保留最后成功的展示目录并合并刷新；知识库读取始终查询服务端。调用方注入原生能力及任务运行时。技能和套件的安装操作通过 Host 管理已认证员工的设备；写入提交后才发送目录事件。卸载保留服务端资源和已开始任务。员工凭据由桌面主进程保管，协议包不依赖 Harness 或 Electron。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 产品桥

#### 模型看到的内容

桥接只提供产品元数据和认证。主进程在 Host 启动前注入员工级推理配置；官方 `Session` 执行和对话行为仍是面向模型的权威来源。

#### Token 影响

不会向模型上下文加入产品令牌。

#### KV Cache 影响

不会创建缓存条目；桥接不会组装或发送模型请求。<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 安装版从随包发布的 `deepseek-harness/product.json` 读取DeepSeek Harness服务端地址；未打包的开发环境可以使用 `DEEPSEEK_HARNESS_SERVER_URL` 覆盖。
- 受监管的 sidecar 不可用时，原生方法会直接失败。

<a id="dev-note"></a>
### 开发备注

已认证请求、推理配置、后台目录和会话续期归属启动时捕获的员工生命周期。身份切换取消旧请求并拒绝迟到响应。旧令牌的认证失败不会退出已续期会话；续期仅在原身份及令牌仍有效时提交。释放桥接等待全部在途续期结束。

钉钉授权轮询绑定当前授权尝试。切换账号、发起新授权或调用方取消后，迟到的登录响应不能提交。续期、创建授权和轮询均接收调用方取消信号；登录期限覆盖完整流程。启动续期期间，后台检查若已使原会话失效并取消旧请求，登录流程继续正常浏览器授权；调用方取消仍立即结束，其他员工的新会话不会被覆盖。

JSON 请求的网络中断或内部请求期限超时返回 `PRODUCT_NETWORK_UNAVAILABLE`，私有原因保留在主进程异常中。请求不自动重试，写入是否完成仍可能未知；调用方取消保留原取消原因。登录仅在服务端明确拒绝员工认证时开始新授权，刷新网络失败不会信任旧会话或清除其记录。

`knowledge.folders.get` 按 ID 读取指定知识库内的一个文件夹，转发取消信号并由服务端检查当前权限。仅接受知识库和文件夹 ID；客户端可独立于已加载目录页解析上级路径。

文件夹响应必须包含 `updatedAt`；重命名要求 `expectedUpdatedAt` 和 `operationId`，桥接发送版本与 `Idempotency-Key`。服务端冲突不会覆盖新版本，同键同内容重试返回原回执。`knowledge.documents.upload.pending` 仅向桌面页面提供当前员工在指定知识库的原生上传恢复信息，不向 Host 或模型开放，也不暴露本地路径。

使用命名空间传输，并由产品协议白名单校验请求。`tasks.capabilities.prepare` 是唯一的套件准备入口，返回能力快照、执行位置及已校验的依赖，官方 Preset 与 Session API 负责执行。

JSON 与原文件请求统一保留服务端错误的 `retryable`、资源和依赖检查结果。已明确不可重试的配置错误不会因 HTTP 503 变成可重试；缺少结构化错误的网关响应才按 HTTP 状态判断。无法解析的响应或无效 COLA 信封返回 `INVALID_SERVER_RESPONSE`，不把原始响应内容传给界面或模型。

任务能力读取和准备结果包含从固定专家套件解析的 `requiredConnectorIds`。调用方据此锁定任务选择，该选择独立于账号授权和连接器可用状态。

`extensions.import.inspect`、`extensions.save`、`extensions.submit`、`extensions.delete` 将个人扩展编辑交给主进程，返回预览或业务结果。`extensions.import.release` 清理员工隔离的预览。`extension-draft` 出口提供浏览器可用的表单校验，`authoring` 在主进程解析 YAML，生成标准技能/套件文件和依赖并集。所有者来自服务端认证。目录返回 `visibility`、`ownerEmployeeId`、`canEdit`、`canSubmit`、`canDelete` 和审核状态，个人可用资格独立于共享审核。知识引用解析区分不存在、无权访问、歧义与临时故障。

技能、内置技能与套件的 `knowledgeBaseRefs` 仅接受 `personal:<key>`、`department:<key>`、`company:<key>`，与目录 `reference` 一致。创建、导入和服务端提交均拒绝旧 `team:`、`organization:` 前缀，详情不转换引用。固定任务仍按实际知识库 ID 和实时权限执行。旧扩展须按[知识引用升级说明](../../../docs/upgrade-guide/v0.2.1-alpha.4/product-knowledge-references/guide.md)另建版本。

扩展保存、删除和提交审核结束后立即清空目录缓存并发送目录变更事件，返回原始业务结果，不等待全部目录刷新。后台刷新由目录管理器持有，释放时取消并等待结束；每类目录分别提交成功结果，故障只阻止对应目录首次加载或实时读取，其他目录继续可读。依赖目录刷新失败后，其旧结果不能用于宣告技能或套件依赖可用。并发读取以每类目录最后发起的请求为准；旧员工和较早请求不能覆盖新结果。缓存仅用于展示，知识库读取与执行授权仍查询服务端。

连接器授权确认及撤销以服务端响应为准，成功后立即清空展示缓存并发送目录变更事件，不等待四类目录刷新。后台刷新由目录管理器持有并在释放时取消、等待结束；失败由后续目录读取报告。连接器页面重读自身目录，知识库或组织服务故障不会将已成功的授权或撤销显示为失败。

扩展保存可能在服务端提交后于本机安装阶段失败。桥接仍使目录缓存失效并通知创建记录重读，返回原始错误。`EXTENSION_INSTALL_FAILED` 表示已保存但本机安装可重试；`EXTENSION_SAVE_PENDING` 表示提交结果待确认，须重试固定内容。取消或身份切换后不发送旧员工通知。创建快照的 `pendingSave` 固定主进程提供的作者，`saved` 固定资源与版本，两者不包含凭据。

`extensions.authoring.begin/read/update/save/discard` 管理创建对话草稿。受信 Host 可以读取、更新并保存对应创建对话的个人资源。草稿按员工隔离、关联 Session 并校验修订号，仅记录自身 Session 标识。`authoring.changed` 通知已提交的变动，不携带内容。内容草稿校验排除连接器凭据和暂存标识。保存校验只允许专家套件包含内置技能。提交共享仍是所有者的独立操作。

内置技能草稿通过可选的 `description` 保留完整原生描述，与最多 300 字符的目录 `summary` 分开。简介必须等于描述或其空白归一化投影：首个完整句子能容纳时取该句，否则取前 299 个 UTF-16 单元并追加省略号。内置技能 ID 和导入资源 ID 支持两个字符的名称。`extensionFiles` 从主进程持有的原始 Markdown 保留额外 frontmatter，并按 UTF-8 字节检查完整生成文件：独立技能 64 KiB，内置技能 256 KiB。

`extensions.connector.read/update/delete` 通过主进程管理本人创建的个人连接器。读取仅返回公开配置及已配置私密键的空占位值。修改创建不可变的新版本，删除使资源 ID 退役。服务端对每项操作校验所有者。

`extensions.connector.configuration.read/save` 管理本人设备上的连接凭据，适用于当前可访问的非托管、无 OAuth 连接器，无需资源编辑权限。读取返回固定目标、所需字段名、超时和配置状态；保存只接收私密 Header、环境变量与超时，不允许更换目标或提升版本。公开列表仅返回 `canConfigure` 和配置状态；私密值不返回 Renderer 或 Host。配置完成使连接器目录缓存失效。

Host `connectors.list` 可提交 `{ids: string[]}`，在本机工具发现前筛选连接器；省略查询全部，空数组返回空集合。Renderer 目录不做 MCP 工具发现，仅展示服务端元数据与本机配置状态。服务端认证代理的运行时请求附带固定版本 Header；员工令牌与私密 Header 始终由主进程持有。

连接器保存接受 1–600 的整数 `timeoutSeconds`，默认 60 秒。该字段属于本机 MCP 配置，不能写入对话内容草稿。标准 MCP JSON 可提供同一字段。

`knowledge.documents.*`、`knowledge.folders.*` 和 `knowledge.sources.read` 通过产品服务端分发已认证的管理与阅读操作。分页返回从一开始的 `page` 以及 `items`、`size`、`total`，筛选与总数来自服务端分页。写入校验内容大小和稳定重试键。文件夹创建发送可为 null 的稳定 `parentId`，响应保留上级标识，名称限制为 80 字符，重命名不改变上级或内容位置。Markdown 和网页新建转发所选 `folderId`；Markdown 修改必须提供 `expectedUpdatedAt`，拒绝同时改变文件夹。创建结果未确认时保留重试键，须先检查真实资源。`knowledge.documents.upload.select` 通过主进程原生多选回调登记文件，返回独立操作编号、文件名和固定目标。`upload` 只提交已登记的单个文件；`upload.pending` 恢复全部未确认项，`upload.discard` 释放对应选择。拒绝渲染进程提交路径、所有者或解析器配置。`pdfParseMode` 仅接受 `STANDARD`（默认）或 `TEXT`（提取 PDF 内嵌文字，不执行 OCR），解析引擎由服务端决定。响应保留异步处理和删除状态。调用取消与身份切换会取消远端操作。WeKnora 地址与凭据不会经过产品桥返回。

`knowledge.documents.previewMetadata` 读取原文件元数据，不依赖索引状态。`preview.open`、`preview.read`、`preview.close` 使用按员工隔离、由主进程持有的文件句柄；Renderer 收到有界 `Uint8Array` 分块，不再接收整文件 Base64。请求仅接受资源 ID、不透明传输 ID 或经校验的字节偏移。Office 渲染通过私有 JSON 分块调用官方 Host 转换服务。`download`、`openExternal` 仅接受资源 ID，将原生文件操作交给主进程。二进制 HTTP 传输拒绝重定向，流式写入调用方持有的目标，保留结构化权限错误。索引引用片段继续通过 `knowledge.sources.read` 阅读，打开原文件不会创建 Session 或增加检索输入。[桌面配置](../desktop/README.md) 定义产品限制和临时文件归属。
