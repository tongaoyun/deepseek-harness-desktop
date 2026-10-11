---
kind: upgrade-guide
description: "Personal extension activation and standard import metadata replace executable drafts and unresolved dependency references."
---

# Personal Extensions

English | [中文](guide.zh.md)

## Change

Skills and Expert Kits use 20 fixed categories and standard directory or ZIP imports. Kit details show shortcuts and resolved resources; preparation checks remain enforced without a startup-check panel. Knowledge references must resolve to real accessible IDs before they appear usable.

Kit details omit advanced information; the framed guide preview opens the full reader. The separate Kit selector shows names without summaries. Skill details render the `SKILL.md` body without additional metadata sections. **Add MCP server** accepts a complete stdio command, pasted private variables, and a local `timeoutSeconds` from 1 through 600. The official MCP client's existing `toolCallTimeoutMs` also governs connection and discovery; non-default values now affect startup. The generic desktop namespace transport accepts an optional final `timeoutMs` argument.

Personal availability is independent of shared review. Uploaded drafts require explicit artifact validation and activation. Server catalogs merge personal available versions with published shared resources and return ownership and review metadata. Owners remain fixed; editing creates a new immutable version. Creating resources never creates an execution Preset.

Desktop authoring uses `extensions.import.inspect`, `extensions.save`, `extensions.submit`, and `extensions.delete`. Skill save installs on the device. Personal connectors support MCP HTTP/stdio discovery; private headers and environment stay encrypted in main. OAuth retains server-managed authorization. Only actual non-destructive read-only annotations bypass approval.

Skill and Kit creation and modification use separate official conversations with unsent drafts, replacing manual forms and creation previews. Session tools save personal resources directly. Import previews stay read-only; missing information is completed in conversation. Main persists employee-scoped drafts and resources under `extension-conversations-v1`; stale revisions fail. The Host cannot publish shared content. All three types use **More actions → Modify / Submit for sharing / Delete**, with sharing and deletion confirmations. Deletion retires all versions and retains artifacts and Session history; published versions require unpublishing first. Skill actions stay visible while scrolling.

## Migration

1. Apply server migrations `V50__personal_extension_activation.sql`, `V51__retire_personal_connectors.sql`, and `V52__retire_personal_artifacts.sql`. Keep published resources, historical artifacts, and Session data. Existing drafts require validation and activation.
2. Update product desktop and server together. Use standard `SKILL.md` with product metadata or kit schema 3 manifests; complete missing import metadata in conversation. Qoder exports are not converted.
3. Re-create unsupported product caches through explicit recovery. Keep content-addressed artifacts and task snapshots; new versions affect subsequent selections. Creation conversations use sidebar navigation; remove the retired `sourceSessionId` field from existing `extension-conversations-v1/*/draft.json` records while Desktop is closed, retaining all other fields and resources.
4. Use server-derived ownership, visibility and `canDelete`. Submit no owner declarations or manual READ policies. Configure private connector credentials on each device.
5. Use **Add → Create** or **More actions → Modify**, then send the requirements draft. The model saves completed content directly. Retain desktop user data for unsaved conversations. Check non-default `toolCallTimeoutMs` against startup time. Verify personal isolation, fixed-version copying, skill discovery, preparation, deletion, cancellation, restart, and both profiles. Run `pnpm run verify:upstream` before upgrading Harness.
