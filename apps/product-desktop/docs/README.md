# 企业桌面项目总览

企业桌面结合 Harness 的对话、执行、审批和文档预览，以及公司专家、技能、连接器和资料库。员工通过钉钉登录；管理员使用服务端提供的[网页控制中心](http://www.instudio.me:6206/traefik/deepseek-harness/)。使用桌面无需在本地启动控制中心。

## 目录

- [能力使用](#capabilities)
- [资料库文件](#library-files)
- [仓库与架构](#repositories-and-architecture)
- [开发与交付](#development-and-delivery)
- [验收与限制](#verification-and-limitations)

<a id="capabilities"></a>
## 能力使用

左侧“扩展能力”打开专家套件、技能、连接器和资料库；切换页面保留对话和草稿。专家、技能随桌面更新，内容发布无需重新打包软件。

| 能力 | 使用方式 |
| --- | --- |
| 专家套件与技能 | “市场”使用公司审核内容，“我的”创建、导入和管理个人内容；执行使用原生 Agent、Skill Provider 和审批 |
| 连接器 | 添加或管理 MCP 服务，分别配置第三方授权和本机私密值；模型按需发现工具，写操作需要审批 |
| 资料库 | 浏览个人、直属部门和公司资料；从对话加号菜单选择文件，使用原生附件与文件工具 |

公司内容的格式、提交审核、AI 发布及同步见[专家与技能共享](company-content.md)。

<a id="library-files"></a>
## 资料库文件

浏览个人、直属部门和公司资料，管理者可创建文件夹、上传、重命名、移动及删除。原文件使用 Harness 原生预览，Word 和 PowerPoint 经原生 Office 转换显示；也可下载或使用系统应用打开。

对话加号菜单选择资料库文件后，文件进入原生附件栏，由原生文件和 Office 工具处理。产物卡片可显式“保存到资料库”；普通模型输出保留在原生会话。权限及存储说明见[产品子系统](../../../docs/subsystems/deepseek-harness-product.md)。

<a id="repositories-and-architecture"></a>
## 仓库与架构

| 仓库 | 职责 |
| --- | --- |
| `deepseek-harness-desktop` | Harness 基线、登记补丁、产品包、UI 和桌面交付 |
| `deepseek-harness-server` | 认证、控制中心、内容发布审核、连接器授权、企业资料权限与 MinIO 文件存储 |
| `k3s-gitops` | Fleet 管理的部署清单 |

产品通过 Cordis、原生 Remote 和 UI 插槽扩展 Harness；[原生能力复用](../../../docs/subsystems/deepseek-harness-product.md#原生能力复用)说明各类扩展的职责。连接器业务实现归属 `erp-mcp-gateway` 等业务服务，目录与授权归属服务端。包职责见[包地图](../../../packages/deepseek-harness-product/README.md)，固定基线见 [UPSTREAM_TAG](../../../UPSTREAM_TAG)，通用补丁见[补丁清单](../../../scripts/upstream-patches/manifest.json)。

<a id="development-and-delivery"></a>
## 开发与交付

使用[产品启动入口](../README.md#local-development)，其 home 和 Electron 用户数据目录与官方装配隔离。凭据留在主进程或服务端，不进入渲染进程变量或提交文件。

Gitea 负责评审和 CI；手动同步工作流调用 GitHub 原生 runner 构建 Windows x64 和 macOS ARM64。安装包发布到公开下载仓库及内网 Gitea，构建仓库的可见性决定源码是否公开。分发模式、更新源和恢复见[交付说明](delivery.md)，证书要求见[签名接入](signing.md)。

服务端使用自己的 CI、Harbor、GitOps 和 Fleet。接口变更先部署服务端，再交付依赖新接口的桌面；服务端 `docs/README.md` 索引 API、部署和领域文档。

<a id="verification-and-limitations"></a>
## 验收与限制

按改动选择[仓库测试](../../../docs/testing.zh.md)与[桌面验收](acceptance.md)。服务端资料库验收见其 `docs/library-verification.md`，运行结果单独记录。构建、部署就绪和员工流程验收分别确认。

模拟身份、模型和服务只验证组合、界面及恢复；真实钉钉权限、第二员工隔离和模型效果需单独验收。资料库不解析或索引内容；文件处理由当前模型与原生工具完成。

公司内容版本及原生 Session 分别持久化，详见[运行时](../../../packages/deepseek-harness-product/runtime/README.md)。

产品自有文档以中文维护，操作说明描述当前行为；上游文档遵循其语言与校验规则。
