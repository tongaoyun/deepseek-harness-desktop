---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-product-expert-kit-instructions

English | [中文](2026-10-13-product-expert-kit-instructions.zh.md)

## Summary

Records pinned Expert Kit guide and shortcut skill instructions as ordinary user messages with product attribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain readable. The new source kind and metadata identify the producer only; unknown sources preserve the message text without this plugin. Product duplicate suppression reads its own attribution from the current model-visible history. Required shortcut selection and provider settings are enforced by separate hashed product task snapshots; older runtime snapshot schemas refuse unsupported fields rather than execute default capabilities. Official Session format and execution meanings remain unchanged.

<a id="verification"></a>
## Verification

The real Loader runtime-loader.spec.ts recording verifies full guide and selected skill content before the first direct MCP call, pinned snapshot restoration, no duplicate injection after restart, live authorization denial and credential exclusion. expert-kit-readme.spec.ts verifies visible-history deduplication, restoration after surface replacement, wrong-provider denial and disposal.

<a id="dev-note"></a>
## Dev Note

None.
