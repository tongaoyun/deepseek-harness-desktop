---
name: DeepSeek Harness knowledge workspace
description: Native resource browsing, document management, and inline reading.
colors:
  primary-fill: "var(--dsw-alias-button-primary-fill)"
  primary-foreground: "var(--dsw-alias-label-primary-foreground)"
  surface-base: "var(--dsw-alias-bg-base)"
  surface-module: "var(--dsw-alias-bg-module-platform)"
  label-primary: "var(--dsw-alias-label-primary)"
  label-secondary: "var(--dsw-alias-label-secondary)"
  label-tertiary: "var(--dsw-alias-label-tertiary)"
  border: "var(--dsw-alias-border-l2)"
  hover-fill: "var(--dsw-alias-interactive-bg-hover)"
  ready-dot: "var(--dsw-alias-state-success-primary)"
  error: "var(--dsw-alias-state-error-primary)"
typography:
  headline:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "36px"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.02em"
  card-title:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  native-control: "var(--dsw-radius-md)"
  native-control-small: "var(--dsw-radius-sm)"
  library-card: "12px"
  search: "7px"
  navigation-row: "5px"
spacing:
  icon-gap: "4px"
  control-gap: "8px"
  row-padding: "16px"
  card-gap: "20px"
  card-padding: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.native-control}"
    height: "36px"
    padding: "0 14px"
  button-outline-small:
    textColor: "{colors.label-primary}"
    rounded: "{rounded.native-control-small}"
    typography: "{typography.label}"
    height: "28px"
    padding: "0 10px"
  button-ghost-small:
    textColor: "{colors.label-primary}"
    rounded: "{rounded.native-control-small}"
    typography: "{typography.label}"
    height: "28px"
    padding: "0 10px"
  search-field:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.search}"
    typography: "{typography.body}"
    height: "34px"
    padding: "0 10px"
  library-card:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.label-primary}"
    rounded: "{rounded.library-card}"
    padding: "24px 24px 20px"
  navigation-row:
    textColor: "{colors.label-secondary}"
    rounded: "{rounded.navigation-row}"
    typography: "{typography.body}"
    padding: "8px"
  status-ready:
    textColor: "{colors.label-primary}"
---

# Design System: DeepSeek Harness knowledge workspace

## Overview

**Creative North Star: "Native Harness resource workspace"**

This reference describes the product knowledge directory, library materials, and inline reader. WorkBuddy informs resource browsing; Harness owns the surrounding shell, theme, system typography, controls, and original-file preview.

**Key Characteristics:**

- Neutral light and dark surfaces with restrained semantic color.
- A searchable card directory followed by a separate materials workspace.
- Compact controls, generous document rows, and visible keyboard state.

