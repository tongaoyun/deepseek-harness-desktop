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
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.4px"
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

技能、专家套件、专家团、连接器和资料库共用 `product-capability-*` 标题与正文宽度。主标题为 24/32px、字重 600，正文为 13/20px；横向留白为 20–44px。窄窗口工具栏换行，不缩小标题或隐藏主要操作。

资料库默认展示文件首页，包含最近、我的、收藏、资料库目录；文件支持文档、图片视频、HTML、其他分类及访问时间、名称、大小和修改时间排序。列表与网格复用同一批文件节点。目录按库、文件夹分层浏览，保留面包屑、搜索和刷新，文件与文件夹使用稳定标识。上传、新建文件夹、编辑、移动和删除使用原生弹窗及固定页脚，长列表在正文滚动。

## 状态与焦点

首次加载使用静态占位，不先显示空列表；刷新保留已确认内容、筛选和滚动位置。错误保留到成功读取，重试不重建原入口。操作状态只影响相关控件，避免无关按钮变化。

原生 Modal 负责初始焦点与返回焦点。放弃修改确认保留编辑节点、光标和选区；删除或后台结果移除入口时，丢失的焦点交回搜索框，主动移到其他控件的焦点保持原位。

## 权限

个人资料仅本人可读可管理；共享资料按部门或公司读取，管理员和指定负责人管理。界面只根据服务端回执开放操作，每次读写仍由服务端重新授权。普通对话输出不会自动归档。对话成果显式保存时记录来源；共享文件可显示来源类型，仅创建者获得原会话入口。
