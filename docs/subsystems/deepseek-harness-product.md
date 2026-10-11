# DeepSeek Harness product

English | [中文](deepseek-harness-product.zh.md)

Enterprise catalogs extend the official Harness Session, execution loop, approvals, and conversation UI. Product packages own authentication, downloads, capability selection, connector policy, and scoped knowledge retrieval.

## Packages

| Package | Responsibility |
|---|---|
| `@deepseek-harness/product` | Protocol, authentication, catalogs, and server requests; no Harness or Electron dependency |
| `@deepseek-harness/product-runtime` | Cordis Loader plugin for content verification, composition, snapshots, connector policy, and knowledge tools |
| `@deepseek-harness/product-desktop` | DingTalk login, encrypted credentials, product dispatch, sidecar lifecycle, and packaging resources |
| `@deepseek-harness/product-ui` | Four catalog views through official Sidebar/Main slots; one Session/Workspace/Preset/draft adapter |

## Task capabilities

Expert Kits contribute provider rows from content-addressed installed files; preparation creates no standalone Skill or Kit Preset. Only the complete task composition is registered and persisted. The selected mode supplies base tools, and dependency checks inspect the resulting task tool catalog. The runtime requires the profile's configured base mode without depending on a `standard` definition.

Kit device installations use `expertKits.install`, `expertKits.installed.read`, and `expertKits.uninstall`. `ProductInstalledExpertKits.installed` returns employee-scoped content identities. Installing alone creates no Preset or task. Uninstall removes only the device record, preserving server resources, immutable content, and existing task compositions. The [runtime contract](../../packages/deepseek-harness-product/runtime/README.md) defines persistence and lifecycle behavior.

`tasks.capabilities.read` returns the current task selection. `tasks.capabilities.prepare` accepts an Expert Kit, connector IDs, and knowledge-base IDs, returning the execution location, immutable Preset ID, effective capability snapshot, and dependency checks. A kit supplies the initial composition. Additional capabilities retain existing selections; required dependencies cannot be disabled. Connector authorization and task enablement are separate operations.

Both task responses expose `requiredConnectorIds` resolved from the pinned kit. Skills and Expert Kits supply connector dependencies; the product UI offers no independent connector task selection. The connector directory manages authorization with **All** and **Connected** views; search and category grouping apply in both views. See the [UI contract](../../packages/extensions/ui-deepseek-harness-product/README.md).

`skills.install` verifies content and records an employee-scoped installation without modifying tasks or Presets. Skills have no enable or disable state. `skills.installed.read` returns installed identities and the subset visible to a task. `skills.uninstall` removes the device record, excluding the skill from unstarted tasks while retaining started tasks' pinned content and server resources. The per-agent official Skill Provider discovers installed skills with satisfied dependencies, mounting their declared authorized connectors through the official MCP client. The first model-step boundary freezes content and connector definitions; a logged catalog message records them without credentials. Loaded instructions use official skill events. Restart restores pinned content and fresh relay credentials; reads, loads, and connector execution recheck permissions. See the [runtime contract](../../packages/deepseek-harness-product/runtime/README.md).

`basePresetId` selects the execution mode independently of product capabilities. Preparation preserves pinned product plugins while replacing the base plugin set and checking required tools. The runtime handles the generic `agent-preset/resolve-selection` waterfall so official selection entries retain task capabilities. The official Preset UI shows the base mode of a composed snapshot and becomes read-only after a task starts. `expertKitId: null` clears the Kit composition; selecting or clearing a Kit retains selected knowledge IDs. The independent Kit selector uses public conversation slots without replacing the official mode controls. Knowledge selection uses a separate staged multi-selector. Catalog details do not modify task selection. Expert Kit README previews have a full Markdown reader; command tables do not declare executable commands.

An empty task selects the derived Preset directly. Once a turn starts, the client creates a new official Session in the same Workspace and carries the latest composer draft into it. The official Preset selection guard handles concurrent starts. Preparation failure leaves the current task and draft intact. Installed Skills use the official `skill` tool and plain-text `/<skillName>` invocation; installation leaves the current task and draft intact.

Configuration actions capture an explicit Session ID before entering the queue. Completion updates that Session and preserves the current view when the user has navigated elsewhere. Recovery is one preparation request: exit the Kit, remove revoked knowledge IDs, and retain available IDs. Network failure does not establish revocation. Invalid snapshots expose an unavailable diagnostic and require explicit recovery; affected history remains readable.

Snapshots pin content identities, plugin configuration, connector tool contracts, and capability selection. Upstream credentials remain in main; restart reconnects through its private MCP relay. The scoped system prompt records capability selections and content identities. The official `agent-preset/selected` event records the hash-addressed snapshot ID; normal skill and tool events retain model-visible content, retrieval queries, and results. Catalog refresh only affects later selections. Task snapshots and their content are retained; automatic task snapshot garbage collection is deferred.

