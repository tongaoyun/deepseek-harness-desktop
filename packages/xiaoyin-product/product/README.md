---
description: "Electron main-process bridge for Xiaoyin authentication and enterprise product APIs."
kind: "package-reference"
---

# Xiaoyin Product Bridge

English | [中文](README.zh.md)

## Summary

The bridge keeps DingTalk credentials and product API access in the Electron main process while exposing a narrow typed interface to the Renderer. No companion is published because its typed bridge and server API cannot diverge independently.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Model Experience

### Product bridge

#### What the model sees

The bridge serves product metadata and authentication; official `Session` execution and conversation behavior remain model-facing authority.

#### Token effect

No provider tokens are added.

#### KV Cache effect

No cache entries are created; the bridge does not assemble or send provider requests.

## Known Limitations and Deferred Work

- Installed applications read the Xiaoyin server origin from the packaged `xiaoyin/product.json`; unpackaged development may override it with `XIAOYIN_SERVER_URL`.
- Native methods fail closed when the supervised sidecar is unavailable.

<a id="dev-note"></a>
### Dev Note

Keep product configuration, credentials, and native dispatch in the Electron main process. Renderer code uses only the preload allowlist.
