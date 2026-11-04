---
kind: upgrade-guide
description: Company content uses version indexes and AgentSpec packages, requiring a paired desktop and control-plane upgrade.
---

# Company content and AgentSpec packages

English | [中文](guide.zh.md)

## Change

The product desktop reads company resource version indexes instead of complete file snapshots. Experts use AgentSpec directories with `manifest.json` and `config/SOUL.md`; teams reference immutable expert versions. The server resets company content and review records with Flyway V73. Employee, organization, connector, knowledge and native conversation data remain available.

Personal experts become immutable local packages scoped to the authenticated employee. Native Settings stores their references and display metadata. Personal teams pin member versions; references to removed company experts require a new selection.

Company team members use a fixed-length digest of the team and expert identifiers. Existing member enablement and personal-team references to those members require a new selection.

## Migration

1. Deploy the matching control plane and upgrade the product desktop together. Earlier desktops receive an explicit update requirement when reading company content.
2. Start the desktop with the employee account that owns the existing personal library. The first content read converts that library once; later employee accounts receive separate libraries.
3. Open personal experts and teams, verify their instructions and attachments, and reselect any unavailable company members before saving a team.
4. Publish company skills as standard `SKILL.md` packages, experts as AgentSpec packages, then teams whose members are already published. The formal company directory starts empty.
5. Start a new conversation to execute company content. Existing conversation history remains readable; conversations bound to the previous company protocol cannot resume execution.
6. Disable and re-enable previously enabled company teams. If a personal team references a company-team member, select that member again and save. Confirm that all selected members are enabled before summoning the team.

See the [company content guide](../../../../apps/product-desktop/docs/company-content.md) for the package formats and publishing operations.
