---
kind: upgrade-guide
description: "移除自建专家套件和技能，改用预装原生生态插件。"
---

# 原生专家与技能

## 变更

自建专家套件、技能的目录、创作、导入、制品、安装和审核接口删除。产品桌面预装 Agency Agents 和 Skills Manager，技能由官方 Skill Provider 发现并按需加载。企业连接器、知识库及官方会话历史保留。

任务知识库快照只保存官方派生定义及知识库 ID。旧自建套件组合不能继续执行，不提供产品缓存转换，也不静默换成默认模式。

## 迁移

1. 先部署服务端并执行 `V64__retire_product_content.sql`，安装新版桌面；机器发布配置改为 `deepseek-harness.connectors.publisher-token`。
2. 在预装插件的官方设置入口管理专家和技能。企业连接器仍在左侧连接器入口配置，知识库仍从对话入口选择。
3. 旧套件任务可查看历史和保留草稿；显式恢复为新任务，或新建对话后确认知识库范围再发送。
4. 验证插件加载、原生技能按需读取、连接器审批和知识库范围。完整产品说明见[破坏性变更](../../../../apps/product-desktop/docs/breaking-changes.md)。
