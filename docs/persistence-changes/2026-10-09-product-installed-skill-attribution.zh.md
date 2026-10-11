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
    previous: "2026-10-05-working-directory-attribution"
    after: "d5c1cc228b926ba21e6fb7230cb5da5e2086e0730d80195b8751c00d17110d12"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "81786891009889381850dd6f8b0d23a2451b62a95064adffad9b7afec8bbcc50"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "80ee1022d1c5d532a6628de63e527a2aa8a09b58024c8ecb76088c753a92404d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "d5bcf9c01e88ae180d60abecb1cb5a3a2d466ec6d3af298c4e86d705f1171816"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

product-installed-skills 来源只标识生产者，不改变消息解释。未加载产品插件时，读取器仍保留消息文本。已有记录可以没有该来源，官方 Session 历史无需迁移。产品缓存的显式恢复独立于 Session 格式。

<a id="verification"></a>
## 验证

真实 Loader 组合及无密钥 capabilities-session 记录验证固定技能说明、连接器定义、检索输入、重启恢复和凭据排除。验证文件为 packages/deepseek-harness-product/runtime/tests/runtime-loader.spec.ts 和 packages/deepseek-harness-product/runtime/tests/installed-skills.spec.ts。

<a id="dev-note"></a>
## 开发备注

无。
