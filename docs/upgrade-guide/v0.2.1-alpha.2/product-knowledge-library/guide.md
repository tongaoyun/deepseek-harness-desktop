---
kind: upgrade-guide
description: "Product knowledge writes require management permission and citation source IDs identify parsed fragments."
---

# Product Knowledge Library

English | [中文](guide.zh.md)

## Change

Knowledge read access no longer grants write or management rights. Personal owners, designated base managers, and configured administrators can manage libraries. Existing shared bases without a manager require an administrator. Authorization uses authenticated IDs, never display names.

Search `sourceId` identifies a parsed fragment; `documentId` identifies its document. Reading rechecks live permission and indexing readiness. Lists are paginated, with asynchronous processing and deletion states. Markdown editing requires current `expectedUpdatedAt`; WeKnora webpage edits lack atomic conflict protection.

Official tools support approved task-result saving and cited-fragment reading. Empty task selection provides no retrieval tool. Saving does not change retrieval selection.

Programmatic `knowledge_read` returns a structured hit rather than JSON inside `content`; model text is unchanged. Source identities persist in official `tool/result.meta`. Older results remain readable without invented links.

Preview reads the authorized original independently of indexing, using official renderers and local Office conversion. Transfers use bounded chunks and private temporary files, cleaned on close, cancellation, or disposal. Whole-file Base64 IPC is removed. Preview creates no Session and never substitutes indexed passages for originals.

File limits use the lower server or desktop policy; official format limits still apply. Server defaults are 50 MiB for preview/upload and 250 MiB for download. Download uses a native save dialog; system-open uses a main-owned file. Neither exposes paths or credentials. Webpages without stored originals cannot preview; citations remain readable.

Employees can create personal libraries. Managers can manage single-level folders and upload into the selected folder, retained on failure or cancellation. Markdown and webpages start at the root and can be moved. Department/company creation requires an administrator. See [product architecture](../../../subsystems/deepseek-harness-product.md) for implementation details.

## Migration

Original metadata requires `contentVersion`; indexing timestamps are not original identity. Replacing originals or editing Markdown invalidates transfers and conversions. Missing identity rejects preview/download.

1. Upgrade the server and run ownership/folder migrations before desktop upgrades. Preserve library IDs, WeKnora content, and Session history; existing documents need no content migration.
2. Configure `deepseek-harness.auth.admin-employee-ids` using authenticated employee IDs. Shared libraries without managers remain administrator-managed.
3. Update citation clients to use `sourceId` for fragments and `documentId` for documents. Preserve pagination and job states.
4. Read fresh Markdown metadata; submit `expectedUpdatedAt` and a stable retry key through product editing. Stale edits must report conflicts.
5. Verify read-only members cannot write, personal owners can manage, empty scopes cannot retrieve, and denied save approval produces no write.
6. Configure `deepseek-harness.knowledge.files.*-max-bytes` and desktop `knowledgeFiles`. Verify failed-index originals, cleanup, download, live access checks, Office content versions, and selected-folder upload. Old preview IPC is unsupported.
