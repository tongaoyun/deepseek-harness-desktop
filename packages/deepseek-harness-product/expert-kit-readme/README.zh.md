---
description: "直接从 README 文件加载DeepSeek Harness专家套件说明的模型专用 Harness 技能提供器。"
kind: "package-reference"
---

# DeepSeek Harness专家套件 README

[English](README.md) | 中文

## 概述

这个 Preset 作用域提供器会把每个已启用专家套件的名称和摘要发布到官方 Harness 技能目录。只有模型选择该专家套件时，官方 `skill` 工具才会读取制品中的原始 `README.md`。该入口只允许模型调用，不会出现在用户命令目录中。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 专家套件说明

#### 模型看到的内容

会话技能目录为每个已启用套件提供一个 `expert-kit-<id>` 摘要。加载该入口后，模型会收到套件原始 README，并以套件目录作为资源基准路径。

#### Token 影响

初始目录只包含入口名称和摘要。仅当官方 `skill` 工具加载套件说明时，README 内容才进入上下文。

#### KV Cache 影响

启用套件组合变化时，技能目录及其缓存前缀会变化。README 加载后，其内容会进入该会话的后续请求。专家套件制品按 SHA-256 代保留；Host 重启时只恢复被 Session 引用或当前启用组合需要的 Preset。 <a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- README 文件最大为 64 KiB。
- 历史制品代暂不自动回收；清理前必须先确认没有 Session 引用对应 Preset。

<a id="dev-note"></a>
### 开发备注

专家套件说明必须保留在制品 README 中，不得复制到生成的技能文件或会话初始提示词中。
