---
description: "叠加在 DeepSeek Harness 公开扩展点之上的DeepSeek Harness产品包。"
kind: "package-group"
---

# DeepSeek Harness产品包

## 概述

此包组将DeepSeek Harness企业服务接入 Harness 公开扩展点。执行、会话、对话、工具、审批、Browser、Office 和持久化仍由官方 Harness 包负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`expert-kit-readme`](expert-kit-readme/README.md) | 在 Preset 作用域内按需向模型加载专家套件 README 说明 |
| [`product`](product/README.md) | 服务端客户端、钉钉会话适配器、能力快照和 Electron 桥接 |
| [`runtime`](runtime/README.md) | Cordis 任务能力组合、内容快照和权限策略 |
| [`desktop`](desktop/README.md) | 主进程认证、凭据、sidecar 与产品打包资源 |

<a id="related-documentation"></a>
## 相关文档

从[企业桌面项目总览](../../apps/product-desktop/docs/README.md)了解产品流程和仓库职责。[DeepSeek Harness 产品子系统](../../docs/subsystems/deepseek-harness-product.md)定义集成点，[桌面装配](../../apps/product-desktop/README.md)维护本地启动和交付说明。

<a id="dev-note"></a>
## 开发备注

产品包只能依赖 Harness 公开 API，不替换或修改 Harness 运行时。
