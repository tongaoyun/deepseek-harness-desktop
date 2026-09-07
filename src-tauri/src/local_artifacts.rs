use crate::local_files::LocalFileAuthorizations;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;
use zip::ZipArchive;

const TEXT_PREVIEW_LIMIT: usize = 2 * 1024 * 1024;
const MEDIA_PREVIEW_LIMIT: usize = 12 * 1024 * 1024;
const CODE_EXTENSIONS: &[&str] = &[
    "c",
    "cc",
    "cpp",
    "cs",
    "css",
    "go",
    "gradle",
    "h",
    "hpp",
    "htm",
    "html",
    "java",
    "js",
    "json",
    "jsx",
    "kt",
    "kts",
    "php",
    "properties",
    "py",
    "rb",
    "rs",
    "scss",
    "sql",
    "swift",
    "toml",
    "ts",
    "tsx",
    "vue",
    "xml",
    "yaml",
    "yml",
];
const TEXT_EXTENSIONS: &[&str] = &["csv", "log", "md", "txt"];
const OFFICE_EXTENSIONS: &[&str] = &["doc", "docx", "ods", "odt", "ppt", "pptx", "xls", "xlsx"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArtifactPreview {
    name: String,
    path: String,
    kind: String,
    language: Option<String>,
    content: Option<String>,
    data_url: Option<String>,
    size_bytes: u64,
    truncated: bool,
}

#[tauri::command]
pub fn read_local_artifact_preview(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
) -> Result<LocalArtifactPreview, String> {
    let target = authorizations.resolve_artifact(&root_id, &path)?;
    preview_file(&validate_artifact_path(&target)?, path)
}

#[tauri::command]
pub fn reveal_local_artifact(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
) -> Result<(), String> {
    let target = authorizations.resolve_artifact(&root_id, &path)?;
    let target = validate_artifact_path(&target)?;
    let status = platform_reveal(&target)?;
    if status.success() {
        Ok(())
    } else {
        Err("系统无法在文件夹中定位该文件".to_string())
    }
}

#[tauri::command]
pub fn read_harness_image_preview(
    app: tauri::AppHandle,
    attachment_id: String,
    media_type: String,
) -> Result<String, String> {
    let hash = attachment_id
        .strip_prefix("sha256:")
        .filter(|value| {
            value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| "截图标识无效".to_string())?;
    let mime = match media_type.as_str() {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        _ => return Err("截图格式不支持".to_string()),
    };
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定 Harness 数据目录：{error}"))?;
    let path = root
        .join("harness")
        .join("attachments")
        .join(format!("{hash}.image"));
    let (bytes, truncated) = read_limited(&path, 5 * 1024 * 1024)?;
    if truncated || format!("{:x}", Sha256::digest(&bytes)) != hash.to_ascii_lowercase() {
        return Err("截图内容不完整或已损坏".to_string());
    }
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn preview_file(target: &Path, relative_path: String) -> Result<LocalArtifactPreview, String> {
    let metadata = target
        .metadata()
        .map_err(|error| format!("无法读取文件信息：{error}"))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("文件")
        .to_string();
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if let Some(mime) = image_mime(&extension) {
        let (bytes, truncated) = read_limited(target, MEDIA_PREVIEW_LIMIT)?;
        return Ok(LocalArtifactPreview {
            name,
            path: relative_path,
            kind: "image".to_string(),
            language: None,
            content: None,
            data_url: (!truncated).then(|| format!("data:{mime};base64,{}", BASE64.encode(bytes))),
            size_bytes: metadata.len(),
            truncated,
        });
    }
    if extension == "pdf" {
        let (bytes, truncated) = read_limited(target, MEDIA_PREVIEW_LIMIT)?;
        return Ok(LocalArtifactPreview {
            name,
            path: relative_path,
            kind: "pdf".to_string(),
            language: None,
            content: None,
            data_url: (!truncated)
                .then(|| format!("data:application/pdf;base64,{}", BASE64.encode(bytes))),
            size_bytes: metadata.len(),
            truncated,
        });
    }
    if OFFICE_EXTENSIONS.contains(&extension.as_str()) {
        let content = preview_office_text(target, &extension)?;
        return Ok(LocalArtifactPreview {
            name,
            path: relative_path,
            kind: "office".to_string(),
            language: Some(extension),
            content,
            data_url: None,
            size_bytes: metadata.len(),
            truncated: false,
        });
    }

    let (bytes, truncated) = read_limited(target, TEXT_PREVIEW_LIMIT)?;
    let known_text = CODE_EXTENSIONS.contains(&extension.as_str())
        || TEXT_EXTENSIONS.contains(&extension.as_str())
        || extension.is_empty();
    let content = if known_text {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        String::from_utf8(bytes).ok()
    };
    Ok(LocalArtifactPreview {
        name,
        path: relative_path,
        kind: if CODE_EXTENSIONS.contains(&extension.as_str()) {
            "code"
        } else if content.is_some() {
            "text"
        } else {
            "file"
        }
        .to_string(),
        language: (!extension.is_empty()).then_some(extension),
        content,
        data_url: None,
        size_bytes: metadata.len(),
        truncated,
    })
}

fn preview_office_text(target: &Path, extension: &str) -> Result<Option<String>, String> {
    if matches!(extension, "doc" | "ppt" | "xls") {
        return Ok(None);
    }
    let file = File::open(target).map_err(|error| format!("无法打开 Office 文件：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Office 文件结构无效：{error}"))?;
    let content = match extension {
        "docx" => read_zip_entry(&mut archive, "word/document.xml")
            .map(|value| office_xml_text(&value, &["</w:p>", "</w:tr>"], &["</w:tc>"]))?,
        "pptx" => {
            let mut names = (0..archive.len())
                .filter_map(|index| {
                    archive
                        .by_index(index)
                        .ok()
                        .map(|entry| entry.name().to_string())
                })
                .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
                .collect::<Vec<_>>();
            names.sort_by_key(|name| numeric_suffix(name));
            let mut slides = Vec::new();
            for (index, name) in names.iter().enumerate().take(200) {
                let xml = read_zip_entry(&mut archive, name)?;
                let text = office_xml_text(&xml, &["</a:p>"], &[]);
                if !text.trim().is_empty() {
                    slides.push(format!("第 {} 页\n{}", index + 1, text.trim()));
                }
            }
            slides.join("\n\n")
        }
        "xlsx" | "ods" => preview_sheet_text(&mut archive, extension)?,
        "odt" => read_zip_entry(&mut archive, "content.xml").map(|value| {
            office_xml_text(
                &value,
                &["</text:p>", "</table:table-row>"],
                &["</table:table-cell>"],
            )
        })?,
        _ => String::new(),
    };
    Ok((!content.trim().is_empty()).then(|| content.chars().take(500_000).collect()))
}

fn preview_sheet_text(archive: &mut ZipArchive<File>, extension: &str) -> Result<String, String> {
    if extension == "ods" {
        return read_zip_entry(archive, "content.xml").map(|value| {
            office_xml_text(&value, &["</table:table-row>"], &["</table:table-cell>"])
        });
    }
    let shared = read_zip_entry_optional(archive, "xl/sharedStrings.xml")?
        .map(|xml| {
            xml_blocks(&xml, "si")
                .into_iter()
                .map(|value| office_xml_text(value, &[], &[]))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut names = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|entry| entry.name().to_string())
        })
        .filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .collect::<Vec<_>>();
    names.sort_by_key(|name| numeric_suffix(name));
    let mut sheets = Vec::new();
    for (sheet_index, name) in names.iter().enumerate().take(100) {
        let xml = read_zip_entry(archive, name)?;
        let rows = xml_blocks(&xml, "row")
            .into_iter()
            .take(10_000)
            .map(|row| {
                let mut cells = Vec::new();
                for cell in xml_blocks(row, "c") {
                    let column = xml_attribute(cell, "r")
                        .and_then(spreadsheet_column)
                        .unwrap_or(cells.len());
                    if column >= 16_384 {
                        continue;
                    }
                    let raw = xml_tag_value(cell, "v")
                        .filter(|value| !value.is_empty())
                        .or_else(|| xml_tag_value(cell, "t"))
                        .unwrap_or_else(|| {
                            xml_tag_value(cell, "f")
                                .filter(|formula| !formula.is_empty())
                                .map(|formula| format!("[公式：{formula}；待重算]"))
                                .unwrap_or_default()
                        });
                    let value = if xml_attribute(cell, "t") == Some("s") {
                        raw.parse::<usize>()
                            .ok()
                            .and_then(|index| shared.get(index))
                            .cloned()
                            .unwrap_or(raw)
                    } else {
                        decode_xml_entities(&raw)
                    };
                    if cells.len() <= column {
                        cells.resize(column + 1, String::new());
                    }
                    cells[column] = value;
                }
                cells.join("\t")
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !rows.trim().is_empty() {
            sheets.push(format!("工作表 {}\n{}", sheet_index + 1, rows));
        }
    }
    Ok(sheets.join("\n\n"))
}

fn read_zip_entry(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    let entry = archive
        .by_name(name)
        .map_err(|_| format!("Office 文件缺少 {name}"))?;
    let mut value = String::new();
    entry
        .take(4 * 1024 * 1024)
        .read_to_string(&mut value)
        .map_err(|error| format!("无法读取 Office 内容：{error}"))?;
    Ok(value)
}

fn read_zip_entry_optional(
    archive: &mut ZipArchive<File>,
    name: &str,
) -> Result<Option<String>, String> {
    match archive.by_name(name) {
        Ok(entry) => {
            let mut value = String::new();
            entry
                .take(4 * 1024 * 1024)
                .read_to_string(&mut value)
                .map_err(|error| format!("无法读取 Office 内容：{error}"))?;
            Ok(Some(value))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(error) => Err(format!("Office 文件结构无效：{error}")),
    }
}

fn office_xml_text(xml: &str, line_breaks: &[&str], tabs: &[&str]) -> String {
    let mut normalized = xml.to_string();
    for marker in line_breaks {
        normalized = normalized.replace(marker, "\n");
    }
    for marker in tabs {
        normalized = normalized.replace(marker, "\t");
    }
    let mut text = String::with_capacity(normalized.len());
    let mut in_tag = false;
    for character in normalized.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    decode_xml_entities(&text)
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let start = format!("<{tag}");
    let end = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut remaining = xml;
    while let Some(begin) = remaining.find(&start) {
        let candidate = &remaining[begin..];
        if !candidate
            .as_bytes()
            .get(start.len())
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>' || *byte == b'/')
        {
            remaining = &candidate[start.len()..];
            continue;
        }
        let Some(header_end) = candidate.find('>') else {
            break;
        };
        if candidate[..header_end].ends_with('/') {
            blocks.push(&candidate[..=header_end]);
            remaining = &candidate[header_end + 1..];
            continue;
        }
        let Some(close) = candidate.find(&end) else {
            break;
        };
        let block_end = close + end.len();
        blocks.push(&candidate[..block_end]);
        remaining = &candidate[block_end..];
    }
    blocks
}

fn xml_attribute<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let header = xml.split('>').next()?;
    for quote in ['"', '\''] {
        let marker = format!(" {name}={quote}");
        if let Some((_, value)) = header.split_once(&marker) {
            return value.split(quote).next();
        }
    }
    None
}

fn spreadsheet_column(reference: &str) -> Option<usize> {
    let mut column = 0usize;
    for letter in reference.bytes().take_while(u8::is_ascii_alphabetic) {
        column = column
            .checked_mul(26)?
            .checked_add((letter.to_ascii_uppercase() - b'A' + 1) as usize)?;
    }
    column.checked_sub(1)
}

fn xml_tag_value(xml: &str, tag: &str) -> Option<String> {
    let block = xml_blocks(xml, tag).into_iter().next()?;
    Some(office_xml_text(block, &[], &[]))
}

fn numeric_suffix(value: &str) -> u32 {
    value
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(u32::MAX)
}

fn read_limited(path: &Path, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| format!("无法打开文件：{error}"))?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取文件：{error}"))?;
    let truncated = bytes.len() > limit;
    if truncated {
        bytes.truncate(limit);
    }
    Ok((bytes, truncated))
}

fn image_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn validate_artifact_path(value: &Path) -> Result<PathBuf, String> {
    let path = value
        .canonicalize()
        .map_err(crate::local_files::artifact_io_error)?;
    if !path.is_file() {
        return Err("目标不是文件".to_string());
    }
    Ok(path)
}

fn platform_reveal(path: &Path) -> Result<std::process::ExitStatus, String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = Command::new("explorer.exe");
        value.arg(format!("/select,{}", path.display()));
        value
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg("-R").arg(path);
        value
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut value = Command::new("xdg-open");
        value.arg(path.parent().unwrap_or(path));
        value
    };
    command
        .status()
        .map_err(|error| format!("无法调用系统文件程序：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "xiaoyin-artifact-preview-{}-{label}",
            std::process::id()
        ))
    }

    #[test]
    fn spreadsheet_preview_preserves_blank_columns_and_missing_formula_results() {
        use std::io::Write;
        let root = temporary_root("sparse-xlsx");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("sparse.xlsx");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file(
                "xl/worksheets/sheet1.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(br#"<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>total</t></is></c><c r="C1"/><c r="E1"><v>167.5</v></c></row><row r="2"><c r='C2'><f>SUM(A1:B1)</f><v/></c></row></sheetData></worksheet>"#).unwrap();
        writer.finish().unwrap();
        let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        assert_eq!(
            preview_sheet_text(&mut archive, "xlsx").unwrap(),
            "工作表 1\n\ttotal\t\t\t167.5\n\t\t[公式：SUM(A1:B1)；待重算]"
        );
        assert_eq!(
            xml_blocks("<cols/><c r=\"A1\"/><c r=\"B1\"><v>0</v></c>", "c").len(),
            2
        );
        assert_eq!(spreadsheet_column("AA12"), Some(26));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_artifacts() {
        assert!(validate_artifact_path(Path::new("")).is_err());
        assert!(validate_artifact_path(Path::new("/definitely/missing/report.pdf")).is_err());
    }

    #[test]
    fn previews_code_and_configuration_files() {
        let root = temporary_root("code");
        std::fs::create_dir_all(&root).unwrap();
        for name in [
            "DemoApplication.java",
            "pom.xml",
            "application.yml",
            "App.tsx",
        ] {
            let path = root.join(name);
            std::fs::write(&path, format!("content of {name}")).unwrap();
            let preview = preview_file(&path, name.to_string()).unwrap();
            assert_eq!(preview.kind, "code", "{name}");
            assert!(preview.content.unwrap().contains(name));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn returns_images_as_embedded_preview_data() {
        let root = temporary_root("image");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("preview.png");
        std::fs::write(&path, b"png bytes").unwrap();
        let preview = preview_file(&path, "preview.png".to_string()).unwrap();
        assert_eq!(preview.kind, "image");
        assert!(
            preview
                .data_url
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
