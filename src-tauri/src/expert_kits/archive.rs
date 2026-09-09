use super::{KIT_MANIFEST_PATH, SKILL_MANIFEST_PATH, child_directories, validate_relative_path};
use flate2::read::GzDecoder;
use std::{
    fs::{self, File},
    io::Cursor,
    path::{Component, Path, PathBuf},
};

const MAX_EXTRACTED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 1024;

pub(super) fn extract_package(bytes: &[u8], destination: &Path) -> Result<(), String> {
    if bytes.starts_with(b"PK\x03\x04") {
        return extract_zip_package(bytes, destination);
    }
    extract_tar_gzip_package(bytes, destination)
}

fn extract_tar_gzip_package(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("专家套件压缩包无效：{error}"))?;
    let mut count = 0usize;
    let mut extracted_bytes = 0u64;
    for entry in entries {
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err("专家套件文件数量超过限制".to_string());
        }
        let mut entry = entry.map_err(|error| format!("读取专家套件条目失败：{error}"))?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("专家套件不能包含符号链接或特殊文件".to_string());
        }
        let path = entry
            .path()
            .map_err(|error| format!("专家套件路径无效：{error}"))?
            .into_owned();
        let Some(path) = normalized_archive_entry_path(&path)? else {
            if entry_type.is_dir() {
                continue;
            }
            return Err("专家套件根路径不能是文件".to_string());
        };
        validate_relative_path(&path)?;
        let output = destination.join(&path);
        if entry_type.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("无法创建套件目录：{error}"))?;
            continue;
        }
        let size = entry
            .header()
            .size()
            .map_err(|error| format!("套件文件大小无效：{error}"))?;
        extracted_bytes = extracted_bytes
            .checked_add(size)
            .ok_or_else(|| "专家套件解压大小无效".to_string())?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("专家套件解压后超过 64 MiB 限制".to_string());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建套件文件目录：{error}"))?;
        }
        let mut file =
            File::create(&output).map_err(|error| format!("无法创建套件文件：{error}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("无法写入套件文件：{error}"))?;
    }
    Ok(())
}

fn extract_zip_package(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("技能 ZIP 压缩包无效：{error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("技能文件数量超过限制".to_string());
    }
    let mut extracted_bytes = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取技能 ZIP 条目失败：{error}"))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("技能不能包含符号链接".to_string());
        }
        let path = entry
            .enclosed_name()
            .ok_or_else(|| "技能 ZIP 路径无效".to_string())?
            .to_path_buf();
        let Some(path) = normalized_archive_entry_path(&path)? else {
            if entry.is_dir() {
                continue;
            }
            return Err("技能 ZIP 根路径不能是文件".to_string());
        };
        validate_relative_path(&path)?;
        let output = destination.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("无法创建技能目录：{error}"))?;
            continue;
        }
        extracted_bytes = extracted_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "技能解压大小无效".to_string())?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("技能解压后超过 64 MiB 限制".to_string());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建技能文件目录：{error}"))?;
        }
        let mut file =
            File::create(&output).map_err(|error| format!("无法创建技能文件：{error}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("无法写入技能文件：{error}"))?;
    }
    Ok(())
}

pub(super) fn package_root(staging_directory: &Path) -> Result<PathBuf, String> {
    if has_extension_manifest(staging_directory) {
        return Ok(staging_directory.to_path_buf());
    }
    let children = child_directories(staging_directory)?;
    if children.len() == 1 && has_extension_manifest(&children[0]) {
        return Ok(children[0].clone());
    }
    Err("扩展缺少根级清单，或压缩包目录结构无效".to_string())
}

fn has_extension_manifest(root: &Path) -> bool {
    root.join(KIT_MANIFEST_PATH).is_file()
        || root.join(SKILL_MANIFEST_PATH).is_file()
        || super::qoder_import::has_import_entry(root)
}

fn normalized_archive_entry_path(path: &Path) -> Result<Option<PathBuf>, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            _ => return Err("专家套件包含不安全路径".to_string()),
        }
    }
    Ok((!normalized.as_os_str().is_empty()).then_some(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_root_markers_are_normalized_without_weakening_traversal_checks() {
        assert_eq!(
            normalized_archive_entry_path(Path::new("./skills/report/SKILL.md")).unwrap(),
            Some(PathBuf::from("skills/report/SKILL.md"))
        );
        assert_eq!(normalized_archive_entry_path(Path::new(".")).unwrap(), None);
        assert!(normalized_archive_entry_path(Path::new("../outside")).is_err());
        assert!(normalized_archive_entry_path(Path::new("/absolute")).is_err());
    }
}
