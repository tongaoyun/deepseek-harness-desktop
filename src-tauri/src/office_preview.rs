use calamine::{Data, Reader, open_workbook_auto};
use roxmltree::{Document, Node};
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};
use zip::ZipArchive;

const XML_LIMIT: u64 = 16 * 1024 * 1024;
const ARCHIVE_LIMIT: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 1_000;
const MAX_COLUMNS: usize = 100;
const MAX_SHEETS: usize = 20;
const MAX_CELLS: usize = 50_000;
const MAX_TEXT: usize = 500_000;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum StructuredPreview {
    Spreadsheet { sheets: Vec<PreviewSheet> },
    Document { blocks: Vec<PreviewBlock> },
    Presentation { slides: Vec<Vec<PreviewBlock>> },
}

impl StructuredPreview {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Spreadsheet { .. } => "spreadsheet",
            Self::Document { .. } => "document",
            Self::Presentation { .. } => "presentation",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewSheet {
    name: String,
    rows: Vec<Vec<PreviewCell>>,
    row_offset: u32,
    column_offset: u32,
    truncated: bool,
}

#[derive(Serialize)]
pub(crate) struct PreviewCell {
    value: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    formula: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum PreviewBlock {
    Paragraph { text: String, level: u8 },
    Table { rows: Vec<Vec<String>> },
}

#[derive(Default)]
struct Budget {
    text: usize,
    cells: usize,
    truncated: bool,
}

impl Budget {
    fn text(&mut self, text: String) -> String {
        let remaining = MAX_TEXT.saturating_sub(self.text);
        let length = text.chars().count();
        self.truncated |= length > remaining;
        self.text += length.min(remaining);
        text.chars().take(remaining).collect()
    }
}

pub(crate) fn read(path: &Path, extension: &str) -> Result<(StructuredPreview, bool), String> {
    if path.metadata().map_err(|_| "无法读取文件信息")?.len() > 25 * 1024 * 1024 {
        return Err("文件超过 25 MiB，请使用本机应用打开".into());
    }
    let mut budget = Budget::default();
    let preview = match extension {
        "csv" | "tsv" => csv_preview(path, extension, &mut budget)?,
        "xlsx" => {
            let mut archive = archive(path)?;
            // Bound sparse worksheet dimensions before the spreadsheet reader allocates a range.
            for index in 0..archive.len() {
                let name = archive
                    .by_index(index)
                    .map_err(|_| "无法读取表格结构")?
                    .name()
                    .to_string();
                if name.starts_with("xl/worksheets/") && name.ends_with(".xml") {
                    let xml = read_xml(&mut archive, &name)?;
                    validate_sheet_dimensions(&parse_xml(&xml)?)?;
                }
            }
            spreadsheet_preview(path, &mut budget)?
        }
        "docx" | "odt" => {
            let mut archive = archive(path)?;
            let xml = read_xml(
                &mut archive,
                if extension == "docx" {
                    "word/document.xml"
                } else {
                    "content.xml"
                },
            )?;
            let document = parse_xml(&xml)?;
            let body_name = if extension == "docx" { "body" } else { "text" };
            let body = document
                .descendants()
                .find(|node| node.has_tag_name(body_name))
                .ok_or("文档缺少正文")?;
            StructuredPreview::Document {
                blocks: document_blocks(body, extension == "odt", &mut budget),
            }
        }
        "pptx" => presentation_preview(&mut archive(path)?, &mut budget)?,
        _ => return Err("该格式不支持内容预览".into()),
    };
    Ok((preview, budget.truncated))
}

fn archive(path: &Path) -> Result<ZipArchive<File>, String> {
    let mut archive = ZipArchive::new(File::open(path).map_err(|_| "无法打开 Office 文件")?)
        .map_err(|_| "Office 文件结构无效")?;
    if archive.len() > 4_000 {
        return Err("Office 文件包含过多内容部件".into());
    }
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "无法读取 Office 结构")?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > ARCHIVE_LIMIT {
            return Err("Office 解压内容超过 64 MiB，请使用本机应用打开".into());
        }
    }
    Ok(archive)
}

fn read_xml(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    let entry = archive
        .by_name(name)
        .map_err(|_| format!("Office 文件缺少 {name}"))?;
    if entry.size() > XML_LIMIT {
        return Err("Office 内容部件超过预览大小限制".into());
    }
    let mut content = String::new();
    entry
        .take(XML_LIMIT + 1)
        .read_to_string(&mut content)
        .map_err(|_| "Office 内容无法读取")?;
    if content.len() as u64 > XML_LIMIT {
        return Err("Office 内容部件超过预览大小限制".into());
    }
    Ok(content)
}

fn parse_xml(xml: &str) -> Result<Document<'_>, String> {
    Document::parse(xml).map_err(|_| "Office XML 内容损坏，无法完整预览".into())
}

