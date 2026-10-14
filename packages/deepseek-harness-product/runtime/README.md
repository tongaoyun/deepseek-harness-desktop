---
kind: package-reference
description: "Prepare and restore immutable enterprise capabilities for official Harness tasks."
---

# Product Runtime

English | [中文](README.zh.md)

## Summary

Install enterprise Skills once for automatic discovery through the official Harness Skill Provider. Skills and Expert Kits supply connector dependencies; Knowledge is selected per task. Restart restores the pinned composition. Preparation verifies downloaded content. Employee credentials remain outside snapshots.

## Table of Contents

- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="composition"></a>
## Composition

`skills.install` verifies and installs content in an employee-scoped registry without creating a Preset or changing a Session. There is no per-skill enable or disable state. A per-agent Skill Provider contributes installed instructions to the official catalog when the task satisfies their connector, knowledge, and tool dependencies. Installation does not require those dependencies. `skills.installed.read` distinguishes installed content from task-visible content.

`skills.uninstall` atomically removes the employee's device installation record and invalidates live Skill Provider catalogs. Tasks that have not started no longer discover the skill. Started tasks keep their pinned catalogs and content, including after restart, with continuing server permission checks. Uninstall preserves server resources, immutable content, and Session history. Installation and uninstall share a serialized queue; disposal waits for in-flight operations. Reinstall restores discovery for subsequent tasks.

The first model-step boundary freezes the installed directory, versions, hashes, and connector tool definitions for that Session. Authorized connectors declared by available installed Skills mount through the official MCP client in that Agent's scope; unrelated authorized connectors do not mount. Installation does not change the task Preset. New installations affect tasks that have not started. Restart restores pinned instructions and connector definitions with fresh relay credentials. Listing and loading recheck server permissions and task dependencies. The official `skill` tool loads instructions on model request; user invocation uses `/<skillName>`.

Only the server's nonretryable `EXPERT_KIT_NOT_FOUND` response removes an inaccessible installed Skill from discovery. Transport failures, identity errors, malformed responses, and damaged local content stop preparation; they do not freeze an empty directory. The first boundary validates eligible content before saving the catalog, allowing the same task to retry after the underlying failure is resolved.

Expert Kits resolve directly to immutable Skill Provider and README Provider rows. Content preparation neither mounts nor persists an intermediate Preset. The runtime derives the selected base mode and registers one task execution snapshot, then checks required tools against that final composition. No `standard` Preset is required by the product runtime. Connector and knowledge plugins belong to the task composition.

`expertKits.install` validates packaged content and records an employee-scoped device installation without preparing a task. A new selection requires that installation and the same catalog version and SHA-256; preparation never writes installation records. `KIT_NOT_INSTALLED` requires installation, and `KIT_INSTALLED_VERSION_CHANGED` requires explicitly installing the current version. `expertKits.installed.read` returns `ProductInstalledExpertKits.installed`, the pinned content identities on this device. `expertKits.uninstall` atomically removes the employee's installation record and prevents new selections. Existing task snapshots, providers, and immutable content remain retained for execution, restart, and mode or knowledge changes without installation; server authorization still applies. Installation, selection content preparation, and uninstall share a serialized queue; disposal awaits in-flight work.

Restart registers retained task compositions during Host activation. Tasks without connectors do not query the connector directory for restore or preparation. Failed external restoration retains the valid snapshot and registers a blocked composition for history access. Explicit preparation retries current dependencies against the pinned content; a started task receives a new Session. An Agent already mounted on the blocked generation remains blocked even when that identity is registered successfully for a replacement. Required tools are checked before each model step, after Host services have settled; new preparation checks them immediately and withdraws a failed registration. Preparation of an already registered snapshot repeats dependency checks.

The exported `cordis.patch.yml` mounts this Loader plugin through its package-relative built entry, so the official Host needs no product dependency. Product desktop supplies its parent-process IPC provider. Task capability methods return the selected Preset and dependency checks; clients use official Session selection. The [product subsystem](../../../docs/subsystems/deepseek-harness-product.md) defines task transitions and permission behavior.

