---
kind: package-reference
description: "产品桌面的内建专家套件模块。"
---

# 专家套件

## Summary

产品 profile 固定装配专家管理与原生委派。在“我的”管理个人 AgentSpec 包和专家团，在“市场”使用公司审核内容。格式、发布与同步说明见[公司内容](../../../apps/product-desktop/docs/company-content.md)。

## Table of Contents

- [内容与存储](#内容与存储)
- [API 与界面](#api-与界面)
- [执行](#执行)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## 内容与存储

专家保留 AgentSpec manifest、SOUL.md、可选 AGENTS.md、参考资料及二进制模板。说明作为字面量提示词交给原生 Subagent，并提供固定资源目录；不执行包内安装声明。个人文件按员工和摘要隔离，先写不可变版本，再通过官方 Settings 修订号原子切换引用。Settings 保存展示信息、启用状态和版本化 Team 文档。

公司内容由主进程校验索引与文件后安装，模块每次读取时解析公司内容服务，消费对应的固定版本目录。新会话固定资源摘要，子会话继承。团队成员引用精确专家版本，更新专家不替换既有团队成员。失效引用须重新选择。

## API 与界面

管理操作使用原生 Remote/Typert 生成契约。目录和团队通过原生外部存储订阅共享快照；读取失败显示错误，不伪装为空目录。关闭页面、切换来源或断开连接取消在途读取，迟到结果不能改变当前页面；原子写入开始后取消不能撤回已提交的 Settings 事务。

编辑器支持目录／ZIP 导入、完整 ZIP 导出、说明和附件编辑。并发冲突保留草稿，要求读取最新内容后确认。保存与删除接受权威回执，不用后续读取失败重复写入。团队启停和删除不依赖聊天输入；召唤时无法取得输入目标会显示错误。分类只影响展示，不改变包标识。

## 执行

单专家使用原生 Subagent `startActivation`。团队按当前会话能力选择原生 Agent Team 或普通子代理，实际选择记录在召唤结果中；主会话负责汇总。团队成员不能自行扩大团队，原生 `tools.guard` 在执行前拦截委派工具。单专家仍受宿主深度、权限和原生审批约束。

专家说明可以指导模型使用技能、MCP 与知识库，不新增资源绑定或权限引擎。知识库继续受员工授权和任务范围限制。

## Model Experience

### Expert delegation

#### What the model sees

模型通过原生 `list_experts`、`summon_expert` 查看专家目录并召唤专家。子代理接收字面量 `SOUL.md`、可选 `AGENTS.md` 和固定版本的资源根目录，按需使用原生文件工具读取资料；技能由原生 Skill Provider 加载。

#### Token effect

目录摘要、选中的专家说明、委派任务和实际读取的资料进入上下文；附件不会全量注入。

#### KV Cache effect

不单独管理模型缓存；请求与上下文组装沿用原生实现。

## Known Limitations and Deferred Work

- 公司团队只能引用已发布的公司专家。
- AgentSpec 只分发内容，不启动 Worker，也不执行安装声明或定时任务。
- 说明中的工具使用要求由模型理解，权限和写入审批由原生宿主执行。

### Dev Note

```sh
pnpm run build:product
pnpm --filter @deepseek-harness/product-experts typecheck
pnpm exec vitest run packages/deepseek-harness-product/experts
```

Host 与客户端随产品构建，不提供独立插件安装包。许可证与分发声明见 [LICENSE](LICENSE)、[NOTICE](NOTICE)。
