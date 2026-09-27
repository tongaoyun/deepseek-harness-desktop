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
use tauri_plugin_opener::OpenerExt;

const TEXT_PREVIEW_LIMIT: usize = 2 * 1024 * 1024;
const MEDIA_PREVIEW_LIMIT: usize = 12 * 1024 * 1024;
pub(crate) const HTML_PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

pub(crate) fn html_preview_response(
    authorizations: &LocalFileAuthorizations,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let result = (|| {
        if request.method() != tauri::http::Method::GET {
            return Err("预览请求无效".to_string());
        }
        let decoded =
            percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/'))
                .decode_utf8()
                .map_err(|_| "文件路径编码无效")?;
        let (root_id, path) = decoded.split_once('/').ok_or("文件预览路径无效")?;
        let target = authorizations.resolve_artifact(root_id, path)?;
        html_preview_bytes(&validate_artifact_path(&target)?)
    })();
    let (status, content_type, body) = match result {
        Ok(bytes) => (200, "text/html; charset=utf-8", bytes),
        Err(error) => (400, "text/plain; charset=utf-8", error.into_bytes()),
    };
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", HTML_PREVIEW_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .expect("valid HTML preview response")
}

fn html_preview_bytes(path: &Path) -> Result<Vec<u8>, String> {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "html" | "htm"))
    {
        return Err("交互预览仅支持 HTML 文件".into());
    }
    let (bytes, truncated) = read_limited(path, TEXT_PREVIEW_LIMIT)?;
    if truncated {
        return Err("HTML 文件超过 2 MiB，请查看源码".into());
    }
    std::str::from_utf8(&bytes).map_err(|_| "HTML 必须是 UTF-8 文本")?;
    Ok(bytes)
}
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
const TEXT_EXTENSIONS: &[&str] = &["csv", "log", "md", "markdown", "tsv", "txt"];
static PREVIEW_LOCK: futures_util::lock::Mutex<()> = futures_util::lock::Mutex::new(());

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
pub async fn read_local_artifact_preview(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
) -> Result<LocalArtifactPreview, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    authorizations.ensure_employee(&employee_id)?;
    let _guard = PREVIEW_LOCK.lock().await;
    let authorizations = authorizations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = authorizations.resolve_artifact(&root_id, &path)?;
        preview_file(&validate_artifact_path(&target)?, path)
    })
    .await
    .map_err(|_| "文件预览处理失败，请重试".to_string())?
}

#[tauri::command]
pub async fn reveal_local_artifact(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
) -> Result<(), String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    authorizations.ensure_employee(&employee_id)?;
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
pub async fn open_local_artifact(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
) -> Result<(), String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    authorizations.ensure_employee(&employee_id)?;
    let target = authorizations.resolve_artifact(&root_id, &path)?;
    let target = validate_artifact_path(&target)?;
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|_| "系统无法打开该文件，请检查是否安装对应应用".into())
}

#[tauri::command]
pub async fn read_harness_image_preview(
    app: tauri::AppHandle,
    employee_id: String,
    attachment_id: String,
    media_type: String,
) -> Result<String, String> {
    crate::harness::validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    let hash = attachment_id
        .strip_prefix("sha256:")
        .filter(|value| {
            value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| "截图标识无效".to_string())?;
    let mime = match media_type.as_str() {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/gif" => "image/gif",
        _ => return Err("截图格式不支持".to_string()),
    };
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定 Harness 数据目录：{error}"))?;
    let path = harness_attachment_path(&root, &employee_id, hash);
    let (bytes, truncated) = read_limited(&path, 5 * 1024 * 1024)?;
    if truncated || format!("{:x}", Sha256::digest(&bytes)) != hash.to_ascii_lowercase() {
        return Err("截图内容不完整或已损坏".to_string());
    }
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn harness_attachment_path(root: &Path, employee_id: &str, hash: &str) -> PathBuf {
    root.join("harness")
        .join(crate::harness::employee_namespace(employee_id))
        .join("attachments")
        .join("v1")
        .join("objects")
        .join(&hash[..2])
        .join(hash)
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

    if let Some((kind, mime)) = media_type(&extension) {
        let (bytes, truncated) = read_limited(target, MEDIA_PREVIEW_LIMIT)?;
        return Ok(LocalArtifactPreview {
            name,
            path: relative_path,
            kind: kind.to_string(),
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
        kind: if matches!(extension.as_str(), "md" | "markdown") {
            "markdown"
        } else if CODE_EXTENSIONS.contains(&extension.as_str()) {
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

fn media_type(extension: &str) -> Option<(&'static str, &'static str)> {
    match extension {
        "bmp" => Some(("image", "image/bmp")),
        "gif" => Some(("image", "image/gif")),
        "jpeg" | "jpg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "webp" => Some(("image", "image/webp")),
        "svg" => Some(("image", "image/svg+xml")),
        "mp3" => Some(("audio", "audio/mpeg")),
        "wav" => Some(("audio", "audio/wav")),
        "m4a" => Some(("audio", "audio/mp4")),
        "ogg" => Some(("audio", "audio/ogg")),
        "mp4" | "m4v" => Some(("video", "video/mp4")),
        "webm" => Some(("video", "video/webm")),
        "mov" => Some(("video", "video/quicktime")),
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

    #[test]
    fn html_preview_enforces_authorization_type_size_and_isolation() {
        let root = temporary_root("html");
        std::fs::create_dir_all(&root).unwrap();
        let html = root.join("tool.html");
        std::fs::write(&html, "<button onclick='this.textContent=2'>1</button>").unwrap();
        assert!(html_preview_bytes(&html).unwrap().starts_with(b"<button"));
        assert!(html_preview_bytes(&root.join("secret.txt")).is_err());
        std::fs::write(&html, vec![b'x'; TEXT_PREVIEW_LIMIT + 1]).unwrap();
        assert!(html_preview_bytes(&html).unwrap_err().contains("2 MiB"));
        let request = tauri::http::Request::builder()
            .uri("xiaoyin-preview://localhost/unknown/tool.html")
            .body(Vec::new())
            .unwrap();
        let response = html_preview_response(&LocalFileAuthorizations::default(), &request);
        assert_eq!(response.status(), 400);
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("sandbox allow-scripts")
        );
        assert!(String::from_utf8_lossy(response.body()).contains("授权已失效"));
        std::fs::remove_dir_all(root).unwrap();
    }

    fn temporary_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "xiaoyin-artifact-preview-{}-{label}",
            std::process::id()
        ))
    }

    #[test]
    fn rejects_missing_artifacts() {
        assert!(validate_artifact_path(Path::new("")).is_err());
        assert!(validate_artifact_path(Path::new("/definitely/missing/report.pdf")).is_err());
    }

    #[test]
    fn harness_attachments_are_isolated_by_employee_without_exposing_identity() {
        let root = Path::new("/application-data");
        let first = harness_attachment_path(root, "employee-1", "abc123");
        let second = harness_attachment_path(root, "employee-2", "abc123");
        assert_ne!(first, second);
        assert!(!first.to_string_lossy().contains("employee-1"));
        assert!(first.ends_with("attachments/v1/objects/ab/abc123"));
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
