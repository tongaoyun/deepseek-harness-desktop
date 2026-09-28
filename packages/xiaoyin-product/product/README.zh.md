---
description: "用于小胤认证和企业产品 API 的 Electron 主进程桥。"
kind: "package-reference"
---

# 小胤产品桥

[English](README.md) | 中文

## 概述

桥接在 Electron 主进程保存钉钉凭据并访问产品 API，只向 Renderer 暴露精简的类型化接口。不会发布 companion 包，因为类型化桥接和服务端 API 不会独立发生偏差。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 模型体验

### 产品桥

#### 模型看到的内容

桥接只提供产品元数据和认证，官方 `Session` 执行和对话行为仍是面向模型的权威来源。

#### Token 影响

无。

#### KV Cache 影响

不会创建缓存条目；桥接不会组装或发送模型请求。

## 已知限制与延期工作

- 远程产品方法需要配置小胤服务端。
- 受监管的 sidecar 不可用时，原生方法会直接失败。

<a id="dev-note"></a>
### 开发备注

凭据和原生分发必须保留在 Electron 主进程。Renderer 只能使用 preload 白名单。
