# DeepSeek Harness 产品层

产品层通过公开扩展点接入企业身份、公司内容、连接器和知识库；对话、执行、审批及持久化由 Harness 提供。员工入口见[项目总览](../../apps/product-desktop/docs/README.md)。

## 模块职责

| 模块 | 负责内容 |
| --- | --- |
| [产品协议](../../packages/deepseek-harness-product/product/README.md) | 钉钉会话、目录与服务端请求校验 |
| [桌面](../../packages/deepseek-harness-product/desktop/README.md) | 凭据隔离、原生文件、设备上报和 Host 启动准备 |
| [运行时](../../packages/deepseek-harness-product/runtime/README.md) | MCP 工具发现、审批策略、任务知识库和内容版本绑定 |
| [产品 UI](../../packages/extensions/ui-deepseek-harness-product/README.md) | 扩展页面、文件工作区、任务选择与反馈 |
| [专家](../../packages/deepseek-harness-product/experts/README.md)与[技能](../../packages/deepseek-harness-product/skills/README.md) | 原生 Agent、Agent Team、Settings 与 Skill Provider 的产品入口 |

## 身份与权限

员工令牌留在主进程，连接器 OAuth 凭据留在服务端。连接器工具按版本和定义绑定，执行时重新检查访问资格；READ 通过策略，WRITE 请求官方审批，未声明工具拒绝。

知识库按 `PERSONAL`、`DEPARTMENT`、`COMPANY` 授权。服务端通过 org-directory 将已认证的 unionId 或 userid 精确映射到在职员工，授予本人、全部直属部门及配置公司的范围；不按姓名、openId 或任务中的旧部门声明授权。目录快照默认有效 26 小时，超期或组织服务故障拒绝访问。部署配置由服务端 `docs/deployment.md` 维护。

阅读和管理分离：个人所有者、固定管理者及配置的管理员可管理相应内容，部门成员身份只授予阅读权。普通员工只能创建个人库，共享库由管理员创建或绑定；未绑定库不可检索，文件夹不增加权限。

## 任务与知识文件

任务在 `product-knowledge-tasks-v1` 固定执行模式、知识库 ID 和官方派生定义。只有选择了知识库才注册 `knowledge_search` 与 `knowledge_read`，查询和来源读取不能超出固定 ID；服务端实时权限仍优先于任务快照。

公司内容按 Session 固定版本与哈希，子会话继承父会话。绑定或内容损坏时保留 Session、草稿与诊断并阻止执行，用户可显式恢复为新任务；不能用当前市场内容替换已绑定版本。结果保存需单独请求，不会把保存目标加入检索范围。

产品元数据管理文件夹与归属，WeKnora 管理原文、解析和索引。产品提供文档分页、文件上传、Markdown 编辑及网页导入；位置不明或写入结果未知时禁止盲目重发。产品内版本锁不能约束 WeKnora 后台的直接并发编辑。

原件查看使用官方预览 Factory，不创建 Session，也不依赖索引就绪。主进程暂存并发送有界块，Office 使用官方转换；传输检查权限和稳定的 `contentVersion`，预览、上传与下载同时受服务端及桌面限制。下载和系统打开不暴露本地路径或上游凭据，未保存原件的网页不能以索引片段冒充原件。

## 桌面与上游集成

官方壳提供可信启动、profile overlay、命名空间 IPC、来源检查及清理。产品校验方法白名单和结构化响应，保留错误码、关联资源及可重试性。取消贯穿 Renderer、主进程、Host 和远端请求，插件释放等待在途操作及资源清理。

产品使用公开 API，包括保留 Loader 解析上下文的 `agentPresets.derive`。固定版本见 [UPSTREAM_TAG](../../UPSTREAM_TAG)，改动清单见[上游补丁](../../scripts/upstream-patches/manifest.json)；`verify:upstream` 校验基线、登记差异及依赖方向。产品 profile 使用钉钉身份，官方 profile 可独立运行。
