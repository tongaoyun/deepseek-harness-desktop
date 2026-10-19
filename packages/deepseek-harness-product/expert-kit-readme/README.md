---
description: "直接从 README 文件加载DeepSeek Harness专家套件说明的模型专用 Harness 技能提供器。"
kind: "package-reference"
---

# DeepSeek Harness专家套件 README

## 概述

这个 Preset 作用域插件通过官方 `agent/pre-step` 消息流程，在首次模型请求前加载已选专家套件的原始 README。README 同时进入官方技能目录供模型查询，不出现在用户命令目录中。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 专家套件说明

#### 模型看到的内容

首次请求包含固定版本的套件说明及其包资源基准路径。Session 将其记录为 `product-expert-kit-instructions` 用户消息。套件技能通过原生语义发现和官方 `skill` 工具加载。

#### Token 影响

套件说明从首次请求起占用上下文。指令按当前模型可见历史去重；上下文替换移除指令后，会重新加载。

#### KV Cache 影响

固定内容在后续请求和 Host 重启后保持稳定。更改套件选择会改变任务快照及缓存前缀。每个模型步骤和说明加载前都会检查当前服务端权限。 <a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- README 文件最大为 64 KiB。

<a id="dev-note"></a>
### 开发备注

指令保留在制品 README 和 SKILL.md 中。本插件读取固定的套件说明，并由官方消息流程在模型执行前持久化。
