---
description: "小胤产品目录与账号范围产品导航的 Electron 侧边栏扩展。"
kind: "package-reference"
---

# 小胤产品侧边栏

[English](README.md) | 中文

此包发布小胤产品侧边栏扩展。不会发布 companion 包，因为所有产品操作都通过 Electron preload 白名单和 `xiaoyin.native.v1` sidecar 分发。

## 概述

侧边栏展示产品目录，不重新实现 Harness 的对话或任务状态。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在官方 Electron 桌面组合中启用此扩展，即可展示专家套件、技能、连接器、知识库、定时任务和 IM 导航。产品请求始终经过 preload 白名单并由主进程产品桥处理，Renderer 不会获得会话凭据或直接访问 sidecar 的能力。

<a id="model-experience"></a>
## 模型体验

### 产品导航

#### 模型看到的内容

扩展只负责渲染浏览器导航，不增加 `ToolDefinition`、提示词片段或其他面向模型的行为。

#### Token 影响

不会增加模型 token。

#### KV Cache 影响

不会创建缓存条目；扩展只负责渲染产品导航。<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 侧边栏需要 Electron 产品桥和可访问的小胤服务端。
- 不提供离线目录或第二套执行路径。

<a id="dev-note"></a>
### 开发备注

使用仓库标准包构建流程构建此扩展。产品 API 调用放在 `packages/xiaoyin-product/product`，本包只负责官方 Sidebar slot 注册和展示。
