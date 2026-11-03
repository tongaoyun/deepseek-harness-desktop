---
description: "企业桌面的身份、连接器、知识库、专家和技能集成。"
kind: "package-group"
---

# 企业产品包

## 概述

本包组将公司服务接入 Harness，提供钉钉登录、连接器、知识库、专家和技能。对话、执行、审批、文档预览及 Session 持久化使用官方能力。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
| --- | --- |
| [product](product/README.md) | 产品协议、服务端访问和员工会话 |
| [runtime](runtime/README.md) | 连接器工具、知识库范围与任务快照 |
| [desktop](desktop/README.md) | 主进程凭据、原生文件、sidecar 与启动准备 |
| [experts](experts/README.md) | 专家、专家团及原生委派 |
| [skills](skills/README.md) | 技能管理与原生 Skill Provider 接入 |

专家和技能由产品桌面固定装配，页面合入产品 UI，随桌面统一更新。官方 profile 不加载这些产品模块。

企业界面提供中文和英文词条；其他 Harness 语言使用英文词条。

<a id="related-documentation"></a>
## 相关文档

- [项目总览](../../apps/product-desktop/docs/README.md)：员工入口和仓库职责。
- [产品子系统](../../docs/subsystems/deepseek-harness-product.md)：集成与权限规则。
- [桌面构建](../../apps/product-desktop/README.md)：本地启动和交付。

<a id="dev-note"></a>
## 开发备注

产品包只使用 Harness 公开 API。
