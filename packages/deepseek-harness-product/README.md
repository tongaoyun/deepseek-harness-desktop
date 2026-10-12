---
description: "DeepSeek Harness product packages layered on public DeepSeek Harness extension points."
kind: "package-group"
---

# DeepSeek Harness Product Packages

English | [中文](README.zh.md)

## Summary

This group connects DeepSeek Harness enterprise services to public Harness extension points. Official Harness packages continue to own execution, Sessions, Conversation, tools, approvals, Browser, Office, and persistence.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`expert-kit-readme`](expert-kit-readme/README.md) | Preset-scoped, model-only loading of Expert Kit README instructions |
| [`product`](product/README.md) | Server client, DingTalk session adapter, capability snapshot, and Electron bridge |
| [`runtime`](runtime/README.md) | Cordis task composition, content snapshots, and permission policy |
| [`desktop`](desktop/README.md) | Main-process authentication, credentials, sidecar, and product packaging resources |

<a id="related-documentation"></a>
## Related documentation

Start with the [enterprise desktop overview](../../apps/product-desktop/docs/README.md) for product workflows and repository responsibilities. The [DeepSeek Harness product subsystem](../../docs/subsystems/deepseek-harness-product.md) defines integration points, and the [desktop assembly](../../apps/product-desktop/README.md) owns local launch and delivery.

<a id="dev-note"></a>
## Dev Note

Product packages may depend only on public Harness APIs and do not replace or patch the Harness runtime.
