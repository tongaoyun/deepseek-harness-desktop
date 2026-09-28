---
description: "Electron sidebar contribution for Xiaoyin product catalogs and account-scoped product navigation."
kind: "package-reference"
---

# Xiaoyin Product Sidebar

English | [中文](README.zh.md)

This package publishes the Xiaoyin product sidebar contribution. No companion is published because every product operation is dispatched through the Electron preload allowlist and the `xiaoyin.native.v1` sidecar.

## Summary

The sidebar exposes product-owned catalogs without reimplementing Harness conversation or task state.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable this extension in the official Electron desktop composition to expose Expert Kits, Skills, Connectors, Knowledge, Schedules, and IM navigation. Product requests remain behind the preload allowlist and are handled by the main-process product bridge; the Renderer never receives session credentials or direct sidecar access.

<a id="model-experience"></a>
## Model Experience

### Product navigation

#### What the model sees

The extension adds no `ToolDefinition`, prompt section, or other model-facing behavior; it only renders browser navigation.

#### Token effect

No provider tokens are added.

#### KV Cache effect

No cache entries are created; the extension only renders product navigation. <a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- The sidebar requires the Electron product bridge and a reachable Xiaoyin server.
- It does not provide an offline catalog or a second execution path.

<a id="dev-note"></a>
### Dev Note

Build the extension with the repository's standard package build. Keep product API calls in `packages/xiaoyin-product/product` and keep this package limited to official Sidebar slot registration and presentation.