fn validate_sheet_dimensions(document: &Document<'_>) -> Result<(), String> {
    let mut max_row = 0u64;
    let mut max_column = 0u64;
    for formula in document.descendants().filter(|node| node.has_tag_name("f")) {
        if let Some(index) = formula.attribute("si")
            && index.parse::<u64>().map_err(|_| "共享公式标识无效")? > 50_000
        {
            return Err("工作表共享公式索引超过预览限制".into());
        }
    }
    for node in document.descendants().filter(|node| node.has_tag_name("c")) {
        let reference = node.attribute("r").ok_or("表格单元格缺少地址")?;
        let split = reference
            .find(|character: char| character.is_ascii_digit())
            .ok_or("表格单元格地址无效")?;
        let mut column = 0u64;
        for letter in reference[..split].bytes() {
            if !letter.is_ascii_alphabetic() {
                return Err("表格单元格地址无效".into());
            }
            column = column
                .saturating_mul(26)
                .saturating_add((letter.to_ascii_uppercase() - b'A' + 1) as u64);
        }
        let row = reference[split..]
            .parse::<u64>()
            .map_err(|_| "表格单元格地址无效")?;
        if row == 0 || column == 0 {
            return Err("表格单元格地址无效".into());
        }
        max_row = max_row.max(row);
        max_column = max_column.max(column);
        if max_row.saturating_mul(max_column) > 1_000_000 {
            return Err("工作表范围过大，请使用本机表格应用打开".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

fn spreadsheet_preview(path: &Path, budget: &mut Budget) -> Result<StructuredPreview, String> {
    let mut workbook = open_workbook_auto(path).map_err(|_| "表格文件结构无效")?;
    let names = workbook.sheet_names().to_vec();
    budget.truncated |= names.len() > MAX_SHEETS;
    let mut sheets = Vec::new();
    for name in names.into_iter().take(MAX_SHEETS) {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|_| format!("无法读取工作表 {name}"))?;
        let formulas = workbook
            .worksheet_formula(&name)
            .map_err(|_| format!("无法读取工作表 {name} 的公式"))?;
        let start = match (range.start(), formulas.start()) {
            (Some(a), Some(b)) => (a.0.min(b.0), a.1.min(b.1)),
            (a, b) => a.or(b).unwrap_or_default(),
        };
        let end = match (range.end(), formulas.end()) {
            (Some(a), Some(b)) => Some((a.0.max(b.0), a.1.max(b.1))),
            (a, b) => a.or(b),
        };
        let mut rows = Vec::new();
        let mut truncated = false;
        if let Some(end) = end {
            let height = (end.0 - start.0 + 1) as usize;
            let width = (end.1 - start.1 + 1) as usize;
            truncated |= height > MAX_ROWS || width > MAX_COLUMNS;
            for row in 0..height.min(MAX_ROWS) {
                if budget.cells + width.min(MAX_COLUMNS) > MAX_CELLS || budget.text >= MAX_TEXT {
                    truncated = true;
                    break;
                }
                let mut cells = Vec::new();
                for column in 0..width.min(MAX_COLUMNS) {
                    let position = (start.0 + row as u32, start.1 + column as u32);
                    let value = range.get_value(position).unwrap_or(&Data::Empty);
                    let formula = formulas
                        .get_value(position)
                        .filter(|formula| !formula.is_empty())
                        .cloned();
                    let (text, kind) = match value {
                        Data::Int(_) | Data::Float(_) => (value.to_string(), "number"),
                        Data::Bool(value) => {
                            (if *value { "TRUE" } else { "FALSE" }.into(), "boolean")
                        }
                        Data::DateTime(value) => (
                            value
                                .as_datetime()
                                .map(|date| date.to_string())
                                .unwrap_or_else(|| value.to_string()),
                            "date",
                        ),
                        Data::Error(_) => (value.to_string(), "error"),
                        _ => (value.to_string(), "text"),
                    };
                    cells.push(PreviewCell {
                        value: budget.text(text),
                        kind,
                        formula: formula.map(|value| budget.text(value)),
                    });
                }
                budget.cells += cells.len();
                rows.push(cells);
            }
        }
        budget.truncated |= truncated;
        sheets.push(PreviewSheet {
            name,
            rows,
            row_offset: start.0,
            column_offset: start.1,
            truncated,
        });
    }
    Ok(StructuredPreview::Spreadsheet { sheets })
}

fn csv_preview(
    path: &Path,
    extension: &str,
    budget: &mut Budget,
) -> Result<StructuredPreview, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(if extension == "tsv" { b'\t' } else { b',' })
        .from_path(path)
        .map_err(|_| "无法打开表格文件")?;
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|_| "表格文本无法解析，请检查编码与引号")?;
        if rows.len() >= MAX_ROWS
            || budget.cells + record.len().min(MAX_COLUMNS) > MAX_CELLS
            || budget.text >= MAX_TEXT
        {
            budget.truncated = true;
            break;
        }
        budget.truncated |= record.len() > MAX_COLUMNS;
        budget.cells += record.len().min(MAX_COLUMNS);
        rows.push(
            record
                .iter()
                .take(MAX_COLUMNS)
                .map(|value| PreviewCell {
                    value: budget.text(value.into()),
                    kind: "text",
                    formula: None,
                })
                .collect(),
        );
    }
    Ok(StructuredPreview::Spreadsheet {
        sheets: vec![PreviewSheet {
            name: path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            rows,
            row_offset: 0,
            column_offset: 0,
            truncated: budget.truncated,
        }],
    })
}

