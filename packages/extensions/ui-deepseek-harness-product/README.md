---
description: "Official Harness sidebar navigation for DeepSeek Harness product capabilities."
kind: "package-reference"
---

# DeepSeek Harness Product Capabilities

English | [中文](README.zh.md)

This package publishes DeepSeek Harness product navigation in the official Harness sidebar. No companion is published because every product operation is dispatched through the Electron product method allowlist and the `deepseek-harness.native.v1` sidecar.

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

Enable this extension in the official Electron desktop composition to expose the Capabilities group and its Expert Kits, Skills, Connectors, and Knowledge entries in the official sidebar. Product requests remain behind the product method allowlist and are handled by the main-process product bridge; the Renderer never receives employee session credentials or upstream connector credentials.

Directories search the complete server-backed catalog. Skills and Kits group by category, Connectors by their own categories, and Knowledge by organization ownership. Compact cards retain names, summaries, authors, versions, and actual status. Wide layouts show two Kit or Connector columns and three Skill columns, reducing columns as the panel narrows. Harness theme tokens, icons, and primitives supply both themes. Skill details render the `SKILL.md` body directly in the official Modal, preserving document headings and formatting without catalog metadata or additional sections. YAML frontmatter is hidden. Only the document scrolls; the title, close button, and install action remain visible. Escape closes the dialog and restores focus. Kits open a full main-panel detail. Connector **All** and **Connected** tabs distinguish account authorization from task selection. OAuth exposes authorize, reauthorize, and revoke while the server retains credentials. The UI does not infer permissions or installation absent from server metadata.

Connectors missing device-local configuration show **Needs configuration** and are excluded from **Connected**, even when the server reports authorization. Authorized connectors with temporary server outages remain in that filter and show their actual availability.

Signing out or changing employees clears open resource details, references, editors, confirmations, installation state, and the knowledge reader. Pending directory reads and management writes are canceled; late responses cannot reopen the former employee's content or start its modification conversation. Refreshing the same employee's session retains open details. An unavailable identity transport reports a loading failure rather than a sign-out.

**Install skill** downloads and verifies content once, then shows **Installed** for that content version. Skills have no enable or disable state. Installation preserves the current Session, mode, and draft. The official skill catalog automatically discovers installed skills when task dependencies are satisfied; the model can request their instructions and users can invoke `/<skillName>` explicitly. Started tasks retain their pinned skill versions, while new content versions can be installed for subsequent tasks.

Installed Skill cards and details, including shared resources, offer **More actions → Uninstall** with a named confirmation. Uninstall removes the current device installation; new tasks no longer discover the Skill. Started tasks retain their fixed content, history, and drafts. The server resource stays available for reinstall. Failure retains the confirmation for retry, and success restores **Install skill** without changing the current task or draft.

Expert Kits supply the initial capability composition. Selecting Knowledge retains existing capabilities. Empty tasks adjust directly without rewriting the editor; after a turn starts, the official selection guard creates a new task in the same Workspace and carries the latest text and reference chips while preserving history. Explicit shortcut commands always prepare a new task in the source Workspace, preserving the source composition and draft. The official draft initializer persists receiving content before navigation; pending submission or persistence failure leaves the source task and draft intact. Skills and Expert Kits declare connector dependencies; the connector directory manages account authorization.

Kit cards and details expose **Install expert kit** or a noninteractive **Installed** status for the current catalog version. Install before using a Kit: uninstalled details hide **Start using** and disable shortcut commands. New selections require the installed version and hash to match the accessible catalog version; a published update requires explicit installation. Task preparation never changes installation records. New Kit selections reject absent or mismatched installations with `KIT_NOT_INSTALLED` or `KIT_INSTALLED_VERSION_CHANGED`.

Installed Kits, including shared resources, expose **Uninstall** in **More actions**. Confirmation names the Kit and explains that the device installation is removed while the directory and existing task content remain available. Failed uninstall retains the confirmation for retry. Successful uninstall restores **Install expert kit**, preserving the current task and draft. Task preparation never reinstalls a removed Kit. Existing tasks retain pinned content and history; adjusting their mode or knowledge does not require reinstalling the pinned Kit. Execution and instruction loading still check current access permissions. Owner-only editing, review, and deletion remain separate resource operations.

Execution mode uses the [official Preset UI](../../client/ui-agent-preset/README.md) and its controller: the empty-task menu shows names and descriptions, obeys Developer tools, and becomes a read-only header label after a turn starts. Composed task snapshots display and select their base mode while retaining their actual execution identity in Session logs. The product does not replace either official mode slot.

