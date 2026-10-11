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
## Compatibility

The product-installed-skills source identifies its producer without changing message interpretation. Readers preserve the text when the product plugin is absent. Existing records omit this source, and official Session history requires no migration. Product caches use explicit recovery independently of the Session format.

<a id="verification"></a>
## Verification

The real Loader composition and keyless capabilities-session recording verify pinned Skill instructions, connector definitions, retrieval inputs, restart restoration, and credential exclusion. See packages/deepseek-harness-product/runtime/tests/runtime-loader.spec.ts and packages/deepseek-harness-product/runtime/tests/installed-skills.spec.ts.

<a id="dev-note"></a>
## Dev Note

None.
