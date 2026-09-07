# Office 工具

本机工具支持 DOCX、XLSX、PPTX 和 PDF 的读取、生成、检查与交付。文件访问限定在任务授权目录。

## 工具职责

| 工具 | 作用 |
| --- | --- |
| `office_document_read` | 提取文档内容与表格数据 |
| `office_document_check` | 只读检查结构、公式错误与缺失计算结果 |
| `office_pdf_page` | 渲染指定 PDF 页供视觉核对 |
| `office_engine_status` | 检测 LibreOffice |
| `office_xlsx_recalculate` | 真实重算 XLSX 并保存新副本 |
| `office_document_export_pdf` | 将 DOCX、XLSX、PPTX 导出为 PDF |
| `office_xlsx_format_sheet` | 调整列宽、换行、估算行高和打印范围 |

转换工具接收 `rootId`、源文件 `path` 和新文件 `outputPath`。保存成功后返回路径、哈希及检查结果；源文件和已存在的目标保持不变。

## 公式与检查

公式使用 `{"formula":"C2*D2"}` 显式声明，不接受调用方伪造缓存结果。以 `=` 开头的普通字符串按文本存储。只有真实重算后才能核对计算结果，数值 `0` 和布尔 `false` 均保留。

结构检查最多扫描 100000 个非空单元格、报告 100 项问题，并标记截断。表格格式调整最多处理 2000 行、100 列，不自动处理合并单元格。结构检查和行高估算不能替代公式业务校验与导出后的页面核对。

PDF 每次渲染一页，宽度 1400 像素，文件上限 25 MiB。视觉核对需要可处理图像的模型；扫描件文本识别与页面渲染是不同步骤。

## LibreOffice

公式重算和 Office 转 PDF 依赖本机 [LibreOffice](https://www.libreoffice.org/download/)，普通文档生成可独立运行。

按 `XIAOYIN_SOFFICE_PATH`、标准安装目录和 PATH 查找。Mac 支持系统及用户 Applications 目录；Windows 支持 Program Files 下的 LibreOffice。环境变量需要传入原生应用或 Host 进程，配置后重启。

转换使用独立用户配置与临时目录，单文件输入、输出上限均为 25 MiB，超时 90 秒。停止或超时清理进程树与临时文件；成功退出但未生成结果判为失败。输出目录需要支持硬链接。

Mac 中文转换需要中文字库。默认临时 Fontconfig 配置加载系统、全局和用户字体；显式 `FONTCONFIG_FILE` 使用调用方配置。可安装 Noto Sans CJK SC。

含宏、外部工作簿链接、专有函数、数据连接或复杂版面的文件，应在对应办公应用中核对。交付前分别确认源文件、公式结果、页面布局与业务数据。
