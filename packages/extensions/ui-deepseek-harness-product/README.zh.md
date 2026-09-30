---
description: "DeepSeek Harness产品能力的官方 Harness 侧边栏导航扩展。"
kind: "package-reference"
---

# DeepSeek Harness产品能力

[English](README.md) | 中文

此包在 Harness 官方侧边栏中发布DeepSeek Harness产品能力导航。不会发布 companion 包，因为所有产品操作都通过 Electron preload 白名单和 `deepseek-harness.native.v1` sidecar 分发。

## 概述

能力面板展示产品目录，不重新实现 Harness 的对话或任务状态。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在官方 Electron 桌面组合中启用此扩展，即可在官方侧边栏中展示“能力”分组及专家套件、技能、连接器和知识库四个入口。产品请求始终经过 preload 白名单并由主进程产品桥处理，Renderer 不会获得会话凭据或直接访问 sidecar 的能力。

每个目录都能在服务端完整目录上执行本地搜索。专家套件按真实启用状态筛选，连接器按自身声明的分类分组，知识库按自身声明的作用域分组。专家套件和技能通过侧栏抽屉展示包内 README 或 SKILL 原文，查看详情时目录保持可见。界面不会推断服务端未返回的市场、安装或分类状态。

打开专家套件并使用**在聊天中启用**，即可让后续普通会话获得该套件的技能、连接器和知识库引用；已有会话保留创建时的能力快照。已启用套件的快捷命令会创建普通会话，并预填命令声明的 `/<skillId>` 和命令说明。打开技能并选择**使用技能**，即可在当前官方会话中预填 `/<skillId>`；没有打开的会话时，扩展会创建普通会话。现有输入内容会被保留。

<a id="model-experience"></a>
## 模型体验

### 产品导航

#### 模型看到的内容

扩展只负责渲染能力导航和目录面板，不增加 `ToolDefinition`、提示词片段或其他面向模型的行为。

#### Token 影响

不会增加模型 token。

#### KV Cache 影响

不会创建缓存条目；扩展只负责渲染产品能力目录。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 能力面板需要 Electron 产品桥和可访问的DeepSeek Harness服务端。
- 不提供离线目录或第二套执行路径。

### 开发备注

<a id="dev-note"></a>

使用仓库标准包构建流程构建此扩展。产品 API 调用放在 `packages/deepseek-harness-product/product`，本包只负责官方 Sidebar/Main slot 注册和展示。
