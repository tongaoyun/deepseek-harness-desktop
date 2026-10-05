---
description: "Official Harness sidebar navigation for DeepSeek Harness product capabilities."
kind: "package-reference"
---

# DeepSeek Harness Product Capabilities

English | [中文](README.zh.md)

This package publishes DeepSeek Harness product navigation in the official Harness sidebar. No companion is published because every product operation is dispatched through the Electron preload allowlist and the `deepseek-harness.native.v1` sidecar.

## Summary

The capability panels expose product-owned catalogs without reimplementing Harness conversation or task state.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable this extension in the official Electron desktop composition to expose the Capabilities group and its Expert Kits, Skills, Connectors, and Knowledge entries in the official sidebar. Product requests remain behind the preload allowlist and are handled by the main-process product bridge; the Renderer never receives session credentials or direct sidecar access.

Each directory provides local search over the complete server-backed catalog. Expert Kits and Skills are grouped by category, Connectors by their declared category, and Knowledge bases by their declared scope. Connector rows show only availability, authentication, and tool count; scope, transport, version, raw tool names, and permissions remain in the detail drawer. Knowledge details show scope and update time. The UI does not infer marketplace, installation, or category state that the server did not return.

Open an Expert Kit and select **Start using** to create a new official Session bound to that kit's immutable Agent Preset. The Preset contains the kit README, Skills, connectors, and knowledge references; other Sessions do not inherit them. A Common task creates the same kind of Session and pre-fills its business prompt without sending it. Common tasks do not display slash prefixes or technical Skill IDs. Open a standalone Skill and select **Use skill** to pre-fill Harness's native `/<skillId>` command in the current official Session; when no Session is open, the extension creates an ordinary Session. Existing composer text is preserved.

<a id="model-experience"></a>
## Model Experience

### Product navigation

#### What the model sees

The extension adds no `ToolDefinition`, prompt section, or other model-facing behavior; it only renders capability navigation and catalog panels.

#### Token effect

No provider tokens are added.

#### KV Cache effect

No cache entries are created; the extension only renders product settings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The capability panels require the Electron product bridge and a reachable DeepSeek Harness server.
- It does not provide an offline catalog or a second execution path.

### Dev Note

<a id="dev-note"></a>

Build the extension with the repository's standard package build. Keep product API calls in `packages/deepseek-harness-product/product` and keep this package limited to official Sidebar/Main slot registration and presentation.
