---
description: "提供产品协议、认证、目录与服务端访问，不依赖 Harness 或 Electron。"
kind: "package-library"
---

# DeepSeek Harness产品桥

[English](README.md) | 中文

## 概述

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

使用命名空间传输，并由产品协议白名单校验请求。`tasks.capabilities.prepare` 是唯一的套件准备入口，返回能力快照、执行位置及已校验的依赖，官方 Preset 与 Session API 负责执行。

任务能力读取和准备结果包含从固定专家套件解析的 `requiredConnectorIds`。调用方据此锁定任务选择，该选择独立于账号授权和连接器可用状态。

`extensions.import.inspect`、`extensions.save`、`extensions.submit`、`extensions.delete` 将个人扩展编辑交给主进程，返回预览或业务结果。`extensions.import.release` 清理员工隔离的预览。`extension-draft` 出口提供浏览器可用的表单校验，`authoring` 在主进程解析 YAML，生成标准技能/套件文件和依赖并集。所有者来自服务端认证。目录返回 `visibility`、`ownerEmployeeId`、`canEdit`、`canSubmit`、`canDelete` 和审核状态，个人可用资格独立于共享审核。知识引用解析区分不存在、无权访问、歧义与临时故障。

写入提交后清空目录缓存。随后的刷新失败不会将已提交操作报告为失败，目录读取显示刷新错误，不返回过时权限。

`extensions.authoring.begin/read/update/save/discard` 管理创建对话草稿。受信 Host 可以读取、更新并保存对应创建对话的个人资源。草稿按员工隔离、关联 Session 并校验修订号，仅记录自身 Session 标识。`authoring.changed` 通知已提交的变动，不携带内容。内容草稿校验排除连接器凭据和暂存标识。保存校验只允许专家套件包含内置技能和快捷命令。提交共享仍是所有者的独立操作。

`extensions.connector.read/update/delete` 通过主进程管理本人创建的个人连接器。读取仅返回公开配置及已配置私密键的空占位值。修改创建不可变的新版本，删除使资源 ID 退役。服务端对每项操作校验所有者。

连接器保存接受 1–600 的整数 `timeoutSeconds`，默认 60 秒。该字段属于本机 MCP 配置，不能写入对话内容草稿。标准 MCP JSON 可提供同一字段。

`knowledge.documents.*`、`knowledge.folders.*` 和 `knowledge.sources.read` 通过产品服务端分发已认证的管理与阅读操作。分页返回从一开始的 `page` 以及 `items`、`size`、`total`，筛选与总数来自服务端分页。写入校验内容大小和稳定重试键；Markdown 修改必须提供 `expectedUpdatedAt`。文件上传通过注入的原生回调选择文件，拒绝渲染进程提交路径和解析器配置。`pdfParseMode` 仅接受 `STANDARD`（默认）或 `TEXT`（提取 PDF 内嵌文字，不执行 OCR），解析引擎由服务端决定。响应保留异步处理和删除状态。调用取消与身份切换会取消远端操作。WeKnora 地址与凭据不会经过产品桥返回。

`knowledge.documents.previewMetadata` 读取原文件元数据，不依赖索引状态。`preview.open`、`preview.read`、`preview.close` 使用按员工隔离、由主进程持有的文件句柄；Renderer 收到有界 `Uint8Array` 分块，不再接收整文件 Base64。请求仅接受资源 ID、不透明传输 ID 或经校验的字节偏移。Office 渲染通过私有 JSON 分块调用官方 Host 转换服务。`download`、`openExternal` 仅接受资源 ID，将原生文件操作交给主进程。二进制 HTTP 传输拒绝重定向，流式写入调用方持有的目标，保留结构化权限错误。索引引用片段继续通过 `knowledge.sources.read` 阅读，打开原文件不会创建 Session 或增加检索输入。[桌面配置](../desktop/README.zh.md) 定义产品限制和临时文件归属。