fn document_blocks(body: Node<'_, '_>, odf: bool, budget: &mut Budget) -> Vec<PreviewBlock> {
    let mut blocks = Vec::new();
    for node in body.children().filter(Node::is_element) {
        if blocks.len() >= 2_000 || budget.text >= MAX_TEXT {
            budget.truncated = true;
            break;
        }
        match node.tag_name().name() {
            "p" | "h" => {
                let level = node
                    .descendants()
                    .find(|child| child.has_tag_name("pStyle"))
                    .and_then(|child| child.attributes().find(|attr| attr.name() == "val"))
                    .and_then(|attr| {
                        attr.value()
                            .to_ascii_lowercase()
                            .strip_prefix("heading")
                            .and_then(|value| value.parse::<u8>().ok())
                    })
                    .or_else(|| {
                        node.attributes()
                            .find(|attr| attr.name() == "outline-level")
                            .and_then(|attr| attr.value().parse().ok())
                    })
                    .unwrap_or(0)
                    .min(6);
                blocks.push(PreviewBlock::Paragraph {
                    text: budget.text(paragraph_text(node, odf)),
                    level,
                });
            }
            "tbl" | "table" => {
                let mut rows = Vec::new();
                for row in node
                    .children()
                    .filter(|child| matches!(child.tag_name().name(), "tr" | "table-row"))
                {
                    if rows.len() >= 200 {
                        budget.truncated = true;
                        break;
                    }
                    let mut cells = Vec::new();
                    for cell in row
                        .children()
                        .filter(|child| matches!(child.tag_name().name(), "tc" | "table-cell"))
                    {
                        if cells.len() >= 50 {
                            budget.truncated = true;
                            break;
                        }
                        let text = cell
                            .descendants()
                            .filter(|child| child.has_tag_name("p"))
                            .map(|paragraph| paragraph_text(paragraph, odf))
                            .collect::<Vec<_>>()
                            .join("\n");
                        cells.push(budget.text(text));
                    }
                    rows.push(cells);
                }
                blocks.push(PreviewBlock::Table { rows });
            }
            _ => {}
        }
    }
    blocks
}

fn paragraph_text(node: Node<'_, '_>, odf: bool) -> String {
    let mut text = String::new();
    for child in node.descendants() {
        if odf && child.is_text() {
            text.push_str(child.text().unwrap_or_default());
        }
        if !child.is_element() {
            continue;
        }
        match child.tag_name().name() {
            "t" if !odf => text.push_str(child.text().unwrap_or_default()),
            "tab" => text.push('\t'),
            "br" | "line-break" => text.push('\n'),
            _ => {}
        }
    }
    text
}

fn presentation_preview(
    archive: &mut ZipArchive<File>,
    budget: &mut Budget,
) -> Result<StructuredPreview, String> {
    let manifest_xml = read_xml(archive, "ppt/presentation.xml")?;
    let relations_xml = read_xml(archive, "ppt/_rels/presentation.xml.rels")?;
    let manifest = parse_xml(&manifest_xml)?;
    let relations = parse_xml(&relations_xml)?;
    let mut slides = Vec::new();
    for slide in manifest
        .descendants()
        .filter(|node| node.has_tag_name("sldId"))
    {
        if slides.len() >= 100 || budget.text >= MAX_TEXT {
            budget.truncated = true;
            break;
        }
        let id = slide
            .attributes()
            .find(|attr| attr.name() == "id" && attr.namespace().is_some())
            .map(|attr| attr.value())
            .ok_or("演示稿页面缺少关联标识")?;
        let relation = relations
            .descendants()
            .find(|node| node.attribute("Id") == Some(id))
            .ok_or("演示稿页面关联不存在")?;
        if relation.attribute("TargetMode") == Some("External") {
            return Err("演示稿页面不能引用外部地址".into());
        }
        let target = relation.attribute("Target").ok_or("演示稿页面路径缺失")?;
        let path = if target.starts_with('/') {
            target.trim_start_matches('/').to_string()
        } else {
            format!("ppt/{target}")
        };
        let xml = read_xml(archive, &path)?;
        let document = parse_xml(&xml)?;
        let mut blocks = Vec::new();
        for paragraph in document.descendants().filter(|node| node.has_tag_name("p")) {
            if blocks.len() >= 2_000 || budget.text >= MAX_TEXT {
                budget.truncated = true;
                break;
            }
            blocks.push(PreviewBlock::Paragraph {
                text: budget.text(paragraph_text(paragraph, false)),
                level: 0,
            });
        }
        slides.push(blocks);
    }
    Ok(StructuredPreview::Presentation { slides })
}
