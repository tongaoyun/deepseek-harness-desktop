---
description: "Product protocol, authentication, catalogs, and server access independent of Harness and Electron."
kind: "package-library"
---

# DeepSeek Harness Product Bridge

English | [中文](README.zh.md)

## Summary

The bridge provides authenticated employee catalogs, task capability preparation, and connector authorization. It retains the last successful display catalog and merges refreshes; knowledge reads always query the server. Callers inject native capabilities and the task runtime. Skill and Kit installation operations address the authenticated employee's device through the Host; mutations emit catalog events after commit. Uninstall preserves server resources and started tasks. The desktop main process retains employee credentials; this protocol package does not depend on Harness or Electron.

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

Use namespace transport and validate requests against the product protocol allowlist. `tasks.capabilities.prepare` is the sole Kit preparation entry. It returns a capability snapshot, execution location, and verified dependencies; official Preset and Session APIs own execution.

Task capability reads and preparation results include `requiredConnectorIds`, resolved from the pinned Expert Kit. Consumers lock those task selections independently of account authorization or connector availability.

`extensions.import.inspect`, `extensions.save`, `extensions.submit`, and `extensions.delete` delegate personal authoring to main; responses contain previews or business results. `extensions.import.release` clears employee-scoped previews. The `extension-draft` export provides browser-safe form schemas; `authoring` parses YAML and generates standard skill/kit files and the dependency union in main. Ownership comes from server authentication. Catalogs expose `visibility`, `ownerEmployeeId`, `canEdit`, `canSubmit`, `canDelete`, and review status; personal usability is independent of shared review. Knowledge reference resolution distinguishes absent, denied, ambiguous, and transient failures.

Committed writes clear cached catalogs. A subsequent refresh failure does not fail the committed mutation; catalog reads report the refresh error rather than returning obsolete permissions.

`extensions.authoring.begin/read/update/save/discard` manage conversation drafts. The trusted Host may read, update and save the matching conversation's personal resource. Each draft is employee-scoped, Session-bound and revision-checked; it records only its own Session identity. `authoring.changed` publishes committed changes without their content. Content draft schemas exclude connector secrets and staging handles. Save validation accepts bundled skills and shortcut commands only for Expert Kits. Shared submission remains a separate owner action.

Bundled skill drafts retain the optional full native `description` separately from the 300-character catalog `summary`. The summary must equal the description or its whitespace-normalized projection: the first complete sentence when it fits, otherwise 299 UTF-16 units followed by an ellipsis. Bundled skill IDs and imported resource IDs accept two-character names. `extensionFiles` retains extra frontmatter from main-owned original Markdown and validates the complete emitted skill against the standalone 64 KiB or bundled 256 KiB UTF-8 limit.

`extensions.connector.read/update/delete` manage owned personal connectors through main. Reads return public configuration and empty placeholders for configured private keys. Updates create an immutable version; deletion retires the resource ID. The server verifies ownership for every operation.

Connector saves accept an integer `timeoutSeconds` from 1 through 600, defaulting to 60. It belongs to local MCP configuration and is excluded from conversation content drafts. Standard MCP JSON may provide the same field.

`knowledge.documents.*`, `knowledge.folders.*`, and `knowledge.sources.read` dispatch authenticated management and reading through the product server. Pages expose one-based `page` with `items`, `size`, and `total`; filtering and totals come from server pagination. Writes validate bounded content and stable retry keys. Folder creation sends a nullable stable `parentId`; folder responses retain the parent identity. Names are limited to 80 characters. Rename does not change a folder's parent or content location. Markdown updates require `expectedUpdatedAt`. File upload delegates selection to an injected native callback and rejects renderer paths and parser configuration. `pdfParseMode` accepts only `STANDARD` (default) or `TEXT` (PDF embedded text without OCR); the server owns engine selection. Responses retain asynchronous processing and deletion state. Caller cancellation and identity changes cancel remote operations. WeKnora addresses and credentials never cross this bridge.

`knowledge.documents.previewMetadata` reads original metadata independently of indexing. `preview.open`, `preview.read`, and `preview.close` use employee-bound main-owned file handles; Renderer receives bounded `Uint8Array` chunks instead of whole-file Base64. Requests accept resource IDs, an opaque transfer ID, or a verified byte offset. Office rendering uses the official Host converter with bounded private JSON chunks. `download` and `openExternal` accept only resource IDs and delegate native file operations to main. The binary HTTP transport refuses redirects, streams into an owned sink, and preserves structured permission errors. Indexed citation fragments continue through `knowledge.sources.read`; opening an original creates no Session or retrieval input. [Desktop configuration](../desktop/README.md) defines product limits and temporary-file ownership.