## Permissions and retrieval

Declared READ connector tools continue through Harness policy; WRITE tools request official approval. Undeclared connector tools are denied. The service remains responsible for live permission checks and revocation. Employee tokens stay in main, and upstream connector OAuth credentials stay on the server.

Knowledge selection belongs to the task snapshot. Search accepts only a query and result count; cited fragment reading accepts a source ID. A selected composition registers `knowledge_search` and `knowledge_read`; an empty selection registers no retrieval tool and never expands to all visible bases. Resolved base IDs define the exact search and reading scope. Service permission failures are tool failures, and results outside the selected IDs are rejected.

Knowledge uses `PERSONAL`, `DEPARTMENT`, and `COMPANY` ownership. On every directory query and retrieval, the server resolves the authenticated DingTalk unionId through `org-directory`; when OAuth omits unionId, it resolves the userid and validates the employee mapping, userid, employee ID, active status, and snapshot age. If the tenant has no unionId for that employee, the verified userid becomes the stable ownership key; `openId` is never used. It then grants the employee's personal scope, all direct departments, and configured company. Parent, child, and sibling departments grant no additional access. The default maximum snapshot age is two hours. Directory service outages deny access with a retryable diagnostic; no fixed team or cached task grant substitutes for the directory.

Administrators bind existing knowledge bases to directory employee or department IDs, or the configured company. Unbound bases cannot be retrieved. WeKnora retains documents and indexes; organization synchronization does not create bases. Kit access is rechecked by resource ID before execution and instruction loading; versions stay pinned. Product failures contain a code, related resources, retryability, and dependency results when preparation fails.

Product metadata owns folders, ownership, and read/manage permissions. Read access does not grant writes: personal owners, designated base managers, and configured administrator IDs can manage content. Employees explicitly create personal libraries; shared library creation requires an administrator. Managers create, rename, and delete single-level folders and upload into the selected folder. Markdown and URL creation remain at the root and can be moved afterward. WeKnora handles parsing, indexing, document content, and native folder paths. Product interfaces expose filtered document pages, parsed reading, URL ingestion, Markdown creation or modification, file upload, and asynchronous deletion. Folder IDs are stable and independent of displayed names; folders do not affect authorization. Markdown timestamp checks serialize product edits but cannot provide atomic conflict protection against direct WeKnora edits. Live collaborative editing is outside this module.

Task result saving is explicit and independent of retrieval scope. Writable destination metadata and Markdown saving use product tools with official Session logs and approval, as defined in the [runtime contract](../../packages/deepseek-harness-product/runtime/README.md). Saving does not automatically attach the destination to the current task or imply that indexing has completed.

Original-file viewing is independent of retrieval and indexing readiness. The server authorizes original metadata and bytes, and the product UI uses the public official document preview Factory without creating a Session. Main streams files into private temporary storage, sends bounded binary chunks to the renderer, and uses bounded JSON chunks for the official Host Office converter. Transfers close on completion, cancellation, or disposal. Authenticated server limits and desktop policy jointly bound preview, upload, and download; official format safeguards remain. Original download and desktop system-open stay in main and return no local paths. Office conversion rechecks permission and version; the [bridge contract](../../packages/deepseek-harness-product/product/README.md) defines limits and credential-free transport. Webpage imports without a stored original have no file preview; their cited fragments remain subject to retrieval checks.

Original access requires a stable `contentVersion`, shared by server streaming, desktop transfer checks and Office caching. Index processing timestamps do not replace this version; missing original identity fails closed.

## Desktop and upstream integration

The official shell offers trusted startup preparation, environment/profile overlays, namespaced IPC, events, and cleanup. Preload transports structured replies: `{ ok: true, result }` or `{ ok: false, failure }`. The product client decodes failures after crossing the isolated-world bridge, preserving codes, resources, and retryability. The product validates method allowlists. Window, origin, and main-frame checks remain in Electron. Runtime registration and process listeners follow Cordis disposal.

Request cancellation crosses Renderer, main, Host, and remote requests. Product disposal cancels work and awaits in-flight operations before releasing listeners and the native sidecar. Preparation cancellation does not discard another caller's registration or draft.

Product code uses public Harness exports, including typed `agentPresets.derive`, which retains the declaring Loader resolution context. `verify-upstream` checks the pinned release, complete registered patches, source imports, and dependency direction. Upgrade by updating the baseline, explicitly applying and resolving registered patches, checking the adapter, and running acceptance tests. The official profile remains usable without product overlays.

See the [task capability guide](../upgrade-guide/v0.2.0-rc.2/product-task-capabilities/guide.md), [knowledge management guide](../upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.md), and [patch manifest](../../scripts/upstream-patches/manifest.json).
