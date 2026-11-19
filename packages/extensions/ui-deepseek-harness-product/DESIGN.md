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

资料库使用页内左侧导航和右侧内容区：左侧为新建、最近、我的资料及共享空间，右侧顶部显示目录路径，下方使用原生文件夹图标和当前目录标题，提供上传、通过对话生成、搜索和文件列表。标题区最小高度 40px，有无文件夹图标及操作换行时保持对齐；标题使用 20/28px、字重 500，顶部目录路径为 16/24px，正文为 13/20px；原生 Button、Input、Menu 和文件树 Factory 保持与 Harness 的控件一致。文件列表最小行高 64px，使用 24px 原生文件图标。窄窗口将同一导航节点排在内容区上方，目录区独立滚动，不重建搜索、文件或弹窗。

目录树按需展开，使用稳定资源标识和原生文件图标，分组下及每层目录缩进 18px，选中背景覆盖整行，各层分页提供加载更多。后台读取保留已有节点，失败保留错误和重试入口；写入后，折叠目录再次展开时重新校验已加载的分页；删除目录不会从缓存恢复其子节点。侧栏可编辑文件夹共用列表的重命名、移动和删除菜单；删除或移动当前目录及其上级目录后返回有效的上级目录。我的资料与共享空间使用目录接口，最近使用跨库文件接口，不提供手动刷新或排序。点击未选中的展开目录进入该目录，点击当前目录可折叠；共享空间与我的资料均直接展示目录树，名称进入根目录；共享空间根目录及可编辑文件夹的“+”提供上传和新建文件夹。团队树分页入口移除后，焦点返回所属团队。当前可管理目录直接上传，最近先选择目标；移动使用同库拖放，文件列表中的文件夹整行作为同一目标；引用和归档的目标选择器分层浏览资料库与文件夹，保留搜索、面包屑和失败重试。新建文件夹只填写名称，添加入口确定保存目录，通用新建入口使用当前可编辑的个人或共享目录，未选中可编辑目录时使用我的资料根目录；成功后进入实际保存目录并更新导航。普通员工可创建共享空间，默认仅创建者可见；顶部“成员”与空间菜单共用成员窗口；所有者在同一窗口选择员工、部门或全公司并直接添加，已有授权列表保持可见，可原位修改权限或移除成员；成员窗口复用原生 Modal、搜索框、分段控件、按钮和权限菜单，沿用详情弹窗的固定标题与内容滚动样式，反馈区预留两行文字，读取失败优先展示当前读取错误，直接显示可滚动的选择列表，切换页码和查询保留已选对象，转让所有权收在更多菜单中。所有者可编辑、删除空间。新建共享空间在保存前可直接关闭、取消或按 Esc 退出，保存期间阻止关闭；已有内容编辑保留放弃修改确认。所有编辑复用原生弹窗；成员变更和内容编辑发生并发冲突后须先成功重新读取当前权限及版本，再明确保存或删除，重新读取保留草稿和文本选区，不重复写入。文件生成保留原生会话草稿追加行为。

## 状态与焦点

目录的“+”与“…”按钮保持透明背景和原有颜色，悬停不增加底色；目录旁的“+”菜单固定操作目标，不依赖右侧当前目录；悬停和键盘焦点显示文件夹操作，鼠标选中不保持显示，预留按钮宽度，展开菜单时保留可见入口。原生 HTML 拖放用于同库文件和文件夹移动，可放入目标使用主题选中背景，移动过程只在源文件报告忙碌，不改变无关按钮的外观。

导航分组统一使用 12px、字重 500，操作与文件树使用 13px，图标和文字按同一轴线排列。未知目录使用静态列表占位，不先显示空列表或插入推挤树节点的加载行；已访问目录即时显示已确认内容并后台校验，写入或刷新后不复用旧版本。后台读取保留筛选和滚动位置。错误保留到成功读取，重试不重建原入口。操作状态只影响相关控件，避免无关按钮变化。

上传弹窗以拖放区为主要入口，选择文件与选择文件夹共享主进程登记和上传回执。文件夹完整保留目录树，包括空目录；失败重试复用已创建的目录和未确认文件的幂等键。新建文件夹的目标固定在打开时，表单不提供二次位置选择。原生 Modal 负责初始焦点与返回焦点。放弃修改确认保留编辑节点、光标和选区；删除或后台结果移除入口时，丢失的焦点交回搜索框，主动移到其他控件的焦点保持原位。

## 权限

个人资料仅本人可读可管理；共享空间按显式成员授权，所有者管理资料库和成员，可编辑成员管理文件，仅查看成员只读。部门与全公司为批量授权对象。界面只根据服务端回执开放操作，每次读写仍由服务端重新授权。普通对话输出不会自动归档。对话成果显式保存时记录来源；共享文件可显示来源类型，仅创建者获得原会话入口。

共享空间的新建与编辑仅填写名称，不提供简介。资料库管理弹窗共用固定顶部位置和宽度；内容超出时由原生弹窗滚动。
