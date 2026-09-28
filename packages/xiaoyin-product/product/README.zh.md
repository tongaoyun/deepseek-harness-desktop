---
description: "用于小胤认证和企业产品 API 的 Electron 主进程桥。"
kind: "package-reference"
---

# 小胤产品桥

[English](README.md) | 中文

## 概述

桥接在 Electron 主进程保存钉钉凭据、读取已认证的 Bootstrap 并访问产品 API，只向 Renderer 暴露精简的类型化接口。运行时 Bootstrap 机密只传给官方 Harness Host，不作为桥接方法暴露。不会发布 companion 包，因为类型化桥接和服务端 API 不会独立发生偏差。

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

- 安装版从随包发布的 `xiaoyin/product.json` 读取小胤服务端地址；未打包的开发环境可以使用 `XIAOYIN_SERVER_URL` 覆盖。
- 受监管的 sidecar 不可用时，原生方法会直接失败。

<a id="dev-note"></a>
### 开发备注

产品配置、凭据和原生分发必须保留在 Electron 主进程。Renderer 只能使用 preload 白名单。
