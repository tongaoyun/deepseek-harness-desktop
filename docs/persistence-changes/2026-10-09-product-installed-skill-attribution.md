---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-09-product-installed-skill-attribution

English | [中文](2026-10-09-product-installed-skill-attribution.zh.md)

## Summary

Installed product skills add an attribution-only message source. Content versions and credential-free connector definitions remain in the durable message text; the Session format remains unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The product-installed-skills source identifies its producer without changing message interpretation. Readers preserve the text when the product plugin is absent. Existing records omit this source, and official Session history requires no migration. Product caches use explicit recovery independently of the Session format.

<a id="verification"></a>
## Verification

The real Loader composition and keyless capabilities-session recording verify pinned Skill instructions, connector definitions, retrieval inputs, restart restoration, and credential exclusion. See packages/deepseek-harness-product/runtime/tests/runtime-loader.spec.ts and packages/deepseek-harness-product/runtime/tests/installed-skills.spec.ts.

<a id="dev-note"></a>
## Dev Note

None.
