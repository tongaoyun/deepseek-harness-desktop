---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-product-expert-kit-instructions

[English](2026-10-13-product-expert-kit-instructions.md) | 中文

## Summary

通过带产品归属的普通用户消息记录固定的专家套件说明和快捷任务技能指令。

## Table of Contents

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-product-expert-kit-instructions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "58d07e6499911de16a7b93bc6b9d8487fe5a4f788d2438072e3a137af44deeda"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "73fa50c739eb21fca8ca14443699b72090e5bc6ae962fd4d277fffa44da97235"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "5cce146af6ebad4ca2cafc99ec1852cd323477bfd836fa3539596de9d3a86ab8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "f3116a318f37233d46978e253374f7964fba7742af47f6579b72f9770fa39096"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

已有记录继续可读。新来源类型和元数据仅标记生产者；未加载本插件时，未知来源仍保留消息正文。产品去重读取当前模型可见历史中的自身归属。必需的快捷任务选择和 Provider 配置由独立哈希产品快照校验；旧运行时快照 Schema 拒绝不支持的字段，不会改用默认能力执行。官方 Session 格式和执行语义保持不变。

<a id="verification"></a>
## Verification

真实 Loader 的 runtime-loader.spec.ts 记录验证首次直接 MCP 调用前已提供完整说明和所选技能、固定快照恢复、重启不重复注入、实时权限拒绝和凭据排除。expert-kit-readme.spec.ts 验证可见历史去重、上下文替换后恢复、错误 Provider 拒绝和插件释放。

<a id="dev-note"></a>
## Dev Note

无。
