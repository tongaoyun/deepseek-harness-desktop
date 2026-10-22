---
kind: package-reference
description: "产品桌面的内建专家套件模块。"
---

# 专家套件

## 概述

随产品桌面固定装配，产品 UI 在左侧“扩展能力”直接挂载页面，不另行安装功能插件，不提供设置重复页或独立更新。个人专家和专家团由官方 Settings 保存；委派使用官方 Subagent 和工具机制。个人创建、导入、修改、删除与提交共享在页面完成；团队共享内容由服务端同步。

## 目录

- [装配与维护](#assembly)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="assembly"></a>
## 装配与维护

Host 模块通过产品 profile 固定装配，普通 ESM 客户端模块合入产品 UI 的浏览器产物；不声明独立安装包。根目录 `pnpm run build:artifacts` 完成构建，本目录 `tsconfig.json` 检查源码。官方 profile 不加载产品模块。

原始来源摘要见 [upstream.json](upstream.json)，保留 [Apache-2.0 许可](LICENSE)。代码由本仓库维护，社区更新选择性合入，不整包替换。团队内容的格式和发布入口见[公司内容说明](../../../apps/product-desktop/docs/company-content.md)。

<a id="dev-note"></a>
### 开发备注

源码从固定社区版本移入产品包，已有断言按原始语法指纹移入仓库检查基线，禁止增加新断言。原社区实现保留原 lint 范围，由独立严格类型检查及行为测试验证；新增装配、配置读取和提交出口仍执行仓库 lint。个人配置身份、本机技能文件与官方 Session 存储保持稳定，不读取历史插件设置备份。

<a id="model-experience"></a>
## 模型体验

### 原生能力

#### 模型看到的内容

模型通过 `list_experts` 浏览专家名册并通过 `summon_expert` 使用选定说明；个人内容和团队内容按当前版本读取。公司内容按 Session 固定版本，输入记录沿用原生日志。

#### Token 影响

名册、委派参数和说明按需占用上下文。页面整合不新增模型输入。

#### KV Cache 影响

不管理模型缓存；内容变化由官方请求组装处理。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 仅随产品桌面装配和更新，不作为社区插件独立发布。
