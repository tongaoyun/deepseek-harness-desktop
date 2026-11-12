---
version: 1
slug: "product-src-client-knowledgeworkspace-tsx-b1297a25"
primary_target: "packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeWorkspace.tsx"
related_targets: ["packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeLibraryDirectory.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeLibraryActions.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeDocuments.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeProcessingDetails.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeDestination.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeUploadDialog.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeEditor.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeBaseEditor.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeContentSearch.tsx","packages/extensions/ui-deepseek-harness-product/src/client/KnowledgeParsedContent.tsx","packages/extensions/ui-deepseek-harness-product/src/DeepSeekHarnessProduct.module.css"]
---

# 知识库工作区

本页限定知识库目录、资料管理和页内阅读的设计范围。布局、主题、尺寸与控件规则统一见[设计规范](../../DESIGN.md#知识工作区设计规范)，权限、检索范围和操作行为见[模块说明](../../README.md#knowledge)。

## 页面结构

先选择个人、部门或公司知识库，再进入资料列表与原件阅读。返回目录保留查询、范围和焦点，离开知识库取消在途读取。工作区复用 Harness 原生主题、字体、按钮、菜单、弹窗、提示和预览。

## 操作与状态

“添加资料”集中提供上传文件、导入网页、新建文档和新建文件夹。创建和上传始终显示真实目标路径；位置未确认时不得默认为库根目录。PDF 处理方式在上传开始后固定，重试沿用同一文件、位置和操作标识。

首屏使用静态占位与加载文字，刷新保留已确认内容。空目录、筛选无结果和读取失败分别展示；失权后移除资料与管理操作，保留返回和重新核对入口。

正文检索、解析内容和处理详情在当前工作区内展示。原件使用原生预览，解析内容使用原生 MarkdownText；禁止显示上游原始诊断或虚构进度。

## 视觉验收

覆盖浅色、深色及桌面、平板、手机宽度。检查文本对比度、控件换行、键盘焦点和权限状态；目录卡片与资料表格保持平面，浮层深度由原生菜单和弹窗负责。