Task snapshots record `basePresetId`, pinned base plugin keys, required tools, and catalog display names. Mode changes replace only the base composition and revalidate dependencies; existing product content stays pinned. The selection resolver preserves these capabilities for every official Preset selection entry. Explicit selection accepts selectable modes even when `defaultable: false`; that flag only controls the saved default for future Sessions. Snapshots without base plugin metadata remain readable but require a new task before changing mode.

New execution definitions record `selectionBase` equal to `basePresetId`. Restore projects this display association from the snapshot's fixed `basePresetId` without changing stored content or hashes; missing base metadata or a conflicting association requires explicit recovery. Restore does not diagnose the target during Host activation: a subsequent read waits for the Loader to settle before marking an absent base unavailable. Official mode surfaces display that selectable base, while execution and Session logs retain the immutable task composition ID. Product UI supplies independent Kit and Knowledge controls without replacing the official mode component or controller.

`expertKitId: null` clears Kit providers and dependencies. Selecting or clearing a Kit preserves selected knowledge IDs; former required bases remain selected but become removable. Required connectors from the old Kit are replaced by the new Kit dependencies. `knowledgeBaseIds` submits the complete scope, including any required bases; an empty scope contributes no retrieval tool.

Task reads and preparation expose `requiredConnectorIds` from the pinned kit, including after restart. Connector authorization is managed in the directory, without a task selection control. Unavailable dependencies exclude installed Skills from discovery; authorization is checked before connector execution. READ, WRITE approval, and undeclared-tool policies apply to both Kit and installed-Skill connectors. Agent disposal and product plugin unloading release MCP registrations and connections.

Before execution and every Kit README or embedded Skill load, the runtime checks current server access by Kit ID. Published updates do not replace pinned content. Preparation checks the main-process desktop version, every declared packaged Skill, required tools, connectors, and knowledge. Failures include resource IDs and dependency results; `NOT_CHECKED` identifies checks not reached after a failure.

`expertKitTaskId` selects a shortcut from the installed kit manifest. Preparation returns its pinned `prompt` and records `{ id, name, skillIds }` as `expertKitTask` in the capability snapshot. Bindings must reference existing bundled skills. The README plugin enters the pinned guide and selected skill instructions through official pre-step messages before model execution, deduplicating current visible history. Model-driven skill discovery remains available for other skills. Mode and knowledge changes retain shortcut selection; clearing the kit removes it.

Snapshots use version 2 and pin `requiredKnowledgeBaseIds` after resolving required references once. `recoverCapabilities: true` exits the Kit and retains only knowledge IDs returned by a successful live directory query. A failed query preserves all selections. Corrupt or missing snapshots block only affected tasks; raw files and diagnostics are retained. A nonselectable Preset with a scoped execution blocker keeps history and drafts accessible while every model step is rejected. Explicit recovery creates a replacement composition. Failed registration or persistence rolls back.

Before publishing controls, startup collects content generations unreferenced by any employee installation or retained task and skill snapshots. Official Session headers, selection events and installed-skill publication events identify retained and required snapshots through public query APIs; a missing required snapshot, unavailable history, oversized record or invalid digest stops collection with a diagnostic. Valid snapshots unreferenced by any existing Session are collected, unless a task diagnostic accompanies them. Referenced snapshots and diagnostics remain unchanged. Only regular, checksum-marked generations are deleted; links, special files, unknown directories and damaged markers are preserved. Abandoned installation stages and snapshot temporary files are removed only in managed directories.

The public `withFileLock` helper serializes startup ownership and collection. Process ownership records persist until actual process exit, including after plugin unloading, to protect pending readers. Any live owner defers collection; the next sole Host startup removes records whose PIDs are absent and collects unused content. Ownership applies to processes on one host and PID namespace. An unreadable or malformed ownership directory blocks storage initialization rather than collecting uncertain content.

