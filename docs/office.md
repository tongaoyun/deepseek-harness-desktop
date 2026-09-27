# Office 文档能力

小胤直接使用 DeepSeek Harness `0.1.7-rc.2` 的官方 Office 能力，不维护独立的文档解析或生成引擎。

## 运行方式

- `office-docx`：Word 文档读取、创建、修改和结构检查。
- `office-xlsx`：Excel 表格读取、计算、创建、修改和结构检查。
- `office-pptx`：PowerPoint 读取、创建、修改和结构检查。
- `load_workspace_dependencies`：返回随安装包提供的 Python 3.12、Office Python 库及其固定版本。
- LibreOffice Kit：负责格式转换、公式重算和页面渲染。
- `present`：声明最终交付文件。

任务开始后，Agent 从技能目录加载对应的官方 Office 技能，按技能原文调用随包运行时。安装包固定并校验 Python、`python-docx`、`python-pptx`、`openpyxl`、`pandas`、Pillow、lxml、XlsxWriter 和 LibreOffice Kit；不依赖员工电脑预装 Python 或 LibreOffice。

## 安装包来源

桌面安装包使用 DeepSeek Harness `0.1.7-rc.2` 的预构建 Primary Runtime 制品。构建时从内部 generic package 下载对应平台归档，并使用 `scripts/official-harness-runtime.json` 中的 SHA-256 校验值验证后解压。当前归档为：

| 平台 | 归档 | SHA-256 |
| --- | --- | --- |
| Windows x64 | `win-x64.tar.gz` | `4f875211fb28cf8547d525b343e74316c8b27c70e67454bd76d729dfdbae3a5e` |
| macOS Intel | `mac-x64.tar.gz` | `b20283bbcb4ebced5b02d1830fb2dfca3b631786ac7af8f6a30b479e82432564` |
| macOS Apple Silicon | `mac-arm64.tar.gz` | `9364ef03063783102f8e4fd9712301ed14271cf927c2757d4dce012bbd614496` |

构建不会复制、补丁化或重新编译 Harness 源码。归档解压后必须包含 `primary-runtime/runtime.json` 和 `office-skills/scripts/check_office.py`，缺失或摘要不匹配时立即失败。`prepare-harness-runtime-macos.sh` 与 `prepare-harness-runtime.ps1` 是唯一的安装包准备入口。

## 文件边界

当前任务的主要工作目录是 Harness 官方文件系统的根目录。小胤负责员工工作目录选择、授权和多目录产品能力；Office 文件的读取、修改、检查与交付由 Harness 工作流完成。

IM 附件只保存原文件，不提前生成第二份解析结果。附件内容是不可信数据；Agent 必须加载相应技能并读取原文件后才能给出结论。

## 验收

本机能力自检检查以下事实：

1. Primary Runtime 清单与当前平台、架构一致。
2. 随包 Python 能导入全部固定 Office 依赖。
3. 三个官方 Office 技能及共享结构检查器存在。
4. LibreOffice Kit 能返回有效能力清单。
5. Harness Shell、文件系统和 `present` 可用。

创建或修改 Office 文件后必须重新打开并执行技能要求的结构检查。需要版面确认时再渲染页面；结构检查、公式重算和视觉检查分别验证不同事实，不能互相替代。