An independent **Expert kits** selector sits beside the official mode on the empty-task screen, with the same plain button style. Its choices include only accessible catalog Kits whose current version and hash are installed on this device. It displays the pinned Kit name, or **Expert kits** when none is selected; an unavailable current choice remains visible without becoming selectable. **No expert kit** clears the composition. Kit changes retain knowledge; official mode changes retain pinned product content.

After conversation starts, the header displays a selected Kit as a read-only label alongside the official mode, with no border, chevron, or menu. It omits the Kit label when no Kit is selected. To use another Kit, open its directory detail and choose **Start using** or a shortcut command; these actions prepare a new task through the official guard, preserving the original history and draft. Knowledge changes remain available from the input and follow the same official task boundary.

**+ → Reference knowledge bases** opens searchable multi-selection and commits it once with **Apply**. Selected bases appear as compact tags inside the input, with full names on hover and bounded horizontal scrolling. Optional tags can be removed; required Kit bases remain locked. An empty scope shows no tags. Cancel discards staged changes; preparation failure retains them for retry. Catalog failures retain selected identities. Knowledge catalogs and task selection distinguish missing employee mappings, inactive employees, invalid DingTalk sources, expired synchronization, and organization outages using localized messages and diagnostic codes; they never display private upstream exception text or offer permission recovery while the catalog is unavailable. Knowledge selection remains in the input after a task starts and prepares a new task through the official guard. The sidebar **Capabilities → Knowledge** directory remains available. Private snapshot IDs never label controls.

The knowledge Add-menu entry registers with the composer before capability reads finish. An opening request waits for that task's capabilities; switching tasks discards the pending request. Returning from a directory does not require waiting for a completed capability read before opening selection.

Expert Kit details show identity, summary, shortcut commands, skills, connectors, knowledge bases, and the kit guide in that order. Dependency checks run during task preparation and report concrete failures. Skill rows show names and summaries; connector rows show authorization; knowledge rows resolve stable references and show organization ownership. Missing, denied, ambiguous, and failed lookups remain unavailable. Kit details omit technical IDs and hashes. A compact framed Markdown preview opens the full reader when clicked or activated with the keyboard; Escape restores focus without leaving the detail. Shortcut commands prepare a new official task and fill its draft for confirmation.

Skills and Expert Kits offer all 20 fixed categories, including empty categories, and **All / Mine** filters. Cards omit the normal **Available** label and retain dependency warnings; Skill cards show **Install** or a noninteractive **Installed** status for this device. **Add** groups creation and import. Creating or modifying content opens a separate official conversation in the source Workspace with a prefilled unsent draft. Modification drafts name the resource type and loaded content's name. The source task and draft remain intact; later navigation prevents focus changes. Scoped model tools update the content and save it directly to the personal directory, installing skills on this device. Creation conversations have no preview or save-confirmation control. Modifying a personal resource prepares a new version while old tasks keep their content. Shared review remains a separate owner action.

Import starts with file or folder selection and a read-only preview. Standard directories and ZIP packages retain resources; a standalone `SKILL.md` requires missing product metadata before saving. **Continue in conversation** completes metadata or changes content. Kits require at least one skill; accessible catalog skills are copied by fixed version and hash with their resources. Failed saves preserve the creation draft; closing the preview cancels its requests. Unused import staging is released, while drafts attached to a creation Session survive desktop restart. Conversation navigation uses the official sidebar.

Connectors offer **Add** and **Mine**, alongside account authorization. **Add** opens one **Add MCP server** dialog with **Manual configuration / Paste JSON** tabs, stable dimensions, and a fixed **Add** footer. The form provides a server-type selector, name, HTTP endpoint or complete stdio command, and private key/value rows. Resource ID, version, summary and category use generated defaults without an advanced editor. Literal command parsing preserves quoted arguments and rejects shell operations and variable expansion. Clipboard paste accepts JSON string maps or `KEY=VALUE` lines. Standard MCP JSON fills the form; multiple servers require selecting one. Switching tabs preserves entered content. A local timeout accepts 1–600 seconds, defaulting to 60, for connection, discovery and tool calls. Only explicit **Add** discovers tools, without business calls. Private values are masked and write-only; unsaved credentials stay in the local form. Configured OAuth providers reuse server authorization and its default timeout; local configuration is required on each device.

Connector details use a compact dialog with connection status, transport, authentication and authorization actions, without a task selection checkbox or advanced disclosure. Owners can modify personal connectors in the same MCP dialog or confirm deletion. Failed saves retain input; loading configuration must succeed before editing. Private keys appear with blank values; unchanged destinations can retain them. Read and write summaries share a separate band; the capability list expands independently and omits technical tool names. Narrow windows wrap status fields and summaries without horizontal scrolling. The Expert Kit selector lists Kit names without summaries and refreshes when the active task or Preset changes.

