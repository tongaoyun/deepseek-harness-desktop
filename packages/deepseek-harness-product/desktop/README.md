---
kind: package-library
description: "Authenticate product desktop users and manage credentials, native operations, and product resources."
---

# Product Desktop

English | [中文](README.zh.md)

## Summary

Sign in with DingTalk before opening the enterprise workspace. Employee tokens use OS-encrypted storage in Electron main. Product requests and the native sidecar are managed by a trusted desktop extension.

## Table of Contents

- [Assembly](#assembly)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="assembly"></a>
## Assembly

`createExtension` supplies startup preparation, product dispatch, events, and shutdown hooks to the official shell. The product assembly owns `desktop-extension.json`, `assembly.json`, server resources, and the native binary. The official profile loads no product extension by default. See the [product subsystem](../../../docs/subsystems/deepseek-harness-product.md).

The desktop bundle keeps `electron` external so the running Electron process supplies its main-process API.

`ExtensionAuthoring` owns native directory, ZIP, or standalone `SKILL.md` selection, bounded inspection, employee-scoped staging, immutable archive upload and activation. It never returns selected paths or upload credentials. Invalid paths, links, duplicate files, oversized content, and checksum mismatches fail before activation. Standalone Markdown is limited to 64 KiB; adjacent resources require directory import. Imported resources survive edits; copied catalog skills use the selected version download. Cancel or shutdown releases staging; upload work directories are always removed. A successful personal skill save installs through the official Host skill provider without preparing a task.

`extensions.delete` forwards Skill or Kit ID and version to authenticated server retirement. Employee ownership and shared-version protection are enforced on the server. Local immutable content, task snapshots, and official Session history are retained; later execution still requires server access. Connector retirement uses `PersonalConnectors` and clears its device configuration only after server deletion succeeds.

`AuthoringSessions` stores atomic employee-scoped drafts and original resources under `extension-conversations-v1` in desktop user data. Creation records bind to preallocated official Session IDs before Agent creation and store only that Session identity. Model updates resolve catalog skill content and dependencies by immutable coordinate before committing the draft. Updates and saves serialize on a revision; stale requests fail without replacing newer content. The Host allowlist grants read, update and personal save for the matching Session; shared submission remains separate. Completed saves freeze the version. Failed saves and desktop restart retain drafts and resources; corrupt records retain raw bytes and fail only their own reads. Drafts are limited to 2 MiB and package resources to the import limits. Unsaved conversation drafts remain local to this device.

`PersonalConnectors` discovers MCP tools, encrypts private headers and environment with OS storage, and relays stdio through loopback HTTP. Only actual non-destructive read-only annotations permit READ; other declared tools use official approval. Undeclared tools are refused. Public configuration goes to the server, private configuration stays employee-scoped on the device. Account changes and shutdown close owned SDK connections and children. Employee tokens only reach the product server's exact managed MCP route; configured OAuth uses the existing server provider.

Owner editing reads public fields with empty placeholders for local private keys. A blank value retains the existing secret only when transport, endpoint, command and arguments are unchanged; a changed destination requires new private values. Saving discovers tools and creates a new version. Deletion retires all server versions, closes cached connections and removes the current device configuration. Failed updates preserve the previous configuration.

Main supplies `runtime.environment.desktopVersion` from Electron; Renderer cannot override it. Caller cancellation combines with the extension lifetime signal for Host, HTTP, and native requests. Shutdown stops background refreshes, cancels pending operations, waits for settlement, and confirms sidecar exit. Credential-free product diagnostics retain error codes, resource IDs, retryability, and dependency results.

Knowledge uploads use the main-process native file picker and retain the selected folder. Standard upload preserves server document processing. Text PDF upload uses a PDF-only picker and requests embedded text extraction without OCR; non-PDF selections are rejected. Main opens one regular file without following symbolic links and uploads bytes, the finite `pdfParseMode`, and the selected folder to the authenticated product server. The upload cap is the smaller of the live server limit and main-owned `knowledgeFiles.uploadMaxBytes`. Cancelling the picker returns a cancellation result without a write. Request cancellation settles native picker and save-dialog waits promptly; late choices are discarded. Local paths and WeKnora credentials are never returned to Renderer or Host; open file handles close on failure or cancellation.

Original preview downloads stream into random private directories with 0700 directories and 0600 files. Opaque handles bind the employee, knowledge base, document and content version. Each chunk rechecks current permission and version; cancellation, identity changes, expiry and shutdown remove private files. Startup removes abandoned owned transfers without following symbolic links. Renderer receives 256 KiB `Uint8Array` chunks; Host conversion uses bounded JSON chunks. Original downloads use the native save dialog. Manual documents export with a Markdown suffix; private filenames fit the UTF-8 byte budget while retaining ordinary extensions. System opening permits document and image formats and retains a private file until its transfer expires or the application closes.

Original metadata must provide a stable `contentVersion`. Indexing status and its `updatedAt` do not change this identity; replacement originals and edited Markdown do. Missing content identity fails closed. Office conversion and its cache use the same version.

The packaged `product.json` accepts a `knowledgeFiles` object. Defaults are `previewMaxBytes` 32 MiB, `spreadsheetMaxBytes` 16 MiB, `officeInputMaxBytes` 50 MiB, `officeOutputMaxBytes` 100 MiB, `downloadMaxBytes` 250 MiB, `uploadMaxBytes` 50 MiB, `transferLifetimeMs` 15 minutes, `fileRequestTimeoutMs` 5 minutes, and `maxTransfers` 8. Values must be positive bounded integers; byte limits combine with the live server limit, while official renderers retain their own protections. Renderer cannot override this configuration.

Startup writes a credential-free model overlay from the server bootstrap's exact model IDs. DeepSeek models use the official DeepSeek adapter; other models use the official pi-ai adapter's OpenAI-compatible gateway route. The product profile omits the public account route. A valid saved default is retained; an unavailable default is replaced with the server's first model before task creation. Existing Session model selections remain explicit and can be changed through the official model selector.

Local MCP configuration stores `timeoutSeconds` with encrypted device settings, from 1 through 600, defaulting to 60. Connection, complete paginated discovery, and tool calls honor this deadline and caller cancellation. Host receives the credential-free timeout and applies it through the official MCP client. Creating a connector allows two operation deadlines plus server-save time in the generic desktop transport; Host catalog requests allow the maximum connection and discovery deadlines. Configured OAuth retains the default timeout.

<a id="model-experience"></a>
## Model Experience

### Product desktop

#### What the model sees

Main supplies inference configuration to Host through `prepareHost`. Its loopback MCP relay replaces upstream credentials with a private relay capability and checks connector availability on each request. Employee tokens remain in main; Renderer receives no employee token or runtime bootstrap secret.

#### Token effect

Authentication and native operations add no provider tokens.

#### KV Cache effect

This package does not assemble provider requests or cache entries.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Live DingTalk login needs a reachable product service. Packaging and native binaries require the target platform toolchain; signing and deployment are separate operations.

<a id="dev-note"></a>
### Dev Note

Shutdown cancels authentication polling, disposes product refreshes, and stops the sidecar. Method allowlists belong to the product protocol; preload transports namespaced requests and the shell validates their sender. After building and preparing the local macOS runtime, run `DSH_DESKTOP_SMOKE=1 DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/deepseek-harness-catalog.e2e.ts` to verify both Electron profiles against an isolated product fixture.
