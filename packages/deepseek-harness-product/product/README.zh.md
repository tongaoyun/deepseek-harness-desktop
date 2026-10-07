---
description: "用于DeepSeek Harness认证和企业产品 API 的 Electron 主进程桥。"
kind: "package-reference"
---

# DeepSeek Harness产品桥

[English](README.md) | 中文

## 概述

桥接在 Electron 主进程保存钉钉会话并读取已认证的 Bootstrap，同时向 Renderer 暴露类型化的产品和原生方法。它管理最后一份成功的目录快照、合并刷新生命周期、按需准备 Skill 与专家套件，以及员工数据连接授权调用。准备状态使用不可变的 `id`、`version` 和 SHA-256 标识，新版本不会继承旧制品的可用状态。上游 OAuth Token 始终保留在服务端。运行时 Bootstrap 机密只传给官方 Harness Host。不会发布 companion 包，因为类型化桥接和服务端 API 不会独立发生偏差。

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

运行时 Bootstrap 机密和会话令牌必须保留在 Electron 主进程。Renderer 可以调用 preload 白名单声明的产品和原生方法。
