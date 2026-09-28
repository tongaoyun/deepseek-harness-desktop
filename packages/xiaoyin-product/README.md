---
description: "Xiaoyin product packages layered on public DeepSeek Harness extension points."
kind: "package-group"
---

# Xiaoyin Product Packages

English | [中文](README.zh.md)

## Summary

This group connects Xiaoyin enterprise services to public Harness extension points. Official Harness packages continue to own execution, Sessions, Conversation, tools, approvals, Browser, Office, and persistence.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`product`](product/README.md) | Server client, DingTalk session adapter, capability snapshot, and restricted Electron bridge |

<a id="related-documentation"></a>
## Related documentation

The [Xiaoyin product subsystem](../../docs/subsystems/xiaoyin-product.md) defines the product responsibilities and integration points.

<a id="dev-note"></a>
## Dev Note

Product packages may depend only on public Harness APIs and do not replace or patch the Harness runtime.