Knowledge remains under **Capabilities → Knowledge**. Its main panel shows a personal, direct-department and company library tree beside the materials and reading area. Department headings show their names; identical department names include their stable IDs. Selecting a library or folder lists its materials; selecting a file opens its original bytes in the official document preview, with a persistent breadcrumb and manager actions. An incomplete or failed retrieval index does not disable original-file viewing. Narrow panels toggle between navigation and reading. Document names, formats and processing states filter on the server, with pagination. The main toolbar groups file search, upload and creation. The sidebar lists folders only; the main list shows direct subfolders followed by files, and the reader returns to that list. Refresh discards the prior preview and rechecks current access; explicit denial clears library materials, while network errors retain the selected file and offer retry. Library and document changes cancel prior requests and discard prior reading state; browsing never changes the task or draft. Referenced library details retain separate **Documents** and **Search** views; search hits open indexed citations, whose **View original file** action opens the document preview. Only server-confirmed managers see upload, Markdown creation or editing, URL import, reindex, move, delete, and folder management. The upload menu offers regular files with standard processing and text PDF extraction explicitly labeled **no OCR**; scanned PDFs use regular upload. A duplicate upload does not change an existing document's parsing mode. Markdown edits check the latest document timestamp; failed saves retain the editor. Deletion reports a submitted background job. Folders organize content within a base and do not grant access.

Original-file viewing uses the official Session-free `document.preview` factory: PDF shows pages, Excel shows a read-only workbook, and Word or PowerPoint uses the official Office-to-PDF converter. Missing-font notices remain visible. Markdown, text, HTML and images use the same official renderers as Sidebar documents. The authenticated product bridge accepts resource IDs only and supplies bounded bytes, without upstream URLs or credentials; each read and conversion checks current permission. Retrieval continues through WeKnora's indexed passages. An unavailable original file, oversized response or failed conversion produces a localized error instead of falling back to indexed text. Transfer saturation asks the user to retry later; a version change during reading asks them to reopen the preview. Both retain library access and allow an explicit retry.

The personal group offers **New personal knowledge base**; the server fixes ownership to the authenticated employee. The folder tree exposes **New folder** and a per-folder menu for creating subfolders, uploading, renaming and deleting. Creation selects the new folder; deletion returns to its parent only when deleting the current folder. The parent picker, breadcrumbs and move picker display complete folder paths. Names are unique within a parent; deletion requires no files or subfolders. Uploads retain the selected destination after completion, cancellation or failure. Folders support nested metadata with stable engine content locations; online documents and website imports are created at the library root and can then be moved. Shared libraries expose only authorized reading and original-file downloads unless the server grants management. File menus retain **Download original file** even when preview fails; **Open in system app** appears only in the desktop. Previews receive bounded binary chunks through a temporary main-process transfer, closing the transfer after success, failure or cancellation instead of carrying an entire Base64 file through IPC.

Document trees and materials tables show localized processing states without raw parser diagnostics.

Conversation `knowledge_search` and `knowledge_read` rows expose recorded sources through the official keyed toolview. Expanding a result shows the filename, library name and unchanged locator; selecting it reads the authorized fragment, and **View original file** opens the correct document through the official preview. Source metadata survives Session replay without a directory query. Opening a source rechecks current access; failed or unsupported metadata retains recorded output without creating a source link. Locators remain visible while reading the original; automatic page or spreadsheet-cell navigation is unavailable in the official Session-free preview API.

Skill, Kit and Connector cards and details place owner-only resource operations in **More actions**: **Modify**, **Submit for shared review**, then separated red **Delete**. Review status replaces repeat submission. Sharing confirmation explains company availability after approval and continued personal use during review. Deletion confirmation names the resource and preserves conversation history; resources with a published version require unpublishing first. Skill and Connector management stays in the fixed dialog footer while content scrolls. Failed writes retain the dialog and resource for retry; successful deletion removes the resource without changing the current task or draft.

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

Build the extension with the repository's standard package build. The Desktop Host applies this package's exported `cordis.patch.yml` over the official Web profile, mounting product navigation and disabling official account onboarding. The Host installation supplies the product plugin without adding it to the upstream Web bundle. `harness-actions.ts` owns the client integration with official Session, Workspace, composer, and Preset services; the registration entry only connects slots and actions. Keep product API calls in `packages/deepseek-harness-product/product`.
