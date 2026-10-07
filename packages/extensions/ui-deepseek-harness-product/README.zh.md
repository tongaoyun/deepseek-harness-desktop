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

在官方 Electron 桌面组合中启用此扩展，即可在官方侧边栏中展示“能力”分组及专家套件、技能、数据连接和知识库四个入口。产品请求始终经过 preload 白名单并由主进程产品桥处理，Renderer 不会获得员工会话凭据或上游数据连接凭据。

每个目录都能在服务端完整目录上执行本地搜索。专家套件和技能按分类分组，数据连接按自身声明的分类分组，知识库按自身声明的作用域分组。数据连接列表展示可用状态、认证方式和工具数；作用域、传输方式、版本、原始 MCP 工具名和权限保留在详情抽屉中。OAuth 条目提供授权、重新授权和撤销操作，凭据仍由服务端保管。知识库详情展示作用域和更新时间。界面不会推断服务端未返回的市场、安装、分类、授权或读写状态。

打开专家套件并选择**开始使用**，桌面端会准备其精确内容代，再创建绑定不可变 Agent Preset 的官方 Session。Preset 固定套件 README、Skill 版本、数据连接、知识库引用和工具权限，其他 Session 不会继承这些能力。选择常用任务会创建同类 Session，并把业务提示预填到输入框但不自动发送。打开独立技能并选择**使用技能**，桌面端会准备其精确内容代和依赖快照，创建绑定该不可变 Skill Preset 的官方 Session，并插入本地化的官方 Skill 引用 Chip。提交时，官方 `ReferenceCodec` 将 Chip 精确序列化为 `/<skillId>`。复制、粘贴、删除和重新打开 Session 均使用官方引用表示，不解析产品自定义自然语言提示。

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