The [product constraints](PRODUCT.md) govern native reuse and permissions. The [package reference](README.md#knowledge) owns operation, authorization, and processing behavior.

## Colors

The native palette uses cool neutral surfaces and labels, neutral primary buttons, and semantic success/error accents. Frontmatter values stay bound to the active Harness theme; the [native theme source](../../client/ui-theme/src/styles/design-platform.css) owns their light and dark values.

### Primary

- **Primary fill and foreground:** directory creation, upload, and dialog confirmation actions.

### Neutral

- **Base and module surfaces:** the directory/materials canvas and the quieter library navigation rail.
- **Primary, secondary, and tertiary labels:** names and selected content, descriptions and metadata, then quiet supporting labels.
- **Border and hover fill:** card edges, table separators, and interactive row feedback.

Ready uses the success accent only for its dot. Failed states and operation errors use the native error alias. Native business color remains available for keyboard focus; it does not replace the neutral primary button fill.

**The Theme Alias Rule.** Use the native semantic aliases in both themes; primary controls and selected navigation remain neutral.

**The Readable Status Rule.** Ready status uses primary label text and a green dot; color supplements the localized status label.

## Typography

All roles inherit the user-configurable native text family (`--dsw-font-family`), whose default stack starts with Apple system, BlinkMacSystemFont, Segoe UI, and CJK system fallbacks. This workspace adds no display face.

The headline role leads the directory; title leads library/folder materials; card-title names libraries. Body serves rows and navigation; descriptions use the same size with a more open line height (22px). Label serves controls, statuses, and metadata. At compact width, the directory heading becomes (24px/32px) and the materials heading becomes (20px/28px). Original-file typography belongs to the native preview.

## Layout

The centered directory caps its width (1200px), with desktop padding (40px 40px 48px). Header, scope tabs, search, refresh, and library cards form the discovery view. Cards use an auto-fill grid with a minimum column width (250px) and the card gap token; their descriptions clamp to two lines.

An opened library uses a navigation rail (236px) and a flexible materials pane. The pane has a sticky breadcrumb/action header, body padding (24px 28px 28px), a title with management actions, browsing-mode tabs, search and filters, then a full-width table. Table cells use vertical padding (16px); filenames wrap. The inline reader replaces the materials content while retaining navigation and document actions. Passage reading caps its width (820px); original-file preview uses the available pane.

At a materials-container width of at most (680px), format, size, and update columns disappear while name, status, and actions remain. At a workspace-container width of at most (640px), the directory uses padding (24px 20px), cards form a narrow grid, and scope tabs and search fill the width. The workspace shows either navigation or materials under a mobile browse header. Filters use two flexible columns plus refresh (28px), and clear filters occupies its own row. Materials body padding becomes (16px). The viewport breakpoint (640px) also lets search and add actions wrap. macOS top padding includes the native frame clearance.

## Elevation & Depth

Cards, navigation, and materials use tonal separation and fine borders without card shadows. Table and workspace separators use hairlines (0.5px); library cards use a continuous stroke (1px). Native menus and dialogs retain `--dsw-elevation-prominent`; menus retain native material treatment. The native segmented indicator uses `--dsw-elevation-soft`. Outline buttons use the native inset hairline. Do not redefine those effects in this extension.

**The Overlay Depth Rule.** Keep directory cards and document rows flat; native menus and dialogs own overlay elevation.

## Shapes

Library cards use the card radius token with clipped content; their icon containers have softly curved corners (10px). Search and icon controls use the search radius, and navigation rows use the navigation radius. Native buttons keep their regular and small radii; native menus and dialogs retain their own geometry. These local values describe this workspace and do not replace the shared radius scale.

## Components

**Buttons and menus.** Reuse native primary, outline, and ghost variants. Directory creation uses regular size; workspace and dialog actions use small size. Primary hover uses the native primary-hover alias; outline/ghost hover uses hover fill. Disabled native buttons reduce opacity (0.4). Menu anchors expose expanded state and localized names; portaled native menus preserve their keyboard behavior.

**Search, filters, and scope tabs.** Search uses a native search input in a labeled bordered wrapper; focus strengthens the border. Directory search filters the cards, while materials search has an explicit submit action. Format/status selects have localized labels. Native SegmentedControl owns scope and browsing-mode selection, selected indicators, keyboard focus, and reduced-motion behavior.

**Library cards and navigation.** The large card button opens the library; its footer holds scope/owner information and separate permitted actions. Hover strengthens the border and fills the button; keyboard focus adds an inset outline (2px). Navigation exposes current and expanded state. Opening a library focuses the materials heading through native `focusWithoutRing`; returning restores the originating card, or the directory heading when the card is absent.

**Materials and reading.** Use semantic table headers, labeled selection checkboxes, native file-type icons, wrapped names, textual processing status, and explicit pagination. Ready text stays primary with a dot (5px). Loading uses ProductLoading with an accessible label; busy regions expose `aria-busy`; errors use alerts and retry actions; empty states distinguish no content from no matches. Read-only users retain browsing/reading controls, while management and batch actions follow existing permissions. Upload, edit, move, and confirmation states use native Modal/Menu; original files render through `document.preview`, and extracted passages through MarkdownText.

## Do's and Don'ts

### Do:

- **Do** reuse native Button, SegmentedControl, Menu, Modal, Tooltip, icons, MarkdownText, and document.preview.
- **Do** keep search, format, status, refresh, and clear-filter controls usable when the workspace narrows.
- **Do** preserve localized names, explicit loading/error/empty states, permission-dependent actions, and library transition focus.

### Don't:

- **Don't** hardcode a separate light/dark palette or replace the Harness text family.
- **Don't** turn the ready label green or communicate processing state through color alone.
- **Don't** create parallel native controls, document viewers, retrieval engines, or configuration systems.
