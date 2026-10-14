---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-product-expert-kit-instructions

## 概述

通过带产品归属的普通用户消息记录固定的专家套件说明和快捷任务技能指令。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-product-expert-kit-instructions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "71ce9a33cecea3f77cc29c03c7965b350912fcc65029503287e0c02b2239b235"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "cb06b76c4ceaa0b3a859c94d7d1256f7c6871049b9be2d84706eb9690274dc16"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "8e528afc7b6116c0e76fcf8a222aa8f9754c53e554d20633efa8632d412a77e2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-product-installed-skill-attribution"
    after: "fe9edd76dbfb375127cf708914d2b7043f2fb135d884b73b77a65d30153bd618"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录继续可读。新来源类型和元数据仅标记生产者；未加载本插件时，未知来源仍保留消息正文。产品去重读取当前模型可见历史中的自身归属。必需的快捷任务选择和 Provider 配置由独立哈希产品快照校验；旧运行时快照 Schema 拒绝不支持的字段，不会改用默认能力执行。官方 Session 格式和执行语义保持不变。

<a id="verification"></a>
## 验证

真实 Loader 的 runtime-loader.spec.ts 记录验证首次直接 MCP 调用前已提供完整说明和所选技能、固定快照恢复、重启不重复注入、实时权限拒绝和凭据排除。expert-kit-readme.spec.ts 验证可见历史去重、上下文替换后恢复、错误 Provider 拒绝和插件释放。

<a id="dev-note"></a>
## 开发备注

无。