Creation conversations use the official Session and Agent loop without deriving a product execution Preset. `conversation-authoring` reads main-owned creation records at Agent creation and attaches `extension_draft`, `extension_catalog`, `extension_draft_update`, and `extension_save` only to the matching Session. When the requested content is complete, the model saves directly to the personal directory; successful skill saves install on this device. These tools cannot publish shared resources. Public catalog projection excludes connection secrets. Update results include the committed draft after resolving catalog skill content. Reads, updates and saves travel through official tool events; the scoped system section and schemas enter official request history. Unloading the product plugin removes the scoped tools even while an Agent remains alive, cancels requests and waits for them to settle. Restored Agents reconnect to the durable draft by Session ID and employee identity.

Selected knowledge registers `knowledge_search` and `knowledge_read`. Search accepts only query and count; reading accepts a cited fragment ID and rejects content outside the pinned base IDs. The server rechecks current access and indexing state. Empty task selection supplies neither retrieval tool. Search results retain document and fragment IDs for citation; returned content enters official tool results.

Both retrieval tools attach credential-free source identities as official `tool/result.meta`, retaining the library, document, fragment, filename and original locator for Client replay. `knowledge_read` returns the structured hit to programmatic callers; its model-facing JSON text remains unchanged. Opening a recorded source rechecks live access and does not add model input.

The product runtime also supplies `knowledge_destinations` and `knowledge_save` without changing task selection. Destination discovery exposes writable base names and ownership only. Saving a user-requested task result creates Markdown through official tool approval; rejection performs no write. Department and company destinations require an explicit user choice. A Session and call ID determine the retry key. Save results report asynchronous processing rather than retrieval readiness. Plugin unloading cancels requests and awaits their settlement.

Knowledge Office previews use the official `officeToPdf` service outside Session execution. The main process authorizes original metadata before queue admission; source bytes are fetched only after admission, with another permission and version check. Cache identities include the employee and document. Returning any PDF rechecks current permission and source version. Private input and output transfers use bounded 256 KiB JSON chunks; the result contains only a main-owned file descriptor. Cancellation and plugin disposal propagate through the converter and file requests, close input handles, and discard incomplete output handles. Official conversion limits and [desktop file policy](../desktop/README.md) both apply; credentials, server addresses, engine diagnostics, and private paths are excluded from results.

Stable `contentVersion` identifies the original used by conversion and caching. Indexing timestamp changes retain the same version; original replacement or Markdown edits invalidate it. Metadata without this version cannot be rendered.

<a id="model-experience"></a>
## Model Experience

### Task capabilities

#### What the model sees

Installed skill summaries enter the official catalog; their full instructions load through the official skill mechanism. Kit instructions and connectors enter the composed Preset; installed-Skill connectors register in the Agent scope. `knowledge_search` and `knowledge_read` use the immutable task scope; `knowledge_save` exposes writable destination metadata and requires official approval. The scoped system prompt records capability selections and content identities. Official Session events record installed catalog identities, credential-free connector definitions, loaded skill content, tool inputs, and results.

#### Token effect

Selected instructions, tool schemas, retrieval results, saved Markdown arguments, and creation drafts consume provider tokens. No employee credential is model-visible.

#### KV Cache effect

A new capability composition or creation conversation can change the request prefix. Existing tasks retain their recorded composition; creation draft updates are logged tool results.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Existing Session history and task diagnostics retain their pinned content. Valid orphan snapshots and unused generations are reclaimed only at a sole Host startup. Damaged records stop collection; PID reuse can conservatively postpone it. Legacy product caches are unsupported. Live service permission checks remain necessary for connector calls and retrieval.

<a id="dev-note"></a>
### Dev Note

All registrations, IPC listeners, and outstanding product requests follow Cordis disposal. Use public Harness package exports and typed Preset derivation. The real Loader tests cover scoped tools, unloading, and restart restoration.

[Large shortcut instruction regression](tests/kit-skills-loader.spec.ts) generates an authored kit, loads its long-description skill through the official filesystem provider, and checks complete instructions in the first model request and Session log. Restored execution retains that content without duplicate injection. The model adapter is deterministic; this verifies delivery and replay rather than a live model's reasoning.
