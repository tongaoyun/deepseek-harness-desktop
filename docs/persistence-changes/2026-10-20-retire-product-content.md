---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-retire-product-content

English | [中文](2026-10-20-retire-product-content.zh.md)

## Summary

删除自建技能与专家套件的消息来源声明，使用原生技能 Provider。

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-retire-product-content
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-product-expert-kit-instructions"
    after: "0755b7d1128319ba2e389619cbbf2c961ad648882b4e91da7f3e9582cc8a2034"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-product-expert-kit-instructions"
    after: "97e0162f983c27456ec71269fb4976b1851588b8c1aeac5d071d43e11f95e03c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-product-expert-kit-instructions"
    after: "79a4c87f8bfb4d6d05cd9952b99210d6a7db3b478c4a01d94b4c50602308c056"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-product-expert-kit-instructions"
    after: "2ae8594a998c9862a597129e782277bcc518266712a703b5c3161bdf552d13b8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

移除仅用于归属标记的 product-installed-skills 和产品创作来源，不改变已持久化消息的正文、角色或工具结果。现有读取器保留未知来源的消息正文；新读取器同样保留旧日志正文，但不再产生这些来源或恢复已移除的产品组合。来源判别信息防止将旧配置解释为新知识库任务；旧产品任务明确阻止执行并要求显式恢复，不删除官方 Session 历史。旧读取器可以读取新记录中的官方来源；不要求回退产品运行时。会话格式版本保持不变，不增加旧协议或缓存兼容层。

<a id="verification"></a>
## Verification

真实 Loader 回归验证原生 skill 按需加载、连接器审批、知识库固定范围、重启恢复及卸载；blocked-task-loader 和 tasks 回归覆盖坏快照与旧组合禁止静默执行。原生模型可见快照已生成。

<a id="dev-note"></a>
## Dev Note

None.
