---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-09-product-installed-skill-attribution

[English](2026-10-09-product-installed-skill-attribution.md) | 中文

## 概述

已安装的产品技能新增仅用于归因的消息来源。内容版本和不含凭据的连接器定义保留在持久化消息文本中，Session 格式保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-product-installed-skill-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "224e61636c90516cf9c9ec2136db7f6cc62d2252cdc52a6b1069a5e39dfd1d5f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "5ad4fca2c59fa0d91f2e09fc3745110761a81a1645915c9abb258fa1871eae20"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "45a57e10a22c4ec1d3f40362fcc23ac8f3ec8a09b0cd91806d53b778e65ed965"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "62e2b4be0b8a8645f7c274dda007cb54bdfb24db5b404fc4390241cbe06dbadb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

product-installed-skills 来源只标识生产者，不改变消息解释。未加载产品插件时，读取器仍保留消息文本。已有记录可以没有该来源，官方 Session 历史无需迁移。产品缓存的显式恢复独立于 Session 格式。

<a id="verification"></a>
## 验证

真实 Loader 组合及无密钥 capabilities-session 记录验证固定技能说明、连接器定义、检索输入、重启恢复和凭据排除。验证文件为 packages/deepseek-harness-product/runtime/tests/runtime-loader.spec.ts 和 `installed-skills.spec.ts`（记录时的技能归属回归，现由原生技能 Provider 接管）。

<a id="dev-note"></a>
## 开发备注

无。
