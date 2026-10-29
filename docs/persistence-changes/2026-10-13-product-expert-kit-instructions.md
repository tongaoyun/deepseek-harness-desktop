---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-product-expert-kit-instructions

English | [中文](2026-10-13-product-expert-kit-instructions.zh.md)

## Summary

Ordinary user messages with product attribution record pinned expert-kit instructions and shortcut task skill instructions.

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

Existing records remain readable. The new source kind and metadata identify only the producer; an unknown source preserves the message body when this plugin is absent. Product deduplication reads its own attribution in the current model-visible history. A separately hashed product snapshot validates required shortcut selections and Provider configuration. Older runtime snapshot schemas reject unsupported fields instead of executing with default capabilities. The official Session format and execution semantics remain unchanged.

<a id="verification"></a>
## Verification

The real Loader tests in runtime-loader.spec.ts verify complete instructions and selected skills before the first direct MCP call, pinned snapshot restoration, restart deduplication, live permission denial and credential exclusion. The expert-kit-readme.spec.ts tests verify deduplication against visible history, restoration after context replacement, rejection of the wrong Provider and plugin disposal.

<a id="dev-note"></a>
## Dev Note

None.
