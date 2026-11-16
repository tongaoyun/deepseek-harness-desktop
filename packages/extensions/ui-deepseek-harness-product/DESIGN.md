---
name: DeepSeek Harness 资料库
description: 使用原生控件浏览资源、管理资料和阅读文档。
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
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "28px"
  title:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
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
  composer-reference:
    fontFamily: "var(--dsw-font-family)"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
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
  card-gap: "16px"
  card-padding: "18px 20px 14px"
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
  button-icon-header:
    textColor: "{colors.label-secondary}"
    rounded: "{rounded.native-control-small}"
    height: "28px"
    width: "28px"
    padding: "0"
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
    padding: "{spacing.card-padding}"
  navigation-row:
    textColor: "{colors.label-secondary}"
    rounded: "{rounded.navigation-row}"
    typography: "{typography.body}"
    padding: "8px"
  status-ready:
    textColor: "{colors.label-primary}"
---

# 资料库设计规范

## 范围

资料库沿用产品页的标题、字体、明暗主题和原生控件。页面用于文件浏览和管理；对话中的文件显示使用原生附件卡片，预览使用原生预览 Factory。

## 布局与操作

资料库使用页内左侧导航和右侧内容区：左侧为新建、最近、我的资料及团队资料，右侧为当前目录标题、上传、通过对话生成、搜索和列表／网格。标题使用 20/28px、字重 500，正文为 13/20px；原生 Button、Input、Menu 和文件树 Factory 保持与 Harness 的控件一致。文件列表最小行高 64px，使用 24px 原生文件图标；网格使用轻描边。窄窗口将同一导航节点排在内容区上方，目录区独立滚动，不重建搜索、文件或弹窗。

目录树按需展开，使用稳定资源标识和原生文件图标，各层分页提供加载更多。后台读取保留已有节点，失败保留错误和重试入口；删除目录不会从缓存恢复其子节点。我的资料与团队资料使用目录接口，最近使用跨库文件接口，不提供手动刷新或排序。点击未选中的展开目录进入该目录，点击当前目录可折叠；团队树分页入口移除后，焦点返回所属团队。当前可管理目录直接上传并展示目标，其他视图先选择位置；移动和引用文件的目标选择器分层浏览资料库与文件夹，保留搜索、面包屑和失败重试。新建文件夹在个人目录内默认保存到当前目录，其他视图默认我的资料，可更改位置；成功后进入实际保存目录并更新导航。普通员工可创建团队资料库，默认仅创建者可见；团队菜单提供成员管理，所有者可编辑、删除或转移所有权。所有编辑复用原生弹窗，文件生成保留原生会话草稿追加行为。

## 状态与焦点

首次加载使用静态占位，不先显示空列表；刷新保留已确认内容、筛选和滚动位置。错误保留到成功读取，重试不重建原入口。操作状态只影响相关控件，避免无关按钮变化。

原生 Modal 负责初始焦点与返回焦点。放弃修改确认保留编辑节点、光标和选区；删除或后台结果移除入口时，丢失的焦点交回搜索框，主动移到其他控件的焦点保持原位。

## 权限

个人资料仅本人可读可管理；团队资料按显式成员授权，所有者管理资料库和成员，可编辑成员管理文件，仅查看成员只读。部门与全公司为批量授权对象。界面只根据服务端回执开放操作，每次读写仍由服务端重新授权。普通对话输出不会自动归档。对话成果显式保存时记录来源；共享文件可显示来源类型，仅创建者获得原会话入口。
