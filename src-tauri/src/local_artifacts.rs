use crate::local_files::LocalFileAuthorizations;
use std::{path::Path, process::Command};

const ALLOWED_EXTENSIONS: &[&str] = &["doc", "docx", "xls", "xlsx", "pdf", "csv", "txt", "md"];

#[tauri::command]
pub fn open_local_artifact(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    let path = authorizations.resolve_artifact(&root_id, &path)?;
    let path = validate_artifact_path(&path)?;
    let status = platform_open(&path, reveal)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "系统无法{}该文件",
            if reveal { "定位" } else { "打开" }
        ))
    }
}

fn validate_artifact_path(value: &Path) -> Result<std::path::PathBuf, String> {
    let path = value
        .canonicalize()
        .map_err(|_| "文件不存在或已被移动".to_string())?;
    if !path.is_file() {
        return Err("目标不是文件".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("仅支持打开文档、表格、PDF、文本和 Markdown 产物".to_string());
    }
    Ok(path)
}

fn platform_open(path: &Path, reveal: bool) -> Result<std::process::ExitStatus, String> {
    #[cfg(target_os = "windows")]
    let mut command = if reveal {
        let mut value = Command::new("explorer.exe");
        value.arg(format!("/select,{}", path.display()));
        value
    } else {
        let mut value = Command::new("explorer.exe");
        value.arg(path);
        value
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        if reveal {
            value.arg("-R");
        }
        value.arg(path);
        value
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut value = Command::new("xdg-open");
        value.arg(if reveal {
            path.parent().unwrap_or(path)
        } else {
            path
        });
        value
    };
    command
        .status()
        .map_err(|error| format!("无法调用系统文件程序：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_and_unsupported_artifacts() {
        assert!(validate_artifact_path(Path::new("")).is_err());
        assert!(validate_artifact_path(Path::new("/definitely/missing/report.pdf")).is_err());
    }
}
