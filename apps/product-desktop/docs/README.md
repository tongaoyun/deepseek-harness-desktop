# Enterprise desktop overview

English | [中文](README.zh.md)

## Summary

The enterprise desktop combines official Harness conversations, execution modes, approvals, and document previews with DingTalk identity, skills, Expert Kits, connectors, and knowledge libraries. Use this page to find the current product behavior and its documentation owners.

## Table of Contents

- [Product entry points](#product-entry-points)
- [Capabilities](#capabilities)
- [Knowledge files](#knowledge-files)
- [Repositories and architecture](#repositories-and-architecture)
- [Development and delivery](#development-and-delivery)
- [Verification and limitations](#verification-and-limitations)

<a id="product-entry-points"></a>
## Product entry points

Employees use the product desktop and sign in through DingTalk. The official Harness profile remains a separate assembly without enterprise extensions. The [product desktop](../README.md) owns product launch and packaging; the [desktop extension](../../../packages/deepseek-harness-product/desktop/README.md) owns authentication and encrypted device credentials.

Administrators use the [web control center](http://www.instudio.me:6206/traefik/deepseek-harness/), served by `deepseek-harness-server`. Desktop use does not require starting a local control center. Business requests require an authenticated employee; administration also requires the server's configured permissions. Server connection details belong to its `docs/deployment.md`.

<a id="capabilities"></a>
## Capabilities

| Capability | Employee workflow | Task behavior |
|---|---|---|
| Skills | Create or edit through a conversation; import a directory, ZIP, or `SKILL.md`; install or uninstall on this device | Installed eligible skills use native semantic discovery or explicit `/<skillName>` invocation; installation creates no Preset |
| Expert Kits | Install, read the guide, then select a Kit before sending or choose a shortcut | The task pins the Kit content; a started conversation displays its Kit without a switch control; shortcuts prefill and require the user to send |
| Connectors | Add through a form or MCP JSON; owners may edit or delete; manage authorization separately | Skills and Kits declare dependencies; READ annotations allow policy checks, WRITE tools require official approval, undeclared tools are denied |
| Knowledge libraries | Browse personal, direct-department, and company libraries under Capabilities | Choose retrieval scope from the conversation input; browsing files does not add a library to a task |

Creation saves personal skills and Kits to the server; successful skill saves also install on this device. Shared submission is a separate owner action. Editing creates a new immutable version. Uninstall removes a device installation, while deletion retires an owned server resource. Neither operation deletes official conversation history. Existing pinned tasks retain content after uninstall but still require current server access. See the [UI](../../../packages/extensions/ui-deepseek-harness-product/README.md) and [runtime](../../../packages/deepseek-harness-product/runtime/README.md) references for the complete rules.

<a id="knowledge-files"></a>
## Knowledge files

The library workspace has a folder tree, a file list, and an inline reader. Managers can create nested folders, rename folders, upload into them, move files, and delete empty folders. The service rejects deletion while files or subfolders remain. Folder queries show the selected folder's direct files; All materials spans the library. Breadcrumbs and destination selectors show complete paths. Markdown and webpage creation occur at the library root and can be moved afterward.

Original-file viewing uses official Harness preview components and does not depend on successful indexing. PDF renders pages; Excel renders a read-only workbook; Word and PowerPoint use official Office-to-PDF conversion. Available originals can also be downloaded or opened with a system application on desktop. Parsing, indexing, search, and source fragments belong to WeKnora. A webpage without a stored original has no original-file preview. File limits, conversion failures, and permission failures remain explicit. See the [file UI reference](../../../packages/extensions/ui-deepseek-harness-product/README.md) and [knowledge upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.md).

The server rechecks current DingTalk organization membership rather than trusting a task snapshot or client department claim. Only the employee, all direct departments, and the configured company grant scope; folders grant no additional access. Empty task scope registers no retrieval tool. Missing access and network failures have different recovery behavior. The [product subsystem](../../../docs/subsystems/deepseek-harness-product.md) owns these permission and retrieval rules.

<a id="repositories-and-architecture"></a>
## Repositories and architecture

| Repository | Responsibility |
|---|---|
| `deepseek-harness-desktop` | Official Harness baseline, registered generic patches, independent product packages, UI, and desktop delivery |
| `deepseek-harness-server` | Authenticated API, web control center, catalogs, personal resources, review, organization access, and WeKnora adaptation |
| `deepseek-harness-extensions` | Maintained shared skill and Kit source, schemas, validation, immutable artifacts, and publisher workflow |
| `k3s-gitops` | Development deployment manifests reconciled by Fleet |

Connector implementations belong to their business services, such as `erp-mcp-gateway`; their directory and authorization belong to the server. There is no separate connector repository or upstream mirror in the delivery path. The desktop repository retains the pinned Harness baseline tag and registered patches. Product packages consume public Harness exports through Cordis plugins and UI slots. See the [package map](../../../packages/deepseek-harness-product/README.md), [subsystem reference](../../../docs/subsystems/deepseek-harness-product.md), and [patch manifest](../../../scripts/upstream-patches/manifest.json).

<a id="development-and-delivery"></a>
## Development and delivery

Use the product launcher for enterprise development; its home and Electron profile are separate from the official desktop. The [local launch instructions](../README.md#local-development) describe the supported entry and profile overrides. Credentials remain in Electron main or controlled server configuration, never in renderer variables or committed files.

Gitea owns development review and desktop CI. The manual GitHub synchronization workflow requires successful CI for the exact source commit and sends committed desktop source plus the pinned baseline to the build repository. Native runners build Windows x64, macOS ARM64, and macOS Intel. Verified installers and checksum metadata are published to the public download repository and internal Gitea releases. These are unsigned development packages; no automatic-update feed is published. Public build repository source and history are publicly readable. The [desktop delivery reference](../README.md) owns workflow inputs, credentials, retries, and recovery.

Server deployment uses its Gitea workflow, Harbor, GitOps, and Fleet. Build success, deployment readiness, and employee workflow acceptance are separate results. The server's `docs/README.md` links API, deployment, domain, and acceptance references. A protocol migration must reach the server before a desktop that requires it; [product upgrade guides](../../../docs/upgrade-guide/v0.2.1-alpha.2/product-knowledge-library/guide.md) record the affected behavior.

<a id="verification-and-limitations"></a>
## Verification and limitations

Documentation checks use the repository's bilingual pairing and document validation commands. Behavior evidence includes focused product regressions, real Loader/profile tests, keyless model fixtures, browser layouts, and built or installed native desktop acceptance. The [testing reference](../../../docs/testing.md) and [desktop delivery reference](../README.md#local-checks) define the executed checks; server acceptance evidence belongs to its `docs/knowledge-acceptance.md` and `docs/knowledge-stability.md`.

Mock identities and models verify request handling, composition, UI, and recovery without employee secrets; they do not establish live DingTalk permissions or real model reasoning. Real second-employee isolation remains a separate acceptance requirement. OCR and visual models are outside the current scope. Direct concurrent editing in WeKnora is outside product edit-lock guarantees; live collaborative editing, folder moves, and automatic snapshot garbage collection are not provided.
