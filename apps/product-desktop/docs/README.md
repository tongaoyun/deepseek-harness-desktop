# 企业桌面项目总览

## 概述

企业桌面将官方 Harness 对话、执行模式、审批和文档预览，与预装社区专家和技能插件、钉钉身份、连接器及知识库结合。本页用于查找当前产品行为和对应文档。

产品自有文档只维护中文，规范文件名为 `README.md` 或对应的 `.md`。不再维护英文副本及翻译配对记录；官方上游文档随固定基线保留原有语言与校验规则。

## 目录

- [产品入口](#product-entry-points)
- [能力使用](#capabilities)
- [知识文件](#knowledge-files)
- [仓库与架构](#repositories-and-architecture)
- [开发与交付](#development-and-delivery)
- [公司专家与技能：仓库安装、AI 发布与桌面同步](company-content.md)
- [验收与限制](#verification-and-limitations)

<a id="product-entry-points"></a>
## 产品入口

员工使用产品桌面，通过钉钉登录。官方 Harness profile 是不加载企业扩展的独立装配。[产品桌面](../README.md)负责产品启动与打包，[桌面扩展](../../../packages/deepseek-harness-product/desktop/README.md)负责认证和设备凭据加密。

管理员使用由 `deepseek-harness-server` 提供的[网页控制中心](http://www.instudio.me:6206/traefik/deepseek-harness/)。使用桌面无需在本地启动控制中心。业务请求需要员工认证，管理操作还需服务端配置的权限。服务端连接说明由其 `docs/deployment.md` 维护。

<a id="capabilities"></a>
## 能力使用

左侧“扩展能力”中的“专家套件”“技能”在主内容区展示内建模块的管理页；不提供设置重复页、独立安装或独立更新。页面切换不修改当前对话或草稿。

“连接器”直接展示公司服务端目录及第三方账号连接配置，使用官方 MCP 客户端连接服务并提供工具。

| 能力 | 员工操作 | 任务行为 |
|---|---|---|
| 专家套件与技能 | 在“市场／我的”浏览和管理内建内容 | 使用官方 Agent、Skill Provider、工具与审批 |
| 连接器 | 通过表单或 MCP JSON 添加，所有者可修改或删除，独立管理第三方账号连接 | 公司连接器默认全员可见，配置完成且账号条件满足后供普通会话使用；READ 注解进入策略检查，WRITE 工具走官方审批，未声明工具拒绝 |
| 知识库 | 在能力下浏览个人、直属部门和公司知识库 | 从对话输入框选择检索范围，浏览文件不将知识库加入任务 |


<a id="knowledge-files"></a>
## 知识文件

知识库工作区包含目录树、文件列表和内嵌阅读器。管理者可创建多级文件夹、重命名、上传、移动资料及删除空目录；非空目录拒绝删除。点击知识库名称返回首页，左侧仅列真实文件夹；右侧“按文件夹 / 全部文件”切换直属资料与跨目录文件。文件名搜索提示当前范围，可一键清除筛选；文件菜单可定位所在目录。左侧加号创建顶层目录，子目录从文件夹菜单创建；新建和导入保留当前位置，位置未确认时提示检查全部文件，不盲目重复创建。

原件使用官方 Harness 预览组件，不依赖解析成功：PDF 显示页面，Excel 显示只读工作簿，Word 和 PowerPoint 通过官方 Office 转 PDF；也可下载或用系统应用打开。WeKnora 负责解析、索引、检索及来源片段，网页资料不一定有原件。协议与限制见[文件 UI](../../../packages/extensions/ui-deepseek-harness-product/README.md)。

服务端重新检查当前钉钉组织归属，不信任任务快照或客户端部门声明。只有本人、全部直属部门和配置公司授予范围，文件夹不增加权限。空任务范围不注册检索工具，失权和网络失败采用不同恢复方式。[产品子系统](../../../docs/subsystems/deepseek-harness-product.md)定义权限与检索规则。

<a id="repositories-and-architecture"></a>
## 仓库与架构

| 仓库 | 职责 |
|---|---|
| `deepseek-harness-desktop` | 官方 Harness 基线、登记的通用补丁、独立产品包、UI 和桌面交付 |
| `deepseek-harness-server` | 认证 API、网页控制中心、目录、个人资源、审核、组织权限和 WeKnora 适配 |
| `k3s-gitops` | 由 Fleet 同步的开发环境部署清单 |

连接器实现归属 `erp-mcp-gateway` 等业务服务，目录和授权归属服务端。交付流程不依赖独立连接器仓库或上游镜像仓库；桌面仓库保留固定 Harness 基线标签和登记补丁。产品包通过 Cordis 插件及 UI 插槽使用 Harness 公开出口。见[包地图](../../../packages/deepseek-harness-product/README.md)、[子系统说明](../../../docs/subsystems/deepseek-harness-product.md)和[补丁清单](../../../scripts/upstream-patches/manifest.json)。

<a id="development-and-delivery"></a>
## 开发与交付

企业开发使用产品启动入口，其 home 和 Electron profile 与官方桌面分开。[本地启动说明](../README.md#local-development)定义入口和 profile 覆盖方式。凭据留在 Electron 主进程或服务端受控配置，不放进渲染进程变量或提交文件。

Gitea 负责评审和 CI，GitHub 原生 runner 构建 Windows x64 与两种 Mac 架构，安装包发布到公开下载仓库及内网 Gitea。支持 `unsigned` 开发包、`internal` 免费内部更新和 `signed` 正式签名更新；具体区别见[构建入口](../README.md#native-updates)。[交付说明](delivery.md)维护流水线参数和恢复，[签名接入](signing.md)维护证书要求。公开构建仓库的源码及 Git 历史可公开读取。

Gitea 的共享 Runner 使用与上游 CI 一致的 `DSH_COVERAGE_TEST_TIMEOUT_MS=90000`，同时约束测试、清理钩子和轮询；不重试失败测试，也不改变应用运行超时。

服务端通过其 Gitea 流水线、Harbor、GitOps 和 Fleet 部署。构建成功、部署就绪和员工流程验收是独立结果。服务端 `docs/README.md` 索引 API、部署、领域和验收说明。涉及接口变更时先更新服务端，再更新依赖新接口的桌面。

<a id="verification-and-limitations"></a>
## 验收与限制

文档使用仓库的内容、链接和结构检查命令验证。行为证据包含定向产品回归、真实 Loader/profile 测试、无密钥模型 fixture、浏览器布局，以及构建后或安装后原生桌面验收。[测试说明](../../../docs/testing.zh.md)和[桌面验收说明](acceptance.md)定义执行的检查，服务端证据由其 `docs/knowledge-acceptance.md` 和 `docs/knowledge-stability.md` 维护。

模拟身份和模型可在不使用员工密钥的情况下验证请求、组合、UI 和恢复，但不能证明真实钉钉权限或模型推理效果。真实第二员工隔离仍需单独验收。OCR 和视觉模型不在当前范围内，产品编辑锁不保证与 WeKnora 直接并发修改互斥。当前不提供实时协同编辑或文件夹移动。启动时可回收无引用的有效快照和内容版本，保留 Session 引用及诊断记录；回收条件和失败保护见[运行时说明](../../../packages/deepseek-harness-product/runtime/README.md)。

## 开发期协议

产品快照只接受当前协议；格式错误的文件保留诊断并提示显式恢复，不降级执行。官方 Session 历史和草稿保留。具体恢复及快照规则见[运行时](../../../packages/deepseek-harness-product/runtime/README.md)。
