---
description: "Electron main-process bridge for DeepSeek Harness authentication and enterprise product APIs."
kind: "package-reference"
---

# DeepSeek Harness Product Bridge

English | [中文](README.zh.md)

## Summary

The bridge keeps DingTalk session tokens and authenticated bootstrap access in the Electron main process while exposing typed product and native methods to the Renderer. Runtime bootstrap secrets are passed only to the official Harness Host and are not bridge methods. No companion is published because its typed bridge and server API cannot diverge independently.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Product bridge

#### What the model sees

The bridge serves product metadata and authentication. The main process injects the employee-scoped inference configuration before Host startup; official `Session` execution and conversation behavior remain model-facing authority.

#### Token effect

No product token is added to model context.

#### KV Cache effect

No cache entries are created; the bridge does not assemble or send provider requests. <a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- Installed applications read the DeepSeek Harness server origin from the packaged `deepseek-harness/product.json`; unpackaged development may override it with `DEEPSEEK_HARNESS_SERVER_URL`.
- Native methods fail closed when the supervised sidecar is unavailable.

<a id="dev-note"></a>
### Dev Note

Keep runtime bootstrap secrets and session tokens in the Electron main process. Renderer code can invoke the product and native methods declared by the preload allowlist.
