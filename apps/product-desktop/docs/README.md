# 企业桌面项目总览

## 概述

企业桌面将官方 Harness 对话、执行模式、审批和文档预览，与钉钉身份、技能、专家套件、连接器及知识库结合。本页用于查找当前产品行为和对应文档。

产品自有文档只维护中文，规范文件名为 `README.md` 或对应的 `.md`。不再维护英文副本及翻译配对记录；官方上游文档随固定基线保留原有语言与校验规则。

## 目录

- [产品入口](#product-entry-points)
- [能力使用](#capabilities)
- [知识文件](#knowledge-files)
- [仓库与架构](#repositories-and-architecture)
- [开发与交付](#development-and-delivery)
- [验收与限制](#verification-and-limitations)

<a id="product-entry-points"></a>
## 产品入口

员工使用产品桌面，通过钉钉登录。官方 Harness profile 是不加载企业扩展的独立装配。[产品桌面](../README.md)负责产品启动与打包，[桌面扩展](../../../packages/deepseek-harness-product/desktop/README.md)负责认证和设备凭据加密。

管理员使用由 `deepseek-harness-server` 提供的[网页控制中心](http://www.instudio.me:6206/traefik/deepseek-harness/)。使用桌面无需在本地启动控制中心。业务请求需要员工认证，管理操作还需服务端配置的权限。服务端连接说明由其 `docs/deployment.md` 维护。

<a id="capabilities"></a>
## 能力使用

| 能力 | 员工操作 | 任务行为 |
|---|---|---|
| 技能 | 通过对话创建或修改；导入目录、ZIP 或 `SKILL.md`；在本机安装或卸载 | 依赖满足的已安装技能使用原生语义发现或显式 `/<skillName>` 调用，安装不创建 Preset |
| 专家套件 | 安装并阅读说明，发送前选择套件或点击快捷任务 | 任务固定套件内容，已开始对话只显示套件且不提供切换；快捷任务预填后由用户确认发送 |
| 连接器 | 通过表单或 MCP JSON 添加，所有者可修改或删除，独立管理授权 | 技能和套件声明依赖；READ 注解进入策略检查，WRITE 工具走官方审批，未声明工具拒绝 |
| 知识库 | 在能力下浏览个人、直属部门和公司知识库 | 从对话输入框选择检索范围，浏览文件不将知识库加入任务 |

创建将个人技能和套件保存到服务端，技能保存成功后也会安装到本机。提交共享是所有者的独立操作。修改创建新的不可变版本；卸载移除设备安装，删除退役本人拥有的服务端资源。这些操作不删除官方对话历史。已固定任务在卸载后保留内容，但仍需通过服务端当前权限检查。完整规则见 [UI](../../../packages/extensions/ui-deepseek-harness-product/README.md)和[运行时](../../../packages/deepseek-harness-product/runtime/README.md)说明。

<a id="knowledge-files"></a>
## 知识文件

知识库工作区包含目录树、文件列表和内嵌阅读器。管理者可创建多级文件夹、重命名、上传到目录、移动文件及删除空目录。存在文件或子文件夹时，服务端拒绝删除。文件夹查询仅显示所选目录的直属文件，全部资料跨目录显示。面包屑和目标选择显示完整路径。Markdown 和网页创建保留已选文件夹；位置未确认时保留编辑，提示先检查全部资料再决定是否重新创建。

原文件查看使用官方 Harness 预览组件，不依赖索引成功。PDF 展示页面，Excel 展示只读工作簿，Word 和 PowerPoint 使用官方 Office 转 PDF。已有原件也可下载，桌面支持用系统应用打开。解析、索引、检索和来源片段由 WeKnora 负责；未保存原件的网页没有原文件预览。文件限额、转换失败和权限失败均明确提示。见[文件 UI 说明](../../../packages/extensions/ui-deepseek-harness-product/README.md)和[知识库升级说明](../../../docs/upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.md)。

服务端重新检查当前钉钉组织归属，不信任任务快照或客户端部门声明。只有本人、全部直属部门和配置公司授予范围，文件夹不增加权限。空任务范围不注册检索工具，失权和网络失败采用不同恢复方式。[产品子系统](../../../docs/subsystems/deepseek-harness-product.md)定义权限与检索规则。

<a id="repositories-and-architecture"></a>
## 仓库与架构

| 仓库 | 职责 |
|---|---|
| `deepseek-harness-desktop` | 官方 Harness 基线、登记的通用补丁、独立产品包、UI 和桌面交付 |
| `deepseek-harness-server` | 认证 API、网页控制中心、目录、个人资源、审核、组织权限和 WeKnora 适配 |
| `deepseek-harness-extensions` | 维护的共享技能及套件源码、Schema、校验、不可变制品和发布流水线 |
| `k3s-gitops` | 由 Fleet 同步的开发环境部署清单 |

连接器实现归属 `erp-mcp-gateway` 等业务服务，目录和授权归属服务端。交付流程不依赖独立连接器仓库或上游镜像仓库；桌面仓库保留固定 Harness 基线标签和登记补丁。产品包通过 Cordis 插件及 UI 插槽使用 Harness 公开出口。见[包地图](../../../packages/deepseek-harness-product/README.md)、[子系统说明](../../../docs/subsystems/deepseek-harness-product.md)和[补丁清单](../../../scripts/upstream-patches/manifest.json)。

<a id="development-and-delivery"></a>
## 开发与交付

企业开发使用产品启动入口，其 home 和 Electron profile 与官方桌面分开。[本地启动说明](../README.md#local-development)定义入口和 profile 覆盖方式。凭据留在 Electron 主进程或服务端受控配置，不放进渲染进程变量或提交文件。

Gitea 负责开发评审和桌面 CI。手动 GitHub 同步流水线要求精确源码提交的 CI 成功，将已提交的桌面源码和固定基线推送到构建仓库。原生 Runner 构建 Windows x64、macOS ARM64 和 macOS Intel，校验后的安装包及校验和同步到公开下载仓库和内部 Gitea Release。默认开发包不提供更新订阅；选择签名构建并配置签名机后，复用原生“发现新版、下载、确认重启安装”。公开构建仓库的源码和 Git 历史可公开读取。[桌面交付说明](../README.md)定义流水线参数、凭据、重试和恢复；[签名办理与接入](signing.md)说明所需资质、机器和验收。

服务端通过其 Gitea 流水线、Harbor、GitOps 和 Fleet 部署。构建成功、部署就绪和员工流程验收是独立结果。服务端 `docs/README.md` 索引 API、部署、领域和验收说明。协议迁移先部署服务端，再更新依赖新协议的桌面；[产品升级说明](../../../docs/upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.md)记录受影响行为。

<a id="verification-and-limitations"></a>
## 验收与限制

文档使用仓库的内容、链接和结构检查命令验证。行为证据包含定向产品回归、真实 Loader/profile 测试、无密钥模型 fixture、浏览器布局，以及构建后或安装后原生桌面验收。[测试说明](../../../docs/testing.zh.md)和[桌面交付说明](../README.md#local-checks)定义执行的检查，服务端证据由其 `docs/knowledge-acceptance.md` 和 `docs/knowledge-stability.md` 维护。

模拟身份和模型可在不使用员工密钥的情况下验证请求、组合、UI 和恢复，但不能证明真实钉钉权限或模型推理效果。真实第二员工隔离仍需单独验收。OCR 和视觉模型不在当前范围内，产品编辑锁不保证与 WeKnora 直接并发修改互斥。当前不提供实时协同编辑或文件夹移动。启动时可回收无引用的有效快照和内容版本，保留 Session 引用及诊断记录；回收条件和失败保护见[运行时说明](../../../packages/deepseek-harness-product/runtime/README.md)。

## 开发期协议清理

产品任务快照只接受第 3 版，执行组合元数据完整后才恢复；旧格式或损坏文件保留并提示显式恢复，不转换旧产品缓存。官方 Session 历史和草稿保留。服务端删除客户端验证报告及退回修改状态，旧记录一次性归为拒绝并保留审核原因。当前版本不提供旧接口降级。任务协议不保留空技能列表，技能由已安装技能 Provider 独立发现。
